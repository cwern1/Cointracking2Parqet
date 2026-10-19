/**
 * Stateless relay. Neither CoinTracking nor Parqet send CORS headers that would
 * let a browser call them from this origin, so the app sends its requests here
 * and this function forwards them unchanged.
 *
 * Rules, enforced below:
 * - Only two upstreams, and on Parqet only the paths the app needs.
 * - Only same-origin browser requests.
 * - Nothing is stored and nothing is logged. Do not add console.* calls here.
 * - Only the headers each upstream needs are forwarded, in both directions.
 *
 * The CoinTracking API secret never reaches this code: the browser signs each
 * request itself and only sends the public key and the one-time signature.
 */
/**
 * @typedef {object} RelayEnv
 * @property {string} [PARQET_CLIENT_ID] Client ID of the Parqet integration. Public, served to the app via /api/config.
 * @property {string} [PARQET_AUTHORIZE_URL] Override for the OAuth authorize URL. Tests only.
 * @property {string} [PARQET_CLIENT_SECRET] Only if Parqet ever requires a confidential client. An app secret, not user data.
 * @property {string} [CT_UPSTREAM] Override for the CoinTracking endpoint. Tests only.
 * @property {string} [PARQET_UPSTREAM] Override for the Parqet API origin. Tests only.
 */

export const PARQET_AUTHORIZE_DEFAULT = 'https://connect.parqet.com/oauth2/authorize';
export const CT_DEFAULT = 'https://cointracking.info/api/v1/';
export const PARQET_DEFAULT = 'https://connect.parqet.com';
export const MAX_BODY_BYTES = 1_000_000;
const ID = '[A-Za-z0-9_-]{1,64}';
const PARQET_ROUTES = [
    { re: /^\/oauth2\/token$/, methods: ['POST'] },
    { re: /^\/user$/, methods: ['GET'] },
    { re: /^\/portfolios$/, methods: ['GET', 'POST'] },
    { re: new RegExp(`^/portfolios/${ID}/activities$`), methods: ['GET', 'POST', 'DELETE'] },
    { re: new RegExp(`^/portfolios/${ID}/holdings$`), methods: ['GET'] },
];
const PASS_RESPONSE_HEADERS = ['content-type', 'retry-after'];
/**
 * @param {Request} request
 * @param {RelayEnv} env
 * @returns {Promise<Response>}
 */
export async function handleRelay(request, env) {
    const url = new URL(request.url);
    if (!isSameOriginBrowserRequest(request, url))
        return fail(403, 'cross_origin_request');
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES)
        return fail(413, 'body_too_large');
    const route = url.pathname.replace(/^\/api/, '');
    if (route === '/config') {
        if (request.method !== 'GET')
            return fail(405, 'method_not_allowed');
        // Public app configuration. The client ID of an OAuth public client is not a secret.
        return new Response(JSON.stringify({
            clientId: env.PARQET_CLIENT_ID || '',
            authorizeUrl: env.PARQET_AUTHORIZE_URL || PARQET_AUTHORIZE_DEFAULT,
        }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (route === '/ct') {
        if (request.method !== 'POST')
            return fail(405, 'method_not_allowed');
        const body = await readBody(request);
        if (body === null)
            return fail(413, 'body_too_large');
        const headers = pick(request.headers, ['key', 'sign']);
        headers.set('content-type', 'application/x-www-form-urlencoded');
        return forward(env.CT_UPSTREAM || CT_DEFAULT, { method: 'POST', headers, body });
    }
    if (route.startsWith('/parqet/')) {
        const path = route.slice('/parqet'.length);
        const allowed = PARQET_ROUTES.find((r) => r.re.test(path));
        if (!allowed)
            return fail(404, 'unknown_route');
        if (!allowed.methods.includes(request.method))
            return fail(405, 'method_not_allowed');
        const headers = pick(request.headers, ['authorization', 'content-type', 'accept']);
        let body;
        if (request.method !== 'GET') {
            const raw = await readBody(request);
            if (raw === null)
                return fail(413, 'body_too_large');
            body = raw;
            if (path === '/oauth2/token' && env.PARQET_CLIENT_SECRET) {
                const form = new URLSearchParams(new TextDecoder().decode(raw));
                form.set('client_secret', env.PARQET_CLIENT_SECRET);
                body = form.toString();
                headers.set('content-type', 'application/x-www-form-urlencoded');
            }
        }
        const base = (env.PARQET_UPSTREAM || PARQET_DEFAULT).replace(/\/$/, '');
        return forward(base + path + url.search, { method: request.method, headers, body });
    }
    return fail(404, 'unknown_route');
}
export function isSameOriginBrowserRequest(request, url) {
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    if (site !== null && site !== 'same-origin')
        return false;
    if (origin !== null && origin !== url.origin)
        return false;
    // Browsers always send at least one of the two on fetch(). Plain scripts usually don't.
    return site !== null || origin !== null;
}
async function readBody(request) {
    const buf = await request.arrayBuffer();
    return buf.byteLength > MAX_BODY_BYTES ? null : buf;
}
function pick(source, names) {
    const out = new Headers();
    for (const name of names) {
        const value = source.get(name);
        if (value !== null)
            out.set(name, value);
    }
    return out;
}
async function forward(target, init) {
    let upstream;
    try {
        upstream = await fetch(target, { ...init, redirect: 'manual' });
    }
    catch {
        return fail(502, 'upstream_unreachable');
    }
    const headers = pick(upstream.headers, PASS_RESPONSE_HEADERS);
    headers.set('cache-control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
}
function fail(status, error) {
    return new Response(JSON.stringify({ relayError: error }), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
}
