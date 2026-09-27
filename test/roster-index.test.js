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

const { agentDefinitions, historyNames, wholeRoster } = require('../host/roster-index');
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

  const names = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], ['code-reviewer']);
});

test('agentDefinitions falls back to the filename when there is no frontmatter name', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'miguel.md', 'just a body, no frontmatter at all');

  const names = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], ['miguel']);
});

test('agentDefinitions falls back to the filename when frontmatter has no name: key', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'dexter.md',
    '---' + NL + 'description: logic review' + NL + '---' + NL + 'body');

  const names = await agentDefinitions({ homeDir: home });
  assert.deepStrictEqual([...names], ['dexter']);
});

test('agentDefinitions merges the global and per-project agent directories', async () => {
  const home = tmpDir('cc-roster-home-');
  const cwd = tmpDir('cc-roster-proj-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'global.md',
    '---' + NL + 'name: global-agent' + NL + '---');
  writeAgentMd(path.join(cwd, '.claude', 'agents'), 'local.md',
    '---' + NL + 'name: local-agent' + NL + '---');

  const names = await agentDefinitions({ homeDir: home, cwd });
  assert.deepStrictEqual([...names].sort(), ['global-agent', 'local-agent']);
});

test('agentDefinitions ignores non-.md files and tolerates a missing directory', async () => {
  const home = tmpDir('cc-roster-home-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'notes.txt', 'not an agent');

  const names = await agentDefinitions({ homeDir: home, cwd: path.join(home, 'no-such-project') });
  assert.deepStrictEqual([...names], []);
});

test('agentDefinitions de-dupes a name defined in both places', async () => {
  const home = tmpDir('cc-roster-home-');
  const cwd = tmpDir('cc-roster-proj-');
  writeAgentMd(path.join(home, '.claude', 'agents'), 'a.md', '---' + NL + 'name: shared' + NL + '---');
  writeAgentMd(path.join(cwd, '.claude', 'agents'), 'b.md', '---' + NL + 'name: shared' + NL + '---');

  const names = await agentDefinitions({ homeDir: home, cwd });
  assert.deepStrictEqual([...names], ['shared']);
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
