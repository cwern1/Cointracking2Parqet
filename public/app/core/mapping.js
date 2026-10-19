import { isFiat } from './currencies.js';
const INCOME = [
    'Income', 'Mining', 'Mining (commercial)', 'Airdrop', 'Airdrop (non taxable)', 'Staking', 'Masternode', 'Minting',
    'Dividends Income', 'Lending Income', 'Interest Income', 'Reward / Bonus', 'LP Rewards', 'Other Income',
    'Income (non taxable)', 'Other Income (non taxable)', 'Gift/Tip(In)', 'Margin Profit', 'Derivatives / Futures Profit',
];
const OUT = [
    'Withdrawal', 'Spend', 'Donation', 'Gift(Out)', 'Stolen', 'Lost', 'Liquidation', 'Other Expense',
    'Expense (non taxable)', 'Margin Loss', 'Derivatives / Futures Loss',
];
const FEE = ['Margin Fee', 'Borrowing Fee', 'Settlement Fee', 'Other Fee', 'Fee'];
const DEFI_IN = ['Receive Loan', 'Receive Collateral', 'Remove Liquidity', 'Receive LP Token'];
const DEFI_OUT = ['Repay Loan', 'Send Collateral', 'Provide Liquidity', 'Return LP Token'];
const SKIP = ['Margin Trade', 'Derivatives / Futures Trade'];
export const TYPE_RULES = new Map([
    ['Trade', 'trade'],
    ['Swap (non taxable)', 'trade'],
    ['Deposit', 'in'],
    ...INCOME.map((t) => [t, 'income']),
    ...OUT.map((t) => [t, 'out']),
    ...FEE.map((t) => [t, 'fee']),
    ...DEFI_IN.map((t) => [t, 'defi_in']),
    ...DEFI_OUT.map((t) => [t, 'defi_out']),
    ...SKIP.map((t) => [t, 'skip']),
]);
export const DEFAULT_OPTIONS = {
    incomeAs: 'transfer_in',
    defiAsTransfers: false,
    symbolMap: {},
    skipSymbols: [],
    cryptoFees: 'included',
};
/** Fiat prices per transaction and currency, from CoinTracking's ledger. */
export class PriceBook {
    accountCurrency;
    prices = new Map();
    constructor(accountCurrency, rows = []) {
        this.accountCurrency = accountCurrency;
        for (const r of rows) {
            const k = PriceBook.key(r.id, r.currency);
            if (this.prices.has(k))
                continue;
            let p = null;
            if (r.price !== null && r.price >= 0)
                p = r.price;
            else if (r.valueAtTransaction !== null && r.amount)
                p = Math.abs(r.valueAtTransaction / r.amount);
            if (p !== null && Number.isFinite(p))
                this.prices.set(k, p);
        }
    }
    static key(id, currency) {
        return `${id}|${currency}`;
    }
    /** Price of one unit of `currency` in the account currency at transaction `id`. */
    priceOf(id, currency) {
        if (currency === this.accountCurrency)
            return 1;
        return this.prices.get(PriceBook.key(id, currency)) ?? null;
    }
}
const BROKERS = {
    kraken: 'kraken',
    coinbase: 'coinbase',
    coinbasepro: 'coinbase_pro',
    coinbaseadvanced: 'coinbase_pro',
    bitpanda: 'bitpanda',
    bitpandapro: 'bitpanda',
    cryptocom: 'crypto_com',
    cryptocomexchange: 'crypto_com',
    bison: 'bison',
    bsdex: 'bsdex',
    traderepublic: 'trade_republic',
    scalablecapital: 'scalable_capital',
};
export function brokerFor(exchange) {
    return BROKERS[exchange.toLowerCase().replace(/[^a-z0-9]/g, '')];
}
/** Round to 12 significant digits to drop float noise without hurting tiny prices. */
export function round(x) {
    return Number(x.toPrecision(12));
}
/** FNV-1a, 32 bit, as 8 hex chars. Enough to notice that a transaction changed. */
export function hash8(input) {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}
export function safeId(id) {
    return id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 200);
}
export const EXTERNAL_ID_RE = /^ct-([A-Za-z0-9_]+)-([a-z])-([0-9a-f]{8})$/;
export function externalId(tradeId, suffix, hash) {
    return `ct-${safeId(tradeId)}-${suffix}-${hash}`;
}
function describe(trade) {
    const parts = ['CoinTracking', trade.type, trade.exchange, trade.comment].filter((p) => p !== '');
    const text = parts.join(' · ');
    return text.length > 250 ? `${text.slice(0, 249)}…` : text;
}
function side(currency, amount) {
    if (!currency || amount === null || amount === 0)
        return null;
    return { currency, amount: Math.abs(amount) };
}
export function mapTrade(trade, prices, opts) {
    const notes = [];
    const skip = (reason) => ({ trade, activities: [], skipped: reason, notes });
    const rule = TYPE_RULES.get(trade.type);
    if (!rule)
        return skip(`Unknown CoinTracking type "${trade.type}"`);
    if (rule === 'skip')
        return skip(`${trade.type} is not imported (no effect on holdings)`);
    if ((rule === 'defi_in' || rule === 'defi_out') && !opts.defiAsTransfers) {
        return skip(`${trade.type} is skipped. Enable loans and liquidity in the options to import it`);
    }
    const buy = side(trade.buyCurrency, trade.buyAmount);
    const sell = side(trade.sellCurrency, trade.sellAmount);
    const fee = side(trade.feeCurrency, trade.feeAmount);
    const skipSet = new Set(opts.skipSymbols.map((s) => s.toUpperCase()));
    const symbolOf = (c) => (opts.symbolMap[c] ?? c).toUpperCase();
    const hash = hash8(JSON.stringify([
        trade.type, trade.time, buy?.currency, buy?.amount, sell?.currency, sell?.amount, fee?.currency, fee?.amount,
        buy && symbolOf(buy.currency), sell && symbolOf(sell.currency), opts.accountCurrency,
        // Options only count where they change the result, so toggling one doesn't rewrite everything.
        rule === 'income' ? opts.incomeAs : '',
        fee && !isFiat(fee.currency) ? `fees:${opts.cryptoFees}` : '',
    ]));
    const datetime = new Date(trade.time * 1000).toISOString();
    const description = describe(trade);
    const broker = brokerFor(trade.exchange);
    /** Fiat value of one unit of `s`, using the ledger first and the counter side second. */
    const unitPrice = (s, counter) => {
        const direct = prices.priceOf(trade.id, s.currency);
        if (direct !== null)
            return direct;
        if (counter) {
            const counterPrice = prices.priceOf(trade.id, counter.currency);
            if (counterPrice !== null)
                return (counter.amount * counterPrice) / s.amount;
        }
        return null;
    };
    const activities = [];
    const make = (type, s, price, suffix) => {
        const symbol = symbolOf(s.currency);
        if (skipSet.has(symbol) || skipSet.has(s.currency)) {
            notes.push(`${s.currency} is on the skip list`);
            return null;
        }
        const a = {
            type,
            assetIdentifierType: 'crypto_symbol',
            symbol,
            shares: round(s.amount),
            price: round(price),
            currency: opts.accountCurrency,
            datetime,
            description,
            externalId: externalId(trade.id, suffix, hash),
        };
        if (broker)
            a.broker = broker;
        activities.push(a);
        return a;
    };
    let feeTarget = null;
    let feeConsumed = false;
    if (rule === 'trade') {
        const buyCrypto = buy && !isFiat(buy.currency) ? buy : null;
        const sellCrypto = sell && !isFiat(sell.currency) ? sell : null;
        if (!buyCrypto && !sellCrypto)
            return skip('Fiat-only exchange, nothing to import');
        if (sellCrypto) {
            const p = unitPrice(sellCrypto, buy);
            if (p === null)
                return skip(`No fiat price for ${sellCrypto.currency}`);
            feeTarget = make('sell', sellCrypto, p, 's') ?? feeTarget;
        }
        if (buyCrypto) {
            const p = unitPrice(buyCrypto, sell);
            if (p === null)
                return skip(`No fiat price for ${buyCrypto.currency}`);
            feeTarget = make('buy', buyCrypto, p, 'b') ?? feeTarget;
        }
    }
    else {
        const incoming = rule === 'in' || rule === 'income' || rule === 'defi_in';
        let s = incoming ? (buy ?? sell) : (sell ?? buy);
        if (!s && rule === 'fee' && fee) {
            // Some fee transactions carry their amount only in the fee fields. Don't count it twice.
            s = fee;
            feeConsumed = true;
        }
        if (!s)
            return skip('Transaction has no amount');
        if (isFiat(s.currency)) {
            if (rule === 'fee')
                return skip('Fiat fee, not a crypto holding');
            return skip(incoming ? 'Fiat deposit, not a crypto holding' : 'Fiat withdrawal, not a crypto holding');
        }
        const p = unitPrice(s, null);
        if (p === null)
            return skip(`No fiat price for ${s.currency}`);
        const type = !incoming
            ? 'transfer_out'
            : rule === 'income' && opts.incomeAs === 'buy'
                ? 'buy'
                : 'transfer_in';
        feeTarget = make(type, s, p, incoming ? (type === 'buy' ? 'b' : 'i') : 'o');
    }
    if (fee && !feeConsumed) {
        const fromTrade = [buy, sell].find((x) => x?.currency === fee.currency) ?? null;
        const p = prices.priceOf(trade.id, fee.currency) ?? (fromTrade ? unitPrice(fromTrade, fromTrade === buy ? sell : buy) : null);
        if (p === null)
            notes.push(`Fee in ${fee.currency} has no fiat price and was left out`);
        else if (isFiat(fee.currency) || opts.cryptoFees === 'included') {
            // CoinTracking's trade amounts already account for the fee; the fee fields are informational.
            // So the fee only adds to the cost in Parqet and does not change any coin balance.
            if (feeTarget)
                feeTarget.fee = round((feeTarget.fee ?? 0) + fee.amount * p);
            else
                notes.push(`Fee of ${fee.amount} ${fee.currency} has no activity to attach to`);
        }
        else {
            const f = make('transfer_out', fee, p, 'f');
            if (f)
                f.description = `${description} · Fee`;
        }
    }
    if (activities.length === 0)
        return skip(notes[0] ?? 'Nothing to import');
    return { trade, activities, notes };
}
export function mapTrades(trades, prices, opts) {
    return trades.map((t) => mapTrade(t, prices, opts));
}
/**
 * CoinTracking appends a digit to tickers that exist more than once, e.g. Solana is "SOL2".
 * Parqet most likely knows these coins by the plain ticker, so we suggest a rename.
 * Tokens whose real ticker ends in a digit (API3, C98) are listed here so they are not flagged.
 */
const REAL_TICKERS_WITH_DIGIT = new Set(['API3', 'C98', 'GHST3', 'L2', 'B2', 'G7', 'Z3', 'W3', 'T1', 'S1']);
export function suggestRenames(symbols, symbolMap) {
    const out = new Map();
    for (const s of symbols) {
        if (symbolMap[s] || REAL_TICKERS_WITH_DIGIT.has(s))
            continue;
        const m = /^([A-Z]{2,})([2-9])$/.exec(s);
        if (m)
            out.set(s, m[1]);
    }
    return [...out].map(([from, to]) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from));
}
