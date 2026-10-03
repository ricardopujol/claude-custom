'use strict';
/**
 * host/occupancy-transcripts.js: the FALLBACK producer of worktree occupancy (backlog #44 + #47, Ricardo
 * 2026-10-03). The hook producer (host/occupancy-producer.js) only sees agents of a session that a host of
 * this build runs. This one reads what every session leaves on disk: the tail of each fresh subagent
 * transcript, judged by the same test (host/agent-occupancy.js touchOf), written into the same store.
 *
 * THE LAUNCHING FOLDER IS WHERE THE TRANSCRIPT IS FILED, NOT THE `cwd` ON ITS LINES. Measured on the live
 * personal-agent session (2026-10-03): 60 lines of one teammate carried cwd `~\.claude\reviews\personal-agent`
 * -- the cwd follows a `cd` in Bash -- and its next call into the launching folder then read as "working in
 * dev". A transcript under <projects>\<encoded root>\ was launched from that root, whatever its lines say.
 *
 * Real files throughout: a temp projects folder, a temp state folder, the real claim writer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const T = require('../host/occupancy-transcripts');
const S = require('../host/occupancy-store');
const O = require('../host/agent-occupancy');
const { projectDirName } = require('../host/project-dir');

const BASE = path.resolve('/occ-scan');
const DEV = path.join(BASE, 'dev');
const FEAT = path.join(BASE, 'feat-x');
const FEAT2 = path.join(BASE, 'feat-y');
const ROOTS = [DEV, FEAT, FEAT2];
const OWN_PID = 777;
const START = '134000000000000000';
const T0 = Date.parse('2026-10-03T05:40:00Z');
const iso = ms => new Date(ms).toISOString();

const use = (name, input) => ({ type: 'tool_use', id: 'toolu_x', name, input });
const read = file => use('Read', { file_path: file });
const text = t => ({ type: 'text', text: t });
// One assistant line of a subagent transcript, as measured: the PARENT's cwd and branch on every line.
const line = (agentId, blocks, { at = T0, stop = 'tool_use', cwd = DEV, branch = 'develop' } = {}) => JSON.stringify({
  type: 'assistant', isSidechain: true, agentId, cwd, gitBranch: branch, timestamp: iso(at),
  message: { role: 'assistant', content: blocks, stop_reason: stop, usage: { input_tokens: 1 } },
}) + '\n';
const done = (agentId, at) => line(agentId, [text('DONE')], { at, stop: 'end_turn' });
const userLine = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }) + '\n';

function rig(over = {}) {
  const projects = tmpDir('occ-scan-projects-');
  const state = tmpDir('occ-scan-state-');
  const r = { projects, state, clock: T0 + 60_000, live: [], logs: [], roots: ROOTS, staleRoots: false, refreshed: 0 };
  r.dir = S.occupancyDir(state);
  r.writer = S.createClaimWriter({ stateRoot: state, now: () => r.clock });
  r.scanner = T.createTranscriptScanner({
    projectsDir: projects,
    roots: { get: () => r.roots, stale: () => r.staleRoots, refresh: async () => { r.refreshed += 1; r.staleRoots = false; return r.roots; } },
    writer: r.writer, dir: r.dir, ownPid: OWN_PID, ownStartedAt: async () => START,
    liveClaims: () => r.live, now: () => r.clock, log: (...a) => r.logs.push(a.join(' ')), ...over,
  });
  // <projects>/<encoded launching folder>/<session>/subagents/agent-<id>.jsonl (+ .meta.json)
  r.file = (agentId, { from = DEV, session = 's1' } = {}) => path.join(projects, projectDirName(from), session, 'subagents', `agent-${agentId}.jsonl`);
  r.put = (agentId, body, { meta, mtime, ...where } = {}) => {
    const f = r.file(agentId, where);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    if (meta !== undefined) fs.writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
    const t = new Date(mtime === undefined ? r.clock : mtime);
    fs.utimesSync(f, t, t);
    return f;
  };
  r.append = (agentId, body, where) => {
    const f = r.file(agentId, where);
    fs.appendFileSync(f, body);
    const t = new Date(r.clock);
    fs.utimesSync(f, t, t);
  };
  r.claims = () => S.readAll(r.dir).claims.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  r.claim = (id) => r.claims().find(c => c.agentId === id) || null;
  return r;
}

const MATE = { agentType: 'lane-x', name: 'lane-x', taskKind: 'in_process_teammate', customAgentType: 'python-pro' };
const PLAIN = { agentType: 'code-reviewer' };

test('a fresh subagent transcript whose calls point at another worktree becomes a claim, with this producer as its proof', async () => {
  const r = rig();
  r.put('alane-x-1', line('alane-x-1', [read(path.join(FEAT, 'a.py'))], { at: T0 }) + userLine()
    + line('alane-x-1', [use('Bash', { command: `cd ${FEAT} && pytest` })], { at: T0 + 5000 }), { meta: MATE });
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.claimed, ['alane-x-1']);
  assert.deepStrictEqual(r.claim('alane-x-1'), {
    agentId: 'alane-x-1', agent: 'lane-x', worktree: FEAT, also: [], fromBranch: 'develop', fromRoot: DEV,
    hostPid: OWN_PID, hostStartedAt: START, firstAt: T0, lastAt: T0 + 5000, count: 2,
  });
});

test('the agent is named by its meta: `name`, else `agentType`, else nobody (null)', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]), { meta: PLAIN });
  r.put('a2', line('a2', [read(path.join(FEAT, 'a.py'))]));                       // no meta file
  r.put('a3', line('a3', [read(path.join(FEAT, 'a.py'))]), { meta: { name: 5, agentType: '' } });
  r.put('a4', line('a4', [read(path.join(FEAT, 'a.py'))]), { meta: { name: 'given-name', agentType: 'its-kind' } });
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => [c.agentId, c.agent]),
    [['a1', 'code-reviewer'], ['a2', null], ['a3', null], ['a4', 'given-name']]);
});

test('only agent-*.jsonl under subagents\\ is a transcript: another .jsonl beside them claims nothing', async () => {
  const r = rig();
  const f = r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  fs.writeFileSync(path.join(path.dirname(f), 'notes.jsonl'), line('stray', [read(path.join(FEAT2, 'a.py'))]));
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => c.agentId), ['a1']);
});

test('the launching folder is the one the transcript is FILED UNDER, whatever cwd its lines carry (it follows a cd)', async () => {
  const r = rig();
  const away = path.resolve('/occ-scan-reviews');
  // a1: cd'd away, then calls back into the launching folder -- not a claim on dev
  r.put('a1', line('a1', [use('Bash', { command: `cd ${away}` })], { at: T0 })
    + line('a1', [read(path.join(DEV, 'handoffs', 'brief.md')), use('Bash', { command: `cd ${DEV} && git status` })], { at: T0 + 1000, cwd: away }));
  // a2: the same, and it works in FEAT: one claim, launched from DEV on develop, though its last lines say otherwise
  r.put('a2', line('a2', [read(path.join(FEAT, 'a.py'))], { at: T0 })
    + line('a2', [read(path.join(FEAT, 'b.py')), read(path.join(DEV, 'brief.md'))], { at: T0 + 1000, cwd: away, branch: 'HEAD' })
    + line('a2', [text('thinking')], { at: T0 + 2000, cwd: 'some/relative/dir', branch: 'elsewhere' }));
  // a3: a line with no cwd at all still proves its touch
  const bare = JSON.parse(line('a3', [read(path.join(FEAT2, 'a.py'))]));
  delete bare.cwd;
  delete bare.gitBranch;
  r.put('a3', JSON.stringify(bare) + '\n');
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => [c.agentId, c.worktree, c.also, c.fromRoot, c.fromBranch]),
    [['a2', FEAT, [], DEV, 'develop'], ['a3', FEAT2, [], DEV, null]]);
  assert.deepStrictEqual(r.logs, []);
});

test('the session\'s branch is read off a line written IN the launching folder; with none, the claim names no branch', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { cwd: path.resolve('/occ-scan-reviews'), branch: 'not-this-one' }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').fromBranch, null);
  assert.strictEqual(r.claim('a1').fromRoot, DEV);
});

test('two worktrees whose names encode alike share one transcript folder: the first one git lists is the launcher', async () => {
  const r = rig();
  const dash = path.join(BASE, 'feat-z');
  const dot = path.join(BASE, 'feat.z');
  assert.strictEqual(projectDirName(dash), projectDirName(dot));
  r.roots = [DEV, dash, dot];
  r.put('a1', line('a1', [read(path.join(DEV, 'a.py'))], { cwd: dash, branch: 'feat/z' }), { from: dash });
  await r.scanner.pass();
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => [c.agentId, c.worktree, c.fromRoot]), [['a1', DEV, dash]]);
});

test('Grep, Glob and Bash count; a call in the launching folder, outside every worktree, or with a relative path does not', async () => {
  const r = rig();
  r.put('a1', line('a1', [use('Grep', { pattern: 'x', path: FEAT2 })]));
  r.put('a2', line('a2', [use('Glob', { pattern: '*', path: path.join(FEAT, 'src') })]));
  r.put('a3', line('a3', [use('Bash', { command: `git -C ${FEAT.replace(/\\/g, '/')} status` })]));
  r.put('a4', line('a4', [read(path.join(DEV, 'a.py')), read(path.resolve('/elsewhere/a.py')), read('src/a.py'), use('Grep', { pattern: 'x' })]));
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => [c.agentId, c.worktree]), [['a1', FEAT2], ['a2', FEAT], ['a3', FEAT]]);
});

test('a session that runs in a worktree: its agent claims nothing there, and dev when it goes to dev', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { cwd: FEAT, branch: 'feat/x' }), { from: FEAT });
  r.put('a2', line('a2', [read(path.join(DEV, 'a.py'))], { cwd: FEAT, branch: 'feat/x' }), { from: FEAT });
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => [c.agentId, c.worktree, c.fromRoot, c.fromBranch]), [['a2', DEV, FEAT, 'feat/x']]);
});

test('an agent that touched two worktrees: the latest is its claim, the other is `also`', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }) + line('a1', [read(path.join(FEAT2, 'a.py'))], { at: T0 + 1000 }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').worktree, FEAT2);
  assert.deepStrictEqual(r.claim('a1').also, [FEAT]);
});

// --- staleness: the file's mtime, under STALE_MS ---------------------------------------------------------

test('a transcript not written for STALE_MS claims nothing, however much it touched', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]), { meta: MATE, mtime: r.clock - T.STALE_MS });
  r.put('a2', line('a2', [read(path.join(FEAT, 'a.py'))]), { meta: MATE, mtime: r.clock - T.STALE_MS + 1000 });
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims().map(c => c.agentId), ['a2']);
  assert.strictEqual(T.STALE_MS, 10 * 60 * 1000);
});

test('a claim this producer made is removed once its transcript goes stale', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]), { meta: MATE });
  await r.scanner.pass();
  assert.ok(r.claim('a1'));
  r.clock += T.STALE_MS;
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.removed, ['a1']);
  assert.strictEqual(r.claim('a1'), null);
});

test('...and it comes back when the agent writes again (a teammate woken after a long idle): the tail is read anew', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]), { meta: MATE });
  await r.scanner.pass();
  r.clock += T.STALE_MS + 60_000;
  await r.scanner.pass();
  r.append('a1', line('a1', [read(path.join(FEAT2, 'b.py'))], { at: r.clock }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').worktree, FEAT2);
});

test('a transcript that is deleted takes its claim with it', async () => {
  const r = rig();
  const f = r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  await r.scanner.pass();
  fs.unlinkSync(f);
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.removed, ['a1']);
});

// --- the end of a run ------------------------------------------------------------------------------------

test('a plain subagent whose last message ended its turn has finished: no claim, and one it had is removed', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]) + userLine(), { meta: PLAIN });
  await r.scanner.pass();
  assert.ok(r.claim('a1'));
  r.append('a1', done('a1', T0 + 9000));
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.removed, ['a1']);
  // seen whole for the first time, already finished: nothing
  r.put('a2', line('a2', [read(path.join(FEAT, 'a.py'))]) + done('a2', T0 + 9000), { meta: PLAIN });
  await r.scanner.pass();
  assert.strictEqual(r.claim('a2'), null);
});

test('a plain subagent that is resumed after it finished starts from scratch: only what it touches now', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }) + done('a1', T0 + 1000), { meta: PLAIN });
  await r.scanner.pass();
  r.append('a1', line('a1', [text('woken')], { at: T0 + 2000, stop: null }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1'), null, 'awake, but it has proven nothing in this run yet');
  r.append('a1', line('a1', [read(path.join(FEAT2, 'b.py'))], { at: T0 + 3000 }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').worktree, FEAT2);
  assert.deepStrictEqual(r.claim('a1').also, [], 'the first run\'s worktree is not carried over');
  assert.strictEqual(r.claim('a1').firstAt, T0 + 3000);
});

test('a TEAMMATE that ended its turn is idle, not gone: its claim stays until the transcript goes stale', async () => {
  const r = rig();
  r.put('amate-1', line('amate-1', [read(path.join(FEAT, 'a.py'))]) + done('amate-1', T0 + 9000), { meta: MATE });
  await r.scanner.pass();
  assert.strictEqual(r.claim('amate-1').worktree, FEAT);
  r.clock += T.STALE_MS - 1;
  await r.scanner.pass();
  assert.ok(r.claim('amate-1'), 'still inside the window');
  r.clock += 61_000;
  await r.scanner.pass();
  assert.strictEqual(r.claim('amate-1'), null);
});

test('a meta that can\'t be read yet is asked for again: until then the agent is nobody and not a teammate', async () => {
  const r = rig();
  const f = r.put('amate-1', line('amate-1', [read(path.join(FEAT, 'a.py'))]) + done('amate-1', T0 + 9000));
  fs.mkdirSync(f.replace(/\.jsonl$/, '.meta.json'));           // EISDIR, not ENOENT
  await r.scanner.pass();
  assert.strictEqual(r.claim('amate-1'), null, 'ended, and not known to be a teammate');
  fs.rmdirSync(f.replace(/\.jsonl$/, '.meta.json'));
  fs.writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(MATE));
  await r.scanner.pass();
  assert.strictEqual(r.claim('amate-1').agent, 'lane-x');
});

// --- reading: the tail first, then only what is new -------------------------------------------------------

test('only new bytes are read on the next pass: the count grows by the new calls, never by the old ones again', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }), { meta: MATE });
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').count, 1);
  r.clock += S.REWRITE_MS;                                     // past the writer's own rewrite window
  r.append('a1', line('a1', [read(path.join(FEAT, 'b.py'))], { at: T0 + 2000 }));
  await r.scanner.pass();
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').count, 2);
  assert.strictEqual(r.claim('a1').firstAt, T0);
  assert.strictEqual(r.claim('a1').lastAt, T0 + 2000);
});

test('a half-written last line is left for the next pass, then counted once', async () => {
  const r = rig();
  const whole = line('a1', [read(path.join(FEAT, 'a.py'))]);
  r.put('a1', whole.slice(0, 60));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1'), null);
  r.put('a1', whole);
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').count, 1);
});

test('only the TAIL of a long transcript is read: what lies further back than tailBytes claims nothing, and the cut line is dropped', async () => {
  const r = rig({ tailBytes: 600 });
  const old = line('a1', [read(path.join(FEAT, 'old.py'))], { at: T0 });
  const filler = line('a1', [text('x'.repeat(900))], { at: T0 + 1000, stop: null });
  const recent = line('a1', [read(path.join(FEAT2, 'new.py'))], { at: T0 + 2000 });
  assert.ok(recent.length < 600 && filler.length > 600);
  r.put('a1', old + filler + recent);
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').worktree, FEAT2);
  assert.deepStrictEqual(r.claim('a1').also, [], 'the old call is behind the tail');
});

test('a transcript that shrank or was replaced is read anew, from its tail', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]) + line('a1', [read(path.join(FEAT, 'b.py'))]));
  await r.scanner.pass();
  r.put('a1', line('a1', [read(path.join(FEAT2, 'c.py'))]));
  r.clock += S.REWRITE_MS;
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').worktree, FEAT2);
  assert.strictEqual(r.claim('a1').count, 1);
});

test('lines that are not an agent\'s own assistant messages prove nothing: user lines, junk, an unsafe agent id', async () => {
  const r = rig();
  r.put('a1', userLine() + '{not json "assistant"\n' + '\n'
    + JSON.stringify({ type: 'user', agentId: 'a1', cwd: DEV, message: { role: 'user', content: [read(path.join(FEAT, 'a.py'))] } }) + '\n'
    + line('../evil', [read(path.join(FEAT, 'a.py'))])
    + JSON.stringify({ type: 'assistant', agentId: 'a1', cwd: DEV, message: null }) + '\n');
  await r.scanner.pass();
  assert.deepStrictEqual(r.claims(), []);
});

test('a line with no timestamp is timed by the file\'s mtime, never by 1970 and never by NaN', async () => {
  const r = rig();
  const l = JSON.parse(line('a1', [read(path.join(FEAT, 'a.py'))]));
  delete l.timestamp;
  r.put('a1', JSON.stringify(l) + '\n', { mtime: r.clock - 5000 });
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').firstAt, r.clock - 5000);
  assert.strictEqual(r.claim('a1').lastAt, r.clock - 5000);
});

// --- one producer per agent --------------------------------------------------------------------------------

const foreign = (over = {}) => ({
  agentId: 'a1', agent: 'electron-pro', worktree: FEAT, also: [], fromBranch: 'develop', fromRoot: DEV,
  hostPid: 4242, hostStartedAt: '1000', firstAt: 1, lastAt: 2, count: 1, ...over,
});
const plant = (r, claim) => {
  fs.mkdirSync(r.dir, { recursive: true });
  fs.writeFileSync(path.join(r.dir, `${claim.agentId}.json`), O.serializeClaim(claim));
};

test('an agent a LIVE producer already claims (its launching host, by hook) is left to it: not overwritten, not removed', async () => {
  const r = rig();
  plant(r, foreign());
  r.live = [foreign()];
  r.put('a1', line('a1', [read(path.join(FEAT2, 'a.py'))]));
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.claimed, []);
  assert.strictEqual(r.claim('a1').hostPid, 4242);
  r.clock += T.STALE_MS;
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, 4242, 'a stale transcript removes nothing of somebody else\'s');
});

test('a claim file from another producer that is NOT known live is left alone for one pass, then taken over', async () => {
  // One pass of grace: a claim a host wrote a moment ago isn't in the readers' live list yet (the list is
  // judged by asking the OS), and overwriting it would make the file flip between two producers.
  const r = rig();
  plant(r, foreign());
  r.put('a1', line('a1', [read(path.join(FEAT2, 'a.py'))]));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, 4242);
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, OWN_PID, 'still not live on the second look: its producer is gone');
  assert.strictEqual(r.claim('a1').worktree, FEAT2);
});

test('...and the grace starts over if it shows up live in between', async () => {
  const r = rig();
  plant(r, foreign());
  r.put('a1', line('a1', [read(path.join(FEAT2, 'a.py'))]));
  await r.scanner.pass();
  r.live = [foreign()];
  await r.scanner.pass();
  r.live = [];
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, 4242, 'one pass of grace again');
});

test('a claim this producer made that another producer then took over is forgotten, and survives this producer\'s exit', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, OWN_PID);
  plant(r, foreign());
  r.live = [foreign()];
  await r.scanner.pass();
  r.scanner.close();
  assert.strictEqual(r.claim('a1').hostPid, 4242);
});

test('a claim another producer took over is not removed when the transcript goes stale in the same breath', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  await r.scanner.pass();
  plant(r, foreign());                       // not in the live list: nobody has judged it yet
  r.clock += T.STALE_MS;
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.removed, []);
  assert.strictEqual(r.claim('a1').hostPid, 4242);
});

test('taking a dead producer\'s file over writes at once, even inside this writer\'s own 30 s window for that agent', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  await r.scanner.pass();                    // this producer's claim, written now
  plant(r, foreign());                       // replaced by a producer that then died
  await r.scanner.pass();                    // one pass of grace
  await r.scanner.pass();                    // taken over -- with no time passed
  assert.strictEqual(r.claim('a1').hostPid, OWN_PID);
});

test('the grace is per sighting: an agent that went quiet and came back is given its one pass again', async () => {
  const r = rig();
  plant(r, foreign());
  r.put('a1', line('a1', [read(path.join(FEAT2, 'a.py'))]), { meta: MATE });
  await r.scanner.pass();                                  // seen once, left alone
  r.clock += T.STALE_MS;                                   // the transcript goes quiet: nothing is wanted
  await r.scanner.pass();
  r.append('a1', line('a1', [read(path.join(FEAT2, 'b.py'))], { at: r.clock }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, 4242, 'a first sighting again, not a second one');
});

test('...and so is an agent this producer took over, when yet another producer claims it later', async () => {
  const r = rig();
  plant(r, foreign());
  r.put('a1', line('a1', [read(path.join(FEAT2, 'a.py'))]));
  await r.scanner.pass();
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, OWN_PID);
  plant(r, foreign({ hostPid: 5555 }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').hostPid, 5555, 'one pass of grace for the newcomer');
});

// --- PR #96 review: Dexter F1. An EMPTY slot is not "unowned" when its owner emptied it. -----------------
// The hook producer deleting its own file (SubagentStop, a teammate's idle expiry, SessionEnd, the host's
// exit) is the precise "this agent is done here". The transcript is still fresh for minutes afterwards, and
// bringing the claim back from it would show an agent that is gone, and ask the confirm all over again.

test('a claim its owner REMOVED is not brought back from the transcript, pass after pass', async () => {
  const r = rig();
  plant(r, foreign());
  r.live = [foreign()];
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }) + done('a1', T0 + 1000), { meta: MATE });
  await r.scanner.pass();                                  // the host's claim: left to it
  fs.unlinkSync(path.join(r.dir, 'a1.json'));              // SessionEnd: the host removes it
  r.live = [];
  assert.deepStrictEqual((await r.scanner.pass()).claimed, []);
  r.append('a1', line('a1', [text('still talking, touching nothing')], { at: r.clock, stop: 'end_turn' }));
  assert.deepStrictEqual((await r.scanner.pass()).claimed, []);
  assert.strictEqual(r.claim('a1'), null);
});

test('...until the agent proves it is there again: a touch NEWER than the ones its owner let go of', async () => {
  const r = rig();
  plant(r, foreign());
  r.live = [foreign()];
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }), { meta: MATE });
  await r.scanner.pass();
  fs.unlinkSync(path.join(r.dir, 'a1.json'));
  r.live = [];
  await r.scanner.pass();
  r.append('a1', line('a1', [read(path.join(FEAT, 'b.py'))], { at: T0 + 5000 }));
  assert.deepStrictEqual((await r.scanner.pass()).claimed, ['a1']);
  assert.strictEqual(r.claim('a1').hostPid, OWN_PID);
});

test('...and going quiet does not wipe that memory: woken later with no new touch, it is still not claimed', async () => {
  const r = rig();
  plant(r, foreign());
  r.live = [foreign()];
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }), { meta: MATE });
  await r.scanner.pass();
  fs.unlinkSync(path.join(r.dir, 'a1.json'));              // the host expired the idle teammate's claim
  r.live = [];
  await r.scanner.pass();
  r.clock += T.STALE_MS + 60_000;                          // the transcript goes stale and is forgotten
  await r.scanner.pass();
  r.append('a1', line('a1', [text('woken, thinking')], { at: r.clock, stop: null }));
  assert.deepStrictEqual((await r.scanner.pass()).claimed, [], 'its old touch is the one its owner let go of');
});

test('a file this producer TOOK OVER is its own from then on: removing it for staleness is not "its owner let go of it"', async () => {
  const r = rig();
  plant(r, foreign());                                     // a producer that died: never live
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }), { meta: MATE });
  await r.scanner.pass();
  await r.scanner.pass();                                  // taken over
  assert.strictEqual(r.claim('a1').hostPid, OWN_PID);
  r.clock += T.STALE_MS;
  assert.deepStrictEqual((await r.scanner.pass()).removed, ['a1']);
  r.append('a1', line('a1', [text('woken')], { at: r.clock, stop: null }));
  assert.deepStrictEqual((await r.scanner.pass()).claimed, ['a1'], 'by the mtime rule, as for any teammate of an unhosted session');
});

test('a slot that was ALWAYS empty is unowned: the transcript claims it (a session no host of this build runs)', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]), { meta: MATE });
  assert.deepStrictEqual((await r.scanner.pass()).claimed, ['a1']);
});

// --- PR #96 review: Dexter F6. A folder that can't be listed protects ITS agents, not everybody's. -------

test('one unlistable folder does not stop the scanner from removing a claim whose own transcript says it finished', async () => {
  const real = fs.promises;
  const blocked = path.join(projectDirName(FEAT), 's9', 'subagents');
  const fsp = {
    open: (...a) => real.open(...a),
    stat: (...a) => real.stat(...a),
    readdir: async (p, ...rest) => {
      if (path.resolve(String(p)).endsWith(blocked)) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return real.readdir(p, ...rest);
    },
  };
  const r = rig({ fsp });
  // under FEAT's project folder: a session whose subagents folder can never be listed
  fs.mkdirSync(path.join(r.projects, blocked), { recursive: true });
  // under DEV's: a plain subagent that claims FEAT, then finishes
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 }), { meta: PLAIN });
  await r.scanner.pass();
  assert.ok(r.claim('a1'));
  r.append('a1', done('a1', T0 + 2000));
  const out = await r.scanner.pass();
  assert.deepStrictEqual(out.removed, ['a1']);
  assert.strictEqual(r.claim('a1'), null);
  // ...and a transcript that goes stale under the listable folder is removed too
  r.put('a2', line('a2', [read(path.join(FEAT, 'a.py'))]), { meta: MATE });
  await r.scanner.pass();
  r.clock += T.STALE_MS;
  assert.deepStrictEqual((await r.scanner.pass()).removed, ['a2']);
});

// --- PR #96 review: Miguel S2 -----------------------------------------------------------------------------

test('only a real start time is a proof: with anything else this producer writes nothing', async () => {
  for (const started of ['?', '', 'soon', 5, undefined]) {
    const r = rig({ ownStartedAt: async () => started });
    r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
    assert.deepStrictEqual((await r.scanner.pass()).claimed, [], JSON.stringify(started));
    assert.deepStrictEqual(r.claims(), []);
  }
});

test('close removes every claim this producer still owns', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  r.put('a2', line('a2', [read(path.join(FEAT, 'a.py'))]));
  await r.scanner.pass();
  r.scanner.close();
  assert.deepStrictEqual(r.claims(), []);
});

// --- its own proof, and failures --------------------------------------------------------------------------

test('until this process knows its own start time it writes nothing: a claim without the proof is never shown anyway', async () => {
  let start = null;
  const r = rig({ ownStartedAt: async () => start });
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  assert.deepStrictEqual((await r.scanner.pass()).claimed, []);
  assert.deepStrictEqual(r.claims(), []);
  start = START;
  assert.deepStrictEqual((await r.scanner.pass()).claimed, ['a1']);
});

test('a stale worktree list is refreshed before the pass; a failing refresh or a failing start-time query never throws', async () => {
  const r = rig();
  r.staleRoots = true;
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  await r.scanner.pass();
  assert.strictEqual(r.refreshed, 1);
  const bad = rig({ ownStartedAt: async () => { throw new Error('powershell'); } });
  bad.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  await assert.doesNotReject(bad.scanner.pass());
  const worse = rig({ roots: { get: () => ROOTS, stale: () => true, refresh: async () => { throw new Error('git'); } } });
  worse.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  assert.deepStrictEqual((await worse.scanner.pass()).claimed, ['a1'], 'the last list it had still serves');
});

test('no projects folder, no folder for a worktree, a session with no subagents: nothing, quietly', async () => {
  const r = rig({ projectsDir: path.join(tmpDir('occ-scan-none-'), 'missing') });
  assert.deepStrictEqual(await r.scanner.pass(), { claimed: [], removed: [] });
  const r2 = rig();
  fs.mkdirSync(path.join(r2.projects, projectDirName(DEV), 's1'), { recursive: true });
  fs.writeFileSync(path.join(r2.projects, projectDirName(DEV), 's1.jsonl'), line('main', [read(path.join(FEAT, 'a.py'))]));
  assert.deepStrictEqual(await r2.scanner.pass(), { claimed: [], removed: [] }, 'a session\'s own transcript is never an agent\'s');
  assert.deepStrictEqual(r2.logs, [], 'and a session file beside the session folders is not a folder that failed to list');
});

test('a folder that can\'t be listed is said once, and never removes a claim already made (absence is not "finished")', async () => {
  let busy = false;
  const real = fs.promises;
  const fsp = {
    open: (...a) => real.open(...a),
    stat: (...a) => real.stat(...a),
    readdir: async (p, ...rest) => {
      if (busy && path.basename(String(p)) === 'subagents') { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
      return real.readdir(p, ...rest);
    },
  };
  // a tail just longer than one line: once the second line is appended, the first is behind the tail
  const first = line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 });
  const r = rig({ fsp, tailBytes: first.length + 10 });
  r.put('a1', first);
  await r.scanner.pass();
  busy = true;
  const out = await r.scanner.pass();
  await r.scanner.pass();
  assert.deepStrictEqual(out.removed, []);
  assert.ok(r.claim('a1'));
  assert.strictEqual(r.logs.filter(l => /can't be listed/.test(l)).length, 1);
  busy = false;
  r.clock += S.REWRITE_MS;
  r.append('a1', line('a1', [read(path.join(FEAT, 'b.py'))], { at: T0 + 1000 }));
  await r.scanner.pass();
  assert.strictEqual(r.claim('a1').count, 2, 'what it had read was kept through the failure: the first call is behind the tail now');
  assert.strictEqual(r.claim('a1').firstAt, T0);
});

test('overlapping passes share one run', async () => {
  const r = rig();
  r.put('a1', line('a1', [read(path.join(FEAT, 'a.py'))]));
  const [a, b] = await Promise.all([r.scanner.pass(), r.scanner.pass()]);
  assert.strictEqual(a, b);
});

// --- the pure fold -----------------------------------------------------------------------------------------

test('fold: lines out of order in time still give the earliest first touch and the latest last one', () => {
  const s = T.newState();
  T.foldLines(s, line('a1', [read(path.join(FEAT, 'a.py'))], { at: T0 + 5000 })
    + line('a1', [read(path.join(FEAT, 'b.py'))], { at: T0 + 1000 })
    + line('a1', [read(path.join(FEAT, 'c.py'))], { at: T0 + 3000 }), ROOTS, T0, DEV);
  assert.deepStrictEqual(T.touchesOf(s), [{ worktree: FEAT, firstAt: T0 + 1000, lastAt: T0 + 5000, count: 3 }]);
});

test('fold: the touches are bounded, the least recently touched worktree forgotten first', () => {
  const many = Array.from({ length: T.TOUCHES_MAX + 3 }, (_, i) => path.join(BASE, `wt-${i}`));
  const s = T.newState({ teammate: true });
  T.foldLines(s, many.map((root, i) => line('a1', [read(path.join(root, 'a.py'))], { at: T0 + i })).join('')
    + line('a1', [read(path.join(many[3], 'again.py'))], { at: T0 + 100 }), [DEV, ...many], T0, DEV);
  const kept = T.touchesOf(s).map(t => t.worktree);
  assert.strictEqual(kept.length, T.TOUCHES_MAX);
  assert.ok(!kept.includes(many[0]) && !kept.includes(many[2]), 'the oldest went');
  assert.strictEqual(kept[kept.length - 1], many[3], 'touched again: the most recent');
});

test('PROPERTY: folding a transcript in any number of chunks gives the same touches as folding it at once', () => {
  const roots = fc.constantFrom(FEAT, FEAT2, DEV, path.resolve('/elsewhere'));
  const block = fc.oneof(fc.constant(text('t')), roots.map(root => read(path.join(root, 'a.py'))),
    roots.map(root => use('Grep', { pattern: 'x', path: root })));
  const msg = fc.record({ blocks: fc.array(block, { maxLength: 3 }), stop: fc.constantFrom('tool_use', 'end_turn', null), dt: fc.integer({ min: 0, max: 5000 }) });
  fc.assert(fc.property(fc.array(msg, { minLength: 1, maxLength: 20 }), fc.array(fc.nat(), { maxLength: 5 }), fc.boolean(), (ms, cuts, teammate) => {
    let at = T0;
    const all = ms.map((m) => { at += m.dt; return line('a1', m.blocks, { at, stop: m.stop }); });
    const whole = T.newState({ teammate });
    T.foldLines(whole, all.join(''), ROOTS, T0, DEV);
    const parts = T.newState({ teammate });
    const idx = [...new Set(cuts.map(c => c % (all.length + 1)))].sort((a, b) => a - b);
    let from = 0;
    for (const cut of [...idx, all.length]) {
      if (cut > from) T.foldLines(parts, all.slice(from, cut).join(''), ROOTS, T0, DEV);
      from = Math.max(from, cut);
    }
    assert.deepStrictEqual(T.touchesOf(parts), T.touchesOf(whole));
    // and a touch only ever names a listed worktree that is not the launching folder
    for (const t of T.touchesOf(whole)) assert.ok([FEAT, FEAT2].includes(t.worktree), t.worktree);
    return true;
  }), { numRuns: 300 });
});

test('PROPERTY: a plain subagent\'s touches are exactly the calls since its last end_turn; a teammate\'s are all of them', () => {
  const step = fc.oneof(fc.constant('end'), fc.constantFrom(FEAT, FEAT2).map(root => ({ root })));
  fc.assert(fc.property(fc.array(step, { minLength: 1, maxLength: 20 }), (steps) => {
    let at = T0;
    const body = steps.map((s) => { at += 1000; return s === 'end' ? done('a1', at) : line('a1', [read(path.join(s.root, 'a.py'))], { at }); }).join('');
    const plain = T.newState({ teammate: false });
    T.foldLines(plain, body, ROOTS, T0, DEV);
    const mate = T.newState({ teammate: true });
    T.foldLines(mate, body, ROOTS, T0, DEV);
    const lastEnd = steps.lastIndexOf('end');
    const since = steps.slice(lastEnd + 1).filter(s => s !== 'end');
    const count = list => list.reduce((n, t) => n + t.count, 0);
    assert.strictEqual(count(T.touchesOf(plain)), since.length);
    assert.strictEqual(count(T.touchesOf(mate)), steps.filter(s => s !== 'end').length);
    return true;
  }), { numRuns: 300 });
});
