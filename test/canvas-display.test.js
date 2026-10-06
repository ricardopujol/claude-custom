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


// ---- anything else drawn over the slot (PR #122 Dexter F5) ---------------------------------------------------------------------------

test('samplePoints: a grid inside the slot, none for a slot with no room', () => {
  const pts = D.samplePoints({ x: 100, y: 50, width: 400, height: 300 });
  assert.ok(pts.length >= 4);
  for (const p of pts) assert.ok(p.x >= 101 && p.x <= 499 && p.y >= 51 && p.y <= 349, JSON.stringify(p));
  assert.ok(pts.some(p => p.x === 101 && p.y === 51) && pts.some(p => p.x === 499 && p.y === 349), 'the corners are sampled');
  for (const bad of [null, undefined, 'x', {}, { x: 0, y: 0, width: 2, height: 100 }, { x: 0, y: 0, width: 100, height: 0 }, { x: NaN, y: 0, width: 100, height: 100 }]) {
    assert.deepStrictEqual(D.samplePoints(bad), [], JSON.stringify(bad));
  }
  assert.ok(D.samplePoints({ x: 0, y: 0, width: 5000, height: 5000 }).length <= 144, 'a huge slot costs a bounded number of hit tests');
});

test('slotObstructed: nothing over the slot is not obstructed; a float, menu or popover over any part of it is', () => {
  const slot = { x: 300, y: 100, width: 400, height: 500 };
  assert.strictEqual(D.slotObstructed(slot, () => true), false);
  const over = (box) => (x, y) => !(x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height);
  assert.strictEqual(D.slotObstructed(slot, over({ x: 600, y: 450, width: 300, height: 300 })), true, 'a float over a corner');
  assert.strictEqual(D.slotObstructed(slot, over({ x: 0, y: 0, width: 5000, height: 50 })), false, 'a bar above the slot is not over it');
  assert.strictEqual(D.slotObstructed(slot, over({ x: 400, y: 0, width: 150, height: 300 })), true, 'a menu dropping into the top');
  assert.strictEqual(D.slotObstructed(null, () => false), false, 'no slot, nothing to cover');
});

test('property: any overlay big enough to see over the slot hides it, wherever it sits inside it', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(
    fc.record({ x: fc.integer({ min: -500, max: 2000 }), y: fc.integer({ min: -500, max: 2000 }), width: fc.integer({ min: 10, max: 3000 }), height: fc.integer({ min: 10, max: 3000 }) }),
    fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }),
    (slot, fx, fy) => {
      const pts = D.samplePoints(slot);
      const xs = [...new Set(pts.map(p => p.x))].sort((a, b) => a - b); const ys = [...new Set(pts.map(p => p.y))].sort((a, b) => a - b);
      const gapX = Math.max(...xs.slice(1).map((v, i) => v - xs[i])); const gapY = Math.max(...ys.slice(1).map((v, i) => v - ys[i]));
      const box = { width: gapX + 0.001, height: gapY + 0.001 };
      box.x = slot.x + 1 + fx * (slot.width - 2 - box.width > 0 ? slot.width - 2 - box.width : 0);
      box.y = slot.y + 1 + fy * (slot.height - 2 - box.height > 0 ? slot.height - 2 - box.height : 0);
      const inside = (x, y) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
      assert.strictEqual(D.slotObstructed(slot, (x, y) => !inside(x, y)), true, JSON.stringify({ slot, box }));
      assert.strictEqual(D.slotObstructed(slot, () => true), false);
    }), { numRuns: 400 });
});

// ---- a refused show is said on screen; questions go with their view (PR #122 Dexter F9, Miguel G4) ----------------------------------

const withPage = () => D.withFrame(D.withFrame(D.emptyState(), frame()), frame({ html: '<p>x</p>' }));

test('a refusal from main is a note and a blank slot, not a view the renderer believes in', () => {
  let s = withPage();
  assert.strictEqual(D.canShow(s), true);
  s = D.withRefusal(s, s.htmlSig, 'the page is too big');
  assert.strictEqual(D.canShow(s), false, 'so the renderer stops asking main to show it');
  const v = D.view(s);
  assert.strictEqual(v.note, "Couldn't show Claude's page: the page is too big.");
  assert.strictEqual(v.loading, false, 'not "Loading..." forever');
  assert.match(D.html(v), /cv-error[^>]*>Couldn&#39;t show Claude&#39;s page: the page is too big\.</);
});

test('a refusal holds for that page only: a new page, a new session or a refusal for a stale page changes nothing', () => {
  const s = D.withRefusal(withPage(), '20:aaa', 'x');
  const next = D.withFrame(D.withFrame(s, frame({ signature: '30:bbb' })), frame({ signature: '30:bbb', html: '<p>y</p>' }));
  assert.strictEqual(D.canShow(next), true);
  assert.strictEqual(D.view(next).note, null);
  assert.strictEqual(D.canShow(D.withFrame(s, frame({ sessionId: 'other', signature: '9:z' }))), false, 'no page yet in the new session');
  assert.strictEqual(D.withRefusal(withPage(), '99:stale', 'x').refusal, null);
  assert.strictEqual(D.withRefusal(withPage(), null, 'x').refusal, null);
  assert.strictEqual(D.view(D.withRefusal(withPage(), '20:aaa', '')).note, "Couldn't show Claude's page: it was refused.");
  assert.ok(D.view(D.withRefusal(withPage(), '20:aaa', 'x'.repeat(500))).note.length < 200, 'the reason is capped');
});

test('withoutAsks drops the pending questions and leaves everything else alone', () => {
  let s = D.withAsk(D.withAsk(withPage(), { id: 1, origin: 'https://a.example' }), { id: 2, origin: 'https://b.example' });
  s = D.toggleHosts(s, true);
  const cleared = D.withoutAsks(s);
  assert.deepStrictEqual(cleared.asks, []);
  assert.strictEqual(cleared.hostsOpen, true);
  assert.strictEqual(cleared.html, s.html);
  const none = withPage();
  assert.strictEqual(D.withoutAsks(none), none, 'same object when there is nothing to clear');
});
