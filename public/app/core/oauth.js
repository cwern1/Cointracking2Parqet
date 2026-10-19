/**
 * OAuth 2 authorization code flow with PKCE for Parqet Connect, as a public client.
 * Tokens live in sessionStorage only: they are gone when the tab closes.
 */
export class OAuthError extends Error {
    name = 'OAuthError';
}
const K_VERIFIER = 'cb.pkce.verifier';
const K_STATE = 'cb.pkce.state';
const K_TOKENS = 'cb.tokens';
export function base64url(bytes) {
    let s = '';
    for (const b of bytes)
        s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function randomString(byteLength = 32) {
    return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
export async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(digest));
}
export class ParqetOAuth {
    config;
    storage;
    fetchImpl;
    refreshing = null;
    constructor(config, storage = sessionStorage, fetchImpl = fetch.bind(globalThis)) {
        this.config = config;
        this.storage = storage;
        this.fetchImpl = fetchImpl;
    }
    /** Builds the authorize URL and remembers verifier and state for the callback. */
    async beginLogin() {
        const verifier = randomString(48);
        const state = randomString(16);
        this.storage.setItem(K_VERIFIER, verifier);
        this.storage.setItem(K_STATE, state);
        const url = new URL(this.config.authorizeUrl);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            scope: this.config.scope,
            state,
            code_challenge: await pkceChallenge(verifier),
            code_challenge_method: 'S256',
        }).toString();
        return url.toString();
    }
    /** True if `url` carries an OAuth response for us. */
    isCallback(url) {
        return url.searchParams.has('state') && (url.searchParams.has('code') || url.searchParams.has('error'));
    }
    async completeLogin(url) {
        const expectedState = this.storage.getItem(K_STATE);
        const verifier = this.storage.getItem(K_VERIFIER);
        this.storage.removeItem(K_STATE);
        this.storage.removeItem(K_VERIFIER);
        const error = url.searchParams.get('error');
        if (error)
            throw new OAuthError(url.searchParams.get('error_description') || `Parqet login failed: ${error}`);
        if (!expectedState || url.searchParams.get('state') !== expectedState || !verifier) {
            throw new OAuthError('The Parqet login could not be verified. Please try again.');
        }
        return this.tokenRequest({
            grant_type: 'authorization_code',
            code: url.searchParams.get('code') ?? '',
            redirect_uri: this.config.redirectUri,
            client_id: this.config.clientId,
            code_verifier: verifier,
        });
    }
    async tokenRequest(params) {
        const res = await this.fetchImpl(this.config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(params).toString(),
        });
        const json = (await res.json().catch(() => ({})));
        if (!res.ok || typeof json.access_token !== 'string') {
            const detail = (json.error_description ?? json.error ?? `HTTP ${res.status}`);
            throw new OAuthError(`Parqet token request failed: ${detail}`);
        }
        const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
        const tokens = {
            accessToken: json.access_token,
            refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : this.load()?.refreshToken,
            expiresAt: Date.now() + expiresIn * 1000,
        };
        this.storage.setItem(K_TOKENS, JSON.stringify(tokens));
        return tokens;
    }
    load() {
        const raw = this.storage.getItem(K_TOKENS);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    isConnected() {
        return this.load() !== null;
    }
    /** A valid access token, refreshed when it is about to expire. */
    async accessToken() {
        const t = this.load();
        if (!t)
            throw new OAuthError('Not connected to Parqet.');
        if (t.expiresAt - Date.now() > 60_000)
            return t.accessToken;
        if (!t.refreshToken)
            throw new OAuthError('Your Parqet session has expired. Please connect again.');
        this.refreshing ??= this.tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: t.refreshToken,
            client_id: this.config.clientId,
        }).finally(() => {
            this.refreshing = null;
        });
        return (await this.refreshing).accessToken;
    }
    logout() {
        this.storage.removeItem(K_TOKENS);
    }
}
