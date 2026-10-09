'use strict';
/**
 * BACKLOG #74 H: a probe that kills host pids it only READ (identity files, the app's state) holds no handle, so the
 * pid may be reused by the time it kills. createSeenPids records each pid's start time and ends it only through
 * killProven(pid, start) (the start proven again on a held handle), never by pid alone.
 *
 * Two ways in, and they differ on purpose (PR #135 Dexter 2/3, Miguel 1/3):
 *   see(pid)          an EARLY sighting (the app's state while the probe runs): the start is read now.
 *   add(pid, start)   a RECORDED start (an identity file's processStartedAt, or one read earlier): stored as given, never
 *                     read fresh -- a read at cleanup time would prove only the suspect's own start (circular).
 */
const test = require('node:test');
const assert = require('node:assert');
const { createSeenPids } = require('../verify/lib/seen-pids');

const rig = (starts = {}, answers = {}) => {
  const proven = [];
  const logs = [];
  const reads = [];
  const seen = createSeenPids({
    startOf: (pid) => { reads.push(pid); return starts[pid] || null; },
    prove: (pid, start) => { proven.push([pid, start]); return answers[pid] || 'killed'; },
    log: (m) => logs.push(m),
  });
  return { seen, proven, logs, reads };
};

test('endAll ends each pid through the proven kill, with the start recorded when it was first seen', () => {
  const { seen, proven } = rig({ 10: '111' });
  seen.see(10);
  seen.add(11, '999');
  seen.endAll();
  assert.deepStrictEqual(proven, [[10, '111'], [11, '999']]);
});

test('a pid seen again later keeps its FIRST fresh start (a reused pid must not adopt the newcomer)', () => {
  const starts = { 10: '111' };
  const { seen, proven } = rig(starts);
  seen.see(10);
  starts[10] = '555';
  seen.see(10);
  seen.endAll();
  assert.deepStrictEqual(proven, [[10, '111']]);
});

test('add(pid, start) with no start never reads one: a start-less identity entry is not killed on a fresh read (Dexter 2)', () => {
  const { seen, proven, reads, logs } = rig({ 10: 'STRANGER' });
  seen.add(10, undefined);
  seen.endAll();
  assert.deepStrictEqual(reads, []);
  assert.deepStrictEqual(proven, []);
  assert.ok(logs.some(l => /10/.test(l) && /no proven start/.test(l)), 'the skip is logged');
});

test('an identity file\'s recorded start replaces a failed or earlier fresh read (Dexter 3)', () => {
  const a = rig({});                                  // the fresh read failed
  a.seen.see(10);
  a.seen.add(10, '111');
  a.seen.endAll();
  assert.deepStrictEqual(a.proven, [[10, '111']]);
  const b = rig({ 10: '222' });                       // an earlier fresh read exists; the host's own start wins
  b.seen.see(10);
  b.seen.add(10, '111');
  b.seen.endAll();
  assert.deepStrictEqual(b.proven, [[10, '111']]);
});

test('a recorded start is not replaced by a later one', () => {
  const { seen, proven } = rig({});
  seen.add(10, '111');
  seen.add(10, '222');
  seen.endAll();
  assert.deepStrictEqual(proven, [[10, '111']]);
});

test('a failed fresh read is retried on the next sighting (Miguel 1)', () => {
  const starts = {};
  const { seen, proven } = rig(starts);
  seen.see(10);
  starts[10] = '111';
  seen.see(10);
  seen.endAll();
  assert.deepStrictEqual(proven, [[10, '111']]);
});

test('a pid whose start could never be read is not killed, and says so', () => {
  const { seen, proven, logs } = rig({});
  seen.see(10);
  const r = seen.endAll();
  assert.deepStrictEqual(proven, []);
  assert.deepStrictEqual(r.left, [10]);
  assert.ok(logs.some(l => /10/.test(l) && /no proven start/.test(l)));
});

test('invalid pids are ignored; endAll twice kills once', () => {
  const { seen, proven } = rig({ 10: '1' });
  seen.see(undefined); seen.see(0); seen.see(-3); seen.see('7'); seen.add(NaN, '1'); seen.see(10);
  seen.endAll();
  seen.endAll();
  assert.deepStrictEqual(proven, [[10, '1']]);
});

test('kill(pid) ends just that recorded pid, once; an unrecorded pid is not touched', () => {
  const { seen, proven } = rig({ 10: '1', 11: '2' });
  seen.see(10); seen.see(11);
  seen.kill(10);
  seen.kill(10);
  seen.kill(99);
  seen.endAll();
  assert.deepStrictEqual(proven, [[10, '1'], [11, '2']]);
});

// The proven kill's answer is used (Miguel 2): only 'killed', 'gone' and 'mismatch' close the entry.
for (const [answer, closes] of [['killed', true], ['gone', true], ['mismatch', true], ['failed', false], ['unknown', false]]) {
  test(`proven kill answers '${answer}': the entry ${closes ? 'is closed' : 'stays, and is reported as left'}`, () => {
    const { seen, proven, logs } = rig({ 10: '1' }, { 10: answer });
    seen.see(10);
    const first = seen.endAll();
    assert.deepStrictEqual(first.left, closes ? [] : [10]);
    if (answer !== 'killed' && answer !== 'gone') assert.ok(logs.some(l => l.includes(answer) && /10/.test(l)), `${answer} is logged`);
    seen.endAll();
    assert.strictEqual(proven.length, closes ? 1 : 2, closes ? 'a closed entry is not killed again' : 'an unlanded kill is retried');
  });
}

test('a throwing proven kill keeps its entry, is logged, and does not stop the rest', () => {
  const proven = [];
  const logs = [];
  const seen = createSeenPids({ startOf: () => '1', prove: (pid) => { if (pid === 10) throw new Error('x'); proven.push(pid); return 'killed'; }, log: (m) => logs.push(m) });
  seen.see(10); seen.see(11);
  const r = seen.endAll();
  assert.deepStrictEqual(proven, [11]);
  assert.deepStrictEqual(r.left, [10]);
  assert.ok(logs.some(l => /10/.test(l)));
});

// ---- source rules over the probes ---------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const VERIFY = path.join(__dirname, '..', 'verify');
const probes = () => fs.readdirSync(VERIFY).filter(f => /^probe-.*\.js$/.test(f)).map(f => [f, fs.readFileSync(path.join(VERIFY, f), 'utf8')]);

test('rule: no probe calls add(pid) with a bare pid (a start-less add records nothing to prove); see(pid) is the early-sighting form', () => {
  const bad = [];
  for (const [f, src] of probes()) {
    src.split(/\r?\n/).forEach((line, i) => {
      if (/\b(?:seenPids|hostSeen)\.add\(\s*[^,()]+\)/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepStrictEqual(bad, []);
});

test('the occupancy probe ends the dev host with the start it read at check 2, not one read at the kill (Dexter 2)', () => {
  const src = fs.readFileSync(path.join(VERIFY, 'probe-worktree-occupancy.js'), 'utf8');
  assert.match(src, /seenPids\.add\(killing, ownStart\)/);
});
