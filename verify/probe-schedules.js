'use strict';
/**
 * PROBE: the Schedules panel (BACKLOG #119 A7) in a REAL window with REAL hosts. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-schedules.js        (exit 0 = every check held)
 *   SCHEDULES_PROBE_SHOTS=<dir>                                       also keep the screenshots there
 *
 * The unit tests pin the model (test/schedules*.test.js, test/cron-next.test.js). No unit test can see a real hook event travel
 * helper -> pipe -> host -> websocket -> page, two hosts sharing one file so a window lists the OTHER session's rows, the panel
 * drawn in a real window, or a click selecting another tab. This runs the chain over a temp git project (develop, feat/a), delivering
 * hook events through the native helper exactly as Claude Code's hooks do. The terminal behind each tab is cmd.exe.
 *
 *   A  nothing scheduled: the panel is open and says so, and the footer says Routines are cloud-side
 *   B  a ScheduleWakeup on the dev host: one row under "Next hour" with its minutes, prompt, reason and session; the rail icon
 *      carries the count; a second wakeup REPLACES it
 *   C  cron: CronCreate jobs are listed (a job due within the hour under "Next hour", a daily one under "Recurring" with its next run,
 *      an expression the matcher cannot read as "schedule: <raw>"), CronDelete removes one
 *   D  a /loop wakeup and a bedtime night on the OTHER host appear in THIS window's list (the hosts share one file), with the right kind
 *      chips; the night row carries "night since ..."
 *   E  a click on the other session's row selects its tab; a click on the footer link is only ever our own link
 *   F  ScheduleWakeup { stop: true } removes that session's wakeup row and the count falls
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* not
 * passed on purpose are deleted; registry, portraits, uploads and user data are temp folders; the project is a temp git repo. The
 * install-wide .harness/state/schedules.json of THIS worktree is emptied before and after (probe state only). The only processes killed
 * are hosts whose folder is inside the probe's temp folder and the window it started, by PID: never by name.
 */

const { spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const HELPER = path.join(HARNESS_DIR, 'hook-helper.exe');
const SCHEDULES_FILE = path.join(HARNESS_DIR, 'state', 'schedules.json');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-sched-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const shots = process.env.SCHEDULES_PROBE_SHOTS || path.join(tmp, 'shots');
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
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
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

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
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
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(() => { try { fs.rmSync(SCHEDULES_FILE, { force: true }); } catch { /* probe state only */ } });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true });

// What Claude Code's hook does: the native helper writes one event to the host's pipe.
function hook(hostPid, event, payload) {
  const r = spawnSync(HELPER, ['--pipe', `\\\\.\\pipe\\claude-custom-${hostPid}`, '--event', event],
    { input: JSON.stringify(payload), windowsHide: true });
  return r.status === 0;
}

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const panel = async (app) => { const r = await view(app, 'schedulesState'); return r && r.ok ? r : null; };
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });
const rowsOf = (p) => (p ? p.groups.flatMap(g => g.rows.map(r => ({ ...r, group: g.id }))) : []);
const clockText = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const S = (extra = {}) => ({ session_id: 'probe', ...extra });
const wake = (pid, prompt, delaySeconds, reason = 'probe') => {
  const scheduledFor = Math.ceil((Date.now() + delaySeconds * 1000) / 60_000) * 60_000;       // the CLI rounds to the minute
  const input = { delaySeconds, reason, prompt, noop: false };
  hook(pid, 'PreToolUse', S({ tool_name: 'ScheduleWakeup', tool_input: input }));
  hook(pid, 'PostToolUse', S({ tool_name: 'ScheduleWakeup', tool_input: input, tool_response: { scheduledFor, clampedDelaySeconds: delaySeconds, wasClamped: false } }));
  return scheduledFor;
};
const stop = (pid) => {
  hook(pid, 'PreToolUse', S({ tool_name: 'ScheduleWakeup', tool_input: { stop: true } }));
  hook(pid, 'PostToolUse', S({ tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: { stopped: true, cancelledWakeups: 1 } }));
};
const cronCreate = (pid, id, cron, prompt, recurring = true, human = null) => {
  const input = { cron, prompt, recurring, durable: false };
  hook(pid, 'PreToolUse', S({ tool_name: 'CronCreate', tool_input: input }));
  hook(pid, 'PostToolUse', S({ tool_name: 'CronCreate', tool_input: input, tool_response: { id, humanSchedule: human || cron, recurring, durable: false } }));
};
const cronDelete = (pid, id) => {
  hook(pid, 'PreToolUse', S({ tool_name: 'CronDelete', tool_input: { id } }));
  hook(pid, 'PostToolUse', S({ tool_name: 'CronDelete', tool_input: { id }, tool_response: { id } }));
};

async function main() {
  try { fs.rmSync(SCHEDULES_FILE, { force: true }); } catch { /* none yet */ }
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', '-b', 'feat/a', featA);
  if (!fs.existsSync(HELPER)) { check('the native hook helper exists (.harness/hook-helper.exe)', false, HELPER); return; }

  const app = await launchApp(container);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the window is up and the dev host is running', !!devHost, devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(1500);   // its hook bridge binds a moment after its identity is written
  const devPid = devHost.pid;

  // A -----------------------------------------------------------------------------
  await view(app, 'select', { id: 'schedules' });
  const first = await waitFor(async () => { const p = await panel(app); return p && p.shown ? p : null; }, 15000);
  check('A: the panel is open, its script loaded into the page\'s one scope', !!first && first.scope === true, JSON.stringify(first && { scope: first.scope, shown: first.shown }));
  check('A: nothing scheduled: it says so', !!first && first.empty === true && first.heads.length === 0, JSON.stringify(first && first.heads));
  check('A: ...and the footer says Routines are cloud-side, linking to claude.ai/code',
    !!first && /Routines on claude\.ai\/code run in the cloud and are not listed here\./.test(first.foot || '') && first.link === 'https://claude.ai/code', JSON.stringify(first && [first.foot, first.link]));
  check('A: ...no count on the rail icon', !!first && first.badge.every(b => b === null), JSON.stringify(first && first.badge));

  // B -----------------------------------------------------------------------------
  const at1 = wake(devPid, 'check the PRs and report', 1380, 'CI takes about 20 min');
  const b1 = await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).length === 1 ? p : null; }, 15000);
  const r1 = b1 && rowsOf(b1)[0];
  check('B: a ScheduleWakeup becomes one row under "Next hour"', !!r1 && r1.group === 'next-hour' && b1.heads.join() === 'Next hour', JSON.stringify(b1 && b1.groups));
  check('B: ...with its minutes, kind, prompt, reason and session', !!r1 && /^in (2[2-4]) min$/.test(r1.when) && r1.kind === 'wakeup' && r1.what === 'check the PRs and report'
    && r1.reason === 'CI takes about 20 min' && /develop/.test(r1.session || ''), JSON.stringify(r1));
  check('B: ...its hover is the full prompt and says the session owns the schedule', !!r1 && r1.title.startsWith('check the PRs and report') && /session owns its schedule/i.test(r1.title));
  check('B: ...the rail icon carries the count', !!b1 && b1.badge.length > 0 && b1.badge.every(b => b === '1') && b1.nextHour === 1, JSON.stringify(b1 && b1.badge));
  await sleep(300);
  await shoot(app, '1-one-wakeup');

  wake(devPid, 'second prompt replaces the first', 600, 'sooner');
  const b2 = await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).length === 1 && rowsOf(p)[0].what === 'second prompt replaces the first' ? p : null; }, 15000);
  check('B: a new wakeup REPLACES the session\'s previous one', !!b2 && /^in (9|10) min$/.test(rowsOf(b2)[0].when), JSON.stringify(b2 && rowsOf(b2)));

  // C -----------------------------------------------------------------------------
  cronCreate(devPid, 'job-10min', '*/10 * * * *', 'poll the deploy', true, 'Every 10 minutes');
  cronCreate(devPid, 'job-daily', '0 6 * * *', 'morning report', true, 'every day 06:00');
  cronCreate(devPid, 'job-weird', '0 9 * * MON', 'weekly thing', true);
  const c1 = await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).length === 4 ? p : null; }, 15000);
  const rows = rowsOf(c1);
  const ten = rows.find(r => r.id === 'job-10min');
  const daily = rows.find(r => r.id === 'job-daily');
  const weird = rows.find(r => r.id === 'job-weird');
  check('C: a cron job due within the hour is under "Next hour" with its computed time', !!ten && ten.group === 'next-hour' && /^in \d+ min$/.test(ten.when) && ten.kind === 'cron', JSON.stringify(ten));
  check('C: a daily job is under "Recurring" with its schedule and its next run', !!daily && daily.group === 'recurring' && daily.when === 'every day 06:00' && /^next (tomorrow )?06:00$/.test(daily.next || ''), JSON.stringify(daily));
  check('C: an expression the matcher cannot read says "schedule: <raw>" and shows no time', !!weird && weird.when === 'schedule: 0 9 * * MON' && weird.next === null, JSON.stringify(weird));
  const mins = (w) => (w === 'in <1 min' ? 0 : Number((/^in (d+) min$/.exec(w) || [])[1]));
  const nextHour = c1 && c1.groups.find(g => g.id === 'next-hour');
  check('C: groups appear in order (Next hour, then Recurring), soonest first inside Next hour', !!c1 && c1.heads.join() === 'Next hour,Recurring' && !!nextHour
    && nextHour.rows.length === 2 && mins(nextHour.rows[0].when) <= mins(nextHour.rows[1].when), JSON.stringify(c1 && c1.groups.map(g => [g.id, g.rows.map(r => [r.id, r.when])])));
  cronDelete(devPid, 'job-weird');
  const c2 = await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).length === 3 && !rowsOf(p).some(r => r.id === 'job-weird') ? p : null; }, 15000);
  check('C: CronDelete removes the job', !!c2);
  cronDelete(devPid, 'job-10min');
  cronDelete(devPid, 'job-daily');
  await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).length === 1 ? p : null; }, 15000);

  // D -----------------------------------------------------------------------------
  const select = await command(app, { cmd: 'select', label: 'feat/a' });
  const featHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'feat/a' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('D: the other tab\'s host is running', !!select.ok && !!featHost, featHost ? `pid ${featHost.pid}` : JSON.stringify(select));
  if (!featHost) return;
  await sleep(1500);
  await command(app, { cmd: 'select', label: 'develop' });
  await waitFor(async () => { const st = await stateOf(app); return Array.isArray(st.stripDom) && st.stripDom.find(t => t.selected && t.label === 'develop') ? true : null; }, 20000);
  const nightPrompt = '/bedtime overnight run (schedules probe). Continue the task list.';
  const nightAt = wake(featHost.pid, nightPrompt, 1800, 'next wake');
  const d1 = await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).some(r => r.kind === 'bedtime') ? p : null; }, 20000);
  const night = d1 && rowsOf(d1).find(r => r.kind === 'bedtime');
  check('D: the OTHER session\'s bedtime night is in THIS window\'s list (the hosts share one file)', !!night && /feat\/a/.test(night.session || '') && night.cwd !== null, JSON.stringify(night));
  check('D: ...as a bedtime row with its night detail and its wake time', !!night && /^night since \d\d:\d\d/.test(night.detail || '') && /^(in \d+ min|\d\d:\d\d)$/.test(night.when), JSON.stringify(night && [night.when, night.detail, clockText(nightAt)]));
  check('D: ...beside this session\'s own wakeup, each on its own session', !!d1 && new Set(rowsOf(d1).map(r => r.session)).size === 2, JSON.stringify(d1 && rowsOf(d1).map(r => r.session)));
  wake(devPid, '/loop 5m check the deploy', 300, 'loop poll');
  const d2 = await waitFor(async () => { const p = await panel(app); return p && rowsOf(p).some(r => r.kind === 'loop') ? p : null; }, 15000);
  check('D: a /loop wakeup is a loop row', !!d2 && rowsOf(d2).filter(r => r.kind === 'loop').length === 1, JSON.stringify(d2 && rowsOf(d2).map(r => [r.kind, r.what])));
  await sleep(300);
  await shoot(app, '2-two-sessions');

  // E -----------------------------------------------------------------------------
  const clicked = await view(app, 'schedulesClick', { id: night ? night.id : 'wakeup', key: night ? night.key : undefined });
  check('E: the row is clickable', !!clicked.ok, JSON.stringify(clicked));
  const onFeat = await waitFor(async () => {
    const st = await stateOf(app);
    return Array.isArray(st.stripDom) && st.stripDom.find(t => t.selected && t.label === 'feat/a') ? true : null;
  }, 20000);
  check('E: a click on the other session\'s row selects its tab', !!onFeat);
  await command(app, { cmd: 'select', label: 'develop' });
  await waitFor(async () => { const st = await stateOf(app); return Array.isArray(st.stripDom) && st.stripDom.find(t => t.selected && t.label === 'develop') ? true : null; }, 20000);

  // F -----------------------------------------------------------------------------
  stop(devPid);
  const f1 = await waitFor(async () => { const p = await panel(app); return p && !rowsOf(p).some(r => /develop/.test(r.session || '')) ? p : null; }, 15000);
  check('F: ScheduleWakeup { stop: true } removes that session\'s row and leaves the other session\'s night', !!f1 && rowsOf(f1).length === 1 && rowsOf(f1)[0].kind === 'bedtime', JSON.stringify(f1 && rowsOf(f1)));
  stop(featHost.pid);
  const f2 = await waitFor(async () => { const p = await panel(app); return p && p.empty === true ? p : null; }, 15000);
  check('F: ...and with both stopped the list is empty again and the count is gone', !!f2 && f2.badge.every(b => b === null), JSON.stringify(f2 && [f2.empty, f2.badge]));
  await shoot(app, '3-empty-again');

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
