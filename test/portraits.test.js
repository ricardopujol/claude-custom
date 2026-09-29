'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { portraitFor, listStates, placeholderFor } = require('../host/portraits');
const { tmpDir } = require('./tmp-dir');

function portraits(tree) {
  const dir = tmpDir('cc-portraits-');
  for (const [agent, states] of Object.entries(tree)) {
    fs.mkdirSync(path.join(dir, agent), { recursive: true });
    for (const s of states) fs.writeFileSync(path.join(dir, agent, s + '.png'), 'x');
  }
  return dir;
}

test('finds a portrait by agent and state', () => {
  const dir = portraits({ 'code-reviewer': ['working'] });
  const p = portraitFor('code-reviewer', 'working', { portraitsDir: dir });
  assert.strictEqual(p.kind, 'file');
  assert.ok(p.path.endsWith('working.png'));
});

test('falls back to a placeholder when the state image is missing', () => {
  const dir = portraits({ 'code-reviewer': ['working'] });
  const p = portraitFor('code-reviewer', 'sleeping', { portraitsDir: dir });
  assert.strictEqual(p.kind, 'placeholder');
});

test('falls back to a placeholder when the agent has no portraits at all', () => {
  // Scope is ~15 named agents; the other ~65 must still render.
  const dir = portraits({});
  const p = portraitFor('spring-boot-engineer', 'working', { portraitsDir: dir });
  assert.strictEqual(p.kind, 'placeholder');
});

test('a missing portraits directory does not throw', () => {
  const p = portraitFor('anyone', 'working', { portraitsDir: path.join(os.tmpdir(), 'cc-none-' + Date.now()) });
  assert.strictEqual(p.kind, 'placeholder');
});

test('placeholders are stable for the same agent', () => {
  // A portrait that changes colour between frames reads as a different agent.
  const a = placeholderFor('code-reviewer');
  const b = placeholderFor('code-reviewer');
  assert.deepStrictEqual(a, b);
});

test('placeholders differ between agents', () => {
  assert.notStrictEqual(placeholderFor('code-reviewer').hue, placeholderFor('logic-reviewer').hue);
});

test('placeholder initials come from the agent name', () => {
  assert.strictEqual(placeholderFor('code-reviewer').initials, 'CR');
  assert.strictEqual(placeholderFor('ai-writing-auditor').initials, 'AW');
  assert.strictEqual(placeholderFor('debugger').initials, 'DE');
});

test('state list is read from config, not hardcoded to four', () => {
  // "thinking" and "waiting on you" are expected to follow.
  const dir = tmpDir('cc-portraits-');
  fs.writeFileSync(path.join(dir, 'states.json'),
    JSON.stringify(['sleeping', 'working', 'happy', 'stressed', 'thinking']));
  assert.deepStrictEqual(listStates({ portraitsDir: dir }),
    ['sleeping', 'working', 'happy', 'stressed', 'thinking']);
});

test('state list falls back to the four built-ins when unconfigured', () => {
  const dir = portraits({});
  assert.deepStrictEqual(listStates({ portraitsDir: dir }),
    ['sleeping', 'working', 'happy', 'stressed']);
});

test('an agent name that could escape the portraits directory is rejected', () => {
  // Agent names key straight into a filesystem path; traversal must not read
  // arbitrary files just because a roster entry was odd.
  const dir = portraits({});
  const p = portraitFor('../../secrets', 'working', { portraitsDir: dir });
  assert.strictEqual(p.kind, 'placeholder');
});

test('finds a portrait at the path the FORGE actually writes', () => {
  // Regression guard on a real bug: the forge wrote
  // portraits/<agent>/states/<state>.png while the harness looked for
  // portraits/<agent>/<state>.png, so every generated portrait was invisible
  // and every agent silently fell back to a placeholder.
  //
  // The existing tests all passed because their fixtures built the layout the
  // READER expected. A fixture that encodes the reader's assumption cannot
  // catch a disagreement with the writer -- so this one is built to mirror the
  // forge's output, including the sibling folders it leaves behind.
  const dir = tmpDir('cc-forge-');
  const agentDir = path.join(dir, 'code-reviewer');
  fs.mkdirSync(path.join(agentDir, 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'states'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'candidates', 'cand-00-seed1.png'), 'x');
  fs.writeFileSync(path.join(agentDir, 'states', 'report.json'), '{}');
  for (const s of ['sleeping', 'working', 'happy', 'stressed']) {
    fs.writeFileSync(path.join(agentDir, `${s}.png`), 'x');
    fs.writeFileSync(path.join(agentDir, `${s}@128.png`), 'x');
  }

  for (const s of ['sleeping', 'working', 'happy', 'stressed']) {
    const p = portraitFor('code-reviewer', s, { portraitsDir: dir });
    assert.strictEqual(p.kind, 'file', `${s} fell back to a placeholder`);
  }
});

test('the @128 variant is not mistaken for a state', () => {
  const dir = tmpDir('cc-forge-');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'happy@128.png'), 'x');
  assert.strictEqual(portraitFor('a', 'happy', { portraitsDir: dir }).kind, 'placeholder');
});
