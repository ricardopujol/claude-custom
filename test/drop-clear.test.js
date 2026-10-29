'use strict';
/**
 * BACKLOG #136: a drop that needs a grant types `/add-dir <dir>` + Enter. It used to put Ctrl-U in the SAME write, ahead of
 * it. MEASURED on the real CLI (verify/probe-paste-doc.js grant6, claude 2.1.312, 703-character draft over 6 rows): Ctrl-U
 * kills only the last row of a wrapped draft, and in a multi-byte write the CLI may not take it as a key at all, so the
 * draft's earlier rows stayed in the box, `/add-dir ...` was appended to them and the Enter SUBMITTED THE LOT to the model.
 * So the clear is one Ctrl-U per row the box holds, each its own write, and the command and its Enter are separate writes too.
 */
const test = require('node:test');
const assert = require('node:assert');
const { promptRows, grantWrites, CTRL_U, MAX_CLEAR_ROWS } = require('../host/drop');

const RULE = '─'.repeat(40);
const screen = (...box) => ['header', RULE, ...box, RULE, '  footer'];

test('the box is the rows between the last two rules', () => {
  assert.strictEqual(promptRows(screen('❯ one row')), 1);
  assert.strictEqual(promptRows(screen('❯ a', '  b', '  c', '  d', '  e', '  f')), 6);
  assert.strictEqual(promptRows(['old', RULE, '❯ old', RULE, 'reply', RULE, '❯ a', '  b', RULE, 'footer']), 2);
});

test('no box on screen, or an absurd one, still clears at least one and at most MAX_CLEAR_ROWS rows', () => {
  assert.strictEqual(promptRows([]), 1);
  assert.strictEqual(promptRows(['no rules here']), 1);
  assert.strictEqual(promptRows(undefined), 1);
  assert.strictEqual(promptRows(screen(...Array(500).fill('  x'))), MAX_CLEAR_ROWS);
});

test('a grant is one Ctrl-U per box row, then the command, then Enter, each its own write', () => {
  const w = grantWrites('C:\\proj\\docs', screen('❯ a', '  b', '  c', '  d', '  e', '  f'));
  assert.deepStrictEqual(w, [...Array(6).fill(CTRL_U), '/add-dir C:\\proj\\docs', '\r']);
  for (const x of w) assert.ok(x === CTRL_U || x === '\r' || !/[\r\x15]/.test(x), 'no write mixes a key with text');
});

test('an empty prompt still gets the one Ctrl-U it always had', () => {
  assert.deepStrictEqual(grantWrites('C:\\d', screen('❯ ')).slice(0, 2), [CTRL_U, '/add-dir C:\\d']);
});

test('the directory is quoted as before (a space must not widen the grant)', () => {
  assert.strictEqual(grantWrites('C:\\Users\\r\\Documents Backup', screen('❯ '))[1], '/add-dir "C:\\Users\\r\\Documents Backup"');
});

test('handleDrop types a grant through grantWrites, never a Ctrl-U glued to the command', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'host', 'host.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /grantWrites\(dir,\s*termState\.lines\(\)\)/);
  assert.doesNotMatch(src, /CTRL_U\s*\+\s*'\/add-dir/);
});
