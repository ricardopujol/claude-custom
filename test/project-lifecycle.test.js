'use strict';
/**
 * app/project-lifecycle.js: opening a project window in the process and closing one (single-instance PR 2; PR #256 Miguel Y2/S3). Pure:
 * the registry is the real one, everything else is a fake that logs. What this pins is BEHAVIOUR (what a failed start leaves behind, what a
 * close drops), which the regex pins on main.js could not see (the crash-guard path once forgot the playback watch).
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRegistry } = require('../app/project-registry');
const { createProjectLifecycle } = require('../app/project-lifecycle');

function fakeWindow(root, { startThrows = false } = {}) {
  const log = [];
  const w = { destroyed: false, destroy() { this.destroyed = true; }, isDestroyed() { return this.destroyed; } };
  return {
    root, label: root, log, win: w,
    async start(appStart) { log.push(['start', appStart]); if (startThrows) throw new Error('boom'); return { started: true }; },
    startPoll() { log.push(['startPoll']); },
    dispose() { log.push(['dispose']); },
    focusWindow() { log.push(['focus']); },
    showLane(cwd) { log.push(['showLane', cwd]); },
  };
}

function rig({ launchOpts, failing = [] } = {}) {
  const registry = createProjectRegistry();
  const launchWindow = fakeWindow('L', launchOpts);
  registry.add(launchWindow);
  const events = [];
  const made = [];
  const lc = createProjectLifecycle({
    registry, launchWindow,
    rootOf: (cwd) => cwd.replace(/\/dev$/, ''),
    makeWindow: (cwd) => { const pw = fakeWindow(cwd.replace(/\/dev$/, ''), { startThrows: failing.includes(cwd) }); made.push(pw); return pw; },
    makeRecord: (pw) => events.push(['record', pw.root]),
    stopRecord: (pw) => events.push(['stopRecord', pw.root]),
    makeUnits: (pw) => events.push(['units', pw.root]),
    dropUnits: (pw) => events.push(['dropUnits', pw.root]),
    dropWatch: (pw) => events.push(['dropWatch', pw.root]),
    getAppStart: () => ({ seams: 'appStart' }),
    afterStart: (pw) => events.push(['afterStart', pw.root]),
    log: () => {},
  });
  return { lc, registry, launchWindow, events, made };
}

test('the launch window: its record and units exist before start(), it is not added again, and its poll is whenReady\'s', async () => {
  const t = rig();
  const r = await t.lc.startProject('L', { launch: true });
  assert.strictEqual(r.pw, t.launchWindow);
  assert.deepStrictEqual(r.first, { started: true });
  assert.deepStrictEqual(t.events.slice(0, 2), [['record', 'L'], ['units', 'L']]);
  assert.deepStrictEqual(t.launchWindow.log, [['start', { seams: 'appStart' }]], 'no startPoll: whenReady starts it after the claim is ready');
  assert.strictEqual(t.registry.size(), 1);
  assert.deepStrictEqual(t.events.at(-1), ['afterStart', 'L']);
});

test('the launch window\'s failure is rethrown and cleans nothing (whenReady exits on it)', async () => {
  const t = rig({ launchOpts: { startThrows: true } });
  await assert.rejects(() => t.lc.startProject('L', { launch: true }), /boom/);
  assert.strictEqual(t.registry.size(), 1);
  assert.ok(!t.events.some(([k]) => k === 'stopRecord' || k === 'dropUnits' || k === 'dropWatch'));
});

test('another project: a window of its own, registered, its record and units first, then started and polled', async () => {
  const t = rig();
  const r = await t.lc.startProject('B/dev');
  assert.strictEqual(r.existing, false);
  assert.strictEqual(t.registry.size(), 2);
  assert.deepStrictEqual(t.made[0].log.map(([k]) => k), ['start', 'startPoll']);
  assert.deepStrictEqual(t.events, [['record', 'B'], ['units', 'B'], ['afterStart', 'B']]);
});

test('S3: a project that already has a window builds NO window; the open one is brought forward and shows the cwd\'s lane', async () => {
  const t = rig();
  await t.lc.startProject('B/dev');
  const before = t.made.length;
  const r = await t.lc.startProject('B');
  assert.strictEqual(t.made.length, before, 'no second window was constructed');
  assert.strictEqual(r.existing, true);
  assert.strictEqual(r.pw, t.made[0]);
  assert.deepStrictEqual(t.made[0].log.filter(([k]) => k === 'focus' || k === 'showLane'), [['focus'], ['showLane', 'B']]);
});

test('Y2: a start that fails leaves nothing behind: not registered, no record, no units, NO PLAYBACK WATCH, disposed, its window destroyed; the others stay', async () => {
  const t = rig({ failing: ['X'] });
  await t.lc.startProject('B/dev');
  const r = await t.lc.startProject('X');
  assert.strictEqual(r.pw, null);
  assert.match(r.error, /boom/);
  assert.strictEqual(t.registry.get('X'), null);
  assert.strictEqual(t.registry.size(), 2, 'L and B are still there');
  const x = t.made[1];
  assert.deepStrictEqual(t.events.filter(([, root]) => root === 'X').map(([k]) => k), ['record', 'units', 'stopRecord', 'dropUnits', 'dropWatch']);
  assert.ok(x.log.some(([k]) => k === 'dispose'));
  assert.strictEqual(x.win.destroyed, true);
  assert.ok(!t.events.some(([k, root]) => root === 'B' && /^(stop|drop)/.test(k)), 'B was not touched');
});

test('closing: a window of several is disposed and everything held for it dropped, once; the last is left alone for the quit path (P3)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const t = rig();
    const wins = [t.launchWindow];
    for (const r of ['A', 'B', 'C']) { const pw = fakeWindow(r); t.registry.add(pw); wins.push(pw); }
    const order = [...wins].sort(() => (Math.sin(seed * 9301 + wins.length) > 0 ? 1 : -1)).sort((a, b) => ((a.root.charCodeAt(0) * seed) % 7) - ((b.root.charCodeAt(0) * seed) % 7));
    let changed = 0;
    const lc = createProjectLifecycle({
      registry: t.registry, launchWindow: t.launchWindow, rootOf: (c) => c, makeWindow: () => null,
      makeRecord() {}, stopRecord: (pw) => t.events.push(['stopRecord', pw.root]), makeUnits() {}, dropUnits: (pw) => t.events.push(['dropUnits', pw.root]),
      dropWatch: (pw) => t.events.push(['dropWatch', pw.root]), getAppStart: () => null, afterStart() {}, log() {}, onChanged: () => { changed++; },
    });
    for (const pw of order) lc.projectClosed(pw);
    const disposed = wins.filter((w) => w.log.some(([k]) => k === 'dispose'));
    assert.strictEqual(disposed.length, 3, `exactly N-1 disposed (seed ${seed})`);
    assert.strictEqual(t.registry.size(), 1, 'the last stays registered');
    assert.strictEqual(t.events.filter(([k]) => k === 'stopRecord').length, 3);
    assert.strictEqual(t.events.filter(([k]) => k === 'dropWatch').length, 3);
    assert.strictEqual(t.events.filter(([k]) => k === 'dropUnits').length, 3);
    assert.strictEqual(changed, 4, 'the tray and the Resources sampler are told on every close, even the last');
    lc.projectClosed(order[0]);                  // closed twice: nothing is dropped twice
    assert.strictEqual(t.events.filter(([k]) => k === 'stopRecord').length, 3);
  }
});
