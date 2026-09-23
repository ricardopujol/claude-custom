'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { samePath, projectLabel } = require('../host/project-path');

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

  // DEXTER, PR #40, F4, and he spotted the asymmetry in this very test: the
  // prose above names FOUR unfixed cases and the body pinned TWO -- and the two
  // it left unpinned are exactly the pair that fails OPEN. A test named
  // "DOCUMENTED, not silently believed to work" was characterizing only the
  // harmless direction.
  //
  // `toLowerCase` is Unicode folding, not the NTFS upcase table. U+0130 (LATIN
  // CAPITAL LETTER I WITH DOT ABOVE) lowercases to `i` + U+0307, so
  // `C:\work\İstanbul` and `C:\work\i̇stanbul` -- two GENUINELY DISTINCT NTFS
  // directories, since the upcase table does not equate them -- normalize to one
  // string. `samePath` says true.
  //
  // That was a display limitation when this only routed window attach. PR #40
  // made the same predicate decide who can read a CREDENTIAL, so the second
  // project's window lists, reveals and copies the first project's secret.
  //
  // PINNED, RUNNING, NOT SKIPPED. My plan was `.skip` and both reviewers
  // rejected it for the same reason, which is this session's own lesson: a skip
  // is an absence reported as a pass. `ℹ skipped 1` inside 1100 is invisible
  // forever -- the same shape as the `\b` written as 0x08, and as
  // `dirsToAdd: []` being true for two opposite reasons. This form goes RED the
  // day someone closes the gap, deliberately or through a Node/ICU upgrade, and
  // hands them the header paragraph to delete.
  assert.strictEqual(
    samePath('C:/work/\u0130stanbul', 'C:/work/i\u0307stanbul'), true,
    'U+0130 folds two DIFFERENT directories together: NOT handled, and this one '
    + 'FAILS OPEN -- if this now returns false, delete the acceptance from '
    + 'host/project-path.js and from secret-vault.js');

  // The premise, measured rather than reasoned -- test/fog-review.test.js
  // already records the same folding, so this is consistent with the repo.
  assert.strictEqual('\u0130'.toLowerCase(), 'i\u0307',
    'the precondition for the case above: JS folds U+0130 into two code units');
});

test('the SECOND fail-open case cannot be pinned as a string property, and that is the finding', () => {
  // Dexter, PR #40, F4, the half that must not be implied to be covered by the
  // test above -- and the reason is sharper than "nobody wrote it".
  //
  // Under a per-directory case-sensitivity flag (any WSL-created tree, which is
  // ordinary for a developer on this machine), `C:\work\Proj` and `C:\work\proj`
  // are TWO directories with one normalized string. But:
  //
  //     samePath('C:/work/Proj', 'C:/work/proj') === true
  //
  // is CORRECT on an ordinary Windows directory and WRONG under the flag. The
  // predicate is not incorrect -- it is missing information it cannot obtain
  // without touching disk. No string-level assertion can distinguish the two
  // worlds, so there is nothing to pin, and a test claiming to cover it would be
  // worse than this comment.
  //
  // It also kills the cheap fix. Folding only ASCII would close the U+0130 hole,
  // but it makes every non-ASCII comparison case-SENSITIVE -- and `samePath`
  // still routes window attach, where a false negative means `decideAttach` says
  // "other-project", `resolvePort` steps, and a second permission-bypassed
  // `claude` starts in a folder that already has one (host/project-path.js
  // records that cost). Trading a near-unreachable credential leak for that is a
  // bad trade, and it would not even finish the job.
  //
  // So: the acceptance covers TWO cases, only ONE is testable as a string
  // property, and the untestable one is the MORE reachable of the two.
  assert.strictEqual(samePath('C:/work/Proj', 'C:/work/proj'), true,
    'case folding: correct on ordinary NTFS, wrong under a case-sensitive flag, '
    + 'and indistinguishable from here');

  // What IS assertable is that the acceptance is written down where the next
  // reader will look. Miguel: the load-bearing edit is upstream, in the module
  // that owns the gap list, not only in the consumer.
  const fs = require('fs');
  const path = require('path');
  const header = fs.readFileSync(
    path.join(__dirname, '..', 'host', 'project-path.js'), 'utf8');
  assert.match(header, /FAILS? OPEN/,
    'the two fail-open cases must be named as such in host/project-path.js');
  assert.match(header, /credential|secret/i,
    'and the header must say the consequence changed, since that is what PR #40 changed');
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

// --- what to call the window -------------------------------------------------
//
// FF3, from the first real use on another project. The window was titled
// `claude-custom — spike/terminal-fidelity`, hardcoded at app/main.js:164 and
// still naming a spike branch. With multi-project (#31) two windows can be open
// at once, so the title is the only thing that tells them apart -- in the
// taskbar, in alt-tab, and in a thumbnail.
//
// A pure helper because the interesting cases are all path edge cases, and
// none of them are reachable from a test if this logic lives in main.js.

test('the label is the folder name, which is what tells two windows apart', () => {
  assert.strictEqual(projectLabel('C:/Users/ricar/VibeCode/suno-pipeline'), 'suno-pipeline');
  assert.strictEqual(projectLabel('C:\\Users\\ricar\\VibeCode\\claude-custom'), 'claude-custom');
});

test('a trailing separator does not produce an empty label', () => {
  assert.strictEqual(projectLabel('C:/Users/ricar/VibeCode/suno-pipeline/'), 'suno-pipeline');
  assert.strictEqual(projectLabel('C:\\Users\\ricar\\VibeCode\\suno-pipeline\\'), 'suno-pipeline');
});

test('a drive root has no folder name, so it names itself', () => {
  // `path.basename('C:\')` is '' -- an empty title is a window with no
  // identity at all, which is worse than the long form.
  //
  // Miguel, PR #33, A11: this asserted `.length > 0`, which passes if the
  // function returns 'x'. The rule the header states is that the window must
  // still IDENTIFY the folder, so assert the value, not its spelling.
  assert.strictEqual(projectLabel('C:\\'), 'C:\\');
  assert.strictEqual(projectLabel('C:/'), 'C:/');
  assert.strictEqual(projectLabel('/'), '/');
});

test('two different projects get two different labels -- the whole point of FF3', () => {
  // The actual requirement, which nothing asserted. Under multi-project the
  // title is the only thing telling two open windows apart, so labels that
  // collide are the failure this feature exists to prevent.
  const a = projectLabel('C:/Users/ricar/VibeCode/suno-pipeline');
  const b = projectLabel('C:/Users/ricar/VibeCode/claude-custom');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, 'suno-pipeline');
  assert.strictEqual(b, 'claude-custom');
});

test('the label does not depend on which platform runs the test', () => {
  // A10: with the ambient `path`, a POSIX runner returns the whole string for
  // a Windows path, so these tests passed only on Windows and the function
  // silently behaved differently there.
  assert.strictEqual(projectLabel('C:/a/b/deep-project'), 'deep-project');
  assert.strictEqual(projectLabel('/home/ricar/work/deep-project'), 'deep-project');
});

test('an absent path falls back to the product name rather than to blank', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    assert.strictEqual(projectLabel(bad), 'claude-custom', JSON.stringify(bad));
  }
});

test('a UNC share keeps a usable name', () => {
  assert.strictEqual(projectLabel('\\\\server\\share\\project'), 'project');
});
