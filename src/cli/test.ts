

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { buildProject } from '../compiler/index.js';
import { buildShell } from './shell.js';

/** A request the harness can make: headers (cookies included) and a body. */
export interface TestRequest {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

/** What a render answers: the page the server would have sent, in pieces. */
export interface TestResult {
  status: number;
  /** the route's own HTML (what lands inside <div id="app">) */
  html: string;
  /** the serialized state, parsed - what the client resumes */
  state: Record<string, unknown>;
  head: string[];
  csr?: boolean;
  /** the route exported `shell = false`: the document keeps the bundle but drops the #app wrapper + STYLES_MIN */
  shell?: boolean;
  lang: string;
  /** the built project's dir (dist is inside it) */
  dir: string;
  /** the complete document, byte-identical to what the servers send */
  document: string;
  /** a middleware short-circuit's target, when it redirected */
  redirect?: string;
}

/** The mounted component: a live DOM plus the interactions a user performs. */
export interface TestHandle {
  /** the pathname this mount is on (what location.pathname reads) */
  route: string;
  document: Document;
  window: Window & typeof globalThis;
  /** textContent of a selector (or of the whole container) */
  text(sel?: string): string;
  /** outerHTML of a selector, or null when it matches nothing */
  html(sel?: string): string | null;
  exists(sel: string): boolean;
  /** dispatch a real click (bubbles, cancelable) and let the handler run */
  click(sel: string): Promise<void>;
  /** set an input's value the way a user typing would */
  fill(sel: string, value: string): void;
  /** dispatch a keydown/keyup on an element (key handlers that are not one of the delegated four need a real event) */
  key(sel: string, key: string, type?: 'keydown' | 'keyup'): void;
  /** submit a form the way the bootstrap does: one POST, in-place adopt */
  submit(formSel?: string, fields?: Record<string, unknown>): Promise<void>;
  /** call a server action by name, from no event at all */
  action(name: string, fields?: Record<string, unknown>): Promise<void>;
  /** client-side navigation to another route of the built app */
  navigate(pathname: string): Promise<void>;
  /** the live state map */
  state(): Record<string, unknown>;
  /** how many requests the client half has made (the zero-request proof) */
  requestCount(): number;
}

export interface TestOptions {
  /** the component's props (`export let`), plain JSON data only */
  props?: Record<string, unknown>;
  /** the route to render for a PAGE target (default: the page's own URL) */
  route?: string;
  /** where to build (default: a fresh temp dir, removed on process exit) */
  dir?: string;
  /** keep the built dir and print its path, for inspecting the artifacts */
  keep?: boolean;
  
  dom?: unknown;
}

export interface TestApp {
  /** the route under test (the synthesized page's URL, or the page's own) */
  route: string;
  dir: string;
  /** render a route of the built app (GET) */
  get(pathname?: string, req?: TestRequest): Promise<TestResult>;
  /** render a route with a POST body: runs the server action, re-renders */
  post(fields?: Record<string, unknown>, req?: TestRequest & { route?: string }): Promise<TestResult>;
  /** call an api route: the parsed JSON body (or the raw Response) */
  api(method: string, pathname: string, req?: TestRequest): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
  /** mount the route in a DOM and drive it like a user would */
  mount(req?: TestRequest): Promise<TestHandle>;
}

// The globals a browser has and a Node test process does not.
const GRAFTED = ['document', 'Node', 'NodeFilter', 'FormData', 'DOMParser', 'location', 'fetch', 'Event', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame'] as const;

/** Absolute path of the project root that owns `file` (the dir holding src/pages). */
function projectRootOf(file: string): string {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'pages'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`rosefd/test: ${file} is not inside a project (no src/pages found above it)`);
    dir = parent;
  }
}

/** `src/pages/blog/[id].rose` -> `/blog/:id`; `src/pages/index.rose` -> `/`. */
function routeOf(file: string, root: string): string {
  const rel = path.relative(path.join(root, 'src', 'pages'), path.resolve(file)).replace(/\\/g, '/').replace(/\.rose$/, '');
  if (rel === 'index') return '/';
  const segs = rel.split('/').map((s) => (s.startsWith('[') && s.endsWith(']') ? `:${s.slice(1, -1)}` : s));
  return '/' + segs.join('/');
}

/** A concrete URL for a pattern: `:id` -> 1, `:lang` -> the app's default locale. */
function concreteRoute(pattern: string, defaultLocale: string | null): string {
  return pattern.split('/').map((s) => (s.startsWith(':') ? (s === ':lang' ? defaultLocale ?? 'en' : '1') : s)).join('/');
}

/** Copy a directory tree, skipping nothing (a test fixture is small). */
function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** `key={value}` attributes from a props object, as JS literals. */
function propAttrs(props: Record<string, unknown>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}={${JSON.stringify(v) ?? 'undefined'}}`)
    .join(' ');
}

let tmpCount = 0;

/**
 * Compile `file` into a throwaway project and return a driver over the
 * bundles that build produced. `file` is a `.rose` component
 * (`src/components
 /**`) or page (`src/pages/**`).
 */
export async function test(file: string, opts: TestOptions = {}): Promise<TestApp> {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) throw new Error(`rosefd/test: no such file: ${target}`);
  const root = projectRootOf(target);
  const rel = path.relative(root, target).replace(/\\/g, '/');
  const isComponent = rel.startsWith('src/components/');

  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rosefd-test-'));
  for (const item of ['src', 'public']) {
    const from = path.join(root, item);
    if (fs.existsSync(from)) copyTree(from, path.join(dir, item));
  }
  for (const item of ['rosefd.config.js']) {
    const from = path.join(root, item);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, item));
  }

  let route: string;
  if (isComponent) {
    const specifier = path.relative(path.join(dir, 'src', 'pages'), path.join(dir, rel)).replace(/\\/g, '/');
    const attrs = propAttrs(opts.props ?? {});
    const page = `<script>\n  import Target from '${specifier}';\n</script>\n\n<template>\n  <Target ${attrs} />\n</template>\n`;
    fs.writeFileSync(path.join(dir, 'src', 'pages', '__rosefd_test.rose'), page);
    route = '/__rosefd_test';
  } else {
    route = opts.route ?? routeOf(target, root);
  }

  const outDir = path.join(dir, 'dist');
  await buildProject(dir, outDir);

  // Import through a .mjs copy, not the built .js: tsx (how the CLI and this
  // suite run) routes a .js import through its CJS interop, i.e. require(esm),
  // and node refuses that for a module inside the loader's own cycle
  // (ERR_REQUIRE_CYCLE_MODULE). A .mjs sibling is unambiguously ESM, imports
  // clean, and is the same bytes - one extra small file in an out dir that is
  // already temporary (or kept, with --keep, alongside the build).
  const esmCopy = (file: string): string => {
    const copy = file.replace(/\.js$/, '.import.mjs');
    fs.copyFileSync(file, copy);
    return copy;
  };
  const serverImport = esmCopy(path.join(outDir, 'server.js'));
  const clientImport = esmCopy(path.join(outDir, 'client.js'));
  const mod = await import(pathToFileURL(serverImport).href);
  const clientSource = fs.readFileSync(path.join(outDir, 'client.js'), 'utf-8');
  let styles = '';
  try {
    styles = fs.readFileSync(path.join(outDir, 'styles.css'), 'utf-8');
  } catch { /* no component styles: shell styles only */ }

  if (opts.keep) console.log(`rosefd/test: built ${target} -> ${outDir}`);
  if (!opts.dir && !opts.keep) {
    process.once('exit', () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* the OS temp dir will reap it */ }
    });
  }

  /** A page result from a rendered page (or a middleware short-circuit). */
  const result = (page: any, redirect?: string): TestResult => ({
    status: page.status ?? 200,
    html: page.html,
    state: page.state ? JSON.parse(page.state) : {},
    head: page.head ?? [],
    csr: page.csr,
    shell: page.shell,
    lang: page.lang ?? 'en',
    dir: page.dir ?? '',
    document: buildShell(page.html, page.state, clientSource, page.head ?? [], styles, page.csr !== false, page.lang ?? 'en', page.dir ?? '', '', page.shell !== false),
    redirect,
  });

  /** The Web-standard Request a server would build, for the middleware. */
  const toRequest = (pathname: string, req: TestRequest = {}, body?: FormData) => {
    const headers = new Headers(req.headers ?? {});
    for (const [k, v] of Object.entries(req.cookies ?? {})) headers.append('cookie', `${k}=${v}`);
    // The fetch standard forbids a body on GET/HEAD; constructing one throws,
    // so the body rides only on the methods that may carry it.
    const method = req.method ?? 'GET';
    const mayBody = method !== 'GET' && method !== 'HEAD';
    return new Request(`http://localhost${pathname}`, { method, headers, body: mayBody ? (body ?? undefined) : undefined });
  };

  // One request through the real server pipeline: middleware first (it can short-circuit - a redirect, an auth wall), then the render.
  const request = async (url: string, req: TestRequest, body?: FormData): Promise<TestResult> => {
    // The servers split the query off the URL and hand it to the render through
    // setQuery - $query() reads that object on the server half. A harness
    // request that kept '?q=' inside the pathname would match no route.
    const qi = url.indexOf('?');
    const query = qi >= 0 ? Object.fromEntries(new URLSearchParams(url.slice(qi + 1))) : null;
    const pathname = qi >= 0 ? url.slice(0, qi) : url;
    if (qi >= 0) mod.setQuery?.(query!);
    else mod.setQuery?.({});
    // The server half has no location in any real deployment, and $query()
    // uses that fact to read the per-request query instead of the URL. This
    // process holds BOTH bundles, so a mounted page's location stub (or a
    // jsdom environment's own) would answer for the server half - hide it for
    // the render, exactly as a real server never has one.
    const hadLocation = 'location' in globalThis;
    const savedLocation = (globalThis as any).location;
    let hidLocation = false;
    if (hadLocation) {
      try {
        (globalThis as any).location = undefined;
        hidLocation = true;
      } catch {
        /* an unforgeable location (a real browser-like env): leave it be */
      }
    }
    try {
      // the middleware runs first here too - the servers do, and an api
      if (mod.middleware) {
        const mw = await mod.runMiddleware(toRequest(url, req, body), body);
        if (mw) return { status: mw.status, html: await mw.text(), state: {}, head: [], lang: 'en', dir: '', document: await mw.text(), redirect: mw.headers.get('location') ?? undefined };
      }
      const page = await mod.renderPage(pathname, body);
      return result(page);
    } finally {
      if (hidLocation) (globalThis as any).location = savedLocation;
    }
  };

  
  let requests = 0;
  let currentRoute = route;

  const mount = async (req: TestRequest = {}): Promise<TestHandle> => {
    
    const win = ((opts.dom as any)?.window ?? opts.dom ?? globalThis) as any;
    if (!win?.document || !win?.DOMParser) {
      throw new Error('rosefd/test: mount() needs a DOM. Pass one - test("src/components/Counter.rose", { dom: new JSDOM() }) - or run under a jsdom environment.');
    }
    const page = await request(route, req);

    const doc = win.document;
    const app = doc.getElementById('app') ?? doc.body;
    // Reuse the state element across mounts of the same document: a second one
    // would lose getElementById's first-match race and the client would read
    // the stale element.
    let stateEl = doc.getElementById('__rosefd_state');
    if (!stateEl) {
      stateEl = doc.createElement('script');
      stateEl.id = '__rosefd_state';
      doc.body.appendChild(stateEl);
    }
    // The client's start(container, route, true) resumes from this element's
    // text as JSON (the browser bootstrap reads the same bytes off the real
    // document). TestResult.state is the parsed object, so it must be
    // re-serialized: assigning the object directly stringifies to
    // "[object Object]", resumeState's parse fails silently, and the client
    // render falls back to declared initials - a guests list shorter than the
    // SSR rows shifts every marker index and wire() crashes.
    stateEl.textContent = typeof page.state === 'string' ? page.state : JSON.stringify(page.state);
    app.innerHTML = page.html;

    // $query() parses location.search on the client half, exactly as it does in
    // a browser: a route rendered for '/search?q=rose' must see the same query
    // when the client re-renders it, or the two halves disagree on the rows.
    const loc = (url: string) => {
      const i = url.indexOf('?');
      return { pathname: i >= 0 ? url.slice(0, i) : url, search: i >= 0 ? url.slice(i) : '', href: `http://localhost${url}` };
    };

    const saved = new Map<string, unknown>();
    for (const key of GRAFTED) {
      saved.set(key, (globalThis as any)[key]);
      (globalThis as any)[key] = win[key] ?? (globalThis as any)[key];
    }
    (globalThis as any).location = loc(currentRoute);
    (globalThis as any).fetch = async (url: string | URL, init: any) => {
      const raw = String(url);
      const parsed = raw.startsWith('http') ? new URL(raw) : null;
      const target = parsed ? parsed.pathname + parsed.search : raw;
      const qi = target.indexOf('?');
      const localePath = qi >= 0 ? target.slice(0, qi) : target;
      if (localePath.startsWith('/locales/') && localePath.endsWith('.json')) {
        const file = path.join(outDir, localePath.slice(1));
        if (!fs.existsSync(file)) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf-8')) };
      }
      requests++;
      const next = await request(target, req, init?.body);
      return { ok: next.status < 400, status: next.status, text: async () => next.document };
    };

    const client = await import(pathToFileURL(clientImport).href);
    // start() matches routes by pathname; the query rides location.search for
    // $query() (the browser bootstrap makes the same split), so a route
    // mounted as '/search?q=rose' starts on '/search'.
    await client.start(app, loc(route).pathname, true);

    const one = (sel?: string): Element | null => (sel ? doc.querySelector(sel) : app);
    const handle: TestHandle = {
      route,
      document: doc,
      window: win,
      text: (sel?: string) => one(sel)?.textContent ?? '',
      html: (sel?: string) => one(sel)?.outerHTML ?? null,
      exists: (sel: string) => !!doc.querySelector(sel),
      click: async (sel: string) => {
        const el = doc.querySelector(sel);
        if (!el) throw new Error(`rosefd/test: no element matches ${sel}`);
        el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      },
      fill: (sel: string, value: string) => {
        const el = doc.querySelector(sel) as any;
        if (!el) throw new Error(`rosefd/test: no element matches ${sel}`);
        el.value = value;
        // A real keystroke fires input; wire()'s bind:value listens for exactly
        // that event. Setting .value alone leaves the binding blind, so every
        // fill() ends with the event the browser would have sent.
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
      },
      key: (sel: string, key: string, type: 'keydown' | 'keyup' = 'keydown') => {
        const el = doc.querySelector(sel) as any;
        if (!el) throw new Error(`rosefd/test: no element matches ${sel}`);
        el.dispatchEvent(new win.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      },
      submit: async (formSel = 'form', fields?: Record<string, unknown>) => {
        const form = doc.querySelector(formSel) as any;
        if (!form) throw new Error(`rosefd/test: no form matches ${formSel}`);
        const body = new win.FormData(form);
        for (const [k, v] of Object.entries(fields ?? {})) body.append(k, String(v));
        await client.postForm(body);
      },
      action: async (name: string, fields?: Record<string, unknown>) => {
        const body = new win.FormData();
        body.append('__action', name);
        for (const [k, v] of Object.entries(fields ?? {})) body.append(k, String(v));
        await client.postForm(body);
      },
      navigate: async (url: string) => {
        currentRoute = url;
        (globalThis as any).location = loc(url);
        // start() matches routes by pathname; the query rides location.search
        // for $query(), the same split the browser's own navigation makes.
        await client.start(app, loc(url).pathname, false);
      },
      state: () => {
        const el = doc.getElementById('__rosefd_state');
        return el?.textContent ? JSON.parse(el.textContent) : {};
      },
      requestCount: () => requests,
    };
    
    (handle as any).restore = () => { for (const [k, v] of saved) (globalThis as any)[k] = v; };
    return handle;
  };

  return {
    route,
    dir,
    get: async (pathname = route, req?: TestRequest) => request(pathname, req ?? {}),
    post: async (fields?: Record<string, unknown>, req: TestRequest & { route?: string } = {}) => {
      const pathname = req.route ?? route;
      const body = new FormData();
      for (const [k, v] of Object.entries(fields ?? {})) body.append(k, String(v));
      return request(pathname, req, body);
    },
    api: async (method: string, pathname: string, req: TestRequest = {}) => {
      
      if (mod.middleware) {
        const mw = await mod.runMiddleware(toRequest(pathname, req));
        if (mw) return { status: mw.status, body: await mw.text(), headers: { location: mw.headers.get('location') ?? '' } };
      }
      const res = await mod.handleApi(method, pathname, toRequest(pathname, req));
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {  }
      
      const headers: Record<string, string> = {};
      res.headers.forEach((v: string, k: string) => { headers[k] = v; });
      return { status: res.status, body, headers };
    },
    mount,
  };
}

export default test;
