/** Non-secret, per-browser conveniences. Every access tolerates blocked storage. */
import { DEFAULT_OPTIONS } from './core/mapping.js';
const K_OPTIONS = 'cb.options';
const K_PORTFOLIO = 'cb.portfolio';
const K_CALLS = 'cb.ctCalls';
function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    }
    catch {
        return fallback;
    }
}
function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        /* storage unavailable */
    }
}
export const DEFAULT_SYNC_OPTIONS = { ...DEFAULT_OPTIONS, removeOrphans: false };
export const loadOptions = () => read(K_OPTIONS, DEFAULT_SYNC_OPTIONS);
export const saveOptions = (o) => write(K_OPTIONS, o);
export const loadPortfolioId = () => read(K_PORTFOLIO, { id: null }).id;
export const savePortfolioId = (id) => write(K_PORTFOLIO, { id });
/** CoinTracking call times within the last hour. */
export function recentCalls(now = Date.now()) {
    return read(K_CALLS, { t: [] }).t.filter((t) => now - t < 3_600_000);
}
export function recordCall(at) {
    write(K_CALLS, { t: [...recentCalls(at), at] });
}
/** "IOTA=MIOTA" lines to a map, upper-cased. */
export function parseSymbolMap(text) {
    const out = {};
    for (const line of text.split(/\n|,/)) {
        const m = /^\s*([A-Za-z0-9._-]+)\s*(?:=|->|→)\s*([A-Za-z0-9._-]+)\s*$/.exec(line);
        if (m)
            out[m[1].toUpperCase()] = m[2].toUpperCase();
    }
    return out;
}
export function formatSymbolMap(map) {
    return Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
}
export function parseSymbolList(text) {
    return [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}
