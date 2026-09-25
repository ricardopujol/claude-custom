'use strict';
/**
 * Fog of war — the defects two reviewers found, each pinned by a test.
 *
 * Separate from fog.test.js because these are not general coverage: every one
 * of them failed before its fix, and several describe behaviour that a
 * 25-test suite reported as healthy. Three of those tests were proven hollow
 * by hand-mutation, which is the real lesson here — a green suite said nothing
 * about `mergeInto`, the clock-skew guard, or the missing-file_path guard,
 * because none of them were actually exercised.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const {
  readFog, brightness, relativeTo,
  TIERS, TIER_PEAK, DECAY_HALFLIFE_MS, MIN_BRIGHTNESS, FLOOR_FOR,
} = require('../host/fog');

const T0 = Date.parse('2026-09-13T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const CWD = 'C:/Users/ricar/VibeCode/proj';

function projectDir() {
  const dir = tmpDir('cc-fogr-');
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  return { dir, project };
}

const toolUse = (name, file, at) => ({
  type: 'assistant',
  timestamp: iso(at),
  message: { content: [{ type: 'tool_use', name, input: { file_path: file } }] },
});

function withTranscripts(files) {
  const { dir, project } = projectDir();
  for (const [name, entries] of Object.entries(files)) {
    const full = path.join(project, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8');
  }
  return dir;
}

// --- merging across sessions -------------------------------------------------

test('tier and touches survive the join across sessions', async () => {
  // mergeInto was ENTIRELY untested: its whole body was replaced with no-ops
  // and all 25 tests stayed green -- while it is the production path here,
  // with 23 transcripts merging into one map.
  const dir = withTranscripts({
    'a.jsonl': [toolUse('Edit', CWD + '/shared.js', T0 - 90000)],
    'b.jsonl': [toolUse('Read', CWD + '/shared.js', T0 - 1000)],
  });
  const fog = await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 });
  const entry = fog.files.find(f => f.path === 'shared.js');

  assert.strictEqual(entry.touches, 2, 'touches did not sum across sessions');
  assert.strictEqual(entry.tier, TIERS.EDITED, 'an Edit lost to a Read in another session');
  assert.strictEqual(entry.lastTouched, T0 - 1000, 'lastTouched is not the latest seen');
});

test('touches do not climb when the map is read repeatedly', async () => {
  // Cached entries are shared between calls. Mutating them instead of a copy
  // would inflate the count every time the panel is opened.
  const dir = withTranscripts({ 's.jsonl': [toolUse('Read', CWD + '/a.js', T0 - 1000)] });
  const opts = { cwd: CWD, projectsDir: dir, now: () => T0 };
  await readFog(opts);
  await readFog(opts);
  assert.strictEqual((await readFog(opts)).files[0].touches, 1);
});

// --- subagent transcripts ----------------------------------------------------

test('subagent transcripts are read, or agent work looks like a blind spot', async () => {
  // Verified on this machine: host/cooldowns.js appears in THREE transcripts,
  // all of them <session>/subagents/*.jsonl and none at the top level. A
  // non-recursive read called it "never opened" -- a FALSE blind spot, which is
  // precisely the failure this feature exists to prevent, and it was biased
  // against exactly the agent-driven work this repo runs on.
  const { dir, project } = projectDir();
  const subagents = path.join(project, 'session-uuid', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(project, 'session-uuid.jsonl'),
    JSON.stringify(toolUse('Read', CWD + '/top.js', T0 - 1000)), 'utf8');
  fs.writeFileSync(path.join(subagents, 'agent-dexter.jsonl'),
    JSON.stringify(toolUse('Read', CWD + '/only-agent-saw.js', T0 - 1000)), 'utf8');
  // .meta.json siblings sit right next to them and are not transcripts.
  fs.writeFileSync(path.join(subagents, 'agent-dexter.meta.json'), '{"x":1}', 'utf8');

  const fog = await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 });
  assert.deepStrictEqual(fog.files.map(f => f.path).sort(),
    ['only-agent-saw.js', 'top.js']);
});

// --- absence conflation ------------------------------------------------------
// Six places where a failure rendered as a confident, wrong map. Status now
// travels with the data so the UI can say which one happened.

test('a missing transcript directory is reported, not shown as "nothing explored"', async () => {
  const fog = await readFog({ cwd: 'C:/nope/at/all', projectsDir: os.tmpdir(), now: () => T0 });
  assert.strictEqual(fog.status.transcriptsMissing, true);
});

test('a present but empty project is NOT reported as missing', async () => {
  const fog = await readFog({ cwd: CWD, projectsDir: withTranscripts({ 's.jsonl': [] }), now: () => T0 });
  assert.strictEqual(fog.status.transcriptsMissing, false);
  assert.strictEqual(fog.status.transcriptsFound, 1);
});

test('a missing tracked list is flagged, because it deletes every dark row', async () => {
  // THE DANGEROUS DIRECTION. With no tracked list there are no dark files, so
  // the panel reads "everything explored, zero blind spots" -- the feature
  // lying in the one direction that makes you stop looking.
  const dir = withTranscripts({ 's.jsonl': [] });
  assert.strictEqual((await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 })).status.trackedOk, false);
  assert.strictEqual(
    (await readFog({ cwd: CWD, projectsDir: dir, now: () => T0, tracked: ['a.js'] })).status.trackedOk,
    true);
});

// --- what "explored" counts --------------------------------------------------

test('coverage is measured against the project, not everything touched', async () => {
  // This repo really does have 8+ reads of .harness/*.png, none tracked by git.
  // Counting them inflated BOTH halves of the ratio, so reading fifty
  // screenshots would have claimed a third of the project was explored.
  const fog = await readFog({
    cwd: CWD,
    projectsDir: withTranscripts({ 's.jsonl': [toolUse('Read', CWD + '/.harness/gui.png', T0 - 1000)] }),
    now: () => T0,
    tracked: ['a.js'],
  });
  assert.strictEqual(fog.explored, 0, 'an untracked screenshot counted as project coverage');
  assert.strictEqual(fog.total, 1, 'an untracked file inflated the denominator');
});

test('duplicate tracked entries produce one row', async () => {
  // git ls-files prints an unmerged path once per stage during a merge
  // conflict, so a conflicted file arrived three times and got three rows.
  const fog = await readFog({
    cwd: CWD, projectsDir: withTranscripts({ 's.jsonl': [] }), now: () => T0,
    tracked: ['a.js', 'a.js', 'a.js'],
  });
  assert.strictEqual(fog.files.length, 1);
  assert.strictEqual(fog.total, 1);
});

// --- path handling -----------------------------------------------------------

test('relativeTo slices the same string it measured', async () => {
  // U+0130 lowercases to TWO code units, so an index taken on the folded string
  // and applied to the original dropped a character: 'src/a.js' became
  // 'rc/a.js', which matched no tracked file and ALSO appeared as dark.
  assert.strictEqual(relativeTo('C:/p/\u0130stanbul', 'C:/p/\u0130stanbul/src/a.js'), 'src/a.js');
});

test('relativeTo refuses a sibling directory sharing a prefix', async () => {
  assert.strictEqual(relativeTo('/home/r/proj', '/home/r/proj-other/x.js'), null);
});

test('relativeTo accepts either slash direction and a trailing slash', async () => {
  assert.strictEqual(relativeTo('C:\\p\\proj', 'C:/p/proj/a.js'), 'a.js');
  assert.strictEqual(relativeTo('C:/p/proj/', 'C:/p/proj/a.js'), 'a.js');
});

// --- brightness --------------------------------------------------------------

test('brightness refuses an unknown tier instead of guessing READ', async () => {
  // `TIER_PEAK[tier] || TIER_PEAK[READ]` silently promoted a never-touched file
  // to a fresh read at 0.55, and did the same for any typo'd tier.
  assert.throws(() => brightness('deleted', 0), /unknown tier/);
});

test('a dark file is dark at every age', async () => {
  assert.strictEqual(brightness(TIERS.DARK, 0), 0);
  assert.strictEqual(brightness(TIERS.DARK, DECAY_HALFLIFE_MS * 100), 0);
});

test('an unusable age falls to the floor, never to full brightness', async () => {
  // `Number(ageMs) || 0` mapped "unknown age" to ZERO age, so a clock returning
  // NaN lit the entire map at 1.0 -- maximum confidence from no information.
  assert.strictEqual(brightness(TIERS.EDITED, NaN), FLOOR_FOR(TIERS.EDITED));
  assert.strictEqual(brightness(TIERS.EDITED, undefined), FLOOR_FOR(TIERS.EDITED));
});

test('each tier has its own floor, and the ordering holds at every age', async () => {
  // MIN_BRIGHTNESS is the EDITED floor; READ's is scaled by its peak. A
  // consumer testing `brightness >= MIN_BRIGHTNESS` to mean "touched" would
  // have classified every stale read file as untouched.
  assert.strictEqual(FLOOR_FOR(TIERS.EDITED), MIN_BRIGHTNESS);
  assert.ok(FLOOR_FOR(TIERS.READ) < MIN_BRIGHTNESS);
  for (const age of [0, 1000, DECAY_HALFLIFE_MS, DECAY_HALFLIFE_MS * 1000]) {
    assert.ok(brightness(TIERS.EDITED, age) >= brightness(TIERS.READ, age), 'at age ' + age);
  }
});

test('brightness at zero age is exactly the tier peak', async () => {
  assert.strictEqual(brightness(TIERS.EDITED, 0), 1);
  assert.strictEqual(brightness(TIERS.READ, 0), TIER_PEAK[TIERS.READ]);
});

// --- the event loop ----------------------------------------------------------

test('the read yields, so no synchronous span approaches the helper timeout', async () => {
  // THE BLOCKER. The hook helper gives up connecting after 80ms, and the host's
  // event loop is what accepts that connection. A 125-175ms synchronous read is
  // the mechanism that dropped 31 of 35 hook events. setImmediate does not fix
  // it -- that runs in the check phase of the SAME loop turn, with the loop
  // still blocked.
  //
  // Measured here rather than argued: a timer scheduled before the read must
  // still fire close to on time while the read is in flight.
  const { dir, project } = projectDir();
  const many = [];
  for (let i = 0; i < 4000; i++) many.push(toolUse('Read', CWD + '/f' + i + '.js', T0 - i));
  fs.writeFileSync(path.join(project, 'big.jsonl'),
    many.map(e => JSON.stringify(e)).join('\n'), 'utf8');

  let longestGap = 0;
  let last = Date.now();
  const ticker = setInterval(() => {
    const nowMs = Date.now();
    longestGap = Math.max(longestGap, nowMs - last);
    last = nowMs;
  }, 5);

  const fog = await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 });
  clearInterval(ticker);

  assert.strictEqual(fog.files.length, 4000, 'the fixture did not parse');
  assert.ok(longestGap < 80,
    `the loop was blocked for ${longestGap}ms, at or past the helper's 80ms connect timeout`);
});
