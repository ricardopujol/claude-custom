'use strict';
/**
 * PROBE: worktree occupancy (backlog #44 + #47, documentation/DESIGN_WORKTREE_OCCUPANCY.md) in a REAL window
 * with REAL hosts. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-worktree-occupancy.js      (exit 0 = every check held)
 *   OCCUPANCY_PROBE_SHOTS=<dir>                                              also keep the screenshots there
 *
 * The unit tests pin the pieces. No unit test can see the strip page paint a hatched edge, the page draw its
 * bar chip, xterm's own input path meet the confirm, or a launching host's claim file be read back by a window
 * that proves it alive. This runs the whole chain: a real tabs window over a temp git project (develop,
 * feat/a), the DEV host as the launching session, and real hook events delivered to its pipe through the
 * native helper -- exactly what Claude Code's hooks do.
 *
 *   1  the producer: a main-session call, a call in the launcher's own folder, and an unsafe agent_id each
 *      write NO claim file
 *   2  a subagent's Edit inside feat-a writes <agent_id>.json naming the agent, the launching folder and
 *      branch, the DEV HOST's pid and its real OS start time
 *   3  the strip: feat/a's tab has the hatched edge (stripes, 4px, NOT animated) and the agent's initials;
 *      the other tabs have neither; the hover names the agent, its launcher and the minutes
 *   4  the hub: the launching session's roster card for that agent says `-> feat-a`; a click on it selects
 *      feat/a's tab
 *   5  the worktree's window: the terminal bar's occupancy chip (#47's banner folded into it, PR for #49 + #52)
 *      carries the agent's initials, and its hover names the agent, where it came from and Jump to develop
 *   6  the confirm: the first keystroke is HELD (xterm onData), *Type* releases it into the session and the
 *      run is not asked again; a second agent is a new run; *Wait* drops its key
 *   7  two writers: the page's own turn turns the edge, the chip and the confirm to the warn colour
 *   8  SubagentStop deletes the claims and clears the strip, the bar and the card line
 *   9  liveness: a claim file for THIS process (alive) is shown only with its exact start time -- not with no
 *      start time, not with the wrong one (a reused pid); a malformed file is skipped
 *  10  killing the launching host (its own PID, never by name) clears the strip and the bar on their own,
 *      and the reader leaves its claim file where it is
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and
 * every CLAUDE_CUSTOM_* not passed on purpose are deleted; registry, portraits, uploads and user data are temp
 * folders; the project is a temp git repo. The only processes killed are hosts whose folder is inside the
 * probe's temp folder and the window it started, by PID.
 *
 * NOT driven here: the host's own `turn` message (probe-git-tree.js covers it); step 7 sets the page's turn
 * through the probe hook and checks the page -> shell -> strip path.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const HELPER = path.join(HARNESS_DIR, 'hook-helper.exe');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { startTimes } = require(path.join(ROOT, 'host', 'proc-start'));
const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));
const { serializeClaim } = require(path.join(ROOT, 'host', 'agent-occupancy'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);       // nothing here is ever suspended
hygiene.install();                      // Ctrl+C and a crash still clean up
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-occ-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const OCC_DIR = path.join(dev, '.claude-custom', 'occupancy');
const userData = path.join(tmp, 'user-data');
const shots = process.env.OCCUPANCY_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 20000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env });
  hygiene.registerSpawnedTree(child.pid);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });
  return app;
}

function command(app, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

const seenPids = new Set();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid);
  for (const pid of seenPids) { try { killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true });

// What Claude Code's hook does: the native helper writes one event to the host's pipe.
function hook(hostPid, event, payload) {
  const r = spawnSync(HELPER, ['--pipe', `\\\\.\\pipe\\claude-custom-${hostPid}`, '--event', event],
    { input: JSON.stringify(payload), windowsHide: true });
  return r.status === 0;
}

const claimFiles = () => { try { return fs.readdirSync(OCC_DIR).filter(f => f.endsWith('.json')).sort(); } catch { return []; } };
const readClaim = (id) => { try { return JSON.parse(fs.readFileSync(path.join(OCC_DIR, `${id}.json`), 'utf8')); } catch { return null; } };

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
  return st;
};
const stripTab = async (app, label) => {
  const st = await stateOf(app);
  return Array.isArray(st && st.stripOccupancy) ? st.stripOccupancy.find(t => t.label === label) || null : null;
};
const view = async (app, action, args = {}) => {
  const r = await command(app, { cmd: 'view', action, args });
  return r;
};
const occState = async (app) => view(app, 'occState');
const screenOf = async (app) => {
  const r = await view(app, 'gitScreen');
  return r && r.ok ? String(r.text) : '';
};
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });

const SUB = (id, agent, extra = {}) => ({ session_id: 'probe', agent_id: id, agent_type: agent, ...extra });
const editIn = (dir, id, agent) => ({ ...SUB(id, agent), tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'app', 'x.js') } });

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', '-b', 'feat/a', featA);
  if (!fs.existsSync(HELPER)) { check('the native hook helper exists (.harness/hook-helper.exe)', false, HELPER); return; }

  const app = await launchApp(container);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    const h = ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid));
    return h || null;
  }, 60000);
  check('0: the window is up and the DEV host (the launching session) is running', !!devHost,
    devHost ? `pid ${devHost.pid}` : `exited=${app.exited} tab0=${JSON.stringify(((await stateOf(app)).tabs || [])[0] || null)} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(1500);   // its hook bridge binds a moment after its identity is written
  const devPid = devHost.pid;

  // 1 -----------------------------------------------------------------------------
  hook(devPid, 'PreToolUse', { session_id: 'probe', tool_name: 'Edit', tool_input: { file_path: path.join(featA, 'a.js') } });   // the MAIN session's own call
  hook(devPid, 'PreToolUse', editIn(dev, 'ownroot01', 'electron-pro'));
  hook(devPid, 'PreToolUse', { ...editIn(featA, '..', 'electron-pro') });
  await sleep(1500);
  check('1: a main-session call, a call in the launcher\'s own folder and an unsafe agent_id write NO claim', claimFiles().length === 0,
    JSON.stringify(claimFiles()));

  // the card the hub shows for the agent, and the claim itself
  hook(devPid, 'PreToolUse', { session_id: 'probe', tool_name: 'Agent', tool_input: { subagent_type: 'electron-pro', description: 'probe' }, tool_use_id: 'toolu_probe1' });
  hook(devPid, 'PreToolUse', editIn(featA, 'probeagent01', 'electron-pro'));

  // 2 -----------------------------------------------------------------------------
  const claim = await waitFor(() => readClaim('probeagent01'), 15000);
  check('2: a subagent\'s Edit inside feat-a writes <agent_id>.json', !!claim, JSON.stringify(claimFiles()));
  if (!claim) { console.log(app.out.slice(-800)); return; }
  const ownStart = (await startTimes([devPid])).get(devPid);
  check('2: ...naming the agent, the worktree, the launching folder and branch',
    claim.agent === 'electron-pro' && path.resolve(claim.worktree).toLowerCase() === path.resolve(featA).toLowerCase()
      && path.resolve(claim.fromRoot).toLowerCase() === path.resolve(dev).toLowerCase() && claim.fromBranch === 'develop', JSON.stringify(claim));
  check('2: ...and the launching host\'s pid with its real OS start time', claim.hostPid === devPid && claim.hostStartedAt === ownStart,
    `${claim.hostPid}/${claim.hostStartedAt} vs ${devPid}/${ownStart}`);
  check('2: ...no temp file left behind', fs.readdirSync(OCC_DIR).every(f => /^[A-Za-z0-9_-]+\.json$/.test(f)), JSON.stringify(fs.readdirSync(OCC_DIR)));

  // 3 -----------------------------------------------------------------------------
  const marked = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    return t && t.occupied ? t : null;
  }, 20000);
  check('3: feat/a\'s tab has the hatched edge and the agent\'s initials', !!marked && JSON.stringify(marked.tags) === '["EP"]', JSON.stringify(marked));
  if (marked) {
    check('3: ...stripes, 4px tall, never animated', /repeating-linear-gradient/.test(marked.edge) && marked.edgeHeight === '4px' && marked.edgeAnimation === 'none',
      `${marked.edge.slice(0, 60)} ${marked.edgeHeight} ${marked.edgeAnimation}`);
    check('3: ...the hover names the agent, its launcher and the time', /electron-pro . from develop . /.test(marked.title), JSON.stringify(marked.title));
  }
  const others = await Promise.all(['develop'].map(l => stripTab(app, l)));
  check('3: the launching tab is not marked', others.every(t => t && !t.occupied && t.tags.length === 0), JSON.stringify(others));
  await sleep(400);
  await shoot(app, '1-occupied');

  // 4 -----------------------------------------------------------------------------
  const card = await waitFor(async () => {
    const o = await occState(app);
    return o && o.ok && o.where.find(w => w.agent === 'electron-pro') ? o : null;
  }, 15000);
  check('4: the launching session\'s roster card says where the agent is', !!card && /feat-a/.test(card.where[0].text), card ? JSON.stringify(card.where) : 'no card line');
  if (card) {
    await shoot(app, '0-card');
    const clicked = await view(app, 'occClick', { target: 'where' });
    const sel = await waitFor(async () => {
      const st = await stateOf(app);
      const t = Array.isArray(st && st.stripDom) ? st.stripDom.find(x => x.selected) : null;
      return t && t.label === 'feat/a' ? t : null;
    }, 20000);
    check('4: ...and a click on it selects feat/a\'s tab', !!clicked.ok && !!sel, JSON.stringify(clicked));
  }

  // 5 -----------------------------------------------------------------------------
  const chipOf = (o) => (o && o.ok ? o.bar.bar.chips.find(c => c.kind === 'occupancy') || null : null);
  const banner = await waitFor(async () => {
    const o = await occState(app);
    return chipOf(o) ? o : null;
  }, 20000);
  const chip = chipOf(banner);
  check('5: feat/a\'s window shows ONE bar with the agent\'s chip (the old banner is gone), initials EP, and the hover says who and from where',
    !!chip && banner.bar.bar.hidden === false && chip.short === 'EP' && /electron-pro . from develop/.test(chip.long), chip ? JSON.stringify(chip) : 'no chip');
  if (chip) {
    check('5: ...with Jump to develop (the chip is the button), a left rule, no animation, and no warning', chip.tag === 'button' && /Jump to develop/.test(chip.long)
      && parseFloat(chip.leftRule) >= 3 && chip.animation === 'none' && chip.warn === false && banner.confirm.hidden === true
      && banner.bar.bar.animation === 'none' && banner.bar.bar.prompt.hidden === true,
      JSON.stringify(banner.bar.bar));
  }
  await sleep(400);
  await shoot(app, '2-chip');

  // 6 -----------------------------------------------------------------------------
  await view(app, 'occKey', { data: 'zq1' });
  const asking = await waitFor(async () => {
    const o = await occState(app);
    return o && o.ok && !o.confirm.hidden ? o : null;
  }, 8000);
  check('6: the first keystroke opens the question', !!asking, asking ? asking.confirm.text : 'no confirm');
  await sleep(800);
  check('6: ...and is HELD: the session has not seen it', !(await screenOf(app)).includes('zq1'));
  await shoot(app, '3-confirm');
  await view(app, 'occClick', { target: 'type' });
  const typed = await waitFor(async () => ((await screenOf(app)).includes('zq1') ? true : null), 10000);
  check('6: Type releases it into the session', !!typed);
  const closed = await occState(app);
  check('6: ...and the question closes', closed.ok && closed.confirm.hidden === true);
  await view(app, 'occKey', { data: 'zq2' });
  const second = await waitFor(async () => ((await screenOf(app)).includes('zq2') ? true : null), 10000);
  const again = await occState(app);
  check('6: the same run is not asked again (the key goes straight through)', !!second && again.confirm.hidden === true);

  hook(devPid, 'PreToolUse', editIn(featA, 'probeagent02', 'logic-reviewer'));
  const two = await waitFor(async () => {
    const o = await occState(app);
    const c = chipOf(o);
    return c && c.short === 'EP LR' && /logic-reviewer/.test(c.long) ? o : null;
  }, 15000);
  check('6: a second agent joins the chip (EP LR) and its hover', !!two, two ? JSON.stringify(chipOf(two)) : 'no second agent');
  const tabTwo = await stripTab(app, 'feat/a');
  check('6: ...and as a second tag on the tab', !!tabTwo && JSON.stringify(tabTwo.tags) === '["EP","LR"]', JSON.stringify(tabTwo && tabTwo.tags));
  await view(app, 'occKey', { data: 'wq9' });
  const reasked = await waitFor(async () => {
    const o = await occState(app);
    return o && o.ok && !o.confirm.hidden ? o : null;
  }, 8000);
  check('6: a second agent is a new run: asked again', !!reasked);
  await view(app, 'occClick', { target: 'wait' });
  await sleep(1500);
  const waited = await occState(app);
  check('6: Wait drops the key, closes the question, and nothing reached the session',
    waited.ok && waited.confirm.hidden === true && !(await screenOf(app)).includes('wq9'));

  // 7 -----------------------------------------------------------------------------
  await view(app, 'occTurn', { turn: 'turn' });
  const warned = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    return t && t.warn ? t : null;
  }, 15000);
  // the bar's paint is coalesced on a short timer, so it is awaited rather than read at once
  const warnBanner = await waitFor(async () => { const o = await occState(app); const c = chipOf(o); return c && c.warn ? o : null; }, 8000) || await occState(app);
  check('7: the tab\'s own session mid-turn turns the edge to the warning', !!warned && /writing too/.test(warned.title), warned ? warned.title : 'no warn');
  const warnChip = chipOf(warnBanner);
  check('7: ...and the chip', !!warnChip && warnChip.warn === true && /own session is writing too/.test(warnChip.long), JSON.stringify(warnChip));
  await view(app, 'occKey', { data: 'x' });
  await sleep(300);
  const warnConfirm = await occState(app);
  check('7: ...and the confirm (a Wait first: the previous run\'s key was never typed)', warnConfirm.ok && (warnConfirm.confirm.hidden || warnConfirm.confirm.warn === true), JSON.stringify(warnConfirm.confirm));
  await shoot(app, '4-two-writers');
  await view(app, 'occClick', { target: 'wait' });
  await view(app, 'occTurn', { turn: 'idle' });
  const calm = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    return t && t.occupied && !t.warn ? t : null;
  }, 15000);
  check('7: back to idle: the warning goes, the occupancy stays', !!calm);

  // 8 -----------------------------------------------------------------------------
  hook(devPid, 'SubagentStop', SUB('probeagent01', 'electron-pro'));
  hook(devPid, 'SubagentStop', SUB('probeagent02', 'logic-reviewer'));
  const gone = await waitFor(() => (claimFiles().length === 0 ? true : null), 10000);
  check('8: SubagentStop deletes the claims', !!gone, JSON.stringify(claimFiles()));
  const cleared = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    const o = await occState(app);
    return t && !t.occupied && o && o.ok && o.bar.bar.hidden && o.bar.bar.chips.length === 0 ? true : null;
  }, 15000);
  check('8: ...and the strip and the bar clear', !!cleared);

  // 9 -----------------------------------------------------------------------------
  const own = process.pid;
  const ownProc = (await startTimes([own])).get(own);
  const base = { agent: 'electron-pro', worktree: featA, also: [], fromBranch: 'develop', fromRoot: dev, hostPid: own, firstAt: Date.now(), lastAt: Date.now(), count: 1 };
  const put = (id, over) => fs.writeFileSync(path.join(OCC_DIR, `${id}.json`), serializeClaim({ agentId: id, ...base, hostStartedAt: ownProc, ...over }));
  put('noStart01', { hostStartedAt: null });
  put('wrongStart01', { hostStartedAt: '116444736000000000' });
  fs.writeFileSync(path.join(OCC_DIR, 'broken01.json'), '{ not a claim');
  await sleep(14000);   // a full re-check passes
  const none = await stripTab(app, 'feat/a');
  check('9: a live pid with NO start time, with the WRONG one (a reused pid), and a malformed file: not shown', !!none && none.occupied === false, JSON.stringify(none));
  put('proven01', {});
  const proven = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    return t && t.occupied ? t : null;
  }, 25000);
  check('9: the same pid with its exact start time IS shown', !!proven, proven ? JSON.stringify(proven.tags) : 'not shown');
  for (const f of ['noStart01', 'wrongStart01', 'broken01', 'proven01']) { try { fs.unlinkSync(path.join(OCC_DIR, `${f}.json`)); } catch { /* gone */ } }

  // 10 ----------------------------------------------------------------------------
  hook(devPid, 'PreToolUse', editIn(featA, 'probeagent03', 'electron-pro'));
  const back = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    return t && t.occupied ? t : null;
  }, 20000);
  check('10: a new claim from the live launcher shows again', !!back);
  const killing = devPid;
  killPidTree(killing);            // the dev host's own PID, a host this probe's window started inside the temp project
  const dark = await waitFor(async () => {
    const t = await stripTab(app, 'feat/a');
    const o = await occState(app);
    return t && !t.occupied && o && o.ok && o.bar.bar.hidden ? true : null;
  }, 45000);
  let darkDetail = '';
  if (!dark) {
    const t = await stripTab(app, 'feat/a');
    const o = await occState(app);
    darkDetail = `strip ${JSON.stringify(t)} bar ${JSON.stringify(o && o.bar && o.bar.bar)} startTimes lists it: ${(await startTimes([killing])).has(killing)}; Get-Process says: ${spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${killing} -ErrorAction SilentlyContinue | ForEach-Object { 'HasExited=' + $_.HasExited }`], { encoding: 'utf8', windowsHide: true }).stdout.trim() || 'no such process'}`;
  }
  check('10: killing the launching host clears the strip and the bar on their own', !!dark, darkDetail);
  check('10: ...and the reader leaves the dead claim\'s file where it is', fs.existsSync(path.join(OCC_DIR, 'probeagent03.json')));
  await shoot(app, '5-after-kill');

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');     // kills the window and, via the cleanup above, every host it started
    console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
