'use strict';
/** P5 (single-instance PR 2, step 6): Resources is minimised exactly when every window is minimised or hidden, in any interleaving. */
const test = require('node:test');
const assert = require('node:assert');
const { createSeenGate } = require('../app/seen-gate');
const { createProjectRegistry } = require('../app/project-registry');

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const fakeWin = (root) => ({ root, unseen: false, isUnseen() { return this.unseen; }, isStrip: () => false, isTabView: () => false, canvasViews: { isPanel: () => false } });

test('P5: after any interleaving of minimise / restore / hide / show across N windows, minimised === every window unseen', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const rand = rng(seed);
    const n = 1 + Math.floor(rand() * 4);
    const registry = createProjectRegistry();
    const wins = Array.from({ length: n }, (_, i) => registry.add(fakeWin(`W${i}`)));
    const resources = { minimised: null, setMinimised(v) { this.minimised = v; } };
    const seenChanged = createSeenGate({ registry, getResources: () => resources });
    for (let step = 0; step < 25; step++) {
      const w = wins[Math.floor(rand() * n)];
      w.unseen = rand() < 0.5;
      seenChanged();
      assert.strictEqual(resources.minimised, wins.every((x) => x.unseen), `seed ${seed} step ${step}`);
    }
  }
});

test('one window minimising does not sleep the sampler while another is in view', () => {
  const registry = createProjectRegistry();
  const a = registry.add(fakeWin('A')); const b = registry.add(fakeWin('B'));
  const resources = { minimised: null, setMinimised(v) { this.minimised = v; } };
  const seenChanged = createSeenGate({ registry, getResources: () => resources });
  a.unseen = true; seenChanged();
  assert.strictEqual(resources.minimised, false);
  b.unseen = true; seenChanged();
  assert.strictEqual(resources.minimised, true);
  a.unseen = false; seenChanged();
  assert.strictEqual(resources.minimised, false);
});

test('before the Resources service exists, a change is a no-op', () => {
  const registry = createProjectRegistry(); registry.add(fakeWin('A'));
  assert.doesNotThrow(() => createSeenGate({ registry, getResources: () => null })());
});

// PR #256 Dexter 1 / 8: the property drives the gate ONLY through the events the real code hooks (a window's minimise / restore / hide / show
// call it; opening a window goes through the lifecycle, closing through projectClosed), so a transition nobody hooked makes it fail.
const { createProjectLifecycle } = require('../app/project-lifecycle');

test('P5 with opens and closes: Resources is minimised exactly when every window is unseen, after every step the real code hooks', async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed);
    const registry = createProjectRegistry();
    const resources = { minimised: null, setMinimised(v) { this.minimised = v; } };
    const seenChanged = createSeenGate({ registry, getResources: () => resources });
    let n = 0;
    // PR 3: every window holds a claim (here one that always proceeds), and the lifecycle registers it, the launch window too
    const claim = { run: async () => 'proceed', markReady() {}, stop() {} };
    const mk = () => { const w = { ...fakeWin(`W${n++}`), unseen: false, claim, async start() { return { started: true }; }, startPoll() {}, dispose() {}, focusWindow() {}, win: null }; return w; };
    const lc = createProjectLifecycle({
      registry, rootOf: (c) => c, makeWindow: () => mk(),
      makeRecord() {}, stopRecord() {}, makeUnits() {}, dropUnits() {}, dropWatch() {}, getAppStart: () => null, log() {},
      onChanged: seenChanged,
    });
    await lc.startProject('L', { launch: true });
    let opened = 0;
    for (let step = 0; step < 30; step++) {
      const wins = registry.list();
      const r = rand();
      if (r < 0.5) {                                   // a window's own minimise / restore / hide / show event
        const w = wins[Math.floor(rand() * wins.length)];
        w.unseen = rand() < 0.5;
        seenChanged();
      } else if (r < 0.8) {                            // open a project; it comes up visible, or unseen (started minimised), and fires no event of its own
        const created = (await lc.startProject(`P${opened++}`)).pw;
        void created;
      } else if (wins.length > 1) {                    // a window closes while another stays
        lc.projectClosed(wins[Math.floor(rand() * wins.length)]);
      }
      assert.strictEqual(resources.minimised, registry.list().every((x) => x.unseen), `seed ${seed} step ${step}`);
    }
  }
});
