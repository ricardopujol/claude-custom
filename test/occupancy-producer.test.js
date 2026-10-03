'use strict';
/**
 * host/occupancy-producer.js: the launching host's half (backlog #44 + #47). Hook events in, claim files out.
 * Only an event carrying an agent_id counts, only a proven touch claims, and the claim is deleted the moment
 * the agent stops.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createOccupancyProducer, isOccupancyOnly, AGENTS_MAX } = require('../host/occupancy-producer');

const BASE = path.resolve('/occ-prod');
const DEV = path.join(BASE, 'dev');
const FEAT = path.join(BASE, 'feat-x');
const FEAT2 = path.join(BASE, 'feat-y');

function rig(over = {}) {
  const r = { writes: [], removed: [], removedAll: 0, clock: 1000, refreshed: 0, listed: [DEV, FEAT, FEAT2], stale: false, logs: [] };
  r.writer = {
    write: (rec) => { r.writes.push(rec); return { ok: true, wrote: true }; },
    remove: (id) => { r.removed.push(id); return { ok: true }; },
    removeAll: () => { r.removedAll += 1; },
  };
  r.roots = {
    get: () => r.listed,
    stale: () => r.stale,
    refresh: async () => { r.refreshed += 1; r.stale = false; return r.listed; },
  };
  r.p = createOccupancyProducer({
    writer: r.writer, roots: r.roots, ownRoot: DEV, fromBranch: () => 'develop', hostPid: 4242,
    hostStartedAt: () => '1000', nameOf: () => null, now: () => r.clock, log: (...a) => r.logs.push(a.join(' ')), ...over,
  });
  return r;
}

const ev = (event, payload) => ({ event, payload });
const edit = (file, extra = {}) => ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file }, agent_id: 'ag1', agent_type: 'electron-pro', ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('an agent\'s Edit in another worktree writes its claim, with the host\'s facts', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  assert.strictEqual(r.writes.length, 1);
  assert.deepStrictEqual(r.writes[0], {
    agentId: 'ag1', agent: 'electron-pro', worktree: FEAT, also: [], fromBranch: 'develop', fromRoot: DEV,
    hostPid: 4242, hostStartedAt: '1000', firstAt: 1000, lastAt: 1000, count: 1,
  });
});

test('more calls in the same worktree: the count grows, firstAt stays, lastAt moves', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.clock = 5000;
  r.p.handle(edit(path.join(FEAT, 'b.js')));
  const last = r.writes[r.writes.length - 1];
  assert.strictEqual(last.count, 2);
  assert.strictEqual(last.firstAt, 1000);
  assert.strictEqual(last.lastAt, 5000);
});

test('touching a second worktree: the latest wins and the first becomes `also`; going back swaps them', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.clock = 2000;
  r.p.handle(edit(path.join(FEAT2, 'a.js')));
  let last = r.writes[r.writes.length - 1];
  assert.strictEqual(last.worktree, FEAT2);
  assert.deepStrictEqual(last.also, [FEAT]);
  assert.strictEqual(last.count, 1, 'counted on THIS worktree');
  r.clock = 3000;
  r.p.handle(edit(path.join(FEAT, 'b.js')));
  last = r.writes[r.writes.length - 1];
  assert.strictEqual(last.worktree, FEAT);
  assert.deepStrictEqual(last.also, [FEAT2]);
  assert.strictEqual(last.count, 2);
  assert.strictEqual(last.firstAt, 1000);
});

test('the launching session\'s own folder, a call with no agent_id, and a Post event write nothing', () => {
  const r = rig();
  r.p.handle(edit(path.join(DEV, 'a.js')));
  r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_id: undefined }));
  r.p.handle(ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(FEAT, 'a.js') }, agent_id: 'ag1' }));
  assert.strictEqual(r.writes.length, 0);
});

test('Bash counts too: a command naming another worktree claims it', () => {
  const r = rig();
  r.p.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: `cd ${FEAT} && npm test` }, agent_id: 'ag1', agent_type: 'electron-pro' }));
  assert.strictEqual(r.writes[0].worktree, FEAT);
});

test('SubagentStop deletes that agent\'s claim, and a later claim starts from scratch', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.p.handle(ev('SubagentStop', { agent_id: 'ag1', agent_type: 'electron-pro' }));
  assert.deepStrictEqual(r.removed, ['ag1']);
  r.clock = 9000;
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  const last = r.writes[r.writes.length - 1];
  assert.strictEqual(last.count, 1);
  assert.strictEqual(last.firstAt, 9000);
  assert.deepStrictEqual(last.also, []);
});

test('SubagentStop of an agent that never claimed is harmless, and one with no id deletes nothing', () => {
  const r = rig();
  r.p.handle(ev('SubagentStop', { agent_id: 'never', agent_type: 'x' }));
  r.p.handle(ev('SubagentStop', {}));
  r.p.handle(ev('SubagentStop', { agent_id: '../bad' }));
  assert.deepStrictEqual(r.removed, ['never']);
});

test('SessionEnd deletes every claim this host made', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.p.handle(ev('SessionEnd', {}));
  assert.strictEqual(r.removedAll, 1);
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  assert.strictEqual(r.writes[r.writes.length - 1].count, 1, 'its touches were forgotten too');
});

test('an agent with no agent_type takes the name the host knows it by', () => {
  const r = rig({ nameOf: id => (id === 'ag1' ? 'logic-reviewer' : null) });
  r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_type: undefined }));
  assert.strictEqual(r.writes[0].agent, 'logic-reviewer');
});

test('a host whose own start time isn\'t known yet still writes, with null (readers show nothing for it)', () => {
  const r = rig({ hostStartedAt: () => null });
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  assert.strictEqual(r.writes[0].hostStartedAt, null);
});

test('a failing writer never throws out of the hook handler', () => {
  const r = rig();
  r.writer.write = () => { throw new Error('disk'); };
  assert.doesNotThrow(() => r.p.handle(edit(path.join(FEAT, 'a.js'))));
  r.writer.write = () => ({ ok: false, error: 'nope' });
  assert.doesNotThrow(() => r.p.handle(edit(path.join(FEAT, 'a.js'))));
});

test('junk events never throw', () => {
  const r = rig();
  for (const e of [null, undefined, 3, {}, { event: 'PreToolUse' }, { event: 'SubagentStop', payload: null }]) {
    assert.doesNotThrow(() => r.p.handle(e));
  }
});

test('a worktree git hasn\'t listed yet: the list is refreshed once (if stale) and the event judged again', async () => {
  const r = rig();
  r.listed = [DEV, FEAT];
  r.stale = true;
  const fresh = path.join(BASE, 'feat-new');
  r.roots.refresh = async () => { r.refreshed += 1; r.stale = false; r.listed = [DEV, FEAT, fresh]; return r.listed; };
  r.p.handle(edit(path.join(fresh, 'a.js')));
  assert.strictEqual(r.writes.length, 0, 'unknown for now');
  await flush();
  assert.strictEqual(r.refreshed, 1);
  assert.strictEqual(r.writes.length, 1);
  assert.strictEqual(r.writes[0].worktree, fresh);
});

test('a fresh list is trusted: no git call for a path outside every worktree', async () => {
  const r = rig();
  r.p.handle(edit(path.resolve('/elsewhere/a.js')));
  await flush();
  assert.strictEqual(r.refreshed, 0);
});

test('the retry happens once: a refresh that still doesn\'t know the path doesn\'t loop', async () => {
  const r = rig();
  r.stale = true;
  r.roots.refresh = async () => { r.refreshed += 1; r.stale = true; return r.listed; };
  r.p.handle(edit(path.join(BASE, 'unlisted', 'a.js')));
  await flush(); await flush();
  assert.strictEqual(r.refreshed, 1);
  assert.strictEqual(r.writes.length, 0);
});

test('a refresh that rejects is swallowed', async () => {
  const r = rig();
  r.stale = true;
  r.roots.refresh = async () => { throw new Error('git missing'); };
  r.p.handle(edit(path.join(BASE, 'unlisted', 'a.js')));
  await flush();
  assert.strictEqual(r.writes.length, 0);
});

test('an event with no agent_id never costs a git call', async () => {
  const r = rig();
  r.stale = true;
  r.p.handle(edit(path.join(BASE, 'unlisted', 'a.js'), { agent_id: undefined }));
  await flush();
  assert.strictEqual(r.refreshed, 0);
});

test('the touch book is bounded: the oldest agents are forgotten, the newest kept', () => {
  const r = rig();
  for (let i = 0; i < AGENTS_MAX + 20; i++) {
    r.clock += 1;
    r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_id: `ag${i}` }));
  }
  r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_id: `ag${AGENTS_MAX + 19}` }));
  assert.strictEqual(r.writes[r.writes.length - 1].count, 2, 'the newest is remembered');
  r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_id: 'ag0' }));
  assert.strictEqual(r.writes[r.writes.length - 1].count, 1, 'the oldest started over');
});

test('isOccupancyOnly: the file-tool PreToolUse the new matcher brings, and nothing else', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit']) {
    assert.strictEqual(isOccupancyOnly(ev('PreToolUse', { tool_name: tool })), true, tool);
  }
  assert.strictEqual(isOccupancyOnly(ev('PreToolUse', { tool_name: 'Bash' })), false);
  assert.strictEqual(isOccupancyOnly(ev('PreToolUse', { tool_name: 'Agent' })), false);
  assert.strictEqual(isOccupancyOnly(ev('PostToolUse', { tool_name: 'Edit' })), false, 'Post isn\'t hooked for these');
  assert.strictEqual(isOccupancyOnly(ev('PreToolUse', {})), false);
  for (const junk of [null, undefined, {}, 3, { event: 'PreToolUse' }]) assert.strictEqual(isOccupancyOnly(junk), false);
});
