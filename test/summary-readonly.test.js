'use strict';
/**
 * The summary is READ-ONLY (backlog #39, DESIGN_SLAVE_MODE_SUMMARY.md decision 7): it never types into a session,
 * never edits a project's files and never posts anywhere. This reads the SOURCE of the modules that touch a
 * session's transcript or talk to the model and refuses any way of writing a file, spawning a process or typing
 * into a pty. (Source-text test: it requires nothing from host/, so it stays out of the Stryker command.)
 *
 * Allowed to write, by design, and so not listed here: host/summary-store.js (its own summaries folder) and
 * host/summary-slot.js (its own lock file).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The code, not the prose about it.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WRITES = /\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rm\(|rename|renameSync|mkdir|mkdirSync|copyFile|truncate|createWriteStream|child_process|spawn|exec|execFile|fork)\b/;

for (const f of ['host/summary-text.js', 'host/summary-scheduler.js', 'host/summary-ollama.js', 'host/summary-service.js', 'app/summary-display.js']) {
  test(`${f} has no way to write a file, run a program or type into a session`, () => {
    if (!fs.existsSync(path.join(__dirname, '..', f))) return;     // the display module lands in a later commit
    assert.doesNotMatch(code(read(f)), WRITES);
    assert.doesNotMatch(code(read(f)), /\b(ptyWrite|pty\.write|term\.write|send\()/);
  });
}

test('the service opens a transcript only for reading', () => {
  const src = code(read('host/summary-service.js'));
  const opens = [...src.matchAll(/openSync\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(opens.length >= 1);
  for (const o of opens) assert.match(o, /['"]r['"]\s*$/);
});

test('the client only ever names Ollama\'s three read endpoints, and never /api/pull', () => {
  const src = code(read('host/summary-ollama.js'));
  assert.doesNotMatch(src, /\/api\/(pull|push|create|delete|copy)/);
  const paths = [...src.matchAll(/['"](\/api\/[a-z]+|\/)['"]/g)].map(m => m[1]);
  for (const p of paths) assert.ok(['/', '/api/tags', '/api/generate'].includes(p), p);
});
