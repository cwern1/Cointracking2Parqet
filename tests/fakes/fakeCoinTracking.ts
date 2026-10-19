/** Stand-in for the CoinTracking API that checks key, signature and nonce like the real one. */
import { createHmac } from 'node:crypto';

export interface FixtureTrade {
  id: string;
  type: string;
  buy?: [number, string];
  sell?: [number, string];
  fee?: [number, string];
  exchange?: string;
  comment?: string;
  time: number;
  /** Fiat price per currency for this transaction, as the ledger reports it. */
  prices?: Record<string, number | null>;
}

const T0 = 1_700_000_000; // 2023-11-14

/** Covers every mapping branch. Account currency EUR. */
export const SAMPLE: FixtureTrade[] = [
  { id: '1001', type: 'Trade', buy: [0.5, 'BTC'], sell: [10000, 'EUR'], fee: [10, 'EUR'], exchange: 'Kraken', time: T0, prices: { BTC: 20000 } },
  { id: '1002', type: 'Trade', buy: [10, 'ETH'], sell: [0.4, 'BTC'], fee: [0.001, 'BTC'], exchange: 'Binance', time: T0 + 100, prices: { ETH: 800, BTC: 20000 } },
  { id: '1003', type: 'Staking', buy: [0.1, 'ETH'], exchange: 'Kraken', time: T0 + 200, prices: { ETH: 810 } },
  { id: '1004', type: 'Withdrawal', sell: [1, 'ETH'], fee: [0.002, 'ETH'], exchange: 'Binance', time: T0 + 300, prices: { ETH: 820 } },
  { id: '1005', type: 'Deposit', buy: [1000, 'EUR'], exchange: 'Kraken', time: T0 + 400 },
  { id: '1006', type: 'Trade', buy: [3000, 'USD'], sell: [0.05, 'BTC'], exchange: 'Coinbase', time: T0 + 500, prices: { BTC: 21000, USD: 0.92 } },
  { id: '1007', type: 'Margin Trade', buy: [1, 'BTC'], sell: [20000, 'EUR'], exchange: 'Kraken', time: T0 + 600 },
  { id: '1008', type: 'Receive Loan', buy: [500, 'USDC'], exchange: 'Aave', time: T0 + 700, prices: { USDC: 0.93 } },
  { id: '1009', type: 'Airdrop', buy: [1000, 'FOO'], exchange: 'Wallet', time: T0 + 800, prices: { FOO: null } },
  { id: '1010', type: 'Trade', buy: [100, 'ADA'], sell: [50, 'EUR'], fee: [0.5, 'BNB'], exchange: 'Binance', time: T0 + 900, prices: { ADA: 0.5, BNB: 200 } },
  { id: '1011', type: 'Other Fee', sell: [0.0001, 'BTC'], exchange: 'Kraken', time: T0 + 1000, prices: { BTC: 20500 } },
];

export function tradesResponse(trades: FixtureTrade[]): Record<string, unknown> {
  const out: Record<string, unknown> = { success: 1, method: 'getTrades' };
  for (const t of trades) {
    out[t.id] = {
      buy_amount: t.buy ? t.buy[0].toFixed(8) : '',
      buy_currency: t.buy?.[1] ?? '',
      sell_amount: t.sell ? t.sell[0].toFixed(8) : '',
      sell_currency: t.sell?.[1] ?? '',
      fee_amount: t.fee ? t.fee[0].toFixed(8) : '',
      fee_currency: t.fee?.[1] ?? '',
      type: t.type,
      exchange: t.exchange ?? '',
      group: '',
      comment: t.comment ?? '',
      imported_from: '',
      time: String(t.time),
      imported_time: String(t.time + 10),
      trade_id: `ex-${t.id}`,
    };
  }
  return out;
}

export function ledgerResponse(trades: FixtureTrade[], accountCurrency = 'EUR'): Record<string, unknown> {
  const out: Record<string, unknown> = { success: 1, method: 'getLedger', account_currency: accountCurrency };
  let n = 0;
  for (const t of trades) {
    const rows: Array<[number, string, boolean]> = [];
    if (t.buy) rows.push([t.buy[0], t.buy[1], false]);
    if (t.sell) rows.push([t.sell[0], t.sell[1], false]);
    if (t.fee) rows.push([t.fee[0], t.fee[1], true]);
    rows.forEach(([amount, currency, isFee], sub) => {
      const p = currency === accountCurrency ? 1 : (t.prices?.[currency] ?? null);
      out[isFee ? `${t.id}F` : sub === 0 ? t.id : `${t.id}_${sub}`] = {
        ledger_count: ++n,
        id: t.id,
        sub_id: String(sub),
        type: isFee ? 'Fee' : t.type,
        amount: amount.toFixed(8),
        currency,
        value_at_transaction: p === null ? '' : (amount * p).toFixed(2),
        price: p === null ? '' : p.toFixed(8),
        exchange: t.exchange ?? '',
        time: String(t.time),
      };
    });
  }
  return out;
}

export function balanceResponse(amounts: Record<string, number>, accountCurrency = 'EUR'): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [coin, amount] of Object.entries(amounts)) details[coin] = { amount: amount.toFixed(8), coin, value_fiat: '0' };
  return { success: 1, method: 'getBalance', account_currency: accountCurrency, details, summary: {} };
}

export class FakeCoinTracking {
  key = 'ct-key';
  secret = 'ct-secret';
  trades: FixtureTrade[] = [...SAMPLE];
  /** Explicit balances, or null to derive them from the trades the way CoinTracking does. */
  balances: Record<string, number> | null = null;

  derivedBalances(): Record<string, number> {
    const out: Record<string, number> = {};
    const add = (s: [number, string] | undefined, sign: number) => {
      if (s) out[s[1]] = (out[s[1]] ?? 0) + sign * s[0];
    };
    for (const t of this.trades) {
      if (t.type === 'Margin Trade' || t.type === 'Derivatives / Futures Trade') continue;
      add(t.buy, 1);
      add(t.sell, -1);
      // Like the live account: fee fields are informational, except on pure fee transactions.
      if (!t.buy && !t.sell) add(t.fee, -1);
    }
    return out;
  }
  accountCurrency = 'EUR';
  calls: string[] = [];
  private lastNonce = 0;

  handle(headers: Headers, body: string): { status: number; body: unknown } {
    const form = new URLSearchParams(body);
    const method = form.get('method') ?? '';
    const err = (error: string, error_msg: string) => ({ status: 200, body: { success: 0, method, error, error_msg } });
    if (!headers.get('key')) return err('KEY_MISSING', 'ERROR: API Key not set');
    if (headers.get('key') !== this.key) return err('KEY_INVALID', 'ERROR: Invalid API Key');
    const expected = createHmac('sha512', this.secret).update(body).digest('hex');
    if (headers.get('sign') !== expected) return err('SIGN_INVALID', 'ERROR: Invalid signature');
    const nonce = Number(form.get('nonce'));
    if (!(nonce > this.lastNonce)) return err('NONCE_INVALID', 'ERROR: Nonce must be increasing');
    this.lastNonce = nonce;
    this.calls.push(method);
    if (method === 'getTrades') return { status: 200, body: tradesResponse(this.trades) };
    if (method === 'getLedger') return { status: 200, body: ledgerResponse(this.trades, this.accountCurrency) };
    if (method === 'getBalance') return { status: 200, body: balanceResponse(this.balances ?? this.derivedBalances(), this.accountCurrency) };
    return err('NO_METHOD', 'ERROR: Method not set');
  }

  fetch(): typeof fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const res = this.handle(new Headers(init?.headers), String(init?.body ?? ''));
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }
}
