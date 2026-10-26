'use strict';
/**
 * PROBE: the Map panel (BACKLOG #120) in a REAL window, and what it costs. (re-runnable; HEAVY: the launcher takes the machine-wide
 * heavy-work lock itself)
 *
 *   node verify/probe-activity-map.js [--reps=2] [--measure-ms=15000] [--png=<file.png>] [--out=<file.json>] [--no-cost] [--sweep] [--desync] [--look=dark|light|asis]
 *
 * ONE real window with two real hosts (the host's `claude` is cmd.exe, nothing bills), a TEMP git project. The panel is fed a FAKE
 * graph through the page's own probe hook (two sessions, six agents, one conflict claim), then:
 *
 *   A. WHAT IT DRAWS: nine nodes (the project, two sessions, six agents), one conflict edge named for the worktree, particles on the
 *      edges of the three WORKING agents and on no other edge, a bitmap sized in device pixels, a canvas that is not blank, a hover card
 *      for an agent and for the conflict edge, a wheel zoom and a Fit. A screenshot is written for a human to look at.
 *   B. THE FRAME-BUDGET RULE, in the page that matters: animating while shown x focused x not lean; one static frame (no loop, no
 *      particles) once the window loses focus; ZERO animation frames asked for in 5 s when the panel is hidden, and when lean mode is
 *      on; no particles under prefers-reduced-motion.
 *   C. THE COST (skipped with --no-cost): CPU % of one core per Electron process type, and the GPU engine, as a median with min..max over --reps
 *      rounds, next to the panel hidden (the baseline): ONE agent working (close to the price of presenting a frame at all), six agents at 33 ms and
 *      at the app's 50 ms gap, the 48-agent cap at 50 ms (the worst case), and shown but unfocused (the static frame). Every scenario rebuilds the
 *      panel first. --sweep adds 40 and 67 ms; --desync adds a low-latency (desynchronized) canvas. Also the frames the page asked for a second.
 *      WHAT IT FOUND (2026-10-20, Katana): a presented frame costs about 4 ms of CPU across the renderer and the GPU process whatever is drawn in
 *      it, so the cost is the frame rate, not the particle count: that is why the app's gap is 50 ms.
 *
 * HONEST LIMIT (as in probe-idle-redraw): a probe window is off screen with backgroundThrottling off and native occlusion tracking
 * off, so it paints like a window that is visible and uncovered. A covered window is cheaper in the real app.
 *
 * Electron is started ONLY through verify/lib/launch-electron.js; only the Electron tree and the hosts this probe started are stopped,
 * by PID. Nothing is stopped by name.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const idle = require('./probe-idle-redraw');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

// ---- the fake graph -----------------------------------------------------------------------------------------------------

const portrait = (name, hue) => ({ url: null, initials: name.slice(0, 2).toUpperCase(), hue });
const agent = (name, session, state, detail, o = {}) => ({ name, session, state, detail, portrait: portrait(name, (name.charCodeAt(0) * 37) % 360), model: 'opus', tokens: 120000, ...o });

/** Two sessions x three agents, one of each kind of state, and two agents claiming one worktree. */
function smallGraph(folderA, folderB, worktree) {
  return {
    op: 'fake',
    sessions: [
      { id: 'a', label: 'develop', state: 'working', self: true, folder: folderA },
      { id: 'b', label: 'feat/a', state: 'idle', self: false, folder: folderB },
    ],
    agents: [
      agent('dexter', 'a', 'working', 'writing', { eventsPerMin: 90, tool: 'Edit' }),
      agent('miguel', 'a', 'working', 'waiting'),
      agent('paris', 'a', 'happy', 'happy'),
      agent('mortimer', 'b', 'working', 'running', { eventsPerMin: 20 }),
      agent('murray', 'b', 'stressed', 'stressed'),
      agent('dewey', 'b', 'working', 'writing', { eventsPerMin: 30, tool: 'Edit' }),
    ],
    claims: [
      { agentId: 'i1', agent: 'dexter', worktree, also: [], lastAt: Date.now() - 20000, wroteAt: Date.now() - 20000 },
      { agentId: 'i2', agent: 'mortimer', worktree, also: [], lastAt: Date.now() - 4000, wroteAt: Date.now() - 4000 },
    ],
    lanes: { open: 3, withPr: 1 },
    feed: { events: 1834, uptimeMs: 7_380_000 },
    totalAgents: 9,
  };
}

/** The worst case: four sessions and the 48-agent cap, every agent working. */
function busyGraph(folders) {
  const sessions = folders.map((f, i) => ({ id: 's' + i, label: i === 0 ? 'develop' : 'feat/s' + i, state: 'working', self: i === 0, folder: f }));
  const agents = [];
  for (let i = 0; i < 48; i += 1) agents.push(agent('agent-' + String(i).padStart(2, '0'), 's' + (i % sessions.length), 'working', 'working', { eventsPerMin: 40 + (i % 5) * 10 }));
  return { op: 'fake', sessions, agents, claims: [], lanes: { open: 4, withPr: 2 }, feed: { events: 99999, uptimeMs: 3_600_000 }, totalAgents: 48 };
}

// ---- measuring ------------------------------------------------------------------------------------------------------------

function processTable() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  try { return JSON.parse(ps.stdout); } catch { throw new Error(`the process table was not JSON: ${String(ps.stderr || ps.stdout || '').slice(0, 200)}`); }
}
function sampleGpu(seconds) {
  const script = `$s = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 5 -MaxSamples ${Math.max(1, Math.floor(seconds / 5))} -ErrorAction SilentlyContinue; ` +
    `$s | ForEach-Object { $t = $_.Timestamp.Ticks; $_.CounterSamples | ForEach-Object { [pscustomobject]@{ at = $t; name = $_.InstanceName; value = $_.CookedValue } } } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let text = '';
    ps.stdout.on('data', (d) => { text += d; });
    ps.on('error', () => resolve(null));
    ps.on('exit', () => {
      try { const j = JSON.parse(text.trim() || '[]'); resolve(Array.isArray(j) ? j : [j]); } catch { resolve(null); }
    });
  });
}
function descendantPids(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p.ProcessId);
  }
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) || []) if (!out.includes(k)) out.push(k);
  return new Set(out);
}

let cleanup = () => {};

async function main() {
  const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));
  const { createHygieneRegistry } = require('./lib/process-hygiene');
  const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
  const hygiene = createHygieneRegistry();
  hygiene.install();
  const tmp = tmpDir('cc-probe-map-');
  const container = path.join(tmp, 'proj');
  const dev = path.join(container, 'dev');
  const featA = path.join(container, 'feat-a');
  const userData = path.join(tmp, 'user-data');
  const reps = Number(arg('reps', '2'));
  const measureMs = Number(arg('measure-ms', '15000'));
  const settleMs = Number(arg('settle-ms', '3000'));
  const pngFile = arg('png', path.join(HARNESS_DIR, 'activity-map.png'));
  const outFile = arg('out', path.join(HARNESS_DIR, 'activity-map.json'));
  const withCost = !flag('no-cost');

  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...a], { cwd, stdio: 'pipe', windowsHide: true });
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
    'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];
  const waitFor = async (fn, ms = 20000, step = 250) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v; try { v = await fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(step);
    }
  };

  const seenPids = require('./lib/seen-pids').createSeenPids();
  const killEverything = () => {
    let files = [];
    try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { /* none */ }
    const inside = path.resolve(tmp).toLowerCase() + path.sep;
    for (const f of files) {
      const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
      if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) seenPids.add(id.pid, id.processStartedAt);
    }
    seenPids.endAll();
  };
  hygiene.addCleanup(killEverything);
  cleanup = killEverything;

  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', featA, '-b', 'feat/a');

  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = { ...process.env, CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CUSTOM_CWD: container,
    CLAUDE_CUSTOM_TABS_PROBE: String(port), CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'), CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads') };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
  const app = { child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });

  const command = (cmd, timeoutMs = 30000) => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token }) + '\n'));
    sock.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } } });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
  const stateOf = async () => {
    const st = await command({ cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    return st;
  };
  const tabOf = (st, label) => (Array.isArray(st && st.stripDom) ? st.stripDom.find(t => t.label === label) || null : null);
  const mapState = async () => { const r = await command({ cmd: 'view', action: 'mapState', args: {} }); return r && r.ok ? r : null; };
  const mapDo = (args) => command({ cmd: 'view', action: 'mapDo', args });
  const leanOn = async () => { const r = await command({ cmd: 'view', action: 'leanState', args: {} }); return r && r.ok ? r.leanOn : null; };
  const setLean = async (on) => {
    if ((await leanOn()) !== on) await command({ cmd: 'strip-lean', button: on ? 'lean-btn' : 'lean-back' });
    return waitFor(async () => ((await leanOn()) === on ? true : null), 10000);
  };

  // ---- checks -----------------------------------------------------------------------------------------------------------
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); return !!ok; };

  // The window up, both tabs started, develop selected.
  if (!await waitFor(async () => (tabOf(await stateOf(), 'feat/a') ? true : null), 60000)) { console.log(`FAIL  the window did not come up\n${app.out.slice(-600)}`); return 1; }
  const pageUp = () => waitFor(async () => { const v = (await stateOf()).viewDom; return v && v.hasTerm === true && v.xterm > 0 ? true : null; }, 30000);
  for (const label of ['feat/a', 'develop']) {
    const r = await command({ cmd: 'select', label });
    if (!(r && r.ok && r.started && await pageUp())) { console.log(`FAIL  tab ${label} did not start\n${app.out.slice(-600)}`); return 1; }
  }
  await sleep(1500);
  await command({ cmd: 'windowFocus' });

  // The project's look is random (a new project rolls dark or light): pin it, so the picture and the particles' compositing are the same every run.
  const lookArg = arg('look', 'dark');
  if (lookArg === 'dark' || lookArg === 'light') {
    const accentBefore = (await mapState() || {}).accent;
    await command({ cmd: 'view', action: 'bgStyle', args: { action: 'set-mode', mode: lookArg } });
    await sleep(2500);
    console.log(`look pinned to ${lookArg} (accent ${accentBefore} -> ${(await mapState() || {}).accent})`);
  }

  // ---- A. what it draws --------------------------------------------------------------------------------------------------
  console.log(`machine ${os.hostname()}; dpr and window are the real ones`);
  const first = await mapState();
  check('the three Map scripts loaded into the one shared scope', first && first.scope === true);
  await command({ cmd: 'view', action: 'move', args: { id: 'map', target: 'right' } });
  const shown = await waitFor(async () => { const s = await mapState(); return s && s.shown && s.state.size.w > 0 ? s : null; }, 15000);
  check('the Map panel is docked and on screen', !!shown, shown ? { canvas: shown.canvas, accent: shown.accent } : undefined);
  if (!shown) { console.log(app.out.slice(-800)); return 1; }

  const folderA = dev; const folderB = featA; const worktree = path.join(container, 'feat-x');
  await mapDo(smallGraph(folderA, folderB, worktree));
  const drawn = await waitFor(async () => { const s = await mapState(); return s && s.state.particles > 0 ? s : null; }, 15000);
  check('particles are flowing', !!drawn, drawn ? { particles: drawn.state.particles, flows: drawn.state.flows } : undefined);
  const s1 = await mapState();
  const st = s1.state;
  check('nine nodes: the project, two sessions, six agents', st.nodes.length === 9, st.nodes.map(n => n.id));
  const kinds = (k) => st.nodes.filter(n => n.kind === k).length;
  check('...of the right kinds', kinds('project') === 1 && kinds('session') === 2 && kinds('agent') === 6);
  const conflict = st.edges.find(e => e.kind === 'conflict');
  check('one conflict edge, named for the worktree', st.conflicts === 1 && conflict && conflict.label === 'feat-x', conflict && conflict.label);
  const flowing = st.edges.filter(e => e.flow > 0).map(e => e.from).sort();
  check('only the three WORKING agents stream', JSON.stringify(flowing) === JSON.stringify(['agent:dewey', 'agent:dexter', 'agent:mortimer']), flowing);
  const particleEdges = st.particleEdges.map(id => st.edges.find(e => e.id === id)).filter(Boolean);
  check('every particle in flight is on a working agent\'s edge', st.particleEdges.length > 0 && particleEdges.length === st.particleEdges.length && particleEdges.every(e => e.state === 'working' && e.kind === 'tree' && /^agent:/.test(e.from)), st.particleEdges);
  check('the layout settled and is moving only for the streams', st.animating === true && st.looping === true);
  check('the strip says what the fake feed says', s1.strip.tasks === 'tasks 3 · 1 PR' && s1.strip.events === 'events 1.8k' && s1.strip.active === 'active 6 / 9' && /^this host up 2h 03m$/.test(s1.strip.uptime), s1.strip);
  check('the legend has the four states', JSON.stringify(s1.legend) === JSON.stringify(['running', 'needs you', 'done', 'idle']));
  check('the bitmap is sized in DEVICE pixels', s1.bitmap.w === Math.round(s1.canvas.width * s1.dpr) && s1.bitmap.h === Math.round(s1.canvas.height * s1.dpr), { dpr: s1.dpr, css: [s1.canvas.width, s1.canvas.height], bitmap: [s1.bitmap.w, s1.bitmap.h] });
  check('the canvas is not blank (sampled pixels that differ clearly from the background)', s1.colours >= 20, s1.colours);

  await mapDo({ op: 'hover', id: 'agent:dexter' });
  const hov = await mapState();
  check('hovering an agent shows its card (model, tokens, tool)', hov.card.hidden === false && hov.card.title === 'dexter' && hov.card.lines.includes('model: opus') && hov.card.lines.includes('tool: Edit'), hov.card);
  await mapDo({ op: 'edge', id: conflict.id });
  const hov2 = await mapState();
  check('hovering the conflict edge names both claims', hov2.card.hidden === false && hov2.card.title === 'Conflict · feat-x' && hov2.card.lines.length === 2, hov2.card);
  // R1: the same two agents on the same worktree, but their claims carry no `wroteAt`: two READERS. No edge, whatever the mood.
  const readers = smallGraph(folderA, folderB, worktree);
  readers.claims = readers.claims.map(({ wroteAt, ...c }) => c);
  await mapDo(readers);
  const rs = await waitFor(async () => { const x = await mapState(); return x && x.state.conflicts === 0 ? x : null; }, 5000) || await mapState();   // the page's rebuild is coalesced to the next frame
  check('R1: two readers on one worktree make no conflict edge', rs.state.conflicts === 0 && !rs.state.edges.some(e => e.kind === 'conflict'), rs.state.conflicts);
  await mapDo(smallGraph(folderA, folderB, worktree));
  const ws = await waitFor(async () => { const x = await mapState(); return x && x.state.conflicts === 1 ? x : null; }, 5000) || await mapState();
  check('R1: two writers on one worktree make one', ws.state.conflicts === 1, ws.state.conflicts);
  const z0 = (await mapState()).state.zoom;
  await mapDo({ op: 'wheel', x: 200, y: 150, deltaY: -400 });
  const z1 = (await mapState());
  check('the wheel zooms (and the strip shows it)', z1.state.zoom > z0 && /^\d+%$/.test(z1.strip.zoom), { before: z0, after: z1.state.zoom, label: z1.strip.zoom });
  await mapDo({ op: 'fit' });
  const z2 = await mapState();
  const v = z2.state.view;
  const onScreen = z2.state.nodes.every(n => n.x * v.k + v.x - n.r * v.k >= -1 && n.x * v.k + v.x + n.r * v.k <= z2.canvas.width + 1 && n.y * v.k + v.y - n.r * v.k >= -1 && n.y * v.k + v.y + n.r * v.k <= z2.canvas.height + 1);
  check('Fit puts every node on screen', onScreen && !z2.state.userView, { view: v, canvas: [z2.canvas.width, z2.canvas.height] });

  fs.mkdirSync(path.dirname(pngFile), { recursive: true });
  await mapDo({ op: 'hover', id: 'agent:dewey' });
  await sleep(600);
  const shot = await command({ cmd: 'screenshot', file: pngFile });
  check('a screenshot was written', shot && shot.ok && fs.existsSync(pngFile) && fs.statSync(pngFile).size > 5000, pngFile);

  // ---- B. the frame-budget rule --------------------------------------------------------------------------------------------
  const rafsOver = async (ms) => { const a = await mapState(); await sleep(ms); const b = await mapState(); return { rafs: b.rafs - a.rafs, frames: b.state.frames - a.state.frames }; };
  await mapDo({ op: 'leave' });
  const live = await rafsOver(3000);
  check('ANIMATING: the loop runs at about 20 fps (the default) while shown, focused and not lean', live.frames >= 45 && live.frames <= 75, live);
  check('ANIMATING: about one animation frame is asked for per frame drawn (a timer covers the wait)', live.rafs <= live.frames * 1.3, live);

  await command({ cmd: 'windowBlur' });
  // the static frame is asked for as the focus goes, and runs a moment later: wait for the loop to have ended, not just for animating to turn false
  await waitFor(async () => { const s = await mapState(); return s && s.state.animating === false && s.state.looping === false ? s : null; }, 8000);
  const blurred = await mapState();
  check('UNFOCUSED: one static frame, no loop, no particles', blurred.state.animating === false && blurred.state.looping === false && blurred.state.particles === 0, { focused: blurred.focused, looping: blurred.state.looping, particles: blurred.state.particles });
  const stillBlur = await rafsOver(5000);
  check('UNFOCUSED: zero animation frames asked for in 5 s', stillBlur.rafs === 0 && stillBlur.frames === 0, stillBlur);
  check('UNFOCUSED: the static frame shows a settled picture', blurred.state.settled === true);
  await command({ cmd: 'windowFocus' });
  const back = await waitFor(async () => { const s = await mapState(); return s && s.state.looping ? s : null; }, 8000);
  check('FOCUS BACK: it moves again', !!back);

  await command({ cmd: 'reduced-motion', on: true });
  await sleep(1500);
  const reduced = await mapState();
  const reducedFrames = await rafsOver(3000);
  check('REDUCED MOTION: no particles, and the loop rests (the layout is settled)', reduced.state.particles === 0 && reducedFrames.rafs === 0, { particles: reduced.state.particles, ...reducedFrames });
  await command({ cmd: 'reduced-motion', on: false });
  await sleep(500);

  await setLean(true);
  await sleep(1500);
  const leanState = await mapState();
  const leanFrames = await rafsOver(5000);
  check('LEAN: the panel is not shown, and zero animation frames are asked for in 5 s', leanState && leanState.shownModule === false && leanFrames.rafs === 0, { shownModule: leanState && leanState.shownModule, ...leanFrames });
  await setLean(false);
  await sleep(1500);
  check('LEAN OFF: it is back and moving', !!(await waitFor(async () => { const s = await mapState(); return s && s.shownModule && s.state.looping ? s : null; }, 8000)));

  await command({ cmd: 'view', action: 'move', args: { id: 'map', target: 'hide' } });
  await sleep(1500);
  const hidden = await mapState();
  const hiddenFrames = await rafsOver(5000);
  check('HIDDEN: the panel is not shown, and ZERO animation frames in 5 s', hidden && hidden.shownModule === false && hidden.state.looping === false && hiddenFrames.rafs === 0 && hiddenFrames.frames === 0, { ...hiddenFrames, looping: hidden && hidden.state.looping });

  // ---- C. the cost ---------------------------------------------------------------------------------------------------------
  const readings = [];
  const frameRates = {};
  if (withCost) {
    const show = async () => { await command({ cmd: 'view', action: 'move', args: { id: 'map', target: 'right' } }); await waitFor(async () => { const s = await mapState(); return s && s.shownModule ? s : null; }, 10000); };
    // A presented frame has a fixed price on this machine, so the gap between frames is what decides the cost: the same six agents at 30, 40 and
    // 50 ms, ONE agent (close to the price of presenting a frame at all), the 48-agent cap, and a low-latency (desynchronized) canvas. Every scenario
    // rebuilds the panel first, so none inherits another's canvas.
    const animate = (gapMs, graph, desync = false) => async () => { await mapDo({ op: 'churn', n: 0 }); await show(); await mapDo({ op: 'remount', desynchronized: desync, ms: gapMs }); await mapDo(graph()); return true; };
    const small = () => smallGraph(folderA, folderB, worktree);
    const one = () => ({ ...smallGraph(folderA, folderB, worktree), agents: [smallGraph(folderA, folderB, worktree).agents[0]], claims: [], totalAgents: 1 });
    const busy = () => busyGraph([dev, featA, path.join(container, 'feat-b'), path.join(container, 'feat-c')]);
    const SCENARIOS = {
      'baseline: map hidden': async () => { await command({ cmd: 'view', action: 'move', args: { id: 'map', target: 'hide' } }); await mapDo({ op: 'unfake' }); return true; },
      'floor: 1 agent working, 50 ms': animate(50, one),
      'animating: 6 agents, 33 ms (30 fps)': animate(33, small),
      'animating: 6 agents, 50 ms (20 fps, the default)': animate(50, small),
      'animating: 48 agents (cap), 50 ms': animate(50, busy),
      'animating: 6 agents, 50 ms, 500 roster messages a second': async () => { await animate(50, small)(); await mapDo({ op: 'churn', n: 50 }); return true; },
      ...(flag('sweep') ? { 'animating: 6 agents, 40 ms': animate(40, small), 'animating: 6 agents, 67 ms (15 fps)': animate(67, small) } : {}),
      ...(flag('desync') ? { 'desynchronized canvas: 6 agents, 33 ms': animate(33, small, true), 'desynchronized canvas: 6 agents, 50 ms': animate(50, small, true) } : {}),
      'static: shown but unfocused': async () => { await mapDo({ op: 'churn', n: 0 }); await show(); await mapDo({ op: 'remount', desynchronized: false, ms: 50 }); await mapDo(small()); await command({ cmd: 'windowBlur' }); return true; },
    };
    const names = Object.keys(SCENARIOS);
    console.log(`\ncost: ${names.length} scenarios x ${reps} rounds, ${measureMs / 1000}s each`);
    for (let round = 1; round <= reps; round++) {
      for (const name of names) {
        await command({ cmd: 'windowFocus' });
        await setLean(false);
        let ok = await SCENARIOS[name]();
        await sleep(settleMs);
        const before = await mapState();
        const a = processTable();
        const pids = descendantPids(a, child.pid);
        const gpuJob = sampleGpu(measureMs / 1000);
        const t0 = Date.now();
        await sleep(measureMs);
        const b = processTable();
        const wallS = (Date.now() - t0) / 1000;
        const after = await mapState();
        const mine = (rows) => rows.filter(p => pids.has(p.ProcessId));
        const cpu = {};
        for (const [t, e] of Object.entries(idle.cpuByType(mine(a), mine(b), wallS, child.pid))) cpu[t] = e.cpu;
        const gpu = idle.gpuPercent(await gpuJob, [...pids]);
        const fps = before && after ? (after.state.frames - before.state.frames) / wallS : null;
        const asked = before && after ? (after.rafs - before.rafs) / wallS : null;
        (frameRates[name] = frameRates[name] || []).push({ drawnPerS: fps, askedPerS: asked, budget: after && after.state.budget, lastCostMs: after && after.state.lastCost, particles: after && after.state.particles });
        readings.push({ round, scenario: name, mode: 'normal', cpu, gpu, scenarioReached: ok });
        console.log(`round ${round} ${name.padEnd(36)} gpu-proc ${(cpu['gpu-process'] || 0).toFixed(1)}%  renderers ${(cpu.renderer || 0).toFixed(1)}%  main ${(cpu.main || 0).toFixed(1)}%  gpu-engine ${gpu.toFixed(1)}%  drawn ${fps === null ? 'n/a' : fps.toFixed(1)}/s, asked ${asked === null ? 'n/a' : asked.toFixed(1)}/s  budget ${after ? after.state.budget.toFixed(2) : 'n/a'}  last frame ${after ? after.state.lastCost.toFixed(1) : 'n/a'} ms`);
      }
    }
    await command({ cmd: 'windowFocus' });
    const rows = idle.summarise(readings);
    console.log('\n' + idle.table(rows));
    const total = (name) => (rows.find(r => r.scenario === name) || {}).cpu;
    const base = total('baseline: map hidden');
    await mapDo({ op: 'remount', desynchronized: false, ms: 50 });
    for (const r of rows) {
      if (r.scenario === 'baseline: map hidden') continue;
      const extra = r.cpu.total && base && base.total ? r.cpu.total.median - base.total.median : null;
      console.log(`${r.scenario}: ${extra === null ? 'n/a' : (extra >= 0 ? '+' : '') + extra.toFixed(1)} % of one core over the baseline (all Electron processes, median)`);
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ measuredAt: new Date().toISOString(), machine: os.hostname(), reps, measureMs, settleMs, readings, rows, frameRates, results }, null, 2));
    console.log('\nfull numbers ->', outFile);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshot -> ${pngFile}`);
  await command({ cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  main()
    .catch((e) => { console.error(e); return 1; })
    .then((code) => { try { cleanup(); } finally { process.exit(code); } });
}

module.exports = { smallGraph, busyGraph };
