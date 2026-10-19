// End to end without a browser: the real dev server and relay, the real core modules,
// and fake CoinTracking and Parqet servers behind them. Everything talks HTTP.
import { get } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { CoinTrackingClient } from '../public/app/core/cointracking.js';
import { DEFAULT_OPTIONS } from '../public/app/core/mapping.js';
import { ParqetOAuth } from '../public/app/core/oauth.js';
import { ParqetClient } from '../public/app/core/parqet.js';
import { executePlan, fetchSource, makePlan } from '../public/app/core/sync.js';
import { startFakeUpstream } from './fakes/upstream.js';
import { expect } from './helpers/expect.js';
import { MemoryStorage } from './helpers/memoryStorage.js';

const UPSTREAM_PORT = 9921;
const APP_PORT = 9922;
const APP = `http://localhost:${APP_PORT}`;
const UPSTREAM = `http://localhost:${UPSTREAM_PORT}`;

let upstream;
let app;

/** fetch as the browser would send it: relative URLs and same-origin headers. */
const browserFetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('origin', APP);
  headers.set('sec-fetch-site', 'same-origin');
  return fetch(new URL(String(input), APP), { ...init, headers, redirect: 'manual' });
};

const upstreamState = async () => (await fetch(`${UPSTREAM}/__state`)).json();

before(async () => {
  upstream = await startFakeUpstream(UPSTREAM_PORT);
  Object.assign(process.env, {
    PARQET_CLIENT_ID: 'test-client',
    PARQET_AUTHORIZE_URL: `${UPSTREAM}/parqet/oauth2/authorize`,
    CT_UPSTREAM: `${UPSTREAM}/ct`,
    PARQET_UPSTREAM: `${UPSTREAM}/parqet`,
  });
  const { startDevServer } = await import('../dev/server.js');
  app = await startDevServer(APP_PORT);
});

after(async () => {
  await new Promise((r) => app.close(r));
  await new Promise((r) => upstream.close(r));
});

describe('dev server, relay and app core together', () => {
  it('serves the app with its security headers and the SPA fallback', async () => {
    const res = await fetch(`${APP}/callback?code=x&state=y`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch("script-src 'self'");
    expect(await res.text()).toMatch('<h1>Cointracking2Parqet</h1>');
    expect((await fetch(`${APP}/app/core/sync.js`)).headers.get('content-type')).toMatch('javascript');
    // fetch() normalises "..", so send raw paths. Nothing outside public/ may ever be served.
    const rawGet = (path) =>
      new Promise((resolve) =>
        get({ host: 'localhost', port: APP_PORT, path }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }),
      );
    for (const path of ['/%2e%2e/package.json', '/app%2F..%2F..%2Fpackage.json', '/..%2F.env.local', '/_headers']) {
      const { status, body } = await rawGet(path);
      expect(body).not.toContain('"private": true');
      expect(body).not.toContain('PARQET_CLIENT_ID=');
      expect(body).not.toContain('Content-Security-Policy:');
      expect([200, 400]).toContain(status);
    }
  });

  it('logs in, syncs, stays idempotent and never leaks the API secret', async () => {
    await fetch(`${UPSTREAM}/__reset`);
    const config = await (await browserFetch('/api/config')).json();
    expect(config.clientId).toBe('test-client');

    const oauth = new ParqetOAuth(
      { ...config, tokenUrl: '/api/parqet/oauth2/token', redirectUri: `${APP}/callback`, scope: 'portfolio:read portfolio:write' },
      new MemoryStorage(),
      browserFetch,
    );
    // The browser would follow the redirect from the authorize page back to /callback.
    const authorize = await fetch(await oauth.beginLogin(), { redirect: 'manual' });
    await oauth.completeLogin(new URL(authorize.headers.get('location')));

    const parqet = new ParqetClient(() => oauth.accessToken(), { fetch: browserFetch });
    const ct = new CoinTrackingClient({ key: 'ct-key', secret: 'ct-secret' }, { fetch: browserFetch });

    const source = await fetchSource(ct);
    const plan = makePlan(source, await parqet.listCryptoActivities('pf_main'), DEFAULT_OPTIONS);
    const result = await executePlan(parqet, 'pf_main', plan, { removeOrphans: false });
    expect(result).toMatchObject({ created: 8, deleted: 0, notDeleted: 0, failures: [] });

    const again = makePlan(source, await parqet.listCryptoActivities('pf_main'), DEFAULT_OPTIONS);
    expect(again.create).toHaveLength(0);

    const state = await upstreamState();
    expect(state.ctCalls).toEqual(['getTrades', 'getLedger']);
    expect(state.seen.filter((s) => JSON.stringify(s).includes('ct-secret'))).toEqual([]);
    expect(state.activities.pf_main).toHaveLength(8);
  });

  it('refuses requests from other sites', async () => {
    const res = await fetch(`${APP}/api/parqet/portfolios`, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
  });
});
