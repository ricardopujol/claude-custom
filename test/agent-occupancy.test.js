'use strict';
/**
 * host/agent-occupancy.js (backlog #44 + #47): which worktree an agent's own tool call proves it is working
 * in. Examples here; the invariants are in test/agent-occupancy-properties.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const O = require('../host/agent-occupancy');

// A container the way the worktree layout has it: dev\, a sibling, and a subagent worktree nested in dev.
const BASE = path.resolve('/occ-proj');
const DEV = path.join(BASE, 'dev');
const FEAT = path.join(BASE, 'feat-git-tree');
const FEAT2 = path.join(BASE, 'feat-git-tree-2');
const NESTED = path.join(DEV, '.claude', 'worktrees', 'agent-x');
const ROOTS = [DEV, FEAT, FEAT2, NESTED];

const pre = (tool, input, extra = {}) => ({
  event: 'PreToolUse',
  payload: { tool_name: tool, tool_input: input, agent_id: 'ac7618c6a7668687d', agent_type: 'electron-pro', ...extra },
});
const claim = (ev, own = DEV, roots = ROOTS) => O.claimFrom(ev, roots, own);

test('an Edit inside a sibling worktree claims it, naming the agent', () => {
  const c = claim(pre('Edit', { file_path: path.join(FEAT, 'app', 'x.js') }));
  assert.deepStrictEqual(c, { agentId: 'ac7618c6a7668687d', agent: 'electron-pro', worktree: FEAT });
});

for (const tool of ['Read', 'Write', 'Edit']) {
  test(`${tool} claims through file_path`, () => {
    assert.strictEqual(claim(pre(tool, { file_path: path.join(FEAT, 'a.txt') })).worktree, FEAT);
  });
}

test('NotebookEdit names its file notebook_path, and still claims', () => {
  assert.strictEqual(claim(pre('NotebookEdit', { notebook_path: path.join(FEAT, 'n.ipynb') })).worktree, FEAT);
});

test('the longest root wins: dev never swallows a nested worktree, a sibling never swallows a longer name', () => {
  assert.strictEqual(claim(pre('Write', { file_path: path.join(NESTED, 'a.js') })).worktree, NESTED);
  assert.strictEqual(claim(pre('Write', { file_path: path.join(FEAT2, 'a.js') })).worktree, FEAT2);
  assert.strictEqual(claim(pre('Write', { file_path: path.join(FEAT, 'a.js') })).worktree, FEAT);
});

test('the launching session\'s own folder never claims', () => {
  assert.strictEqual(claim(pre('Edit', { file_path: path.join(DEV, 'app', 'x.js') })), null);
  // ...and an own root that is NOT dev works the same (a worktree session launching an agent)
  assert.strictEqual(claim(pre('Edit', { file_path: path.join(FEAT, 'x.js') }), FEAT), null);
  assert.strictEqual(claim(pre('Edit', { file_path: path.join(DEV, 'x.js') }), FEAT).worktree, DEV);
});

test('a path outside every known root claims nothing', () => {
  assert.strictEqual(claim(pre('Read', { file_path: path.resolve('/elsewhere/a.js') })), null);
  // a folder whose name merely STARTS with a root's name is not inside it
  assert.strictEqual(claim(pre('Read', { file_path: FEAT + '-old' + path.sep + 'a.js' })), null);
});

test('a relative path proves nothing (it would resolve against the host, not the agent)', () => {
  assert.strictEqual(claim(pre('Read', { file_path: path.join('feat-git-tree', 'a.js') })), null);
  assert.strictEqual(claim(pre('Read', { file_path: '' })), null);
});

test('only a PreToolUse claims, and only one that carries an agent_id', () => {
  const edit = { file_path: path.join(FEAT, 'a.js') };
  assert.strictEqual(claim({ event: 'PostToolUse', payload: pre('Edit', edit).payload }), null);
  assert.strictEqual(claim({ event: 'SubagentStop', payload: pre('Edit', edit).payload }), null);
  assert.strictEqual(claim(pre('Edit', edit, { agent_id: undefined })), null, 'the main session\'s own call');
  assert.strictEqual(claim(pre('Edit', edit, { agent_id: '' })), null);
  assert.strictEqual(claim(pre('Edit', edit, { agent_id: 7 })), null);
});

test('an agent_id that is not a safe file name never claims (it becomes <id>.json)', () => {
  const edit = { file_path: path.join(FEAT, 'a.js') };
  for (const id of ['..\\x', '../x', 'a/b', 'a b', 'x'.repeat(65), 'con:', '.hidden', 'a.json']) {
    assert.strictEqual(claim(pre('Edit', edit, { agent_id: id })), null, id);
  }
  assert.ok(claim(pre('Edit', edit, { agent_id: 'a_B-9' })));
});

test('a tool that is not Read/Edit/Write/NotebookEdit/Bash claims nothing', () => {
  assert.strictEqual(claim(pre('Grep', { file_path: path.join(FEAT, 'a.js'), pattern: 'x' })), null);
  assert.strictEqual(claim(pre('Agent', { prompt: `work in ${FEAT}`, subagent_type: 'x' })), null,
    'the Agent prompt is never parsed');
});

test('an agent with no agent_type is still a claim, with a null name', () => {
  const c = claim(pre('Edit', { file_path: path.join(FEAT, 'a.js') }, { agent_type: undefined }));
  assert.strictEqual(c.agent, null);
});

test('malformed events never throw and never claim', () => {
  for (const ev of [null, undefined, 3, {}, { event: 'PreToolUse' }, { event: 'PreToolUse', payload: null },
    pre('Edit', null), pre('Edit', 'x'), pre('Edit', { file_path: 5 }), pre('Bash', { command: 5 })]) {
    assert.strictEqual(claim(ev), null);
  }
  assert.strictEqual(O.claimFrom(pre('Edit', { file_path: path.join(FEAT, 'a') }), null, DEV), null);
  assert.strictEqual(O.claimFrom(pre('Edit', { file_path: path.join(FEAT, 'a') }), [5, null, ''], DEV), null);
});

// --- Bash ---------------------------------------------------------------------------------------

test('a Bash command naming a root claims it, in either slash form', () => {
  assert.strictEqual(claim(pre('Bash', { command: `cd ${FEAT} && git status` })).worktree, FEAT);
  assert.strictEqual(claim(pre('Bash', { command: `git -C "${FEAT.replace(/\\/g, '/')}" status` })).worktree, FEAT);
});

test('Bash: a root name that is only a prefix of a longer folder name does not match', () => {
  assert.strictEqual(claim(pre('Bash', { command: `ls ${FEAT}-old` })), null);
  assert.strictEqual(claim(pre('Bash', { command: `ls ${FEAT}.bak\\x` })), null);
  assert.strictEqual(claim(pre('Bash', { command: `ls ${FEAT2}` })).worktree, FEAT2);
});

test('Bash: the longest NON-own root wins; the own root alone never claims', () => {
  assert.strictEqual(claim(pre('Bash', { command: `ls ${NESTED}\\app` })).worktree, NESTED, 'dev does not swallow it');
  assert.strictEqual(claim(pre('Bash', { command: `cd ${DEV} && ls` })), null);
  assert.strictEqual(claim(pre('Bash', { command: `cp ${DEV}\\a ${FEAT}\\a` })).worktree, FEAT,
    'touching another worktree is proof even when the own one is named too');
});

test('Bash: no root string, no claim (a command is never parsed for paths)', () => {
  assert.strictEqual(claim(pre('Bash', { command: 'git status && npm test' })), null);
  assert.strictEqual(claim(pre('Bash', { command: 'cd ../feat-git-tree && ls' })), null);
});

test('Bash: Git Bash\'s /c/... form and doubled backslashes name the same folder (Windows)', { skip: process.platform !== 'win32' }, () => {
  const msys = FEAT.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  assert.strictEqual(claim(pre('Bash', { command: `cd ${msys} && ls` })).worktree, FEAT);
  assert.strictEqual(claim(pre('Bash', { command: `dir ${FEAT.replace(/\\/g, '\\\\')}` })).worktree, FEAT);
});

test('Bash: matched without regard to case on Windows, exactly on a case-sensitive platform', () => {
  const shout = claim(pre('Bash', { command: `cd ${FEAT.toUpperCase()}` }));
  if (process.platform === 'win32') assert.strictEqual(shout.worktree, FEAT);
  else assert.strictEqual(shout, null);
});

// --- latest -------------------------------------------------------------------------------------

test('latest: the most recently touched worktree wins and the rest are `also`, newest first', () => {
  const r = O.latest([
    { worktree: FEAT, lastAt: 100 }, { worktree: FEAT2, lastAt: 300 }, { worktree: NESTED, lastAt: 200 },
  ]);
  assert.strictEqual(r.worktree, FEAT2);
  assert.deepStrictEqual(r.also, [NESTED, FEAT]);
});

test('latest: the same worktree spelled two ways is one worktree', () => {
  const r = O.latest([{ worktree: FEAT, lastAt: 1 }, { worktree: FEAT + path.sep, lastAt: 2 }, { worktree: FEAT2, lastAt: 0 }]);
  assert.strictEqual(r.also.length, 1);
  assert.strictEqual(r.also[0], FEAT2);
});

test('latest: nothing in, nothing out; a tie goes to the later entry', () => {
  assert.strictEqual(O.latest([]), null);
  assert.strictEqual(O.latest(null), null);
  assert.strictEqual(O.latest([{ worktree: FEAT, lastAt: 5 }, { worktree: FEAT2, lastAt: 5 }]).worktree, FEAT2);
});

test('latest: entries that are not touches are ignored, not thrown on', () => {
  assert.strictEqual(O.latest([null, 3, { worktree: '', lastAt: 1 }, { worktree: FEAT, lastAt: 'x' }]), null);
  assert.strictEqual(O.latest([null, { worktree: FEAT, lastAt: 2 }]).worktree, FEAT);
});

// --- the claim file -----------------------------------------------------------------------------

const GOOD = {
  agentId: 'ac7618c6a7668687d', agent: 'electron-pro', worktree: FEAT, also: [FEAT2], fromBranch: 'develop',
  fromRoot: DEV, hostPid: 4242, hostStartedAt: '133800000000000000', firstAt: 1000, lastAt: 2000, count: 3,
};

test('a claim written is a claim read back, field for field', () => {
  const r = O.parseClaim(O.serializeClaim(GOOD));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.claim, GOOD);
});

test('the file is named for the agent, and only for a safe id', () => {
  assert.strictEqual(O.claimFileName('ac7618c6a7668687d'), 'ac7618c6a7668687d.json');
  assert.strictEqual(O.claimFileName('../x'), null);
  assert.strictEqual(O.claimFileName(''), null);
  assert.strictEqual(O.claimFileName(undefined), null);
});

test('parseClaim refuses what cannot be a claim, saying why', () => {
  const bad = (patch, why) => {
    const r = O.parseClaim(JSON.stringify({ ...GOOD, ...patch }));
    assert.strictEqual(r.ok, false, why);
    assert.strictEqual(typeof r.reason, 'string');
  };
  bad({ agentId: '../x' }, 'unsafe id');
  bad({ agentId: 5 }, 'id type');
  bad({ worktree: '' }, 'no worktree');
  bad({ worktree: 'rel/path' }, 'worktree must be absolute');
  bad({ fromRoot: 3 }, 'fromRoot');
  bad({ hostPid: 0 }, 'pid');
  bad({ hostPid: 1.5 }, 'pid');
  bad({ hostPid: '12' }, 'pid');
  bad({ firstAt: null }, 'firstAt');
  bad({ lastAt: Infinity }, 'lastAt');
  bad({ count: 0 }, 'count');
  for (const text of ['', '{', 'null', '[]', '3', '"x"']) assert.strictEqual(O.parseClaim(text).ok, false, text);
});

test('hostStartedAt that is missing or not a FILETIME parses, as "can\'t be proven" (null), never as a value', () => {
  for (const v of [undefined, null, '', 'abc', 12, '12.5']) {
    const r = O.parseClaim(JSON.stringify({ ...GOOD, hostStartedAt: v }));
    assert.strictEqual(r.ok, true, String(v));
    assert.strictEqual(r.claim.hostStartedAt, null, String(v));
  }
});

test('optional fields default instead of failing: no agent name, no branch, no also', () => {
  const { agent, fromBranch, also, ...rest } = GOOD;
  const r = O.parseClaim(JSON.stringify(rest));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.claim.agent, null);
  assert.strictEqual(r.claim.fromBranch, null);
  assert.deepStrictEqual(r.claim.also, []);
});

test('also keeps only absolute strings and at most ALSO_MAX of them', () => {
  const many = Array.from({ length: O.ALSO_MAX + 5 }, (_v, i) => path.join(BASE, `w${i}`));
  const r = O.parseClaim(JSON.stringify({ ...GOOD, also: [5, '', 'rel', ...many] }));
  assert.deepStrictEqual(r.claim.also, many.slice(0, O.ALSO_MAX));
});

test('buildClaim: the touches become worktree + also; a fresh claim counts its own tool calls', () => {
  const b = O.buildClaim({
    agentId: GOOD.agentId, agent: 'electron-pro', fromBranch: 'develop', fromRoot: DEV, hostPid: 4242,
    hostStartedAt: GOOD.hostStartedAt,
    touches: [
      { worktree: FEAT, firstAt: 1000, lastAt: 1500, count: 2 },
      { worktree: FEAT2, firstAt: 1800, lastAt: 2000, count: 1 },
    ],
  });
  assert.strictEqual(b.worktree, FEAT2);
  assert.deepStrictEqual(b.also, [FEAT]);
  assert.strictEqual(b.firstAt, 1800, 'the time on THIS worktree');
  assert.strictEqual(b.lastAt, 2000);
  assert.strictEqual(b.count, 1);
  assert.strictEqual(O.buildClaim({ ...GOOD, touches: [] }), null);
});
