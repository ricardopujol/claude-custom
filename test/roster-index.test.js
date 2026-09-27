'use strict';
/**
 * The WHOLE roster (BACKLOG D #16): definitions + history, across every
 * project -- not just the one the harness happens to be running in.
 *
 * The identity risk is the same one host/agent-stats.js already solved (a
 * NAMED spawn must resolve to its TYPE, never its label) and this module must
 * reuse that resolution rather than re-deriving it, so this suite pins that a
 * named spawn in the history half resolves the same way it does there.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  agentDefinitions, historyNames, wholeRoster, nameFromFrontmatter, scanProjects, resolveSubagentEntry,
} = require('../host/roster-index');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);

function writeAgentMd(dir, filename, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

const U = (input, output) => ({ input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

function session(dir, name, spawns) {
  const lines = spawns.map((s, i) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    message: {
      usage: U(1, 1),
      content: [{
        type: 'tool_use', id: s.id, name: 'Agent',
        input: { subagent_type: s.type, ...(s.name ? { name: s.name } : {}) },
      }],
    },
  }));
  fs.writeFileSync(path.join(dir, name + '.jsonl'), lines.join(NL) + NL);
}

function subagent(dir, sessionName, file, meta, entries) {
  const sd = path.join(dir, sessionName, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join(NL) + NL);
}

const turn = (minute, usage) => ({
  type: 'assistant',
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(),
  message: { usage },
});

// --- definitions --------------------------------------------------------------

test('agentDefinitions reads name: from frontmatter', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'reviewer.md',
    '---' + NL + 'name: code-reviewer' + NL + 'description: reviews code' + NL + '---' + NL + 'body');

  const { names } = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], ['code-reviewer']);
});

test('agentDefinitions falls back to the filename when there is no frontmatter name', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'miguel.md', 'just a body, no frontmatter at all');

  const { names } = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], ['miguel']);
});

test('agentDefinitions falls back to the filename when frontmatter has no name: key', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'dexter.md',
    '---' + NL + 'description: logic review' + NL + '---' + NL + 'body');

  const { names } = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], ['dexter']);
});

test('agentDefinitions merges the global and per-project agent directories', async () => {
  const home = tmpDir('cc-roster-home-');
  const cwd = tmpDir('cc-roster-proj-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'global.md',
    '---' + NL + 'name: global-agent' + NL + '---');
  writeAgentMd(path.join(cwd, '.claude', 'agents'), 'local.md',
    '---' + NL + 'name: local-agent' + NL + '---');

  const { names } = await agentDefinitions({ homeDir: home, cwd });
  assert.deepStrictEqual([...names].sort(), ['global-agent', 'local-agent']);
});

test('agentDefinitions ignores non-.md files and tolerates a missing directory', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'notes.txt', 'not an agent');

  const { names } = await agentDefinitions({ homeDir: home, cwd: path.join(home, 'no-such-project') });
  assert.deepStrictEqual([...names], []);
});

test('agentDefinitions de-dupes a name defined in both places', async () => {
  const home = tmpDir('cc-roster-home-');
  const cwd = tmpDir('cc-roster-proj-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'a.md', '---' + NL + 'name: shared' + NL + '---');
  writeAgentMd(path.join(cwd, '.claude', 'agents'), 'b.md', '---' + NL + 'name: shared' + NL + '---');

  const { names } = await agentDefinitions({ homeDir: home, cwd });
  assert.deepStrictEqual([...names], ['shared']);
});

// --- Dexter N6 (definitions half) / F8 residual, PR #59 R2 ----------------------

test('agentDefinitions counts a REAL failure to list an agents directory, not just ENOENT', async () => {
  const home = tmpDir('cc-roster-home-');
  // A FILE where the agents directory should be: readdir throws ENOTDIR, a
  // real failure, never the ordinary "no such directory" case.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agents'), 'not a directory');

  const { names, unreadable } = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], []);
  assert.strictEqual(unreadable, 1);
});

test('agentDefinitions counts an unreadable definition file rather than silently falling back uncounted', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'weird.md', 'irrelevant -- readFile is injected below');

  // A real EACCES/EPERM on a genuine `.md` FILE isn't reliably reproducible
  // across platforms in a test without admin/root tricks, so the failing read
  // is injected (Dexter F8 residual) -- the same DI pattern
  // host/agent-stats-cache.js's `lifetimeAgentTokens` already uses for its own
  // `readFile`.
  const throwing = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };

  const { names, unreadable } = await agentDefinitions({ homeDir: home, readFile: throwing });
  assert.deepStrictEqual([...names], ['weird'], 'the fallback-to-filename behaviour must still apply');
  assert.strictEqual(unreadable, 1);
});

// --- history, across every project ---------------------------------------------

function project(root, cwd) {
  const dir = path.join(root, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('historyNames resolves a NAMED spawn to its TYPE, same as agent-stats.js', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'code-reviewer', name: 'miguel-usage' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'miguel-usage', requestShape: 'background' },
    [turn(0, U(100, 0))]);

  const { names } = await historyNames({ projectsDir: root });
  assert.deepStrictEqual([...names], ['code-reviewer']);
});

test('historyNames covers EVERY project under the projects dir, not just one', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const dirB = project(root, 'C:/w/proj-b');
  session(dirB, 's1', [{ id: 'toolu_1', type: 'dexter' }]);
  subagent(dirB, 's1', 'agent-a', { agentType: 'dexter', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const { names } = await historyNames({ projectsDir: root });
  assert.deepStrictEqual([...names].sort(), ['dexter', 'paris']);
});

test('historyNames dedupes an agent that ran in two different projects', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'miguel' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'miguel', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const dirB = project(root, 'C:/w/proj-b');
  session(dirB, 's1', [{ id: 'toolu_1', type: 'miguel' }]);
  subagent(dirB, 's1', 'agent-a', { agentType: 'miguel', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const { names } = await historyNames({ projectsDir: root });
  assert.deepStrictEqual([...names], ['miguel']);
});

test('historyNames returns nothing, not a failure, when ~/.claude/projects does not exist', async () => {
  const root = tmpDir('cc-roster-projects-');
  const { names, unreadable } = await historyNames({ projectsDir: path.join(root, 'absent') });
  assert.deepStrictEqual([...names], []);
  assert.strictEqual(unreadable, 0);
});

// --- the union -------------------------------------------------------------------

test('wholeRoster is definitions UNION history', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'a.md', '---' + NL + 'name: never-run' + NL + '---');

  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'has-run' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'has-run', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const { names } = await wholeRoster({ homeDir: home, projectsDir: root });
  assert.deepStrictEqual(names.sort(), ['has-run', 'never-run']);
});

// --- Dexter F8: a quoted YAML name must not create a duplicate row -------------

test('nameFromFrontmatter strips surrounding double quotes', () => {
  assert.strictEqual(nameFromFrontmatter('---' + NL + 'name: "code-reviewer"' + NL + '---', 'f'),
    'code-reviewer');
});

test('nameFromFrontmatter strips surrounding single quotes', () => {
  assert.strictEqual(nameFromFrontmatter('---' + NL + "name: 'code-reviewer'" + NL + '---', 'f'),
    'code-reviewer');
});

test('a quoted definition name matches the same agent found in history -- one row, not two', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'reviewer.md',
    '---' + NL + 'name: "code-reviewer"' + NL + '---');

  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'code-reviewer' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const { names } = await wholeRoster({ homeDir: home, projectsDir: root });
  assert.deepStrictEqual(names, ['code-reviewer'], 'the quoted definition must not create a second row');
});

// --- Dexter F5 / Miguel M1 / F10: one shared project scan ----------------------

test('scanProjects walks every project once, carrying files+identityTables for each', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const { projects, errors } = await scanProjects(root);
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(errors, 0);
  assert.ok(Array.isArray(projects[0].files));
  assert.ok(projects[0].tables && projects[0].tables.byToolUse instanceof Map);
});

test('historyNames accepts a pre-computed scan instead of walking again', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const scan = await scanProjects(root);
  const { names } = await historyNames({ scan });
  assert.deepStrictEqual([...names], ['paris']);
});

test('wholeRoster folds the shared scan errors in exactly once (Miguel L2)', async () => {
  const root = tmpDir('cc-roster-projects-');
  // A file where a project directory should be makes transcriptFiles' walk
  // enumerate it fine (readdir lists files and dirs alike) but the identity
  // pass sees an empty project -- not the shape under test here. Use a
  // genuinely unreadable subagents directory instead: a FILE named
  // "subagents" inside a session directory, so readdir on it throws ENOTDIR.
  const dir = project(root, 'C:/w/proj-a');
  fs.mkdirSync(path.join(dir, 's1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1', 'subagents'), 'not a directory');
  fs.writeFileSync(path.join(dir, 's1.jsonl'), '');

  const scan = await scanProjects(root);
  assert.ok(scan.errors >= 1, 'precondition: the shared scan must see the enumeration failure');

  const roster = await wholeRoster({ projectsDir: root, scan });
  assert.strictEqual(roster.unreadable, scan.errors,
    'wholeRoster must fold the shared scan errors in exactly once, not double them');
});

// --- Dexter F3 / Miguel L1: an unresolved label is not a peer of a real type ---

test('an orphaned NAMED spawn is kept as history but flagged unresolved, not silently treated as a type', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  // No parent session .jsonl at all -- the name "miguel-usage" can never be
  // resolved to a real subagent_type, the exact orphan case resolveAgent's own
  // contract warns about.
  subagent(dir, 's1', 'agent-a', { agentType: 'miguel-usage', requestShape: 'background' },
    [turn(0, U(10, 0))]);

  const { names, unresolvedNames } = await historyNames({ projectsDir: root });
  assert.ok(names.has('miguel-usage'), 'a run that really happened is still real history');
  assert.ok(unresolvedNames.has('miguel-usage'), 'but it must be flagged, not drawn as a peer of a real type');
});

test('resolveSubagentEntry reports source and a readError for a corrupt meta.json (Dexter F4)', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-a.meta.json'), '{"agentType":'); // truncated
  fs.writeFileSync(path.join(sd, 'agent-a.jsonl'), JSON.stringify(turn(0, U(10, 0))) + NL);

  const { projects } = await scanProjects(root);
  const file = projects[0].files.find(f => f.subagent);
  const { readError, agent } = await resolveSubagentEntry(file, projects[0].tables);
  assert.strictEqual(readError, true);
  assert.strictEqual(agent, null);
});

test('historyNames counts a corrupt meta.json as unreadable rather than silently dropping the run', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-a.meta.json'), 'null'); // valid JSON, no identity
  fs.writeFileSync(path.join(sd, 'agent-a.jsonl'), JSON.stringify(turn(0, U(10, 0))) + NL);

  const { unreadable } = await historyNames({ projectsDir: root });
  assert.strictEqual(unreadable, 1);
});

// --- Dexter N6, PR #59 R2: a real failure to enumerate the projects root ------

test('scanProjects counts a REAL failure to list the projects root, not just ENOENT', async () => {
  const root = tmpDir('cc-roster-projects-');
  // A FILE where the projects root should be: readdir throws ENOTDIR.
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');

  const { projects, errors } = await scanProjects(notADir);
  assert.deepStrictEqual(projects, []);
  assert.strictEqual(errors, 1);
});

test('a real projects-root failure gives ok:false through wholeRoster, never a confident empty roster', async () => {
  const root = tmpDir('cc-roster-projects-');
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  // An isolated, empty homeDir -- this repo's real `~/.claude/agents` must not
  // leak into a test asserting the roster is EMPTY.
  const home = tmpDir('cc-roster-home-');

  const { names, unreadable } = await wholeRoster({ homeDir: home, projectsDir: notADir });
  assert.deepStrictEqual(names, []);
  assert.ok(unreadable >= 1, 'a real enumeration failure must never report as zero unreadable');
});

test('scanProjects still treats a genuinely missing projects root as zero errors', async () => {
  const root = tmpDir('cc-roster-projects-');
  const { errors } = await scanProjects(path.join(root, 'absent'));
  assert.strictEqual(errors, 0);
});

// --- Dexter N5 (L2 residual), PR #59 R2: identity resolved ONCE, not twice ----

test('scanProjects resolves each subagent identity once, shared by both consumers', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const { projects } = await scanProjects(root);
  const file = projects[0].files.find(f => f.subagent);
  assert.ok(projects[0].resolved instanceof Map);
  assert.deepStrictEqual(projects[0].resolved.get(file.file), { agent: 'paris', source: 'tool-use' });
});

test('a corrupt meta.json is counted exactly ONCE in the whole roster, not once per consumer (Dexter N5)', async () => {
  const root = tmpDir('cc-roster-projects-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-a.meta.json'), 'null'); // valid JSON, no identity
  fs.writeFileSync(path.join(sd, 'agent-a.jsonl'), JSON.stringify(turn(0, U(10, 0))) + NL);
  // An isolated, empty homeDir -- this repo's real `~/.claude/agents` must not
  // contribute a surprise unreadable count of its own.
  const home = tmpDir('cc-roster-home-');

  const { unreadable } = await wholeRoster({ homeDir: home, projectsDir: root });
  assert.strictEqual(unreadable, 1, 'one corrupt file must cost exactly one, not one per consumer');
});
