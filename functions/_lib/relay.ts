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

export interface RelayEnv {
  /** Test-only override for the CoinTracking endpoint. Empty in production. */
  CT_UPSTREAM?: string;
  /** Test-only override for the Parqet API origin. Empty in production. */
  PARQET_UPSTREAM?: string;
  /** Only set if Parqet requires a confidential client. This is an app secret, not user data. */
  PARQET_CLIENT_SECRET?: string;
}

export const CT_DEFAULT = 'https://cointracking.info/api/v1/';
export const PARQET_DEFAULT = 'https://connect.parqet.com';
export const MAX_BODY_BYTES = 1_000_000;

const ID = '[A-Za-z0-9_-]{1,64}';
const PARQET_ROUTES: ReadonlyArray<{ re: RegExp; methods: readonly string[] }> = [
  { re: /^\/oauth2\/token$/, methods: ['POST'] },
  { re: /^\/user$/, methods: ['GET'] },
  { re: /^\/portfolios$/, methods: ['GET', 'POST'] },
  { re: new RegExp(`^/portfolios/${ID}/activities$`), methods: ['GET', 'POST', 'DELETE'] },
  { re: new RegExp(`^/portfolios/${ID}/holdings$`), methods: ['GET'] },
];

const PASS_RESPONSE_HEADERS = ['content-type', 'retry-after'];

export async function handleRelay(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!isSameOriginBrowserRequest(request, url)) return fail(403, 'cross_origin_request');

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return fail(413, 'body_too_large');

  const route = url.pathname.replace(/^\/api/, '');

  if (route === '/ct') {
    if (request.method !== 'POST') return fail(405, 'method_not_allowed');
    const body = await readBody(request);
    if (body === null) return fail(413, 'body_too_large');
    const headers = pick(request.headers, ['key', 'sign']);
    headers.set('content-type', 'application/x-www-form-urlencoded');
    return forward(env.CT_UPSTREAM || CT_DEFAULT, { method: 'POST', headers, body });
  }

  if (route.startsWith('/parqet/')) {
    const path = route.slice('/parqet'.length);
    const allowed = PARQET_ROUTES.find((r) => r.re.test(path));
    if (!allowed) return fail(404, 'unknown_route');
    if (!allowed.methods.includes(request.method)) return fail(405, 'method_not_allowed');

    const headers = pick(request.headers, ['authorization', 'content-type', 'accept']);
    let body: BodyInit | undefined;
    if (request.method !== 'GET') {
      const raw = await readBody(request);
      if (raw === null) return fail(413, 'body_too_large');
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

export function isSameOriginBrowserRequest(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  if (site !== null && site !== 'same-origin') return false;
  if (origin !== null && origin !== url.origin) return false;
  // Browsers always send at least one of the two on fetch(). Plain scripts usually don't.
  return site !== null || origin !== null;
}

async function readBody(request: Request): Promise<ArrayBuffer | null> {
  const buf = await request.arrayBuffer();
  return buf.byteLength > MAX_BODY_BYTES ? null : buf;
}

function pick(source: Headers, names: string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

async function forward(target: string, init: RequestInit): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(target, { ...init, redirect: 'manual' });
  } catch {
    return fail(502, 'upstream_unreachable');
  }
  const headers = pick(upstream.headers, PASS_RESPONSE_HEADERS);
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ relayError: error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
