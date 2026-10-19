export class ParqetError extends Error {
    status;
    body;
    constructor(status, message, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'ParqetError';
    }
}
export class ParqetAuthError extends ParqetError {
    constructor(status, body) {
        super(status, 'Your Parqet session has expired. Please connect again.', body);
        this.name = 'ParqetAuthError';
    }
}
export const BATCH_SIZE = 100;
export function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size)
        out.push(list.slice(i, i + size));
    return out;
}
export class ParqetClient {
    getToken;
    base;
    fetchImpl;
    sleep;
    constructor(getToken, options = {}) {
        this.getToken = getToken;
        this.base = options.base ?? '/api/parqet';
        this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    async request(method, path, body) {
        for (let attempt = 0;; attempt++) {
            const token = await this.getToken();
            const res = await this.fetchImpl(this.base + path, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                const retryAfter = Number(res.headers.get('retry-after'));
                await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
                continue;
            }
            const text = await res.text();
            const json = text ? safeJson(text) : undefined;
            if (res.status === 401)
                throw new ParqetAuthError(res.status, json);
            if (!res.ok)
                throw new ParqetError(res.status, errorMessage(res.status, json), json);
            return json;
        }
    }
    async listPortfolios() {
        const res = await this.request('GET', '/portfolios');
        return res.items.map(({ id, name, currency }) => ({ id, name, currency }));
    }
    async createPortfolio(name) {
        const res = await this.request('POST', '/portfolios', { name });
        return res.id;
    }
    /** All crypto activities of a portfolio, following the cursor. */
    async listCryptoActivities(portfolioId) {
        const out = [];
        let cursor = null;
        do {
            const q = new URLSearchParams({ limit: '500', assetType: 'crypto' });
            if (cursor)
                q.set('cursor', cursor);
            const res = await this.request('GET', `/portfolios/${encodeURIComponent(portfolioId)}/activities?${q}`);
            for (const a of res.activities) {
                out.push({
                    id: a.id,
                    externalId: a.externalId,
                    type: a.type,
                    symbol: a.asset && 'symbol' in a.asset ? a.asset.symbol : undefined,
                    shares: a.shares ?? 0,
                    datetime: a.datetime,
                });
            }
            cursor = res.cursor ?? null;
        } while (cursor);
        return out;
    }
    async createActivities(portfolioId, activities, onProgress) {
        let created = 0;
        const failures = [];
        let done = 0;
        for (const batch of chunk(activities, BATCH_SIZE)) {
            const res = await this.request('POST', `/portfolios/${encodeURIComponent(portfolioId)}/activities`, { activities: batch });
            created += res.createdActivities?.length ?? 0;
            for (const nc of res.notCreatedActivities ?? []) {
                const idx = nc.error?.originalIndex;
                const activity = idx !== undefined ? batch[idx] : undefined;
                if (activity)
                    failures.push({ activity, code: nc.error?.code ?? 'unknown', message: nc.error?.message ?? '' });
            }
            done += batch.length;
            onProgress?.(done);
        }
        return { created, failures };
    }
    /**
     * Deletes activities and returns how many Parqet confirmed.
     * Listing returns ids like "cpa_<objectId>" while create/delete answer with a bare "_id", and Parqet
     * silently ignores ids it doesn't know. So each id is sent in both forms; the unknown form is a no-op.
     */
    async deleteActivities(portfolioId, ids) {
        const forms = [...new Set(ids.flatMap((id) => [id, id.replace(/^[a-z]+_/, '')]))];
        const deleted = new Set();
        for (const batch of chunk(forms, BATCH_SIZE)) {
            const res = await this.request('DELETE', `/portfolios/${encodeURIComponent(portfolioId)}/activities`, { activityIds: batch });
            for (const d of res.deletedActivities ?? [])
                if (d._id)
                    deleted.add(d._id.replace(/^[a-z]+_/, ''));
        }
        return deleted.size;
    }
}
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function errorMessage(status, body) {
    if (body && typeof body === 'object') {
        const b = body;
        const msg = b.message ?? b.error ?? b.relayError;
        if (msg)
            return `Parqet error ${status}: ${Array.isArray(msg) ? msg.join(', ') : String(msg)}`;
    }
    return `Parqet error ${status}`;
}
