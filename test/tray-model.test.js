'use strict';
// The tray's pure rules (app/tray-model.js): the needs-you count, the tooltip, the badge text, which cue a click goes to,
// and the right-click menu's template. No Electron: every effect is injected.
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const {
  needsYouKeys, tooltipText, badgeText, trackCues, clickTarget, windowlessItems, trayTemplate, MAX_DIGIT,
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

test('tooltipText: the app, the sessions, and who needs you', () => {
  assert.strictEqual(tooltipText({ sessions: 3, needs: 1 }), 'claude-custom · 3 sessions · 1 needs you');
  assert.strictEqual(tooltipText({ sessions: 3, needs: 2 }), 'claude-custom · 3 sessions · 2 need you');
  assert.strictEqual(tooltipText({ sessions: 1, needs: 0 }), 'claude-custom · 1 session');
  assert.strictEqual(tooltipText({ sessions: 0, needs: 0 }), 'claude-custom · no sessions');
});

test('tooltipText: a count it was not given is not shown as zero', () => {
  assert.strictEqual(tooltipText({ sessions: null, needs: null }), 'claude-custom');
  assert.strictEqual(tooltipText({}), 'claude-custom');
  assert.strictEqual(tooltipText({ sessions: 2, needs: null }), 'claude-custom · 2 sessions');
  assert.strictEqual(tooltipText({ sessions: 2, needs: -1 }), 'claude-custom · 2 sessions');
  assert.strictEqual(tooltipText({ sessions: 2.5, needs: 1 }), 'claude-custom · 1 needs you');
});

test('property: the tooltip pluralises both counts correctly', () => {
  fc.assert(fc.property(fc.nat(500), fc.nat(500), (s, n) => {
    const needs = Math.min(n, s);
    const t = tooltipText({ sessions: s, needs });
    if (s === 0) assert.match(t, /no sessions/);
    else if (s === 1) assert.match(t, / 1 session(?!s)/);
    else assert.ok(t.includes(` ${s} sessions`), t);
    if (needs === 0) assert.ok(!/need/.test(t), t);
    else if (needs === 1) assert.ok(t.endsWith('1 needs you'), t);
    else assert.ok(t.endsWith(`${needs} need you`), t);
    assert.ok(t.length <= 127, 'a Windows tooltip is cut at 127 characters');
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

test('trackCues: a cue keeps the time it first appeared; a cleared one is forgotten and starts over', () => {
  let m = trackCues(new Map(), ['a'], 100);
  assert.deepStrictEqual([...m], [['a', 100]]);
  m = trackCues(m, ['a', 'b'], 200);
  assert.deepStrictEqual([...m], [['a', 100], ['b', 200]]);
  m = trackCues(m, ['b'], 300);
  assert.deepStrictEqual([...m], [['b', 200]]);
  m = trackCues(m, ['a', 'b'], 400);
  assert.strictEqual(m.get('a'), 400);
});

test('clickTarget: the oldest cue first, else the window as it was', () => {
  assert.deepStrictEqual(clickTarget(new Map([['b', 200], ['a', 100]])), { kind: 'tab', key: 'a' });
  assert.deepStrictEqual(clickTarget(new Map()), { kind: 'window' });
  assert.deepStrictEqual(clickTarget(null), { kind: 'window' });
});

test('property: the click target is always a tab with a cue, and never a younger one than another', () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.string({ minLength: 1 }), fc.nat(1000)), { maxLength: 12 }), (pairs) => {
    const cues = new Map(pairs);
    const t = clickTarget(cues);
    if (cues.size === 0) return assert.deepStrictEqual(t, { kind: 'window' });
    assert.strictEqual(t.kind, 'tab');
    assert.ok(cues.has(t.key));
    for (const since of cues.values()) assert.ok(cues.get(t.key) <= since);
  }));
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
const view = (over = {}) => ({ windowLabel: 'claude-custom', tabs: 2, needs: 0, hidden: false, startMinimised: false, windowless: [], ...over });

test('trayTemplate: the window row, hide/show, start minimised, quit', () => {
  const { actions, calls } = spy();
  const t = trayTemplate(view(), actions);
  const labels = t.filter(x => x.type !== 'separator').map(x => x.label);
  assert.deepStrictEqual(labels, ['claude-custom  ·  2 tabs', 'Hide all windows', 'Start minimised to tray', 'Quit claude-custom']);
  t.find(x => x.label === 'claude-custom  ·  2 tabs').click();
  t.find(x => x.label === 'Hide all windows').click();
  t.find(x => x.label === 'Quit claude-custom').click();
  assert.deepStrictEqual(calls, [['focus'], ['hide'], ['quit']]);
});

test('trayTemplate: a window that needs you says so; one tab is "1 tab"', () => {
  const t = trayTemplate(view({ tabs: 1, needs: 1 }), spy().actions);
  assert.strictEqual(t[0].label, 'claude-custom  ·  1 tab  ·  needs you');
  assert.strictEqual(trayTemplate(view({ tabs: 3, needs: 2 }), spy().actions)[0].label, 'claude-custom  ·  3 tabs  ·  2 need you');
});

test('trayTemplate: hidden windows offer Show all windows', () => {
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

test('trayTemplate: each windowless session has Open and "Stop that session…", wired to its own row', () => {
  const { actions, calls } = spy();
  const a = ITEM(1, 0);
  const b = ITEM(2, 0, { open: null });
  const t = trayTemplate(view({ windowless: [a, b] }), actions);
  const rows = t.filter(x => x.submenu);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0].submenu.map(s => [s.label, s.enabled]), [['Open', true], ['Stop that session…', true]]);
  assert.strictEqual(rows[1].submenu[0].enabled, false);
  rows[0].submenu[0].click();
  rows[0].submenu[1].click();
  assert.deepStrictEqual(calls, [['open', a.open], ['stop', a.row]]);
});

test('trayTemplate: & in a folder or label is shown, never read as a mnemonic', () => {
  const t = trayTemplate(view({ windowLabel: 'R&D', windowless: [ITEM(1, 0, { label: 'A & B' })] }), spy().actions);
  assert.strictEqual(t[0].label, 'R&&D  ·  2 tabs');
  assert.strictEqual(t.find(x => x.submenu).label, 'A && B');
});

test('trayTemplate: Stop that session is never silent: the row goes to stopBackground, which asks', () => {
  const { actions, calls } = spy();
  const a = ITEM(1, 0);
  trayTemplate(view({ windowless: [a] }), actions).find(x => x.submenu).submenu[1].click();
  assert.deepStrictEqual(calls, [['stop', a.row]]);
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
