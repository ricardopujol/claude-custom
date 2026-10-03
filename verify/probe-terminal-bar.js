'use strict';
/**
 * PROBE: the terminal bar (backlog #49 last prompt + #52 bedtime night, #47's banner folded in as a chip;
 * documentation/DESIGN_TERMINAL_BAR.md) in a REAL window with REAL hosts. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-terminal-bar.js        (exit 0 = every check held)
 *   TERMINAL_BAR_PROBE_SHOTS=<dir>                                       also keep the screenshots there
 *
 * The unit tests pin the decisions. No unit test can see xterm's buffer scroll a prompt off the top, the bar
 * appear over a real terminal, a real hook event travel helper -> pipe -> host -> websocket -> page, or the strip
 * paint a night tab. This runs the whole chain over a temp git project (develop, feat/a): real hook events are
 * delivered to a host's pipe through the native helper, exactly what Claude Code's hooks do, and the terminal's
 * output is a real cmd.exe session.
 *
 *   A  nothing to say: the bar is absent
 *   B  #49, the last prompt
 *      1  a prompt event is kept by the host and anchored in the buffer; while it is still on screen the bar stays absent
 *      2  enough output to scroll it off the top: the bar shows the FIRST LINE, its age, and the whole text on click
 *      3  scrolling back to it hides the bar, scrolling down shows it again
 *      4  a slash command shows as typed; a pasted image reads [image]; a subagent's prompt never counts
 *      5  FAILS VISIBLE: an erased scrollback (what /clear sends) and a window that attached later show the prompt
 *         even though it is on screen
 *   C  #52, the bedtime night
 *      6  a bedtime ScheduleWakeup starts it: the moon chip with the next wake (the CLI's own scheduledFor) and
 *         "PRs: ?" (the temp repo has no GitHub: unknown, never 0); the dev tab turns night-blue with a moon, the
 *         other tab does not; a poll (ScheduleWakeup that doesn't name bedtime) changes nothing
 *      7  focus mode hides the bar
 *      8  the first keystroke is held behind "An overnight run is going. Type anyway?"; Type releases it once
 *      9  a wake (the scheduled prompt replayed) reads "working"; the prompt it replayed is the last prompt
 *      10 the other tab, with a night AND an agent working in it: ONE bar, two chips on one row
 *      11 ScheduleWakeup { stop: true } clears the chip and the night tab
 *   The bar never animates (computed animation none, transition 0s) in any of these states.
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* not passed on purpose are deleted; registry, portraits, uploads and user data are temp folders; the
 * project is a temp git repo. The only processes killed are hosts whose folder is inside the probe's temp folder
 * and the window it started, by PID: never by name.
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
const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);       // nothing here is ever suspended
hygiene.install();                      // Ctrl+C and a crash still clean up
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-bar-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const shots = process.env.TERMINAL_BAR_PROBE_SHOTS || path.join(tmp, 'shots');
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

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
  return st;
};
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const barState = async (app) => { const r = await view(app, 'barState'); return r && r.ok ? r : null; };
const occState = (app) => view(app, 'occState');
const screenOf = async (app) => { const r = await view(app, 'gitScreen'); return r && r.ok ? String(r.text) : ''; };
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });
const stripTabs = async (app) => {
  const st = await stateOf(app);
  return Array.isArray(st && st.stripOccupancy) ? st.stripOccupancy : [];
};
const stripTab = async (app, label) => (await stripTabs(app)).find(t => t.label === label) || null;
const typeInto = (app, text) => view(app, 'gitTermInput', { data: text });
const clockText = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// The prompts the person "types", and the loop the night schedules.
const P1 = "fix the drawer's hover card so a redraw never closes it\nand keep the focus ring on the first row";
const P1_HEAD = "fix the drawer's hover card so a redraw never closes it";
const NIGHT_PROMPT = '/bedtime overnight run (terminal-bar probe). Continue the task list.';
const SUB = (id) => ({ session_id: 'probe', agent_id: id, agent_type: 'electron-pro' });
const submit = (pid, prompt, extra = {}) => hook(pid, 'UserPromptSubmit', { session_id: 'probe', prompt, ...extra });
const schedule = (pid, prompt, delaySeconds, scheduledFor) => {
  const input = { delaySeconds, reason: 'probe', prompt, noop: false };
  hook(pid, 'PreToolUse', { session_id: 'probe', tool_name: 'ScheduleWakeup', tool_input: input });
  hook(pid, 'PostToolUse', { session_id: 'probe', tool_name: 'ScheduleWakeup', tool_input: input,
    tool_response: { scheduledFor, clampedDelaySeconds: delaySeconds, wasClamped: false } });
};
const stopLoop = (pid) => hook(pid, 'PreToolUse', { session_id: 'probe', tool_name: 'ScheduleWakeup', tool_input: { stop: true } });
const flood = (app, n) => typeInto(app, `for /L %i in (1,1,${n}) do @echo bar line %i\r`);
const calm = (b) => !!b && b.bar.animation === 'none' && /^0s(, 0s)*$/.test(b.bar.transitionDuration || '0s');

async function main() {
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
  check('0: the window is up and the dev host is running', !!devHost,
    devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(1500);   // its hook bridge binds a moment after its identity is written
  const devPid = devHost.pid;

  // A -----------------------------------------------------------------------------
  const first = await waitFor(() => barState(app), 15000);
  check('A: nothing to say: the bar is absent, with no prompt and no night', !!first && first.bar.hidden === true && first.bar.chips.length === 0
    && first.prompt === null && first.bedtime === null, JSON.stringify(first && first.bar));

  // B1 ----------------------------------------------------------------------------
  check('B1: the prompt event is delivered', submit(devPid, P1));
  const anchored = await waitFor(async () => {
    const b = await barState(app);
    return b && b.prompt && b.prompt.text === P1 && b.anchor && b.anchor.seq === b.prompt.seq ? b : null;
  }, 15000);
  check('B1: the page holds the host\'s prompt and anchored it in the terminal buffer (baseY + cursorY)', !!anchored,
    anchored ? JSON.stringify(anchored.anchor) : JSON.stringify(await barState(app)));
  check('B1: ...and while it is still on screen the bar stays absent', !!anchored && anchored.bar.hidden === true && anchored.bar.open === false,
    anchored ? `viewportY ${anchored.buffer.viewportY} anchor line ${anchored.anchor.line}` : '');

  // B2 ----------------------------------------------------------------------------
  flood(app, 120);
  const away = await waitFor(async () => {
    const b = await barState(app);
    return b && b.bar.hidden === false && b.bar.prompt.hidden === false ? b : null;
  }, 25000);
  check('B2: enough output to scroll it off the top: the bar appears with the prompt part', !!away,
    away ? `viewportY ${away.buffer.viewportY} > anchor line ${away.anchor.line}` : JSON.stringify(await barState(app)));
  if (away) {
    check('B2: ...showing the FIRST LINE only, clipped by CSS, with its age', away.bar.prompt.text === P1_HEAD && /^· just now$|^· \d+ min ago$/.test(away.bar.prompt.age),
      JSON.stringify([away.bar.prompt.text, away.bar.prompt.age]));
    check('B2: ...a single row over the terminal, never animated, nothing else in it', away.bar.height > 0 && away.bar.height < 60 && away.bar.chips.length === 0 && calm(away),
      JSON.stringify({ height: away.bar.height, animation: away.bar.animation, transition: away.bar.transitionDuration }));
    check('B2: ...the whole text is held for the click, and closed until then', away.bar.prompt.full === P1 && away.bar.prompt.fullHidden === true);
  }
  await sleep(400);
  await shoot(app, '1-prompt-scrolled-away');
  const opened = await view(app, 'barClick', { target: 'prompt' });
  const full = await waitFor(async () => { const b = await barState(app); return b && b.bar.prompt.fullHidden === false ? b : null; }, 5000);
  check('B2: a click opens the whole prompt (both lines), and a second click closes it', !!opened.ok && !!full && full.bar.prompt.full === P1, JSON.stringify(opened));
  await shoot(app, '2-prompt-open');
  await view(app, 'barClick', { target: 'prompt' });
  const shut = await waitFor(async () => { const b = await barState(app); return b && b.bar.prompt.fullHidden === true ? b : null; }, 5000);
  check('B2: ...closed again', !!shut);

  // B3 ----------------------------------------------------------------------------
  await view(app, 'barScroll', { to: 'top' });
  const top = await waitFor(async () => { const b = await barState(app); return b && b.bar.hidden === true ? b : null; }, 8000);
  check('B3: scrolled back to the prompt: the bar hides', !!top, top ? `viewportY ${top.buffer.viewportY} <= anchor line ${top.anchor.line}` : JSON.stringify(await barState(app)));
  await view(app, 'barScroll', { to: 'bottom' });
  const down = await waitFor(async () => { const b = await barState(app); return b && b.bar.hidden === false && b.bar.prompt.hidden === false ? b : null; }, 8000);
  check('B3: ...and scrolled down again, it shows again', !!down);

  // B4 ----------------------------------------------------------------------------
  const lastPrompt = async (text) => waitFor(async () => {
    const b = await barState(app);
    return b && b.prompt && b.prompt.text === text && b.anchor ? b : null;
  }, 15000);
  submit(devPid, '/checkpoint');
  await lastPrompt('/checkpoint');
  flood(app, 120);
  const slash = await waitFor(async () => { const b = await barState(app); return b && !b.bar.hidden && b.bar.prompt.text === '/checkpoint' ? b : null; }, 25000);
  check('B4: a slash command shows as typed', !!slash, JSON.stringify(slash && slash.bar.prompt));
  submit(devPid, 'look at [Image #1] and [Image #2]');
  await lastPrompt('look at [Image #1] and [Image #2]');
  flood(app, 120);
  const image = await waitFor(async () => { const b = await barState(app); return b && !b.bar.hidden && b.bar.prompt.text === 'look at [image] and [image]' ? b : null; }, 25000);
  check('B4: pasted images read [image]', !!image, JSON.stringify(image && image.bar.prompt));
  submit(devPid, 'subagent words that are nobody\'s prompt', SUB('probesub01'));
  await sleep(1500);
  const sub = await barState(app);
  check('B4: a subagent\'s prompt event never counts', !!sub && sub.prompt.text === 'look at [Image #1] and [Image #2]', JSON.stringify(sub && sub.prompt));

  // B5 ----------------------------------------------------------------------------
  submit(devPid, 'a prompt that is on screen');
  await lastPrompt('a prompt that is on screen');
  const onScreen = await waitFor(async () => { const b = await barState(app); return b && b.bar.hidden === true ? b : null; }, 8000);
  check('B5: a fresh prompt sits on screen: the bar is absent', !!onScreen);
  const epoch0 = onScreen ? onScreen.epoch : -1;
  const cleared = await view(app, 'barClear');
  const visible = await waitFor(async () => { const b = await barState(app); return b && !b.bar.hidden && b.bar.prompt.hidden === false ? b : null; }, 8000);
  check('B5: FAILS VISIBLE: an erased scrollback (/clear\'s CSI 3 J) starts a new epoch and the prompt shows although it was on screen',
    !!cleared.ok && !!visible && visible.epoch > epoch0, visible ? `epoch ${epoch0} -> ${visible.epoch}` : JSON.stringify(await barState(app)));
  await view(app, 'reconnect', { blur: true });
  const late = await waitFor(async () => {
    const b = await barState(app);
    return b && b.prompt && b.prompt.text === 'a prompt that is on screen' && b.anchor === null && !b.bar.hidden ? b : null;
  }, 20000);
  check('B5: FAILS VISIBLE: a window that attaches later is told the prompt (hello) and shows it, with no anchor to hide it by', !!late,
    JSON.stringify(late ? late.anchor : await barState(app)));

  // C6 ----------------------------------------------------------------------------
  const wakeAt = Math.ceil((Date.now() + 1800_000) / 60_000) * 60_000;
  schedule(devPid, NIGHT_PROMPT, 1800, wakeAt);
  // The call's own estimate (call + delay) shows first; the result's scheduledFor, rounded by the CLI, replaces it a
  // moment later. The chip is read once it says the CLI's own answer.
  const wantShort = `🌙 overnight · next wake ${clockText(wakeAt)} · PRs: ?`;
  const night = await waitFor(async () => {
    const b = await barState(app);
    return b && b.bedtime && b.bar.chips.some(c => c.kind === 'bedtime' && c.short === wantShort) ? b : null;
  }, 20000);
  const chip = night && night.bar.chips.find(c => c.kind === 'bedtime');
  check('C6: a bedtime ScheduleWakeup starts the night: the moon chip with the CLI\'s own next wake and the PR count unknown ("PRs: ?", never 0)',
    !!chip && chip.short === wantShort, chip ? JSON.stringify(chip.short) : JSON.stringify(((await barState(app)) || { bar: { chips: [] } }).bar.chips.map(c => c.short)));
  check('C6: ...its hover says since when and that the count is unknown', !!chip && /overnight run since \d\d:\d\d/.test(chip.long) && /PRs so far: unknown/.test(chip.long), chip ? JSON.stringify(chip.long) : '');
  check('C6: ...one bar, one row, the night colour rule, never animated', !!night && night.bar.chips.length === 1 && night.bar.height < 60 && calm(night)
    && parseFloat(chip.leftRule) >= 3 && chip.animation === 'none', night ? JSON.stringify({ height: night.bar.height, rule: chip && chip.leftRule }) : '');
  const tabs = await waitFor(async () => {
    const all = await stripTabs(app);
    const d = all.find(t => t.label === 'develop');
    return d && d.night ? all : null;
  }, 15000);
  const devTab = tabs && tabs.find(t => t.label === 'develop');
  const otherTab = tabs && tabs.find(t => t.label === 'feat/a');
  check('C6: the dev tab turns night-blue with a moon, still, deep blue (#1a2350)', !!devTab && devTab.night && devTab.moon && devTab.bg === 'rgb(26, 35, 80)' && devTab.anim === 'none',
    JSON.stringify(devTab && { night: devTab.night, moon: devTab.moon, bg: devTab.bg, anim: devTab.anim }));
  check('C6: ...and the other tab does not', !!otherTab && otherTab.night === false && otherTab.moon === false, JSON.stringify(otherTab && { night: otherTab.night, moon: otherTab.moon }));
  await sleep(400);
  await shoot(app, '3-night');
  schedule(devPid, 'Check on the background test run', 90, Date.now() + 120_000);       // a poll: not bedtime
  await sleep(1500);
  const afterPoll = await barState(app);
  const pollChip = afterPoll && afterPoll.bar.chips.find(c => c.kind === 'bedtime');
  check('C6: a poll (a ScheduleWakeup that does not name bedtime) changes nothing', !!pollChip && pollChip.short === chip.short, pollChip ? pollChip.short : 'no chip');

  // C7 ----------------------------------------------------------------------------
  await command(app, { cmd: 'key', key: 'F', modifiers: ['control', 'shift'] });
  const inFocus = await waitFor(async () => { const b = await barState(app); return b && b.bar.display === 'none' ? b : null; }, 6000);
  check('C7: focus mode hides the bar, with the rest of the chrome', !!inFocus);
  await command(app, { cmd: 'key', key: 'F', modifiers: ['control', 'shift'] });
  const outFocus = await waitFor(async () => { const b = await barState(app); return b && b.bar.display !== 'none' ? b : null; }, 6000);
  check('C7: ...and it is back after', !!outFocus);

  // C8 ----------------------------------------------------------------------------
  await view(app, 'occKey', { data: 'zq1' });
  const asking = await waitFor(async () => {
    const o = await occState(app);
    return o && o.ok && !o.confirm.hidden ? o : null;
  }, 8000);
  check('C8: the first keystroke into a night is held behind the question, in its own words',
    !!asking && asking.confirm.text === 'An overnight run is going. Type anyway?', asking ? asking.confirm.text : 'no confirm');
  await sleep(800);
  check('C8: ...and the session has not seen it', !(await screenOf(app)).includes('zq1'));
  await shoot(app, '4-night-confirm');
  await view(app, 'occClick', { target: 'type' });
  const typed = await waitFor(async () => ((await screenOf(app)).includes('zq1') ? true : null), 10000);
  await view(app, 'occKey', { data: 'zq2' });
  const second = await waitFor(async () => ((await screenOf(app)).includes('zq2') ? true : null), 10000);
  const again = await occState(app);
  check('C8: Type releases it, and the same night is not asked again', !!typed && !!second && again.ok && again.confirm.hidden === true);

  // C9 ----------------------------------------------------------------------------
  hook(devPid, 'Stop', { session_id: 'probe' });
  await sleep(400);
  submit(devPid, NIGHT_PROMPT);                       // the CLI replays the scheduled prompt when it wakes
  const woke = await waitFor(async () => {
    const b = await barState(app);
    const c = b && b.bar.chips.find(x => x.kind === 'bedtime');
    return c && /^🌙 overnight · working · PRs: \?$/.test(c.short) ? b : null;
  }, 15000);
  check('C9: a wake (the scheduled prompt replayed) reads "working", with no next wake until it schedules again', !!woke,
    JSON.stringify(((await barState(app)) || { bar: { chips: [] } }).bar.chips.map(c => c.short)));
  check('C9: ...and the prompt it replayed is the last prompt', !!woke && woke.prompt.text === NIGHT_PROMPT);
  const nextAt = Math.ceil((Date.now() + 1500_000) / 60_000) * 60_000;
  schedule(devPid, NIGHT_PROMPT, 1500, nextAt);
  hook(devPid, 'Stop', { session_id: 'probe' });
  const rescheduled = await waitFor(async () => {
    const b = await barState(app);
    const c = b && b.bar.chips.find(x => x.kind === 'bedtime');
    return c && c.short.includes(`next wake ${clockText(nextAt)}`) && /1 wake so far/.test(c.long) ? b : null;
  }, 15000);
  check('C9: scheduling again shows the new wake and counts the one that came', !!rescheduled);

  // C10 ---------------------------------------------------------------------------
  const select = await command(app, { cmd: 'select', label: 'feat/a' });
  const featHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'feat/a' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('C10: the other tab\'s host is running', !!select.ok && !!featHost, featHost ? `pid ${featHost.pid}` : JSON.stringify(select));
  if (featHost) {
    await sleep(1500);
    const fAt = Math.ceil((Date.now() + 1800_000) / 60_000) * 60_000;
    schedule(featHost.pid, NIGHT_PROMPT, 1800, fAt);
    hook(devPid, 'PreToolUse', { ...SUB('probeagent01'), tool_name: 'Agent', tool_input: { subagent_type: 'electron-pro', description: 'probe' }, tool_use_id: 'toolu_probe1' });
    hook(devPid, 'PreToolUse', { ...SUB('probeagent01'), tool_name: 'Edit', tool_input: { file_path: path.join(featA, 'app', 'x.js') } });
    const both = await waitFor(async () => {
      const b = await barState(app);
      return b && b.bar.chips.length === 2 ? b : null;
    }, 25000);
    check('C10: a night AND an agent working in this folder: ONE bar, two chips (moon, then the initials)', !!both
      && both.bar.chips.map(c => c.kind).join() === 'bedtime,occupancy' && both.bar.chips[1].short === 'EP',
    JSON.stringify(both ? both.bar.chips.map(c => c.short) : await barState(app)));
    if (both) {
      check('C10: ...on one row, still, no prompt part when the prompt is on screen', both.bar.height < 60 && calm(both) && both.bar.prompt.hidden === true,
        JSON.stringify({ height: both.bar.height, promptHidden: both.bar.prompt.hidden }));
    }
    await view(app, 'occKey', { data: 'wq1' });
    const both2 = await waitFor(async () => {
      const o = await occState(app);
      return o && o.ok && !o.confirm.hidden ? o : null;
    }, 8000);
    check('C10: the question names both: the overnight run and the agent', !!both2 && both2.confirm.text === 'An overnight run is going. An agent is writing here. Type anyway?',
      both2 ? both2.confirm.text : 'no confirm');
    await sleep(300);
    await shoot(app, '5-night-and-agent');
    await view(app, 'occClick', { target: 'wait' });
    hook(devPid, 'SubagentStop', SUB('probeagent01'));
    stopLoop(featHost.pid);
    const quiet = await waitFor(async () => {
      const b = await barState(app);
      return b && b.bar.chips.length === 0 && b.bedtime === null ? b : null;
    }, 20000);
    check('C10: the agent stopping and the loop stopping clear both chips', !!quiet);
  }

  // C11 ---------------------------------------------------------------------------
  await command(app, { cmd: 'select', label: 'develop' });
  const backDev = await waitFor(async () => {
    const st = await stateOf(app);
    return Array.isArray(st.stripDom) && st.stripDom.find(t => t.selected && t.label === 'develop') ? true : null;
  }, 20000);
  check('C11: back on the dev tab, its night is still on (it is that session\'s, not the window\'s)', !!backDev && !!(await barState(app)).bedtime);
  stopLoop(devPid);
  const over = await waitFor(async () => {
    const b = await barState(app);
    const t = await stripTab(app, 'develop');
    return b && b.bedtime === null && b.bar.chips.length === 0 && t && !t.night && !t.moon ? { b, t } : null;
  }, 20000);
  check('C11: ScheduleWakeup { stop: true } clears the chip, the night and the tab\'s moon', !!over, JSON.stringify(over ? over.t : await stripTab(app, 'develop')));
  const overBar = over ? over.b : null;
  check('C11: ...and the bar is a bar of its own again: absent unless the prompt has scrolled away', !!overBar && (overBar.bar.hidden || overBar.bar.prompt.hidden === false));
  await shoot(app, '6-after-stop');

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
