import { createHash } from 'node:crypto';
import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { OAuthError, ParqetOAuth, pkceChallenge } from '../public/app/core/oauth.js';
import { FakeParqet } from './fakes/fakeParqet.js';
import { MemoryStorage } from './helpers/memoryStorage.js';
const config = (fake) => ({
    clientId: fake.clientId,
    authorizeUrl: 'https://connect.parqet.com/oauth2/authorize',
    tokenUrl: '/api/parqet/oauth2/token',
    redirectUri: 'https://app.test/callback',
    scope: 'portfolio:read portfolio:write',
});
async function login(fake, storage = new MemoryStorage()) {
    const oauth = new ParqetOAuth(config(fake), storage, fake.fetch());
    const authorizeUrl = new URL(await oauth.beginLogin());
    const redirect = fake.authorize(authorizeUrl.searchParams);
    const callback = new URL(redirect.headers.location);
    expect(oauth.isCallback(callback)).toBe(true);
    await oauth.completeLogin(callback);
    return { oauth, storage, authorizeUrl, callback };
}
describe('Parqet OAuth with PKCE', () => {
    it('computes the S256 challenge like an independent implementation', async () => {
        for (const verifier of ['dBjftJeZ4CVP-mJ92ZTUxnr8EsTZsNJ7RBbl2Ttzpx0', 'a'.repeat(128)]) {
            expect(await pkceChallenge(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
        }
    });
    it('sends the documented parameters to the authorize endpoint', async () => {
        const { authorizeUrl } = await login(new FakeParqet());
        expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://connect.parqet.com/oauth2/authorize');
        expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
            response_type: 'code', client_id: 'test-client', scope: 'portfolio:read portfolio:write', code_challenge_method: 'S256',
        });
    });
    it('logs in and keeps tokens only in the given session storage', async () => {
        const { oauth, storage } = await login(new FakeParqet());
        expect(oauth.isConnected()).toBe(true);
        expect(await oauth.accessToken()).toMatch(/^at_/);
        expect(storage.getItem('cb.pkce.verifier')).toBeNull();
    });
    it('rejects a callback with a foreign state', async () => {
        const fake = new FakeParqet();
        const oauth = new ParqetOAuth(config(fake), new MemoryStorage(), fake.fetch());
        await oauth.beginLogin();
        await expect(oauth.completeLogin(new URL('https://app.test/callback?code=x&state=forged'))).rejects.toBeInstanceOf(OAuthError);
    });
    it('surfaces a denied consent', async () => {
        const fake = new FakeParqet();
        const oauth = new ParqetOAuth(config(fake), new MemoryStorage(), fake.fetch());
        await oauth.beginLogin();
        await expect(oauth.completeLogin(new URL('https://app.test/callback?error=access_denied&state=s'))).rejects.toThrow(/access_denied/);
    });
    it('refreshes an expiring token once, even for parallel callers', async () => {
        const fake = new FakeParqet();
        const { oauth, storage } = await login(fake);
        const t = JSON.parse(storage.getItem('cb.tokens'));
        storage.setItem('cb.tokens', JSON.stringify({ ...t, expiresAt: Date.now() + 1000 }));
        const before = fake.requests.length;
        const [a, b] = await Promise.all([oauth.accessToken(), oauth.accessToken()]);
        expect(a).toBe(b);
        expect(a).not.toBe(t.accessToken);
        expect(fake.requests.slice(before).filter((r) => r.path === '/oauth2/token')).toHaveLength(1);
    });
    it('logout forgets the tokens', async () => {
        const { oauth } = await login(new FakeParqet());
        oauth.logout();
        await expect(oauth.accessToken()).rejects.toBeInstanceOf(OAuthError);
    });
});
