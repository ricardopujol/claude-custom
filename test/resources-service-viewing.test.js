'use strict';
/**
 * app/resources-service.js (BACKLOG #100 c): which pages are SHOWING the Resources panel. The shared poller samples every
 * 10 s while any window shows it and every 30 s while only the chip is in view, so the service now tells the sampler.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const S = require('../app/resources-service');

function rig() {
  const wanted = [];
  const svc = S.createResourcesService({
    sampler: { setWanted: (w) => wanted.push(w), sampleNow: async () => null, snapshot: () => null },
    tabs: () => [], claims: () => [], installDirs: () => [], ownPid: 10, cores: 4, send: () => {}, kill: async () => [], now: () => 5000,
  });
  return { svc, wanted };
}

test('no page shows the panel: the sampler is told the old two keys and nothing more', () => {
  const r = rig();
  r.svc.refresh();
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true });
});

test('a page that shows the panel makes the sampler hear `viewing`; hiding it again takes it away', () => {
  const r = rig();
  r.svc.setViewing(7, true);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true, viewing: true });
  r.svc.setViewing(7, false);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true });
});

test('any page showing it is enough, and every page must stop showing it', () => {
  const r = rig();
  r.svc.setViewing(1, true);
  r.svc.setViewing(2, true);
  r.svc.setViewing(1, false);
  assert.strictEqual(r.wanted.at(-1).viewing, true);
  r.svc.setViewing(2, false);
  assert.strictEqual(r.wanted.at(-1).viewing, undefined);
});

test('a page that is closed no longer counts: forgetViewer drops it', () => {
  const r = rig();
  r.svc.setViewing(3, true);
  r.svc.forgetViewer(3);
  assert.strictEqual(r.wanted.at(-1).viewing, undefined);
});

test('a minimised window wants nothing, whatever its pages say', () => {
  const r = rig();
  r.svc.setViewing(1, true);
  r.svc.setMinimised(true);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: false, chip: false });
  r.svc.setMinimised(false);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true, viewing: true });
});

test('only a real boolean counts as "showing"', () => {
  const r = rig();
  r.svc.setViewing(1, 'yes');
  r.svc.setViewing(2, 1);
  r.svc.setViewing(3, undefined);
  assert.strictEqual(r.wanted.at(-1).viewing, undefined);
});

test('property: `viewing` is told exactly when the window is not minimised and some page shows the panel', () => {
  fc.assert(fc.property(
    fc.array(fc.oneof(
      fc.record({ k: fc.constant('view'), id: fc.integer({ min: 1, max: 4 }), on: fc.boolean() }),
      fc.record({ k: fc.constant('forget'), id: fc.integer({ min: 1, max: 4 }) }),
      fc.record({ k: fc.constant('min'), on: fc.boolean() })), { maxLength: 20 }),
    (steps) => {
      const r = rig();
      const model = new Map();
      let minimised = false;
      for (const s of steps) {
        if (s.k === 'view') { r.svc.setViewing(s.id, s.on); if (s.on) model.set(s.id, true); else model.delete(s.id); }
        else if (s.k === 'forget') { r.svc.forgetViewer(s.id); model.delete(s.id); }
        else { r.svc.setMinimised(s.on); minimised = s.on; }
      }
      if (r.wanted.length === 0) return;
      const w = r.wanted.at(-1);
      assert.strictEqual(w.viewing === true, !minimised && model.size > 0);
      assert.strictEqual(w.panel, !minimised);
    }));
});
