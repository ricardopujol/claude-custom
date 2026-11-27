'use strict';
// The tray's pure rules (app/tray-model.js): the needs-you count, the tooltip, the badge text, which cue a click goes to,
// and the right-click menu's template. No Electron: every effect is injected.
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const {
  needsYouKeys, tooltipText, badgeText, trackCues, clickTarget, windowlessItems, trayTemplate, MAX_DIGIT, cueId,
} = require('../app/tray-model');

const tab = (key, status) => ({ key, status });

test('needsYouKeys: a tab counts when its status says needsInput or finished, as a real true', () => {
  const tabs = [
    tab('a', { needsInput: true }), tab('b', { finished: true }), tab('c', { working: true }),
    tab('d', null), tab('e', { needsInput: 'yes' }), tab('f', { finished: 1 }), { key: 'g' }, tab('h', {}),
  ];
  assert.deepStrictEqual(needsYouKeys(tabs), ['a', 'b']);
});

test('needsYouKeys: anything that is not a list of tabs is no cue, never a throw', () => {
  for (const bad of [null, undefined, 3, 'x', {}]) assert.deepStrictEqual(needsYouKeys(bad), []);
  assert.deepStrictEqual(needsYouKeys([null, undefined, 4]), []);
});

test('property: the count never exceeds the number of sessions, and equals the tabs with a cue', () => {
  const status = fc.oneof(fc.constant(null), fc.record({ needsInput: fc.boolean(), finished: fc.boolean(), working: fc.boolean() }));
  fc.assert(fc.property(fc.array(status), (statuses) => {
    const tabs = statuses.map((s, i) => tab('k' + i, s));
    const n = needsYouKeys(tabs).length;
    assert.ok(n <= tabs.length);
    assert.strictEqual(n, statuses.filter(s => s && (s.needsInput || s.finished)).length);
  }));
});

// ---- single-instance PR 3 step 8: one tray for every window of the process ---------------------------------------------------------

test('tooltipText: Jiandu, the windows, the sessions (every window\'s tabs), and who needs you', () => {
  assert.strictEqual(tooltipText({ windows: 4, sessions: 11, needs: 2 }), 'Jiandu · 4 windows · 11 sessions · 2 need you');
  assert.strictEqual(tooltipText({ windows: 1, sessions: 3, needs: 0 }), 'Jiandu · 1 window · 3 sessions');
  assert.strictEqual(tooltipText({ windows: 1, sessions: 1, needs: 1 }), 'Jiandu · 1 window · 1 session · 1 needs you');
  assert.strictEqual(tooltipText({ windows: 0, sessions: 0 }), 'Jiandu · no windows · no sessions');
});

test('tooltipText: a count it was not given is left out, never shown as zero', () => {
  assert.strictEqual(tooltipText({}), 'Jiandu');
  assert.strictEqual(tooltipText({ sessions: 2 }), 'Jiandu · 2 sessions');
  assert.strictEqual(tooltipText({ windows: 2, needs: null }), 'Jiandu · 2 windows');
  assert.strictEqual(tooltipText({ windows: -1, sessions: 2.5, needs: 1 }), 'Jiandu · 1 needs you');
});

test('property: the tooltip pluralises every count and stays under 127', () => {
  fc.assert(fc.property(fc.nat(500), fc.nat(500), fc.nat(500), (w, s, n) => {
    const needs = Math.min(n, s);
    const t = tooltipText({ windows: w, sessions: s, needs });
    assert.ok(t.startsWith('Jiandu · '));
    if (w === 1) assert.match(t, / 1 window(?!s)/); else if (w > 1) assert.ok(t.includes(` ${w} windows`));
    if (s === 1) assert.match(t, / 1 session(?!s)/); else if (s > 1) assert.ok(t.includes(` ${s} sessions`));
    if (needs === 0) assert.ok(!/need/.test(t)); else assert.ok(t.endsWith(needs === 1 ? '1 needs you' : `${needs} need you`));
    assert.ok(t.length <= 127);
  }));
});

test('trackCues: cue ids are { root, key } pairs (a develop tab exists in every project); each keeps when it first appeared', () => {
  let m = trackCues(new Map(), [{ root: 'A', key: 'develop' }], 100);
  m = trackCues(m, [{ root: 'A', key: 'develop' }, { root: 'B', key: 'develop' }], 200);
  assert.strictEqual(m.size, 2, 'A\'s develop and B\'s develop are two cues');
  assert.deepStrictEqual([...m.values()], [{ root: 'A', key: 'develop', since: 100 }, { root: 'B', key: 'develop', since: 200 }]);
  m = trackCues(m, [{ root: 'B', key: 'develop' }], 300);
  assert.deepStrictEqual([...m.values()], [{ root: 'B', key: 'develop', since: 200 }], 'a cleared cue is forgotten');
  m = trackCues(m, [{ root: 'A', key: 'develop' }, { root: 'B', key: 'develop' }], 400);
  assert.strictEqual([...m.values()].find((c) => c.root === 'A').since, 400, 'and starts over when it comes back');
  assert.strictEqual(cueId('A', 'develop') === cueId('B', 'develop'), false);
});

test('clickTarget: the oldest cue in ANY window, else the window used last', () => {
  const cues = trackCues(trackCues(new Map(), [{ root: 'B', key: 'feat-x' }], 50), [{ root: 'B', key: 'feat-x' }, { root: 'A', key: 'develop' }], 90);
  assert.deepStrictEqual(clickTarget(cues, 'A'), { kind: 'tab', root: 'B', key: 'feat-x' });
  assert.deepStrictEqual(clickTarget(new Map(), 'A'), { kind: 'window', root: 'A' });
  assert.deepStrictEqual(clickTarget(null, null), { kind: 'window', root: null });
});

test('P-T2: the click target is the cue with the smallest since across all windows; a closed window\'s cue is never it', () => {
  const ids = fc.record({ root: fc.constantFrom('A', 'B', 'C'), key: fc.constantFrom('develop', 'feat-a', 'feat-b') });
  fc.assert(fc.property(fc.array(fc.tuple(ids, fc.nat(1000)), { maxLength: 15 }), fc.subarray(['A', 'B', 'C']), (pairs, closed) => {
    let cues = new Map();
    for (const [id, t] of pairs) cues = trackCues(cues, [...[...cues.values()].map(({ root, key }) => ({ root, key })), id], t);
    // a closed window's cues are forgotten (the controller drops them): what is left is what the tabs of the open windows say
    cues = new Map([...cues].filter(([, c]) => !closed.includes(c.root)));
    const t = clickTarget(cues, 'A');
    if (cues.size === 0) return assert.deepStrictEqual(t, { kind: 'window', root: 'A' });
    assert.strictEqual(t.kind, 'tab');
    assert.ok(!closed.includes(t.root));
    const mine = [...cues.values()].find((c) => c.root === t.root && c.key === t.key);
    for (const c of cues.values()) assert.ok(mine.since <= c.since);
  }));
});
test('badgeText: nothing at 0, the digit up to 9, then 9+', () => {
  assert.strictEqual(badgeText(0), '');
  assert.strictEqual(badgeText(1), '1');
  assert.strictEqual(badgeText(MAX_DIGIT), '9');
  assert.strictEqual(badgeText(MAX_DIGIT + 1), '9+');
  assert.strictEqual(badgeText(400), '9+');
  for (const bad of [null, undefined, NaN, -3, 1.5, '4']) assert.strictEqual(badgeText(bad), '', String(bad));
});

const ROW = (port, windows, over = {}) => ({ port, pid: 100 + port, cwd: `C:\\p\\${port}`, build: 'dev', windows, own: true, ...over });
const ITEM = (port, windows, over = {}) => ({
  label: `p${port}  ·  dev  ·  3 h  ·  no window`, open: { kind: 'window', port, cwd: `C:\\p\\${port}` }, stop: windows === 0, row: ROW(port, windows), ...over,
});

test('windowlessItems: only sessions with no window and not a tab here; the unknown count is not "none"', () => {
  const items = [ITEM(1, 0), ITEM(2, 1), ITEM(3, null, { stop: true }), ITEM(4, 0, { open: { kind: 'select-tab', key: 'k' }, stop: false })];
  assert.deepStrictEqual(windowlessItems({ items }).map(i => i.row.port), [1]);
  assert.deepStrictEqual(windowlessItems(null), []);
  assert.deepStrictEqual(windowlessItems({ items: 'x' }), []);
});

function spy() {
  const calls = [];
  const fn = name => (...a) => calls.push([name, ...a]);
  return { calls, actions: {
    focusWindow: fn('focus'), openBackground: fn('open'), stopBackground: fn('stop'), hideAll: fn('hide'), showAll: fn('show'),
    setStartMinimised: fn('start'), quit: fn('quit') } };
}
const W = (root, over = {}) => ({ root, label: root.toLowerCase(), tabs: 2, needs: 0, waitingKey: null, ...over });
const view = (over = {}) => ({ windows: [W('A')], hidden: false, startMinimised: false, windowless: [], ...over });

test('trayTemplate: one row per window in open order, hide/show, start minimised, Quit Jiandu; no Open project row (PR 4)', () => {
  const { actions, calls } = spy();
  const t = trayTemplate(view({ windows: [W('A'), W('B', { tabs: 1 })] }), actions);
  const labels = t.filter(x => x.type !== 'separator').map(x => x.label);
  assert.deepStrictEqual(labels, ['a  ·  2 tabs', 'b  ·  1 tab', 'Hide all windows', 'Start minimised to tray', 'Quit Jiandu']);
  assert.ok(!labels.some((l) => /Open project/.test(l)));
  t.find(x => x.label === 'b  ·  1 tab').click();
  t.find(x => x.label === 'Hide all windows').click();
  t.find(x => x.label === 'Quit Jiandu').click();
  assert.deepStrictEqual(calls, [['focus', 'B', null], ['hide'], ['quit']]);
});

test('trayTemplate: a row click names its window and the tab waiting there; a window that needs you says so', () => {
  const { actions, calls } = spy();
  const t = trayTemplate(view({ windows: [W('A', { tabs: 1, needs: 1, waitingKey: 'develop' }), W('B', { tabs: 3, needs: 2, waitingKey: 'feat-a' })] }), actions);
  assert.strictEqual(t[0].label, 'a  ·  1 tab  ·  needs you');
  assert.strictEqual(t[1].label, 'b  ·  3 tabs  ·  2 need you');
  t[1].click();
  assert.deepStrictEqual(calls, [['focus', 'B', 'feat-a']]);
});

test('trayTemplate: any hidden window offers Show all windows', () => {
  const t = trayTemplate(view({ hidden: true }), spy().actions);
  assert.ok(t.some(x => x.label === 'Show all windows'));
  assert.ok(!t.some(x => x.label === 'Hide all windows'));
});

test('trayTemplate: start minimised is a checkbox that sends the opposite of what it shows', () => {
  const { actions, calls } = spy();
  for (const on of [false, true]) {
    const t = trayTemplate(view({ startMinimised: on }), actions);
    const row = t.find(x => x.label === 'Start minimised to tray');
    assert.strictEqual(row.type, 'checkbox');
    assert.strictEqual(row.checked, on);
    row.click({ checked: !on });
  }
  assert.deepStrictEqual(calls, [['start', true], ['start', false]]);
});

test('trayTemplate: the sessions with no window sit under a disabled head row, each with Open and "Stop that session…"', () => {
  const { actions, calls } = spy();
  const a = ITEM(1, 0);
  const b = ITEM(2, 0, { open: null });
  const t = trayTemplate(view({ windowless: [a, b] }), actions);
  const head = t.find((x) => x.label === 'Sessions with no window');
  assert.ok(head && head.enabled === false, 'a disabled head row');
  assert.ok(t.indexOf(head) < t.findIndex((x) => x.submenu));
  const rows = t.filter(x => x.submenu);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0].submenu.map(s => [s.label, s.enabled]), [['Open', true], ['Stop that session…', true]]);
  assert.strictEqual(rows[1].submenu[0].enabled, false);
  rows[0].submenu[0].click();
  rows[0].submenu[1].click();
  assert.deepStrictEqual(calls, [['open', a.open], ['stop', a.row]]);
  assert.ok(!trayTemplate(view(), spy().actions).some((x) => x.label === 'Sessions with no window'), 'no head row with none');
});

test('trayTemplate: & in a folder or label is shown, never read as a mnemonic', () => {
  const t = trayTemplate(view({ windows: [W('A', { label: 'R&D' })], windowless: [ITEM(1, 0, { label: 'A & B' })] }), spy().actions);
  assert.strictEqual(t[0].label, 'R&&D  ·  2 tabs');
  assert.strictEqual(t.find(x => x.submenu).label, 'A && B');
});

test('P-T1: whatever order windows open, close, hide and show in, and cues rise and clear, the badge is the sum of the windows\' waiting tabs, the rows are the open windows in order, and the tooltip counts match', () => {
  const op = fc.oneof(
    fc.record({ k: fc.constant('open'), r: fc.constantFrom('A', 'B', 'C', 'D') }),
    fc.record({ k: fc.constant('close'), r: fc.constantFrom('A', 'B', 'C', 'D') }),
    fc.record({ k: fc.constantFrom('hide', 'show'), r: fc.constantFrom('A', 'B', 'C', 'D') }),
    fc.record({ k: fc.constantFrom('cue', 'clear'), r: fc.constantFrom('A', 'B', 'C', 'D'), t: fc.constantFrom('develop', 'feat-a') }),
  );
  fc.assert(fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
    const open = [];                    // [{ root, hidden, tabs: Map key -> status }]
    for (const o of ops) {
      const w = open.find((x) => x.root === o.r);
      if (o.k === 'open' && !w) open.push({ root: o.r, hidden: false, tabs: new Map([['develop', null], ['feat-a', null]]) });
      else if (o.k === 'close' && w) open.splice(open.indexOf(w), 1);
      else if ((o.k === 'hide' || o.k === 'show') && w) w.hidden = o.k === 'hide';
      else if (o.k === 'cue' && w) w.tabs.set(o.t, { needsInput: true });
      else if (o.k === 'clear' && w) w.tabs.set(o.t, null);
    }
    const windows = open.map((w) => {
      const tabs = [...w.tabs].map(([key, status]) => ({ key, status }));
      return { root: w.root, label: w.root, tabs: tabs.length, needs: needsYouKeys(tabs).length, waitingKey: needsYouKeys(tabs)[0] || null };
    });
    const needs = windows.reduce((s, w) => s + w.needs, 0);
    const sessions = windows.reduce((s, w) => s + w.tabs, 0);
    assert.strictEqual(badgeText(needs), needs === 0 ? '' : (needs > 9 ? '9+' : String(needs)));
    const t = trayTemplate({ windows, hidden: open.some((w) => w.hidden), startMinimised: false, windowless: [] }, spy().actions);
    const rows = t.slice(0, windows.length).map((x) => x.label.split('  ·  ')[0]);
    assert.deepStrictEqual(rows, open.map((w) => w.root));
    assert.ok(t.some((x) => x.label === (open.some((w) => w.hidden) ? 'Show all windows' : 'Hide all windows')));
    const tip = tooltipText({ windows: windows.length, sessions, needs });
    if (windows.length > 1) assert.ok(tip.includes(`${windows.length} windows`));
    if (needs > 0) assert.ok(tip.includes(needs === 1 ? '1 needs you' : `${needs} need you`));
  }));
});
const { hidesOnClose, startsHidden } = require('../app/tray-model');

test('hidesOnClose: only with the switch on, a tray to reach the window from, and the app not quitting', () => {
  const on = { minimiseOnClose: true };
  assert.strictEqual(hidesOnClose({ settings: on, trayExists: true, quitting: false }), true);
  assert.strictEqual(hidesOnClose({ settings: on, trayExists: false, quitting: false }), false, 'no tray: the window would be lost');
  assert.strictEqual(hidesOnClose({ settings: on, trayExists: true, quitting: true }), false, 'quitting must close');
  assert.strictEqual(hidesOnClose({ settings: { minimiseOnClose: false }, trayExists: true, quitting: false }), false);
  assert.strictEqual(hidesOnClose({ settings: {}, trayExists: true, quitting: false }), false, 'off by default');
  assert.strictEqual(hidesOnClose({}), false);
});

test('startsHidden: only with the switch on and the tray icon on, so the window can always be reached', () => {
  assert.strictEqual(startsHidden({ startMinimised: true, trayIcon: true }), true);
  assert.strictEqual(startsHidden({ startMinimised: true, trayIcon: false }), false);
  assert.strictEqual(startsHidden({ startMinimised: false, trayIcon: true }), false);
  assert.strictEqual(startsHidden({}), false);
  assert.strictEqual(startsHidden(null), false);
});

// PR #256 Dexter 6: the tray's "hidden" is ANY window hidden (or no window to show), so "Show all windows" is offered whenever one needs it
const { anyWindowHidden } = require('../app/tray-model');
test('anyWindowHidden: one hidden window of several is enough; none, or a destroyed one, counts as hidden', () => {
  const w = (visible, destroyed = false) => ({ isDestroyed: () => destroyed, isVisible: () => visible });
  assert.strictEqual(anyWindowHidden([w(true), w(false)]), true, 'B is hidden while A is visible');
  assert.strictEqual(anyWindowHidden([w(false), w(true)]), true);
  assert.strictEqual(anyWindowHidden([w(true), w(true)]), false);
  assert.strictEqual(anyWindowHidden([]), true, 'no window: it can only be shown');
  assert.strictEqual(anyWindowHidden([w(true), w(true, true)]), true, 'a destroyed window is not visible');
  assert.strictEqual(anyWindowHidden([w(true), null]), true, 'a window not made yet is not visible');
});
