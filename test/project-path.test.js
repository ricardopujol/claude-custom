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

test('spellings Windows treats as one folder compare as one folder', () => {
  // Dexter, PR #31 Finding 5. `samePath` handled three transforms -- separators,
  // trailing slashes, case -- and Win32 path equality needs more than that.
  // Each miss cost the same thing: `decideAttach` said 'other-project',
  // `resolvePort` stepped, and a SECOND host with a SECOND
  // `claude --dangerously-skip-permissions` started in the folder that already
  // had one, with two ptys competing over one working tree.
  // Backslashes via char code, for the reason this file's header already
  // gives -- and which I have now re-learned four times tonight: a heredoc
  // eats one level, and the result is not always a syntax error. Here it was.
  // 'C:\proj' silently becomes 'C:proj', which would have tested nothing.
  const B = String.fromCharCode(92);
  const WIN = `C:${B}proj`;
  assert.strictEqual(samePath('C:/p/sub/..', 'C:/p'), true, 'unresolved ..');
  assert.strictEqual(samePath('C:/a//b', 'C:/a/b'), true, 'doubled separators mid-path');
  assert.strictEqual(samePath(`C:${B}proj${B}.${B}`, WIN), true, 'a . segment');
  assert.strictEqual(samePath('C:/proj/sub/../', WIN), true, 'trailing .. with a slash');
});

test('a sibling is still a different project after resolution', () => {
  // The boundary that must survive the fix: resolving must not make neighbours
  // equal. This is the prefix-vs-equality trap from the other direction.
  assert.strictEqual(samePath('C:/proj', 'C:/proj-other'), false);
  assert.strictEqual(samePath('C:/p/a/..', 'C:/p/b/..'), true, 'both resolve to C:/p');
  assert.strictEqual(samePath('C:/p/a', 'C:/p/b'), false);
});

// WHAT THIS DELIBERATELY DOES NOT CLAIM.
//
// Dexter's Finding 5 lists cases that path.resolve does NOT fix and that I am
// not fixing here, because getting them right needs Win32 semantics I cannot
// verify by reasoning: trailing dots and spaces (Win32 strips them, Node does
// not), 8.3 short names (VIBECO~1), UNC vs mapped drive, and the \?\ prefix.
// He also noted the opposite direction -- JS toLowerCase is Unicode folding,
// not the NTFS upcase table, so U+0130 can fold two genuinely distinct
// directories together, as can a case-sensitive-flagged directory.
//
// The honest fix for all of those is a device+file-id comparison
// (fs.statSync().dev/.ino), which is the only thing that gets junctions, 8.3
// and UNC-vs-mapped right in one move -- but it only works when BOTH paths
// exist, and `samePath` is called on paths that may not. That is a design
// change, not a patch, and it is recorded as a follow-up rather than guessed
// at in the dark. Dexter's own recommendation was a Windows platform
// specialist for exactly this.
test('the unfixed Win32 cases are DOCUMENTED, not silently believed to work', () => {
  // A test that asserts the current, limited behaviour so nobody reads the
  // module header as a completeness claim. If someone later makes these pass,
  // this test failing is the prompt to update the header.
  assert.strictEqual(samePath('C:/proj.', 'C:/proj'), false, 'trailing dot: NOT handled');
  assert.strictEqual(samePath('C:/proj ', 'C:/proj'), false, 'trailing space: NOT handled');
});

test('deleting a separator must not merge two DIFFERENT projects', () => {
  // MUTATION-DRIVEN, and it is the finding Mortimer first called equivalent
  // and then corrected himself on after executing it against a 20-path corpus.
  // The mutant replaces `.replace(/\/g, '/')` with `.replace(/\/g, '')` --
  // deleting the separator rather than converting it -- and it disagreed with
  // the original 24 times:
  //
  //   normalize('C:/a/b') -> 'c:/a/b'   under the mutant -> 'c:ab'
  //   normalize('C:/ab')  -> 'c:/ab'    under the mutant -> 'c:ab'
  //
  // Two genuinely different projects comparing as one project: the exact
  // silent-wrong-session failure this whole feature exists to remove, and the
  // thing decideAttach is built to refuse.
  //
  // THE PROPERTY THIS PINS IS INJECTIVITY, and that is the lesson. His first
  // reasoning was that both operands pass through the same transform, so
  // equality is preserved -- true, and insufficient. Running both sides
  // through one transform preserves equality for paths that ARE equal; it says
  // nothing about paths that are NOT. Replacing a separator with another
  // separator is injective; deleting it is not.
  assert.strictEqual(samePath('C:/a/b', 'C:/ab'), false, 'a separator is not nothing');
  assert.strictEqual(samePath('C:/x/y/z', 'C:/xyz'), false);

  // UNC is where the collision is starkest: //server/share/proj and
  // //server/shareproj both collapse to 'servershareproj'.
  assert.strictEqual(samePath('//server/share/proj', '//server/shareproj'), false,
    'and not on UNC either');
});
