import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { handleRelay, MAX_BODY_BYTES } from '../functions/_lib/relay.js';
const ORIGIN = 'https://sync.example.com';
const calls = [];
function stubUpstream(status = 200, body = '{"ok":true}', headers = {}) {
    vi.stubGlobal('fetch', async (url, init) => {
        calls.push({ url, init });
        return new Response(body, { status, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', ...headers } });
    });
}
function req(path, init = {}) {
    return new Request(ORIGIN + path, {
        ...init,
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...init.headers },
    });
}
afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
});
describe('relay', () => {
    it('forwards CoinTracking calls with only key, sign and the body', async () => {
        stubUpstream();
        const res = await handleRelay(req('/api/ct', { method: 'POST', body: 'method=getTrades&nonce=1', headers: { key: 'K', sign: 'S', cookie: 'x=y', 'x-other': '1' } }), {});
        expect(res.status).toBe(200);
        expect(calls[0].url).toBe('https://cointracking.info/api/v1/');
        const sent = new Headers(calls[0].init.headers);
        expect([...sent.keys()].sort()).toEqual(['content-type', 'key', 'sign']);
        expect(new TextDecoder().decode(calls[0].init.body)).toBe('method=getTrades&nonce=1');
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
    it('forwards allowed Parqet routes with the query string and the bearer token', async () => {
        stubUpstream();
        const res = await handleRelay(req('/api/parqet/portfolios/pf_1/activities?limit=500&cursor=abc', { headers: { authorization: 'Bearer T' } }), {});
        expect(res.status).toBe(200);
        expect(calls[0].url).toBe('https://connect.parqet.com/portfolios/pf_1/activities?limit=500&cursor=abc');
        expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer T');
    });
    for (const [path, method] of [
        ['/api/parqet/performance', 'POST'],
        ['/api/parqet/portfolios/pf_1/holdings/custom', 'POST'],
        ['/api/parqet/portfolios/pf%2F1/activities', 'GET'],
        ['/api/elsewhere', 'GET'],
    ]) {
        it(`refuses ${path}`, async () => {
        stubUpstream();
        const res = await handleRelay(req(path, { method, body: method === 'GET' ? undefined : '{}' }), {});
        expect(res.status).toBe(404);
        expect(calls).toHaveLength(0);
    });
    }
    it('serves the public app configuration without contacting an upstream', async () => {
        stubUpstream();
        const res = await handleRelay(req('/api/config'), { PARQET_CLIENT_ID: 'abc', PARQET_CLIENT_SECRET: 'never' });
        const body = await res.json();
        expect(body).toEqual({ clientId: 'abc', authorizeUrl: 'https://connect.parqet.com/oauth2/authorize' });
        expect(JSON.stringify(body)).not.toContain('never');
        expect(calls).toHaveLength(0);
    });
    it('refuses wrong methods', async () => {
        stubUpstream();
        expect((await handleRelay(req('/api/ct'), {})).status).toBe(405);
        expect((await handleRelay(req('/api/parqet/user', { method: 'DELETE' }), {})).status).toBe(405);
        expect(calls).toHaveLength(0);
    });
    it('refuses cross-site and header-less requests', async () => {
        stubUpstream();
        const cross = new Request(`${ORIGIN}/api/parqet/user`, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
        const bare = new Request(`${ORIGIN}/api/parqet/user`);
        const forgedOrigin = new Request(`${ORIGIN}/api/parqet/user`, { headers: { origin: 'https://evil.example' } });
        for (const r of [cross, bare, forgedOrigin])
            expect((await handleRelay(r, {})).status).toBe(403);
        expect(calls).toHaveLength(0);
    });
    it('refuses oversized bodies', async () => {
        stubUpstream();
        const big = 'x'.repeat(MAX_BODY_BYTES + 1);
        const res = await handleRelay(req('/api/ct', { method: 'POST', body: big }), {});
        expect(res.status).toBe(413);
        expect(calls).toHaveLength(0);
    });
    it('adds the client secret to token requests only when configured', async () => {
        stubUpstream();
        await handleRelay(req('/api/parqet/oauth2/token', { method: 'POST', body: 'grant_type=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), {
            PARQET_CLIENT_SECRET: 's3cret',
        });
        expect(String(calls[0].init.body)).toBe('grant_type=x&client_secret=s3cret');
        await handleRelay(req('/api/parqet/oauth2/token', { method: 'POST', body: 'grant_type=x' }), {});
        expect(new TextDecoder().decode(calls[1].init.body)).toBe('grant_type=x');
    });
    it('passes upstream status and retry-after through', async () => {
        stubUpstream(429, '{}', { 'retry-after': '7' });
        const res = await handleRelay(req('/api/parqet/portfolios'), {});
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('7');
    });
    it('never logs', async () => {
        stubUpstream();
        const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m));
        await handleRelay(req('/api/ct', { method: 'POST', body: 'a=b', headers: { key: 'K', sign: 'S' } }), {});
        await handleRelay(req('/api/nope'), {});
        for (const s of spies)
            expect(s).not.toHaveBeenCalled();
    });
});
