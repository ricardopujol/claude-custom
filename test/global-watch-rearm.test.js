'use strict';
/**
 * Dexter N4 (PR #64 round 2): the _global watcher died with its folder and was
 * never re-armed, so after the folder was deleted (Explorer, a cleanup tool)
 * other windows stopped following global changes for the life of their host.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { watchGlobalDir } = require('../host/global-watch');

function rig() {
  const r = { watchers: [], made: 0, timers: [], changes: 0, logs: [] };
  r.deps = {
    mkdirSync: () => { r.made += 1; },
    watch: (dir, h) => {
      const w = new EventEmitter();
      w.close = () => { w.closed = true; };
      w.handler = h;
      r.watchers.push(w);
      return w;
    },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; r.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    log: (...a) => r.logs.push(a.join(' ')),
    rearmMs: 1000,
  };
  r.fire = (t) => { if (t.live) { t.live = false; t.fn(); } };
  return r;
}

test('N4: an error on the watcher re-creates the folder, watches again, and reports the change', () => {
  const r = rig();
  watchGlobalDir('/x/_global', () => { r.changes += 1; }, r.deps);
  assert.strictEqual(r.watchers.length, 1);
  r.watchers[0].emit('error', new Error('EPERM'));
  assert.strictEqual(r.watchers[0].closed, true, 'the dead watcher is closed');
  const rearm = r.timers.find(t => t.ms === 1000);
  assert.ok(rearm, 're-arming is scheduled, not immediate (no tight loop)');
  r.fire(rearm);
  assert.strictEqual(r.made, 2, 'the folder is created again');
  assert.strictEqual(r.watchers.length, 2, 'and watched again');
  const debounce = r.timers.filter(t => t.live && t.ms !== 1000);
  assert.strictEqual(debounce.length, 1, 'the deletion itself is a change: a repaint is queued');
  r.fire(debounce[0]);
  assert.strictEqual(r.changes, 1);
});

test('N4: after re-arming, a later change still calls onChange', () => {
  const r = rig();
  watchGlobalDir('/x/_global', () => { r.changes += 1; }, r.deps);
  r.watchers[0].emit('error', new Error('EPERM'));
  r.fire(r.timers.find(t => t.ms === 1000));
  r.watchers[1].handler('change', 'default.png');
  const t = r.timers.filter(x => x.live).pop();
  r.fire(t);
  assert.ok(r.changes >= 1);
});

test('N4: a rename event that names the folder itself also re-arms', () => {
  const r = rig();
  watchGlobalDir('/x/_global', () => {}, r.deps);
  r.watchers[0].handler('rename', '_global');
  assert.ok(r.timers.find(t => t.ms === 1000 && t.live));
});

test('N4: a rename of a file inside the folder does not re-arm', () => {
  const r = rig();
  watchGlobalDir('/x/_global', () => {}, r.deps);
  r.watchers[0].handler('rename', 'default.png');
  assert.strictEqual(r.timers.find(t => t.ms === 1000), undefined);
});

test('N4: if re-arming fails it tries again later, and says so', () => {
  const r = rig();
  let fail = true;
  const realWatch = r.deps.watch;
  r.deps.watch = (d, h) => { if (fail && r.watchers.length >= 1) throw new Error('ENOENT'); return realWatch(d, h); };
  watchGlobalDir('/x/_global', () => {}, r.deps);
  r.watchers[0].emit('error', new Error('gone'));
  r.fire(r.timers.find(t => t.ms === 1000 && t.live));
  assert.match(r.logs.join('\n'), /cannot watch/);
  const again = r.timers.filter(t => t.ms === 1000 && t.live);
  assert.strictEqual(again.length, 1, 'another attempt is scheduled');
  fail = false;
  r.fire(again[0]);
  assert.strictEqual(r.watchers.length, 2);
});

test('N4: close() cancels a pending re-arm', () => {
  const r = rig();
  const h = watchGlobalDir('/x/_global', () => {}, r.deps);
  r.watchers[0].emit('error', new Error('EPERM'));
  const rearm = r.timers.find(t => t.ms === 1000);
  h.close();
  r.fire(rearm);
  assert.strictEqual(r.watchers.length, 1);
});
