'use strict';
/**
 * app/canvas-display.js: Claude's panel as a dock module (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md): pure decisions
 * and escaped HTML strings, the app/resources-display.js pattern. The page Claude wrote is NOT drawn here (it is a native
 * view main lays over `#canvas-slot`); this draws the frame around it: the header and its host badge, the empty state, the
 * too-big note, the question "this panel wants to reach <host>", and the host list.
 *
 * Every host string is somebody else's (the page chose it) and is escaped.
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('../app/canvas-display');

const SID = 'abc-123';
const frame = (over = {}) => ({ type: 'canvas', ok: true, sessionId: SID, status: 'ok', bytes: 20, signature: '20:aaa', hosts: { approved: [], denied: [] }, limitBytes: 1048576, changed: false, ...over });

test('a fresh state has nothing: not shown, nothing to fetch, nothing covered', () => {
  const s = D.emptyState();
  assert.strictEqual(D.view(s).kind, 'empty');
  assert.strictEqual(D.needsFetch(s), false);
  assert.strictEqual(D.covered(s), false);
  assert.strictEqual(D.canShow(s), false);
});

test('a page on disk is something to fetch until its html arrives; then it can be shown', () => {
  let s = D.withFrame(D.emptyState(), frame());
  assert.strictEqual(D.needsFetch(s), true);
  assert.strictEqual(D.canShow(s), false);
  s = D.withFrame(s, frame({ html: '<p>x</p>' }));
  assert.strictEqual(D.needsFetch(s), false);
  assert.strictEqual(D.canShow(s), true);
  assert.deepStrictEqual(D.showRequest(s), { html: '<p>x</p>', hosts: { approved: [], denied: [] }, shelf: [] });
});

test('a changed signature without html is stale: the old page stays up only until the new one is fetched', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>one</p>' }));
  s = D.withFrame(s, frame({ signature: '20:bbb' }));
  assert.strictEqual(D.needsFetch(s), true);
  assert.strictEqual(D.canShow(s), false, 'a stale page is not shown as if it were current');
  s = D.withFrame(s, frame({ signature: '20:bbb', html: '<p>two</p>' }));
  assert.strictEqual(D.canShow(s), true);
  assert.strictEqual(D.showRequest(s).html, '<p>two</p>');
});

test('an old html frame that arrives after a newer signature does not become the page', () => {
  let s = D.withFrame(D.emptyState(), frame({ signature: '20:bbb' }));
  s = D.withFrame(s, frame({ signature: '20:aaa', html: '<p>old</p>' }));
  assert.strictEqual(D.canShow(s), false, 'its signature is not the latest');
});

test('the panel docks itself when Claude writes a page, and only then', () => {
  assert.strictEqual(D.shouldDock(frame({ changed: true })), true);
  assert.strictEqual(D.shouldDock(frame({ changed: false })), false, 'a resumed session\'s old page does not pop the panel open');
  assert.strictEqual(D.shouldDock(frame({ changed: true, status: 'empty' })), false);
  assert.strictEqual(D.shouldDock(frame({ changed: true, status: 'toobig' })), true, 'a refused page still says why');
  assert.strictEqual(D.shouldDock(null), false);
  assert.strictEqual(D.shouldDock({}), false);
});

test('a new session is an empty panel: the old page, questions and open list are dropped', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  s = D.withAsk(s, { id: 1, origin: 'https://a.example.com' });
  s = D.toggleHosts(s);
  s = D.withFrame(s, frame({ sessionId: 'other', status: 'empty', bytes: 0, signature: 'empty' }));
  assert.strictEqual(D.canShow(s), false);
  assert.deepStrictEqual(s.asks, []);
  assert.strictEqual(s.hostsOpen, false);
});

test('a frame that is not a canvas payload changes nothing', () => {
  const s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  for (const bad of [null, undefined, {}, 'x', { status: 'ok' }, { sessionId: 5, status: 'ok' }]) assert.strictEqual(D.withFrame(s, bad), s);
});

test('a refusal frame (ok:false) carries the true state and says why', () => {
  let s = D.withFrame(D.emptyState(), frame());
  s = D.withFrame(s, frame({ ok: false, reason: 'that host answer was not accepted' }));
  assert.strictEqual(D.view(s).note, 'that host answer was not accepted');
  s = D.withFrame(s, frame());
  assert.strictEqual(D.view(s).note, null, 'the next good frame clears it');
});

test('questions queue in order, ignore repeats and bad shapes, and are answered by id', () => {
  let s = D.emptyState();
  s = D.withAsk(s, { id: 1, origin: 'https://a.example.com' });
  s = D.withAsk(s, { id: 2, origin: 'https://b.example.com' });
  s = D.withAsk(s, { id: 2, origin: 'https://b.example.com' });
  for (const bad of [null, {}, { id: 'x', origin: 'https://c.example.com' }, { id: 3 }, { id: 3, origin: 5 }, { id: -1, origin: 'https://c.example.com' }]) s = D.withAsk(s, bad);
  assert.deepStrictEqual(s.asks.map(a => a.id), [1, 2]);
  assert.strictEqual(D.covered(s), true);
  assert.deepStrictEqual(D.view(s).ask, { id: 1, origin: 'https://a.example.com', more: 1 });
  s = D.answered(s, 1);
  assert.deepStrictEqual(D.view(s).ask, { id: 2, origin: 'https://b.example.com', more: 0 });
  s = D.answered(s, 2);
  assert.strictEqual(D.view(s).ask, null);
  assert.strictEqual(D.covered(s), false);
});

test('the host list covers the panel while it is open, and so does a question', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  assert.strictEqual(D.covered(s), false);
  s = D.toggleHosts(s);
  assert.strictEqual(D.covered(s), true);
  s = D.toggleHosts(s);
  assert.strictEqual(D.covered(s), false);
  assert.strictEqual(D.toggleHosts(s, true).hostsOpen, true);
  assert.strictEqual(D.toggleHosts(D.toggleHosts(s, true), false).hostsOpen, false);
});

test('the badge counts the hosts allowed for this panel, singular and plural, and hides at none', () => {
  const badge = (hosts) => D.view(D.withFrame(D.emptyState(), frame({ hosts }))).badge;
  assert.strictEqual(badge({ approved: [], denied: [] }), null);
  assert.strictEqual(badge({ approved: ['https://a.example.com'], denied: [] }).text, '1 host allowed');
  assert.strictEqual(badge({ approved: ['https://a.example.com', 'https://b.example.com'], denied: [] }).text, '2 hosts allowed');
  assert.strictEqual(badge({ approved: [], denied: ['https://a.example.com'] }).text, '1 host denied', 'a list worth opening is not hidden');
});

test('the empty state is the design\'s: the invitation, three examples and a line on the sandbox', () => {
  const v = D.view(D.emptyState());
  const html = D.html(v);
  assert.match(html, /Nothing here yet\. Ask Claude to build something in this panel, for example:/);
  for (const ex of ['a list of every artifact you publish', 'a clock with Santiago and UTC', 'a button that checks my Claude quota']) assert.ok(html.includes(ex), ex);
  assert.match(html, /class="cv-sandbox"/);
  assert.doesNotMatch(html, /id="canvas-slot"/, 'nothing to lay a view over');
});

test('a page over the cap says how big it was and what the limit is, and shows no slot', () => {
  const s = D.withFrame(D.emptyState(), frame({ status: 'toobig', bytes: 1.5 * 1024 * 1024, signature: 'big' }));
  const v = D.view(s);
  assert.strictEqual(v.kind, 'toobig');
  assert.strictEqual(v.text, "Claude's page is too big (1.5 MB, the limit is 1 MB)");
  assert.ok(D.html(v).includes('Claude&#39;s page is too big (1.5 MB, the limit is 1 MB)'));
  assert.doesNotMatch(D.html(v), /id="canvas-slot"/);
});

test('an unreadable page is said so, not shown as empty', () => {
  const s = D.withFrame(D.emptyState(), frame({ status: 'unreadable', bytes: 0, signature: 'unreadable' }));
  assert.strictEqual(D.view(s).kind, 'unreadable');
  assert.match(D.html(D.view(s)), /can't be read/);
});

test('a page ready to show draws the slot the native view is laid over, and the header', () => {
  const s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  const html = D.html(D.view(s));
  assert.match(html, /id="canvas-slot"/);
  assert.match(html, /Claude's panel/);
});

test('a question replaces the slot with "this panel wants to reach <host>", Allow for this panel and Deny', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  s = D.withAsk(s, { id: 7, origin: 'https://api.example.com' });
  const html = D.html(D.view(s));
  assert.match(html, /This panel wants to reach <code>https:\/\/api\.example\.com<\/code>\./);
  assert.match(html, /data-canvas-act="allow" data-canvas-id="7"[^>]*>Allow for this panel</);
  assert.match(html, /data-canvas-act="deny" data-canvas-id="7"[^>]*>Deny</);
  assert.doesNotMatch(html, /id="canvas-slot"/, 'the native view is hidden while the question is up');
  s = D.withAsk(s, { id: 8, origin: 'https://b.example.com' });
  assert.match(D.html(D.view(s)), /1 more waiting/);
});

test('the host list shows each host, allowed or denied, with a Remove, and says so when empty', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>', hosts: { approved: ['https://a.example.com'], denied: ['https://b.example.com'] } }));
  s = D.toggleHosts(s);
  const html = D.html(D.view(s));
  assert.match(html, /https:\/\/a\.example\.com/);
  assert.match(html, /data-canvas-act="remove" data-canvas-origin="https:\/\/a\.example\.com"/);
  assert.match(html, /data-canvas-act="remove" data-canvas-origin="https:\/\/b\.example\.com"/);
  assert.match(html, /Allowed/);
  assert.match(html, /Denied/);
  assert.match(html, /data-canvas-act="close-hosts"/);
  const none = D.toggleHosts(D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' })));
  assert.match(D.html(D.view(none)), /No hosts yet/);
});

test('every string the page chose is escaped', () => {
  const evil = 'https://a.example.com/"><img src=x onerror=alert(1)>';
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>', hosts: { approved: [evil], denied: [] } }));
  s = D.withAsk(s, { id: 1, origin: evil });
  const asking = D.html(D.view(s));
  assert.doesNotMatch(asking, /<img/);
  const listing = D.html(D.view(D.toggleHosts(D.answered(s, 1))));
  assert.doesNotMatch(listing, /<img/);
  assert.doesNotMatch(listing, /"><img/);
});

test('actionOf: a click\'s data attributes become an action, strictly', () => {
  assert.deepStrictEqual(D.actionOf({ canvasAct: 'allow', canvasId: '7' }), { act: 'allow', id: 7 });
  assert.deepStrictEqual(D.actionOf({ canvasAct: 'deny', canvasId: '7' }), { act: 'deny', id: 7 });
  assert.deepStrictEqual(D.actionOf({ canvasAct: 'remove', canvasOrigin: 'https://a.example.com' }), { act: 'remove', origin: 'https://a.example.com' });
  assert.deepStrictEqual(D.actionOf({ canvasAct: 'hosts' }), { act: 'hosts' });
  assert.deepStrictEqual(D.actionOf({ canvasAct: 'close-hosts' }), { act: 'close-hosts' });
  for (const bad of [null, undefined, {}, { canvasAct: 'nope' }, { canvasAct: 'allow' }, { canvasAct: 'allow', canvasId: 'x' }, { canvasAct: 'allow', canvasId: '-3' },
    { canvasAct: 'remove' }, { canvasAct: 'remove', canvasOrigin: '' }]) assert.strictEqual(D.actionOf(bad), null, JSON.stringify(bad));
});

// --- the shelf and the buttons (BACKLOG #71, PR 2) ----------------------------------------------------------------

const gate = require('../app/submit-gate');
const ITEM = { title: 'Roadmap', url: 'https://claude.ai/artifact/aaa', time: '2026-10-05T12:00:00.000Z' };

test('the shelf rides in the host\'s frames, validated, and goes to the panel with the page', () => {
  const s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>', shelf: [ITEM, { title: 5, url: 'x' }, null, { title: 'no url', time: 't' }, { ...ITEM, url: 'javascript:1' }] }));
  assert.deepStrictEqual(D.showRequest(s).shelf, [ITEM]);
  assert.deepStrictEqual(D.shelfOf(s), [ITEM]);
  assert.deepStrictEqual(D.shelfOf(D.emptyState()), []);
  assert.deepStrictEqual(D.shelfOf(D.withFrame(D.emptyState(), frame({ shelf: 'x' }))), []);
});

test('a shelf change alone (same page) changes the shelf and nothing that would reload the page', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  const sig = s.htmlSig;
  s = D.withFrame(s, frame({ shelf: [ITEM] }));
  assert.strictEqual(s.htmlSig, sig);
  assert.strictEqual(D.canShow(s), true);
  assert.strictEqual(D.shelfKey(s), JSON.stringify([ITEM]));
});

test('typed: a click that typed says "typed, press Enter" (the gate\'s words); sent says what the gate says', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  s = D.typed(s, { ok: true });
  assert.strictEqual(D.view(s).status, gate.FLASH.typed);
  assert.strictEqual(D.view(s).statusIsError, false);
  s = D.typed(s, { ok: true, flash: 'sent' });
  assert.strictEqual(D.view(s).status, 'sent');
  s = D.typed(s, { ok: true, flash: 'sent', box: 'a half-typed draft' });
  assert.strictEqual(D.view(s).status, 'sent' + gate.DRAFT_CLEARED, 'a draft that was replaced is said, as the wand says it');
});

test('typed: a refusal says why and that it came from the panel, as an error line', () => {
  let s = D.typed(D.emptyState(), { ok: false, reason: 'a dialog is open in the terminal' });
  const v = D.view(s);
  assert.strictEqual(v.status, "didn't type your message from Claude's panel: a dialog is open in the terminal");
  assert.strictEqual(v.statusIsError, true);
  assert.match(D.view(D.typed(D.emptyState(), null)).status, /the terminal did not take it/);
  assert.match(D.view(D.typed(D.emptyState(), { ok: false })).status, /the terminal did not take it/);
  s = D.clearStatus(s);
  assert.strictEqual(D.view(s).status, null);
});

test('the status line is drawn under the header, escaped, with the error class only for a refusal', () => {
  let s = D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' }));
  s = D.typed(s, { ok: true });
  assert.match(D.html(D.view(s)), /<div class="cv-status" role="status">typed, press Enter<\/div>/);
  s = D.typed(s, { ok: false, reason: '<b>x</b>' });
  const html = D.html(D.view(s));
  assert.match(html, /class="cv-status cv-status-bad"/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.doesNotMatch(D.html(D.view(D.clearStatus(s))), /cv-status/);
});

test('a new session drops the status line too', () => {
  let s = D.typed(D.withFrame(D.emptyState(), frame({ html: '<p>x</p>' })), { ok: true });
  s = D.withFrame(s, frame({ sessionId: 'other', status: 'empty', bytes: 0, signature: 'empty' }));
  assert.strictEqual(D.view(s).status, null);
});

test('the line sent to the session is "(from Claude\'s panel) <text>", one line', () => {
  assert.strictEqual(D.sessionLine('hello'), "(from Claude's panel) hello");
  assert.strictEqual(D.sessionLine('  padded  '), "(from Claude's panel) padded");
  for (const bad of ['', '   ', 5, null, undefined, 'two\nlines', 'tab\there', 'x'.repeat(2001)]) assert.strictEqual(D.sessionLine(bad), null, JSON.stringify(bad));
});
