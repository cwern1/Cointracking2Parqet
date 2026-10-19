import type { CoinTrackingClient } from './cointracking';
import { isFiat, isParqetCurrency } from './currencies';
import { mapTrades, PriceBook, safeId, type MapOptions } from './mapping';
import type { CreateFailure, ParqetClient } from './parqet';
import { buildPlan, ownTradeKey, type SyncPlan } from './plan';
import type { CtLedgerRow, CtTrade, ExistingActivity } from './types';

export interface SourceData {
  trades: CtTrade[];
  ledger: CtLedgerRow[];
  accountCurrency: string;
  fetchedAt: number;
}

/** Two CoinTracking calls: trades for the transactions, ledger for the fiat prices. */
export async function fetchSource(ct: CoinTrackingClient): Promise<SourceData> {
  const trades = await ct.getTrades();
  const { accountCurrency, rows } = await ct.getLedger();
  return { trades, ledger: rows, accountCurrency, fetchedAt: Date.now() };
}

export class SyncError extends Error {
  override name = 'SyncError';
}

export function makePlan(
  source: SourceData,
  existing: ExistingActivity[],
  options: Omit<MapOptions, 'accountCurrency'>,
): SyncPlan {
  if (!isParqetCurrency(source.accountCurrency)) {
    throw new SyncError(
      `Your CoinTracking account currency is ${source.accountCurrency || 'unknown'}, which Parqet does not support.`,
    );
  }
  const prices = new PriceBook(source.accountCurrency, source.ledger);
  const mapped = mapTrades(source.trades, prices, { ...options, accountCurrency: source.accountCurrency });
  return buildPlan(mapped, existing);
}

export interface SyncResult {
  created: number;
  deleted: number;
  failures: CreateFailure[];
  /** Old activities kept because their replacement could not be created. */
  keptBecauseOfFailure: number;
  /** Activities Parqet should have deleted but that are still there. */
  notDeleted: number;
}

export type Progress = { phase: 'create' | 'delete'; done: number; total: number };

export async function executePlan(
  parqet: ParqetClient,
  portfolioId: string,
  plan: SyncPlan,
  options: { removeOrphans: boolean },
  onProgress?: (p: Progress) => void,
): Promise<SyncResult> {
  // Create first, delete second: if creating fails half way, nothing is lost.
  const total = plan.create.length;
  onProgress?.({ phase: 'create', done: 0, total });
  const reported = total
    ? await parqet.createActivities(portfolioId, plan.create, (done) => onProgress?.({ phase: 'create', done, total }))
    : { created: 0, failures: [] };

  // Parqet's response does not reliably list what it created, so count what is actually there now.
  const present = total ? new Set((await parqet.listCryptoActivities(portfolioId)).map((a) => a.externalId)) : new Set<string>();
  const created = plan.create.filter((a) => present.has(a.externalId)).length;
  const reportedIds = new Set(reported.failures.map((f) => f.activity.externalId));
  const failures: CreateFailure[] = [
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

export interface BalanceRow {
  symbol: string;
  coinTracking: number;
  parqet: number;
  difference: number;
}

/** One satoshi, plus room for float error. */
const DUST = 1.000001e-8;

const SIGN: Record<string, number> = { buy: 1, transfer_in: 1, sell: -1, transfer_out: -1 };

/** Compares CoinTracking's current balances with the shares implied by the Parqet activities. */
export function compareBalances(
  ctAmounts: Map<string, number>,
  activities: ExistingActivity[],
  symbolMap: Record<string, string>,
  skipSymbols: string[] = [],
): BalanceRow[] {
  const parqet = new Map<string, number>();
  for (const a of activities) {
    if (!a.symbol) continue;
    const sym = a.symbol.toUpperCase();
    parqet.set(sym, (parqet.get(sym) ?? 0) + (SIGN[a.type] ?? 0) * a.shares);
  }
  const ct = new Map<string, number>();
  const skip = new Set(skipSymbols.map((s) => s.toUpperCase()));
  for (const [coin, amount] of ctAmounts) {
    if (isFiat(coin) || skip.has(coin.toUpperCase())) continue;
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
export function ownActivities(existing: ExistingActivity[]): ExistingActivity[] {
  return existing.filter((a) => ownTradeKey(a) !== null);
}


export interface BreakdownRow {
  label: string;
  coinTracking: number;
  parqet: number;
}

/**
 * Where does a balance difference come from? Net amount of one coin per CoinTracking type,
 * once as CoinTracking books it (buy − sell − fee) and once as the synced Parqet activities add up.
 * Fees are their own row so double counting shows up directly.
 */
export function explainDifference(
  symbol: string,
  trades: CtTrade[],
  activities: ExistingActivity[],
  symbolMap: Record<string, string>,
): BreakdownRow[] {
  const sym = (c: string | null) => (c ? (symbolMap[c] ?? c).toUpperCase() : null);
  const rows = new Map<string, BreakdownRow>();
  const add = (label: string, side: 'coinTracking' | 'parqet', v: number) => {
    const r = rows.get(label) ?? { label, coinTracking: 0, parqet: 0 };
    r[side] += v;
    rows.set(label, r);
  };
  const typeById = new Map<string, string>();
  for (const t of trades) {
    typeById.set(safeId(t.id), t.type);
    if (sym(t.buyCurrency) === symbol && t.buyAmount) add(t.type, 'coinTracking', Math.abs(t.buyAmount));
    if (sym(t.sellCurrency) === symbol && t.sellAmount) add(t.type, 'coinTracking', -Math.abs(t.sellAmount));
    if (sym(t.feeCurrency) === symbol && t.feeAmount) add(`Fees on ${t.type}`, 'coinTracking', -Math.abs(t.feeAmount));
  }
  for (const a of activities) {
    if (a.symbol?.toUpperCase() !== symbol) continue;
    const m = a.externalId ? /^ct-([A-Za-z0-9_]+)-([a-z])-/.exec(a.externalId) : null;
    if (!m) continue;
    const type = typeById.get(m[1]!) ?? 'Deleted in CoinTracking';
    add(m[2] === 'f' ? `Fees on ${type}` : type, 'parqet', (SIGN[a.type] ?? 0) * a.shares);
  }
  const clean = (n: number) => (Math.abs(n) <= DUST ? 0 : Number(n.toFixed(10)));
  return [...rows.values()]
    .map((r) => ({ ...r, coinTracking: clean(r.coinTracking), parqet: clean(r.parqet) }))
    .filter((r) => r.coinTracking !== 0 || r.parqet !== 0)
    .sort((a, b) => Math.abs(b.coinTracking - b.parqet) - Math.abs(a.coinTracking - a.parqet));
}
