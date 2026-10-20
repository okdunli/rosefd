/**
 * test-sliced.ts - the sliced bundle mode (mode C)
 *
 * R49 shipped route-sliced inlining and rolled it back: the slices and the
 * shared nav chunk each carried their OWN runtime copy, so the nav chunk's
 * $query() read a module-local {} instead of the slice's per-request state.
 * R51 singletons the runtime's shared tables; this mode is the third bundle
 * shape built on top:
 *
 *   - every interactive document inlines the runtime + ITS OWN route's render
 *     chain (dist/slices/<key>.js, keyed by the route pattern),
 *   - every OTHER route's render chain rides one shared chunk (dist/nav.js),
 *     fetched on the first cross-route navigation (or a hover prefetch),
 *   - the nav chunk resolves the runtime through globalThis.__rosefd_rt, the
 *     object the slice published - ONE runtime copy, or the per-request bags
 *     (requestQuery/prefetchOverride) disagree and $query() lies.
 *
 * The polarity assertion is the whole point: a render driven through the nav
 * chunk must observe the override the SLICE set. A second runtime copy answers
 * '(none)' where the single copy answers the query.
 *
 * Run: npx tsx tests/test-sliced.ts   (from the repo root)
 */

import { JSDOM } from 'jsdom';
import { readFileSync, existsSync, cpSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { fnv1a32 } from '../src/hash.js';
import { createEdgeHandler } from '../src/cli/edge.js';

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const REPO = process.cwd();
const TSX = [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join(REPO, 'src/cli/index.ts')];
const run = (args: string[], cwd: string) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
  const p = spawn(process.execPath, [...TSX, ...args], { cwd });
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
});

// The fixture builds through the REAL CLI (cwd = the project, so dist/ lands
// inside it): headers.json and the prerendered documents are CLI products, not
// compiler products, and the per-route CSP lives in the CLI.
const tmp = mkdtempSync(join(tmpdir(), 'rosefd-sliced-'));
const app = join(tmp, 'app');
cpSync(join(REPO, 'tests/fixture-sliced'), app, { recursive: true });
const built = await run(['build'], app);
assert(built.code === 0, `the sliced fixture builds through the CLI (stderr: ${built.err.slice(0, 300)})`);
const dist = join(app, 'dist');

// === 1. Build form: one slice per route, one shared nav chunk, one core ===
const sliceFiles = readdirSync(join(dist, 'slices')).filter((f) => f.endsWith('.js')).sort();
assert(sliceFiles.length === 3, `one slice file per page route (got ${sliceFiles.length}: ${sliceFiles.join(', ')})`);
assert(existsSync(join(dist, 'nav.js')), 'the shared nav chunk exists');
assert(existsSync(join(dist, 'client.js')), 'the runtime-only core exists (mount.js embedders and 404 documents)');

const navSrc = readFileSync(join(dist, 'nav.js'), 'utf-8');
const coreSrc = readFileSync(join(dist, 'client.js'), 'utf-8');
const sliceSrc: Record<string, string> = {};
for (const f of sliceFiles) sliceSrc[f] = readFileSync(join(dist, 'slices', f), 'utf-8');

const MARKERS = ['slice-home', 'slice-alpha', 'slice-beta'];
assert(MARKERS.every((m) => navSrc.includes(m)), 'the nav chunk carries every route render chain');
assert(navSrc.includes('slice-404'), 'the not-found render rides the nav chunk too');
assert(navSrc.includes('the sliced bundle bridge is missing'), 'the nav chunk guards on the published runtime (a chunk that loads before any slice fails loudly)');
assert(MARKERS.every((m) => !coreSrc.includes(m)) && !coreSrc.includes('slice-404'), 'the core carries no route render code');
assert(coreSrc.includes('__rosefd_signalMap'), 'the core still carries the runtime itself');

for (const [f, src] of Object.entries(sliceSrc)) {
  const own = MARKERS.filter((m) => src.includes(m));
  assert(own.length === 1, `slice ${f} inlines exactly one route render (${own.join(',') || 'none'})`);
  assert(!/from"/.test(src), `slice ${f} is self-contained (no module imports - the runtime is inlined)`);
  assert(src.includes('globalThis.__rosefd_rt'), `slice ${f} publishes the runtime for the nav chunk`);
  assert(src.includes('__rosefd_navImport'), `slice ${f} keeps the nav-import seam`);
}
assert(!/from"/.test(navSrc), 'the nav chunk is self-contained (it resolves the runtime through the bridge, not an import)');

// The server names the slice from the same table the files are written from.
const server: any = await import(pathToFileURL(join(dist, 'server.js')).href);
assert(typeof server.sliceKeyFor === 'function', 'the server bundle exports sliceKeyFor in sliced mode');
assert(server.sliceKeyFor('/nope') === null, 'a pathname matching no route has no slice (the 404 document rides the core)');
for (const m of MARKERS) {
  const f = sliceFiles.find((s) => sliceSrc[s].includes(m))!;
  const route = m === 'slice-home' ? '/' : m === 'slice-alpha' ? '/alpha' : '/beta';
  assert(server.sliceKeyFor(route) === f.replace(/\.js$/, ''), `sliceKeyFor('${route}') names the slice that inlines ${m}`);
}

// === 2. Document form: the document inlines its own slice and nothing else ===
const moduleScriptOf = (doc: string): string => {
  const blocks = [...doc.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert(blocks.length === 1, `the document carries exactly one module script (got ${blocks.length})`);
  return blocks[0];
};
const alphaDoc = readFileSync(join(dist, 'alpha', 'index.html'), 'utf-8');
const alphaScript = moduleScriptOf(alphaDoc);
assert(alphaScript.includes('slice-alpha'), 'the alpha document inlines its own route render');
assert(!alphaScript.includes('slice-beta') && !alphaScript.includes('slice-home'), 'the alpha document does NOT inline the other routes');
assert(alphaScript.includes('globalThis.__rosefd_rt'), 'the document publishes the runtime before any render runs');

const navBytes = readFileSync(join(dist, 'nav.js'));
const navUrl = '/nav.js?v=' + fnv1a32(navBytes);
assert(alphaScript.includes(navUrl), 'the slice fetches exactly the nav chunk this build produced (versioned by its bytes)');

// The route CSP hashes the document's own inline bytes and admits the
// same-origin nav fetch - and still no 'unsafe-inline'.
const headers = JSON.parse(readFileSync(join(dist, 'headers.json'), 'utf-8'));
const alphaRoute = headers.routes.find((r: any) => r.pattern === '/alpha');
assert(!!alphaRoute, 'headers.json carries a per-route entry for /alpha');
const alphaCsp: string = alphaRoute.headers['content-security-policy'];
const alphaHash = createHash('sha256').update(alphaScript, 'utf-8').digest('base64');
assert(alphaCsp.includes(`'sha256-${alphaHash}'`), "the route CSP hashes the document's own inline bytes");
assert(alphaCsp.includes("'self'"), 'the sliced CSP admits the same-origin nav chunk fetch');
const scriptSrcOf = (csp: string): string => /script-src[^;]*/.exec(csp)![0];
assert(!scriptSrcOf(alphaCsp).includes('unsafe-inline'), 'the sliced script-src still has no unsafe-inline (style-src keeps its own)');
assert(headers.default['Content-Security-Policy'].includes("'self'"), 'the default CSP (core documents) admits the nav chunk too');
for (const r of headers.routes) {
  assert(Object.values(r.headers).length === 1 && 'content-security-policy' in r.headers, `route ${r.pattern} overrides only the CSP`);
}

// === 3. The edge adapter serves the per-route slices from ITS dist ===
// The handler is handed a directory that is not this process's cwd/dist - a
// slice resolved against the wrong one falls back to the core and ships every
// route's render chain in one document.
const handle = await createEdgeHandler(dist);
const edgeAlpha = await handle(new Request('http://localhost/alpha'));
assert(edgeAlpha.status === 200, 'the edge serves /alpha');
const edgeAlphaHtml = await edgeAlpha.text();
const edgeAlphaScript = moduleScriptOf(edgeAlphaHtml);
assert(edgeAlphaScript.includes('slice-alpha') && !edgeAlphaScript.includes('slice-beta'),
  'the edge document inlines the route own slice (resolved against the handler dist, not the cwd)');
const edgeAlphaCsp = edgeAlpha.headers.get('content-security-policy')!;
assert(edgeAlphaCsp.includes(`'sha256-${createHash('sha256').update(edgeAlphaScript, 'utf-8').digest('base64')}'`),
  'the edge CSP hashes the slice it actually inlined');
const edgeBeta = await handle(new Request('http://localhost/beta?q=thorn'));
assert(edgeBeta.status === 200, 'the edge serves the dynamic route');
const edgeBetaHtml = await edgeBeta.text();
assert(edgeBetaHtml.includes('slice-beta') && edgeBetaHtml.includes('thorn'),
  'the per-request route document renders its own slice with the request query');
const edgeMissing = await handle(new Request('http://localhost/nope'));
assert(edgeMissing.status === 404, 'the edge answers 404 for an unknown route');
const edgeMissingHtml = await edgeMissing.text();
assert(edgeMissingHtml.includes('slice-404'), 'the 404 document is the app own not-found page');
assert(!/<script type="module"/.test(edgeMissingHtml),
  'the 404 document is zero-JS: a pure content route ships no module script at all (nothing to slice, nothing to inline)');

// === 4. Polarity of the comparison: inline mode still ships everything ===
const inlineApp = join(tmp, 'inline');
cpSync(join(REPO, 'tests/fixture-sliced'), inlineApp, { recursive: true });
const layoutFile = join(inlineApp, 'src', 'pages', '_layout.rose');
writeFileSync(layoutFile, readFileSync(layoutFile, 'utf-8').replace("bundle = 'sliced'", "bundle = 'inline'"));
const { buildProject } = await import('../src/compiler/index.js');
const inlineBuild = await buildProject(inlineApp, join(tmp, 'inline-dist'));
assert(inlineBuild.bundle === 'inline', 'the same fixture flipped to inline reports inline mode');
assert(!existsSync(join(tmp, 'inline-dist', 'slices')), 'inline mode emits no slices directory');
const inlineClient = readFileSync(join(tmp, 'inline-dist', 'client.js'), 'utf-8');
assert(MARKERS.every((m) => inlineClient.includes(m)), 'inline mode ships every route in one bundle');
const alphaSlice = sliceFiles.find((s) => sliceSrc[s].includes('slice-alpha'))!;
assert(inlineClient.length > sliceSrc[alphaSlice].length,
  `each slice is smaller than the whole inline bundle (${sliceSrc[alphaSlice].length} < ${inlineClient.length} bytes)`);

// === 5. Runtime: one copy, adopted DOM, cross-route nav through the chunk ===
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
(globalThis as any).document = dom.window.document;
(globalThis as any).NodeFilter = dom.window.NodeFilter;
(globalThis as any).Node = dom.window.Node;
const NativeFormData = (globalThis as any).FormData;
(globalThis as any).FormData = dom.window.FormData;
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).location = { pathname: '/', search: '' };
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.startsWith('/locales/') && u.endsWith('.json')) return { ok: false, json: async () => ({}) };
  throw new Error(`unexpected fetch in the sliced runtime test: ${u}`);
};

const document = dom.window.document;
const appEl = document.getElementById('app')!;
const tick = () => new Promise((r) => setTimeout(r, 0));

// The seam is read at the slice module's top level, so it must exist BEFORE
// the import. It also captures the nav module for the polarity assertion.
let navMod: any = null;
let seamFresh = false;
(globalThis as any).__rosefd_navImport = async (u: string) => {
  assert(String(u).startsWith('/nav.js?v='), `the slice asks for the versioned nav chunk (got ${u})`);
  const file = seamFresh ? join(dist, 'nav-fresh.js') : join(dist, 'nav.js');
  const m = await import(pathToFileURL(file).href);
  if (!seamFresh) navMod = m;
  return m;
};

const slice: any = await import(pathToFileURL(join(dist, 'slices', alphaSlice)).href);
assert(!!(globalThis as any).__rosefd_rt, 'importing a slice publishes the runtime on globalThis');
assert(typeof (globalThis as any).__rosefd_rt.$query === 'function', 'the published surface carries $query (the nav chunk resolves it through the bridge)');

const ssr = await server.renderPage('/alpha');
const stateEl = document.createElement('script');
stateEl.id = '__rosefd_state';
stateEl.textContent = ssr.state;
document.body.appendChild(stateEl);
appEl.innerHTML = ssr.html;
await slice.start(appEl, '/alpha', true);
assert(appEl.textContent!.includes('slice-alpha'), 'the slice adopts the SSR DOM for its own route');
assert(appEl.querySelector('p strong')!.textContent === '10', 'the adopted route shows its SSR state');
assert(appEl.querySelector('nav a[href="/beta"]') !== null, 'the shared layout renders around the page');
(appEl.querySelector('[data-on-click="alphaBump"]') as any).click();
await tick();
assert(appEl.querySelector('p strong')!.textContent === '11', 'the slice wires its own events');

// The first cross-route navigation: the render comes from the nav chunk.
await slice.start(appEl, '/beta');
assert(navMod !== null, 'the navigation fetched the shared nav chunk through the seam');
assert(appEl.textContent!.includes('slice-beta'), 'the nav chunk renders the target route');
assert(appEl.textContent!.includes('(none)'), 'a query-less client render answers (none)');
assert(appEl.querySelectorAll('p strong')[0]!.textContent === '20', 'the nav-chunk route carries its own state');
(appEl.querySelector('[data-on-click="betaBump"]') as any).click();
await tick();
assert(appEl.querySelectorAll('p strong')[0]!.textContent === '21', 'events wired through the nav-chunk render patch the DOM');

// THE POLARITY ASSERTION. The override is set on the SLICE's runtime copy; the
// render runs inside the nav chunk, whose components resolve $query through
// globalThis.__rosefd_rt. A second runtime copy would read its own (empty)
// override and answer (none). A fresh key matters too: state() seeds once per
// map, so the navigation above (which clears the client state) is what makes
// the initializer run again here.
await slice.start(appEl, '/');
slice.setPrefetchOverride({ q: 'thorn' });
const bridgedHtml = await navMod.navRenders['/beta'].render([], '');
slice.setPrefetchOverride(null);
assert(bridgedHtml.includes('slice-beta'), 'the nav render entry is callable directly');
assert(bridgedHtml.includes('thorn') && !bridgedHtml.includes('(none)'),
  'the nav chunk render observes the override the SLICE set (one runtime copy - the bridge holds)');

// The not-found page is lazy too: it rides the nav chunk like any other route.
await slice.startNotFound(appEl, '/nope');
assert(appEl.textContent!.includes('slice-404'), 'the lazy not-found render comes through the bridge');

// === 6. Falsification: without the publish, the chunk refuses to boot ===
// A byte-identical copy under a fresh name: the module cache already holds the
// nav chunk from the live run above, and the guard only fires on FIRST
// evaluation - re-importing the same path would answer from cache.
writeFileSync(join(dist, 'nav-fresh.js'), navBytes);
const strippedPath = join(dist, 'slices', 'stripped.js');
writeFileSync(strippedPath, sliceSrc[alphaSlice].replace(/globalThis\.__rosefd_rt\s*=\s*\{[^}]*\};?/, ''));
const stripped: any = await import(pathToFileURL(strippedPath).href);
const errs: string[] = [];
const realErr = console.error;
console.error = (...a: unknown[]) => { errs.push(a.map((x) => String(x)).join(' ')); };
seamFresh = true;
(globalThis as any).__rosefd_rt = null;
try {
  await stripped.start(appEl, '/beta');
} finally {
  console.error = realErr;
  seamFresh = false;
}
assert(errs.some((e) => e.includes('bridge')),
  `without the published runtime the nav chunk refuses to boot (got: ${errs.join(' | ').slice(0, 200)})`);
assert(appEl.textContent!.includes('Something went wrong'), 'the failed bridge load degrades to the error page, not a blank document');

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${checks} checks passed - the sliced bundle mode holds (bridge, slices, CSP, falsification)`);
