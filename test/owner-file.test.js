'use strict';
/**
 * The owner-file core (single-instance PR 3, step 0): the proof that host/window-owner.js tied to `<stateRoot>\.claude-custom\window.json`,
 * made generic over a plain file, so the app lock (host/app-owner.js, `<dir>\app.json`) uses the same proof and not a copy.
 * Every test here runs against a file in a temp folder with NO `.claude-custom` folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const load = () => require('../host/owner-file');

const START_A = '133800000000000001';
const START_B = '133800000000000002';
const live = (pid, start) => async () => new Map([[pid, start]]);
const none = async () => new Map();

function plain() {
  const dir = tmpDir('cc-owner-file-');
  return { dir, file: path.join(dir, 'owner.json'), usable: () => true, prepare: () => fs.mkdirSync(dir, { recursive: true }) };
}
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

test('claimFile on a plain folder: no file -> proceed and publish this process', async () => {
  const { claimFile } = load();
  const f = plain();
  const r = await claimFile({ ...f, self: { pid: 20, start: START_A }, startTimes: none, now: () => 5 });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(r.reason, 'no-owner');
  assert.strictEqual(r.published, true);
  assert.deepStrictEqual(JSON.parse(read(f.file)), { pid: 20, start: START_A, at: 5 });
  assert.ok(!fs.existsSync(path.join(f.dir, '.claude-custom')), 'the core never makes a look folder');
});

test('claimFile: a live owner -> focus, with the judged bytes, and the file untouched', async () => {
  const { claimFile } = load();
  const f = plain();
  const text = JSON.stringify({ pid: 10, start: START_B, at: 1 });
  fs.writeFileSync(f.file, text);
  const r = await claimFile({ ...f, self: { pid: 20, start: START_A }, startTimes: live(10, START_B) });
  assert.strictEqual(r.action, 'focus');
  assert.strictEqual(r.owner.pid, 10);
  assert.strictEqual(r.text, text);
  assert.strictEqual(read(f.file), text);
});

test('claimFile: a dead owner (pid gone, or reused with another start) -> proceed and take the file over', async () => {
  const { claimFile } = load();
  for (const startTimes of [none, live(10, START_A)]) {
    const f = plain();
    fs.writeFileSync(f.file, JSON.stringify({ pid: 10, start: START_B }));
    const r = await claimFile({ ...f, self: { pid: 20, start: START_A }, startTimes });
    assert.strictEqual(r.reason, 'dead-owner');
    assert.strictEqual(r.published, true);
    assert.strictEqual(JSON.parse(read(f.file)).pid, 20);
  }
});

test('claimFile: an owner that cannot be proved -> proceed, and the live-maybe owner keeps its file', async () => {
  const { claimFile } = load();
  const f = plain();
  const text = JSON.stringify({ pid: 10, start: START_B });
  fs.writeFileSync(f.file, text);
  const r = await claimFile({ ...f, self: { pid: 20, start: START_A }, startTimes: async () => null });
  assert.strictEqual(r.reason, 'unproven-owner');
  assert.strictEqual(r.published, false);
  assert.strictEqual(read(f.file), text);
});

test('claimFile: an unusable place -> proceed, nothing written, the caller names the reason', async () => {
  const { claimFile } = load();
  const f = plain();
  const r = await claimFile({ ...f, usable: () => false, unusableReason: 'foreign-dir', self: { pid: 20, start: START_A }, startTimes: none });
  assert.deepStrictEqual(r, { action: 'proceed', reason: 'foreign-dir', file: null, published: false });
  assert.strictEqual(read(f.file), null);
});

test('claimFile: no start time for this process -> proceed and publish nothing', async () => {
  const { claimFile } = load();
  const f = plain();
  const r = await claimFile({ ...f, self: { pid: 20, start: null }, startTimes: none });
  assert.strictEqual(r.reason, 'no-self-start');
  assert.strictEqual(r.published, false);
  assert.strictEqual(read(f.file), null);
});

test('claimFile: the publish race -- a file that appears between the read and the publish wins (hard link, one winner)', async () => {
  const { claimFile } = load();
  const f = plain();
  let raced = false;
  const r = await claimFile({
    ...f, self: { pid: 20, start: START_A }, startTimes: live(10, START_B),
    hooks: { beforePublish: () => { if (!raced) { raced = true; fs.writeFileSync(f.file, JSON.stringify({ pid: 10, start: START_B })); } } },
  });
  assert.strictEqual(r.action, 'focus', 'the loser re-reads and finds the winner');
  assert.strictEqual(r.owner.pid, 10);
  assert.strictEqual(JSON.parse(read(f.file)).pid, 10);
});

test('takeOverFile: replaces only the judged bytes; a file someone else wrote since is left alone', () => {
  const { takeOverFile } = load();
  const f = plain();
  const judged = JSON.stringify({ pid: 10, start: START_B });
  fs.writeFileSync(f.file, judged);
  assert.strictEqual(takeOverFile({ ...f, self: { pid: 20, start: START_A }, judgedText: judged }), true);
  assert.strictEqual(JSON.parse(read(f.file)).pid, 20);

  const g = plain();
  const newer = JSON.stringify({ pid: 30, start: START_B });
  fs.writeFileSync(g.file, newer);
  assert.strictEqual(takeOverFile({ ...g, self: { pid: 20, start: START_A }, judgedText: judged }), false);
  assert.strictEqual(read(g.file), newer);
});

test('takeOverFile: unusable place, or no start time -> false and nothing written', () => {
  const { takeOverFile } = load();
  const f = plain();
  assert.strictEqual(takeOverFile({ ...f, usable: () => false, self: { pid: 20, start: START_A } }), false);
  assert.strictEqual(takeOverFile({ ...f, self: { pid: 20, start: null } }), false);
  assert.strictEqual(read(f.file), null);
});

test('releaseFile: removes the file only while it names this process by pid AND start', () => {
  const { releaseFile } = load();
  const f = plain();
  fs.writeFileSync(f.file, JSON.stringify({ pid: 20, start: START_A }));
  assert.strictEqual(releaseFile({ file: f.file, selfPid: 20, selfStart: START_B }), false);
  assert.ok(fs.existsSync(f.file));
  assert.strictEqual(releaseFile({ file: f.file, selfPid: 21, selfStart: START_A }), false);
  assert.strictEqual(releaseFile({ file: f.file, selfPid: 20, selfStart: START_A }), true);
  assert.ok(!fs.existsSync(f.file));
  assert.strictEqual(releaseFile({ file: f.file, selfPid: 20, selfStart: null }), false);
});

test('releaseFile: guarded -- a file that a launch took over between the read and the remove is put back', () => {
  const { releaseFile } = load();
  const f = plain();
  fs.writeFileSync(f.file, JSON.stringify({ pid: 20, start: START_A }));
  const newer = JSON.stringify({ pid: 30, start: START_B });
  const r = releaseFile({ file: f.file, selfPid: 20, selfStart: START_A, hooks: { afterRead: () => fs.writeFileSync(f.file, newer) } });
  assert.strictEqual(r, false);
  assert.strictEqual(read(f.file), newer);
});

test('the decision table and the proof are the same functions window-owner exports', () => {
  const core = load();
  const wo = require('../host/window-owner');
  assert.strictEqual(wo.parseOwner, core.parseOwner);
  assert.strictEqual(wo.decide, core.decide);
  assert.strictEqual(wo.proveOwner, core.proveOwner);
});
