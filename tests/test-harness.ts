/**
 * rosefd/test - the PUBLIC testing API, proven against the demo app.
 *
 * The framework's own suites (client/edge/e2e/go/cli/pack) drive the bundles
 * directly. This one drives them the way a USER does: through the single
 * `test()` entry point a project's own vitest file would import. If this
 * suite is green, a project can test its components, pages, middleware,
 * api routes and server actions with nothing but `rosefd/test`.
 *
 * What it proves, in order:
 *   1. a component target builds and renders with the given props
 *   2. a page target renders, with state the client can resume
 *   3. the middleware wall, the session cookie and locale negotiation
 *   4. api routes: public JSON, a guarded 401, the same call authorized
 *   5. server actions on the server half: success, ActionError, the cap
 *   6. mount() without a DOM says so instead of crashing obscurely
 *   7. the mounted half: a real submit -> in-place adopt, ONE request,
 *      zero hydration (untouched nodes keep their identity), an action
 *      error adopted in place, $action from no event, client-side nav
 *   8. restore() puts the process back the way it was
 *   9. the adopt contract across route shapes: the client render and the SSR
 *      document agree by INDEX (every close the render pushes lines up with
 *      the marker the server emitted) - proven on nested blocks, islands,
 *      $query + $data and attr bindings, not just one page's shape
 *
 * Run: npx tsx tests/test-harness.ts
 */

import { JSDOM } from 'jsdom';
import { test } from '../src/cli/test.js';

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const stripMarkers = (h: string) => h.replace(/<!--\u27e6[^>]*-->/g, '');

const card = await test('example/src/components/FactCard.rose', {
  props: { fact: 'components compile into the app' },
});
assert(card.route === '/__rosefd_test', 'a component target gets its own synthesized route');
const cardPage = await card.get();
assert(cardPage.status === 200, 'the synthesized route renders (200)');
assert(stripMarkers(cardPage.html).includes('components compile into the app'), 'the component renders with the given props');
assert(stripMarkers(cardPage.html).includes('<li class="fact">'), 'the component markup IS the page markup (no wrapper node)');
assert(stripMarkers(cardPage.html).includes('🌹'), 'the app layout still wraps a component test');

const home = await test('example/src/pages/index.rose');
assert(home.route === '/', 'a page target defaults to the page\'s own URL');
const homePage = await home.get();
assert(homePage.status === 200, 'the home page renders (200)');
assert(stripMarkers(homePage.html).includes('Welcome to Rose Frame Driver'), 'the page content is there');
assert(homePage.document.includes('id="__rosefd_state"'), 'the document carries the state script the client resumes');
assert(homePage.state.count === 0, 'the state parses out of the document (count starts at 0)');
assert(homePage.document.includes('<script'), 'the document ships the bundle (the page is interactive)');

const post = await test('example/src/pages/blog/[id].rose', { route: '/blog/2' });
assert(post.route === '/blog/2', 'a dynamic page target takes the concrete URL to render');
const postPage = await post.get();
assert(postPage.status === 200 && stripMarkers(postPage.html).includes('Blog Post #2'), 'the dynamic route renders the row for that URL');

const walled = await home.get('/vault');
assert(walled.status === 302 && walled.redirect === '/sign', 'the middleware wall redirects a session-less request');
const inside = await home.get('/vault', { cookies: { session: 'Ada' } });
assert(inside.status === 200, 'the session cookie opens the wall');
const negotiated = await home.get('/about', { headers: { 'accept-language': 'zh' } });
assert(negotiated.status === 302 && negotiated.redirect === '/zh/about', 'locale negotiation redirects to the visitor\'s language');
const unmatched = await home.get('/about', { headers: { 'accept-language': 'fr' } });
assert(unmatched.status === 200, 'a preference matching no dictionary serves the page in the default locale');

const hello = await home.api('GET', '/api/hello');
assert(hello.status === 200 && (hello.body as any)?.hello === 'Rose Frame Driver', 'a public api route answers JSON');
const secret = await home.api('GET', '/api/secret');
assert(secret.status === 401, 'the guarded api route refuses an anonymous call');
const mine = await home.api('GET', '/api/secret', { cookies: { session: 'Ada' } });
assert(mine.status === 200 && (mine.body as any)?.secret === 'the thorn is sharp', 'the same call with a session cookie answers');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const book = await test('example/src/pages/sign.rose', { dom });
assert(book.route === '/sign', 'a page target knows its route');
const signed = await book.post({ name: 'Margaret Hamilton' });
assert(signed.status === 200 && stripMarkers(signed.html).includes('Margaret Hamilton'), 'a POST runs the server action and re-renders with its effect');
const blank = await book.post({ name: '   ' });
assert(blank.status === 422 && stripMarkers(blank.html).includes('A signature needs a name.'), 'an ActionError keeps its status and shows its message');
assert(stripMarkers(blank.html).includes('Ada Lovelace'), 'the page still renders the store after the failure');

const bare = await test('example/src/pages/index.rose');
let mountError = '';
try {
  await bare.mount();
} catch (e) {
  mountError = String((e as Error).message);
}
assert(mountError.includes('needs a DOM'), 'mount() without a DOM explains what to pass');

const fetchBefore = globalThis.fetch;
const page = await book.mount();
assert(page.text('h1') === 'Guestbook 🌹', 'the mount adopts the SSR document');
assert(page.text('ul').includes('Margaret Hamilton'), 'the mounted page shows the store the server action wrote');
assert(page.requestCount() === 0, 'the mount itself costs no requests (the document was already rendered)');

const ulBefore = page.document.querySelector('ul');
await page.fill('input[name="name"]', 'Katherine Johnson');
await page.submit();
assert(page.text('ul').includes('Katherine Johnson'), 'a real submit adopts the action\'s response in place');
assert(page.requestCount() === 1, 'the in-place adopt cost exactly ONE request');
assert(page.text('h1') === 'Guestbook 🌹', 'the adopt swapped the page content, heading included');
assert(ulBefore !== null && page.document.querySelector('ul') !== null, 'the list is still a list after the adopt');

await page.fill('input[name="name"]', ' ');
await page.submit();
assert(page.text('#app').includes('A signature needs a name.'), 'an ActionError is adopted in place, message visible');
assert((page.state() as any).actionError?.code === 422, 'the adopted state carries the failure (code 422, field name)');
assert(page.requestCount() === 2, 'the failed action was still exactly one request');

await page.action('action', { name: 'Radia Perlman' });
assert(page.text('ul').includes('Radia Perlman'), '$action(name) runs the action from any event (here: none)');

await page.action('action', { name: 'Barbara Liskov' });
assert(page.text('#app').includes('guestbook is full'), 'the guard vetoes the sixth signature with its ActionError message');

await page.navigate('/');
assert(page.text('h1').includes('Welcome to Rose Frame Driver'), 'client-side navigation renders another route of the built app');
assert(page.requestCount() === 4, 'navigation re-rendered locally: no request for the new route');

const header = page.document.querySelector('header');
const heading = page.document.querySelector('h1');
assert(page.text('#app p strong') === '0', 'the navigated page starts at count 0');
await page.click('[data-on-click="increment"]');
assert(page.text('#app p strong') === '1', 'a click ran the handler and the state moved');
assert(page.document.querySelector('header') === header, 'fine-grained: the layout node the event did not touch keeps its identity');
assert(page.document.querySelector('h1') === heading, 'fine-grained: the heading keeps its identity too');

(page as any).restore();
assert((globalThis as any).document === undefined, 'restore() ungrafts the DOM globals');
assert(globalThis.fetch === fetchBefore, 'restore() puts the fetch proxy back to the process\'s own');

// --- the adopt contract across route shapes --------------------------------
// The mount above proved the client-render/SSR-document contract on ONE page
// shape (if + each + $store). The two halves agree by index: every close the
// client render pushes must line up with the marker the server emitted, or
// wire() attaches the wrong effect and crashes. Each shape below shifts those
// indexes a different way, so each mount is a separate guard.

const idxDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const idx = await test('example/src/pages/index.rose', { dom: idxDom });
const idxPage = await idx.mount();
assert(idxPage.text('h1').includes('Welcome to Rose Frame Driver'), 'the index mount adopts the SSR document');
assert(idxPage.text('#app').includes('This section failed to render.'), 'the {#boundary} degradation is in the adopted DOM');
assert(idxPage.text('#app').includes('Zero-hydration'), 'the each nested inside the if block rendered');
const feats = idxPage.document.querySelector('ul');
await idxPage.click('[data-on-click="increment"]');
assert(idxPage.text('#app p strong') === '1', 'a click on the adopted index page moves the state');
assert(idxPage.document.querySelector('ul') === feats, 'fine-grained: the list the click did not touch keeps its identity');
const beforeLike = idxPage.requestCount();
await idxPage.click('.rcard button');
assert(idxPage.text('#app').includes('42 likes'), 'the $action button on an adopted page runs server-side');
assert(idxPage.requestCount() === beforeLike + 1, 'the like cost exactly one request');
(idxPage as any).restore();

const islDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const isl = await test('example/src/pages/island-demo.rose', { dom: islDom });
const islPage = await isl.mount();
assert(islPage.text('h1') === 'Islands (T3)', 'the island page mounts');
assert(islPage.text('#app').includes('Hello World!'), 'the island region rendered');
const outside = islPage.document.querySelector('p');
await islPage.click('.counter button');
assert(islPage.text('.counter').includes('Count: 1'), 'the island hydrates: its button moves its state');
assert(islPage.document.querySelector('p') === outside, 'the static region outside the island keeps its identity');
(islPage as any).restore();

const srchDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const srch = await test('example/src/pages/search.rose', { route: '/search?q=rose', dom: srchDom });
const rosePage = await srch.mount();
assert(rosePage.text('#app').includes('result(s) for'), 'a query string reaches the render through the harness');
assert(rosePage.text('#app').includes('Hello Rose Frame Driver'), 'the $data resolver filtered on the query');
assert(rosePage.document.querySelector('input')?.getAttribute('value') === 'rose', 'the attr-bound input carries the query value');
const miss = await srch.get('/search?q=zzznomatch');
assert(miss.status === 200 && stripMarkers(miss.html).includes('0 result(s)'), 'a query with no hits renders the empty result set');
const noQuery = await srch.get('/search');
assert(noQuery.status === 200 && stripMarkers(noQuery.html).includes('Type a word'), 'no query renders the empty state');
(rosePage as any).restore();

// {#await}: the server flushes the pending branch, the client settles the
// promise in place - and the catch branch is reachable through a real event.
const tick = () => new Promise((r) => setTimeout(r, 0));
const awaitDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const awaitPage = await test('example/src/pages/await-demo.rose', { dom: awaitDom });
const serverFlush = await awaitPage.get();
assert(serverFlush.status === 200 && serverFlush.html.includes('Reading the index'), 'the server flush carries the pending branch only');
assert(!serverFlush.html.includes('Protocol v1'), 'the resolved branch stays in the client bundle, out of the flush');
const mounted = await awaitPage.mount();
await tick();
assert(mounted.text('#app ul').includes('Protocol v1') && mounted.text('#app ul').includes('Protocol v3'), 'the client settles the promise and adopts the resolved list');
(mounted as any).restore();

// the same page mounted with ?broken=1: the block's promise rejects, so the
// catch branch is what the client adopts - the second half of the contract.
const brokenDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const brokenPage = await test('example/src/pages/await-demo.rose', { route: '/await-demo?broken=1', dom: brokenDom });
const brokenFlush = await brokenPage.get('/await-demo?broken=1');
assert(brokenFlush.status === 200 && brokenFlush.html.includes('Reading the index'), 'a rejected block still flushes the pending branch');
const brokenMounted = await brokenPage.mount();
await tick();
assert(brokenMounted.text('#app').includes('Failed: the index is gone'), 'a rejected promise adopts the catch branch in place');
(brokenMounted as any).restore();

// {#defer}: the server flushes the placeholder, a timer flips the block on
// the client - the adopt swaps one {#if} for its complement in place.
const deferDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const deferPage = await test('example/src/pages/defer-demo.rose', { dom: deferDom });
const deferFlush = await deferPage.get();
assert(deferFlush.status === 200 && deferFlush.html.includes('rv-defer-loading'), 'the server flush carries the placeholder, not the deferred content');
assert(!deferFlush.html.includes('延迟渲染'), 'the deferred content stays out of the flush');
const deferMounted = await deferPage.mount();
assert(deferMounted.exists('.rv-defer-loading'), 'the mounted page opens on the placeholder');
await new Promise((r) => setTimeout(r, 80));
assert(!deferMounted.exists('.rv-defer-loading'), 'the timer took the placeholder away');
assert(deferMounted.text('#app').includes('延迟渲染：大块内容'), 'the deferred content took its place');
assert(deferMounted.text('#app').includes('页面尾部'), 'the rest of the page never moved');
(deferMounted as any).restore();

// {#key}: the keyed body is torn down and rebuilt when the key changes (an
// <input> loses its typed value), and left untouched - identity preserved -
// when a re-render carries the same key.
const keyDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const keyPage = await test('example/src/pages/key-demo.rose', { dom: keyDom });
const keyFlush = await keyPage.get();
assert(keyFlush.status === 200 && stripMarkers(keyFlush.html).includes('Showing the first tab'), 'the server flush renders the keyed body for the first key');
const keyMounted = await keyPage.mount();
assert(keyMounted.exists('#app input.scratch'), 'the keyed body mounted');
keyMounted.fill('#app input.scratch', 'typed text');
await keyMounted.click('button:first-of-type');
assert((keyMounted.document.querySelector('#app input.scratch') as HTMLInputElement).value === 'typed text', 're-clicking the active key leaves the body alone - the typed value survives');
await keyMounted.click('button:last-of-type');
assert(keyMounted.text('#app').includes('Showing the second tab'), 'the new key rendered its body');
assert((keyMounted.document.querySelector('#app input.scratch') as HTMLInputElement).value === '', 'switching the key rebuilt the body - the typed value is gone');
(keyMounted as any).restore();

// bind: the whole two-way family, driven by real events. fill() ends with the
// input event the browser would have sent; checkboxes and radios go through
// click() (a real toggle fires change).
const bindDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const bindPage = await test('example/src/pages/bind-demo.rose', { dom: bindDom });
const bindMounted = await bindPage.mount();
bindMounted.fill('.bind-demo input[placeholder="Type your name"]', 'Ada');
assert(bindMounted.text('#app').includes('Hello Ada'), 'bind:value writes through to the state and the greeting re-renders');
await bindMounted.click('input[type="checkbox"]');
assert(bindMounted.text('#app').includes('Subscribed'), 'bind:checked flips on a click');
await bindMounted.click('input[value="pro"]');
assert(bindMounted.text('#app').includes('Plan: pro'), 'bind:group (radio) holds the selected value');
await bindMounted.click('input[value="red"]');
assert(bindMounted.text('#app').includes('Colors: red'), 'bind:group (checkbox) accumulates an ARRAY of the checked values');
bindMounted.key('.key-probe', 'a');
assert(bindMounted.text('#app').includes('Last key: a'), 'keydown is not one of the delegated four - wire() binds it directly on the input');
bindMounted.key('.win-probe', 'Escape', 'keyup');
assert(bindMounted.text('#app').includes('Win key: Escape'), 'on:keyup|window moves the binding onto window itself');
(bindMounted as any).restore();

// {:else} / {:else if}: the chains are rewritten at compile time into
// complementary {#if}s - the adopt swaps one branch's nodes for its
// complement's, exactly like a hand-written pair of ifs.
const elseDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const elsePage = await test('example/src/pages/else-demo.rose', { dom: elseDom });
const elseFlush = await elsePage.get();
assert(elseFlush.status === 200 && stripMarkers(elseFlush.html).includes('alpha') && stripMarkers(elseFlush.html).includes('plenty'), 'the server flush renders the first branch of both chains');
const elseMounted = await elsePage.mount();
await elseMounted.click('button:first-of-type');
assert(elseMounted.exists('.grid-view') && !elseMounted.exists('.else-demo ul'), 'the first {:else if} took over the first branch\'s nodes');
await elseMounted.click('button:nth-of-type(2)');
assert(elseMounted.exists('.no-view') && !elseMounted.exists('.grid-view'), 'the {:else} took over when no earlier condition held');
await elseMounted.click('button:last-of-type');
assert(elseMounted.text('#app').includes('count guard: few'), 'an inline {#if}/{:else} flipped the other way');
(elseMounted as any).restore();

// Nesting stress: {#each} -> {#if}/{:else} -> {#each} -> {#if}. The {:else}
// inside an each row is what the if-else expander used to leapfrog (it
// compiled to invalid JS); the flips below are what the adopt fixes protect -
// every level tears down exactly its own range, no stray rows, no leftovers.
const nestDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const nestPage = await test('example/src/pages/nest-demo.rose', { dom: nestDom });
const nestFlush = await nestPage.get();
assert(nestFlush.status === 200 && stripMarkers(nestFlush.html).includes('Group A') && stripMarkers(nestFlush.html).includes('a1'), 'the server flush renders the on-groups with their rows');
const nestMounted = await nestPage.mount();
assert(nestMounted.document.querySelectorAll('#app .item').length === 2 && nestMounted.document.querySelectorAll('#app .on').length === 1 && nestMounted.document.querySelectorAll('#app .off').length === 1, 'group A mounted on with its rows, group B on the else branch');
await nestMounted.click('button:first-of-type');
assert(nestMounted.document.querySelectorAll('#app .item').length === 1 && nestMounted.document.querySelectorAll('#app .on').length === 1 && nestMounted.document.querySelectorAll('#app .off').length === 1, 'flipping swapped which group is on - only the revealed rows render');
await nestMounted.click('button:nth-of-type(2)');
assert(nestMounted.document.querySelectorAll('#app .item').length === 1, 'adding an item to the hidden group renders nothing');
await nestMounted.click('button:first-of-type');
assert(nestMounted.document.querySelectorAll('#app .item').length === 3 && nestMounted.document.querySelectorAll('#app .on').length === 1, 'flipping back revealed all three rows of group A');
await nestMounted.click('button:last-of-type');
assert(nestMounted.document.querySelectorAll('#app .off').length === 0, 'hiding the off-groups took the else branch\'s inner if down');
await nestMounted.click('button:last-of-type');
assert(nestMounted.document.querySelectorAll('#app .off').length === 1, 'showing them again put the inner if back');
(nestMounted as any).restore();

// {@html}: trusted html - the explicit reverse of esc(). A CMS's rendered
// markdown must arrive as markup, not escaped source, and the markers the
// block wraps it in must survive wire()'s adopt (rawMark reuses the {#if}
// machinery: identity preserved, no re-render).
const htmlDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const htmlPage = await test('example/src/pages/content-demo.rose', { dom: htmlDom });
const htmlFlush = await htmlPage.get();
assert(htmlFlush.status === 200 && htmlFlush.html.includes('<h1>Hello Content</h1>'), 'the flush carries the rendered markdown as real markup');
assert(htmlFlush.html.includes('<strong>src/content/posts/</strong>'), 'the inline markup inside the post body arrived as tags too');
const htmlMounted = await htmlPage.mount();
assert(htmlMounted.exists('#app div h1'), 'the trusted block is in the mounted DOM');
assert([...htmlMounted.document.querySelectorAll('#app h1')].some((h) => h.textContent === 'Hello Content'), 'wire() adopted the trusted block in place');
assert(htmlMounted.document.querySelectorAll('#app li').length >= 1, 'the content list rendered beside the trusted block');
(htmlMounted as any).restore();

// {@const}: a compile-time binding that must stay REACTIVE - the const's
// expression reads signals, so a signal write has to re-evaluate it. The top
// level is the hard case: the binding is a plain value captured in the
// render closure, so only a use site that re-reads the signal (through the
// compiled thunk) subscribes the wire() effect. One click moves qty: the
// direct expression, the const, the const built on the const, the attribute,
// the if condition and the per-item rows all have to follow.
const constDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const constPage = await test('example/src/pages/const-demo.rose', { dom: constDom });
const constFlush = await constPage.get();
assert(constFlush.status === 200 && stripMarkers(constFlush.html).includes('direct: 20') && stripMarkers(constFlush.html).includes('const: 20'), 'the flush renders the direct expression and the const with the same value');
assert(stripMarkers(constFlush.html).includes('total: 20'), 'a const built on another const resolves in the flush');
assert(stripMarkers(constFlush.html).includes('data-total="20"'), 'a const in an attribute position resolves in the flush');
assert(stripMarkers(constFlush.html).includes('small total'), 'a const in an {#if} condition resolves in the flush');
assert(stripMarkers(constFlush.html).includes('a=6') && stripMarkers(constFlush.html).includes('b=10'), 'a per-item const inside {#each} resolves in the flush');
// Shadowing: the top-level const shadows qty from its declaration on (its
// initializer still reads the signal: 2 * 1000), the nested same-name const
// builds on the OUTER const (2000 * 10), and the signal is back after the
// block closes.
assert(stripMarkers(constFlush.html).includes('shadow: 2000'), 'a const that shadows a state reads the state in its initializer');
assert(stripMarkers(constFlush.html).includes('shadow in block: 20000'), 'a nested same-name const builds on the shadowing const');
assert(stripMarkers(constFlush.html).includes('signal after block: 2'), 'the state is visible again after the shadowing block closes');
// An each item shadows EVERY outer name of the same name inside its body -
// here both the top-level const and the state - and the signal is back after
// {/each}.
assert(stripMarkers(constFlush.html).includes('a x3') && stripMarkers(constFlush.html).includes('b x5'), 'an each item shadows the const and the state of the same name');
assert(stripMarkers(constFlush.html).includes('signal after each: 2'), 'the state is visible again after the shadowing each');
assert(stripMarkers(constFlush.html).includes('stamped: none'), 'the handler section starts unstamped in the flush');
const constMounted = await constPage.mount();
assert(constMounted.text('#app').includes('const: 20'), 'the mount adopts the const page');
await constMounted.click('button:first-of-type');
assert(constMounted.text('#app').includes('direct: 30'), 'the direct expression moved on the click');
assert(constMounted.text('#app').includes('const: 30'), 'the top-level const re-evaluated on the click');
assert(constMounted.text('#app').includes('total: 30'), 'the const built on the const re-evaluated too');
assert(constMounted.text('#app').includes('attr: 30'), 'the const in a text position after the attribute moved too');
assert(constMounted.document.querySelector('[data-total]')?.getAttribute('data-total') === '30', 'the attribute itself moved');
assert(constMounted.text('#app').includes('a=9') && constMounted.text('#app').includes('b=15'), 'the per-item consts followed the signal');
assert(constMounted.text('#app').includes('shadow: 3000'), 'the shadowing const re-evaluated on the click');
assert(constMounted.text('#app').includes('shadow in block: 30000'), 'the nested shadowing const followed the signal too');
assert(constMounted.text('#app').includes('signal after block: 3'), 'the state moved under the shadow');
assert(constMounted.text('#app').includes('a x3') && constMounted.text('#app').includes('b x5'), 'the shadowing each item is not the signal - it did not move on the click');
assert(constMounted.text('#app').includes('signal after each: 3'), 'the state moved after the shadowing each');
await constMounted.click('button:nth-of-type(2)');
assert(!constMounted.exists('.badge'), 'the toggle took the const-in-if body down');
await constMounted.click('button:nth-of-type(2)');
assert(constMounted.exists('.badge'), 'the toggle put the const-in-if body back');
// In handlers: a top-level const is hoisted into the render() scope - the
// same scope the handlers registry is emitted in - so an on:click
// expression can read it. The earlier bump already moved qty to 3, so the
// first stamp reads 30; one more bump moves the const to 40 while the
// stamped state stays 30 (a stamp is a call, not a binding); the second
// stamp reads the LIVE const, not a mount-time snapshot.
assert(constMounted.text('#app').includes('stamped: none'), 'the mount starts unstamped');
await constMounted.click('button.stamp');
assert(constMounted.text('#app').includes('stamped: 30'), 'the handler reads the const (the hoist put the thunk in the handler scope)');
await constMounted.click('button:first-of-type');
assert(constMounted.text('#app').includes('const: 40'), 'the signal moved under the handler test too');
assert(constMounted.text('#app').includes('stamped: 30'), 'the stamped state does not follow the const on its own');
await constMounted.click('button.stamp');
assert(constMounted.text('#app').includes('stamped: 40'), 'the handler reads the live const, not a mount-time snapshot');
(constMounted as any).restore();

console.log(`\nAll rosefd/test checks passed - ${checks} assertions`);
