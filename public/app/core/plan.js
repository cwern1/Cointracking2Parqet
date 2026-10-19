import { EXTERNAL_ID_RE, safeId } from './mapping.js';
const TYPE_ORDER = { transfer_in: 0, buy: 1, sell: 2, transfer_out: 3 };
export function sortForCreation(list) {
    return [...list].sort((a, b) => a.datetime.localeCompare(b.datetime) || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));
}
/** Only activities this tool created carry an externalId of the form ct-<id>-<x>-<hash>. */
export function ownTradeKey(a) {
    const m = a.externalId ? EXTERNAL_ID_RE.exec(a.externalId) : null;
    return m ? m[1] : null;
}
export function buildPlan(mapped, existing) {
    const byTrade = new Map();
    for (const a of existing) {
        const key = ownTradeKey(a);
        if (key === null)
            continue;
        const list = byTrade.get(key) ?? [];
        list.push(a);
        byTrade.set(key, list);
    }
    const trades = [];
    const create = [];
    const deleteChanged = [];
    const seen = new Set();
    for (const m of mapped) {
        const key = safeId(m.trade.id);
        seen.add(key);
        const have = byTrade.get(key) ?? [];
        if (m.skipped) {
            // A transaction that is now skipped but was synced before counts as changed: its old activities go.
            if (have.length) {
                deleteChanged.push(...have);
                trades.push({ mapped: m, status: 'changed' });
            }
            else
                trades.push({ mapped: m, status: 'skipped' });
            continue;
        }
        const want = new Set(m.activities.map((a) => a.externalId));
        const haveIds = new Set(have.map((a) => a.externalId));
        const missing = m.activities.filter((a) => !haveIds.has(a.externalId));
        const stale = have.filter((a) => !want.has(a.externalId));
        if (missing.length === 0 && stale.length === 0) {
            trades.push({ mapped: m, status: 'unchanged' });
            continue;
        }
        create.push(...missing);
        deleteChanged.push(...stale);
        trades.push({ mapped: m, status: have.length ? 'changed' : 'new' });
    }
    const orphaned = existing.filter((a) => {
        const key = ownTradeKey(a);
        return key !== null && !seen.has(key);
    });
    const counts = { new: 0, changed: 0, unchanged: 0, skipped: 0, orphaned: orphaned.length };
    for (const t of trades)
        counts[t.status]++;
    return { trades, create: sortForCreation(create), deleteChanged, orphaned, counts };
}
