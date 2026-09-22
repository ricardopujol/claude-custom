'use strict';
/**
 * How Claude Code names the folder it keeps a project's transcripts in.
 *
 * Two reviewers found the same defect here independently, which is the signal
 * that it was a guess rather than a measurement: the harness replaced only `/`
 * and `:`, while Claude Code replaces EVERY non-alphanumeric character with a
 * dash. Any project path containing a space, a dot or an underscore therefore
 * resolved to a directory that does not exist -- and because a missing
 * directory is indistinguishable from a project with no history, the failure
 * rendered as a confident, wrong answer rather than as an error.
 *
 * The `.claude` case is not exotic: CLAUDE.md MANDATES git worktrees for
 * parallel agents, and every worktree path contains `.claude/worktrees`.
 *
 * The expected values below are copied from real directory names on this
 * machine, not derived from the same assumption twice.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { projectDirName } = require('../host/project-dir');

test('encodes a plain project path', () => {
  assert.strictEqual(
    projectDirName('C:\\Users\\ricar\\VibeCode\\claude-custom'),
    'C--Users-ricar-VibeCode-claude-custom');
});

test('a DOT becomes a dash, which is what broke worktrees', () => {
  // Real directory on this machine:
  //   C--Users-ricar-VibeCode-music-tagging--claude-worktrees-frosty-banzai-0d7073
  // Note the double dash: `/.claude` is two non-alphanumerics in a row.
  assert.strictEqual(
    projectDirName('C:/Users/ricar/VibeCode/music-tagging/.claude/worktrees/frosty-banzai-0d7073'),
    'C--Users-ricar-VibeCode-music-tagging--claude-worktrees-frosty-banzai-0d7073');
});

test('a SPACE becomes a dash', () => {
  assert.strictEqual(
    projectDirName('C:\\Users\\ricar\\Unreal Projects\\ThirdPersonSOVGA'),
    'C--Users-ricar-Unreal-Projects-ThirdPersonSOVGA');
});

test('an UNDERSCORE becomes a dash', () => {
  assert.strictEqual(projectDirName('C:/w/my_project'), 'C--w-my-project');
});

test('existing dashes survive unchanged', () => {
  assert.strictEqual(projectDirName('C:/w/claude-custom'), 'C--w-claude-custom');
});

test('slash direction does not matter', () => {
  assert.strictEqual(projectDirName('C:\\w\\a'), projectDirName('C:/w/a'));
});

test('the result contains only characters Claude Code actually uses', () => {
  // Every one of the 38 project directories on this machine matches this shape.
  const encoded = projectDirName('C:/Users/ricar/Some Odd (Path)/x.y_z');
  assert.ok(/^[A-Za-z0-9-]+$/.test(encoded), encoded);
});

// NOTE FOR MUTATION RUNS: this test asserts about the real filesystem, so it
// fails inside any sandboxed copy of the tree -- StrykerJS's .stryker-tmp, and
// mutmut's mutants/ for the same reason. It aborts the dry run and must be
// deselected by name. It kills no mutant: its subject is this machine, not a
// function. CLAUDE.md records this exact failure shape costing two full runs
// on another project; it cost two here before Mortimer identified it.
test('AGREES WITH THE REAL DIRECTORIES ON THIS MACHINE', () => {
  // The check that matters: every folder Claude Code has actually created must
  // be reproducible from some path. A unit test against my own assumption is
  // what let this ship in the first place, so this one reads the real thing.
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return;                       // another machine; the unit tests still hold
  }
  const bad = dirs.filter(d => !/^[A-Za-z0-9-]+$/.test(d));
  assert.deepStrictEqual(bad, [],
    'Claude Code used characters the encoder does not produce: ' + bad.join(', '));

  // And this project's own directory must be exactly what we compute.
  const mine = projectDirName(process.cwd());
  assert.ok(dirs.includes(mine), `${mine} is not among the real project dirs`);
});
