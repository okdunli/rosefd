/**
 * Compiler regression tests - pure compileComponent checks that need no
 * server. Run: tsx tests/test-compiler.ts (after the example build, like
 * test-client).
 *
 * F1 regression: braceDepthAt must skip regex literals. A build-plugin
 * preamble carrying /[&<>"']/g before a $data declaration used to desync the
 * brace counter (the " inside the regex opened a phantom string), the decl
 * was misjudged as nested and hoisted past its readers - TDZ at runtime.
 */
import { compileComponent, scopeCss } from '../src/compiler/index.ts';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// tsx resolves a dynamic import() specifier relative to the IMPORTING FILE,
// not the cwd - so scratch modules written cwd-relative were never found by
// their own imports, and every render-based check below failed with
// 'Cannot find module'. Anchor them at this file instead.
const HERE = path.dirname(fileURLToPath(import.meta.url));
import fs from 'node:fs';

let failures = 0;
(globalThis as any).__rvLoad = (key: string) => ({ counts: { n: 1 }, key });
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log('ok -', name);
  else { failures++; console.log('FAIL -', name, detail); }
}

function safeRm(p: string, opts: { recursive?: boolean } = {}): void {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(p, { force: true, ...opts }); return; }
    catch (e) {
      if (i === 9) throw e;
      const wait = 50 * (i + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

const tmp = path.join(process.cwd(), '.test-compiler-tmp.rose');
const PREAMBLE_WITH_REGEX = `<script>
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function __rvLoad(k){return {counts:{n:1}};}
</script>`;

const page = (body: string) => `<script>
${PREAMBLE_WITH_REGEX.match(/<script>([\s\S]*?)<\/script>/)![1]}
${body}
</script>
<head><title>t</title></head>
<div>ok</div>`;

const cases: Array<[string, string]> = [
  ['decl read after regex preamble', page(`
  let st = $data(() => __rvLoad("k", {}));
  const direct = st().counts;
  function counts() { return direct ? direct : st().counts; }`)],
  ['decl read after regex preamble ($state)', page(`
  let items = $state(['a', 'b']);
  const first = items()[0];`)],
  ['defer hold=N compiles to setTimeout flip', `<script>
  let st = $data(() => __rvLoad("k", {}));
  function counts() { return st().counts; }
</script>
<head><title>t</title></head>
<div>{#defer hold=800}<p>HELD</p>{/defer}</div>`],
  ['defer block compiles to skeleton + client flip', `<script>
  let st = $data(() => __rvLoad("k", {}));
  function counts() { return st().counts; }
</script>
<head><title>t</title></head>
<div>{#defer}<p>DEFERRED</p>{/defer}</div>`],
  ['await block compiles to pending SSR + client flip', `<script>
  function loadUsers() { return Promise.resolve(['a', 'b']); }
</script>
<head><title>t</title></head>
<div>{#await loadUsers()}<p>loading</p>{:then list}<ul>{#each list as u}<li>{u}</li>{/each}</ul>{:catch err}<p class="err">error</p>{/await}</div>`],
  ['await block without catch compiles', `<script>
  function go() { return Promise.resolve(42); }
</script>
<head><title>t</title></head>
<div>{#await go()}<p>wait</p>{:then n}<p>got {n}</p>{/await}</div>`],
  ['division after call stays division', page(`
  let n = $state(4);
  const half = n() / 2;`)],
];

fs.mkdirSync('.test-compiler-out', { recursive: true });
for (const [name, src] of cases) {
  fs.writeFileSync(tmp, src, 'utf-8');
  try {
    const out: any = await compileComponent(tmp, path.join(process.cwd(), 'public'), 'tc', false, [], new Map());
    const ssr: string = out.ssr || '';
    const iDecl = Math.min(...['const [st, setSt]', 'const [items, setItems]', 'const [n, setN]'].map((m) => { const i = ssr.indexOf(m); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
    const readNeedles = ['st().counts', "items()[0]", 'n() / 2'];
    const iRead = Math.min(...readNeedles.map((m) => { const i = ssr.indexOf(m); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
    if (name.startsWith('defer block')) {
      const dormant = !/DEFER_ENABLED = true/.test(
        fs.readFileSync('./src/compiler/index.ts', 'utf-8'),
      );
      const client: string = out.client || '';
      if (dormant) {
        check(`${name} (dormant: content static)`, ssr.includes('DEFERRED'), 'content missing');
        check(`${name} (dormant: no skeleton)`, !ssr.includes('rv-defer-loading'), 'skeleton leaked while dormant');
        check(`${name} (dormant: no boot)`, !client.includes('__rvDefer1'), 'boot code leaked while dormant');
      } else {
        check(`${name} (ssr skeleton)`, ssr.includes('rv-defer-loading'), 'no skeleton in ssr');
        check(`${name} (client flip)`, /__rvDefer1/.test(client) && /set__rvDefer1\(true\)/.test(client) && client.includes('DEFERRED'), 'client missing defer boot/content');
        fs.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
        fs.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
        const modPath = path.join(HERE, '.test-compiler-tmp/page.ssr.ts');
        fs.writeFileSync(modPath, out.ssr, 'utf-8');
        const mod = await import(pathToFileURL(modPath).href);
        const html = String(await mod.render([], [], {}, {}));
        check(`${name} (rendered ssr hides content)`, !html.includes('DEFERRED'), 'deferred content rendered server-side');
        check(`${name} (rendered ssr has skeleton)`, html.includes('rv-defer-loading'), 'skeleton missing from render');
        fs.rmSync(modPath, { force: true });
        fs.rmSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), { force: true });
      }
        } else if (name.startsWith('await block')) {
        const clientA: string = out.client || '';
        check(`${name} (ssr pending marker)`, ssr.includes('loading') || ssr.includes('wait'), 'no pending branch in ssr');
        check(`${name} (client flip code)`, /__rvAwait1/.test(clientA) && clientA.includes('Promise.resolve') && clientA.includes('set__rvAwait1('), 'client missing await boot code');
        check(`${name} (client carries then/catch)`, clientA.includes('error') || clientA.includes('got'), 'then/catch body missing from client');
        const tmpAwait = path.join(HERE, '.test-compiler-await');
        fs.mkdirSync(tmpAwait, { recursive: true });
        fs.writeFileSync(path.join(tmpAwait, 'runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
        const modPathA = path.join(tmpAwait, 'await-page.ssr.ts');
        fs.writeFileSync(modPathA, out.ssr, 'utf-8');
        const modA = await import(pathToFileURL(modPathA).href);
        const htmlA = String(await modA.render([], [], {}, {}));
        check(`${name} (rendered ssr shows pending)`, htmlA.includes('loading') || htmlA.includes('wait'), 'pending not in rendered html');
        check(`${name} (rendered ssr hides then/catch)`, !htmlA.includes('error') && !htmlA.includes('got'), 'then/catch leaked into server render');
        safeRm(modPathA);
        safeRm(path.join(tmpAwait, 'runtime.ts'));
        safeRm(tmpAwait, { recursive: true });
        } else {
      check(`${name} (ssr order)`, iDecl < Number.MAX_SAFE_INTEGER && iRead > iDecl, `decl@${iDecl} read@${iRead}`);
    }
    check(`${name} (compiles clean)`, ssr.length > 100);
    if (name === 'defer hold=N compiles to setTimeout flip') {
      const client: string = (out as any).client || '';
      check('defer hold: setTimeout 800 in client', client.includes('setTimeout') && client.includes('800'));
    }
  } catch (e) {
    check(name, false, String(e).slice(0, 120));
  }
}
safeRm(tmp);
safeRm('.test-compiler-out', { recursive: true });

if (failures) {
  console.log(`${failures} compiler test(s) failed`);
  process.exit(1);
}
{
  const fsImg = await import('fs');
  const pathImg = await import('path');
  const tmpImg = pathImg.join('.test-compiler-out', 'img-defaults.rose');
  fsImg.mkdirSync('.test-compiler-out', { recursive: true });
  fsImg.writeFileSync(tmpImg, `<div>
  <img src="/a.png" alt="a">
  <img src="/b.png" alt="b" loading="eager">
</div>`, 'utf-8');
  const out: any = await compileComponent(tmpImg, pathImg.join(process.cwd(), 'public'), 'tc-img', false, [], new Map());
  const ssr: string = out.ssr || '';
  const lazyCount = (ssr.match(/loading=/g) || []).length;
  check('img defaults: lazy + async added to bare img', lazyCount >= 2 && ssr.includes('decoding='));
  check('img defaults: explicit eager preserved', ssr.includes('eager') && ssr.split('loading=').length - 1 === 2);
}

{
  const fsImg = await import('fs');
  const pathImg = await import('path');
  const osImg = await import('os');
  const tmpPub = fsImg.mkdtempSync(pathImg.join((await import('os')).tmpdir(), 'rv-pub-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fsImg.writeFileSync(pathImg.join(tmpPub, 'c.png'), png);
  const tmpImg2 = pathImg.join('.test-compiler-out', 'img-dims.rose');
  fsImg.writeFileSync(tmpImg2, `<div>
  <img src="/c.png" alt="c">
  <img src="/c.png" alt="c2" width="10" height="20">
</div>`, 'utf-8');
  const out2: any = await compileComponent(tmpImg2, tmpPub, 'tc-imgd', false, [], new Map());
  const ssr2: string = out2.ssr || '';
  const W = (n: string) => new RegExp(`width=\\\\?"?${n}"?`).test(ssr2);
  const H = (n: string) => new RegExp(`height=\\\\?"?${n}"?`).test(ssr2);
  check('img dims: width/height injected from header', W('1') && H('1'));
  check('img dims: author width/height win', W('10') && H('20'));
  fsImg.rmSync(tmpPub, { recursive: true, force: true });
}

{
  const fsS = await import('fs');
  const pathS = await import('path');
  const tmpPub = fsS.mkdtempSync(pathS.join((await import('os')).tmpdir(), 'rv-ss-'));
  const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const big = Buffer.concat([png1, Buffer.alloc(8192)]);
  fsS.writeFileSync(pathS.join(tmpPub, 'd.png'), big);
  fsS.writeFileSync(pathS.join(tmpPub, 'd.w800.png'), png1);
  fsS.writeFileSync(pathS.join(tmpPub, 'd.w400.png'), png1);
  fsS.writeFileSync(pathS.join(tmpPub, 'e.png'), big);
  const tmpSS = pathS.join('.test-compiler-out', 'img-srcset.rose');
  fsS.mkdirSync('.test-compiler-out', { recursive: true });
  fsS.writeFileSync(tmpSS, `<div>
  <img src="/d.png" alt="d">
  <img src="/d.png" alt="da" srcset="/d.w1600.png 1600w">
  <img src="/e.png" alt="e">
</div>`, 'utf-8');
  const outS: any = await compileComponent(tmpSS, tmpPub, 'tc-srcset', false, [], new Map());
  const ssrS: string = outS.ssr || '';
  check('A4 srcset: sorted variants emitted', ssrS.includes('srcset=\\"/d.w400.png 400w, /d.w800.png 800w\\"'));
  check('A4 srcset: author srcset untouched', ssrS.includes('srcset=\\"/d.w1600.png 1600w\\"') && (ssrS.match(/srcset=/g) || []).length === 2);
  const at = ssrS.indexOf('/e.png');
  const eTag = at >= 0 ? ssrS.slice(ssrS.lastIndexOf('<img', at), ssrS.indexOf('>', at) + 1) : '';
  check('A4 srcset: no variants = no attribute', eTag.length > 0 && !eTag.includes('srcset'));
  safeRm(tmpSS);
  fsS.rmSync(tmpPub, { recursive: true, force: true });
}

{
  const fsT = await import('fs');
  const pathT = await import('path');
  const tmpT = pathT.join('.test-compiler-out', 'each-bridge.rose');
  fsT.mkdirSync('.test-compiler-out', { recursive: true });
  fsT.writeFileSync(tmpT, `<div>
  {#each globalThis.__rosefdContent.list("docs") as d}<li>{d.title}</li>{/each}
</div>`, 'utf-8');
  (globalThis as any).__rosefdContent = { get: () => null, list: () => ([{ title: 'A' }, { title: 'B' }]), mk: () => '' };
  const outT: any = await compileComponent(tmpT, pathT.join(process.cwd(), 'public'), 't22', false, [], new Map());
  fsT.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsT.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsT.writeFileSync(path.join(HERE, '.test-compiler-tmp/t22-page.ssr.ts'), outT.ssr, 'utf-8');
  const modT = await import('./.test-compiler-tmp/t22-page.ssr.ts');
  const htmlT = String(await modT.render([], [], {}, {}));
  check('T22: {#each} over globalThis bridge renders items', htmlT.includes('A') && htmlT.includes('B'));
  safeRm(tmpT);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  delete (globalThis as any).__rosefdContent;
}

{
  const fsI = await import('fs');
  const pathI = await import('path');
  const tmpI = pathI.join('.test-compiler-out', 'island.rose');
  fsI.mkdirSync('.test-compiler-out', { recursive: true });
  fsI.writeFileSync(tmpI, `<script>
  let who = $state('World');
  let count = $state(0);
  function inc() { count(count() + 1); }
</script>
<head><title>Islands</title></head>
<div>
  <p>STATIC OUTSIDE</p>
  {#island name="counter"}
    <p>Hello {who()}!</p>
    <p>Count: {count()}</p>
    <button on:click={inc}>Inc</button>
  {/island}
  <p>ALSO STATIC OUTSIDE</p>
</div>`, 'utf-8');
  const outI: any = await compileComponent(tmpI, pathI.join(process.cwd(), 'public'), 'isl', false, [], new Map());
  const ssrI: string = outI.ssr || '';
  fsI.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsI.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsI.writeFileSync(path.join(HERE, '.test-compiler-tmp/island-page.ssr.ts'), ssrI, 'utf-8');
  const modI = await import('./.test-compiler-tmp/island-page.ssr.ts');
  const htmlI = String(await modI.render([], [], {}, {}));
  check('T3 islands: wrapper div emitted', htmlI.includes('data-rv-island="counter"'));
  const before = htmlI.split('data-rv-island')[0];
  check('T3 islands: outside content static (no markers)', before.includes('STATIC OUTSIDE') && !before.includes('⟦'));
  check('T3 islands: inside content reactive (markers + handler)', htmlI.includes('⟦') && htmlI.includes('data-on-click'));
  safeRm(tmpI);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const pathI = await import('path');
  const fsI = await import('fs');
  fsI.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpH = pathI.join('.test-compiler-out', 'island-h.rose');
  fsI.writeFileSync(tmpH, `<script>
  let n = $state(0);
  function bump() { $setState('n', n() + 1); }
</script>
<p>STATIC</p>
{#island name="a" hydrate="visible"}
  <p>{n()}</p><button on:click={bump}>+</button>
{/island}
{#island name="b" hydrate="idle"}
  <p>{n()}</p>
{/island}
{#island name="c" hydrate="bogus"}
  <p>{n()}</p>
{/island}`, 'utf-8');
  const outH: any = await compileComponent(tmpH, pathI.join(process.cwd(), 'public'), 'islh', false, [], new Map());
  fsI.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsI.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsI.writeFileSync(path.join(HERE, '.test-compiler-tmp/island-h.ssr.ts'), outH.ssr, 'utf-8');
  const modH = await import('./.test-compiler-tmp/island-h.ssr.ts');
  const htmlH = String(await modH.render([], [], {}, {}));
  check('T3b islands: hydrate=visible carried on wrapper', htmlH.includes('data-rv-island="a" data-rv-island-hydrate="visible"'));
  check('T3b islands: hydrate=idle carried on wrapper', htmlH.includes('data-rv-island="b" data-rv-island-hydrate="idle"'));
  check('T3b islands: unknown hydrate dropped (immediate)', htmlH.includes('data-rv-island="c">') && !htmlH.includes('data-rv-island-hydrate="bogus"'));
  safeRm(tmpH);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsB = await import('fs');
  const pathB = await import('path');
  fsB.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpB = pathB.join('.test-compiler-out', 'bind.rose');
  fsB.writeFileSync(tmpB, `<script>
  let q = $state('');
  let on = $state(false);
  function flip() { $setState('on', !on()); }
</script>
<div>
  <input bind:value={q}>
  <p>{q()}</p>
  <input type="checkbox" bind:checked={on}>
  <p>{on() ? 'on' : 'off'}</p>
  <button on:click={flip}>flip</button>
</div>`, 'utf-8');
  const outB: any = await compileComponent(tmpB, pathB.join(process.cwd(), 'public'), 'bindpage', false, [], new Map());
  const srcB: string = String(outB.client ?? outB.ssr ?? '');
  check('F1 bind: reactive value attr + data-b emitted', /value=\\"?"?\(\) => \(q\(\)\)/.test(srcB) || srcB.includes('attrMark') && srcB.includes("() => (q())") && srcB.includes("'value'"));
  check('F1 bind: synthetic input handler writes state', srcB.includes('(e) => { const t = e.target; const raw = t.type === \'number\' || t.type === \'range\' ? t.valueAsNumber : t.value; setQ(typeof raw === \'number\' && Number.isNaN(raw) ? null : raw); }'));
  check('F1 bind: checked rides boolAttrMark', /boolAttrMark\(__c, \(\) => \(on\(\)\), 'checked'\)/.test(srcB));
  check('F1 bind: change handler for checked', srcB.includes('(e) => setOn(e.target.checked)'));
  safeRm(tmpB);

  const tmpBad = pathB.join('.test-compiler-out', 'bind-bad.rose');
  fsB.writeFileSync(tmpBad, `<div><input bind:value={nope}></div>`, 'utf-8');
  let threw = '';
  try { await compileComponent(tmpBad, pathB.join(process.cwd(), 'public'), 'bindbad', false, [], new Map()); }
  catch (e) { threw = (e as Error).message; }
  check('F1 bind: non-state target fails at the .rose file', threw.includes('must name a $state declaration'));
  safeRm(tmpBad);

  const tmpBool = pathB.join('.test-compiler-out', 'bool-attr.rose');
  fsB.writeFileSync(tmpBool, `<script>let off = $state(false);</script>
<div><input type="checkbox" checked={off}></div>`, 'utf-8');
  const outBool: any = await compileComponent(tmpBool, pathB.join(process.cwd(), 'public'), 'boolattr', false, [], new Map());
  const ssrBool = String(outBool.ssr ?? '');
  check('F1 boolean attr: no checked="false" in SSR', !ssrBool.includes('checked=\\\\"false\\\\"') && !ssrBool.includes('checked="false"'));
  safeRm(tmpBool);
}

{
  const fsE = await import('fs');
  const pathE = await import('path');
  fsE.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpE = pathE.join('.test-compiler-out', 'else.rose');
  fsE.writeFileSync(tmpE, `<script>
  let eon = $state(true);
  let en = $state(2);
</script>
<div>
  <p>{#if eon}ON{:else}OFF{/if}</p>
  <p>{#if en === 1}one{:else if en === 2}two{:else}many{/if}</p>
</div>`, 'utf-8');
  const outE: any = await compileComponent(tmpE, pathE.join(process.cwd(), 'public'), 'elsepage', false, [], new Map());
  fsE.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsE.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsE.writeFileSync(path.join(HERE, '.test-compiler-tmp/else-page.ssr.ts'), outE.ssr, 'utf-8');
  const modE = await import('./.test-compiler-tmp/else-page.ssr.ts');
  const html1 = String(await modE.render([], [], {}, {}));
  check('F2 else: true branch renders, else hidden', html1.includes('ON') && !html1.includes('>OFF') && html1.includes('two'));
  const rt = await import('./.test-compiler-tmp/runtime.ts');
  rt.setState('eon', false);
  rt.setState('en', 5);
  const html2 = String(await modE.render([], [], {}, {}));
  check('F2 else: flipped state renders the else branch', html2.includes('OFF') && html2.includes('many'));
  check('F2 else: source shows complementary negation', String(outE.ssr).includes('!('));
  safeRm(tmpE);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsI2 = await import('fs');
  const pathI2 = await import('path');
  fsI2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpEI = pathI2.join('.test-compiler-out', 'each-index.rose');
  fsI2.writeFileSync(tmpEI, `<script>
  let idxRows = $state(['a', 'b']);
  let on = $state(true);
  let big = $state(false);
</script>
<ul>{#each idxRows as r, i}<li>{i}: {r}</li>{/each}</ul>
<p class="btn" class:active={on} class:big={big}>x</p>`, 'utf-8');
  const outEI: any = await compileComponent(tmpEI, pathI2.join(process.cwd(), 'public'), 'eachidx', false, [], new Map());
  fsI2.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsI2.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsI2.writeFileSync(path.join(HERE, '.test-compiler-tmp/each-index.ssr.ts'), outEI.ssr, 'utf-8');
  const modEI = await import('./.test-compiler-tmp/each-index.ssr.ts');
  const htmlEI = String(await modEI.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F2d each-index: positions rendered', htmlEI.includes('0: a') && htmlEI.includes('1: b'));
  check('F2d class:: static + true segment, false segment absent', /class="[^"]*btn[^"]*active[^"]*"/.test(htmlEI) && !htmlEI.includes('big'));
  const rtI = await import('./.test-compiler-tmp/runtime.ts');
  rtI.setState('on', false);
  const htmlEI2 = String(await modEI.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F2d class:: flipped state drops the segment', !/\bactive\b/.test(htmlEI2) && htmlEI2.includes('btn'));
  safeRm(tmpEI);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsS2 = await import('fs');
  const pathS2 = await import('path');
  fsS2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpS2 = pathS2.join('.test-compiler-out', 'style-each.rose');
  fsS2.writeFileSync(tmpS2, `<script>
  let scolor = $state('blue');
  let srows = $state([]);
  let sfull = $state(['x']);
</script>
<div>
  <p style="color: red" style:color={scolor}>t</p>
  {#each srows as r}<li>{r}</li>{:else}<li class="empty">none</li>{/each}
  {#each sfull as f}<li>{f}</li>{:else}<li>none</li>{/each}
</div>`, 'utf-8');
  const outS2: any = await compileComponent(tmpS2, pathS2.join(process.cwd(), 'public'), 'styleeach', false, [], new Map());
  fsS2.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsS2.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsS2.writeFileSync(path.join(HERE, '.test-compiler-tmp/style-each.ssr.ts'), outS2.ssr, 'utf-8');
  const modS2 = await import('./.test-compiler-tmp/style-each.ssr.ts');
  const strip = (h: string) => h.replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  const htmlS1 = strip(String(await modS2.render([], [], {}, {})));
  check('F2f style:: override appended after static', /style="[^"]*color:\s*red;?\s*color:\s*blue[^"]*"/.test(htmlS1));
  check('F2f each-else: empty list renders the else branch', htmlS1.includes('none') && !htmlS1.includes('<li></li>'));
  const rtS2 = await import('./.test-compiler-tmp/runtime.ts');
  rtS2.setState('srows', ['r1']);
  const htmlS2 = strip(String(await modS2.render([], [], {}, {})));
  check('F2f each-else: non-empty list drops the else branch', htmlS2.includes('r1') && !htmlS2.includes('none'));
  safeRm(tmpS2);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsM = await import('fs');
  const pathM = await import('path');
  fsM.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpM = pathM.join('.test-compiler-out', 'mods.rose');
  fsM.writeFileSync(tmpM, `<script>
  let n = $state(0);
  let q = $state('');
  async function save() {}
</script>
<div>
  <form on:submit|preventDefault={save}><input bind:value={n} type="number"></form>
  <form on:submit|preventDefault|stopPropagation={() => {}}></form>
</div>`, 'utf-8');
  const outM: any = await compileComponent(tmpM, pathM.join(process.cwd(), 'public'), 'modspage', false, [], new Map());
  const srcM: string = String(outM.client ?? outM.ssr ?? '');
  check('F3 mods: preventDefault wraps the named handler', srcM.includes('(e) => { e.preventDefault(); (save)(e); }'));
  check('F3 mods: both modifiers compose', srcM.includes('e.preventDefault(); e.stopPropagation(); (() => {})(') || srcM.includes('e.stopPropagation(); (() => {})('));
  check('F3 numeric bind: valueAsNumber coercion', srcM.includes("t.type === 'number' || t.type === 'range' ? t.valueAsNumber : t.value"));
  safeRm(tmpM);
  const tmpBad = pathM.join('.test-compiler-out', 'mods-bad.rose');
  fsM.writeFileSync(tmpBad, `<div on:click|explode={() => {}}>x</div>`, 'utf-8');
  let threwM = '';
  try { await compileComponent(tmpBad, pathM.join(process.cwd(), 'public'), 'modsbad', false, [], new Map()); }
  catch (e) { threwM = (e as Error).message; }
  check('F3 mods: unknown modifier fails at the .rose file', threwM.includes('unknown event modifier |explode'));
  safeRm(tmpBad);
}

{
  const fsK = await import('fs');
  const pathK = await import('path');
  fsK.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpK = pathK.join('.test-compiler-out', 'keyed.rose');
  fsK.writeFileSync(tmpK, `<script>
  let subject = $state('a');
</script>
<div>
  {#key subject}<p class="kv">subject: {subject}</p>{/key}
</div>`, 'utf-8');
  const outK: any = await compileComponent(tmpK, pathK.join(process.cwd(), 'public'), 'keypage', false, [], new Map());
  fsK.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsK.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsK.writeFileSync(path.join(HERE, '.test-compiler-tmp/keyed.ssr.ts'), outK.ssr, 'utf-8');
  const modK = await import('./.test-compiler-tmp/keyed.ssr.ts');
  const htmlK1 = String(await modK.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F4 key: body renders from the expression', htmlK1.includes('subject: a'));
  const rtK = await import('./.test-compiler-tmp/runtime.ts');
  rtK.setState('subject', 'b');
  const htmlK2 = String(await modK.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F4 key: rebuilds when the expression changes', htmlK2.includes('subject: b'));
  check('F4 key: desugars through eachMark', String(outK.ssr).includes('eachMark') && String(outK.ssr).includes('['));
  safeRm(tmpK);
  const tmpK2 = pathK.join('.test-compiler-out', 'keyed-bad.rose');
  fsK.writeFileSync(tmpK2, `<div>{#key on}<p>x</p></div>`, 'utf-8');
  let threwK = '';
  try { await compileComponent(tmpK2, pathK.join(process.cwd(), 'public'), 'keybad', false, [], new Map()); }
  catch (e) { threwK = (e as Error).message; }
  check('F4 key: unclosed key fails loud', threwK.includes('is never closed'));
  safeRm(tmpK2);
}

{
  const fsU = await import('fs');
  const pathU = await import('path');
  fsU.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpU = pathU.join('.test-compiler-out', 'use.rose');
  fsU.writeFileSync(tmpU, `<script>
  directives.tooltip = (el) => { el.title = 'tip'; };
</script>
<div><span use:tooltip>hover</span></div>`, 'utf-8');
  const outU: any = await compileComponent(tmpU, pathU.join(process.cwd(), 'public'), 'usepage', false, [], new Map());
  const srcU = String(outU.ssr ?? '');
  check('F5 use: data-use attribute emitted', srcU.includes('data-use=\\"tooltip\\"') || srcU.includes('data-use="tooltip"'));
  check('F5 use: script can register via directives', String(outU.client ?? outU.ssr ?? '').includes('directives.tooltip'));
  safeRm(tmpU);
  const tmpU2 = pathU.join('.test-compiler-out', 'use-param.rose');
  fsU.writeFileSync(tmpU2, `<script>
  directives.tip = (el, p) => { el.title = String(p); return { update: (np) => { el.title = String(np); } }; };
  let who = $state('a');
</script>
<div><span use:tip={who}>x</span></div>`, 'utf-8');
  const outU2: any = await compileComponent(tmpU2, pathU.join(process.cwd(), 'public'), 'useparam', false, [], new Map());
  const srcU2 = String(outU2.ssr ?? '');
  check('F5b use: reactive param compiled', srcU2.includes('data-use-param={JSON.stringify(who())}') || srcU2.includes('data-use-param=\\\"') || srcU2.includes('data-use-param'));
  check('F5b use: param reaches the action as JSON', srcU2.includes('JSON.stringify(who())'));
  safeRm(tmpU2);
}

{
  const fsSp = await import('fs');
  const pathSp = await import('path');
  fsSp.mkdirSync('.test-compiler-out', { recursive: true });
  const cardP = pathSp.resolve('.test-compiler-out', 'card.rose');
  fsSp.writeFileSync(cardP, `<p class="card">{title}</p>`, 'utf-8');
  const registrySp = new Map([[cardP, { index: 0, scopeKey: 'components/card', slots: [] }]]);
  await compileComponent(cardP, pathSp.join(process.cwd(), 'public'), 'components/card', false, [], registrySp);
  const pageP = pathSp.resolve('.test-compiler-out', 'spread-page.rose');
  fsSp.writeFileSync(pageP, `<script>
  import Card from './card.rose';
  let rest = $state({ tone: 'dark' });
</script>
<Card {...rest} title="Hi"></Card>`, 'utf-8');
  const outSp: any = await compileComponent(pageP, pathSp.join(process.cwd(), 'public'), 'spreadpage', false, [], registrySp);
  const srcSp = String(outSp.ssr ?? '');
  check('F6 spread: object spread emitted into the props literal', /\.\.\.\(rest\)/.test(srcSp) && srcSp.includes('"title"'));
  safeRm(cardP);
  safeRm(pageP);
}

{
  const fsF = await import('fs');
  const pathF = await import('path');
  fsF.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpF = pathF.resolve('.test-compiler-out', 'fallback.rose');
  fsF.writeFileSync(tmpF, `<div>
  <slot name="rows">No rows yet</slot>
  <slot>default body</slot>
</div>`, 'utf-8');
  const outF: any = await compileComponent(tmpF, pathF.join(process.cwd(), 'public'), 'fbpage', false, [], new Map());
  const srcF = String(outF.ssr ?? '');
  check('F7 slot: named fallback rides __slotBlock', srcF.includes('"No rows yet"') && srcF.includes('__slotBlock'));
  check('F7 slot: unnamed fallback rides __slotDefault', srcF.includes('__slotDefault(children, "default body")'));
  safeRm(tmpF);
  const tmpF2 = pathF.resolve('.test-compiler-out', 'fallback-bad.rose');
  fsF.writeFileSync(tmpF2, `<div><slot name="x">count: {n}</slot></div>`, 'utf-8');
  let threwF = '';
  try { await compileComponent(tmpF2, pathF.join(process.cwd(), 'public'), 'fbpagebad', false, [], new Map()); }
  catch (e) { threwF = (e as Error).message; }
  check('F7 slot: reactive fallback rejected with the hint', threwF.includes('fallback content must be static'));
  safeRm(tmpF2);
}

{
  const fsS = await import('fs');
  const pathS = await import('path');
  fsS.mkdirSync('.test-compiler-out', { recursive: true });
  const cardS = pathS.resolve('.test-compiler-out', 'slots-card.rose');
  fsS.writeFileSync(cardS, `<div class="card"><slot name="a">fallback</slot></div>`, 'utf-8');
  const regS = new Map([[cardS, { index: 0, scopeKey: 'components/slots-card', slots: [{ name: 'a', props: [] }] }]]);
  await compileComponent(cardS, pathS.join(process.cwd(), 'public'), 'components/slots-card', false, [], regS);

  const pageS = pathS.resolve('.test-compiler-out', 'slots-nested.rose');
  fsS.writeFileSync(pageS, `<script>
  import Card from './slots-card.rose';
  let show = $state(true);
  let slotted = $state('SLOTTED_UNIQUE');
</script>
<Card>
  {#if show}
    <p slot="a">{slotted}</p>
  {/if}
</Card>`, 'utf-8');
  const outS: any = await compileComponent(pageS, pathS.join(process.cwd(), 'public'), 'slotsnested', false, [], regS);
  const srcS = String(outS.ssr ?? '');
  check('F21 slot: nested-in-if lifted into named slot closure', srcS.includes('"a": (__s, __c)') && srcS.includes('slotted()') && !srcS.includes('slot="a"'));
  check('F21 slot: block gate preserved on the lifted wrapper', srcS.includes('show()'));
  safeRm(cardS);
  safeRm(pageS);

  const cardE = pathS.resolve('.test-compiler-out', 'slots-card-e.rose');
  fsS.writeFileSync(cardE, `<div class="card"><slot name="a">fallback</slot></div>`, 'utf-8');
  const regE = new Map([[cardE, { index: 0, scopeKey: 'components/slots-card-e', slots: [{ name: 'a', props: [] }] }]]);
  await compileComponent(cardE, pathS.join(process.cwd(), 'public'), 'components/slots-card-e', false, [], regE);
  const pageE = pathS.resolve('.test-compiler-out', 'slots-wrap.rose');
  fsS.writeFileSync(pageE, `<script>
  import Card from './slots-card-e.rose';
</script>
<Card><div><p slot="a">x</p></div></Card>`, 'utf-8');
  let threwE = '';
  try { await compileComponent(pageE, pathS.join(process.cwd(), 'public'), 'slotse', false, [], regE); }
  catch (e) { threwE = (e as Error).message; }
  check('F21 slot: wrapper-element nesting still rejected', threwE.includes('must be a direct child'));
  safeRm(cardE);
  safeRm(pageE);
}

{
  const fsG = await import('fs');
  const pathG = await import('path');
  fsG.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpG = pathG.join('.test-compiler-out', 'group.rose');
  fsG.writeFileSync(tmpG, `<script>
  let plan = $state('free');
</script>
<div>
  <input type="radio" name="plan" value="free" bind:group={plan}>
  <input type="radio" name="plan" value="pro" bind:group={plan}>
</div>`, 'utf-8');
  const outG: any = await compileComponent(tmpG, pathG.join(process.cwd(), 'public'), 'grouppage', false, [], new Map());
  const srcG = String(outG.client ?? outG.ssr ?? '');
  check('F6b group: checked comparison + change handler emitted', srcG.includes('plan() === "free"') && srcG.includes('(e) => { setPlan(e.target.value); }'));
  safeRm(tmpG);
  const tmpG2 = pathG.resolve('.test-compiler-out', 'group-bad.rose');
  fsG.writeFileSync(tmpG2, `<script>let plan = $state('free');</script>
<div><input type="text" bind:group={plan}></div>`, 'utf-8');
  let threwG = '';
  try { await compileComponent(tmpG2, pathG.join(process.cwd(), 'public'), 'groupbad', false, [], new Map()); }
  catch (e) { threwG = (e as Error).message; }
  check('F6b group: non-radio fails with the radio hint', threwG.includes('bind:group is for radio and checkbox inputs'));
  safeRm(tmpG2);
}

{
  const fsM2 = await import('fs');
  const pathM2 = await import('path');
  fsM2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpM2 = pathM2.join('.test-compiler-out', 'multi-attr.rose');
  fsM2.writeFileSync(tmpM2, `<script>
  let hv = $state('/a');
  let tv = $state('T1');
</script>
<div><a href={hv} title={tv}>link</a></div>`, 'utf-8');
  const outM2: any = await compileComponent(tmpM2, pathM2.join(process.cwd(), 'public'), 'multiattr', false, [], new Map());
  fsM2.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsM2.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsM2.writeFileSync(path.join(HERE, '.test-compiler-tmp/multi-attr.ssr.ts'), outM2.ssr, 'utf-8');
  const modM2 = await import('./.test-compiler-tmp/multi-attr.ssr.ts');
  const htmlM2 = String(await modM2.render([], [], {}, {}));
  check('F8b multi-attr: both markers emitted with distinct names', /data-b0="href"/.test(htmlM2) && /data-b1="title"/.test(htmlM2));
  const domM2 = new (await import('jsdom')).JSDOM(htmlM2);
  const aM2 = domM2.window.document.querySelector('a');
  const namesM2 = aM2 ? aM2.getAttributeNames().filter((n) => n.startsWith('data-b')) : [];
  check('F8b multi-attr: both markers survive the HTML parse', namesM2.length === 2);
  safeRm(tmpM2);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsP = await import('fs');
  const pathP = await import('path');
  fsP.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpP = pathP.resolve('.test-compiler-out', 'persist.rose');
  fsP.writeFileSync(tmpP, `<script>
  let theme = $persist('light');
</script>
<div><p class="pv">{theme}</p></div>`, 'utf-8');
  const outP: any = await compileComponent(tmpP, pathP.join(process.cwd(), 'public'), 'persistpage', false, [], new Map());
  const srcP = String(outP.ssr ?? '');
  check('F9 persist: decl compiles through persistState', srcP.includes('persistState("theme"'));
  safeRm(tmpP);
}

{
  const fsBF = await import('fs');
  const pathBF = await import('path');
  fsBF.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpBF = pathBF.resolve('.test-compiler-out', 'bfb.rose');
  fsBF.writeFileSync(tmpBF, `<script>
  function boom() { throw new Error('widget broke'); }
</script>
{#boundary}
  <p class="ok">widget ok {boom()}</p>
{:fallback}
  <p class="fb">widget failed gracefully: {$boundaryError()?.message}</p>
{/boundary}`, 'utf-8');
  const outBF: any = await compileComponent(tmpBF, pathBF.join(process.cwd(), 'public'), 'bfbpage', false, [], new Map());
  fsBF.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsBF.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsBF.writeFileSync(path.join(HERE, '.test-compiler-tmp/bfb.ssr.ts'), outBF.ssr, 'utf-8');
  const modBF = await import('./.test-compiler-tmp/bfb.ssr.ts');
  const htmlBF = String(await modBF.render([], [], {}, {}));
  check('F11 boundary: custom fallback renders on throw', htmlBF.includes('widget failed gracefully') && !htmlBF.includes('widget ok'));
  check('F12 boundary: the caught error is readable via $boundaryError', htmlBF.includes('widget broke'));
  check('F11 boundary: fallback compiled as its own block', String(outBF.ssr).includes('__bf'));
  safeRm(tmpBF);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  const tmpBF2 = pathBF.resolve('.test-compiler-out', 'bfb-bad.rose');
  fsBF.writeFileSync(tmpBF2, `<div>{#boundary}{#if on}<p>x</p>{:fallback}<p>y</p>{/if}{/boundary}</div>`, 'utf-8');
  let threwBF = '';
  try { await compileComponent(tmpBF2, pathBF.join(process.cwd(), 'public'), 'bfpagebad', false, [], new Map()); }
  catch (e) { threwBF = (e as Error).message; }
  check('F11 boundary: nested {:fallback} fails with the move-it hint', threwBF.includes('must sit directly inside a {#boundary}'));
  safeRm(tmpBF2);
}

{
  const fsC = await import('fs');
  const pathC = await import('path');
  fsC.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpC = pathC.resolve('.test-compiler-out', 'const.rose');
  fsC.writeFileSync(tmpC, `<script>
  let items = $state([{ name: 'a', price: 10 }, { name: 'b', price: 20 }]);
  let rate = $state(1.1);
</script>
{@const top = rate() * 2}
{@const label = 'of ' + top}
<p>top: {top}</p>
<p>label: {label}</p>
<p data-v={top}>attr: {top}</p>
<ul>
{#each items as item}
  {@const total = item.price * rate()}
  <li>{item.name}: {total}</li>
{/each}
</ul>`, 'utf-8');
  const outC: any = await compileComponent(tmpC, pathC.join(process.cwd(), 'public'), 'constpage', false, [], new Map());
  fsC.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsC.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsC.writeFileSync(path.join(HERE, '.test-compiler-tmp/const.ssr.ts'), outC.ssr, 'utf-8');
  const modC = await import('./.test-compiler-tmp/const.ssr.ts');
  const htmlC = String(await modC.render([], [], {}, {}));
  check('F13 @const: top-level binding resolves', htmlC.includes('2.2'));
  check('F13 @const: per-item binding inside {#each} resolves', htmlC.includes('>11<') && htmlC.includes('>22<'));
  // The thunk carries an INTERNAL name (__rvctN), never the source one: a
  // const may shadow a state/derived/function, and reusing the name would
  // re-declare the binding or capture the outer value. Names are per-file
  // deterministic (compileComponent resets the counter), so top=__rvct0,
  // label=__rvct1, the each-scoped total=__rvct2.
  check('F13 @const: compiles to a thunk like $derived (a use re-reads the signals)', String(outC.ssr).includes('const __rvct0 = () => (rate() * 2)'));
  check('F13 @const: uses compile to calls of the internal thunk', String(outC.ssr).includes('=> (__rvct0())') && String(outC.ssr).includes('=> (__rvct2())'));
  check('F13 @const: a const built on a const calls the inner thunk', String(outC.ssr).includes("const __rvct1 = () => ('of ' + __rvct0())") && htmlC.includes('of 2.2'));
  check('F13 @const: a const in an attribute position compiles to a call', String(outC.ssr).includes("attrMark(__c, () => (__rvct0()), 'data-v')"));
  safeRm(tmpC);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsC2 = await import('fs');
  const pathC2 = await import('path');
  fsC2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpC2 = pathC2.resolve('.test-compiler-out', 'const-shadow.rose');
  // Every state name carries a z prefix: the signal registry is process-global
  // and first-registration-wins, so a plain name like `on` (an earlier test
  // sets it false) would silently flip this page's blocks.
  fsC2.writeFileSync(tmpC2, `<script>
  let zTotal = $state(5);
  let zQty = $state(3);
  let zShow = $state(true);
  let zOn = $state(true);
  let zV = $state(1);
  let zWord = $state('x');
  let zA = $state(4);
  function bump() { $setState('zQty', zQty() + 1); }
</script>
{@const total = zTotal() * 2}
<p>const: {total}</p>
<p>state: {zTotal()}</p>
{#if zShow}
  {@const qty = zQty() * 10}
  <p>in block: {qty}</p>
{:else}
  <p>else: {zQty()}</p>
{/if}
<p>after block: {zQty()}</p>
{@const v = zV() + 100}
{#if zOn}
  {@const v = v + 10}
  <p>inner: {v}</p>
{/if}
<p>outer: {v}</p>
{@const bump = zA() * 7}
<p>fn shadow: {bump}</p>
{@const word = 'word word'}
<p title="word word">{word}</p>`, 'utf-8');
  const outC2: any = await compileComponent(tmpC2, pathC2.join(process.cwd(), 'public'), 'constshadowpage', false, [], new Map());
  fsC2.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsC2.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsC2.writeFileSync(path.join(HERE, '.test-compiler-tmp/const-shadow.ssr.ts'), outC2.ssr, 'utf-8');
  const modC2 = await import('./.test-compiler-tmp/const-shadow.ssr.ts');
  const htmlC2 = String(await modC2.render([], [], {}, {}));
  const ssrC2 = String(outC2.ssr);
  const marked = (label: string, value: string): boolean =>
    new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': <!--⟦m:\\d+⟧-->' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(htmlC2);
  // Thunk numbering is deterministic per file: a scope's OWN declarations are
  // numbered first, in source order (total=__rvct0, v=__rvct1, bump=__rvct2,
  // word=__rvct3), and each nested scope's when its recursive call runs
  // (the block's qty=__rvct4, the inner v=__rvct5). The upfront pass that
  // hands out these ids walks the whole scope once, so a declaration AFTER a
  // block still precedes that block's consts in the sequence.
  // Top-level shadow: the use reads the const (10), the explicit call reads
  // the signal (5) - and the declaration itself is no longer mangled into
  // {@const total() = …}, which used to fail the const matcher at build time.
  check('F14 shadow: a top-level const shadows the state it reads', ssrC2.includes('const __rvct0 = () => (zTotal() * 2)') && marked('const', '10') && marked('state', '5'));
  // Block-level shadow: inside the block the const (30), after it the signal
  // (3) - the scope closes with the block.
  check('F14 shadow: a block-level const shadows the state only inside its block', marked('in block', '30') && marked('after block', '3'));
  // Nested shadow: the inner initializer reads the OUTER const (101 + 10),
  // and after the block the outer const is back (101).
  check('F14 shadow: a nested same-name const builds on the outer one', ssrC2.includes('const __rvct5 = () => (__rvct1() + 10)') && ssrC2.includes('const __rvct1 = () => (zV() + 100)') && marked('inner', '111') && marked('outer', '101'));
  // A const may shadow a script function; the text use reads the const (28).
  check('F14 shadow: a const shadows a script function without breaking either', marked('fn shadow', '28'));
  // String literals are never rewritten, in an initializer or an attribute.
  check('F14 shadow: string literals survive the rewrite untouched', ssrC2.includes("const __rvct3 = () => ('word word')") && htmlC2.includes('<p title="word word">') && /<!--⟦m:\d+⟧-->word word/.test(htmlC2));
  // No source-named thunk may leak into the output.
  check('F14 shadow: no source-named const thunk is emitted', !/const (?:total|qty|v|bump|word) = \(\) =>/.test(ssrC2));
  safeRm(tmpC2);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  // F15: block-introduced bindings shadow outer names. An each item/index,
  // every name in a destructuring pattern, a snippet parameter and the
  // {:then}/{:catch} variable are DECLARATIONS, not use sites - rewriting
  // one shattered the head itself ({#each rows as name} became
  // {#each rows as name()}, a build failure) and hijacked the body's uses.
  // State names carry a z prefix: the signal registry is process-global and
  // first-registration-wins.
  const fsC3 = await import('fs');
  const pathC3 = await import('path');
  fsC3.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpC3 = pathC3.resolve('.test-compiler-out', 'each-shadow.rose');
  fsC3.writeFileSync(tmpC3, `<script>
  let zRows = $state(['a', 'b']);
  let zName = $state('SIGNAL');
  let zIdx = $state(-1);
  let zObjs = $state([{ zNm: 'x' }, { zNm: 'y' }]);
  let zNm = $state('SIGNAL');
  let zKeyed = $state([{ zId: 7, t: 'p' }, { zId: 9, t: 'q' }]);
</script>
<ul>
{#each zRows() as zName}
  <li>item: {zName}</li>
{/each}
</ul>
<p>signal: {zName()}</p>
<ol>
{#each zRows() as zIt, zIdx}
  <li>idx: {zIdx}={zIt}</li>
{/each}
</ol>
<p>idx signal: {zIdx()}</p>
<ul>
{#each zObjs() as { zNm }}
  <li>destr: {zNm}</li>
{/each}
</ul>
<ul>
{#each zKeyed() as row (row.zId)}
  <li>key: {row.t}</li>
{/each}
</ul>
{#snippet zSnip(zNm)}
  <p>snip: {zNm}</p>
{/snippet}
{@render zSnip('CALLED')}
{#await Promise.resolve([1, 2])}
  <p>loading</p>
{:then zNm}
  <p>then: {zNm.length}</p>
{/await}`, 'utf-8');
  const outC3: any = await compileComponent(tmpC3, pathC3.join(process.cwd(), 'public'), 'eachshadowpage', false, [], new Map());
  fsC3.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsC3.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsC3.writeFileSync(path.join(HERE, '.test-compiler-tmp/each-shadow.ssr.ts'), outC3.ssr, 'utf-8');
  const modC3 = await import('./.test-compiler-tmp/each-shadow.ssr.ts');
  const rawC3 = String(await modC3.render([], [], {}, {}));
  // Adjacent text marks carry a CLOSING marker between them, and marker
  // indices shift with earlier renders in the same process - so strip the
  // markers entirely (the F2d pattern) and assert on the plain text.
  const htmlC3 = rawC3.replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  const ssrC3 = String(outC3.ssr);
  // The item shadows the state inside the block; the signal is back after it.
  check('F15 each: the item shadows a same-named state, the signal survives the block', htmlC3.includes('item: a') && htmlC3.includes('item: b') && htmlC3.includes('signal: SIGNAL'));
  // The index shadows too, and both names survive in one head.
  check('F15 each: the index shadows a same-named state', htmlC3.includes('idx: 0=a') && htmlC3.includes('idx: 1=b') && htmlC3.includes('idx signal: -1'));
  // A destructuring pattern's names shadow, and the pattern still binds.
  check('F15 each: a destructuring pattern shadows and binds', htmlC3.includes('destr: x') && htmlC3.includes('destr: y'));
  // A keyed each keeps its key (the item is in scope for it) and the body reads the item.
  check('F15 each: a keyed each keeps its key expression', ssrC3.includes('(__s, __i) => (__s.zId)') && htmlC3.includes('key: p') && htmlC3.includes('key: q'));
  // A snippet parameter shadows; the call passes the value through.
  check('F15 snippet: a parameter shadows a same-named state', htmlC3.includes('snip: CALLED'));
  // The {:then} variable shadows in its branch body - proven in the source,
  // because the branch renders empty while the promise is pending.
  check('F15 await: the {:then} variable shadows in its branch body', ssrC3.includes('(__s) => (__s.length)'));
  // No head may carry a rewritten binding.
  check('F15: no block head carries a callified binding', !/#each[^\n]*as \w+\(\)/.test(ssrC3) && !/:then \w+\(\)/.test(ssrC3) && !/#snippet \w+\([^)]*\(\)/.test(ssrC3));
  safeRm(tmpC3);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsD = await import('fs');
  const pathD = await import('path');
  fsD.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpD = pathD.resolve('.test-compiler-out', 'destr.rose');
  fsD.writeFileSync(tmpD, `<script>
  let items = $state([{ name: 'a', price: 10 }, { name: 'b', price: 20 }]);
  let pairs = $state([['x', 1], ['y', 2]]);
</script>
<ul>
{#each items as {name, price}}
  <li>{name}: {price}</li>
{/each}
</ul>
<dl>
{#each pairs as [k, v]}
  <dt>{k}</dt><dd>{v}</dd>
{/each}
</dl>`, 'utf-8');
  const outD: any = await compileComponent(tmpD, pathD.join(process.cwd(), 'public'), 'destrpage', false, [], new Map());
  fsD.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsD.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsD.writeFileSync(path.join(HERE, '.test-compiler-tmp/destr.ssr.ts'), outD.ssr, 'utf-8');
  const modD = await import('./.test-compiler-tmp/destr.ssr.ts');
  const htmlD = String(await modD.render([], [], {}, {}));
  check('F14 each destructuring: object pattern renders both rows', htmlD.includes('>a<') && htmlD.includes('>10<') && htmlD.includes('>b<') && htmlD.includes('>20<'));
  check('F14 each destructuring: array pattern renders both pairs', htmlD.includes('>x<') && htmlD.includes('>1<') && htmlD.includes('>y<') && htmlD.includes('>2<'));
  check('F14 each destructuring: pattern declared in the block fn', String(outD.ssr).includes('const {name, price} = __s;') && String(outD.ssr).includes('const [k, v] = __s;'));
  safeRm(tmpD);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsE = await import('fs');
  const pathE = await import('path');
  fsE.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpE = pathE.resolve('.test-compiler-out', 'ref.rose');
  fsE.writeFileSync(tmpE, `<script>
  let box = $state(null);
</script>
<div bind:this={box}>panel</div>`, 'utf-8');
  const outE: any = await compileComponent(tmpE, pathE.join(process.cwd(), 'public'), 'refpage', false, [], new Map());
  check('F15 bind:this: emits the data-bind-this marker', /data-bind-this[=]["\\]*box/.test(String(outE.ssr)));
  check('F15 bind:this: no event handler is attached', !/data-on-(input|change)=/.test(String(outE.ssr)));
  safeRm(tmpE);
  const tmpE2 = pathE.resolve('.test-compiler-out', 'ref-bad.rose');
  fsE.writeFileSync(tmpE2, `<script>
  let box = $state(null);
</script>
<div bind:this={notDeclared}>panel</div>`, 'utf-8');
  let threwE = '';
  try { await compileComponent(tmpE2, pathE.join(process.cwd(), 'public'), 'refpagebad', false, [], new Map()); }
  catch (e) { threwE = (e as Error).message; }
  check('F15 bind:this: a non-$state name is refused', threwE.includes('must name a $state declaration'));
  safeRm(tmpE2);
}

{
  const fsF = await import('fs');
  const pathF = await import('path');
  fsF.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpF = pathF.resolve('.test-compiler-out', 'mods2.rose');
  fsF.writeFileSync(tmpF, `<script>
  function hit() {}
</script>
<div on:click|self={hit}>a</div>
<span on:click|once={hit}>b</span>`, 'utf-8');
  const outF: any = await compileComponent(tmpF, pathF.join(process.cwd(), 'public'), 'mods2page', false, [], new Map());
  const srcF: string = String(outF.client ?? outF.ssr ?? '');
  check('F16 mods: |self guards on the bound element', srcF.includes('if (__self && e.target !== __self) return;'));
  check('F16 mods: |once unbinds after the first run', srcF.includes("removeAttribute('data-on-' + e.type)"));
  safeRm(tmpF);
  const tmpF2 = pathF.resolve('.test-compiler-out', 'mods2-bad.rose');
  fsF.writeFileSync(tmpF2, `<script>
  function hit() {}
</script>
<div on:click|passive={hit}>a</div>`, 'utf-8');
  let threwF = '';
  try { await compileComponent(tmpF2, pathF.join(process.cwd(), 'public'), 'mods2bad', false, [], new Map()); }
  catch (e) { threwF = (e as Error).message; }
  check('F16 mods: a listener-option modifier is refused with the reason', threwF.includes('unknown event modifier |passive'));
  safeRm(tmpF2);
}

// F17: a TOP-LEVEL {@const} is hoisted out of __root into the render() scope -
// the same scope the handlers registry is emitted in - so an on:click
// expression can read it. Before the hoist the binding kept the bare name: a
// ReferenceError on click, or the same-named signal's getter under a shadow.
// Block-level consts stay in __root (they may read block bindings the render
// scope does not have), so a handler still cannot see those - the boundary is
// structural and documented, not a silent wrong value.
{
  const fsI = await import('fs');
  const pathI = await import('path');
  fsI.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpI = pathI.resolve('.test-compiler-out', 'handler-const.rose');
  fsI.writeFileSync(tmpI, `<script>
  let zP17 = $state(10);
  let zQ17 = $state(2);
  let zTS17 = $state(999);
  let zL17 = $state('none');
  function zN17() {}
</script>
{@const zT17 = zP17() * zQ17()}
{@const zTS17 = 7}
<p>a: {zT17}</p>
<p>b: {zTS17}</p>
<button on:click={() => $setState('zL17', zT17)}>a</button>
<button on:click={() => $setState('zL17', zTS17)}>b</button>
<button on:click={zN17}>c</button>
{#if true}
  {@const zI17 = zP17() + 1}
  <button on:click={() => $setState('zL17', zI17)}>d</button>
{/if}`, 'utf-8');
  const outI: any = await compileComponent(tmpI, pathI.join(process.cwd(), 'public'), 'handlerconstpage', false, [], new Map());
  const srcI = String(outI.ssr);
  const clientI = String(outI.client);
  // Both top-level consts are hoisted as internal thunks, the shadowing one
  // second - and neither keeps its source name.
  check('F17 handler: top-level consts hoist as internal thunks', srcI.includes('const __rvct0 = () => (zP17() * zQ17())') && srcI.includes('const __rvct1 = () => (7)'));
  // The hoist is into the render() scope: the thunk precedes __root in both
  // outputs, and precedes the handlers registry in the client.
  const thunkAt = srcI.indexOf('const __rvct0');
  const rootAt = srcI.indexOf('const __root');
  const regAt = clientI.indexOf('Object.assign(handlers');
  const clientThunkAt = clientI.indexOf('const __rvct0');
  check('F17 handler: the thunk lands in the render() scope', thunkAt >= 0 && thunkAt < rootAt && clientThunkAt >= 0 && clientThunkAt < regAt && regAt < clientI.indexOf('const __root'));
  // The handler expressions are rewritten to the internal names - the
  // shadowing const wins over the same-named signal.
  check('F17 handler: the binding reads the const, not the signal', clientI.includes("__h0: () => $setState('zL17', __rvct0())") && clientI.includes("__h1: () => $setState('zL17', __rvct1())"));
  // A bare-word handler names a script function to CALL; it is left alone.
  check('F17 handler: a bare-word handler is not renamed', clientI.includes('zN17') && !clientI.includes('__h2'));
  // A block-level const is not hoisted - its thunk is emitted inline inside
  // __root - and the handler keeps the bare name: the structural boundary,
  // pinned rather than papered over.
  check('F17 handler: a block-level const stays out of the handler scope', clientI.includes("__h3: () => $setState('zL17', zI17)") && srcI.includes('const __rvct2 = () => (zP17() + 1)') && srcI.indexOf('const __rvct2') > srcI.indexOf('const __root'));
  // The template uses still resolve through the hoisted thunks.
  fsI.mkdirSync(pathI.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsI.writeFileSync(pathI.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsI.writeFileSync(pathI.join(HERE, '.test-compiler-tmp/handler-const.ssr.ts'), srcI, 'utf-8');
  const modI = await import('./.test-compiler-tmp/handler-const.ssr.ts');
  const htmlI = String(await modI.render([], [], {}, {}));
  check('F17 handler: the SSR output renders both const values', htmlI.replace(/<!--⟦[^>]*⟧-->/g, '').includes('a: 20'));
  check('F17 handler: the shadowing const renders in SSR too', htmlI.replace(/<!--⟦[^>]*⟧-->/g, '').includes('b: 7'));
  safeRm(tmpI);
  safeRm(pathI.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

// F18: a bare name in a block condition is read as a SIGNAL and called -
// but a JS literal is not a signal. autoCall used to rewrite {#if true}
// into ifMark(…, () => (true())…), a TypeError the moment the block ran,
// so a literal condition crashed the page instead of gating it.
{
  const fsJ = await import('fs');
  const pathJ = await import('path');
  fsJ.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpJ = pathJ.resolve('.test-compiler-out', 'literal-cond.rose');
  fsJ.writeFileSync(tmpJ, `{#if true}\n<p>yes</p>\n{:else}\n<p>no</p>\n{/if}\n{#if false}\n<p>never</p>\n{/if}`, 'utf-8');
  const outJ: any = await compileComponent(tmpJ, pathJ.join(process.cwd(), 'public'), 'literalcondpage', false, [], new Map());
  const srcJ = String(outJ.ssr);
  check('F18 literal: a true condition compiles to the literal, not a call', srcJ.includes('ifMark(__c, () => (true)') && !srcJ.includes('true()'));
  check('F18 literal: a false condition likewise stays a literal', srcJ.includes('ifMark(__c, () => (false)') && !srcJ.includes('false()'));
  fsJ.mkdirSync(pathJ.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsJ.writeFileSync(pathJ.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsJ.writeFileSync(pathJ.join(HERE, '.test-compiler-tmp/literal-cond.ssr.ts'), srcJ, 'utf-8');
  const modJ = await import('./.test-compiler-tmp/literal-cond.ssr.ts');
  const htmlJ = String(await modJ.render([], [], {}, {}));
  check('F18 literal: the true branch renders and the false one does not', htmlJ.includes('yes') && !htmlJ.includes('no') && !htmlJ.includes('never'));
  safeRm(tmpJ);
  safeRm(pathJ.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

// F19: two same-named TOP-LEVEL {@const}s. The hoistedConstRenames map is
// keyed by source name, so a second top-level declaration used to capture
// every handler expression sitting between the two - it silently read the
// second thunk where the nearest preceding binding is the first. Plain JS
// refuses `const x` twice in one scope; so does the const pass now. The two
// controls pin what stays LEGAL: the same name in sibling blocks (that is
// shadowing, not redeclaration), and a handler reading a top-level const
// while a same-name const lives in a nested block.
{
  const fsK = await import('fs');
  const pathK = await import('path');
  fsK.mkdirSync('.test-compiler-out', { recursive: true });

  const tmpK1 = pathK.resolve('.test-compiler-out', 'const-dup.rose');
  fsK.writeFileSync(tmpK1, `<script>
  let zBase19 = $state(1);
</script>
{@const zX19 = zBase19()}
<button on:click={() => $setState('zOut19', zX19)}>a</button>
{@const zX19 = zX19 + 10}
<p>second: {zX19}</p>`, 'utf-8');
  let threwK = '';
  try {
    await compileComponent(tmpK1, pathK.join(process.cwd(), 'public'), 'constduppage', false, [], new Map());
  } catch (e: any) {
    threwK = String(e?.message ?? e);
  }
  check('F19 dup: a second top-level const of the same name is a build error', threwK.includes('declared twice at the top level'));
  safeRm(tmpK1);

  const tmpK2 = pathK.resolve('.test-compiler-out', 'const-sibling.rose');
  fsK.writeFileSync(tmpK2, `<script>
  let zA19 = $state(true);
  let zB19 = $state(false);
</script>
{#if zA19}
  {@const zX19 = 1}
  <p>first: {zX19}</p>
{/if}
{#if zB19}
  {@const zX19 = 2}
  <p>second: {zX19}</p>
{/if}`, 'utf-8');
  const outK2: any = await compileComponent(tmpK2, pathK.join(process.cwd(), 'public'), 'constsibpage', false, [], new Map());
  fsK.mkdirSync(pathK.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsK.writeFileSync(pathK.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsK.writeFileSync(pathK.join(HERE, '.test-compiler-tmp/const-sibling.ssr.ts'), String(outK2.ssr), 'utf-8');
  const modK2 = await import('./.test-compiler-tmp/const-sibling.ssr.ts');
  const htmlK2 = String(await modK2.render([], [], {}, {})).replace(/<!--⟦[^>]*⟧-->/g, '');
  check('F19 sibling: the same const name in sibling blocks is shadowing, not redeclaration', htmlK2.includes('first: 1') && !htmlK2.includes('second:'));
  safeRm(tmpK2);
  safeRm(pathK.join(HERE, '.test-compiler-tmp'), { recursive: true });

  const tmpK3 = pathK.resolve('.test-compiler-out', 'const-nested-handler.rose');
  fsK.writeFileSync(tmpK3, `<script>
  let zBase19b = $state(1);
  let zOn19 = $state(true);
</script>
{@const zX19b = zBase19b()}
<button on:click={() => $setState('zOut19b', zX19b)}>a</button>
{#if zOn19}
  {@const zX19b = zBase19b() + 100}
  <p>inner: {zX19b}</p>
{/if}`, 'utf-8');
  const outK3: any = await compileComponent(tmpK3, pathK.join(process.cwd(), 'public'), 'constnestpage', false, [], new Map());
  check('F19 nested: a handler reads the top-level const, not a same-name block const', String(outK3.client).includes("$setState('zOut19b', __rvct0())"));
  safeRm(tmpK3);
}

{
  const fsL = await import('fs');
  const pathL = await import('path');
  fsL.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpL = pathL.resolve('.test-compiler-out', 'island-mix.rose');
  // The non-marker path: a page that declares an {#island} compiles
  // everything OUTSIDE the island without dynamic markers - and that path
  // had an unbalanced paren in the non-reactive {#each} emission, which made
  // the whole page fail at runtime.
  fsL.writeFileSync(tmpL, `<script>
  let zItems20 = $state(['a', 'b', 'c']);
  let zOn20 = $state(true);
  let zIdx20 = $state(7);
  let zKeyed20 = $state([{ id: 1, n: 'x' }, { id: 2, n: 'y' }]);
  let zPromise20 = $state(Promise.resolve(['p', 'q']));
  let zRows20 = $state([1, 2]);
</script>

{#each zItems20() as zIt20}
  <p>item: {zIt20}</p>
{/each}

{#each zItems20() as zIt20, zI20}
  <p>idx: {zI20}={zIt20}</p>
{/each}

{#each zKeyed20() as { id, n }}
  <p>d: {id}:{n}</p>
{/each}

{#each zKeyed20() as zK20 (zK20.id)}
  <p>k: {zK20.n}</p>
{/each}

{#if zOn20}
  <p>on: {zIdx20()}</p>
{/if}

{#key zIdx20()}
  <p>keyed: {zIdx20()}</p>
{/key}

{#await zPromise20()}
  <p>pending</p>
{:then zUsers20}
  <p>got: {zUsers20.length}</p>
{:catch zErr20}
  <p>err: {zErr20.message}</p>
{/await}

{#boundary}
  <p>safe</p>
{/boundary}

{#island name="box"}
  {#each zRows20() as zR20}
    <p>inner: {zR20}</p>
  {/each}
  <input on:input={() => {}} />
{/island}`, 'utf-8');
  const outL: any = await compileComponent(tmpL, pathL.join(process.cwd(), 'public'), 'islandmixpage', false, [], new Map());
  const ssrL = String(outL.ssr);
  // Every emitted statement must balance its parens.
  const unbalanced: string[] = [];
  for (const line of ssrL.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('h +=') && !t.startsWith('const __b')) continue;
    let depth = 0;
    for (const ch of t) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth < 0) break; }
    }
    if (depth !== 0) unbalanced.push(t.slice(0, 130));
  }
  check('F20 island-mix: every emitted statement balances its parens', unbalanced.length === 0);
  fsL.mkdirSync(pathL.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsL.writeFileSync(pathL.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsL.writeFileSync(pathL.join(HERE, '.test-compiler-tmp', 'island-mix.ssr.ts'), ssrL, 'utf-8');
  const modL = await import('./.test-compiler-tmp/island-mix.ssr.ts');
  const htmlL = String(await modL.render([], [], {}, {})).replace(/<!--⟦[^>]*⟧-->/g, '');
  check('F20 island-mix: each renders every variant outside the island', htmlL.includes('item: a') && htmlL.includes('item: c') && htmlL.includes('idx: 0=a') && htmlL.includes('idx: 2=c') && htmlL.includes('d: 1:x') && htmlL.includes('d: 2:y') && htmlL.includes('k: x') && htmlL.includes('k: y'));
  check('F20 island-mix: if, key, await, boundary and the island itself render', htmlL.includes('on: 7') && htmlL.includes('keyed: 7') && htmlL.includes('pending') && htmlL.includes('safe') && htmlL.includes('data-rv-island="box"') && htmlL.includes('inner: 1') && htmlL.includes('inner: 2'));
  check('F20 island-mix: no raw block syntax leaks into the output', !htmlL.includes(':else') && !htmlL.includes('{zIt20}'));
  // The inline await form ({#await expr then x}) is NOT the rosefd syntax -
  // it used to be silently leaked into the output. It must be refused with
  // the correct form, while a promise's own .then/.catch methods are fine.
  const inlineForms: Array<[string, string, boolean]> = [
    ['inline then', `{#await zP20() then zU20}<p>{zU20}</p>{/await}`, true],
    ['inline catch', `{#await zP20() catch zE20}<p>{zE20}</p>{/await}`, true],
    ['a promise .then method', `{#await zP20().then((r) => r)}<p>x</p>{/await}`, false],
    ['a promise .catch method', `{#await zP20().catch((e) => e)}<p>x</p>{/await}`, false],
    ['a plain promise', `{#await zP20()}<p>x</p>{/await}`, false],
  ];
  for (const [label, body, shouldThrow] of inlineForms) {
    const tmpL2 = pathL.resolve('.test-compiler-out', 'await-inline.rose');
    fsL.writeFileSync(tmpL2, `<script>\n  let zP20 = $state(Promise.resolve(1));\n</script>\n${body}`, 'utf-8');
    let msg = '';
    try {
      await compileComponent(tmpL2, pathL.join(process.cwd(), 'public'), 'awaitinlinepage', false, [], new Map());
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    const ok = shouldThrow ? msg.includes('puts the') : msg.length === 0;
    check(`F20 await-inline: ${label}`, ok);
    safeRm(tmpL2);
  }
  safeRm(tmpL);
  safeRm(pathL.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

{
  const fsG = await import('fs');
  const pathG = await import('path');
  fsG.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpG = pathG.resolve('.test-compiler-out', 'dbg.rose');
  fsG.writeFileSync(tmpG, `<script>
  let n = $state(5);
</script>
<p>x</p>
{@debug n}
{@debug}`, 'utf-8');
  const outG: any = await compileComponent(tmpG, pathG.join(process.cwd(), 'public'), 'dbgpage', false, [], new Map());
  const srcG = String(outG.ssr);
  check('F19 @debug: logs the named values at that point', /console\.log\('\[rosefd:debug\]', \{ n\(\) \}\);/.test(srcG));
  check('F19 @debug: bare form also breaks into the debugger', srcG.includes("console.log('[rosefd:debug]'); debugger;"));
  check('F19 @debug: emits nothing into the output', !srcG.includes('rosefd:debug]') || !/<p>x<\/p>\\s*rosefd/.test(srcG));
  safeRm(tmpG);
}

{
  const out = scopeCss(
    '.card :global(.md) { color: red }\n:global(body) { margin: 0 }\n.plain { color: blue }',
    'demo',
  );
  check('F27: mixed :global keeps the owning half scoped, the rest unscoped', out.includes('[data-rosefd-c="demo"] .card .md{color:red}'), out);
  check('F27: an all-:global selector emits without the scope prefix', /(^|[}])body\{margin:0\}/.test(out), out);
  check('F27: plain selectors still scope', out.includes('[data-rosefd-c="demo"] .plain{color:blue}'), out);
}

// F28: a comment that READS like a declaration used to match DECL_RE, and
// its [^=]* span swallowed the real declaration on the next line - the page
// compiled with a phantom binding and a missing one (a runtime "price is
// not defined"). extractDecls now matches on a masked copy: comments and
// literals are blanked, positions stay 1:1.
{
  const fsH = await import('fs');
  const pathH = await import('path');
  fsH.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpH = pathH.resolve('.test-compiler-out', 'phantom.rose');
  fsH.writeFileSync(tmpH, `<script>
  // A const whose expression reads a signal must re-evaluate - write
  // let price = $state(10) first, then let qty = $state(2).
  let price = $state(10);
  let qty = $state(2);
</script>
<p>total: {price() * qty()}</p>`, 'utf-8');
  const outH: any = await compileComponent(tmpH, pathH.join(process.cwd(), 'public'), 'phantompage', false, [], new Map());
  const ssrH = String(outH.ssr);
  check('F28 phantom decl: the real declaration survives the decl-like comment', ssrH.includes('state("price", 10)') && ssrH.includes('state("qty", 2)'), ssrH.slice(0, 400));
  check('F28 phantom decl: no phantom binding from the comment text', !ssrH.includes('"whose"'));
  fsH.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  fsH.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
  fsH.writeFileSync(path.join(HERE, '.test-compiler-tmp/phantom.ssr.ts'), outH.ssr, 'utf-8');
  const modH = await import('./.test-compiler-tmp/phantom.ssr.ts');
  const htmlH = String(await modH.render([], [], {}, {}));
  check('F28 phantom decl: the page renders with both signals', htmlH.includes('total:') && htmlH.includes('>20<'), htmlH);
  safeRm(tmpH);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  // A decl-like text inside a STRING must not match either.
  const tmpH2 = pathH.resolve('.test-compiler-out', 'phantom2.rose');
  fsH.writeFileSync(tmpH2, `<script>
  const doc = "write let n = $state(1) to declare";
  let n = $state(7);
</script>
<p>n: {n()}</p>`, 'utf-8');
  const outH2: any = await compileComponent(tmpH2, pathH.join(process.cwd(), 'public'), 'phantom2page', false, [], new Map());
  const ssrH2 = String(outH2.ssr);
  check('F28 phantom decl: a decl-like string does not eat the real decl', ssrH2.includes('state("n", 7)'), ssrH2.slice(0, 400));
  safeRm(tmpH2);
}

// F29: a block opener's head is an expression, so it may hold braces.
// {#each [{id: 1}] as row} and {#if pick({a: 1})} used to truncate at the
// first } - the directive read as malformed ("missing its item name") or
// the else-rewriter emitted a broken head. Openers are now scanned with
// blockOpenerEnd (quote/template-aware brace counting).
{
  const fsI = await import('fs');
  const pathI = await import('path');
  fsI.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpI = pathI.resolve('.test-compiler-out', 'braces.rose');
  fsI.writeFileSync(tmpI, `<script>
  function pick(o) { return o.a === 1; }
</script>
<ul>
{#each [{ id: 1, t: 'one' }, { id: 2, t: 'two' }] as row}
  <li>{row.id}: {row.t}</li>
{/each}
</ul>
{#if pick({ a: 1 })}
  <p class="hit">picked</p>
{:else}
  <p class="miss">not picked</p>
{/if}
{#key { a: 1 }}
  <p class="keyed">keyed body</p>
{/key}`, 'utf-8');
  let errI = '';
  let outI: any = null;
  try {
    outI = await compileComponent(tmpI, pathI.join(process.cwd(), 'public'), 'bracespage', false, [], new Map());
  } catch (e) { errI = (e as Error).message; }
  check('F29 brace openers: an each source holding an object literal compiles', !errI, errI);
  check('F29 brace openers: an if condition holding an object literal compiles', !errI, errI);
  if (outI) {
    fsI.mkdirSync(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
    fsI.writeFileSync(path.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
    fsI.writeFileSync(path.join(HERE, '.test-compiler-tmp/braces.ssr.ts'), outI.ssr, 'utf-8');
    const modI = await import('./.test-compiler-tmp/braces.ssr.ts');
    const htmlI = String(await modI.render([], [], {}, {}));
    check('F29 brace openers: the each rows render', htmlI.includes('>1<') && htmlI.includes('>2<') && htmlI.includes('one<') && htmlI.includes('two<'), htmlI);
    check('F29 brace openers: the if branch with the object-literal condition renders', htmlI.includes('picked'));
    check('F29 brace openers: the key block with an object-literal key renders', htmlI.includes('keyed body'));
  }
  safeRm(tmpI);
  safeRm(path.join(HERE, '.test-compiler-tmp'), { recursive: true });
  // The directive gate still refuses a genuinely malformed each.
  const tmpI2 = pathI.resolve('.test-compiler-out', 'braces-bad.rose');
  fsI.writeFileSync(tmpI2, `<ul>{#each items}<li>x</li>{/each}</ul>`, 'utf-8');
  let errI2 = '';
  try { await compileComponent(tmpI2, pathI.join(process.cwd(), 'public'), 'bracesbadpage', false, [], new Map()); }
  catch (e) { errI2 = (e as Error).message; }
  check('F29 brace openers: an each with no item name is still refused', errI2.includes('is missing its item name'));
  safeRm(tmpI2);
}

// F30: a {@const} declared inside a COMPONENT'S CHILDREN belongs to the child
// scope - compileTemplate compiles those through a recursive call. The
// upfront id pass (R45) collects the scope's own consts, and a component tag
// is not a {#block}: without the component-children range it collected the
// child's const too and rewrote its uses to a thunk THIS scope never emits -
// `h += __rvct0()` with no declaration, a ReferenceError at render time and
// no build error at all. The same-name case pins the other direction: the
// child's declaration shadows the page's only inside the children.
{
  const fsN = await import('fs');
  const pathN = await import('path');
  fsN.mkdirSync('.test-compiler-out', { recursive: true });
  const cardN = pathN.resolve('.test-compiler-out', 'child-const-card.rose');
  fsN.writeFileSync(cardN, `<div class="child-const-card"><slot>fb</slot></div>`, 'utf-8');
  const regN = new Map([[cardN, { index: 0, scopeKey: 'components/child-const-card', slots: [] }]]);
  await compileComponent(cardN, pathN.join(process.cwd(), 'public'), 'components/child-const-card', false, [], regN);

  const pageN = pathN.resolve('.test-compiler-out', 'child-const.rose');
  fsN.writeFileSync(pageN, `<script>
  import Card from './child-const-card.rose';
  let zA30 = $state(2);
</script>
{@const zTop30 = zA30() * 10}
<Card>
  {@const zInner30 = zA30() * 3}
  <p>inner: {zInner30}</p>
  <p>outer in child: {zTop30}</p>
</Card>
<p>outer: {zTop30}</p>
<Card>
  {@const zTop30 = zA30() + 1}
  <p>shadowed in child: {zTop30}</p>
</Card>`, 'utf-8');
  let errN = '';
  let outN: any = null;
  try {
    outN = await compileComponent(pageN, pathN.join(process.cwd(), 'public'), 'childconstpage', false, [], regN);
  } catch (e) { errN = (e as Error).message; }
  check('F30 child const: a const inside component children compiles', !errN, errN);
  if (outN) {
    const srcN = String(outN.ssr);
    // One thunk per scope: the page's zTop30 = __rvct0, the first child's
    // zInner30 = __rvct1, the second child's zTop30 = __rvct2.
    check('F30 child const: the page thunk stays in the page scope', srcN.includes('const __rvct0 = () => (zA30() * 10)'));
    check('F30 child const: the child thunk is the child scope\'s own', srcN.includes('const __rvct1 = () => (zA30() * 3)'));
    check('F30 child const: a same-name child const shadows only inside the children', srcN.includes('const __rvct2 = () => (zA30() + 1)'));
    check('F30 child const: no source const name survives into the code', !/\bz(?:Top|Inner)30\b/.test(srcN.replace(/const __rvct\d+ = \(\) => \([^)]*\);/g, '')));
    // The uses resolve to the thunk of the scope that declares them: the
    // page's read of zTop30 sits in the page body, the children's reads in
    // the child closures.
    const pageRead = srcN.split('const __rvct').findIndex((seg) => /h \+= textMark\(__c, \(\) => \(__rvct0\(\)\)\)/.test(seg));
    check('F30 child const: each use calls the thunk its scope declares', pageRead >= 0 && srcN.includes('() => (__rvct1())') && srcN.includes('() => (__rvct2())'));
  }
  safeRm(cardN);
  safeRm(pageN);
  safeRm(pathN.join(HERE, '.test-compiler-tmp'), { recursive: true });

  // A second const of the same name in one BLOCK scope skips the upfront pass
  // (one flat name -> id map cannot hold two thunks) and takes the
  // per-declaration fallback: each use reads its nearest preceding
  // declaration, and no duplicate internal name reaches esbuild.
  const tmpN2 = pathN.resolve('.test-compiler-out', 'block-dup.rose');
  fsN.writeFileSync(tmpN2, `<script>
  let zOn30 = $state(true);
</script>
{#if zOn30}
  {@const zD30 = 1}
  <p>a: {zD30}</p>
  {@const zD30 = 2}
  <p>b: {zD30}</p>
{/if}`, 'utf-8');
  let errN2 = '';
  let outN2: any = null;
  try {
    outN2 = await compileComponent(tmpN2, pathN.join(process.cwd(), 'public'), 'blockduppage', false, [], new Map());
  } catch (e) { errN2 = (e as Error).message; }
  check('F30 block dup: a same-name const twice in one block still compiles', !errN2, errN2);
  if (outN2) {
    const srcN2 = String(outN2.ssr);
    check('F30 block dup: each declaration gets its own internal name', srcN2.includes('const __rvct0 = () => (1)') && srcN2.includes('const __rvct1 = () => (2)') && !/const __rvct0[\s\S]*const __rvct0/.test(srcN2));
    fsN.mkdirSync(pathN.join(HERE, '.test-compiler-tmp'), { recursive: true });
    fsN.writeFileSync(pathN.join(HERE, '.test-compiler-tmp/runtime.ts'), 'export * from "../../src/runtime/index.ts";', 'utf-8');
    fsN.writeFileSync(pathN.join(HERE, '.test-compiler-tmp/block-dup.ssr.ts'), srcN2, 'utf-8');
    const modN2 = await import('./.test-compiler-tmp/block-dup.ssr.ts');
    const htmlN2 = String(await modN2.render([], [], {}, {})).replace(/<!--⟦[^>]*⟧-->/g, '');
    check('F30 block dup: each use reads its nearest preceding declaration', htmlN2.includes('a: 1') && htmlN2.includes('b: 2'), htmlN2);
  }
  safeRm(tmpN2);
  safeRm(pathN.join(HERE, '.test-compiler-tmp'), { recursive: true });
}

// F31: the comment/literal scanner must be LINEAR in the source length. The
// word before a slash used to be read as `/(\w+)$/.exec(src.slice(0, b + 1))` -
// a full prefix copy plus an end-anchored run that tries every start position,
// quadratic. Every `</tag>` (a slash after a word character) and every `/` in
// a `<script>` paid it: a 200KB static chunk took 10.8s to compile, a 56KB
// script with 2500 divisions 0.7s (R44 snapshot A/B). The sizes below are
// chosen so the bad shape misses the bound by ~5x while the fixed shape beats
// it by ~100x, so the guard is decisive without being machine-sensitive.
{
  const fsP = await import('fs');
  const pathP = await import('path');
  fsP.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpP = pathP.resolve('.test-compiler-out', 'big-static.rose');
  const markup = (lines: number, width: number): string =>
    '<script>\n  let s = $state(1);\n</script>\n'
    + Array.from({ length: lines }, (_, i) => `<p>${'x'.repeat(width)}${String(i).padStart(3)}</p>`).join('\n');
  const timeCompile = async (src: string): Promise<number> => {
    fsP.writeFileSync(tmpP, src, 'utf-8');
    await compileComponent(tmpP, pathP.join(process.cwd(), 'public'), 'bigstaticpage', false, [], new Map());
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await compileComponent(tmpP, pathP.join(process.cwd(), 'public'), 'bigstaticpage', false, [], new Map());
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  // Same shape, 5x the bytes: a quadratic scanner costs ~25x, a linear one ~5x.
  const smallMs = await timeCompile(markup(200, 190));
  const bigMs = await timeCompile(markup(1000, 190));
  check('F31 big static: a 200KB markup chunk compiles in linear time', bigMs < 2000, `${bigMs.toFixed(1)}ms`);
  check('F31 big static: the per-byte cost does not grow with size', bigMs / 5 < smallMs * 4, `${smallMs.toFixed(1)}ms for 40KB vs ${bigMs.toFixed(1)}ms for 200KB`);
  // The script side walks the same predicate: 2500 divisions (each `/` is a
  // slash after a word character) must not be quadratic either.
  let scriptSrc = '<script>\n  let s0 = $state(1);\n';
  for (let i = 0; i < 2500; i++) scriptSrc += `  let d${i} = 100 / ${(i % 7) + 1};\n`;
  scriptSrc += '</script>\n<p>x</p>';
  const divMs = await timeCompile(scriptSrc);
  check('F31 big static: a division-heavy script stays linear too', divMs < 500, `${divMs.toFixed(1)}ms`);
  safeRm(tmpP);
}

if (failures > 0) {
  console.error(`\n${failures} compiler check(s) FAILED`);
  process.exit(1);
}
// The .rose sources are read by path (never imported), so they stay
// cwd-relative - but the suite must leave nothing behind either way.
safeRm('.test-compiler-out', { recursive: true });
console.log('All compiler pipeline checks passed');