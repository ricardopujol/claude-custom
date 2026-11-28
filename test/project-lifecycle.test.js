'use strict';
/**
 * app/project-lifecycle.js: opening a project window in the process and closing one (single-instance PR 2; PR #256 Miguel Y2/S3). Pure:
 * the registry is the real one, everything else is a fake that logs. What this pins is BEHAVIOUR (what a failed start leaves behind, what a
 * close drops), which the regex pins on main.js could not see (the crash-guard path once forgot the playback watch).
 * PR 3 step 3: EVERY window holds its claim, and the registry holds only windows that passed it: the claim runs before registry.add, a
 * claim that handed the launch to another process answers { pw: null, elsewhere: true } with no window, and every window that started gets
 * markReady().
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRegistry } = require('../app/project-registry');
const { createProjectLifecycle } = require('../app/project-lifecycle');

function fakeWindow(root, { startThrows = false, claimSays = 'proceed', registry = null } = {}) {
  const log = [];
  const w = { destroyed: false, destroy() { this.destroyed = true; }, isDestroyed() { return this.destroyed; } };
  return {
    root, label: root, log, win: w,
    claim: {
      async run() { log.push(['claim.run', registry ? registry.get(root) !== null : null]); return claimSays; },
      markReady() { log.push(['claim.markReady']); },
      stop() { log.push(['claim.stop']); },
    },
    async start(appStart) { log.push(['start', appStart]); if (startThrows) throw new Error('boom'); return { started: true }; },
    startPoll() { log.push(['startPoll']); },
    dispose() { log.push(['dispose']); },
    focusWindow() { log.push(['focus']); },
    showLane(cwd) { log.push(['showLane', cwd]); },
  };
}

function rig({ failing = [], elsewhere = [] } = {}) {
  const registry = createProjectRegistry();
  const events = [];
  const made = [];
  const rootOf = (cwd) => cwd.replace(/\/dev$/, '');
  const lc = createProjectLifecycle({
    registry,
    rootOf,
    makeWindow: (cwd, opts) => {
      const pw = fakeWindow(rootOf(cwd), { startThrows: failing.includes(cwd), claimSays: elsewhere.includes(cwd) ? 'exit' : 'proceed', registry });
      pw.madeWith = opts;
      made.push(pw);
      return pw;
    },
    makeRecord: (pw) => events.push(['record', pw.root]),
    stopRecord: (pw) => events.push(['stopRecord', pw.root]),
    makeUnits: (pw) => events.push(['units', pw.root]),
    dropUnits: (pw) => events.push(['dropUnits', pw.root]),
    dropWatch: (pw) => events.push(['dropWatch', pw.root]),
    dropExit: (pw) => events.push(['dropExit', pw.root]),
    getAppStart: () => ({ seams: 'appStart' }),
    afterStart: (pw) => events.push(['afterStart', pw.root]),
    log: () => {},
  });
  return { lc, registry, events, made };
}

test('the launch window: made with launch true, claimed BEFORE it is registered, its record and units before start(), its poll is whenReady\'s', async () => {
  const t = rig();
  const r = await t.lc.startProject('L', { launch: true });
  const pw = t.made[0];
  assert.strictEqual(r.pw, pw);
  assert.deepStrictEqual(pw.madeWith, { launch: true });
  assert.deepStrictEqual(r.first, { started: true });
  assert.deepStrictEqual(pw.log[0], ['claim.run', false], 'the claim ran while the window was not in the registry');
  assert.deepStrictEqual(t.events.slice(0, 2), [['record', 'L'], ['units', 'L']]);
  assert.deepStrictEqual(pw.log.map(([k]) => k), ['claim.run', 'start', 'claim.markReady'], 'no startPoll: whenReady starts it');
  assert.strictEqual(t.registry.size(), 1);
  assert.deepStrictEqual(t.events.at(-1), ['afterStart', 'L']);
});

test('PR 3: a claim that handed the launch to another process answers { pw: null, elsewhere: true }: no window registered, started or kept', async () => {
  const t = rig({ elsewhere: ['B/dev'] });
  const r = await t.lc.startProject('B/dev');
  assert.deepStrictEqual(r, { pw: null, existing: false, first: null, elsewhere: true });
  assert.strictEqual(t.registry.size(), 0);
  assert.ok(!t.made[0].log.some(([k]) => k === 'start'), 'never started');
  assert.ok(t.made[0].log.some(([k]) => k === 'dispose'), 'its construction is disposed');
  assert.deepStrictEqual(t.events, [], 'no record, no units');
  const l = await t.lc.startProject('B/dev', { launch: true });
  assert.strictEqual(l.elsewhere, true, 'the launch window too');
});

test('the launch window\'s failure is rethrown and cleans nothing (whenReady exits on it)', async () => {
  const t = rig({ failing: ['L'] });
  await assert.rejects(() => t.lc.startProject('L', { launch: true }), /boom/);
  assert.strictEqual(t.registry.size(), 1);
  assert.ok(!t.events.some(([k]) => k === 'stopRecord' || k === 'dropUnits' || k === 'dropWatch'));
});

test('another project: a window of its own (launch false), claimed, registered, its record and units first, then started, ready and polled', async () => {
  const t = rig();
  await t.lc.startProject('L', { launch: true });
  const r = await t.lc.startProject('B/dev');
  assert.strictEqual(r.existing, false);
  assert.strictEqual(t.registry.size(), 2);
  assert.deepStrictEqual(t.made[1].madeWith, { launch: false });
  assert.deepStrictEqual(t.made[1].log.map(([k]) => k), ['claim.run', 'start', 'claim.markReady', 'startPoll']);
  assert.deepStrictEqual(t.events.filter(([, r]) => r === 'B'), [['record', 'B'], ['units', 'B'], ['afterStart', 'B']]);
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

test('Y2: a start that fails leaves nothing behind: not registered, no record, no units, NO PLAYBACK WATCH, no exit hook, disposed, its window destroyed; the others stay', async () => {
  const t = rig({ failing: ['X'] });
  await t.lc.startProject('L', { launch: true });
  await t.lc.startProject('B/dev');
  const r = await t.lc.startProject('X');
  assert.strictEqual(r.pw, null);
  assert.match(r.error, /boom/);
  assert.strictEqual(t.registry.get('X'), null);
  assert.strictEqual(t.registry.size(), 2, 'L and B are still there');
  const x = t.made[2];
  assert.deepStrictEqual(t.events.filter(([, root]) => root === 'X').map(([k]) => k), ['record', 'units', 'stopRecord', 'dropUnits', 'dropWatch', 'dropExit']);
  assert.ok(x.log.some(([k]) => k === 'dispose'));
  assert.ok(!x.log.some(([k]) => k === 'claim.markReady'), 'a window that failed is never ready for launches');
  assert.strictEqual(x.win.destroyed, true);
  assert.ok(!t.events.some(([k, root]) => root === 'B' && /^(stop|drop)/.test(k)), 'B was not touched');
});

test('closing: a window of several is disposed and everything held for it dropped (its exit hook too), once; the last is left alone for the quit path (P3)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const t = rig();
    const wins = [];
    for (const r of ['L', 'A', 'B', 'C']) { const pw = fakeWindow(r); t.registry.add(pw); wins.push(pw); }
    const order = [...wins].sort(() => (Math.sin(seed * 9301 + wins.length) > 0 ? 1 : -1)).sort((a, b) => ((a.root.charCodeAt(0) * seed) % 7) - ((b.root.charCodeAt(0) * seed) % 7));
    let changed = 0;
    const lc = createProjectLifecycle({
      registry: t.registry, rootOf: (c) => c, makeWindow: () => null,
      makeRecord() {}, stopRecord: (pw) => t.events.push(['stopRecord', pw.root]), makeUnits() {}, dropUnits: (pw) => t.events.push(['dropUnits', pw.root]),
      dropWatch: (pw) => t.events.push(['dropWatch', pw.root]), dropExit: (pw) => t.events.push(['dropExit', pw.root]),
      getAppStart: () => null, afterStart() {}, log() {}, onChanged: () => { changed++; },
    });
    for (const pw of order) lc.projectClosed(pw);
    const disposed = wins.filter((w) => w.log.some(([k]) => k === 'dispose'));
    assert.strictEqual(disposed.length, 3, `exactly N-1 disposed (seed ${seed})`);
    assert.strictEqual(t.registry.size(), 1, 'the last stays registered');
    for (const k of ['stopRecord', 'dropWatch', 'dropUnits', 'dropExit']) assert.strictEqual(t.events.filter(([e]) => e === k).length, 3, k);
    assert.strictEqual(changed, 4, 'the tray and the Resources sampler are told on every close, even the last');
    lc.projectClosed(order[0]);                  // closed twice: nothing is dropped twice
    assert.strictEqual(t.events.filter(([k]) => k === 'stopRecord').length, 3);
  }
});

test('Jiandu Home: projectClosed asks othersStay(): with Home open the last project window is dropped and disposed, and onChanged runs', async () => {
  const registry = createProjectRegistry();
  const events = [];
  let stays = true;
  const lc = createProjectLifecycle({
    registry, rootOf: (c) => c, makeWindow: (cwd) => fakeWindow(cwd, { registry }),
    makeRecord: () => {}, stopRecord: (pw) => events.push(['stopRecord', pw.root]), makeUnits: () => {}, dropUnits: () => {},
    dropWatch: () => {}, getAppStart: () => ({}), othersStay: () => stays, onChanged: () => events.push(['changed']), log: () => {},
  });
  const { pw } = await lc.startProject('A');
  events.length = 0;
  lc.projectClosed(pw);
  assert.strictEqual(registry.size(), 0);
  assert.deepStrictEqual(events, [['stopRecord', 'A'], ['changed']]);
  assert.ok(pw.log.some((e) => e[0] === 'dispose'));
  stays = false;
  const second = await lc.startProject('B');
  lc.projectClosed(second.pw);
  assert.strictEqual(registry.size(), 1, 'no Home: the last window is left for window-all-closed, as before');
});
