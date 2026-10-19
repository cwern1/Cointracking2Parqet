import { isFiat, isParqetCurrency } from './currencies.js';
import { mapTrades, PriceBook, safeId } from './mapping.js';
import { buildPlan, ownTradeKey } from './plan.js';
/** Two CoinTracking calls: trades for the transactions, ledger for the fiat prices. */
export async function fetchSource(ct) {
    const trades = await ct.getTrades();
    const { accountCurrency, rows } = await ct.getLedger();
    return { trades, ledger: rows, accountCurrency, fetchedAt: Date.now() };
}
export class SyncError extends Error {
    name = 'SyncError';
}
export function makePlan(source, existing, options) {
    if (!isParqetCurrency(source.accountCurrency)) {
        throw new SyncError(`Your CoinTracking account currency is ${source.accountCurrency || 'unknown'}, which Parqet does not support.`);
    }
    const prices = new PriceBook(source.accountCurrency, source.ledger);
    const mapped = mapTrades(source.trades, prices, { ...options, accountCurrency: source.accountCurrency });
    return buildPlan(mapped, existing);
}
export async function executePlan(parqet, portfolioId, plan, options, onProgress) {
    // Create first, delete second: if creating fails half way, nothing is lost.
    const total = plan.create.length;
    onProgress?.({ phase: 'create', done: 0, total });
    const reported = total
        ? await parqet.createActivities(portfolioId, plan.create, (done) => onProgress?.({ phase: 'create', done, total }))
        : { created: 0, failures: [] };
    // Parqet's response does not reliably list what it created, so count what is actually there now.
    const present = total ? new Set((await parqet.listCryptoActivities(portfolioId)).map((a) => a.externalId)) : new Set();
    const created = plan.create.filter((a) => present.has(a.externalId)).length;
    const reportedIds = new Set(reported.failures.map((f) => f.activity.externalId));
    const failures = [
        ...reported.failures.filter((f) => !present.has(f.activity.externalId)),
        ...plan.create
            .filter((a) => !present.has(a.externalId) && !reportedIds.has(a.externalId))
            .map((activity) => ({ activity, code: 'missing', message: 'Parqet accepted the request but the activity is not in the portfolio.' })),
    ];
    const failedTrades = new Set(failures.map((f) => /^ct-([A-Za-z0-9_]+)-/.exec(f.activity.externalId)?.[1]));
    const replace = plan.deleteChanged.filter((a) => !failedTrades.has(ownTradeKey(a) ?? ''));
    const toDelete = [...replace, ...(options.removeOrphans ? plan.orphaned : [])].map((a) => a.id);
    onProgress?.({ phase: 'delete', done: 0, total: toDelete.length });
    let deleted = 0;
    let notDeleted = 0;
    if (toDelete.length) {
        await parqet.deleteActivities(portfolioId, toDelete);
        // As with creating: trust the portfolio, not the response.
        const remaining = new Set((await parqet.listCryptoActivities(portfolioId)).map((a) => a.id));
        notDeleted = toDelete.filter((id) => remaining.has(id)).length;
        deleted = toDelete.length - notDeleted;
    }
    onProgress?.({ phase: 'delete', done: toDelete.length, total: toDelete.length });
    return { created, deleted, notDeleted, failures, keptBecauseOfFailure: plan.deleteChanged.length - replace.length };
}
/** One satoshi, plus room for float error. */
const DUST = 1.000001e-8;
const SIGN = { buy: 1, transfer_in: 1, sell: -1, transfer_out: -1 };
/** Compares CoinTracking's current balances with the shares implied by the Parqet activities. */
export function compareBalances(ctAmounts, activities, symbolMap, skipSymbols = []) {
    const parqet = new Map();
    for (const a of activities) {
        if (!a.symbol)
            continue;
        const sym = a.symbol.toUpperCase();
        parqet.set(sym, (parqet.get(sym) ?? 0) + (SIGN[a.type] ?? 0) * a.shares);
    }
    const ct = new Map();
    const skip = new Set(skipSymbols.map((s) => s.toUpperCase()));
    for (const [coin, amount] of ctAmounts) {
        if (isFiat(coin) || skip.has(coin.toUpperCase()))
            continue;
        const sym = (symbolMap[coin] ?? coin).toUpperCase();
        ct.set(sym, (ct.get(sym) ?? 0) + amount);
    }
    const symbols = [...new Set([...ct.keys(), ...parqet.keys()])].sort();
    return symbols
        .map((symbol) => {
        const c = ct.get(symbol) ?? 0;
        const p = parqet.get(symbol) ?? 0;
        // Differences of one satoshi or less are CoinTracking rounding dust, not missing transactions.
        const raw = p - c;
        const difference = Math.abs(raw) <= DUST ? 0 : Number(raw.toFixed(10));
        return { symbol, coinTracking: c, parqet: Number(p.toFixed(10)) || 0, difference };
    })
        .filter((r) => Math.abs(r.coinTracking) > 1e-12 || Math.abs(r.parqet) > 1e-12);
}
/** Every activity this tool created, for the "remove all synced activities" reset. */
export function ownActivities(existing) {
    return existing.filter((a) => ownTradeKey(a) !== null);
}
/**
 * Where does a balance difference come from? Net amount of one coin per CoinTracking type,
 * once as CoinTracking books it (buy − sell − fee) and once as the synced Parqet activities add up.
 * Fees are their own row so double counting shows up directly.
 */
export function explainDifference(symbol, trades, activities, symbolMap) {
    const sym = (c) => (c ? (symbolMap[c] ?? c).toUpperCase() : null);
    const rows = new Map();
    const add = (label, side, v) => {
        const r = rows.get(label) ?? { label, coinTracking: 0, parqet: 0 };
        r[side] += v;
        rows.set(label, r);
    };
    const typeById = new Map();
    for (const t of trades) {
        typeById.set(safeId(t.id), t.type);
        if (sym(t.buyCurrency) === symbol && t.buyAmount)
            add(t.type, 'coinTracking', Math.abs(t.buyAmount));
        if (sym(t.sellCurrency) === symbol && t.sellAmount)
            add(t.type, 'coinTracking', -Math.abs(t.sellAmount));
        if (sym(t.feeCurrency) === symbol && t.feeAmount)
            add(`Fees on ${t.type}`, 'coinTracking', -Math.abs(t.feeAmount));
    }
    for (const a of activities) {
        if (a.symbol?.toUpperCase() !== symbol)
            continue;
        const m = a.externalId ? /^ct-([A-Za-z0-9_]+)-([a-z])-/.exec(a.externalId) : null;
        if (!m)
            continue;
        const type = typeById.get(m[1]) ?? 'Deleted in CoinTracking';
        add(m[2] === 'f' ? `Fees on ${type}` : type, 'parqet', (SIGN[a.type] ?? 0) * a.shares);
    }
    const clean = (n) => (Math.abs(n) <= DUST ? 0 : Number(n.toFixed(10)));
    return [...rows.values()]
        .map((r) => ({ ...r, coinTracking: clean(r.coinTracking), parqet: clean(r.parqet) }))
        .filter((r) => r.coinTracking !== 0 || r.parqet !== 0)
        .sort((a, b) => Math.abs(b.coinTracking - b.parqet) - Math.abs(a.coinTracking - a.parqet));
}
