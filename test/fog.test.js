'use strict';
/**
 * Fog of war: which files this project has actually looked at.
 *
 * Read from Claude Code's own transcripts, NOT from new hooks. The design
 * assumed hooking Read/Grep/Edit, which would tax every tool call in the
 * critical path -- the same reason the matcher is deliberately narrow. The
 * transcripts already record every tool_use with its file_path, so the data is
 * free, needs no latency budget, and covers sessions this harness never hosted.
 *
 * The value is the DARK regions. They are blind spots, and this project's own
 * history has a fix landing inside the largest zero-coverage region in scope,
 * invisible twice over.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readFog, TIERS, TIER_PEAK, brightness, relativeTo,
        DECAY_HALFLIFE_MS, MIN_BRIGHTNESS, FLOOR_FOR } = require('../host/fog');

const T0 = Date.parse('2026-09-13T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const CWD = 'C:/Users/ricar/VibeCode/proj';

function transcriptDir(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fog-'));
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session-a.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n'), 'utf8');
  return dir;
}

const toolUse = (name, file, at) => ({
  type: 'assistant',
  timestamp: iso(at),
  message: { content: [{ type: 'tool_use', name, input: { file_path: file } }] },
});

const fogFor = entries => readFog({
  cwd: CWD,
  projectsDir: transcriptDir(entries),
  now: () => T0,
});

test('a file that was read is listed as read', async () => {
  const fog = await fogFor([toolUse('Read', CWD + '/src/a.js', T0 - 1000)]);
  const entry = fog.files.find(f => f.path === 'src/a.js');
  assert.ok(entry, JSON.stringify(fog.files));
  assert.strictEqual(entry.tier, TIERS.READ);
});

test('a file that was edited outranks one merely read', async () => {
  // Editing a file is knowing it far better than reading it, so the tier must
  // not be decided by whichever tool happened to come last.
  const file = CWD + '/src/a.js';
  const fog = await fogFor([
    toolUse('Edit', file, T0 - 50000),
    toolUse('Read', file, T0 - 1000),      // read AFTER the edit
  ]);
  assert.strictEqual(fog.files.find(f => f.path === 'src/a.js').tier, TIERS.EDITED);
});

test('Write counts as editing, not reading', async () => {
  const fog = await fogFor([toolUse('Write', CWD + '/n.js', T0 - 1000)]);
  assert.strictEqual(fog.files[0].tier, TIERS.EDITED);
});

test('paths are relative to the project, and slash-direction agnostic', async () => {
  // Transcripts store Windows paths with backslashes; the tree renders one form.
  const fog = await fogFor([toolUse('Read', 'C:\\Users\\ricar\\VibeCode\\proj\\src\\deep\\b.js', T0 - 1000)]);
  assert.strictEqual(fog.files[0].path, 'src/deep/b.js');
});

test('a file outside the project is ignored', async () => {
  // Reading ~/.claude/agents/x.md says nothing about THIS project's map.
  const fog = await fogFor([
    toolUse('Read', 'C:/Users/ricar/.claude/agents/x.md', T0 - 1000),
    toolUse('Read', CWD + '/in.js', T0 - 1000),
  ]);
  assert.deepStrictEqual(fog.files.map(f => f.path), ['in.js']);
});

test('touches are counted, not just recorded', async () => {
  const file = CWD + '/hot.js';
  const fog = await fogFor([
    toolUse('Read', file, T0 - 3000),
    toolUse('Edit', file, T0 - 2000),
    toolUse('Edit', file, T0 - 1000),
  ]);
  assert.strictEqual(fog.files[0].touches, 3);
});

test('the most recent touch is what decays', async () => {
  const file = CWD + '/a.js';
  const fog = await fogFor([
    toolUse('Read', file, T0 - 900000),
    toolUse('Read', file, T0 - 1000),
  ]);
  assert.strictEqual(fog.files[0].lastTouched, T0 - 1000);
});

test('brightness decays with age, so stale knowledge dims', async () => {
  // The whole point: a file read a month ago is not knowledge you still have.
  const fresh = brightness(TIERS.EDITED, 0);
  const old = brightness(TIERS.EDITED, DECAY_HALFLIFE_MS * 4);
  assert.ok(old < fresh, `${old} should be dimmer than ${fresh}`);
});

test('brightness never reaches zero, or a touched file becomes unexplored', async () => {
  // Black means NEVER TOUCHED. A file edited a year ago is still one you have
  // seen, and conflating the two erases the only signal that matters.
  const ancient = brightness(TIERS.EDITED, DECAY_HALFLIFE_MS * 1000);
  assert.ok(ancient > 0, String(ancient));
});

test('an edited file is brighter than a read one of the same age', async () => {
  assert.ok(brightness(TIERS.EDITED, 1000) > brightness(TIERS.READ, 1000));
});

test('brightness is bounded at 1', async () => {
  assert.ok(brightness(TIERS.EDITED, 0) <= 1);
});

test('a missing project directory yields an empty map, not a throw', async () => {
  const fog = await readFog({ cwd: 'C:/nope', projectsDir: os.tmpdir(), now: () => T0 });
  assert.deepStrictEqual(fog.files, []);
});

test('a truncated final line does not lose the rest of the session', async () => {
  // Transcripts are appended live, so a half-written last line is normal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fog-'));
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's.jsonl'),
    JSON.stringify(toolUse('Read', CWD + '/ok.js', T0 - 1000)) + '\n{"partial":',
    'utf8');
  const fog = await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 });
  assert.strictEqual(fog.files.length, 1);
});

test('spans every session in the project, not just the current one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fog-'));
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  for (const pair of [['a.jsonl', 'one.js'], ['b.jsonl', 'two.js']]) {
    fs.writeFileSync(path.join(project, pair[0]),
      JSON.stringify(toolUse('Read', CWD + '/' + pair[1], T0 - 1000)), 'utf8');
  }
  const fog = await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 });
  assert.deepStrictEqual(fog.files.map(f => f.path).sort(), ['one.js', 'two.js']);
});

test('a tool with no file_path is skipped rather than crashing', async () => {
  const dir = transcriptDir([{
    type: 'assistant', timestamp: iso(T0 - 1000),
    // A READ with no file_path. The previous version used Bash, which the
    // tool-name filter rejects before the guard under test is ever reached --
    // deleting `if (!filePath) continue;` left all 25 tests green.
    message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
  }]);
  assert.deepStrictEqual((await readFog({ cwd: CWD, projectsDir: dir, now: () => T0 })).files, []);
});

test('files are ordered brightest first, so the known world reads top-down', async () => {
  const fog = await fogFor([
    toolUse('Read', CWD + '/dim.js', T0 - DECAY_HALFLIFE_MS * 3),
    toolUse('Edit', CWD + '/bright.js', T0 - 1000),
  ]);
  assert.strictEqual(fog.files[0].path, 'bright.js');
});

test('a future timestamp is treated as fresh, not amplified', async () => {
  // Clock skew between machines writing the same project folder is real.
  //
  // Asserted on READ, and pinned to an exact value. The previous version used
  // EDITED and asserted `<= 1`, which the outer Math.min(1, ...) guarantees
  // whatever the code does -- removing the Math.max(0, ...) skew guard left all
  // 25 tests green.
  assert.strictEqual(brightness(TIERS.READ, -100000), TIER_PEAK[TIERS.READ]);
});

// --- the dark regions, which are the whole point -----------------------------

test('untouched project files appear in the map as dark', async () => {
  // A map of only what you HAVE seen is not a map, it is a history. The
  // unexplored regions are the signal, so they have to be in the output.
  const fog = await readFog({
    cwd: CWD,
    projectsDir: transcriptDir([toolUse('Read', CWD + '/seen.js', T0 - 1000)]),
    now: () => T0,
    tracked: ['seen.js', 'never-opened.js', 'src/deep/hidden.js'],
  });
  const dark = fog.files.filter(f => f.tier === TIERS.DARK).map(f => f.path);
  assert.deepStrictEqual(dark.sort(), ['never-opened.js', 'src/deep/hidden.js']);
});

test('a dark file has zero brightness, which is what makes it dark', async () => {
  const fog = await readFog({
    cwd: CWD, projectsDir: transcriptDir([]), now: () => T0,
    tracked: ['untouched.js'],
  });
  assert.strictEqual(fog.files[0].brightness, 0);
  assert.strictEqual(fog.files[0].touches, 0);
});

test('dark files sort last, under everything actually known', async () => {
  const fog = await readFog({
    cwd: CWD,
    projectsDir: transcriptDir([toolUse('Read', CWD + '/seen.js', T0 - DECAY_HALFLIFE_MS * 50)]),
    now: () => T0,
    tracked: ['seen.js', 'dark.js'],
  });
  assert.strictEqual(fog.files[fog.files.length - 1].path, 'dark.js');
});

test('a touched file missing from tracked is still listed', async () => {
  // Untracked-but-read files are real knowledge -- and a file being read while
  // gitignored is worth seeing, not hiding.
  const fog = await readFog({
    cwd: CWD,
    projectsDir: transcriptDir([toolUse('Read', CWD + '/scratch.js', T0 - 1000)]),
    now: () => T0,
    tracked: ['other.js'],
  });
  assert.ok(fog.files.some(f => f.path === 'scratch.js'));
});

test('coverage counts what is known, which is the number worth reading', async () => {
  const fog = await readFog({
    cwd: CWD,
    projectsDir: transcriptDir([toolUse('Read', CWD + '/a.js', T0 - 1000)]),
    now: () => T0,
    tracked: ['a.js', 'b.js', 'c.js', 'd.js'],
  });
  assert.strictEqual(fog.explored, 1);
  assert.strictEqual(fog.total, 4);
});

test('with no tracked list it reports only what was touched', async () => {
  // Callers that cannot enumerate the project (no git) still get a usable map.
  const fog = await fogFor([toolUse('Read', CWD + '/a.js', T0 - 1000)]);
  assert.strictEqual(fog.total, 1);
  assert.strictEqual(fog.explored, 1);
});

// --- cost ---------------------------------------------------------------------
// readFog is synchronous and takes ~180ms across this project's transcripts.
// The host's event loop delivers hook events, and this project has already
// measured what blocking it costs: a spawnSync in the server dropped 31 of 35
// events. So a re-read must not re-parse files that have not changed.

test('an unchanged transcript is not parsed twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fog-'));
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's.jsonl'),
    JSON.stringify(toolUse('Read', CWD + '/a.js', T0 - 1000)), 'utf8');

  const parsed = [];
  const opts = { cwd: CWD, projectsDir: dir, now: () => T0, onParse: f => parsed.push(f) };
  await readFog(opts);
  const afterFirst = parsed.length;
  await readFog(opts);
  assert.strictEqual(afterFirst, 1, 'first read should parse the file once');
  assert.strictEqual(parsed.length, 1, 'second read re-parsed an unchanged file');
});

test('a changed transcript IS re-parsed, or the map goes stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fog-'));
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify(toolUse('Read', CWD + '/a.js', T0 - 1000)), 'utf8');

  const opts = { cwd: CWD, projectsDir: dir, now: () => T0 };
  assert.strictEqual((await readFog(opts)).files.length, 1);

  fs.appendFileSync(file, '\n' + JSON.stringify(toolUse('Edit', CWD + '/b.js', T0 - 500)));
  const after = await readFog(opts);
  assert.strictEqual(after.files.length, 2, 'an appended transcript was not picked up');
});
