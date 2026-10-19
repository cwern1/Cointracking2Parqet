/** One HTTP server that plays both CoinTracking (/ct) and Parqet (/parqet/*) for the e2e run. */
import { createServer } from 'node:http';
import { FakeCoinTracking } from './fakeCoinTracking.js';
import { FakeParqet } from './fakeParqet.js';
export const UPSTREAM_PORT = 9911;
export function startFakeUpstream(port = UPSTREAM_PORT) {
    let ct = new FakeCoinTracking();
    let parqet = new FakeParqet();
    /** Everything that reached the upstreams through the relay, for leak checks. */
    let seen = [];
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', `http://localhost:${port}`);
            const body = Buffer.concat(chunks).toString('utf8');
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers))
                if (typeof v === 'string')
                    headers.set(k, v);
            const send = (status, payload, extra = {}) => {
                res.writeHead(status, { 'content-type': 'application/json', ...extra });
                res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            };
            if (url.pathname === '/__reset') {
                ct = new FakeCoinTracking();
                parqet = new FakeParqet();
                seen = [];
                return send(200, { ok: true });
            }
            if (url.pathname === '/__state') {
                return send(200, { activities: Object.fromEntries(parqet.activities), ctCalls: ct.calls, seen, portfolios: parqet.portfolios });
            }
            if (url.pathname === '/__ct/trades' && req.method === 'POST') {
                ct.trades = JSON.parse(body);
                return send(200, { ok: true });
            }
            if (url.pathname !== '/parqet/oauth2/authorize') {
                seen.push({ path: url.pathname, headers: Object.fromEntries(headers), body });
            }
            if (url.pathname === '/ct') {
                const r = ct.handle(headers, body);
                return send(r.status, r.body);
            }
            if (url.pathname.startsWith('/parqet/')) {
                const r = parqet.handle({
                    method: req.method ?? 'GET', path: url.pathname.slice('/parqet'.length), query: url.searchParams, headers, body,
                });
                return send(r.status, r.body, r.headers);
            }
            send(404, { message: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
