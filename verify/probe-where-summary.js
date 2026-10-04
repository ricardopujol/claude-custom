'use strict';
/**
 * PROBE: the "where are we" summary (backlog #39 job 1, documentation/DESIGN_SLAVE_MODE_SUMMARY.md) in a REAL window
 * with REAL hosts and a FAKE Ollama. (re-runnable, about 4 minutes: the quiet period, the 30 s panel and the 60 s
 * retry are the design's own fixed constants and are waited out, not faked)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-where-summary.js        (exit 0 = every check held)
 *   WHERE_SUMMARY_PROBE_SHOTS=<dir>                                       also keep the screenshots there
 *   WHERE_SUMMARY_PROBE_STOP_AFTER=B                                      stop after phase B (a quick run, about a minute)
 *   WHERE_SUMMARY_PROBE_QUICK=1                                           skip phase A2's minute-long wait (for looping phase B)
 *
 * TOLERANCE (Miguel I6, PR #105): phase B waits up to 90 s for the OTHER tab's hover to carry its summary (40 s for the dev
 * tab's). Looped 22 times, that hover was missing at 40 s in 3 runs: one explained (Ollama was down at start, so the
 * host's first check failed and its job sat out the 60 s retry), two while other work was loading the machine (cause
 * unproven), then 12 clean runs in a row on a quiet machine.
 * Not reproduced on a quiet machine, so the window is the tolerance; a run that still misses it prints every tab's title
 * and looks at the page itself (see the diagnostic block after B3).
 *
 * The unit tests pin the decisions. No unit test can see a transcript flattened by a real host, a job queued behind a
 * GPU slot shared by two hosts, a summary travel host -> websocket -> page, the panel painted in the terminal bar,
 * or the strip's hover card. This runs the whole chain over a temp git project (develop, feat/a): each host's
 * session id comes from a real SessionStart hook event (through the native helper, as Claude Code's hooks do), its
 * transcript is a file in a temp "projects" folder, and Ollama is verify/lib/fake-ollama.js.
 *
 *   A  nothing to say: no summary, no panel
 *   A2 Ollama is down and no summary has EVER been made (Miguel I1): the tab's hover card says "Local summary off" and
 *      nothing else, and switching to an idle tab does NOT pop the bar up
 *   B  a transcript with new turns, after the 25 s quiet period, is summarised by the model, per tab
 *      1  both hosts ask, ONE AT A TIME (never two requests in flight: the GPU slot is shared across hosts)
 *      2  what the model was sent: the conversation only (the tool call, the tool result and the skill injection are
 *         NOT in it), the transcript first and the instruction last, llama3.2:3b, num_ctx 8192, keep_alive 5m
 *      3  the strip's hover card carries each tab's own summary under its name, labelled "local model", and the quiet
 *         period was honoured
 *   C  switching to a tab untouched for 10 minutes opens the panel at the left of the bar, in the prompt part's place:
 *      labelled "local model · llama3.2:3b · N min ago", three lines, a single row, never animated, readable (contrast)
 *   D  the first keystroke hides it; a tab just typed in does not open it when you switch back
 *   E  the other tab (never typed in) shows ITS summary, and it closes by itself after 30 seconds
 *   F0 Escape closes an auto-opened panel with the focus still in the terminal (Miguel S4)
 *   F  a click pins it open (past 30 s) and Escape inside the bar closes it
 *   G  Ollama stops answering: the last summary stays, DIMMED, with "Local summary off: Ollama isn't running", in the
 *      panel and on the hover card; nothing is sent to a server that isn't there
 *   H  Ollama comes back: within the minute the note clears and a new summary is made, with no typing
 *   I  READ-ONLY: the transcripts are byte-for-byte what the probe wrote, the project folders hold nothing new, the
 *      terminals never saw a summary, only Ollama's three endpoints were asked, the slot is released
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* not passed on purpose are deleted; registry, portraits, uploads, summaries, transcripts and user data
 * are temp folders; Ollama is a fake on a loopback port (the real one is never touched); the project is a temp git
 * repo. The only processes killed are hosts whose folder is inside the probe's temp folder and the window it started,
 * by PID: never by name.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const HELPER = path.join(HARNESS_DIR, 'hook-helper.exe');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { startFakeOllama } = require('./lib/fake-ollama');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const { projectDirName } = require(path.join(ROOT, 'host', 'project-dir'));
const { INSTRUCTION } = require(path.join(ROOT, 'host', 'summary-text'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);       // nothing here is ever suspended
hygiene.install();                      // Ctrl+C and a crash still clean up
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-sum-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const userData = path.join(tmp, 'user-data');
const projectsDir = path.join(tmp, 'projects');
const summaryDir = path.join(tmp, 'summaries');
const shots = process.env.WHERE_SUMMARY_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(projectsDir, { recursive: true });

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
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS',
  'CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_SUMMARY_DIR', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_SUMMARY_POWER'];

async function launchApp(cwd, ollamaUrl) {
  const port = await freePort();
  const token = crypto.randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_OLLAMA_URL: ollamaUrl,
    CLAUDE_CUSTOM_SUMMARY_DIR: summaryDir,
    CLAUDE_CUSTOM_GIT_PROJECTS_DIR: projectsDir,
    CLAUDE_CUSTOM_SUMMARY_POWER: 'mains',            // the probe must not depend on whether this laptop is plugged in
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
const screenOf = async (app) => { const r = await view(app, 'gitScreen'); return r && r.ok ? String(r.text) : ''; };
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });
const allTitles = async (app) => {
  const st = await stateOf(app);
  return JSON.stringify((Array.isArray(st && st.stripOccupancy) ? st.stripOccupancy : []).map(t => [t.label, t.title]));
};
const stripTab = async (app, label) => {
  const st = await stateOf(app);
  return (Array.isArray(st && st.stripOccupancy) ? st.stripOccupancy : []).find(t => t.label === label) || null;
};
const selectTab = async (app, label) => {
  await command(app, { cmd: 'select', label });
  return waitFor(async () => {
    const st = await stateOf(app);
    return Array.isArray(st.stripDom) && st.stripDom.find(t => t.selected && t.label === label) ? true : null;
  }, 20000);
};
const calm = (s) => !!s && s.animation === 'none' && s.cardAnimation === 'none';

// --- the conversations the two sessions "had" -------------------------------------------------------------
const line = (type, uuid, content, extra = {}) => JSON.stringify({ type, uuid, message: { role: type, content }, ...extra });
const text = (t) => [{ type: 'text', text: t }];
const DEV_LINES = [
  line('user', 'd1', "let's make the drawer's hover card survive a redraw"),
  line('assistant', 'd2', text('I found it: the card is rebuilt on every poll. I will key it by tab.')),
  line('assistant', 'd3', [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\somewhere\\drawer.js' } }]),
  line('user', 'd4', [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOLRESULT-SECRET-CONTENT' }]),
  line('user', 'd5', 'Base directory for this skill: C:\\skills\\tdd\nSKILL-BODY-TEXT', { isMeta: true }),
  line('user', 'd6', 'yes, and add a test for it'),
  line('assistant', 'd7', text('Done: DEV-MARKER the keyed card is in and its new test passes.')),
];
const FEAT_LINES = [
  line('user', 'f1', 'start the feat-a lane for the probe'),
  line('assistant', 'f2', text('FEATA-MARKER: the lane is set up and waiting for its first task.')),
];
const DEV_REPLY = "Working on: keeping the drawer's hover card open across redraws\nWhere it stands: the keyed card and its test are in\nNext: review and merge";
const FEAT_REPLY = 'Working on: the feat-a probe lane\nWhere it stands: set up, nothing built yet\nNext: wait for its first task';
const OFF_NOTE = "Local summary off: Ollama isn't running";

const contrast = (rgbA, rgbB) => {
  const lum = (s) => { const [r, g, b] = (s.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number).map(c => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [hi, lo] = [lum(rgbA), lum(rgbB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', '-b', 'feat/a', featA);
  if (!fs.existsSync(HELPER)) { check('the native hook helper exists (.harness/hook-helper.exe)', false, HELPER); return; }

  // The fake Ollama answers by who is asking (the dev conversation or feat-a's), slowly enough that two jobs would overlap.
  let inFlight = 0;
  let maxInFlight = 0;
  // Ollama starts DOWN (GET / answers 500): phase A2 needs a host that has never made a summary, with Ollama off.
  const fake = await startFakeOllama({
    rootStatus: process.env.WHERE_SUMMARY_PROBE_QUICK === '1' ? 200 : 500,
    generate: (body) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight -= 1; }, 1200);
      const feat = typeof body.prompt === 'string' && body.prompt.includes('FEATA-MARKER');
      return { delayMs: 1200, json: { response: feat ? FEAT_REPLY : DEV_REPLY, done: true } };
    },
  });
  hygiene.addCleanup(() => { try { fake.close(); } catch { /* closed */ } });

  const app = await launchApp(container, fake.url);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the window is up and the dev host is running', !!devHost, devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(1500);   // its hook bridge binds a moment after its identity is written
  await command(app, { cmd: 'select', label: 'feat/a' });
  const featHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'feat/a' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the other tab\'s host is running', !!featHost, featHost ? `pid ${featHost.pid}` : '');
  if (!featHost) return;
  await sleep(1500);
  check('0: back on the dev tab', !!(await selectTab(app, 'develop')));

  // A -----------------------------------------------------------------------------
  const first = await waitFor(() => barState(app), 15000);
  const t0 = await stripTab(app, 'develop');
  check('A: nothing to say: no summary, no panel', !!first && first.bar.hidden === true && first.bar.summary.hidden === true
    && first.bar.summary.cardHidden === true && !!t0, JSON.stringify([first && first.bar.summary.hidden, t0 && t0.title]));

  // A2 ----------------------------------------------------------------------------
  if (process.env.WHERE_SUMMARY_PROBE_QUICK !== '1') {
    const offOnly = await waitFor(async () => { const t = await stripTab(app, 'develop'); return t && t.title === `develop\n${OFF_NOTE}` ? t : null; }, 30000);
    check('A2: Ollama is down and nothing was ever summarised: the hover card says so, alone', !!offOnly, await allTitles(app));
    await selectTab(app, 'feat/a');
    await selectTab(app, 'develop');
    await sleep(2000);
    const stillQuiet = await barState(app);
    check('A2: ...and switching to an idle tab does NOT pop the bar up for it', !!stillQuiet && stillQuiet.bar.hidden === true && stillQuiet.bar.summary.hidden === true,
      JSON.stringify(stillQuiet && stillQuiet.bar.summary));
    fake.set({ rootStatus: 200 });                                    // Ollama comes up; the hosts notice within their minute
    await sleep(62000);
  } else {
    fake.set({ rootStatus: 200 });
  }

  // B -----------------------------------------------------------------------------
  const transcripts = {
    dev: path.join(projectsDir, projectDirName(devHost.cwd), 'sum-probe-dev.jsonl'),
    feat: path.join(projectsDir, projectDirName(featHost.cwd), 'sum-probe-feat.jsonl'),
  };
  for (const f of Object.values(transcripts)) fs.mkdirSync(path.dirname(f), { recursive: true });
  check('B: each host learns its session id from a real SessionStart hook event',
    hook(devHost.pid, 'SessionStart', { session_id: 'sum-probe-dev', source: 'startup' })
    && hook(featHost.pid, 'SessionStart', { session_id: 'sum-probe-feat', source: 'startup' }));
  await sleep(500);
  const written = {
    dev: DEV_LINES.join('\n') + '\n',
    feat: FEAT_LINES.join('\n') + '\n',
  };
  const wroteAt = Date.now();
  fs.writeFileSync(transcripts.dev, written.dev);
  fs.writeFileSync(transcripts.feat, written.feat);

  const asked = await waitFor(() => (fake.count('POST', '/api/generate') >= 2 ? true : null), 120000, 500);
  check('B1: both hosts ask the model once the quiet period has passed', !!asked, `generate calls: ${fake.count('POST', '/api/generate')}`);
  const gens = fake.requests.filter(r => r.method === 'POST' && r.path === '/api/generate');
  const firstAt = gens.length ? gens[0].at : 0;
  check('B3: ...and not before the 25 s quiet period (first request ' + Math.round((firstAt - wroteAt) / 1000) + ' s after the transcript appeared)', gens.length > 0 && firstAt - wroteAt >= 24000);
  check('B1: ONE AT A TIME: never two requests in flight, although two hosts wanted the GPU at once', maxInFlight === 1, `max in flight ${maxInFlight}`);
  const devReq = gens.find(r => r.body && !String(r.body.prompt).includes('FEATA-MARKER'));
  const prompt = devReq ? String(devReq.body.prompt) : '';
  check('B2: the model was sent the conversation: the person\'s and Claude\'s words, in order', prompt.startsWith("User: let's make the drawer's hover card survive a redraw\n\nAssistant: I found it")
    && prompt.includes('User: yes, and add a test for it') && prompt.includes('DEV-MARKER'), JSON.stringify(prompt.slice(0, 120)));
  check('B2: ...and NOT the tool call, the tool result or the skill injection',
    !/TOOLRESULT-SECRET-CONTENT|Base directory for this skill|SKILL-BODY-TEXT|drawer\.js|tool_use|tool_result/.test(prompt));
  check('B2: ...the instruction comes AFTER the transcript', prompt.endsWith(INSTRUCTION) && prompt.indexOf('DEV-MARKER') < prompt.indexOf(INSTRUCTION));
  check('B2: llama3.2:3b, num_ctx 8192, keep_alive 5m, not streamed', !!devReq && devReq.body.model === 'llama3.2:3b' && devReq.body.options.num_ctx === 8192
    && devReq.body.keep_alive === '5m' && devReq.body.stream === false, JSON.stringify(devReq && { m: devReq.body.model, o: devReq.body.options, k: devReq.body.keep_alive }));
  const hoverOf = async (label, wanted, ms = 40000) => waitFor(async () => {
    const t = await stripTab(app, label);
    return t && t.title.includes(wanted) ? t : null;
  }, ms);
  const devHover = await hoverOf('develop', 'keeping the drawer');
  if (!devHover) console.log('      develop hover not seen; every tab\'s title now: ' + await allTitles(app));
  const featHover = await hoverOf('feat/a', 'feat-a probe lane', 90000);
  check('B3: the strip\'s hover card carries the dev tab\'s summary under its name, labelled as a local model',
    !!devHover && /^develop\nWhere we're at \(local model · llama3\.2:3b · (just now|\d+ min ago)\):\nWorking on: keeping the drawer's hover card open across redraws\nWhere it stands: .+\nNext: review and merge$/.test(devHover.title),
    JSON.stringify(devHover && devHover.title));
  check('B3: ...and the other tab\'s own summary, not the dev tab\'s', !!featHover && featHover.title.includes('feat-a probe lane') && !featHover.title.includes('drawer'),
    featHover ? JSON.stringify(featHover.title) : await allTitles(app));
  if (!featHover) {
    // Not a check: where is the summary the strip is missing? Waits longer, then looks at the page itself.
    const late = await hoverOf('feat/a', 'feat-a probe lane').catch(() => null);
    console.log('      feat/a hover after a further 40 s: ' + (late ? 'PRESENT' : 'still absent'));
    await selectTab(app, 'feat/a');
    await sleep(1500);
    const there = await barState(app);
    console.log('      selecting feat/a: its page has the summary: ' + !!(there && there.bar.summary.hidden === false) + '; title now: ' + JSON.stringify((await stripTab(app, 'feat/a') || {}).title));
    await selectTab(app, 'develop');
  }
  const afterB = await barState(app);
  check('B: a summary arriving while you look at the tab does NOT pop the panel open (only a switch does)', !!afterB && afterB.bar.hidden === true && afterB.bar.summary.hidden === true);
  if (process.env.WHERE_SUMMARY_PROBE_STOP_AFTER === 'B') { await command(app, { cmd: 'quit' }); await fake.close(); return; }

  // C -----------------------------------------------------------------------------
  await selectTab(app, 'feat/a');
  await selectTab(app, 'develop');
  const open = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === false ? b : null; }, 8000);
  const s = open && open.bar.summary;
  check('C: switching to the tab (untouched for over 10 minutes: nothing typed in it this run) opens the panel', !!open, JSON.stringify(await barState(app) && (await barState(app)).bar.summary));
  if (open) {
    check('C: ...labelled "local model · llama3.2:3b · N min ago", never as Claude\'s words', /^local model · llama3\.2:3b · (just now|\d+ min ago)$/.test(s.label), s.label);
    check('C: ...the three lines the model wrote, no note', JSON.stringify(s.lines) === JSON.stringify(DEV_REPLY.split('\n')) && s.note === null && s.dim === false, JSON.stringify(s));
    check('C: ...in the prompt part\'s place at the left: one bar row, the card under it, nothing animated', open.bar.height > 0 && open.bar.height < 60
      && s.cardTop >= open.bar.top + open.bar.height && open.bar.prompt.hidden === true && calm(s) && s.expanded === 'true',
    JSON.stringify({ barTop: open.bar.top, barHeight: open.bar.height, cardTop: s.cardTop, cardHeight: s.cardHeight, prompt: open.bar.prompt.hidden, anim: [s.animation, s.cardAnimation] }));
    const ratio = contrast(s.color, s.background);
    check(`C: ...readable: contrast ${ratio.toFixed(1)}:1 (at least 4.5)`, ratio >= 4.5, `${s.color} on ${s.background}`);
    await sleep(300);
    await shoot(app, '1-switch-to-idle-tab');
  }

  // D -----------------------------------------------------------------------------
  await command(app, { cmd: 'key', key: 'a' });
  const hidden = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === true && b.bar.hidden === true ? b : null; }, 6000);
  check('D: the first keystroke hides it (and the bar with it: nothing else to say)', !!hidden);
  await selectTab(app, 'feat/a');
  await selectTab(app, 'develop');
  await sleep(1500);
  const touched = await barState(app);
  check('D: a tab you have just typed in does NOT open it when you come back (not untouched for 10 minutes)', !!touched && touched.bar.summary.hidden === true);

  // E -----------------------------------------------------------------------------
  await selectTab(app, 'feat/a');
  const featOpen = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === false ? b : null; }, 8000);
  check('E: the other tab (never typed in) shows ITS OWN summary when you switch to it', !!featOpen && JSON.stringify(featOpen.bar.summary.lines) === JSON.stringify(FEAT_REPLY.split('\n')),
    JSON.stringify(featOpen && featOpen.bar.summary.lines));
  await sleep(300);
  await shoot(app, '2-other-tab');
  const shownAt = Date.now();
  const still = await (async () => { await sleep(26000); return barState(app); })();
  check('E: ...still there after 26 seconds', !!still && still.bar.summary.hidden === false);
  const gone = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === true ? b : null; }, 12000, 500);
  const openFor = (Date.now() - shownAt) / 1000;
  check(`E: ...and closes by itself at 30 seconds, with no key pressed (open for ${openFor.toFixed(0)} s)`, !!gone && openFor >= 29 && openFor <= 40);

  // F0 ----------------------------------------------------------------------------
  await selectTab(app, 'develop');
  await selectTab(app, 'feat/a');
  const escOpen = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === false ? b : null; }, 8000);
  await command(app, { cmd: 'key', key: 'Escape' });
  const escClosed = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === true && b.bar.summary.expanded === 'false' ? b : null; }, 5000);
  check('F0: Escape closes an auto-opened panel although the focus is in the terminal, not the bar', !!escOpen && !!escClosed);

  // F -----------------------------------------------------------------------------
  await selectTab(app, 'develop');
  await selectTab(app, 'feat/a');
  const again = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === false ? b : null; }, 8000);
  check('F: switching again opens it again', !!again);
  const clicked = await view(app, 'barClick', { target: 'summary' });
  const pinned = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.expanded === 'true' ? b : null; }, 5000);
  check('F: a click pins it open (aria-expanded true)', !!clicked.ok && !!pinned, JSON.stringify(clicked));
  await sleep(33000);
  const afterPin = await barState(app);
  check('F: ...it is still open after 33 seconds', !!afterPin && afterPin.bar.summary.hidden === false);
  await command(app, { cmd: 'key', key: 'Escape' });
  const closed = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === true && b.bar.summary.expanded === 'false' ? b : null; }, 6000);
  check('F: Escape inside the bar closes it, and aria-expanded follows', !!closed);

  // G -----------------------------------------------------------------------------
  const generatesBefore = fake.count('POST', '/api/generate');
  fake.set({ rootStatus: 500 });                               // "Ollama is not running": GET / no longer says so
  fs.appendFileSync(transcripts.dev, line('user', 'd8', 'now update the docs for it too') + '\n');
  fs.appendFileSync(transcripts.feat, line('user', 'f3', 'and write the first task down') + '\n');
  const downHover = await hoverOf('develop', OFF_NOTE).then(t => t, () => null);
  const downHover2 = downHover || await waitFor(async () => { const t = await stripTab(app, 'develop'); return t && t.title.includes(OFF_NOTE) ? t : null; }, 150000, 1000);
  check('G: with Ollama not answering, the hover card keeps the last summary AND says "Local summary off: Ollama isn\'t running"', !!downHover2
    && downHover2.title.includes("keeping the drawer's hover card") && downHover2.title.endsWith(OFF_NOTE), JSON.stringify(downHover2 && downHover2.title));
  await selectTab(app, 'develop');
  await selectTab(app, 'feat/a');
  const downPanel = await waitFor(async () => { const b = await barState(app); return b && b.bar.summary.hidden === false && b.bar.summary.note !== null ? b : null; }, 10000);
  const dp = downPanel && downPanel.bar.summary;
  check('G: the panel shows the last summary DIMMED, with the note beside it (never a silent empty state)', !!dp && dp.dim === true && dp.note === OFF_NOTE
    && JSON.stringify(dp.lines) === JSON.stringify(FEAT_REPLY.split('\n')) && /^local model/.test(dp.label), JSON.stringify(dp));
  if (dp) {
    const ratio = contrast(dp.color, dp.background);
    check(`G: ...and the dimmed words still read: contrast ${ratio.toFixed(1)}:1 (at least 3, a deliberate dim)`, ratio >= 3, `${dp.color} on ${dp.background}`);
  }
  await sleep(300);
  await shoot(app, '3-ollama-off');
  check('G: nothing was sent to a model that is not there (no new generate request)', fake.count('POST', '/api/generate') === generatesBefore, `before ${generatesBefore}, now ${fake.count('POST', '/api/generate')}`);

  // H -----------------------------------------------------------------------------
  fake.set({ rootStatus: 200 });                               // Ollama is back
  const savedOf = (name) => { try { return JSON.parse(fs.readFileSync(path.join(summaryDir, name), 'utf8')); } catch { return null; } };
  const settled = () => {
    const files = fs.existsSync(summaryDir) ? fs.readdirSync(summaryDir) : [];
    const d = savedOf('sum-probe-dev.json');
    const f = savedOf('sum-probe-feat.json');
    return d && f && d.newestKey === 'd8' && f.newestKey === 'f3' && !files.includes('.job.lock') ? { d, f } : null;
  };
  const recovered = await waitFor(async () => {
    const t = await stripTab(app, 'develop');
    return t && t.title.includes("keeping the drawer's hover card") && !t.title.includes(OFF_NOTE) && settled() ? t : null;
  }, 150000, 1000);
  check('H: Ollama is back: within the minute the note clears and NEW summaries are made (of the messages added while it was off), with no typing',
    !!recovered, JSON.stringify(recovered ? recovered.title : [settled(), await allTitles(app)]));
  await command(app, { cmd: 'key', key: 'Escape' });

  // I -----------------------------------------------------------------------------
  check('I: the dev transcript is exactly what the probe wrote (read-only)', fs.readFileSync(transcripts.dev, 'utf8') === written.dev + line('user', 'd8', 'now update the docs for it too') + '\n');
  check('I: ...and feat-a\'s', fs.readFileSync(transcripts.feat, 'utf8') === written.feat + line('user', 'f3', 'and write the first task down') + '\n');
  // The harness's own look folder (.claude-custom) is there from the host's start, whatever the summary does: what
  // matters is that no file in either project folder (outside .git) mentions a summary or holds its words.
  const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.name !== '.git')
    .flatMap(e => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const projectFiles = [...filesUnder(dev), ...filesUnder(featA)];
  check('I: no file in either project folder is a summary or holds its words', projectFiles.every(f => !/summar/i.test(path.basename(f))
    && !/keeping the drawer|feat-a probe lane|Working on:/.test(fs.readFileSync(f, 'utf8'))), JSON.stringify(projectFiles.map(f => path.relative(container, f))));
  const devScreen = await screenOf(app);
  check('I: the terminal never saw a summary: nothing was typed into the session', !/keeping the drawer|Working on:/.test(devScreen));
  await selectTab(app, 'feat/a');
  const featScreen = await screenOf(app);
  check('I: ...nor did feat-a\'s', !/feat-a probe lane|Working on:/.test(featScreen));
  const files = fs.existsSync(summaryDir) ? fs.readdirSync(summaryDir).sort() : [];
  check('I: each session\'s summary is on disk, and the GPU slot was released', JSON.stringify(files) === JSON.stringify(['sum-probe-dev.json', 'sum-probe-feat.json']), JSON.stringify(files));
  const saved = savedOf('sum-probe-dev.json');
  check('I: ...with its words, model, time and the newest message it was built from', !!saved && saved.model === 'llama3.2:3b' && typeof saved.at === 'number' && saved.newestKey === 'd8' && saved.text.includes('Working on:'), JSON.stringify(saved));
  const paths = new Set(fake.requests.map(r => r.method + ' ' + r.path));
  check('I: only Ollama\'s three endpoints were asked, and nothing was pulled', [...paths].every(p => ['GET /', 'GET /api/tags', 'POST /api/generate'].includes(p)), JSON.stringify([...paths]));

  await command(app, { cmd: 'quit' });
  await fake.close();
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');     // kills the window and, via the cleanup above, every host it started
    console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
