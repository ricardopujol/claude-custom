'use strict';
/**
 * BACKLOG #23: every reader of the CLI's own state honours CLAUDE_CONFIG_DIR. The CLI writes transcripts,
 * credentials, agents and settings under it when it's set, so a reader that guesses ~/.claude reads nothing.
 * One resolver (host/claude-config-dir.js), one test per reader (env set -> under it; unset/blank -> ~/.claude),
 * and a repo guard (test/source-contracts.test.js) so the next reader can't hard-code the default again.
 *
 * HERMETIC: nothing here depends on the runner's own CLAUDE_CONFIG_DIR; every test that reads the live env sets or
 * clears it through withEnv.
 *
 * What the real CLI does with odd values was MEASURED (verify/probe-config-dir.js, `claude auth status`, 2026-10-06):
 * a relative value is anchored against the cwd the CLI runs in; a trailing space is KEPT (it created a folder
 * literally named "cfg "); a blank or empty value is the default. The resolver matches: it never trims a real value.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const resolver = require('../host/claude-config-dir');
const { claudeConfigDir, claudeProjectsDir, setConfigAnchor } = resolver;

const DEFAULT = path.join(os.homedir(), '.claude');
const ROOT = path.parse(os.homedir()).root;
const CFG = path.join(ROOT, 'cfg-elsewhere');

async function withEnv(value, fn) {
  const was = process.env.CLAUDE_CONFIG_DIR;
  try {
    if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = value;
    return await fn();
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
  }
}

test.afterEach(() => setConfigAnchor(null));

// --- the resolver ----------------------------------------------------------------------------

test('resolver: an absolute value is used as-is (a trailing space is kept, like the CLI); blank or absent means ~/.claude', () => {
  const home = path.join(ROOT, 'home');
  const def = path.join(home, '.claude');
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: CFG }, home }), CFG);
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: CFG + ' ' }, home }), CFG + ' ');
  for (const v of ['', '   ', '\t', 5, null, undefined]) {
    assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: v }, home }), def, JSON.stringify(v));
  }
  assert.strictEqual(claudeConfigDir({ env: {}, home }), def);
  assert.strictEqual(claudeConfigDir({ env: null, home }), def);
  assert.strictEqual(claudeProjectsDir({ env: { CLAUDE_CONFIG_DIR: CFG }, home }), path.join(CFG, 'projects'));
});

test('resolver (property): never empty, always absolute; an absolute value comes back unchanged, else ~/.claude or anchored', () => {
  const home = path.join(ROOT, 'home');
  fc.assert(fc.property(fc.oneof(fc.string(), fc.constant(undefined), fc.constant(null), fc.integer()), v => {
    const got = claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: v }, home, cwd: path.join(ROOT, 'tab') });
    assert.ok(typeof got === 'string' && got.length > 0 && path.isAbsolute(got), String(got));
    if (typeof v !== 'string' || !v.trim()) assert.strictEqual(got, path.join(home, '.claude'));
    else if (path.isAbsolute(v)) assert.strictEqual(got, v);
  }));
});

test('resolver: a relative value is anchored against the cwd the CLI runs in, never the host process cwd', () => {
  const tab = path.join(ROOT, 'work', 'tab');
  assert.notStrictEqual(path.resolve(tab), process.cwd(), 'the test needs a tab cwd that is not the host cwd');
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '.cc' }, cwd: tab }), path.join(tab, '.cc'));
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: path.join('..', 'cc') }, cwd: tab }), path.join(ROOT, 'work', 'cc'));
  // the host registers its tab cwd once; the readers then agree without being told
  setConfigAnchor(tab);
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '.cc' } }), path.join(tab, '.cc'));
  assert.strictEqual(claudeProjectsDir({ env: { CLAUDE_CONFIG_DIR: '.cc' } }), path.join(tab, '.cc', 'projects'));
  // an explicit cwd beats the registered one; an absolute value ignores both
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '.cc' }, cwd: ROOT }), path.join(ROOT, '.cc'));
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: CFG } }), CFG);
  // unset: the anchor is irrelevant
  assert.strictEqual(claudeConfigDir({ env: {}, home: path.join(ROOT, 'h') }), path.join(ROOT, 'h', '.claude'));
  setConfigAnchor(null);
  assert.strictEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '.cc' } }), path.resolve('.cc'));
});

test('resolver: env present-but-undefined means NO env; no env key at all reads the live process', async () => {
  const home = path.join(ROOT, 'home');
  await withEnv(CFG, () => {
    assert.strictEqual(claudeConfigDir({ env: undefined, home }), path.join(home, '.claude'));
    assert.strictEqual(claudeConfigDir({ home }), CFG);
    assert.strictEqual(claudeConfigDir(), CFG);
  });
  await withEnv(undefined, () => assert.strictEqual(claudeConfigDir(), DEFAULT));
});

test('wand-skills claudeHomeOf keeps its contract: no env means no env, even when the process has one', async () => {
  const { claudeHomeOf } = require('../host/wand-skills');
  const home = path.join(ROOT, 'home');
  await withEnv(CFG, () => {
    assert.strictEqual(claudeHomeOf({ home }), path.join(home, '.claude'));
    assert.strictEqual(claudeHomeOf({ env: process.env, home }), CFG);
  });
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
  test(`${name}: default transcripts dir follows CLAUDE_CONFIG_DIR`, async () => {
    assert.strictEqual(await withEnv(CFG, read), path.join(CFG, 'projects'));
    assert.strictEqual(await withEnv('', read), path.join(DEFAULT, 'projects'));
    assert.strictEqual(await withEnv(undefined, read), path.join(DEFAULT, 'projects'));
  });
}

test('agent-stats.defaultProjectsDir is the same default agent-log-session falls back to', async () => {
  const { defaultProjectsDir } = require('../host/agent-stats');
  assert.strictEqual(await withEnv(undefined, () => defaultProjectsDir()), path.join(os.homedir(), '.claude', 'projects'));
});

test('quota: credentials live under CLAUDE_CONFIG_DIR', async () => {
  const read = () => require('../host/quota').defaultCredentialsPath();
  assert.strictEqual(await withEnv(CFG, read), path.join(CFG, '.credentials.json'));
  assert.strictEqual(await withEnv('  ', read), path.join(DEFAULT, '.credentials.json'));
});

test('session-registry: the registry lives under CLAUDE_CONFIG_DIR', async () => {
  const { defaultRegistryDir } = require('../host/session-registry');
  assert.strictEqual(await withEnv(CFG, () => defaultRegistryDir()), path.join(CFG, 'sessions'));
});

test('roster-index: user agents live under CLAUDE_CONFIG_DIR, project agents stay under cwd', async () => {
  const { agentDefinitions } = require('../host/roster-index');
  const readFile = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const cwd = path.join(ROOT, 'proj');
  const listed = [];
  const fsp = fs.promises;
  const real = fsp.readdir;
  fsp.readdir = async d => { listed.push(d); throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  try {
    await withEnv(CFG, () => agentDefinitions({ cwd, readFile }));
    await withEnv(undefined, () => agentDefinitions({ cwd, readFile }));
    await agentDefinitions({ configDir: path.join(ROOT, 'explicit'), cwd, readFile });
  } finally { fsp.readdir = real; }
  assert.deepStrictEqual(listed, [
    path.join(CFG, 'agents'), path.join(cwd, '.claude', 'agents'),
    path.join(DEFAULT, 'agents'), path.join(cwd, '.claude', 'agents'),
    path.join(ROOT, 'explicit', 'agents'), path.join(cwd, '.claude', 'agents'),
  ]);
});

test('settings: the user statusLine is read from the config dir', () => {
  const { findUserStatusLine } = require('../host/settings-writer');
  const root = tmpDir('cc-cfgdir-');
  const cfg = path.join(root, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'from-cfg' } }));
  assert.strictEqual(findUserStatusLine({ configDir: cfg }).command, 'from-cfg');
  assert.strictEqual(findUserStatusLine({ configDir: path.join(root, 'nowhere') }), null);
});

// The "no export" readers, measured by what they find rather than by what their source says.
function transcriptUnder(cfg, cwd) {
  const { projectDirName } = require('../host/project-dir');
  const dir = path.join(cfg, 'projects', projectDirName(cwd.replace(/\\/g, '/')));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('fog: with CLAUDE_CONFIG_DIR set and no projectsDir, the transcripts are found under it', async () => {
  const { readFog } = require('../host/fog');
  const cfg = tmpDir('cc-fog-cfg-');
  const cwd = path.join(tmpDir('cc-fog-proj-'), 'proj');
  fs.writeFileSync(path.join(transcriptUnder(cfg, cwd), 's1.jsonl'), '{}\n');
  const r = await withEnv(cfg, () => readFog({ cwd }));
  assert.strictEqual(r.status.transcriptsMissing, false);
  assert.strictEqual(r.status.transcriptsFound, 1);
  const none = await withEnv(path.join(cfg, 'empty'), () => readFog({ cwd }));
  assert.strictEqual(none.status.transcriptsMissing, true);
});

test('repo-diff: with CLAUDE_CONFIG_DIR set and no projectsDir, the transcripts are found under it', async () => {
  const { claudeCallsFor } = require('../host/repo-diff');
  const cfg = tmpDir('cc-rd-cfg-');
  const root = path.join(tmpDir('cc-rd-proj-'), 'proj');
  fs.writeFileSync(path.join(transcriptUnder(cfg, root), 's1.jsonl'), '{}\n');
  assert.strictEqual((await withEnv(cfg, () => claudeCallsFor({ root, rel: 'a.js' }))).transcripts, true);
  assert.strictEqual((await withEnv(path.join(cfg, 'empty'), () => claudeCallsFor({ root, rel: 'a.js' }))).transcripts, false);
});

test('agent-stats-cache: with CLAUDE_CONFIG_DIR set and no projectsDir, subagent transcripts are read from under it', async () => {
  const { lifetimeAgentTokens } = require('../host/agent-stats-cache');
  const cfg = tmpDir('cc-asc-cfg-');
  const sub = path.join(transcriptUnder(cfg, path.join(ROOT, 'p')), 'sess1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, 'agent-a1.jsonl');
  fs.writeFileSync(file, '{}\n');
  const read = [];
  const readFile = async f => { read.push(f); return { total: 1, ms: 0 }; };
  await withEnv(cfg, () => lifetimeAgentTokens({ readFile }));
  assert.deepStrictEqual(read, [file]);
});

// --- drop: the relocated config dir holds credentials too ------------------------------------

test('drop: the config dir (and anything in it, or holding it) is never granted, wherever CLAUDE_CONFIG_DIR puts it', () => {
  const { planDrop } = require('../host/drop');
  const cwd = 'C:/proj';
  const configDir = 'D:\\claude-work';
  const refused = p => planDrop({ entries: [{ path: p, isDirectory: true }], cwd, home: 'C:/Users/r', configDir }).refused;
  assert.strictEqual(refused('D:\\claude-work').length, 1);
  assert.strictEqual(refused('D:\\claude-work\\projects').length, 1);
  assert.strictEqual(refused('d:/CLAUDE-WORK/').length, 1);
  assert.strictEqual(refused('D:\\other').length, 0, 'an unrelated folder is still grantable');
  const parent = planDrop({ entries: [{ path: 'D:\\', isDirectory: true }], cwd, configDir }).refused;
  assert.strictEqual(parent.length, 1);
  const holder = planDrop({ entries: [{ path: 'D:\\ws', isDirectory: true }], cwd, configDir: 'D:\\ws\\claude-work' }).refused;
  assert.strictEqual(holder.length, 1, 'a folder that CONTAINS the config dir would grant it');
  // without a configDir the old behaviour holds: ~/.claude by name
  assert.strictEqual(planDrop({ entries: [{ path: 'C:\\Users\\r\\.claude', isDirectory: true }], cwd, home: 'C:/Users/r' }).refused.length, 1);
});
