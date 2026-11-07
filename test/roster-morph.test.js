'use strict';
/**
 * BACKLOG #184 (#17 F4's rest): a press on an agent card is dropped when that card changes between mousedown and mouseup,
 * because the repaint swapped the card's node and the mouseup lands on the replacement (no `click` fires). Since PR #239 A5
 * only a changed card is swapped; now a changed card is PATCHED IN PLACE (app/roster-morph.js morphElement): the card's node
 * and every control in it that is still the same control keep their identity, so the press and the release land on the same
 * element. A control that turned into another one (another tag, class or data-* attribute: a Pause turned Resume, a hide turned
 * unhide, another face video) is replaced, never morphed, so a held press can't fire a different action than the one pressed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { JSDOM } = require('jsdom');
const { morphElement, patchCards, identity } = require('../app/roster-morph');

const { document } = new JSDOM('<!doctype html><body></body>').window;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parse = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
const mount = (html) => { const host = document.createElement('div'); document.body.replaceChildren(host); host.innerHTML = html; return host.firstElementChild; };
const body = (src, head) => { const i = src.indexOf(head); return src.slice(i, src.indexOf('\n}\n', i)); };
const recorder = () => { const r = { removed: [], added: [] }; r.hooks = { removed: (n) => r.removed.push(n), added: (n) => r.added.push(n) }; return r; };

// A card shaped like renderer.js activeCardHtml: a hide button only on some cards, the medal button, the face, the meta lines.
const card = (s) => `<div class="agent" data-state="${esc(s.state)}" data-detail="${esc(s.detail)}" data-agent="probe"` +
  (s.cause ? ` title="${esc(s.cause)}"` : '') + '>' +
  (s.hide ? `<button type="button" class="agent-hide" data-roster-action="${s.hide}" title="${s.hide}">${s.hide}</button>` : '') +
  '<button type="button" class="agent-medal-btn" data-medal-open title="Give probe a medal">🏅</button>' +
  `<div class="face" data-tier="${s.face.tier}">` +
  (s.face.tier === 'video' ? `<video class="face-media" data-face-key="${esc(s.face.key)}" src="${esc(s.face.src || s.face.key)}" autoplay loop muted playsinline></video>`
    : s.face.tier === 'file' ? `<img class="face-media" src="${esc(s.face.key)}" alt="" title="t" />`
      : `<span class="face-media face-placeholder" title="t">PR</span>`) +
  // The pencil carries the state it acts for, as renderer.js faceEditHtml(state) draws it (PR #244 Dexter 1).
  `<button type="button" class="face-pencil" data-no-card-click data-portrait-state="${esc(s.state)}" title="Choose a picture">✎</button></div>` +
  `<div class="meta"><div class="name" title="probe"><span class="name-big">probe</span></div>` +
  `<div class="state"${s.cause ? ` title="${esc(s.cause)}"` : ''}>${esc(s.words)}${s.chip ? `<span class="medal-chip">🏅${s.chip}</span>` : ''}</div>` +
  (s.wait ? `<div class="agent-wait">waiting ${esc(s.wait)}</div>` : '') +
  // Two lines whose order can swap (PR #244 Dexter's note: the property never reordered siblings).
  (s.flip ? '<div class="agent-model">model</div><div class="career">career</div>' : '<div class="career">career</div><div class="agent-model">model</div>') +
  (s.pause ? `<div class="agent-pause"><button type="button" class="agent-pause-btn" data-agent-pause-act="${s.pause}" data-agent="probe">${s.pause}</button></div>` : '') +
  '</div></div>';
const base = { state: 'working', detail: 'working', cause: '', hide: '', face: { tier: 'text' }, words: 'working', chip: 0, wait: '', pause: 'pause' };

test('a changed card keeps its node and its medal button\'s node, and ends equal to the fresh markup', () => {
  const live = mount(card(base));
  const btn = live.querySelector('[data-medal-open]');
  const next = { ...base, state: 'stressed', detail: 'stressed', cause: 'A Bash call failed', words: 'stressed', chip: 2 };
  const r = recorder();
  const out = morphElement(live, parse(card(next)), r.hooks);
  assert.strictEqual(out, live, 'the card node stays');
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn, 'the pressed button stays');
  assert.strictEqual(live.outerHTML, parse(card(next)).outerHTML);
  assert.strictEqual(live.getAttribute('title'), 'A Bash call failed', 'a hovered card\'s title is updated on the same node');
  assert.deepStrictEqual(r.removed.map(n => n.className), ['face-pencil'], 'the pencil acted for "working": it goes');
  assert.deepStrictEqual(r.added.map(n => n.className), ['face-pencil', 'medal-chip'], 'the stressed pencil and the chip are new');
});

// PR #244 Dexter 1: the pencil saves a picture for the state it was pressed on, or the press drops; never another state.
test('D1: the face pencil pressed on a working card that turns stressed is replaced, so the press drops; the click reads the pencil\'s own state', () => {
  const live = mount(card(base));
  const pencil = live.querySelector('.face-pencil');
  const face = live.querySelector('.face');
  morphElement(live, parse(card({ ...base, state: 'stressed', detail: 'stressed', cause: 'A Bash call failed' })), recorder().hooks);
  assert.strictEqual(live.querySelector('.face'), face, 'same tier: the face itself stays');
  assert.strictEqual(pencil.isConnected, false, 'the pressed pencil is gone: its mouseup lands on another node, no click');
  assert.strictEqual(pencil.dataset.portraitState, 'working', 'and had it fired, it acted for the state that was pressed');
  assert.strictEqual(live.querySelector('.face-pencil').dataset.portraitState, 'stressed');
  // Unchanged state: the same pencil stays, so a press on it lands as before.
  const kept = live.querySelector('.face-pencil');
  morphElement(live, parse(card({ ...base, state: 'stressed', detail: 'stressed', cause: 'A Bash call failed', words: 'other' })), recorder().hooks);
  assert.strictEqual(live.querySelector('.face-pencil'), kept);
});

test('D1: the renderer draws the pencil with the card\'s state and the click reads the pencil\'s, never the card\'s live data-state', () => {
  const js = read('app/renderer.js');
  assert.match(body(js, 'function faceEditHtml'), /data-portrait-state="\$\{escapeHtml\(state\)\}"/);
  assert.match(js, /\$\{faceHtml\(r\.portrait\)\}\$\{faceEditHtml\(r\.state\)\}/, 'the active card passes its state');
  assert.match(js, /\$\{faceHtml\(entry && entry\.portrait\)\}\$\{faceEditHtml\('inactive'\)\}/, 'the inactive row is data-state="inactive"');
  assert.doesNotMatch(js, /faceEditHtml\(\)/, 'no pencil without a state');
  const i = js.indexOf("closest('.face-pencil')");
  const handler = js.slice(i, js.indexOf('\n});', i));
  assert.match(handler, /const state = btn\.dataset\.portraitState;/);
  assert.doesNotMatch(handler, /row\.dataset\.state/);
});

// PR #244 Miguel Y2: a child the fresh markup doesn't have is removed, whoever put it there; the bubble is the known case.
test('Y2: a foreign first child (the speech bubble) is removed by a patch, through the removed hook, and the rest is kept', () => {
  const live = mount(card(base));
  live.insertAdjacentHTML('afterbegin', '<div class="agent-bubble">hi</div>');
  const bubble = live.firstElementChild;
  const btn = live.querySelector('[data-medal-open]');
  const r = recorder();
  morphElement(live, parse(card({ ...base, words: 'reading' })), r.hooks);
  assert.strictEqual(bubble.isConnected, false, 'paintBubbles puts it back, rebuilt settled');
  assert.ok(r.removed.includes(bubble));
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
  assert.strictEqual(live.outerHTML, parse(card({ ...base, words: 'reading' })).outerHTML);
});

// PR #244 Dexter 3: the known residual, pinned so a change to it is deliberate.
test('D3 residual: plain card text whose element changes data-* mid-press is replaced (a press on it still drops), and the header says so', () => {
  const html = (late) => card(base).replace('<div class="career">', `<div class="wait-note" data-late="${late}">waiting</div><div class="career">`);
  const live = mount(html('false'));
  const note = live.querySelector('.wait-note');
  morphElement(live, parse(html('true')), recorder().hooks);
  assert.strictEqual(note.isConnected, false);
  assert.strictEqual(live.querySelector('.wait-note').dataset.late, 'true');
});

// PR #244 Miguel G2: tag and class through morphElement, not only through identity(); a src-only change is content.
test('G2: a child whose tag or class changed is replaced through morphElement; a src-only change keeps the node and updates src', () => {
  const live = mount(card(base));
  const placeholder = live.querySelector('.face-placeholder');
  morphElement(live, parse(card(base).replace('<span class="face-media face-placeholder" title="t">PR</span>', '<b class="face-media face-placeholder" title="t">PR</b>')), recorder().hooks);
  assert.strictEqual(placeholder.isConnected, false, 'span to b: another tag');
  const b = live.querySelector('.face-placeholder');
  morphElement(live, parse(card(base).replace('<span class="face-media face-placeholder" title="t">PR</span>', '<b class="face-media face-placeholder face-dim" title="t">PR</b>')), recorder().hooks);
  assert.strictEqual(b.isConnected, false, 'another class');
  const vid = mount(card({ ...base, face: { tier: 'video', key: 'k', src: 'a.mp4' } }));
  const v = vid.querySelector('video');
  morphElement(vid, parse(card({ ...base, face: { tier: 'video', key: 'k', src: 'b.mp4' } })), recorder().hooks);
  assert.strictEqual(vid.querySelector('video'), v, 'the same key: the node stays');
  assert.strictEqual(v.getAttribute('src'), 'b.mp4');
});

// PR #244 Miguel Y3 + G3: the renderer's per-card path, executed with stubs, not matched as text.
const mediaStub = () => {
  const log = [];
  return { log, media: {
    observer: { observe: (v) => log.push(['observe', v]), unobserve: (v) => log.push(['unobserve', v]) },
    unloadVideo: (v) => log.push(['unload', v]),
    applyFaceVideo: (v) => log.push(['apply', v, v.isConnected]),
    onError: (e) => log.push(['error', e.message]),
  } };
};

test('Y3: patchCards unloads and unobserves a replaced video, observes and applies a new one once it is in the card, and returns the live cards', () => {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  host.innerHTML = card({ ...base, face: { tier: 'video', key: 'a.mp4' } }) + card({ ...base, words: 'other' });
  const olds = [...host.childNodes];
  const oldVideo = olds[0].querySelector('video');
  const fresh = [parse(card({ ...base, face: { tier: 'video', key: 'b.mp4' } })), parse(card({ ...base, words: 'other' }))];
  const { log, media } = mediaStub();
  const live = patchCards(olds, fresh, [0], media);
  assert.deepStrictEqual(live, [olds[0]], 'the card node itself is what is live');
  const newVideo = olds[0].querySelector('video');
  assert.notStrictEqual(newVideo, oldVideo);
  assert.deepStrictEqual(log.map(([k, v, c]) => [k, v === oldVideo ? 'old' : v === newVideo ? 'new' : v, c]),
    [['unobserve', 'old', undefined], ['unload', 'old', undefined], ['observe', 'new', undefined], ['apply', 'new', true]]);
  assert.strictEqual(olds[0].outerHTML, parse(card({ ...base, face: { tier: 'video', key: 'b.mp4' } })).outerHTML);
});

test('Y3: a video that stays (same key) is neither unloaded nor re-applied; no observer is fine', () => {
  const live = mount(card({ ...base, face: { tier: 'video', key: 'a.mp4' } }));
  const { log, media } = mediaStub();
  media.observer = null;
  patchCards([live], [parse(card({ ...base, face: { tier: 'video', key: 'a.mp4' }, words: 'x' }))], [0], media);
  assert.deepStrictEqual(log, []);
});

test('G3: a patch that throws midway is undone by a swap to a pristine copy of the fresh card, and the error is reported', () => {
  const live = mount(card(base));
  // An attribute the HTML parser accepts and setAttribute refuses: the morph throws partway through.
  const bad = card({ ...base, words: 'next', chip: 1 }).replace('<div class="meta">', '<div class="meta" a"b="1">');
  const fresh = parse(bad);
  assert.ok(fresh.querySelector('.meta').hasAttribute('a"b'), 'the parser kept the odd attribute');
  const { log, media } = mediaStub();
  const [now] = patchCards([live], [fresh], [0], media);
  assert.notStrictEqual(now, live);
  assert.strictEqual(live.isConnected, false);
  assert.strictEqual(now.isConnected, true);
  assert.strictEqual(now.outerHTML, parse(bad).outerHTML, 'the whole fresh card, not a half-patched one');
  assert.strictEqual(log[0][0], 'error');
});

test('a control that turned into another one is replaced, never morphed: Pause to Resume, hide to unhide', () => {
  const live = mount(card({ ...base, hide: 'hide' }));
  const pause = live.querySelector('.agent-pause-btn');
  const hide = live.querySelector('.agent-hide');
  const r = recorder();
  morphElement(live, parse(card({ ...base, hide: 'unhide', pause: 'resume' })), r.hooks);
  assert.notStrictEqual(live.querySelector('.agent-pause-btn'), pause, 'a press on Pause must not fire Resume');
  assert.notStrictEqual(live.querySelector('.agent-hide'), hide, 'a press on hide must not fire unhide');
  assert.ok(r.removed.includes(pause) && r.removed.includes(hide), 'the old controls go through the removed hook');
  assert.strictEqual(pause.isConnected, false);
  assert.strictEqual(live.outerHTML, parse(card({ ...base, hide: 'unhide', pause: 'resume' })).outerHTML);
});

test('a control appearing in front of the medal button, or leaving, keeps the medal button\'s node', () => {
  const live = mount(card(base));
  const btn = live.querySelector('[data-medal-open]');
  const r = recorder();
  morphElement(live, parse(card({ ...base, hide: 'hide', pause: '' })), r.hooks);
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
  assert.deepStrictEqual(r.added.map(n => n.className), ['agent-hide']);
  assert.deepStrictEqual(r.removed.map(n => n.className), ['agent-pause']);
  morphElement(live, parse(card(base)), r.hooks);
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
  assert.strictEqual(live.outerHTML, parse(card(base)).outerHTML);
});

test('a face video with the same key keeps its live node; another key is a new video, through the hooks', () => {
  const live = mount(card({ ...base, face: { tier: 'video', key: 'a.mp4' } }));
  const v = live.querySelector('video');
  morphElement(live, parse(card({ ...base, face: { tier: 'video', key: 'a.mp4' }, words: 'reading' })), recorder().hooks);
  assert.strictEqual(live.querySelector('video'), v, 'the same face keeps playing: no restart from frame 0');
  const r = recorder();
  morphElement(live, parse(card({ ...base, face: { tier: 'video', key: 'b.mp4' } })), r.hooks);
  assert.notStrictEqual(live.querySelector('video'), v);
  assert.deepStrictEqual(r.removed, [v], 'the old video is handed over to be unloaded');
  assert.deepStrictEqual(r.added, [live.querySelector('video')], 'the new one is handed over to be watched');
});

test('a text node is patched in place; a root of another tag is replaced and the new root returned', () => {
  const live = mount(card(base));
  const words = live.querySelector('.state').firstChild;
  morphElement(live, parse(card({ ...base, words: 'running' })), recorder().hooks);
  assert.strictEqual(live.querySelector('.state').firstChild, words);
  assert.strictEqual(words.nodeValue, 'running');
  const span = mount('<span data-agent="probe">x</span>');
  const r = recorder();
  const fresh = parse(card(base));
  assert.strictEqual(morphElement(span, fresh, r.hooks), fresh);
  assert.strictEqual(fresh.isConnected, true);
  assert.deepStrictEqual([r.removed, r.added], [[span], [fresh]]);
});

test('identity: tag, class and every data-* attribute; never title, text or src', () => {
  const a = parse('<button class="x" data-k="1" title="a">one</button>');
  assert.strictEqual(identity(a), identity(parse('<button class="x" data-k="1" title="b">two</button>')));
  assert.notStrictEqual(identity(a), identity(parse('<button class="x" data-k="2">one</button>')));
  assert.notStrictEqual(identity(a), identity(parse('<button class="y" data-k="1">one</button>')));
  assert.notStrictEqual(identity(a), identity(parse('<span class="x" data-k="1">one</span>')));
  assert.notStrictEqual(identity(a), identity(parse('<button class="x" data-k="1" data-j>one</button>')));
});

// The pressed control, whatever repaints come: the brief's property ("a card with a pointer down is never swapped, and after the
// pointer is up its content equals a fresh render"). Here the card is never swapped at all, and equals the fresh render after
// EVERY repaint; a node that survives a repaint is still the same control it was (its identity never changes under a press).
const stateArb = fc.record({
  state: fc.constantFrom('working', 'stressed', 'happy', 'sleeping'),
  detail: fc.constantFrom('working', 'reading', 'running', 'bgwait'),
  cause: fc.oneof(fc.constant(''), fc.string({ maxLength: 12 })),
  hide: fc.constantFrom('', 'hide', 'unhide'),
  face: fc.oneof(fc.constant({ tier: 'text' }), fc.record({ tier: fc.constantFrom('file', 'video'), key: fc.constantFrom('a.mp4', 'b.mp4') })),
  words: fc.string({ maxLength: 10 }),
  chip: fc.nat(3),
  wait: fc.oneof(fc.constant(''), fc.string({ maxLength: 6 })),
  pause: fc.constantFrom('', 'pause', 'resume'),
  flip: fc.boolean(),
});

// What a user presses, read straight off the node, NOT through identity() (the function under test; PR #244 Miguel G1).
const DATA = ['data-roster-action', 'data-agent-pause-act', 'data-face-key', 'data-portrait-state', 'data-medal-open'];
const snap = (n) => [n.tagName, n.className, ...DATA.map(a => n.getAttribute(a))].join('|');

test('property: across any repaints (siblings reordered too) the card and its medal button are never swapped, a survivor is still the control it was, and the card equals the fresh render', () => {
  fc.assert(fc.property(stateArb, fc.array(stateArb, { minLength: 1, maxLength: 8 }), (first, rest) => {
    const live = mount(card(first));
    const btn = live.querySelector('[data-medal-open]');
    for (const s of rest) {
      const before = new Map([...live.querySelectorAll('*')].map(n => [n, snap(n)]));
      const r = recorder();
      assert.strictEqual(morphElement(live, parse(card(s)), r.hooks), live);
      assert.strictEqual(live.outerHTML, parse(card(s)).outerHTML);
      assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
      for (const n of live.querySelectorAll('*')) if (before.has(n)) assert.strictEqual(snap(n), before.get(n));
      for (const n of r.removed) assert.strictEqual(n.isConnected, false);
      for (const n of r.added) assert.ok(live.contains(n));
    }
  }), { numRuns: 300 });
});

// ---- the wiring: setRosterHtml patches a changed card in place instead of swapping it ----------------------------------------

test('setRosterHtml patches a changed card through rosterMorph.patchCards, and no longer swaps its node', () => {
  const js = read('app/renderer.js');
  const set = body(js, 'function setRosterHtml');
  assert.match(set, /if \(!patch\.full\) \{ patchRosterCards\(oldNodes, freshNodes, freshHtml, patch\.replace\); return; \}/);
  assert.doesNotMatch(set, /oldNodes\[i\]\.replaceWith\(freshNodes\[i\]\)/);
  const b = body(js, 'function patchRosterCards');
  assert.match(b, /window\.rosterMorph\.patchCards\(oldNodes, freshNodes, changed, \{/);
  assert.match(b, /observer: faceVideoObserver, unloadVideo: portraitMedia\.unloadVideo, applyFaceVideo,/);
  assert.match(b, /changed\.forEach\(\(i, k\) => paintedCardHtml\.set\(live\[k\], freshHtml\[i\]\)\)/, 'the live node remembers the markup it now matches');
});

