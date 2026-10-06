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
const edit = (file, extra = {}) => ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file }, agent_id: 'ag1', agent_type: 'electron-pro', session_id: 'sess-1', ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('an agent\'s Edit in another worktree writes its claim, with the host\'s facts', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  assert.strictEqual(r.writes.length, 1);
  assert.deepStrictEqual(r.writes[0], {
    agentId: 'ag1', agent: 'electron-pro', worktree: FEAT, also: [], fromBranch: 'develop', fromRoot: DEV,
    sessionId: 'sess-1', hostPid: 4242, hostStartedAt: '1000', firstAt: 1000, lastAt: 1000, count: 1,
  });
});

test('the claim names the session its call came from, so a hub card matches its OWN session\'s run (backlog #57, Dexter F5)', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js'), { session_id: 'sess-2' }));
  assert.strictEqual(r.writes[0].sessionId, 'sess-2');
  // a later call that names no session doesn't forget the one already proven
  r.clock = 2000;
  r.p.handle(edit(path.join(FEAT, 'b.js'), { session_id: undefined }));
  assert.strictEqual(r.writes[1].sessionId, 'sess-2');
});

test('a session learned on a later call reaches the file at once, through the real writer (PR #124 Dexter F1)', () => {
  const fs = require('fs');
  const { tmpDir } = require('./tmp-dir');
  const { createClaimWriter, occupancyDir } = require('../host/occupancy-store');
  const state = tmpDir('occ-prod-sess-');
  const r = rig({ writer: createClaimWriter({ stateRoot: state, now: () => r.clock }) });
  r.p.handle(edit(path.join(FEAT, 'a.js'), { session_id: undefined }));
  r.clock = 6000;   // 5 s later: inside the writer's 30 s window
  r.p.handle(edit(path.join(FEAT, 'a.js'), { session_id: 'S' }));
  const onDisk = JSON.parse(fs.readFileSync(path.join(occupancyDir(state), 'ag1.json'), 'utf8'));
  assert.strictEqual(onDisk.sessionId, 'S');
});

const sessionOnWrite = (r, extra = {}) => {
  r.p.handle(edit(path.join(FEAT, 'a.js'), { session_id: undefined, ...extra }));
  return r.writes[r.writes.length - 1].sessionId;
};

test('a stopped agent\'s session is forgotten: a reused agent id that names none gets none (PR #124 Miguel M1)', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.p.handle(ev('SubagentStop', { agent_id: 'ag1', agent_type: 'electron-pro' }));
  assert.strictEqual(sessionOnWrite(r), null);
});

test('SessionEnd forgets every agent\'s session (PR #124 Miguel M1)', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.p.handle(ev('SessionEnd', {}));
  assert.strictEqual(sessionOnWrite(r), null);
});

test('an agent evicted from the touch book takes its session with it (PR #124 Miguel M1)', () => {
  const r = rig();
  r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_id: 'old0' }));
  for (let i = 0; i < AGENTS_MAX; i++) r.p.handle(edit(path.join(FEAT, 'a.js'), { agent_id: `new${i}` }));
  assert.strictEqual(sessionOnWrite(r, { agent_id: 'old0' }), null);
});

test('an idle teammate that expires forgets its session too (PR #124 Miguel M1)', () => {
  const r = rig({ isTeammate: () => true, idleMs: 1000 });
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.clock += 5000;
  r.p.handle(ev('SubagentStop', { agent_id: 'ag1' }));
  assert.strictEqual(sessionOnWrite(r), null);
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

test('a Grep in another worktree claims it, and one that names no worktree can still cost one stale-list retry', async () => {
  const r = rig();
  r.p.handle(ev('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x', path: FEAT }, agent_id: 'ag1', agent_type: 'electron-pro' }));
  assert.strictEqual(r.writes[0].worktree, FEAT);
  r.stale = true;
  r.p.handle(ev('PreToolUse', { tool_name: 'Glob', tool_input: { pattern: '*', path: path.join(BASE, 'unlisted') }, agent_id: 'ag1' }));
  await flush();
  assert.strictEqual(r.refreshed, 1, 'a search is a tool that could claim');
});

test('isOccupancyOnly: the file-tool and search-tool PreToolUse the occupancy matcher brings, and nothing else', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob']) {
    assert.strictEqual(isOccupancyOnly(ev('PreToolUse', { tool_name: tool })), true, tool);
  }
  assert.strictEqual(isOccupancyOnly(ev('PreToolUse', { tool_name: 'Bash' })), false);
  assert.strictEqual(isOccupancyOnly(ev('PreToolUse', { tool_name: 'Agent' })), false);
  assert.strictEqual(isOccupancyOnly(ev('PostToolUse', { tool_name: 'Edit' })), false, 'Post isn\'t hooked for these');
  assert.strictEqual(isOccupancyOnly(ev('PreToolUse', {})), false);
  for (const junk of [null, undefined, {}, 3, { event: 'PreToolUse' }]) assert.strictEqual(isOccupancyOnly(junk), false);
});

// --- teammates (Ricardo, 2026-10-03) ----------------------------------------------------------------------
// A named background agent in an interactive session is an `in_process_teammate`: it ends a turn, idles, and is
// woken again by SendMessage. Its SubagentStop is the end of a TURN (verify/probe-teammate-occupancy.js), so
// deleting its claim there made a worktree look free while its agent sat waiting for the next message.

const { IDLE_MS, teammateFromMeta } = require('../host/occupancy-producer');
const mate = (file, extra = {}) => edit(file, { agent_id: 'amate-1', agent_type: 'lane-x', ...extra });
const stop = (id, extra = {}) => ev('SubagentStop', { agent_id: id, ...extra });
const mateRig = (over = {}) => rig({ isTeammate: p => String(p.agent_id).startsWith('amate'), ...over });

test('a TEAMMATE that stops is idle, not gone: its claim stays, and its touches are remembered', () => {
  const r = mateRig();
  r.p.handle(mate(path.join(FEAT, 'a.js')));
  r.p.handle(stop('amate-1'));
  assert.deepStrictEqual(r.removed, []);
  r.clock = 5000;
  r.p.handle(mate(path.join(FEAT, 'b.js')));
  assert.strictEqual(r.writes[r.writes.length - 1].count, 2, 'woken: the same run of touches goes on');
  assert.strictEqual(r.writes[r.writes.length - 1].firstAt, 1000);
});

test('an idle teammate\'s claim is removed once IDLE_MS have passed since its last touch, on a tick', () => {
  const r = mateRig();
  r.p.handle(mate(path.join(FEAT, 'a.js')));          // touched at 1000
  r.clock = 2000;
  r.p.handle(stop('amate-1'));
  r.clock = 1000 + IDLE_MS - 1;
  r.p.tick();
  assert.deepStrictEqual(r.removed, [], 'one millisecond short');
  r.clock = 1000 + IDLE_MS;
  r.p.tick();
  assert.deepStrictEqual(r.removed, ['amate-1']);
  r.p.tick();
  assert.deepStrictEqual(r.removed, ['amate-1'], 'removed once');
  r.clock += 1;
  r.p.handle(mate(path.join(FEAT, 'a.js')));
  assert.strictEqual(r.writes[r.writes.length - 1].count, 1, 'and it starts from scratch if it comes back');
  assert.strictEqual(IDLE_MS, 10 * 60 * 1000);
});

test('the idle clock runs from the LATEST touch of any worktree, not the first', () => {
  const r = mateRig();
  r.p.handle(mate(path.join(FEAT, 'a.js')));          // 1000
  r.clock = 400_000;
  r.p.handle(mate(path.join(FEAT2, 'a.js')));         // 400000
  r.p.handle(stop('amate-1'));
  r.clock = 1000 + IDLE_MS + 5;
  r.p.tick();
  assert.deepStrictEqual(r.removed, []);
  r.clock = 400_000 + IDLE_MS;
  r.p.tick();
  assert.deepStrictEqual(r.removed, ['amate-1']);
});

test('a teammate that stops long after its last touch is removed at that stop', () => {
  const r = mateRig();
  r.p.handle(mate(path.join(FEAT, 'a.js')));
  r.clock = 1000 + IDLE_MS;
  r.p.handle(stop('amate-1'));
  assert.deepStrictEqual(r.removed, ['amate-1']);
});

test('a teammate that is WORKING is never expired by the tick, however long since its last touch (a long test run)', () => {
  const r = mateRig();
  r.p.handle(mate(path.join(FEAT, 'a.js')));
  r.p.handle(stop('amate-1'));
  r.clock = 3000;
  r.p.handle(mate(path.join(FEAT, 'b.js')));          // woken: working again
  r.clock = 3000 + IDLE_MS * 3;
  r.p.tick();
  assert.deepStrictEqual(r.removed, []);
});

test('a plain subagent still loses its claim the moment it stops, teammate rule or not', () => {
  const r = mateRig();
  r.p.handle(edit(path.join(FEAT, 'a.js')));          // ag1: not a teammate
  r.p.handle(stop('ag1'));
  assert.deepStrictEqual(r.removed, ['ag1']);
  r.p.tick();
  assert.deepStrictEqual(r.removed, ['ag1']);
});

test('a teammate that never claimed anything has nothing to keep; an isTeammate that throws reads as "plain"', () => {
  const r = mateRig();
  r.p.handle(stop('amate-9'));
  assert.deepStrictEqual(r.removed, ['amate-9'], 'the same harmless delete as any agent that never claimed');
  const bad = rig({ isTeammate: () => { throw new Error('meta'); } });
  bad.p.handle(mate(path.join(FEAT, 'a.js')));
  assert.doesNotThrow(() => bad.p.handle(stop('amate-1')));
  assert.deepStrictEqual(bad.removed, ['amate-1']);
});

test('SessionEnd takes the idle teammates too, and the tick then has nothing left to expire', () => {
  const r = mateRig();
  r.p.handle(mate(path.join(FEAT, 'a.js')));
  r.p.handle(stop('amate-1'));
  r.p.handle(ev('SessionEnd', {}));
  assert.strictEqual(r.removedAll, 1);
  r.clock += IDLE_MS * 2;
  r.p.tick();
  assert.deepStrictEqual(r.removed, []);
});

test('tick never throws: nothing idle, or a writer that fails', () => {
  const r = mateRig();
  assert.doesNotThrow(() => r.p.tick());
  r.p.handle(mate(path.join(FEAT, 'a.js')));
  r.p.handle(stop('amate-1'));
  r.writer.remove = () => { throw new Error('disk'); };
  r.clock += IDLE_MS;
  assert.doesNotThrow(() => r.p.tick());
});

test('teammateFromMeta: the .meta.json beside SubagentStop\'s agent_transcript_path says in_process_teammate', () => {
  const fs = require('fs');
  const { tmpDir } = require('./tmp-dir');
  const dir = tmpDir('occ-mate-meta-');
  const t = name => path.join(dir, `agent-${name}.jsonl`);
  const meta = (name, body) => fs.writeFileSync(path.join(dir, `agent-${name}.meta.json`), body);
  meta('mate', JSON.stringify({ agentType: 'lane-x', taskKind: 'in_process_teammate' }));
  meta('plain', JSON.stringify({ agentType: 'code-reviewer' }));
  meta('other', JSON.stringify({ taskKind: 'something_else' }));
  meta('junk', '{not json');
  meta('array', '[]');
  assert.strictEqual(teammateFromMeta({ agent_transcript_path: t('mate') }), true);
  for (const name of ['plain', 'other', 'junk', 'array', 'missing']) {
    assert.strictEqual(teammateFromMeta({ agent_transcript_path: t(name) }), false, name);
  }
  for (const p of [null, undefined, {}, { agent_transcript_path: 5 }, { agent_transcript_path: '' }, { agent_transcript_path: 'no-extension' }]) {
    assert.strictEqual(teammateFromMeta(p), false);
  }
  // the extension is `.jsonl`, dot included: `agent-matexjsonl` is not a transcript, and its last six
  // characters are not clipped into some other file's name (PR #96 Miguel S1)
  let asked = null;
  const spy = (file) => { asked = file; return JSON.stringify({ taskKind: 'in_process_teammate' }); };
  assert.strictEqual(teammateFromMeta({ agent_transcript_path: path.join(dir, 'agent-matexjsonl') }, { readFileSync: spy }), false);
  assert.strictEqual(asked, null, 'nothing was read for it');
  assert.strictEqual(teammateFromMeta({ agent_transcript_path: t('mate') }, { readFileSync: spy }), true);
  assert.strictEqual(asked, path.join(dir, 'agent-mate.meta.json'));
});

// --- PR #96 review: Miguel Y6 -----------------------------------------------------------------------------

test('withoutFileText: the debug log gets who touched which path, never the text a Write or an Edit carries', () => {
  const { withoutFileText } = require('../host/occupancy-producer');
  const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', agent_id: 'ag1',
    tool_input: { file_path: path.join(FEAT, '.env'), content: 'SECRET=hunter2' } };
  assert.deepStrictEqual(withoutFileText(write), { hook_event_name: 'PreToolUse', tool_name: 'Write', agent_id: 'ag1',
    tool_input: { file_path: path.join(FEAT, '.env') } });
  assert.strictEqual(write.tool_input.content, 'SECRET=hunter2', 'the payload itself is not changed: the producer still reads it');
  const editInput = { file_path: 'x', old_string: 'a', new_string: 'b', replace_all: true };
  assert.deepStrictEqual(withoutFileText({ tool_name: 'Edit', tool_input: editInput }).tool_input, { file_path: 'x', replace_all: true });
  assert.deepStrictEqual(withoutFileText({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n', new_source: 's' } }).tool_input, { notebook_path: 'n' });
  assert.deepStrictEqual(withoutFileText({ tool_name: 'Grep', tool_input: { pattern: 'p', path: FEAT } }).tool_input, { pattern: 'p', path: FEAT });
  assert.ok(!JSON.stringify(withoutFileText(write)).includes('hunter2'));
  for (const junk of [null, undefined, 5, 'x']) assert.deepStrictEqual(withoutFileText(junk), {});
  assert.deepStrictEqual(withoutFileText({ tool_name: 'Read', tool_input: null }), { tool_name: 'Read', tool_input: null });
});

// --- PR #96 review: Dexter F2, F8 -------------------------------------------------------------------------

test('a host that does not know its own start time writes NOTHING: a claim without the proof is never shown, and would only fight the transcript producer for the file (Dexter F2)', () => {
  let started = null;
  const r = rig({ hostStartedAt: () => started });
  r.p.handle(edit(path.join(FEAT, 'a.js')));
  r.clock = 2000;
  r.p.handle(edit(path.join(FEAT, 'b.js')));
  assert.strictEqual(r.writes.length, 0);
  for (const junk of ['', '?', 'not-a-filetime', 5, undefined]) {
    started = junk;
    r.p.handle(edit(path.join(FEAT, 'c.js')));
  }
  assert.strictEqual(r.writes.length, 0, 'only a FILETIME is a start time');
  // ...and what it touched meanwhile is remembered: the first write, once the time is known, has it all
  started = '134000000000000000';
  r.clock = 9000;
  r.p.handle(edit(path.join(FEAT, 'd.js')));
  assert.strictEqual(r.writes.length, 1);
  assert.strictEqual(r.writes[0].hostStartedAt, '134000000000000000');
  assert.strictEqual(r.writes[0].firstAt, 1000);
  assert.strictEqual(r.writes[0].count, 8);
});

function slowRoots(r) {
  // a worktree list whose refresh resolves only when the test says so
  let finish;
  r.stale = true;
  r.listed = [DEV, FEAT];
  const fresh = path.join(BASE, 'feat-new');
  r.roots.refresh = () => new Promise((resolve) => { finish = () => { r.stale = false; r.listed = [DEV, FEAT, fresh]; resolve(r.listed); }; });
  return { fresh, finish: () => finish() };
}

test('a retry that comes back after the agent has STOPPED records nothing: no claim for an agent that is gone (Dexter F8)', async () => {
  const r = rig();
  const slow = slowRoots(r);
  r.p.handle(edit(path.join(slow.fresh, 'a.js')));          // unknown worktree, stale list: a refresh starts
  r.p.handle(ev('SubagentStop', { agent_id: 'ag1' }));       // ...and the agent stops before git answers
  await flush();
  slow.finish();
  await flush(); await flush();
  assert.strictEqual(r.writes.length, 0);
});

test('...nor after the SESSION has ended; but an agent that is still there gets its claim from the retry', async () => {
  const r = rig();
  const slow = slowRoots(r);
  r.p.handle(edit(path.join(slow.fresh, 'a.js')));
  r.p.handle(ev('SessionEnd', {}));
  await flush();
  slow.finish();
  await flush(); await flush();
  assert.strictEqual(r.writes.length, 0);

  const r2 = rig();
  const slow2 = slowRoots(r2);
  r2.p.handle(edit(path.join(slow2.fresh, 'a.js')));
  r2.p.handle(ev('SubagentStop', { agent_id: 'somebody-else' }));
  await flush();
  slow2.finish();
  await flush(); await flush();
  assert.strictEqual(r2.writes.length, 1);
  assert.strictEqual(r2.writes[0].worktree, slow2.fresh);
});
