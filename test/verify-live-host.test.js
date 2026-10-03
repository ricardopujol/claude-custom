'use strict';
/**
 * verify/lib/live-host.js: "is this identity file's host still running?" for the probes' REFUSED check.
 * A pid alone is not an answer: Windows reuses pids, so a dead probe host's leftover file can name a pid
 * that an unrelated process (another lane's host) now owns, and the probe would refuse for nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { isLiveHost } = require('../verify/lib/live-host');

const alive = () => true;
const dead = () => false;
const unknown = () => null;
const times = map => async () => new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));

test('a recycled pid is not a live host: the pid runs, but it started at another time', async () => {
  assert.equal(await isLiveHost({ pid: 47120, processStartedAt: '100' }, { isAlive: alive, startTimes: times({ 47120: '999' }) }), false);
});

test('the same pid with the same start time is live', async () => {
  assert.equal(await isLiveHost({ pid: 47120, processStartedAt: '100' }, { isAlive: alive, startTimes: times({ 47120: '100' }) }), true);
});

test('a pid that is not running is not live, and the start time is never asked', async () => {
  let asked = false;
  assert.equal(await isLiveHost({ pid: 1, processStartedAt: '100' }, { isAlive: dead, startTimes: async () => { asked = true; return new Map(); } }), false);
  assert.equal(asked, false);
});

test('no processStartedAt in the file keeps the pid-only answer', async () => {
  const never = async () => { throw new Error('must not ask'); };
  assert.equal(await isLiveHost({ pid: 5 }, { isAlive: alive, startTimes: never }), true);
  assert.equal(await isLiveHost({ pid: 5, processStartedAt: '' }, { isAlive: alive, startTimes: never }), true);
  assert.equal(await isLiveHost({ pid: 5 }, { isAlive: dead, startTimes: never }), false);
});

test('when nothing can be learned it fails closed: live (a probe that refuses wrongly is safe, one that runs beside a real host is not)', async () => {
  assert.equal(await isLiveHost({ pid: 5, processStartedAt: '100' }, { isAlive: unknown, startTimes: times({}) }), true);
  assert.equal(await isLiveHost({ pid: 5, processStartedAt: '100' }, { isAlive: alive, startTimes: async () => null }), true, 'the query failed');
  assert.equal(await isLiveHost({ pid: 5, processStartedAt: '100' }, { isAlive: alive, startTimes: times({ 5: null }) }), true, 'running, start unreadable');
});

test('it exited between the two questions: not live', async () => {
  assert.equal(await isLiveHost({ pid: 5, processStartedAt: '100' }, { isAlive: alive, startTimes: times({}) }), false);
});

const present = () => true;
const gone = () => false;

test('a host whose project folder is gone is not live, whatever its pid says (a probe\'s deleted temp world)', async () => {
  const id = { pid: 37336, cwd: 'C:\\deleted\\proj', processStartedAt: '100' };
  assert.equal(await isLiveHost(id, { exists: gone, isAlive: alive, startTimes: async () => null }), false, 'pid alive, start time unknowable');
  assert.equal(await isLiveHost(id, { exists: gone, isAlive: dead, startTimes: times({}) }), false, 'pid dead');
});

test('a host whose project folder exists still fails closed when nothing can be learned', async () => {
  const id = { pid: 37336, cwd: 'C:\\here\\proj', processStartedAt: '100' };
  assert.equal(await isLiveHost(id, { exists: present, isAlive: alive, startTimes: async () => null }), true);
});

test('no cwd (or one that is not a string) behaves as before: the folder is not asked about', async () => {
  const boom = () => { throw new Error('must not ask'); };
  assert.equal(await isLiveHost({ pid: 5 }, { exists: boom, isAlive: alive, startTimes: times({}) }), true);
  assert.equal(await isLiveHost({ pid: 5, cwd: '' }, { exists: boom, isAlive: alive, startTimes: times({}) }), true);
  assert.equal(await isLiveHost({ pid: 5, cwd: 7 }, { exists: boom, isAlive: alive, startTimes: times({}) }), true);
});

test('junk identities are not live hosts', async () => {
  for (const id of [null, undefined, {}, { pid: 'x' }, { pid: 0 }, { pid: -3 }]) assert.equal(await isLiveHost(id, { isAlive: alive, startTimes: times({}) }), false, JSON.stringify(id));
});
