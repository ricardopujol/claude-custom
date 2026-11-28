'use strict';
/**
 * verify/lib/run-hosts.js: the hosts a probe's scratch projects started, WITH the start time each host wrote. Two misses it replaces
 * (measured 2026-11-28, verify/probe-single-instance.js --cases=1-5 left seven hosts running): readIdentity drops processStartedAt, and
 * a string prefix on the temp folder missed a host that wrote the long form of an 8.3 short path.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { hostsUnder, isInsideOf } = require('../verify/lib/run-hosts');

function harnessWith(files) {
  const harness = tmpDir('cc-run-hosts-');
  fs.mkdirSync(path.join(harness, 'hosts'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(harness, 'hosts', name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return harness;
}

test('hostsUnder returns pid, cwd, port and the processStartedAt the host wrote, for hosts inside the folder only', () => {
  const scratch = tmpDir('cc-run-hosts-scratch-');
  fs.mkdirSync(path.join(scratch, 'a', 'dev'), { recursive: true });
  const harness = harnessWith({
    '7701.json': { port: 7701, pid: 11, cwd: path.join(scratch, 'a', 'dev'), processStartedAt: '134403649017080000' },
    '7702.json': { port: 7702, pid: 12, cwd: path.join(path.dirname(scratch), 'someone-else', 'dev'), processStartedAt: '1' },
    '7703.json': { port: 7703, pid: 13, cwd: path.join(scratch, 'b', 'dev') },
    '7704.json': '{ half-written',
    '7705.json': { port: 7705, pid: 0, cwd: path.join(scratch, 'c') },
    '7706.token': 'secret',
  });
  const got = hostsUnder(harness, scratch).sort((x, y) => x.port - y.port);
  assert.deepStrictEqual(got, [
    { port: 7701, pid: 11, cwd: path.join(scratch, 'a', 'dev'), processStartedAt: '134403649017080000' },
    { port: 7703, pid: 13, cwd: path.join(scratch, 'b', 'dev'), processStartedAt: null },
  ]);
});

test('hostsUnder: a start time that is not a FILETIME string is null, never a number or a guess', () => {
  const scratch = tmpDir('cc-run-hosts-scratch-');
  const harness = harnessWith({ '7701.json': { pid: 11, cwd: scratch, processStartedAt: 134403649017080000 },
    '7702.json': { pid: 12, cwd: scratch, processStartedAt: '12ab' } });
  assert.deepStrictEqual(hostsUnder(harness, scratch).map((h) => h.processStartedAt), [null, null]);
});

test('hostsUnder: no hosts folder is an empty list', () => {
  assert.deepStrictEqual(hostsUnder(tmpDir('cc-run-hosts-empty-'), 'C:\\nowhere'), []);
});

test('isInsideOf compares REAL paths: a short and a long spelling of one folder match, a sibling with the same prefix does not', () => {
  const alias = (p) => p.toLowerCase().replace('c:\\users\\someon~1\\', 'c:\\users\\someone else\\');
  const inside = isInsideOf('C:\\Users\\SOMEON~1\\Temp\\cc-x', alias);
  assert.strictEqual(inside('C:\\Users\\Someone Else\\Temp\\cc-x\\alpha\\feat-a'), true);
  assert.strictEqual(inside('C:\\Users\\SOMEON~1\\Temp\\cc-x\\beta\\dev'), true);
  assert.strictEqual(inside('C:\\Users\\Someone Else\\Temp\\cc-x'), true);
  assert.strictEqual(inside('C:\\Users\\Someone Else\\Temp\\cc-x2\\dev'), false);
  assert.strictEqual(inside('C:\\Users\\Someone Else\\VibeCode\\claude-custom\\dev'), false);
});

test('isInsideOf with the real resolver: the 8.3 short form of a real temp folder is inside its long form', { skip: process.platform !== 'win32' }, () => {
  const scratch = tmpDir('cc-run-hosts-real-');
  const long = fs.realpathSync.native(scratch);
  fs.mkdirSync(path.join(scratch, 'p', 'dev'), { recursive: true });
  assert.strictEqual(isInsideOf(scratch)(path.join(long, 'p', 'dev')), true);
  assert.strictEqual(isInsideOf(long)(path.join(scratch, 'p', 'dev')), true);
});
