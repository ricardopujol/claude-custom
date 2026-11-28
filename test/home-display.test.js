'use strict';
/**
 * app/home-display.js: Jiandu Home's page (plan documentation/PLAN_PROJECT_HUB.md H-PR2). Pure strings and a click resolver; the page
 * wiring runs in jsdom here and in a real window in verify/probe-home.js (the one-global-scope trap is only seen there).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const D = require('../app/home-display');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const card = (over = {}) => ({
  key: 'c:\\p\\viral', root: 'C:\\p\\viral', label: 'viral', pinned: false, state: 'closed', tabs: null, needs: 0, sessions: null,
  lastUsed: NOW - 5 * 60_000, lanes: [], actions: ['open', 'pin', 'show-in-explorer', 'remove'], ...over,
});
const payload = (cards, over = {}) => ({ cards, summary: { open: 0, needs: 0, total: cards.length, shown: cards.length }, filter: '', empty: null, now: NOW, ...over });

test('a closed card: its name, folder, "closed", the time it was used, and its buttons in words', () => {
  const html = D.cardsHtml(payload([card()]));
  assert.match(html, /data-key="c:\\p\\viral"/);
  assert.match(html, />viral</);
  assert.match(html, />C:\\p\\viral</);
  assert.match(html, /closed/);
  assert.match(html, /used 5 min ago/);
  for (const label of ['Open', 'Pin', 'Show in Explorer', 'Remove from the list']) assert.match(html, new RegExp(`>${label}<`));
  assert.doesNotMatch(html, /Go to window|Close window/);
});

test('an open card: tabs and needs, Go to window and Close window (its tip says the sessions keep running), lanes with their cue', () => {
  const html = D.cardsHtml(payload([card({ state: 'open', tabs: 3, needs: 1, actions: ['go-to', 'close-window', 'unpin', 'show-in-explorer'], pinned: true,
    lanes: [{ key: 'k1', label: 'dev', path: 'C:\\p\\viral\\dev', needs: false }, { key: 'k2', label: 'feat-x', path: 'C:\\p\\viral\\feat-x', needs: true }] })]));
  assert.match(html, /open · 3 tabs · needs you/);
  assert.match(html, /class="card open needs pinned"/);
  assert.match(html, />Go to window</);
  assert.match(html, /title="Closes the window\. Its sessions keep running in the tray\."[^>]*>Close window</);
  assert.match(html, />Unpin</);
  assert.match(html, /data-act="lane" data-lane="C:\\p\\viral\\feat-x"[^>]*class="lane needs"/);
});

test('a windowless card: its session count and no window', () => {
  assert.match(D.cardsHtml(payload([card({ state: 'windowless', sessions: 2, actions: ['open', 'pin', 'show-in-explorer'] })])), /2 sessions, no window/);
  assert.match(D.cardsHtml(payload([card({ state: 'windowless', sessions: 1, actions: ['open'] })])), /1 session, no window/);
});

test('every string from a card is escaped (a folder may be named anything)', () => {
  const html = D.cardsHtml(payload([card({ label: '<img src=x onerror=alert(1)>', root: 'C:\\"a&b\'', lanes: [{ key: 'k', label: '<b>', path: 'C:\\<b>', needs: false }] })]));
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /C:\\&quot;a&amp;b&#39;/);
});

test('the times: just now, minutes, hours, days, and nothing when there is no time (never "0")', () => {
  assert.strictEqual(D.usedText(NOW - 20_000, NOW), 'used just now');
  assert.strictEqual(D.usedText(NOW - 59 * 60_000, NOW), 'used 59 min ago');
  assert.strictEqual(D.usedText(NOW - 3 * 3_600_000, NOW), 'used 3 h ago');
  assert.strictEqual(D.usedText(NOW - 2 * 86_400_000, NOW), 'used 2 days ago');
  assert.strictEqual(D.usedText(NOW - 86_400_000, NOW), 'used 1 day ago');
  for (const bad of [null, 0, '5', NaN, undefined]) assert.strictEqual(D.usedText(bad, NOW), '', String(bad));
  assert.strictEqual(D.usedText(NOW + 60_000, NOW), 'used just now', 'a clock a little ahead is not "in the future"');
});

test('the summary line: "N open · N need you", the needs part only when some card needs you', () => {
  assert.strictEqual(D.summaryText({ open: 2, needs: 0, total: 5, shown: 5 }), '2 open');
  assert.strictEqual(D.summaryText({ open: 2, needs: 1, total: 5, shown: 5 }), '2 open · 1 needs you');
  assert.strictEqual(D.summaryText({ open: 0, needs: 3, total: 5, shown: 5 }), '0 open · 3 need you');
  assert.strictEqual(D.summaryText(null), '');
});

test('the empty state is the payload\'s line, escaped', () => {
  assert.match(D.cardsHtml(payload([], { empty: 'No project matches "<x>".' })), /class="empty">No project matches &quot;&lt;x&gt;&quot;\.</);
});

test('clickTarget: a button names its action and card; a lane its path; anything else is nothing', () => {
  const dom = new JSDOM(`<div id="cards">${D.cardsHtml(payload([card({ state: 'open', actions: ['go-to'], lanes: [{ key: 'k', label: 'dev', path: 'C:\\p\\viral\\dev', needs: false }] })]))}</div>`);
  const doc = dom.window.document;
  assert.deepStrictEqual(D.clickTarget(doc.querySelector('[data-act="go-to"]')), { action: 'go-to', key: 'c:\\p\\viral' });
  assert.deepStrictEqual(D.clickTarget(doc.querySelector('[data-act="lane"]')), { action: 'lane', key: 'c:\\p\\viral', lane: 'C:\\p\\viral\\dev' });
  assert.strictEqual(D.clickTarget(doc.querySelector('.label')), null);
  assert.strictEqual(D.clickTarget(null), null);
});

test('the page: home.html loads the display in a strict CSP, the display is wrapped in an IIFE and leaves ONE name', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'home.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"/);
  assert.match(html, /<script src="home-display\.js"><\/script>/);
  assert.match(html, /Home stays open\. Closing it leaves every project window as it is\./);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'home-display.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const before = new Set(Object.keys(dom.window));
  dom.window.eval(src);
  const leaked = Object.keys(dom.window).filter((k) => !before.has(k));
  assert.deepStrictEqual(leaked, ['homeDisplay']);
});

function livePage(answer = () => ({ ok: true })) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'home.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const acts = [];
  const page = { dom, acts, onModel: null };
  // copied through JSON: an object made in the page's realm is not deepStrictEqual to one made here. act is an invoke (Miguel Y3).
  // The bridge is set AFTER the script ran: with it there, the script also starts itself at DOMContentLoaded (the real page's path),
  // and this test would hold two pages.
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'app', 'home-display.js'), 'utf8'));
  dom.window.home = { onModel: (fn) => { page.onModel = fn; }, act: (m) => { acts.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(answer(m)); } };
  dom.window.homeDisplay.start(dom.window.document, dom.window.home);
  return page;
}
const settle = () => new Promise((r) => setImmediate(r));

test('PR #263 Miguel Y3: "removed" shows only after main answers ok; a refused pin or remove says it was not done', async () => {
  const p = livePage((m) => (m.action === 'open' ? { ok: true } : { ok: false, error: 'the record was not written' }));
  const doc = p.dom.window.document;
  p.onModel(payload([card({ key: 'k2', root: 'C:\\q', label: 'q', actions: ['open', 'pin', 'remove'] })]));
  doc.querySelector('[data-act="remove"]').click();
  assert.strictEqual(doc.getElementById('notice').textContent, '', 'nothing said before the answer');
  await settle();
  assert.strictEqual(doc.getElementById('notice').textContent, 'q was not removed: the record was not written.');
  doc.querySelector('[data-act="pin"]').click();
  await settle();
  assert.strictEqual(doc.getElementById('notice').textContent, 'q was not pinned: the record was not written.');
  doc.querySelector('[data-act="open"]').click();
  await settle();
  assert.strictEqual(doc.getElementById('notice').textContent, '');
});

test('PR #263 Dexter 1: the first payload sets the filter box to main\'s filter, so the page and main agree', () => {
  const p = livePage();
  const doc = p.dom.window.document;
  p.onModel(payload([card()], { filter: 'vi' }));
  assert.strictEqual(doc.getElementById('filter').value, 'vi');
  doc.getElementById('filter').value = 'vir';
  p.onModel(payload([card()], { filter: 'vi' }));
  assert.strictEqual(doc.getElementById('filter').value, 'vir', 'a later push never fights the typing');
});

test('the page wiring: a push draws the cards and the summary; a click acts; typing filters; a remove says the folder is not touched', async () => {
  const p = livePage();
  const { acts } = p;
  const onModel = (x) => p.onModel(x);
  const doc = p.dom.window.document;
  const dom = p.dom;
  onModel(payload([card(), card({ key: 'k2', root: 'C:\\q', label: 'q' })], { summary: { open: 1, needs: 0, total: 2, shown: 2 } }));
  assert.strictEqual(doc.querySelectorAll('.card').length, 2);
  assert.strictEqual(doc.getElementById('summary').textContent, '1 open');
  doc.querySelector('[data-key="k2"] [data-act="open"]').click();
  assert.deepStrictEqual(acts.pop(), { action: 'open', key: 'k2' });
  const box = doc.getElementById('filter');
  box.value = 'vir';
  box.dispatchEvent(new dom.window.Event('input'));
  assert.deepStrictEqual(acts.pop(), { action: 'filter', text: 'vir' });
  doc.getElementById('choose').click();
  assert.deepStrictEqual(acts.pop(), { action: 'choose-folder' });
  doc.querySelector('[data-key="k2"] [data-act="remove"]').click();
  assert.deepStrictEqual(acts.pop(), { action: 'remove', key: 'k2' });
  await settle();
  assert.strictEqual(doc.getElementById('notice').textContent, 'q removed from the list. Its folder is not touched.');
});

// ---- H-PR3: Stop its sessions (H8, the card asks) and New lane -----------------------------------------------------------------

const windowless = (over = {}) => card({ key: 'kw', root: 'C:\\w', label: 'viral', state: 'windowless', sessions: 2,
  actions: ['open', 'stop-sessions', 'pin', 'show-in-explorer', 'new-lane'], ...over });
const noteOf = (doc, key) => { const n = doc.querySelector(`[data-key="${key}"] .card-note`); return n ? n.textContent : null; };

// main's side of H8 in a page test: the ask answers a token and a count; the stop answers in turn from `stops`
function stopPage({ count = 2, stops = [], askAnswer = null } = {}) {
  return livePage((m) => {
    if (m.action === 'stop-ask') return askAnswer || { ok: true, token: `tok-${m.key}`, count };
    if (m.action === 'stop-sessions') return stops.shift();
    return { ok: true };
  });
}

test('H8: Stop its sessions asks MAIN first, then the card asks "Stop 2 sessions in viral? Stop / Cancel"; Cancel stops nothing', async () => {
  const p = stopPage({ count: 2 });
  const doc = p.dom.window.document;
  p.onModel(payload([windowless({ sessions: 5 })]));
  doc.querySelector('[data-act="stop-sessions"]').click();
  assert.deepStrictEqual(p.acts, [{ action: 'stop-ask', key: 'kw' }], 'the first click only asks; nothing stops');
  await settle();
  const ask = doc.querySelector('[data-key="kw"] .confirm');
  assert.ok(ask, 'the question is on the card');
  assert.strictEqual(ask.querySelector('.question').textContent, 'Stop 2 sessions in viral?', 'main\'s number, not the card\'s older 5');
  assert.deepStrictEqual([...ask.querySelectorAll('button')].map((b) => b.textContent), ['Stop', 'Cancel']);
  assert.strictEqual(doc.querySelector('[data-key="kw"] [data-act="stop-sessions"]'), null, 'the actions give way to the question');
  p.onModel(payload([windowless()]));
  assert.ok(doc.querySelector('[data-key="kw"] .confirm'), 'a push while asking keeps the question');
  doc.querySelector('[data-act="stop-cancel"]').click();
  assert.strictEqual(doc.querySelector('[data-key="kw"] .confirm'), null);
  assert.deepStrictEqual(p.acts, [{ action: 'stop-ask', key: 'kw' }]);
  const one = stopPage({ count: 1 });
  one.onModel(payload([windowless({ label: 'q<b>' })]));
  one.dom.window.document.querySelector('[data-act="stop-sessions"]').click();
  await settle();
  assert.strictEqual(one.dom.window.document.querySelector('.confirm .question').textContent, 'Stop 1 session in q<b>?', 'one session, and the name escaped');
});

test('H8: an ask main refused shows no question, and says why', async () => {
  const p = stopPage({ askAnswer: { ok: false, error: 'no session of this project runs with no window now' } });
  const doc = p.dom.window.document;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="stop-sessions"]').click();
  await settle();
  assert.strictEqual(doc.querySelector('.confirm'), null);
  assert.strictEqual(noteOf(doc, 'kw'), 'The sessions were not stopped: no session of this project runs with no window now.');
});

test('H8: Stop sends the question\'s token, then the card says how many stopped; a refused stop says why', async () => {
  const p = stopPage({ count: 2, stops: [{ ok: true, asked: 2, stopped: 2, kept: 0 },
    { ok: false, asked: 2, stopped: 1, kept: 1, error: 'Couldn\'t stop that session: it has a window open.' },
    { ok: false, asked: 0, stopped: 0, kept: 0, error: 'powershell failed' }] });
  const doc = p.dom.window.document;
  const stopOnce = async () => {
    p.onModel(payload([windowless()]));
    doc.querySelector('[data-act="stop-sessions"]').click();
    await settle();
    doc.querySelector('[data-act="stop-confirm"]').click();
    assert.strictEqual(noteOf(doc, 'kw'), 'Stopping 2 sessions…');
    await settle();
    return noteOf(doc, 'kw');
  };
  assert.strictEqual(await stopOnce(), 'Stopped 2 sessions.');
  assert.deepStrictEqual(p.acts.pop(), { action: 'stop-sessions', key: 'kw', token: 'tok-kw' });
  assert.strictEqual(await stopOnce(), 'Stopped 1 of 2 sessions. Couldn\'t stop that session: it has a window open.');
  assert.strictEqual(await stopOnce(), 'The sessions were not stopped: powershell failed.');
  p.onModel(payload([windowless({ state: 'closed', sessions: null, actions: ['open'] })]));
  assert.strictEqual(noteOf(doc, 'kw'), 'The sessions were not stopped: powershell failed.', 'the note stays on the card after the push');
});

test('New lane: a form on the card (a type prefix and a name); Create sends prefix + name; the card says it opened', async () => {
  const p = livePage((m) => (m.action === 'new-lane' ? { ok: true, branch: m.branch } : { ok: true }));
  const doc = p.dom.window.document;
  const win = p.dom.window;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="new-lane"]').click();
  const form = doc.querySelector('[data-key="kw"] .lane-form');
  assert.ok(form, 'the form is on the card');
  const prefix = form.querySelector('select[data-field="prefix"]');
  assert.deepStrictEqual([...prefix.options].map((o) => o.value), ['feat/', 'fix/', 'spike/', 'chore/', 'docs/', 'refactor/', 'test/']);
  assert.deepStrictEqual(p.acts, []);
  prefix.value = 'fix/';
  prefix.dispatchEvent(new win.Event('change', { bubbles: true }));
  const name = doc.querySelector('[data-key="kw"] input[data-field="name"]');
  name.value = 'crash-on-open';
  name.dispatchEvent(new win.Event('input', { bubbles: true }));
  p.onModel(payload([windowless()]));
  assert.strictEqual(doc.querySelector('[data-key="kw"] input[data-field="name"]').value, 'crash-on-open', 'a push while typing keeps the name');
  assert.strictEqual(doc.querySelector('[data-key="kw"] select[data-field="prefix"]').value, 'fix/');
  doc.querySelector('[data-act="lane-create"]').click();
  assert.deepStrictEqual(p.acts.pop(), { action: 'new-lane', key: 'kw', branch: 'fix/crash-on-open' });
  assert.strictEqual(noteOf(doc, 'kw'), 'Creating fix/crash-on-open… Its window shows the progress.');
  await settle();
  assert.strictEqual(noteOf(doc, 'kw'), 'fix/crash-on-open opened in its window.');
  assert.strictEqual(doc.querySelector('[data-key="kw"] .lane-form'), null);
});

test('New lane: a name typed with its own prefix is kept as typed; Cancel and Escape close the form; a refused name reopens it with why', async () => {
  const p = livePage((m) => (m.action === 'new-lane' ? { ok: false, error: 'A branch name can\'t contain spaces.' } : { ok: true }));
  const doc = p.dom.window.document;
  const win = p.dom.window;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="new-lane"]').click();
  doc.querySelector('[data-act="lane-cancel"]').click();
  assert.strictEqual(doc.querySelector('.lane-form'), null);
  doc.querySelector('[data-act="new-lane"]').click();
  doc.querySelector('input[data-field="name"]').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(doc.querySelector('.lane-form'), null, 'Escape closes it');
  doc.querySelector('[data-act="new-lane"]').click();
  const n2 = doc.querySelector('input[data-field="name"]');
  n2.value = 'docs/a b';
  n2.dispatchEvent(new win.Event('input', { bubbles: true }));
  n2.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepStrictEqual(p.acts.pop(), { action: 'new-lane', key: 'kw', branch: 'docs/a b' });
  await settle();
  assert.strictEqual(noteOf(doc, 'kw'), 'The lane was not made: A branch name can\'t contain spaces.');
  assert.strictEqual(doc.querySelector('input[data-field="name"]').value, 'docs/a b', 'the form is back with the name');
});

// ---- PR #265 review fixes on the page --------------------------------------------------------------------------------------------

const other = (over = {}) => windowless({ key: 'kb', root: 'C:\\b', label: 'beta', ...over });
const formOf = (doc, key) => doc.querySelector(`[data-key="${key}"] .lane-form`);
const typeName = (p, key, value) => {
  const input = p.dom.window.document.querySelector(`[data-key="${key}"] input[data-field="name"]`);
  input.value = value;
  input.dispatchEvent(new p.dom.window.Event('input', { bubbles: true }));
  return input;
};

test('Dexter 7 / Miguel G4: a question or a form whose card lost the action is gone, and never comes back by itself', async () => {
  const p = stopPage({ count: 2 });
  const doc = p.dom.window.document;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="stop-sessions"]').click();
  await settle();
  assert.ok(doc.querySelector('.confirm'));
  p.onModel(payload([windowless({ state: 'open', actions: ['go-to', 'close-window'] })]));
  p.onModel(payload([windowless()]));
  assert.strictEqual(doc.querySelector('.confirm'), null, 'the old question does not come back');
  doc.querySelector('[data-act="new-lane"]').click();
  assert.ok(formOf(doc, 'kw'));
  p.onModel(payload([windowless({ actions: ['open'] })]));
  p.onModel(payload([windowless()]));
  assert.strictEqual(formOf(doc, 'kw'), null, 'the old form does not come back');
  doc.querySelector('[data-act="new-lane"]').click();
  p.onModel(payload([other()]));                       // the card left the list (a filter, a stop)
  p.onModel(payload([windowless(), other()]));
  assert.strictEqual(formOf(doc, 'kw'), null);
});

test('Dexter 8: each card has its own form: a late refusal on one card never replaces the form open on another', async () => {
  let fail;
  const late = new Promise((r) => { fail = r; });
  const p = livePage((m) => (m.action === 'new-lane' && m.key === 'kw' ? late : { ok: true }));
  const doc = p.dom.window.document;
  p.onModel(payload([windowless(), other()]));
  doc.querySelector('[data-key="kw"] [data-act="new-lane"]').click();
  typeName(p, 'kw', 'first');
  doc.querySelector('[data-key="kw"] [data-act="lane-create"]').click();
  doc.querySelector('[data-key="kb"] [data-act="new-lane"]').click();
  typeName(p, 'kb', 'second');
  fail({ ok: false, error: 'feat/first already exists' });
  await settle();
  assert.strictEqual(doc.querySelector('[data-key="kb"] input[data-field="name"]').value, 'second', 'B\'s form is untouched');
  assert.strictEqual(doc.querySelector('[data-key="kw"] input[data-field="name"]').value, 'first', 'A\'s form is back with its own name');
  assert.strictEqual(noteOf(doc, 'kw'), 'The lane was not made: feat/first already exists');
  assert.strictEqual(noteOf(doc, 'kb'), null);
});

test('Miguel Y2: a push never redraws an open form: the same input, its focus and its caret stay; its status line still follows', () => {
  const p = livePage();
  const doc = p.dom.window.document;
  p.onModel(payload([windowless(), other()]));
  doc.querySelector('[data-key="kw"] [data-act="new-lane"]').click();
  const input = typeName(p, 'kw', 'my-change');
  const select = doc.querySelector('[data-key="kw"] select[data-field="prefix"]');
  input.focus();
  input.setSelectionRange(3, 3);
  p.onModel(payload([windowless({ state: 'closed', sessions: null, actions: ['open', 'pin', 'show-in-explorer', 'new-lane'] }), other()]));
  assert.strictEqual(doc.querySelector('[data-key="kw"] input[data-field="name"]'), input, 'the same element');
  assert.strictEqual(doc.querySelector('[data-key="kw"] select[data-field="prefix"]'), select);
  assert.strictEqual(doc.activeElement, input);
  assert.strictEqual(input.selectionStart, 3);
  assert.strictEqual(doc.querySelector('[data-key="kw"] .state').textContent, 'closed', 'the status line follows the push');
  assert.strictEqual(doc.querySelector('[data-key="kb"] .state').textContent, '2 sessions, no window');
});

test('Dexter 4 / Miguel G3: Create with no name sends nothing and says why; the form stays', () => {
  const p = livePage();
  const doc = p.dom.window.document;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="new-lane"]').click();
  typeName(p, 'kw', '   ');
  doc.querySelector('[data-act="lane-create"]').click();
  typeName(p, 'kw', 'feat/');
  doc.querySelector('[data-act="lane-create"]').click();
  assert.deepStrictEqual(p.acts, []);
  assert.strictEqual(noteOf(doc, 'kw'), 'Type a name after the branch type.');
  assert.ok(formOf(doc, 'kw'));
});

test('Dexter 9 / Miguel G3: one length rule: the longest name the box takes, with the longest type, is a branch main accepts (120)', () => {
  const p = livePage((m) => (m.action === 'new-lane' ? { ok: true, branch: m.branch } : { ok: true }));
  const doc = p.dom.window.document;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="new-lane"]').click();
  const input = doc.querySelector('input[data-field="name"]');
  const max = Number(input.getAttribute('maxlength'));
  const longest = Math.max(...[...doc.querySelectorAll('select[data-field="prefix"] option')].map((o) => o.value.length));
  assert.strictEqual(max + longest, 120);
  const select = doc.querySelector('select[data-field="prefix"]');
  select.value = 'refactor/';
  select.dispatchEvent(new p.dom.window.Event('change', { bubbles: true }));
  typeName(p, 'kw', 'x'.repeat(max));
  doc.querySelector('[data-act="lane-create"]').click();
  assert.strictEqual(p.acts.pop().branch.length, 120);
  doc.querySelector('[data-act="new-lane"]').click();
  typeName(p, 'kw', `feat/${'y'.repeat(116)}`);           // a name typed with its own prefix, 121 long
  doc.querySelector('[data-act="lane-create"]').click();
  assert.deepStrictEqual(p.acts, []);
  assert.strictEqual(noteOf(doc, 'kw'), 'A branch name is at most 120 characters.');
});

test('Miguel G6: a lane made whose setup failed says both, and the form does not come back', async () => {
  const p = livePage((m) => (m.action === 'new-lane' ? { ok: false, made: true, branch: m.branch, error: 'its setup failed: npm ci failed' } : { ok: true }));
  const doc = p.dom.window.document;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="new-lane"]').click();
  typeName(p, 'kw', 'x');
  doc.querySelector('[data-act="lane-create"]').click();
  await settle();
  assert.strictEqual(noteOf(doc, 'kw'), 'feat/x opened in its window, but its setup failed: npm ci failed.');
  assert.strictEqual(formOf(doc, 'kw'), null);
});

test('Dexter 6: a card that is stopping shows no Stop button (main leaves it out) and keeps its note', async () => {
  const p = stopPage({ count: 2, stops: [new Promise(() => {})] });
  const doc = p.dom.window.document;
  p.onModel(payload([windowless()]));
  doc.querySelector('[data-act="stop-sessions"]').click();
  await settle();
  doc.querySelector('[data-act="stop-confirm"]').click();
  p.onModel(payload([windowless({ stopping: true, actions: ['open', 'pin', 'show-in-explorer', 'new-lane'] })]));
  assert.strictEqual(doc.querySelector('[data-act="stop-sessions"]'), null);
  assert.strictEqual(noteOf(doc, 'kw'), 'Stopping 2 sessions…');
});

test('the H-PR3 buttons read "Stop its sessions" and "New lane", with titles that say what they do', () => {
  const html = D.cardsHtml(payload([windowless()]));
  assert.match(html, /<button data-act="stop-sessions" title="[^"]+">Stop its sessions<\/button>/);
  assert.match(html, /<button data-act="new-lane" title="[^"]+">New lane<\/button>/);
});
