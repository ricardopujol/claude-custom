'use strict';
/**
 * The Markdown reader's sanitizing pipeline (build/markdown-render.mjs) driven with a jsdom window, so the security
 * claim is checked here and not only by the Electron probe (PR #204 Miguel Y1). Covers the hostile page HTML, the
 * links, a diagram's SVG (Miguel B1: Mermaid's `click A "https://..."` becomes an <a xlink:href> that navigated the
 * tab), and the instance isolation (Y2: Mermaid hooks the shared DOMPurify and never unhooks it).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { JSDOM } = require('jsdom');

let mod;
const load = async () => { if (!mod) mod = await import('../build/markdown-render.mjs'); return mod; };
const make = async () => {
  const { createRenderer } = await load();
  const win = new JSDOM('<!doctype html><body></body>').window;
  return { win, r: createRenderer(win), html: (frag) => { const d = win.document.createElement('div'); d.append(frag); return d.innerHTML; }, doc: win.document };
};
const FROM = 'docs/guide.md';

const HOSTILE = [
  '# Title <script>window.__x = 1</script>',
  '',
  '<img src="x" onerror="window.__x = 2">',
  '<iframe src="https://example.com"></iframe>',
  '<div style="position:fixed;inset:0" id="reader" onclick="window.__x = 3" name="n">raw div</div>',
  '<a href="javascript:window.__x = 4" target="_blank" rel="x" ping="https://e/">js</a>',
  '<form action="https://e/"><button formaction="https://e/">go</button><input type="text" name="q"></form>',
  '<style>body { display: none }</style>',
  '<svg onload="window.__x = 5"><script>1</script><a xlink:href="https://e/"><text>t</text></a></svg>',
  '<math><mi xlink:href="javascript:1">x</mi></math>',
  '<object data="x"></object><embed src="x"><link rel="stylesheet" href="https://e/c.css"><meta http-equiv="refresh" content="0;url=https://e/">',
  '',
  '[sibling](other.md) [web](https://example.com/a) [mail](mailto:a@b.c) [bad](javascript:alert(1)) [out](../../x.md) [anchor](#title)',
  '',
  '![alt text](pic.png)',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
].join('\n');

test('hostile page HTML: nothing executable, loadable or navigable survives', async () => {
  const { r, html, doc } = await make();
  const frag = r.pageFragment(HOSTILE, { fromFile: FROM });
  const out = html(frag);
  const box = doc.createElement('div');
  box.innerHTML = out;
  for (const sel of ['script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'style', 'form', 'button', 'svg', 'math', 'img', 'textarea', 'select']) {
    assert.strictEqual(box.querySelectorAll(sel).length, 0, `no <${sel}>`);
  }
  for (const el of box.querySelectorAll('*')) {
    for (const at of el.attributes) {
      assert.ok(!/^on/i.test(at.name), `${el.localName} has ${at.name}`);
      assert.ok(!['style', 'id', 'name', 'target', 'ping', 'href', 'src', 'srcset', 'action', 'formaction'].includes(at.name), `${el.localName} keeps ${at.name}`);
      assert.ok(!/javascript:/i.test(at.value), `${at.name}=${at.value}`);
    }
  }
  assert.ok(!/__x/.test(out) || !/<script/i.test(out));
  assert.strictEqual(box.querySelectorAll('input').length, 2, 'only the two task boxes remain');
  assert.ok([...box.querySelectorAll('input')].every((i) => i.type === 'checkbox' && i.hasAttribute('disabled')));
  assert.match(out, /\[image: alt text\]/);
});

test('page links: classified, href-less, and a hostile one is inert', async () => {
  const { r, doc } = await make();
  const frag = r.pageFragment(HOSTILE, { fromFile: FROM });
  const as = [...frag.querySelectorAll('a')];
  const kinds = Object.fromEntries(as.map((a) => [a.textContent, `${a.getAttribute('data-md-kind')}:${a.getAttribute('data-md-target')}`]));
  assert.strictEqual(kinds.sibling, 'file:docs/other.md');
  assert.strictEqual(kinds.web, 'http:https://example.com/a');
  assert.strictEqual(kinds.mail, 'inert:null');
  assert.strictEqual(kinds.bad, 'inert:null');
  assert.strictEqual(kinds.js, 'inert:null');
  assert.strictEqual(kinds.out, 'inert:null');
  assert.strictEqual(kinds.anchor, 'anchor:title');
  assert.ok(as.every((a) => !a.hasAttribute('href') && !a.hasAttribute('target')));
  void doc;
});

test('headings get data anchors (never ids), tables get a scrolling wrapper, fences keep only their language class', async () => {
  const { r } = await make();
  const frag = r.pageFragment('# A b\n\n# A b\n\n| x |\n|---|\n| 1 |\n\n```mermaid\ngraph TD\n```\n\n```js\n1\n```\n', { fromFile: FROM });
  assert.deepStrictEqual([...frag.querySelectorAll('h1')].map((h) => h.getAttribute('data-md-anchor')), ['a-b', 'a-b-1']);
  assert.ok(![...frag.querySelectorAll('*')].some((e) => e.hasAttribute('id')));
  assert.strictEqual(frag.querySelector('.md-table > table') !== null, true);
  assert.deepStrictEqual([...frag.querySelectorAll('pre > code')].map((c) => c.getAttribute('class')), ['language-mermaid', 'language-js']);
});

const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="d1"><g>${inner}</g></svg>`;

test('B1: a diagram link cannot navigate: the SVG <a> loses its href and is classified like a page link', async () => {
  const { r } = await make();
  const frag = r.diagramFragment(svg([
    '<a xlink:href="https://example.com/x" target="_self"><text>web</text></a>',
    '<a href="https://example.com/y"><text>web2</text></a>',
    '<a xlink:href="javascript:window.__x=1"><text>js</text></a>',
    '<a xlink:href="../README.md"><text>file</text></a>',
    '<a xlink:href="#sec"><text>anchor</text></a>',
    '<a xlink:href="file:///C:/Windows/win.ini"><text>local</text></a>',
    '<a xlink:href="mailto:a@b.c"><text>mail</text></a>',
  ].join('')), { fromFile: FROM });
  const as = [...frag.querySelectorAll('a')];
  assert.strictEqual(as.length, 7);
  const kinds = Object.fromEntries(as.map((a) => [a.textContent, `${a.getAttribute('data-md-kind')}:${a.getAttribute('data-md-target')}`]));
  assert.deepStrictEqual(kinds, {
    web: 'http:https://example.com/x', web2: 'http:https://example.com/y', js: 'inert:null', file: 'file:README.md',
    anchor: 'anchor:sec', local: 'inert:null', mail: 'inert:null',
  });
  for (const el of frag.querySelectorAll('*')) {
    for (const at of el.attributes) {
      assert.ok(!/href$/i.test(at.name) && at.name !== 'target', `${el.localName} still has ${at.name}`);
    }
  }
});

test('a diagram loses <use>, <image> sources, scripts, handlers and foreign content', async () => {
  const { r, html } = await make();
  const frag = r.diagramFragment(svg([
    '<use href="#marker"/><use xlink:href="https://evil.example/s.svg#m"/><image href="https://evil.example/p.png"/>',
    '<script>window.__x=1</script><rect onclick="window.__x=2" width="1" height="1"/><g onload="1"></g>',
    '<foreignObject><iframe src="https://e/"></iframe></foreignObject>',
  ].join('')), { fromFile: FROM });
  const out = html(frag);
  assert.doesNotMatch(out, /evil\.example|<script|onclick|onload|iframe|<use|href/i);
});

test('Y2: the page is sanitized by its own DOMPurify, whatever a diagram installs on the shared one', async () => {
  const { createRenderer } = await load();
  const createDOMPurify = (await import('dompurify')).default;
  const win = new JSDOM('<!doctype html><body></body>').window;
  const mine = createRenderer(win);
  const shared = createDOMPurify(win);                       // what Mermaid's import is
  const asText = (frag) => { const d = win.document.createElement('div'); d.append(frag); return d.innerHTML; };
  const before = asText(mine.pageFragment(HOSTILE, { fromFile: FROM }));
  // what Mermaid does on its first diagram: hooks on the shared instance that are never removed
  const seen = new Map();
  shared.addHook('beforeSanitizeAttributes', (n) => { if (n.tagName === 'A' && n.hasAttribute('target')) seen.set(n, n.getAttribute('target')); });
  shared.addHook('afterSanitizeAttributes', (n) => { if (seen.has(n)) n.setAttribute('target', seen.get(n)); });
  shared.sanitize(svg('<a xlink:href="https://e/" target="_blank"><text>t</text></a>'), { USE_PROFILES: { svg: true } });
  const after = asText(mine.pageFragment(HOSTILE, { fromFile: FROM }));
  assert.strictEqual(after, before, 'the second page is sanitized exactly as the first');
  assert.notStrictEqual(mine.purify, shared);
});

test('PROPERTY: whatever HTML is mixed into a page, the tidied fragment holds nothing executable or navigable', async () => {
  const { r } = await make();
  const bits = ['<script>1</script>', '<img src=x onerror=1>', '<a href="javascript:1">a</a>', '<a href="https://example.com">b</a>', '<iframe src=x></iframe>',
    '<svg onload=1><a xlink:href="https://e/">x</a></svg>', '<div id=reader style="position:fixed">d</div>', '[l](other.md)', '[m](mailto:a@b)', '![i](p.png)',
    '<form action=x><input name=q></form>', '<details open ontoggle=1>t</details>', '<math><mi>x</mi></math>', '<base href="https://e/">', 'text', '\n\n', '# h', '`c`'];
  fc.assert(fc.property(fc.array(fc.constantFrom(...bits), { maxLength: 12 }), (parts) => {
    const frag = r.pageFragment(parts.join(' '), { fromFile: FROM });
    for (const el of frag.querySelectorAll('*')) {
      assert.ok(!['script', 'iframe', 'object', 'embed', 'form', 'style', 'svg', 'math', 'img', 'base', 'link', 'meta'].includes(el.localName), el.localName);
      for (const at of el.attributes) {
        assert.ok(!/^on/i.test(at.name) && !['href', 'src', 'id', 'style', 'target', 'action', 'name'].includes(at.name.toLowerCase()), `${el.localName}[${at.name}]`);
      }
    }
  }), { numRuns: 200 });
});
