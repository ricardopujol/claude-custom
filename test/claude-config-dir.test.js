'use strict';
/**
 * BACKLOG #23: every reader of the CLI's own state honours CLAUDE_CONFIG_DIR. The CLI writes transcripts,
 * credentials, agents and settings under it when it's set, so a reader that guesses ~/.claude reads nothing.
 * One resolver (host/claude-config-dir.js), one test per reader (env set -> under it; unset/blank -> ~/.claude),
 * and a repo guard so the next reader can't hard-code the default again.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const { claudeConfigDir, claudeProjectsDir } = require('../host/claude-config-dir');

const DEFAULT = path.join(os.homedir(), '.claude');
const CFG = path.join(path.parse(os.homedir()).root, 'cfg-elsewhere');

function withEnv(value, fn) {
  const was = process.env.CLAUDE_CONFIG_DIR;
  try {
    if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = value;
    return fn();
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
  }
}

// --- the resolver ----------------------------------------------------------------------------

test('resolver: the env value, trimmed; blank or absent means ~/.claude', () => {
  const home = path.join('H:', 'home');
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '  X:\\cfg  ' }, home }), 'X:\\cfg');
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '' }, home }), path.join(home, '.claude'));
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '   ' }, home }), path.join(home, '.claude'));
  assert.strictEqual(claudeConfigDir({ env: {}, home }), path.join(home, '.claude'));
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: 5 }, home }), path.join(home, '.claude'));
  assert.strictEqual(claudeConfigDir({ env: null, home }), path.join(home, '.claude'));
  assert.strictEqual(claudeProjectsDir({ env: { CLAUDE_CONFIG_DIR: 'X:\\cfg' }, home }), path.join('X:\\cfg', 'projects'));
});

test('resolver (property): never an empty path; the trimmed env value when it has one, else ~/.claude', () => {
  const home = path.join('H:', 'home');
  fc.assert(fc.property(fc.oneof(fc.string(), fc.constant(undefined), fc.constant(null), fc.integer()), v => {
    const got = claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: v }, home });
    assert.ok(typeof got === 'string' && got.length > 0);
    const want = typeof v === 'string' && v.trim() ? v.trim() : path.join(home, '.claude');
    assert.strictEqual(got, want);
  }));
});

test('resolver reads process.env and os.homedir() when given nothing', () => {
  assert.strictEqual(withEnv(CFG, () => claudeConfigDir()), CFG);
  assert.strictEqual(withEnv(undefined, () => claudeConfigDir()), DEFAULT);
});

// --- each reader -----------------------------------------------------------------------------

const PROJECTS_READERS = [
  ['agent-stats', () => require('../host/agent-stats').defaultProjectsDir()],
  ['recent', () => require('../host/recent').defaultProjectsDir()],
  ['roster-index', () => require('../host/roster-index').defaultProjectsDir()],
  ['session-model', () => require('../host/session-model').defaultProjectsDir()],
  ['usage', () => require('../host/usage').defaultProjectsDir()],
];

for (const [name, read] of PROJECTS_READERS) {
  test(`${name}: default transcripts dir follows CLAUDE_CONFIG_DIR`, () => {
    assert.strictEqual(withEnv(CFG, read), path.join(CFG, 'projects'));
    assert.strictEqual(withEnv('', read), path.join(DEFAULT, 'projects'));
    assert.strictEqual(withEnv(undefined, read), path.join(DEFAULT, 'projects'));
  });
}

test('quota: credentials live under CLAUDE_CONFIG_DIR', () => {
  const read = () => require('../host/quota').defaultCredentialsPath();
  assert.strictEqual(withEnv(CFG, read), path.join(CFG, '.credentials.json'));
  assert.strictEqual(withEnv('  ', read), path.join(DEFAULT, '.credentials.json'));
});

test('roster-index: user agents live under CLAUDE_CONFIG_DIR, project agents stay under cwd', async () => {
  const { agentDefinitions } = require('../host/roster-index');
  const seen = [];
  const readFile = async f => { seen.push(f); throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const cwd = path.join(path.parse(os.homedir()).root, 'proj');
  const listed = [];
  const fsp = require('fs').promises;
  const real = fsp.readdir;
  fsp.readdir = async d => { listed.push(d); throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  try {
    await withEnv(CFG, () => agentDefinitions({ cwd, readFile }));
    await withEnv(undefined, () => agentDefinitions({ cwd, readFile }));
  } finally { fsp.readdir = real; }
  assert.ok(listed.includes(path.join(CFG, 'agents')), `listed: ${listed.join(' | ')}`);
  assert.ok(listed.includes(path.join(DEFAULT, 'agents')));
  assert.ok(listed.includes(path.join(cwd, '.claude', 'agents')));
});

test('settings: the user statusLine is read from CLAUDE_CONFIG_DIR, falling back to home/.claude', () => {
  const { findUserStatusLine } = require('../host/settings-writer');
  const root = tmpDir('cc-cfgdir-');
  {
    const cfg = path.join(root, 'cfg');
    const home = path.join(root, 'home');
    fs.mkdirSync(cfg, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const sl = c => JSON.stringify({ statusLine: { type: 'command', command: c } });
    fs.writeFileSync(path.join(cfg, 'settings.json'), sl('from-cfg'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), sl('from-home'));
    assert.strictEqual(findUserStatusLine({ home, configDir: cfg }).command, 'from-cfg');
    assert.strictEqual(findUserStatusLine({ home }).command, 'from-home');
  }
});
