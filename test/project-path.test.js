'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { samePath } = require('../host/project-path');

// Written with the Write tool, never a shell heredoc. A quoted heredoc ate one
// backslash level three separate times on this project, and here it is
// especially dangerous: 'C:\Users\ricar\proj' is not a syntax error, it is the
// string 'C:Usersricarproj' with a real carriage return in the middle, so the
// mangled test would have gone GREEN against a broken comparison.
const WIN = 'C:\\Users\\ricar\\proj';

test('the same folder written two ways is the same project', () => {
  assert.strictEqual(samePath(WIN, 'C:/Users/ricar/proj'), true);
});

test('case does not make it a different project', () => {
  // Windows paths are case-insensitive, and the two spellings genuinely reach
  // the same folder. A case-sensitive compare here means the handshake refuses
  // to reattach to your own session because Explorer said Users and the shell
  // said users.
  assert.strictEqual(samePath('C:/Users/Ricar/Proj', 'c:/users/ricar/proj'), true);
});

test('a trailing separator does not make it a different project', () => {
  // Shell completion adds one, the launcher will not, and the host records
  // whatever it was given.
  assert.strictEqual(samePath('C:/proj/', 'C:/proj'), true);
});

test('ABSENCE IS NOT A MATCH -- two unknowns are not the same project', () => {
  // The whole point of the handshake is refusing to attach when we cannot tell
  // which project a host is serving. A coercing compare makes String(null) and
  // String(undefined) into the ordinary strings 'null' and 'undefined', so two
  // missing values would agree with each other and the window would attach to
  // a host it knows nothing about -- the exact silent-wrong-session failure
  // this feature exists to remove.
  assert.strictEqual(samePath(null, null), false);
  assert.strictEqual(samePath(undefined, undefined), false);
  assert.strictEqual(samePath(null, 'C:/proj'), false);
  assert.strictEqual(samePath('C:/proj', ''), false);
  // And a literal path that happens to spell the absent value is still a path.
  assert.strictEqual(samePath(null, 'null'), false);
});

// PIN, not a red-green cycle: this already passed when written. It is here
// because prefix-vs-equality is the classic way a path compare goes wrong, and
// `host/fog.js:104` carries a comment about the same trap costing real time
// ("'/proj-other' must not match '/proj'"). A future rewrite that reaches for
// startsWith fails this instead of silently attaching one project's window to
// a sibling project's host.
test('a sibling folder with a longer name is a different project', () => {
  assert.strictEqual(samePath('C:/proj', 'C:/proj-other'), false);
  assert.strictEqual(samePath('C:/proj', 'C:/proj/sub'), false);
});
