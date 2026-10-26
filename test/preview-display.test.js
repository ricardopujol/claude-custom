'use strict';
/**
 * app/preview-display.js (BACKLOG #119 A4): the Preview panel's frame and the Dev servers chip with its menu, as pure decisions and
 * HTML strings. renderer.js wires the clicks and the native view.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const d = require('../app/preview-display');

const dev = (inBlock = [], outside = [], extra = {}) => ({ ok: true, stale: false, base: 20000, inBlock, outside, at: 1, ...extra });
const row = (port, name = 'node', pid = 10) => ({ port, pid, name });

// ---- the chip -------------------------------------------------------------------------------------------------------------

test('chip: unknown until the first answer is hidden, not a zero', () => {
  assert.strictEqual(d.chipView(null).hidden, true);
  assert.strictEqual(d.chipView(undefined).hidden, true);
});

test('chip: a worktree with no block has nothing to count, so no chip', () => {
  assert.strictEqual(d.chipView(dev([], [], { base: null })).hidden, true);
});

test('chip: counts the listeners inside the block, and only those', () => {
  const v = d.chipView(dev([row(20001), row(20002)], [row(5173)]));
  assert.strictEqual(v.hidden, false);
  assert.strictEqual(v.text, '2');
  assert.strictEqual(v.state, 'on');
  assert.match(v.title, /2 .*20000-20099/);
});

test('chip: none listening reads 0 and idle', () => {
  const v = d.chipView(dev());
  assert.strictEqual(v.text, '0');
  assert.strictEqual(v.state, 'idle');
});

test('chip: an answer that is not known shows a dash and says so, never 0', () => {
  const v = d.chipView({ ok: false });
  assert.strictEqual(v.text, '—');
  assert.strictEqual(v.state, 'unknown');
  assert.match(v.title, /not known/i);
});

test('chip: a stale reading keeps its number and says it is old', () => {
  const v = d.chipView(dev([row(20001)], [], { stale: true }));
  assert.strictEqual(v.text, '1');
  assert.match(v.title, /old/i);
});

test('chip: one server reads in the singular', () => {
  assert.match(d.chipView(dev([row(20001)])).title, /1 dev server /);
  assert.match(d.chipView(dev([row(20001), row(20002)])).title, /2 dev servers /);
});

test('chip: garbage in, hidden out', () => {
  for (const v of [5, 'x', [], { ok: true }, { ok: true, base: 20000 }, { ok: true, base: 20000, inBlock: 'x' }]) assert.doesNotThrow(() => d.chipView(v));
  assert.strictEqual(d.chipView({ ok: true, base: 20000, inBlock: 'x' }).hidden, true);
});

// ---- the menu -------------------------------------------------------------------------------------------------------------

test('menu: a row per listener, "port · process name", with both actions', () => {
  const html = d.menuHtml(dev([row(20001, 'node'), row(20007, 'python')]));
  assert.match(html, /20001 · node/);
  assert.match(html, /20007 · python/);
  assert.strictEqual((html.match(/data-dev-act="preview"/g) || []).length, 2);
  assert.strictEqual((html.match(/data-dev-act="browser"/g) || []).length, 2);
  assert.match(html, /data-dev-port="20001"/);
});

test('menu: ports outside the block are listed after, dimmed and labelled', () => {
  const html = d.menuHtml(dev([row(20001)], [row(5173, 'vite')]));
  assert.ok(html.indexOf('20001') < html.indexOf('5173'));
  assert.match(html, /class="dv-row dv-outside"[^>]*>[\s\S]*5173 · vite/);
  assert.match(html, /\(outside this worktree's block\)/);
});

test('menu: nothing listening says where servers should go', () => {
  const html = d.menuHtml(dev());
  assert.match(html, /Nothing is listening/);
  assert.match(html, /20000/);
  assert.doesNotMatch(html, /data-dev-act/);
});

test('menu: an unknown answer says so and offers no rows', () => {
  const html = d.menuHtml({ ok: false });
  assert.match(html, /couldn't be read/i);
  assert.doesNotMatch(html, /data-dev-act/);
});

test('menu: a process name is somebody else\'s string and is escaped', () => {
  const html = d.menuHtml(dev([row(20001, '<img src=x onerror=alert(1)>')]));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('property: no menu or panel HTML ever carries a raw tag from a process name or a page address', () => {
  fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (name, url) => {
    const m = d.menuHtml(dev([row(20001, name)], [row(5173, name)]));
    const p = d.html(d.view({ ...d.emptyState(), url: `http://localhost:1/${url}`, note: { text: name, bad: true }, dev: dev([row(20001, name)]) }));
    const stripped = (h) => h.replace(/<\/?(div|span|button|select|option|input|ul|li|p|b|svg|path|rect|line|circle)\b[^<>]*>/g, '');
    return !/<[a-zA-Z!/]/.test(stripped(m)) && !/<[a-zA-Z!/]/.test(stripped(p));
  }), { numRuns: 300 });
});

test('actionOf (chip menu): a strict port and one of the two actions', () => {
  assert.deepStrictEqual(d.devActionOf({ devAct: 'preview', devPort: '20001' }), { act: 'preview', port: 20001 });
  assert.deepStrictEqual(d.devActionOf({ devAct: 'browser', devPort: '65535' }), { act: 'browser', port: 65535 });
  for (const bad of [null, {}, { devAct: 'preview' }, { devAct: 'preview', devPort: '0' }, { devAct: 'preview', devPort: '65536' }, { devAct: 'preview', devPort: '1e3' },
    { devAct: 'preview', devPort: ' 80' }, { devAct: 'preview', devPort: '08' }, { devAct: 'kill', devPort: '3000' }, { devAct: 'preview', devPort: '-5' }]) {
    assert.strictEqual(d.devActionOf(bad), null, JSON.stringify(bad));
  }
});

// ---- the panel ------------------------------------------------------------------------------------------------------------

test('panel: with no address it explains itself and has no slot', () => {
  const v = d.view(d.emptyState());
  assert.strictEqual(v.empty, true);
  const html = d.html(v);
  assert.match(html, /pv-empty/);
  assert.doesNotMatch(html, /id="preview-slot"/);
  assert.match(html, /localhost/);
});

test('panel: with an address there is a slot for the native view, and the field shows the address', () => {
  const v = d.view(d.withEvent(d.emptyState(), { kind: 'url', url: 'http://localhost:20001/a' }));
  assert.strictEqual(v.empty, false);
  const html = d.html(v);
  assert.match(html, /id="preview-slot"/);
  assert.match(html, /value="localhost:20001\/a"/);
});

test('panel: a blocked line shows on the header and clears when a page loads', () => {
  let s = d.withEvent(d.emptyState(), { kind: 'blocked', text: 'blocked: example.com' });
  assert.match(d.html(d.view(s)), /blocked: example\.com/);
  assert.strictEqual(d.view(s).noteBad, true);
  s = d.withEvent(s, { kind: 'url', url: 'http://localhost:20001/' });
  assert.strictEqual(d.view(s).note, null);
});

test('panel: a failed load shows its text', () => {
  const s = d.withEvent(d.emptyState(), { kind: 'failed', text: "couldn't load the page: ERR_CONNECTION_REFUSED" });
  assert.match(d.html(d.view(s)), /ERR_CONNECTION_REFUSED/);
});

test('panel: events that are not events change nothing', () => {
  const s = d.emptyState();
  for (const ev of [null, undefined, 5, {}, { kind: 'url' }, { kind: 'url', url: 5 }, { kind: 'blocked' }, { kind: 'zzz' }]) assert.deepStrictEqual(d.withEvent(s, ev), s, JSON.stringify(ev));
});

test('panel: the picker lists the block\'s ports first and the outside ones after, and selects the one the page is on', () => {
  const s = d.withDev(d.withEvent(d.emptyState(), { kind: 'url', url: 'http://localhost:20002/x' }), dev([row(20001), row(20002, 'python')], [row(5173, 'vite')]));
  const v = d.view(s);
  assert.deepStrictEqual(v.picker.map(p => p.value), ['20001', '20002', '5173']);
  assert.strictEqual(v.pickerValue, '20002');
  const html = d.html(v);
  assert.match(html, /<option value="20002" selected>/);
  assert.match(html, /outside/);
});

test('panel: a page on a port that is not in the list selects nothing', () => {
  const s = d.withDev(d.withEvent(d.emptyState(), { kind: 'url', url: 'http://localhost:9999/' }), dev([row(20001)]));
  assert.strictEqual(d.view(s).pickerValue, '');
});

test('panel: with no servers the picker says so', () => {
  const v = d.view(d.withDev(d.emptyState(), dev()));
  assert.match(d.html(v), /no servers/i);
});

test('panel: every control carries a strict action name', () => {
  const html = d.html(d.view(d.withEvent(d.emptyState(), { kind: 'url', url: 'http://localhost:20001/' })));
  for (const act of ['go', 'reload', 'browser', 'devtools']) assert.match(html, new RegExp(`data-preview-act="${act}"`));
});

test('actionOf (panel): only the four known actions', () => {
  for (const a of ['go', 'reload', 'browser', 'devtools']) assert.deepStrictEqual(d.actionOf({ previewAct: a }), { act: a });
  for (const bad of [null, undefined, {}, { previewAct: 'rm' }, { previewAct: '' }, 'go']) assert.strictEqual(d.actionOf(bad), null);
});

test('wantsView: a native view is wanted only once there is an address to show', () => {
  assert.strictEqual(d.wantsView(d.emptyState()), false);
  assert.strictEqual(d.wantsView(d.withEvent(d.emptyState(), { kind: 'url', url: 'http://localhost:20001/' })), true);
});

test('the typed field: what a page address looks like in it (no trailing slash noise on a bare origin)', () => {
  assert.strictEqual(d.fieldText('http://localhost:20001/'), 'localhost:20001');
  assert.strictEqual(d.fieldText('http://localhost:20001/a?b=1#c'), 'localhost:20001/a?b=1#c');
  assert.strictEqual(d.fieldText(null), '');
  assert.strictEqual(d.fieldText('https://example.com/'), 'https://example.com/', 'anything unfamiliar is shown whole');
});

test('the copy of the block size in the page script is the host\'s', () => {
  assert.strictEqual(d.BLOCK, require('../host/port-blocks').BLOCK);
});

test('the chip icon is one-colour line art: inline, currentColor, no fill, round, nothing fetched, hidden from a screen reader', () => {
  const svg = d.serverIcon();
  assert.match(svg, /^<svg class="dv-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">/);
  assert.ok(svg.endsWith('</svg>'));
  assert.strictEqual((svg.match(/<svg/g) || []).length, 1);
  assert.ok(!/https?:|href|<image|<script|\son\w+=|style=/i.test(svg));
});
