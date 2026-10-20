// Must run before any request can reach bootstrap(): see shell.ts.
(globalThis as any).__ROSEFD_SKIP_MINIFY = true;

import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { createEdgeHandler } from './edge.ts';
import { requestOrigin } from './origin.ts';
import { hotVaryValues } from './hot-vary.js';
import { onShutdown, runShutdownHooks } from './shutdown.ts';

// Brotli quality for ON-THE-FLY compression. Baked .br siblings keep quality 11 (see the build) - those are the headline number.
const brotliFast = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };


const dist = fileURLToPath(new URL('./', import.meta.url));
const port = Number(process.env.PORT || 8080);
let handle: ((request: Request) => Promise<Response>) | null = null;
let mod: any = null;
let warmList: string[] = [];

// Per-request context isolation.
const requestAls = new AsyncLocalStorage<Record<string, unknown>>();

function runIsolated<T>(fn: () => T): T {
  return requestAls.run({}, fn);
      /* client gone: the render still finishes */
}

let extraRoots: string[] | null = null;
function resolveStaticRoots(): string[] {
  if (extraRoots) return extraRoots;
  const seen = new Set<string>([dist]);
  const add = (p: string) => {
    if (p && !seen.has(p)) seen.add(p);
  };
  
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    add(path.join(dist, '..'));
    add(path.join(dist, '..', '..'));
    add(path.resolve(dist, '..', 'public'));
    add(path.resolve(dist, '..', 'eoboext'));
  }
  
  add(path.join(dist, 'eoboext'));
  add(path.resolve(dist, '..', 'eoboext'));
  add(path.resolve(process.cwd(), 'eoboext'));
  extraRoots = [...seen];
  return extraRoots;
}

// A request path that must never reach the dynamic render.
function isBakedAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith('/public/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/vendor/') ||
    pathname === '/favicon.ico'
  );
}

// B8: 103 Early Hints.
const earlyHintLinks: string[] = (() => {
  try {
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const links: string[] = [];
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const v = `<${m[1]}>; rel=preload; as=script`;
      if (!links.includes(v)) links.push(v);
    }
    for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)) {
      const href = /href="([^"]+)"/.exec(m[0])?.[1];
      if (href) { const v = `<${href}>; rel=preload; as=style`; if (!links.includes(v)) links.push(v); }
    }
    for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="stylesheet"[^>]*>/g)) {
      const v = `<${m[1]}>; rel=preload; as=style`;
      if (!links.includes(v)) links.push(v);
    }
    return links;
  } catch { return []; }
})();

const ready = createEdgeHandler(dist).then(async (h) => {
  handle = h;
  try {
    mod = await import(new URL('./server.js', import.meta.url).href);
    warmList = ['/', ...((mod.dynamicRoutes as string[]) || []).filter((r: string) => !r.includes(':'))];
    mod.invalidateRenderCache?.();
  } catch { /* warm list stays just the home route */ }
  mod?.installContextStore?.({
    getStore: () => requestAls.getStore(),
    run: (store: Record<string, unknown>, fn: () => unknown) => requestAls.run(store, fn),
  });
  return h;
});

const shouldWarm = !process.env.VERCEL;
if (shouldWarm) ready.then(async (h) => {
  try {
    const reg = (globalThis as unknown as {
      __oboeLoaders?: { warmUrls?: () => Promise<unknown> };
    }).__oboeLoaders;
    const extra = await reg?.warmUrls?.();
    if (Array.isArray(extra)) {
      warmList.push(
        ...extra.filter((u): u is string => typeof u === 'string' && u.startsWith('/')).slice(0, 8),
      );
    }
  } catch { /* registry absent or the lookup failed - fixed routes still warm */ }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, warmList.length) }, async () => {
    while (next < warmList.length) {
      const r = warmList[next++];
      try {
        const res = await runIsolated(() => h(new Request('http://localhost' + r)));
        const buf = await res.arrayBuffer();
        const suspect = res.status === 200 && res.headers.get('content-type')?.includes('text/html') && buf.byteLength < 2048;
        console.log('[rosefd] warm', r, 'status=' + res.status, 'bytes=' + buf.byteLength, suspect ? 'SUSPECT-EMPTY' : '');
      } catch (e) {
        console.error('[rosefd] warm', r, 'FAILED:', (e as Error)?.stack ?? e);
      }
    }
  }));
}).catch((e) => console.error('[rosefd] warm loop aborted:', (e as Error)?.stack ?? e));

const hotCache = new Map<string, { raw: Buffer; br?: Buffer; gzip?: Buffer; headers: Record<string, string | string[]>; etag: string; fetchedAt: number; status?: number; refreshing?: boolean }>();
const HOT_CACHE_MAX = 300;
function hotCacheEvict(): void {
  while (hotCache.size >= HOT_CACHE_MAX) {
    const oldest = hotCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    hotCache.delete(oldest);
  }
}
const HOT_TTL = 10_000;

// An invalidation is only sound if it lands AFTER the mutation commits. The
// clear used to sit at the top of the non-GET handler - before the app's
// write, which commits inside handle() below - so a warm render that started
// between the clear and the commit stored pre-mutation bytes into a cache that
// had already been cleared: stale bytes resurrected for a whole TTL, and the
// window renews itself while the warm storm keeps firing. The generation
// counter closes the other half of the same hole: a store (refetchHot or
// fillHot) that straddled ANY invalidation abandons its write, so bytes
// rendered before the world changed can never outlive the change.
let hotGen = 0;
function invalidateHot(): void {
  hotGen++;
  hotCache.clear();
  const fn = (mod as any).invalidateRenderCache;
  if (typeof fn === 'function') fn();
}
// An app that mutates state OUTSIDE a request - a queue consumer, a cron, a
// $store write from a websocket handler - has no non-GET request to hang the
// invalidation on, so it calls this at its commit point instead. The request
// path needs no hook: the handler schedules its own invalidation on the
// response's finish (below).
(globalThis as unknown as { __rosefdInvalidateHot?: () => void }).__rosefdInvalidateHot = invalidateHot;

const gzipFallback: zlib.ZlibOptions = { level: 6 };

function pickEncoding(raw: Buffer, accept: string): 'br' | 'gzip' | null {
  if (raw.length <= 1024) return null;
  return /br\b/i.test(accept) ? 'br' : /gzip\b/i.test(accept) ? 'gzip' : null;
}

// Vary is a list header, and two independent parties write it: the server
// negotiates the body on Accept-Encoding, and a route may declare its own
// dimensions (an i18n redirect varies on Accept-Language). setHeader replaces
// by name, so a naive write on either side silently drops the other - merge,
// deduped case-insensitively.
function addVary(res: http.ServerResponse, dim: string): void {
  const have = res.getHeader('vary');
  const raw = have == null ? '' : Array.isArray(have) ? have.join(', ') : String(have);
  const parts = raw.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (!parts.some((p: string) => p.toLowerCase() === dim.toLowerCase())) parts.push(dim);
  res.setHeader('Vary', parts.join(', '));
}

const NO_COMPRESS_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico',
  '.woff', '.woff2', '.mp4', '.webm', '.mp3', '.pdf', '.zip', '.gz', '.br',
]);

/**
 * asset (writeBrotli). Compressing those bytes again here costs the same
 * multi-hundred-millisecond synchronous pass - measured: ~290 ms blocked for a
 * 194 KB vendor bundle, ~3.3 s for a 2.2 MB one - on the event loop, inside a
 * request. Reuse the sibling instead. Freshness is the whole safety argument:
 * the sibling must be at least as new as the raw file, so a file replaced in
 * place after the build (or an ISR re-render that rewrote it) is newer than its
 * sibling and falls back to compressing in-process. A stale sibling is
 * therefore unservable - the worst case is the old cost, never wrong bytes.
 */
function prebuiltBro(filePath: string, rawMtimeMs: number): Buffer | null {
  try {
    const brPath = filePath + '.br';
    const s = fs.statSync(brPath);
    if (!s.isFile() || s.mtimeMs < rawMtimeMs) return null;
    return fs.readFileSync(brPath);
  } catch {
    return null;
  }
}

function encodedBody(entry: { raw: Buffer; br?: Buffer; gzip?: Buffer }, enc: 'br' | 'gzip'): Buffer {
  if (enc === 'br') return (entry.br ??= zlib.brotliCompressSync(entry.raw, brotliFast));
  return (entry.gzip ??= zlib.gzipSync(entry.raw, gzipFallback));
}

const brotliAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);
async function encodedBodyAsync(
  entry: { raw: Buffer; br?: Buffer; gzip?: Buffer },
  enc: 'br' | 'gzip',
): Promise<Buffer> {
  if (enc === 'br') return (entry.br ??= await brotliAsync(entry.raw, brotliFast));
  return (entry.gzip ??= await gzipAsync(entry.raw, gzipFallback));
}

/**
 * One access line per request on stdout - the same greppable shape the CLI's
 *
 * prod-server had NO access log at all: the platform request log showed a
 * status and a duration, and the server itself said nothing, so a blank first
 * visit was reported repeatedly with nothing to read. Every response exit in
 * the http handler calls this, which makes a log export readable line by line
 * against what the render actually produced.
 */
function writeAccessLine(req: any, res: any, bytes: number): void {
  console.log(`${new Date().toISOString().slice(0, 19)}Z ${req.method} ${req.url} ${res.statusCode} ${bytes}B`);
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// Normalize a request target: absolute-form request lines (proxy style, which
// RFC allows) must not be joined onto an origin twice - strip to path+search.
function relTarget(u: string): string {
  if (u.startsWith('http://') || u.startsWith('https://')) {
    try {
      const p = new URL(u);
      return p.pathname + p.search;
    } catch {
      return '/';
    }
  }
  return u;
}

// The hot cache is a SHARED store, so its key must name the representation
// exactly: same path, same cookie, same negotiated language. It used to be
// pathname + cookie only - and a representation negotiated on Accept-Language
// is a different representation per language, so the first language rendered
// was replayed to every other language for a whole TTL. Boot warm sends no
// accept-language at all, so the app's default won the shared key and an
// English browser got the Chinese installer (BUG.md AB). Folding the header
// into the key partitions the store: warm fills its own header-less slot
// lazily, and every real language renders on demand. A route can name further
// headers of its own - `export const hotVary = ['x-rv-url']` - and they ride
// along in the same fingerprint, which is what lets an app retire the query-tag
// workaround (/?l=en) and keep the cache.
function hotKey(pathname: string, cookieHeader: string, dims: string[]): string {
  return pathname + '|' + fnv(cookieHeader + '\u0000' + dims.join('\u0000'));
}

// The headers the matched route declared with `export const hotVary`. Matching
// is on pathname (never the query), so one declaration covers every URL a
// dynamic route serves.
function hotVaryNames(target: string): string[] {
  return mod?.hotVaryFor?.(target.split('?')[0]!) ?? [];
}

// A response that declares it must not be STORED by a shared cache - or that
// varies on a dimension the key does not carry - must never enter the store:
// it would be replayed to requests that negotiate differently for a whole
// TTL. The key carries pathname, cookie and accept-language, so
// accept-language is the one app-declared dimension that is already safe;
// anything else (`*`, origin, a custom header) is not - the /api/data loader
// fragment and the installer were both poisoned this way (BUG.md AB). A route
// makes any of them safe by declaring it (`export const hotVary`): a declared
// dimension is carried by the key too, and is passed in here so the guard lets
// it through - refusing a carried dimension would only switch the cache off
// for that route, which is the blunt instrument the declaration exists to
// replace.
// accept-encoding needs no mention: the store keeps the raw bytes and
// re-negotiates the encoding per request (pickEncoding), which is why the
// framework's own Accept-Encoding merge on the node response stays out of
// this check - this reads the app's Response.
//
// no-store and private are the storage prohibitions, and they are the app's
// escape valves. Revalidation-freshness directives (no-cache, max-age=0) are
// deliberately NOT refusals: the framework's own dynamic documents carry
// `cache-control: no-cache` (browsers must revalidate HTML on every visit),
// and the hot cache is the server-side revalidation layer for exactly those
// documents - a 10s TTL plus generation invalidation on every mutation.
// Refusing no-cache would disable the cache for its primary workload, which
// was never the reported defect.
function refusesStore(response: Response, carried: string[] = []): boolean {
  const cc = (response.headers.get('cache-control') || '').toLowerCase();
  for (const tok of cc.split(/[,\s]+/)) {
    if (tok === 'no-store' || tok === 'private') return true;
  }
  const vary = response.headers.get('vary');
  if (vary) {
    for (const dim of vary.split(',')) {
      const d = dim.trim().toLowerCase();
      if (d === '' || d === 'accept-encoding') continue;
      // Carried dimensions are partitioned in the store, so declaring them is
      // a reason to KEEP the response, not to drop it: accept-language is
      // carried unconditionally, the rest because the route declared them.
      if (d === 'accept-language' || carried.includes(d)) continue;
      return true;
    }
  }
  return false;
}

async function refetchHot(pathname: string, cookieHeader: string, dims: string[], names: string[]): Promise<void> {
  const gen = hotGen;
  const headers: Record<string, string> = { 'user-agent': 'rosefd-hot' };
  if (cookieHeader) headers.cookie = cookieHeader;
  // The warm render must negotiate the SAME dimensions the entry it fills is
  // keyed by: a header-less warm render stored under a language (or a declared
  // header) key would serve default bytes to that partition for a whole TTL.
  if (dims[0]) headers['accept-language'] = dims[0];
  for (let i = 0; i < names.length; i++) if (dims[i + 1]) headers[names[i]!] = dims[i + 1]!;
  const response = await runIsolated(() => handle!(new Request('http://localhost' + pathname, { headers })));
  const csp = response.headers.get('content-security-policy') || '';
  const key = hotKey(pathname, cookieHeader, dims);
  if (!cacheable(response.status) || csp.includes('nonce-') || refusesStore(response, names)) {
    hotCache.delete(key);
    return;
  }
  // set-cookie is a list header: forEach delivers it per value, so a plain
  // object assignment keeps only the last one. Capture the whole array and
  // store it under the name node's setHeader replays as multiple headers.
  const head: Record<string, string | string[]> = {};
  const cookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'date' && k !== 'content-encoding') { if (cookies.length && k.toLowerCase() === 'set-cookie') return; head[k] = v; } });
  if (cookies.length) head['set-cookie'] = cookies;
  // AC (BUG.md): same cross-visitor Set-Cookie leak on the warm path. The
  // boot/refresh warm render carries no cookie, so its key is the anonymous
  // slot - refuse to store any Set-Cookie it produces under that key.
  if (!cookieHeader && cookies.length) { hotCache.delete(key); return; }
  const raw = Buffer.from(await response.arrayBuffer());
  // An invalidation landed while this render was in flight: the bytes may
  // predate it, and the cache was already cleared - storing them would
  // resurrect exactly the staleness the invalidation published. Drop them; the
  // next request renders fresh.
  if (gen !== hotGen) return;
  hotCacheEvict();
  hotCache.set(key, {
    raw,
    headers: head,
    etag: `W/"${raw.length}-${fnv(cookieHeader)}"`,
    fetchedAt: Date.now(),
    status: response.status,
  });
}

// In-flight warm dedup: a cookieless GET storm against an empty cache used to
// replay the whole warmList per request (the re-warm trigger has no in-flight
// set), so N concurrent first-hits rendered N x warmList routes - and a failed
// wave left the cache empty, so every subsequent GET fired another full wave.
const warming = new Set<string>();
function warmHot(pathname: string, cookieHeader: string, dims: string[], names: string[]): void {
  const wkey = hotKey(pathname, cookieHeader, dims);
  if (warming.has(wkey)) return;
  warming.add(wkey);
  refetchHot(pathname, cookieHeader, dims, names)
    .catch(() => {
      const e = hotCache.get(wkey);
      if (e) { e.refreshing = false; e.fetchedAt = Date.now() - HOT_TTL + 2000; }
    })
    .finally(() => {
      warming.delete(wkey);
      const e = hotCache.get(wkey);
      if (e) e.refreshing = false;
    });
}

async function tryHot(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const q = relTarget(req.url || '/');
  const cookieHeader = String(req.headers.cookie || '');
  // Same normalization the request path below applies: a key is per
  // representation, and `en-US` / `en-us` are the same representation. The
  // declared headers ride along, so a route's private negotiation dimension
  // gets its own partition instead of poisoning the shared one.
  const names = hotVaryNames(q);
  const dims = hotVaryValues(q.split('?')[0]!, mod?.hotVaryFor, (n) => req.headers[n] as string | undefined);
  const key = hotKey(q, cookieHeader, dims);
  const entry = hotCache.get(key);
  if (!entry) return false;
  const age = Date.now() - entry.fetchedAt;
  if (age > HOT_TTL && !entry.refreshing) {
    entry.refreshing = true;
    warmHot(q, cookieHeader, dims, names);
  }
  res.statusCode = entry.status ?? 200;
  for (const k in entry.headers) res.setHeader(k, entry.headers[k]);
  // The memoized headers come from the edge response, which carries the app's
  // own dimensions but never the server's negotiation dimension - the dynamic
  // path adds it to `res` after the fact, so a hot-cache replay used to serve
  // bytes negotiated on Accept-Encoding while telling caches the response does
  // not vary by it. Merge it back in here.
  addVary(res, 'Accept-Encoding');
  res.setHeader('ETag', entry.etag);
  if (req.headers['if-none-match'] === entry.etag) {
    res.statusCode = 304;
    res.end();
    writeAccessLine(req, res, 0);
    return true;
  }
  const enc = pickEncoding(entry.raw, String(req.headers['accept-encoding'] || ''));
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    const body = await encodedBodyAsync(entry, enc);
    res.end(body);
    writeAccessLine(req, res, body.length);
  } else {
    res.end(entry.raw);
    writeAccessLine(req, res, entry.raw.length);
  }
  return true;
}

function cacheable(status: number): boolean {
  return status === 200 || status === 404;
}

function fillHot(pathname: string, cookieHeader: string, dims: string[], names: string[], response: Response, memo: { raw: Buffer; br?: Buffer; gzip?: Buffer }, etag: string, gen: number): void {
  // The render behind this response may predate an invalidation that landed
  // while it ran (the request path awaits the body and the compression before
  // storing). Stale bytes must not enter the cache it was just dropped from.
  if (gen !== hotGen) return;
  if (!cacheable(response.status)) return;
  const csp = response.headers.get('content-security-policy') || '';
  if (csp.includes('nonce-')) return;
  // The declared cacheability contract (BUG.md AB): a response that says it
  // must not be stored, or that varies on a dimension the key does not carry,
  // never enters the shared store.
  if (refusesStore(response, names)) return;
  if (response.status === 404 && hotCache.size >= HOT_CACHE_MAX) return;
  // set-cookie is a list header: forEach delivers it per value, so a plain
  // object assignment keeps only the last one. Capture the whole array and
  // store it under the name node's setHeader replays as multiple headers.
  const head: Record<string, string | string[]> = {};
  const cookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'date' && k !== 'content-encoding') { if (cookies.length && k.toLowerCase() === 'set-cookie') return; head[k] = v; } });
  if (cookies.length) head['set-cookie'] = cookies;
  // AC (BUG.md): a Set-Cookie replayed from the anonymous (empty-cookie) key
  // is a cross-visitor leak - session fixation, or a shared, readable CSRF
  // token. Set-Cookie is per-request state; the shared slot must not carry it.
  // Authenticated keys already isolate by cookie, so only the anonymous slot
  // is refused (the conservative variant the report proposed as the fallback).
  if (!cookieHeader && cookies.length) return;
  hotCacheEvict();
  hotCache.set(hotKey(pathname, cookieHeader, dims), { ...memo, headers: head, etag, fetchedAt: Date.now(), status: response.status });
}

const fileCache = new Map<string, { filePath: string; raw: Buffer; br?: Buffer; gzip?: Buffer; compressed: boolean; etag: string; mtimeMs: number; checkedAt: number }>();
// Bounded re-stat window: the per-request statSync is a cache-invalidation
// probe only (bytes always come from the in-memory entry), and the freshness
// it guards is already bounded by the headers themselves - chunks/?v= assets
// are immutable, uploads carry max-age=3600, entry docs change only on a
// deploy that restarts the process. See the deployment repo's prod-server.ts
// for the full account and tools/static-hot-bench.mts for the measurement.
const STATIC_RESTAT_MS = 2_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

try {
  const raw = fs.readFileSync(new URL('../.env', import.meta.url), 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* no .env: fine */ }
const REVALIDATE_TOKEN = process.env.ROSEFD_REVALIDATE_TOKEN || '';
let revalidateMod: any = null;

function handleRevalidate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'POST' || !req.url!.startsWith('/__rosefd/revalidate')) return false;
  if (!REVALIDATE_TOKEN) { res.statusCode = 404; res.end(); return true; }
  if (req.headers['x-rosefd-token'] !== REVALIDATE_TOKEN) {
    res.statusCode = 403; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid token' })); return true;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      if (!revalidateMod) revalidateMod = mod;
      const payload = JSON.parse(body || '{}');
      // The endpoint short-circuits before the handler's non-GET branch, so it
      // owes its own invalidation - and it used to drop only the render memo,
      // leaving the hot cache serving the pre-revalidation bytes for a whole
      // TTL. Both caches go, per path or all at once: the endpoint is an
      // explicit admin action and the hot cache repopulates on the next
      // requests.
      if (payload.all) {
        invalidateHot();
        res.end(JSON.stringify({ revalidated: true, scope: 'all' }));
      } else {
        let n = 0;
        for (const p of payload.paths || []) n += revalidateMod.invalidatePath(String(p));
        invalidateHot();
        res.end(JSON.stringify({ revalidated: true, paths: (payload.paths || []).length, dropped: n }));
      }
    } catch (e: any) {
      res.statusCode = 400; res.end(JSON.stringify({ error: String(e).slice(0, 120) }));
    }
  });
  return true;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string | null, rawUrl: string): boolean {
  if (pathname === null) return false;
  if (pathname.includes('\0') || pathname.includes('..')) return false;
  const ext = path.extname(pathname).toLowerCase();
  if (!TYPES[ext]) return false;
  let entry = fileCache.get(pathname);
  let st: fs.Stats | null = null;
  let valid = false;
  if (entry) {
    if (Date.now() - entry.checkedAt < STATIC_RESTAT_MS) {
      valid = true;
    } else {
      entry.checkedAt = Date.now();
      try {
        const s = fs.statSync(entry.filePath);
        if (s.isFile() && s.mtimeMs === entry.mtimeMs) { st = s; valid = true; }
      } catch {
        // moved or deleted since it was cached: re-resolve below
      }
    }
  }
  if (!valid) {
    let filePath = '';
    for (const root of resolveStaticRoots()) {
      const candidate = path.join(root, pathname);
      if (!candidate.startsWith(root)) continue;
      try {
        const s = fs.statSync(candidate);
        if (!s.isFile()) continue;
        filePath = candidate;
        st = s;
        break;
      } catch {
        // not under this root; try the next one
      }
    }
    if (!st) return false;
    const raw = fs.readFileSync(filePath);
    const compressed = raw.length > 1024 && !NO_COMPRESS_EXT.has(ext);
    entry = {
      filePath,
      raw,
      br: compressed ? (prebuiltBro(filePath, st.mtimeMs) ?? undefined) : undefined,
      gzip: undefined,
      compressed,
      etag: `W/"${st.size}-${st.mtimeMs}"`,
      mtimeMs: st.mtimeMs,
      checkedAt: Date.now(),
    };
    fileCache.set(pathname, entry);
    if (fileCache.size > 500) fileCache.delete(fileCache.keys().next().value as string);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[ext]);
  res.setHeader('ETag', entry.etag);
  addVary(res, 'Accept-Encoding');
  const isEntryDoc = pathname === '/' || pathname.endsWith('/') || TYPES[ext].startsWith('text/html');
  const immutableAsset =
    pathname.startsWith('/chunks/') ||
    (pathname.startsWith('/public/') && rawUrl.includes('?v='));
  res.setHeader(
    'Cache-Control',
    isEntryDoc
      ? 'public, max-age=0, must-revalidate'
      : immutableAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  );
  if (req.headers['if-none-match'] === entry.etag) {
    res.statusCode = 304;
    res.end();
    writeAccessLine(req, res, 0);
    return true;
  }
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = entry.compressed ? pickEncoding(entry.raw, accept) : null;
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    const body = encodedBody(entry, enc);
    res.end(body);
    writeAccessLine(req, res, body.length);
  } else {
    res.end(entry.raw);
    writeAccessLine(req, res, entry.raw.length);
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  // The generation this request's renders belong to: captured before handle()
  // runs, so a store at the end of the request can tell whether an invalidation
  // landed while it was rendering.
  const reqGen = hotGen;
  try {
    await ready;
    if (handleRevalidate(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // The invalidation moves to the response's finish (or the client's
      // disconnect): the app's mutation commits INSIDE handle() below, so a
      // clear at the top of the handler ran BEFORE the write it exists to
      // publish - and a warm render starting in between stored pre-mutation
      // bytes into the already-cleared cache. Until this response finishes, a
      // concurrent GET keeps being served the previous bytes, which is exactly
      // right for a mutation that has not committed yet; the moment it has,
      // everything drops and the next render is fresh. Both events are guarded
      // by one flag (close always follows finish), and every path that ends the
      // response - including the catch's 500 - fires one of them.
      let invalidated = false;
      const invalidateOnce = () => {
        if (invalidated) return;
        invalidated = true;
        invalidateHot();
      };
      res.on('finish', invalidateOnce);
      res.on('close', invalidateOnce);
    }
    if (hotCache.size > 0 && (await tryHot(req, res))) return;
    if (req.method === 'GET' && !req.headers.cookie && hotCache.size === 0) {
      for (const r of warmList) warmHot(r, '', [''], hotVaryNames(r));
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rawUrl = relTarget(req.url || '/');
      let pathname: string | null = null;
      try {
        pathname = decodeURIComponent(new URL('http://localhost' + rawUrl).pathname);
      } catch {
        pathname = null;
      }
      if (serveStatic(req, res, pathname, rawUrl)) return;
      const p = pathname ?? rawUrl.split('?')[0]!;
      if (isBakedAssetPath(p)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.end('not found');
        writeAccessLine(req, res, 0);
        return;
      }
    }
    const url = requestOrigin(req, port) + relTarget(req.url || '/');
    const init: RequestInit = { method: req.method, headers: req.headers as any };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      (init as any).body = Readable.toWeb(req) as any;
      (init as any).duplex = 'half';
    }
    const cookieHeader = String(req.headers.cookie || '');
    // The negotiated dimensions are part of the representation's identity:
    // they name the hot-cache key below and the warm render that fills it.
    // accept-language always, plus whatever the route declared with hotVary.
    const hotTarget = relTarget(req.url || '/');
    const names = hotVaryNames(hotTarget);
    const dims = hotVaryValues(hotTarget.split('?')[0]!, mod?.hotVaryFor, (n) => req.headers[n] as string | undefined);
    if (earlyHintLinks.length && req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      try { res.writeEarlyHints({ link: earlyHintLinks }); } catch { /* client gone: the render still finishes */ }
    }
    const replayable = req.method === 'GET' || req.method === 'HEAD';
    let response: Response;
    try {
      response = await runIsolated(() => handle!(new Request(url, init)));
    } catch (err) {
      if (!replayable) throw err;
      console.warn('[rosefd] render failed, retrying once:', (err as Error)?.message ?? err);
      await new Promise((r) => setTimeout(r, 200));
      response = await runIsolated(() => handle!(new Request(url, init)));
    }
    res.statusCode = response.status;
    // set-cookie is a list header: forEach delivers it per value and setHeader
    // replaces, so a multi-cookie response (session + csrf, say) would keep
    // only the last one. Emit the whole array through node's native
    // multi-value form instead.
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((v, k) => { if (setCookies.length && k.toLowerCase() === 'set-cookie') return; res.setHeader(k, v); });
    if (setCookies.length) res.setHeader('set-cookie', setCookies);
    // The bytes below are content-negotiated on Accept-Encoding, so a cache
    // must know the response varies by it. Merged, not written: the edge
    // response may carry the app's own dimensions (an i18n redirect varies on
    // Accept-Language) and setHeader would drop them.
    addVary(res, 'Accept-Encoding');
    const htmlDoc = (response.headers.get('content-type') ?? '').startsWith('text/html');
    const accept = String(req.headers['accept-encoding'] ?? '');
    const raw = response.body ? Buffer.from(await response.arrayBuffer()) : null;
    if (raw && htmlDoc) {
      const etag = 'W/"' + createHash('sha1').update(raw).digest('base64url').slice(0, 24) + '"';
      // RFC 9110: a 304 must carry the validators a 200 would have carried.
      res.setHeader('ETag', etag);
      if (req.method === 'GET' && req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        writeAccessLine(req, res, 0);
        return;
      }
      const memo: { raw: Buffer; br?: Buffer; gzip?: Buffer } = { raw };
      const enc = pickEncoding(raw, accept);
      const body = enc ? await encodedBodyAsync(memo, enc) : raw;
      if (enc) {
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', String(body.length));
      }
      if (req.method === 'GET') fillHot(hotTarget, cookieHeader, dims, names, response, memo, etag, reqGen);
      res.end(body);
      writeAccessLine(req, res, body.length);
    } else if (raw) {
      if (req.method === 'GET') fillHot(hotTarget, cookieHeader, dims, names, response, { raw }, `W/"${raw.length}-${fnv(cookieHeader)}"`, reqGen);
      res.end(raw);
      writeAccessLine(req, res, raw.length);
    } else {
      res.end();
      writeAccessLine(req, res, 0);
    }
  } catch (err) {
    console.error('[rosefd] request failed:', (err as Error)?.stack ?? err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.end('server error');
    writeAccessLine(req, res, 13);
  }
});

if (!process.env.VERCEL) {
  server.listen(port, () => {
    console.log(`🌹 Rose Frame Driver prod server on http://localhost:${port}`);
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref?.();
    server.close(() => {
      void runShutdownHooks(signal).finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

export default server;

export { onShutdown, runShutdownHooks };

void mod?.invalidateRenderCache;
