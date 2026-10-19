// Local development server with no dependencies. It mirrors Cloudflare Pages:
// static files from public/ with the headers from public/_headers, the SPA fallback,
// and /api/* handled by the same relay code that runs in production.
//
//   node dev/server.js            # http://localhost:8788
//   PORT=9000 node dev/server.js
//
// Settings come from environment variables or .env.local (KEY=value lines):
//   PARQET_CLIENT_ID      required for the Parqet login
//   CT_UPSTREAM, PARQET_UPSTREAM, PARQET_AUTHORIZE_URL   test overrides
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRelay } from '../functions/_lib/relay.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const fileEnv = loadEnvFile(join(root, '.env.local'));
const env = { ...fileEnv, ...process.env };
// Earlier versions used a Vite variable name. Accept it so existing .env.local files keep working.
env.PARQET_CLIENT_ID ||= env.VITE_PARQET_CLIENT_ID;

/** Headers for every static file, parsed from public/_headers (only the "/*" block is used). */
function staticHeaders() {
  const path = join(publicDir, '_headers');
  if (!existsSync(path)) return {};
  const headers = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) headers[m[1]] = m[2];
  }
  return headers;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = normalize(join(publicDir, decodeURIComponent(url.pathname)));
  if (!path.startsWith(publicDir + sep) && path !== publicDir) {
    res.writeHead(400).end();
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  // Like Pages without a 404.html: unknown paths get the app, e.g. /callback after the Parqet login.
  if (!existsSync(path) || path.endsWith(`${sep}_headers`)) path = join(publicDir, 'index.html');
  res.writeHead(200, {
    ...staticHeaders(),
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(path));
}

async function serveApi(req, res, port) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handleRelay(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function startDevServer(port = Number(process.env.PORT ?? 8788)) {
  const server = createServer((req, res) => {
    const handle = req.url.startsWith('/api/') ? serveApi(req, res, port) : Promise.resolve(serveStatic(req, res));
    handle.catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startDevServer();
  const { port } = server.address();
  if (!env.PARQET_CLIENT_ID) console.warn('PARQET_CLIENT_ID is not set. Add it to .env.local to enable the Parqet login.');
  console.log(`Ready on http://localhost:${port}`);
}
