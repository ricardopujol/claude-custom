'use strict';
// host/resource-kill.js validTarget: `start` and `pid` are written raw into PowerShell source, so this guard is the only
// thing between the panel's data and code execution. One defect per row (a row with two defects masks each clause).
// Release #117 Mortimer survivor 1.
const test = require('node:test');
const assert = require('node:assert');
const K = require('../host/resource-kill.js');

const recording = () => {
  const calls = [];
  return { calls, exec: async (script) => { calls.push(script); return '5 killed\nEND\n'; } };
};

const BAD = [
  ['pid 0', { pid: 0, start: '1' }],
  ['pid -1', { pid: -1, start: '1' }],
  ['pid 1.5', { pid: 1.5, start: '1' }],
  ['pid as a string', { pid: '5', start: '1' }],
  ['pid NaN', { pid: NaN, start: '1' }],
  ['start as a number', { pid: 5, start: 1 }],
  ['start missing', { pid: 5 }],
  ['start with a leading letter', { pid: 5, start: 'x1' }],
  ['start with a trailing letter', { pid: 5, start: '1x' }],
  ['start empty', { pid: 5, start: '' }],
  ['start with an injected command', { pid: 5, start: '1; calc' }],
  ['start with an injected line', { pid: 5, start: '1\ncalc' }],
  ['start with a trailing newline', { pid: 5, start: '1\n' }],
  ['start negative', { pid: 5, start: '-1' }],
  ['start with a backtick', { pid: 5, start: '1`calc' }],
  ['start with a subexpression', { pid: 5, start: '1$(calc)' }],
  ['start with a space', { pid: 5, start: '1 2' }],
  ['start with a leading space', { pid: 5, start: ' 1' }],
  ['start with a leading +', { pid: 5, start: '+1' }],
  ['start with a leading -', { pid: 5, start: '-1' }],
  ['start in Arabic-Indic digits', { pid: 5, start: String.fromCharCode(0x661, 0x662, 0x663) }],
  ['start in full-width digits', { pid: 5, start: String.fromCharCode(0xff11, 0xff12, 0xff13) }],
  ['null target', null],
];

for (const [name, target] of BAD) {
  test(`kill guard: ${name} is refused and nothing is executed`, async () => {
    const { calls, exec } = recording();
    const r = await K.killVerified([target], { exec });
    assert.strictEqual(calls.length, 0, 'exec must never see a bad target');
    assert.deepStrictEqual(r, [{ pid: target && target.pid, status: 'failed', text: 'not a valid target' }]);
  });
}

test('kill guard: one bad target among good ones refuses the whole list', async () => {
  const { calls, exec } = recording();
  const r = await K.killVerified([{ pid: 5, start: '1' }, { pid: 6, start: 'x' }], { exec });
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(r.map(x => x.status), ['failed', 'failed']);
  assert.deepStrictEqual(r.map(x => x.pid), [5, 6]);
});

test('kill guard: an empty list executes nothing and answers nothing', async () => {
  const { calls, exec } = recording();
  assert.deepStrictEqual(await K.killVerified([], { exec }), []);
  assert.deepStrictEqual(await K.killVerified(undefined, { exec }), []);
  assert.strictEqual(calls.length, 0);
});

test('kill guard: a valid target IS executed, with its pid and start in the script', async () => {
  const { calls, exec } = recording();
  const r = await K.killVerified([{ pid: 5, start: '133000000000000000' }], { exec });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /\$rootId = 5\b/);
  assert.match(calls[0], /K 5 133000000000000000\b/);
  assert.deepStrictEqual(r, [{ pid: 5, status: 'killed' }]);
});

test('kill guard: pid 1 and a one-digit start are the smallest accepted values', async () => {
  const { calls, exec } = recording();
  await K.killVerified([{ pid: 1, start: '0' }], { exec });
  assert.strictEqual(calls.length, 1);
});

// pid is a Windows DWORD and start is cast to [long] in the script: a value past either range is not a process.
const OUT_OF_RANGE = [
  ['pid 1e21 (an integer to JS, written as 1e+21 into the script)', { pid: 1e21, start: '1' }],
  ['pid one past an Int32 (Get-Process -Id and the script [int] casts)', { pid: 2147483648, start: '1' }],
  ['pid at the DWORD maximum, past what the script can read', { pid: 4294967295, start: '1' }],
  ['start of 20 digits', { pid: 5, start: '12345678901234567890' }],
  ['start with leading zeros past 19 digits', { pid: 5, start: '00000000000000000001' }],
  ['start one past a signed 64-bit integer', { pid: 5, start: '9223372036854775808' }],
  ['start of 19 nines', { pid: 5, start: '9999999999999999999' }],
];
for (const [name, target] of OUT_OF_RANGE) {
  test(`kill guard: ${name} is refused and nothing is executed`, async () => {
    const { calls, exec } = recording();
    const r = await K.killVerified([target], { exec });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(r, [{ pid: target.pid, status: 'failed', text: 'not a valid target' }]);
  });
}

for (const [name, target] of [
  ['the largest Int32 pid', { pid: 2147483647, start: '1' }],
  ['the largest signed 64-bit start', { pid: 5, start: '9223372036854775807' }],
  ['a real FILETIME start (18 digits)', { pid: 5, start: '134355977388659781' }],
  ['a short start that starts with a 9 (length decides, not the leading digit)', { pid: 5, start: '999999999999999999' }],
  ['a 19-digit start below the maximum', { pid: 5, start: '9223372036854775806' }],
  ['a 19-digit start with a smaller leading digit', { pid: 5, start: '1999999999999999999' }],
]) {
  test(`kill guard: ${name} IS executed`, async () => {
    const { calls, exec } = recording();
    await K.killVerified([target], { exec });
    assert.strictEqual(calls.length, 1);
  });
}
