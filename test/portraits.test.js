'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { portraitFor, listStates, placeholderFor } = require('../host/portraits');

function portraits(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-portraits-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-portraits-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-forge-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-forge-'));
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'happy@128.png'), 'x');
  assert.strictEqual(portraitFor('a', 'happy', { portraitsDir: dir }).kind, 'placeholder');
});

// --- three-tier resolution: uploaded > forge > shipped > placeholder --------
//
// FF7: Ricardo will upload his own per-state images, GIFs and video later; the
// four states stay in the data model. Only the DEFAULT asset collapses to one
// image reused across all four when nothing per-state exists yet.

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTree(dir, tree) {
  for (const [agent, files] of Object.entries(tree)) {
    fs.mkdirSync(path.join(dir, agent), { recursive: true });
    for (const name of files) fs.writeFileSync(path.join(dir, agent, name), 'x');
  }
}

test('the FORGE tier now reports itself as tier "forge", not just kind "file"', () => {
  const dir = portraits({ 'code-reviewer': ['working'] });
  const p = portraitFor('code-reviewer', 'working', { portraitsDir: dir });
  assert.strictEqual(p.kind, 'file');
  assert.strictEqual(p.tier, 'forge');
  assert.strictEqual(p.media, 'image');
});

test('placeholders report tier "text", so a caller can always ask "which tier answered?"', () => {
  const p = placeholderFor('spring-boot-engineer');
  assert.strictEqual(p.kind, 'placeholder');
  assert.strictEqual(p.tier, 'text');
});

test('an UPLOADED per-state file wins over a forge portrait for the same agent and state', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  const portraitsDir = tmpdir('cc-forge-');
  writeTree(uploadsDir, { 'code-reviewer': ['working.png'] });
  writeTree(portraitsDir, { 'code-reviewer': ['working.png'] });

  const p = portraitFor('code-reviewer', 'working', { uploadsDir, portraitsDir });
  assert.strictEqual(p.tier, 'uploaded');
  assert.ok(p.path.startsWith(uploadsDir), 'the uploaded path must live under uploadsDir');
});

test('an UPLOADED per-agent default.<ext> covers a state with no upload of its own', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  writeTree(uploadsDir, { 'code-reviewer': ['default.png'] });

  const p = portraitFor('code-reviewer', 'sleeping', { uploadsDir });
  assert.strictEqual(p.tier, 'uploaded');
  assert.ok(p.path.endsWith('default.png'));
});

test('a per-state upload beats that same agent\'s own default.<ext> -- the default never overrides a state file', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  writeTree(uploadsDir, { 'code-reviewer': ['default.png', 'working.png'] });

  const p = portraitFor('code-reviewer', 'working', { uploadsDir });
  assert.strictEqual(p.tier, 'uploaded');
  assert.ok(p.path.endsWith('working.png'), `expected the state file, got ${p.path}`);
});

test('uploads accept gif, webp, webm and mp4 alongside png/jpg', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  writeTree(uploadsDir, { 'code-reviewer': ['working.webm'] });

  const p = portraitFor('code-reviewer', 'working', { uploadsDir });
  assert.strictEqual(p.tier, 'uploaded');
  assert.strictEqual(p.media, 'video');
});

test('uploaded video media is classified as "video" and everything else as "image"', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  writeTree(uploadsDir, { a: ['x.mp4'], b: ['x.gif'], c: ['x.webp'] });

  assert.strictEqual(portraitFor('a', 'x', { uploadsDir }).media, 'video');
  assert.strictEqual(portraitFor('b', 'x', { uploadsDir }).media, 'image');
  assert.strictEqual(portraitFor('c', 'x', { uploadsDir }).media, 'image');
});

test('the FORGE tier honours portraits/_default/<state>.png for a one-character-for-everyone rollout', () => {
  const portraitsDir = tmpdir('cc-forge-');
  writeTree(portraitsDir, { _default: ['working.png'] });

  const p = portraitFor('spring-boot-engineer', 'working', { portraitsDir });
  assert.strictEqual(p.tier, 'forge');
  assert.ok(p.path.includes('_default'));
});

test('the FORGE tier falls back to portraits/_default/default.png when no per-state _default exists', () => {
  const portraitsDir = tmpdir('cc-forge-');
  writeTree(portraitsDir, { _default: ['default.png'] });

  const p = portraitFor('spring-boot-engineer', 'sleeping', { portraitsDir });
  assert.strictEqual(p.tier, 'forge');
  assert.ok(p.path.endsWith('default.png'));
});

test('an agent\'s own forge portrait beats _default, which beats an upload the agent does not have', () => {
  const portraitsDir = tmpdir('cc-forge-');
  writeTree(portraitsDir, {
    'code-reviewer': ['working.png'],
    _default: ['working.png'],
  });

  const p = portraitFor('code-reviewer', 'working', { portraitsDir });
  assert.strictEqual(p.tier, 'forge');
  assert.ok(!p.path.includes('_default'));
});

test('the SHIPPED tier is used when no upload and no forge portrait exist', () => {
  const shippedDir = tmpdir('cc-shipped-');
  fs.writeFileSync(path.join(shippedDir, 'portrait-default.png'), 'x');

  const p = portraitFor('anyone', 'working', { shippedDir });
  assert.strictEqual(p.kind, 'file');
  assert.strictEqual(p.tier, 'shipped');
  assert.ok(p.path.startsWith(shippedDir));
});

test('the SHIPPED tier is a graceful absence today -- no file ships, so every agent still gets a placeholder', () => {
  // app/assets/portrait-default.* does not exist yet, deliberately: this
  // change makes the lookup real without generating or committing a
  // placeholder image.
  const shippedDir = path.join(__dirname, '..', 'app', 'assets');
  const p = portraitFor('anyone-at-all', 'working', { shippedDir });
  assert.strictEqual(p.kind, 'placeholder');
});

test('the SHIPPED tier is never consulted before forge, and never before an upload', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  const portraitsDir = tmpdir('cc-forge-');
  const shippedDir = tmpdir('cc-shipped-');
  writeTree(portraitsDir, { 'code-reviewer': ['working.png'] });
  fs.writeFileSync(path.join(shippedDir, 'portrait-default.png'), 'x');

  const p = portraitFor('code-reviewer', 'working', { portraitsDir, uploadsDir, shippedDir });
  assert.strictEqual(p.tier, 'forge');
});

// --- property-style invariants ----------------------------------------------
// No property-testing library is a dependency of this project (it is JS, not
// the Python codebases CLAUDE.md's hypothesis mandate targets); these fuzz a
// wide combination space by hand instead of asserting one fixed fixture.

test('PROPERTY: resolution is total -- every (agent, state) pair yields exactly one tier', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  const portraitsDir = tmpdir('cc-forge-');
  const shippedDir = tmpdir('cc-shipped-');
  const agents = ['code-reviewer', 'spring-boot-engineer', 'a', 'zzz-long-agent-name'];
  const states = ['sleeping', 'working', 'happy', 'stressed', 'thinking'];
  const KNOWN_TIERS = new Set(['uploaded', 'forge', 'shipped', 'text']);

  for (const agent of agents) {
    for (const state of states) {
      const p = portraitFor(agent, state, { uploadsDir, portraitsDir, shippedDir });
      assert.ok(p && typeof p === 'object', `${agent}/${state} produced no result`);
      assert.ok(KNOWN_TIERS.has(p.tier), `${agent}/${state} produced an unknown tier: ${p.tier}`);
      assert.strictEqual(p.kind, p.tier === 'text' ? 'placeholder' : 'file');
    }
  }
});

test('PROPERTY: uploaded beats forge beats shipped beats text, whenever the higher tier exists', () => {
  const AGENT = 'code-reviewer';
  const STATE = 'working';
  const combos = [
    { upload: false, forge: false, shipped: false, expect: 'text' },
    { upload: false, forge: false, shipped: true, expect: 'shipped' },
    { upload: false, forge: true, shipped: false, expect: 'forge' },
    { upload: false, forge: true, shipped: true, expect: 'forge' },
    { upload: true, forge: false, shipped: false, expect: 'uploaded' },
    { upload: true, forge: false, shipped: true, expect: 'uploaded' },
    { upload: true, forge: true, shipped: false, expect: 'uploaded' },
    { upload: true, forge: true, shipped: true, expect: 'uploaded' },
  ];

  for (const combo of combos) {
    const uploadsDir = tmpdir('cc-uploads-');
    const portraitsDir = tmpdir('cc-forge-');
    const shippedDir = tmpdir('cc-shipped-');
    if (combo.upload) writeTree(uploadsDir, { [AGENT]: [`${STATE}.png`] });
    if (combo.forge) writeTree(portraitsDir, { [AGENT]: [`${STATE}.png`] });
    if (combo.shipped) fs.writeFileSync(path.join(shippedDir, 'portrait-default.png'), 'x');

    const p = portraitFor(AGENT, STATE, { uploadsDir, portraitsDir, shippedDir });
    assert.strictEqual(p.tier, combo.expect,
      `combo ${JSON.stringify(combo)} resolved to ${p.tier}, expected ${combo.expect}`);
  }
});

test('PROPERTY: a per-agent default never overrides a per-state file, in either tier that has one', () => {
  const AGENT = 'code-reviewer';
  const STATE = 'working';

  const uploadsDir = tmpdir('cc-uploads-');
  writeTree(uploadsDir, { [AGENT]: ['default.png', `${STATE}.png`] });
  const uploaded = portraitFor(AGENT, STATE, { uploadsDir });
  assert.ok(uploaded.path.endsWith(`${STATE}.png`), 'uploaded default overrode the per-state file');

  const portraitsDir = tmpdir('cc-forge-');
  writeTree(portraitsDir, { _default: [`${STATE}.png`, 'default.png'], [AGENT]: [`${STATE}.png`] });
  const forged = portraitFor(AGENT, STATE, { portraitsDir });
  assert.ok(!forged.path.includes('_default'), 'the shared _default overrode the agent\'s own portrait');
});

test('PROPERTY: the result path is always inside the directory of the tier it claims', () => {
  const uploadsDir = tmpdir('cc-uploads-');
  const portraitsDir = tmpdir('cc-forge-');
  const shippedDir = tmpdir('cc-shipped-');
  writeTree(uploadsDir, { a: ['working.png'], b: ['default.gif'] });
  writeTree(portraitsDir, { a: ['sleeping.png'], _default: ['happy.png'] });
  fs.writeFileSync(path.join(shippedDir, 'portrait-default.jpg'), 'x');

  const DIR_FOR_TIER = { uploaded: uploadsDir, forge: portraitsDir, shipped: shippedDir };
  const agents = ['a', 'b', 'c'];
  const states = ['working', 'sleeping', 'happy', 'stressed'];

  for (const agent of agents) {
    for (const state of states) {
      const p = portraitFor(agent, state, { uploadsDir, portraitsDir, shippedDir });
      if (p.kind !== 'file') continue;
      const root = DIR_FOR_TIER[p.tier];
      assert.ok(root, `unexpected tier claimed on a file result: ${p.tier}`);
      const rel = path.relative(root, p.path);
      assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel),
        `${p.tier} result ${p.path} escapes its own directory ${root}`);
    }
  }
});
