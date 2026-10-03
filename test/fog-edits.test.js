'use strict';
/**
 * The repo browser's `●N` (#45): how many times Claude EDITED a file. fog's `touches` counts reads too, so
 * it can't be the badge; `edits` counts Edit / Write / NotebookEdit calls alone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { readFog } = require('../host/fog');

const T0 = Date.parse('2026-09-13T12:00:00Z');
const CWD = 'C:/Users/ricar/VibeCode/proj';
const call = (name, file, at) => ({
  type: 'assistant', timestamp: new Date(at).toISOString(),
  message: { content: [{ type: 'tool_use', name, input: { file_path: file } }] },
});

function dirWith(sessions) {
  const dir = tmpDir('cc-fog-edits-');
  const project = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(project, { recursive: true });
  sessions.forEach((entries, i) => fs.writeFileSync(path.join(project, `s${i}.jsonl`),
    entries.map(e => JSON.stringify(e)).join('\n'), 'utf8'));
  return dir;
}
const fogOf = (sessions) => readFog({ cwd: CWD, projectsDir: dirWith(sessions), now: () => T0 });

test('edits counts Edit and Write calls; reads add to touches but not to edits', async () => {
  const f = CWD + '/a.js';
  const fog = await fogOf([[call('Read', f, T0 - 5), call('Edit', f, T0 - 4), call('Write', f, T0 - 3), call('Read', f, T0 - 2)]]);
  const e = fog.files.find(x => x.path === 'a.js');
  assert.strictEqual(e.edits, 2);
  assert.strictEqual(e.touches, 4);
});

test('a file that was only read has zero edits (a number, not absent)', async () => {
  const fog = await fogOf([[call('Read', CWD + '/r.js', T0 - 5)]]);
  assert.strictEqual(fog.files.find(x => x.path === 'r.js').edits, 0);
});

test('edits add up across sessions', async () => {
  const f = CWD + '/m.js';
  const fog = await fogOf([[call('Edit', f, T0 - 9)], [call('Edit', f, T0 - 8), call('Edit', f, T0 - 7)]]);
  assert.strictEqual(fog.files.find(x => x.path === 'm.js').edits, 3);
});

test('a second read of the same transcript (the cache) does not double the count', async () => {
  const projectsDir = dirWith([[call('Edit', CWD + '/c.js', T0 - 1)]]);
  await readFog({ cwd: CWD, projectsDir, now: () => T0 });
  const again = await readFog({ cwd: CWD, projectsDir, now: () => T0 });
  assert.strictEqual(again.files.find(x => x.path === 'c.js').edits, 1);
});

test('a dark file has no edits', async () => {
  const fog = await readFog({ cwd: CWD, projectsDir: dirWith([[]]), now: () => T0, tracked: ['never.js'] });
  assert.strictEqual(fog.files.find(x => x.path === 'never.js').edits, 0);
});
