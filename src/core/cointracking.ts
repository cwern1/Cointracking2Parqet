import type { CtLedgerRow, CtTrade } from './types';

export class CoinTrackingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoinTrackingError';
  }
}

export interface CtCredentials {
  key: string;
  secret: string;
}

let lastNonce = 0;

/** Strictly increasing nonce in milliseconds, as in CoinTracking's C# example. */
export function nextNonce(now: number = Date.now()): number {
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce;
}

/** Same layout as the official examples: parameters first, then method and nonce. */
export function buildPostData(method: string, params: Record<string, string | number>, nonce: number): string {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('method', method);
  form.append('nonce', String(nonce));
  return form.toString();
}

export async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const META_KEYS = new Set(['success', 'method', 'account_currency', 'display_currency', 'user', 'error', 'error_msg']);

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function cur(v: unknown): string | null {
  const s = str(v).toUpperCase();
  return s === '' ? null : s;
}

/** CoinTracking returns rows as an object keyed by transaction id, next to `success` and `method`. */
function rowsOf(json: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const container = (json.trades ?? json) as Record<string, unknown> | unknown[];
  const entries: Array<[string, unknown]> = Array.isArray(container)
    ? container.map((v, i) => [String(i), v])
    : Object.entries(container);
  return entries.filter(
    (e): e is [string, Record<string, unknown>] =>
      !META_KEYS.has(e[0]) && typeof e[1] === 'object' && e[1] !== null,
  );
}

export function parseTrades(json: Record<string, unknown>): CtTrade[] {
  return rowsOf(json).map(([key, r]) => ({
    id: key,
    type: str(r.type),
    buyAmount: num(r.buy_amount),
    buyCurrency: cur(r.buy_currency),
    sellAmount: num(r.sell_amount),
    sellCurrency: cur(r.sell_currency),
    feeAmount: num(r.fee_amount),
    feeCurrency: cur(r.fee_currency),
    exchange: str(r.exchange),
    group: str(r.group ?? r.trade_group),
    comment: str(r.comment),
    time: num(r.time) ?? 0,
  }));
}

export function parseLedger(json: Record<string, unknown>): { accountCurrency: string; rows: CtLedgerRow[] } {
  const rows = rowsOf(json).map(([key, r]) => ({
    id: str(r.id) || key.replace(/F$/, ''),
    type: str(r.type),
    amount: num(r.amount),
    currency: cur(r.currency) ?? '',
    valueAtTransaction: num(r.value_at_transaction),
    price: num(r.price),
  }));
  return { accountCurrency: str(json.account_currency).toUpperCase(), rows };
}

export function parseBalance(json: Record<string, unknown>): { accountCurrency: string; amounts: Map<string, number> } {
  const details = (json.details ?? {}) as Record<string, Record<string, unknown>>;
  const amounts = new Map<string, number>();
  for (const [coin, d] of Object.entries(details)) {
    const amount = num(d?.amount);
    if (amount !== null) amounts.set(str(d?.coin) || coin, amount);
  }
  return { accountCurrency: str(json.account_currency).toUpperCase(), amounts };
}

export interface CoinTrackingClientOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  /** Called with the time of every API call, so the UI can show the hourly budget. */
  onCall?: (at: number) => void;
}

export class CoinTrackingClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly creds: CtCredentials,
    private readonly options: CoinTrackingClientOptions = {},
  ) {
    this.endpoint = options.endpoint ?? '/api/ct';
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  async call(method: string, params: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    const body = buildPostData(method, params, nextNonce());
    const sign = await hmacSha512Hex(this.creds.secret, body);
    this.options.onCall?.(Date.now());
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: this.creds.key, Sign: sign },
      body,
    });
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new CoinTrackingError('INVALID_RESPONSE', `CoinTracking answered with HTTP ${res.status} and no JSON.`);
    }
    if (String(json.success) !== '1') {
      throw new CoinTrackingError(str(json.error) || `HTTP_${res.status}`, str(json.error_msg) || 'CoinTracking request failed.');
    }
    return json;
  }

  async getTrades(): Promise<CtTrade[]> {
    return parseTrades(await this.call('getTrades', { order: 'ASC' }));
  }

  async getLedger(): Promise<{ accountCurrency: string; rows: CtLedgerRow[] }> {
    return parseLedger(await this.call('getLedger'));
  }

  async getBalance(): Promise<{ accountCurrency: string; amounts: Map<string, number> }> {
    return parseBalance(await this.call('getBalance'));
  }
}
