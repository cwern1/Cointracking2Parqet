/** Non-secret, per-browser conveniences. Every access tolerates blocked storage. */
import { DEFAULT_OPTIONS, type MapOptions } from '../core/mapping';

export type SyncOptions = Omit<MapOptions, 'accountCurrency'> & { removeOrphans: boolean };

const K_OPTIONS = 'cb.options';
const K_PORTFOLIO = 'cb.portfolio';
const K_CALLS = 'cb.ctCalls';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = { ...DEFAULT_OPTIONS, removeOrphans: false };

export const loadOptions = (): SyncOptions => read(K_OPTIONS, DEFAULT_SYNC_OPTIONS);
export const saveOptions = (o: SyncOptions): void => write(K_OPTIONS, o);

export const loadPortfolioId = (): string | null => read<{ id: string | null }>(K_PORTFOLIO, { id: null }).id;
export const savePortfolioId = (id: string | null): void => write(K_PORTFOLIO, { id });

/** CoinTracking call times within the last hour. */
export function recentCalls(now = Date.now()): number[] {
  return read<{ t: number[] }>(K_CALLS, { t: [] }).t.filter((t) => now - t < 3_600_000);
}

export function recordCall(at: number): void {
  write(K_CALLS, { t: [...recentCalls(at), at] });
}

/** "IOTA=MIOTA" lines to a map, upper-cased. */
export function parseSymbolMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\n|,/)) {
    const m = /^\s*([A-Za-z0-9._-]+)\s*(?:=|->|→)\s*([A-Za-z0-9._-]+)\s*$/.exec(line);
    if (m) out[m[1]!.toUpperCase()] = m[2]!.toUpperCase();
  }
  return out;
}

export function formatSymbolMap(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function parseSymbolList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}
