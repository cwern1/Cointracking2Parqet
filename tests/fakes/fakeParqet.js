/**
 * In-memory stand-in for Parqet Connect. It enforces what we know about the real API:
 * bearer auth, PKCE, the request schema from the OpenAPI spec, batch limits,
 * externalId deduplication and cursor pagination.
 */
import { createHash } from 'node:crypto';
import { createActivityBodyValidator } from './openapi.js';
function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export class FakeParqet {
    clientId = 'test-client';
    portfolios = [{ id: 'pf_main', name: 'Depot', currency: 'EUR' }];
    activities = new Map([['pf_main', []]]);
    /** Symbols the fake treats as unknown assets. */
    unknownSymbols = new Set(['NOTACOIN']);
    pageSize = 500;
    /** Real Parqet did not return createdActivities in a live run. Tests can mimic that. */
    omitCreatedList = false;
    /** Mimic the live API: listing shows "cpa_<id>", but delete only knows the bare id. */
    deleteNeedsBareId = false;
    requests = [];
    codes = new Map();
    validTokens = new Set();
    refreshTokens = new Set();
    seq = 0;
    /** For the e2e flow: what the authorize page would do after the user clicks "allow". */
    authorize(query) {
        if (query.get('client_id') !== this.clientId)
            return { status: 400, body: { error: 'invalid_client' } };
        if (query.get('code_challenge_method') !== 'S256')
            return { status: 400, body: { error: 'pkce_required' } };
        const code = `code_${++this.seq}`;
        this.codes.set(code, { challenge: query.get('code_challenge'), redirectUri: query.get('redirect_uri') });
        const target = new URL(query.get('redirect_uri'));
        target.searchParams.set('code', code);
        target.searchParams.set('state', query.get('state'));
        return { status: 302, body: '', headers: { location: target.toString() } };
    }
    issueToken() {
        const t = `at_${++this.seq}`;
        this.validTokens.add(t);
        return t;
    }
    revokeAll() {
        this.validTokens.clear();
    }
    handle(req) {
        this.requests.push(req);
        if (req.path === '/oauth2/authorize' && req.method === 'GET')
            return this.authorize(req.query);
        if (req.path === '/oauth2/token' && req.method === 'POST')
            return this.token(new URLSearchParams(req.body));
        const auth = req.headers.get('authorization') ?? '';
        if (!this.validTokens.has(auth.replace(/^Bearer /, '')))
            return { status: 401, body: { message: 'Unauthorized' } };
        if (req.path === '/user' && req.method === 'GET') {
            return { status: 200, body: { userId: 'u1', installationId: 'i1', state: 'active', permissions: [] } };
        }
        if (req.path === '/portfolios' && req.method === 'GET') {
            return {
                status: 200,
                body: {
                    items: this.portfolios.map((p) => ({
                        ...p, createdAt: '2024-01-01T00:00:00.000Z', calculationMethod: 'fifo', distinctBrokers: [], subAccounts: [],
                    })),
                },
            };
        }
        if (req.path === '/portfolios' && req.method === 'POST') {
            const { name } = JSON.parse(req.body);
            if (!name || name.length > 80)
                return { status: 400, body: { message: 'invalid name' } };
            const id = `pf_${++this.seq}`;
            this.portfolios.push({ id, name, currency: 'EUR' });
            this.activities.set(id, []);
            return { status: 200, body: { id } };
        }
        const m = /^\/portfolios\/([^/]+)\/activities$/.exec(req.path);
        if (m) {
            const list = this.activities.get(m[1]);
            if (!list)
                return { status: 404, body: { message: 'portfolio not found' } };
            if (req.method === 'GET')
                return this.list(list, req.query);
            if (req.method === 'POST')
                return this.create(list, req.body);
            if (req.method === 'DELETE')
                return this.remove(m[1], req.body);
        }
        return { status: 404, body: { message: 'not found' } };
    }
    token(form) {
        if (form.get('client_id') !== this.clientId)
            return { status: 401, body: { error: 'invalid_client' } };
        if (form.get('grant_type') === 'authorization_code') {
            const entry = this.codes.get(form.get('code') ?? '');
            this.codes.delete(form.get('code') ?? '');
            if (!entry)
                return { status: 400, body: { error: 'invalid_grant' } };
            const challenge = b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest());
            if (challenge !== entry.challenge)
                return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE mismatch' } };
            if (form.get('redirect_uri') !== entry.redirectUri)
                return { status: 400, body: { error: 'invalid_grant' } };
        }
        else if (form.get('grant_type') === 'refresh_token') {
            if (!this.refreshTokens.has(form.get('refresh_token') ?? ''))
                return { status: 400, body: { error: 'invalid_grant' } };
        }
        else
            return { status: 400, body: { error: 'unsupported_grant_type' } };
        const refresh = `rt_${++this.seq}`;
        this.refreshTokens.add(refresh);
        return { status: 200, body: { access_token: this.issueToken(), refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 } };
    }
    list(list, q) {
        const limit = Number(q.get('limit') ?? 100);
        if (!(limit >= 1 && limit <= 500))
            return { status: 400, body: { message: 'limit out of range' } };
        const start = Number(q.get('cursor') ?? 0);
        const size = Math.min(limit, this.pageSize);
        const page = list.slice(start, start + size);
        const next = start + size < list.length ? String(start + size) : null;
        return { status: 200, body: { activities: page, cursor: next } };
    }
    create(list, raw) {
        const body = JSON.parse(raw);
        const validate = createActivityBodyValidator();
        if (!validate(body))
            return { status: 400, body: { message: 'Validation failed', errors: validate.errors } };
        const created = [];
        const notCreated = [];
        body.activities.forEach((a, i) => {
            const symbol = String(a.symbol);
            if (this.unknownSymbols.has(symbol)) {
                notCreated.push({ error: { originalIndex: i, code: 'asset_not_found', message: `Unknown crypto ${symbol}` } });
                return;
            }
            const existing = a.externalId ? list.find((x) => x.externalId === a.externalId) : undefined;
            if (existing) {
                created.push({ _id: existing.id });
                return;
            }
            const id = this.deleteNeedsBareId ? `cpa_${String(++this.seq).padStart(24, '0')}` : `act_${++this.seq}`;
            list.push({
                id,
                externalId: a.externalId,
                type: a.type,
                shares: a.shares,
                price: a.price,
                currency: a.currency,
                datetime: a.datetime,
                fee: a.fee,
                asset: { assetIdentifierType: 'crypto_symbol', symbol },
                holdingAssetType: 'crypto',
            });
            created.push({ _id: id });
        });
        return {
            status: 200,
            body: this.omitCreatedList ? { notCreatedActivities: notCreated } : { createdActivities: created, notCreatedActivities: notCreated },
        };
    }
    remove(portfolioId, raw) {
        const { activityIds } = JSON.parse(raw);
        if (!Array.isArray(activityIds) || activityIds.length < 1 || activityIds.length > 100) {
            return { status: 400, body: { message: 'activityIds must have 1 to 100 items' } };
        }
        const list = this.activities.get(portfolioId);
        const ids = new Set(activityIds);
        const key = (id) => (this.deleteNeedsBareId ? id.replace(/^cpa_/, '') : id);
        const hit = (a) => ids.has(key(a.id)) && !(this.deleteNeedsBareId && ids.has(a.id) && !ids.has(key(a.id)));
        const deleted = list.filter(hit).map((a) => ({ _id: key(a.id) }));
        this.activities.set(portfolioId, list.filter((a) => !hit(a)));
        return { status: 200, body: { deletedActivities: deleted } };
    }
    /** fetch() replacement that routes `${base}/...` to this fake. */
    fetch(base = '/api/parqet') {
        return (async (input, init) => {
            const url = new URL(String(input), 'http://app.test');
            const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
            const res = this.handle({
                method: init?.method ?? 'GET',
                path,
                query: url.searchParams,
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? init.body : '',
            });
            return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), {
                status: res.status,
                headers: { 'content-type': 'application/json', ...res.headers },
            });
        });
    }
}
