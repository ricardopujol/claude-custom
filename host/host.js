'use strict';
/**
 * claude-custom :: session host  (SPIKE — step 0 walking skeleton)
 *
 * Owns the pty running the real `claude` binary and exposes it over a local
 * WebSocket so the Electron GUI can attach as a pure view.
 *
 * Deliberately runs under plain Node, NOT inside Electron: node-pty is a native
 * module and would otherwise need an ABI rebuild against Electron's headers
 * (Visual Studio build tools on Windows). This also mirrors the target
 * architecture, where the host outlives any attached GUI.
 *
 * Spike scope: no detach/reattach, no replay buffer, no hook bridge, no mood
 * state. Those arrive in step 1+. This exists to answer one question — does
 * xterm.js host the Ink TUI faithfully?
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { writeHarnessSettings, buildClaudeArgs } = require('./settings-writer');
const { createHookBridge } = require('./hook-bridge');
const { createTerminalState } = require('./terminal-state');
const { createMoodMachine } = require('./mood-machine');
const { resolveTheme } = require('./themes');
const { portraitFor } = require('./portraits');
const { readUsage, EMPTY } = require('./usage');
const { readAgentStats } = require('./agent-stats');
const { loadCatalogue } = require('./openrouter');
const { normalizeCatalogue } = require('./models');
const { addSeat, removeSeat, seatWarnings, MAX_SEATS } = require('./seats');
const { backgroundFor } = require('./background');
const { createProcessTracker } = require('./processes');
const { createStore } = require('./store');
const { parsePermissionMode, MODES } = require('./mode');
const { buildProviderEnv, describeProvider } = require('./providers');
const { createCooldowns } = require('./cooldowns');
const { readQuota, createQuotaAnnouncer } = require('./quota');
const { planDrop } = require('./drop');
const { createAttention } = require('./attention');
const { milestoneFor, nextMilestone, progressTo, describeSpend,
        createAnnouncer } = require('./milestones');
const { detectRunner, parseResults, healthFrom } = require('./health');
const { createCappedBuffer } = require('./capped-buffer');
const { readFog } = require('./fog');
const { allowConnection, newToken } = require('./gatekeeper');

const PORT = Number(process.env.CLAUDE_CUSTOM_PORT) || 7681;

// --- locate the real claude binary -----------------------------------------
// npm installs a native claude.exe; spawning it directly avoids a cmd.exe shim
// layer that would otherwise sit between the pty and the TUI.
function resolveClaude() {
  if (process.env.CLAUDE_CUSTOM_BIN) return process.env.CLAUDE_CUSTOM_BIN;

  const candidates = [
    path.join(
      process.env.APPDATA || '',
      'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    ),
    path.join(os.homedir(), '.local/bin/claude.exe'),
    path.join(os.homedir(), '.local/bin/claude'),
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Fall back to PATH resolution and let the pty fail loudly if absent.
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

const CLAUDE_BIN = resolveClaude();
const CWD = process.env.CLAUDE_CUSTOM_CWD || process.cwd();

// The generated settings file contributes ONLY the harness's own hook matchers.
// It does not union the user's hooks: those accumulate across settings layers
// on their own, so copying them in would run every one of them twice. See
// verify/probe-hook-layers.js and the design doc's verification section.
const SESSION_ID = process.env.CLAUDE_CUSTOM_SESSION_ID || String(process.pid);
const PIPE_NAME = `\\\\.\\pipe\\claude-custom-${SESSION_ID}`;
const HARNESS_DIR = path.join(__dirname, '..', '.harness');
const HELPER_PATH =
  process.env.CLAUDE_CUSTOM_HELPER || path.join(HARNESS_DIR, 'hook-helper.exe');

// Project HP. The suite runs in a CHILD PROCESS, never in this one: a test run
// is seconds of work, and the host's event loop is what accepts the hook
// helper's named-pipe connection inside its 80ms timeout. Detection is cheap
// enough to do inline; the RUN never is.
//
// One run at a time. A second request while a run is in flight joins the first
// instead of starting a competing process -- two `npm test` runs in one repo
// fight over the same build output.
const healthRunner = detectRunner(CWD);
let healthState = {
  ...healthFrom(null),
  runner: healthRunner ? healthRunner.kind : null,
  running: false,
};
let healthInFlight = null;

function settleHealth(results, started) {
  healthState = {
    ...healthFrom(results),
    runner: healthRunner ? healthRunner.kind : null,
    running: false,
    ranAt: Date.now(),
    tookMs: Date.now() - started,
  };
  // A throw inside a 'close' listener is an UNCAUGHT EXCEPTION, not a
  // rejection -- it would kill the host and the user's live session with it.
  try { broadcastControl({ type: 'health', health: healthState }); } catch {}
  return healthState;
}

// A wall-clock ceiling. Without one, a suite that HANGS -- a watch script, a
// runner prompting on stdin, a `pdb` breakpoint, cmd.exe's "Terminate batch
// job (Y/N)?" -- leaves the bar pulsing forever AND wedges healthInFlight, so
// every later click is a silent no-op. The host is spawned detached, so
// reopening the window reattaches to the same stuck host: there would be no
// way out from inside the product.
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;

// An unbounded `out +=` in the HOST is two hazards at once: past V8's ~512MB
// string limit it throws RangeError inside a 'data' listener, killing the host
// and the user's live session; and long before that, growing a huge string
// forces major GC pauses in the one event loop that must accept the hook
// helper's connection within 80ms.
//
// HEAD *AND* TAIL, because runners disagree about where the summary goes:
//
//   pytest      prints its counts LAST              -> the tail has it
//   node:test   prints its counters, THEN the        -> the HEAD has it
//               "failing tests:" detail
//
// A blind tail was measured losing the node:test counter block at ~48 failures
// (120 failures puts it 156KB from the end), so the reddest suite in the repo
// reported "unknown" instead of "critical" -- the exact defect this branch
// called blocker-grade for pytest, reintroduced for the default runner.
const HEALTH_OUTPUT_CAP = 64 * 1024;

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // The try/catch below does NOT catch this: a ChildProcess reports a failed
    // spawn through an ASYNC 'error' event, and an EventEmitter with no 'error'
    // listener THROWS -- an uncaught exception that kills the host and the
    // user's live Claude session with it. Reproduced: taskkill missing from
    // PATH exits the host with ENOENT.
    //
    // Worst on the timeout path, which runs precisely when a suite has hung and
    // the timeout is the user's only way out.
    try {
      const killer = require('child_process').spawn(
        'taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', (err) => {
        console.log('[host] taskkill failed:', err.code || err.message, '- falling back');
        try { child.kill('SIGTERM'); } catch {}
      });
      return;
    } catch { /* fall through to the portable kill */ }
  }
  try { child.kill('SIGTERM'); } catch {}
}

let healthChild = null;

function runHealth() {
  if (healthInFlight) return healthInFlight;
  if (!healthRunner) {
    // No recognisable suite. UNKNOWN, not zero: a project without tests is not
    // a project whose tests all fail.
    healthState = { ...healthFrom(null), runner: null, running: false };
    broadcastControl({ type: 'health', health: healthState });
    return Promise.resolve(healthState);
  }

  healthState = { ...healthState, running: true };
  broadcastControl({ type: 'health', health: healthState });

  const [cmd, ...args] = healthRunner.command;
  const started = Date.now();
  healthInFlight = new Promise((resolve) => {
    const env = { ...process.env };
    // A child that inherits NODE_TEST_CONTEXT switches to the v8 serializer
    // protocol and writes NOTHING to stdout, which reads as a broken parser.
    delete env.NODE_TEST_CONTEXT;

    const child = require('child_process').spawn(cmd, args, {
      cwd: CWD, env, windowsHide: true,
      // stdin IGNORED, so an interactive runner reads EOF and exits instead of
      // waiting forever for input nobody can type.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Narrow: npm is a .cmd shim on Windows and needs a shell. python.exe is
      // a real executable and does not -- and routing it through cmd.exe is
      // what makes killing it require a tree kill.
      shell: healthRunner.kind === 'npm' && process.platform === 'win32',
    });
    healthChild = child;

    // Separate buffers per stream. One shared accumulator interleaves the two
    // at arbitrary chunk boundaries, splicing a counter line in half ("i pa" +
    // "npm WARN ..." + "ss 319") so a fully green run parses as null.
    const stdout = createCappedBuffer(HEALTH_OUTPUT_CAP);
    const stderr = createCappedBuffer(HEALTH_OUTPUT_CAP);
    child.stdout.setEncoding('utf8');       // no split multi-byte characters
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout.push(d));
    child.stderr.on('data', d => stderr.push(d));

    // ONE settle per run. Node can emit both 'error' and 'close' for a single
    // spawn failure, which broadcast two results with different timestamps.
    let settled = false;
    const done = (results) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      healthChild = null;
      resolve(settleHealth(results, started));
    };

    const timer = setTimeout(() => {
      console.log('[host] health run timed out after', HEALTH_TIMEOUT_MS, 'ms');
      killTree(child);
      done(null);                 // unknown, not zero: we never saw a result
    }, HEALTH_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.on('error', () => done(null));
    child.on('close', () => {
      // stdout first: some runners summarise on stderr, but a runner that
      // writes to both must not have its summary preceded by warnings.
      const parsed = parseResults(healthRunner.parser, stdout.text())
        || parseResults(healthRunner.parser, stderr.text());
      done(parsed);
    });
  }).finally(() => { healthInFlight = null; });

  return healthInFlight;
}

// The project's file map. NOT computed at startup or pushed in `hello`: a cold
// read costs ~175ms of synchronous work, and the host's event loop is what
// delivers hook events -- this project measured a spawnSync in the server
// dropping 31 of 35 of them. It is computed when the client asks for it, and
// the mtime cache makes every later read ~1ms.
//
// `tracked` comes from git, because the DARK files are the whole point and this
// host must never invent a file that does not exist.
function trackedFiles() {
  try {
    // -z and core.quotePath=false: by default git C-QUOTES any path with a
    // non-ASCII or special character ("src/cafÃ©.js"), which then matches
    // no transcript path and appears BOTH as explored and as a phantom dark
    // row. NUL separation also survives filenames containing newlines.
    //
    // maxBuffer raised because the 1MiB default throws ENOBUFS on a repo of
    // ~15k files -- and that error used to land in the "everything explored"
    // branch, which is the worst possible direction to fail in.
    const out = require('child_process').execFileSync(
      'git', ['-C', CWD, '-c', 'core.quotePath=false', 'ls-files', '-z'],
      { encoding: 'utf8', timeout: 4000, maxBuffer: 64 * 1024 * 1024 });
    // No .trim(): a filename may legitimately begin or end with a space.
    return { ok: true, files: out.split(String.fromCharCode(0)).filter(Boolean) };
  } catch (err) {
    // NOT an empty list. An empty list means "this project has no files", which
    // renders as zero dark rows -- "everything explored, no blind spots" -- the
    // single most misleading thing this panel could say.
    return { ok: false, files: [], error: err.message };
  }
}

async function currentFog() {
  const tracked = trackedFiles();
  const fog = await readFog({ cwd: CWD, tracked: tracked.files });
  // The git failure travels with the data, so the panel can say "dark files
  // not counted" instead of silently claiming full coverage.
  fog.status.trackedOk = tracked.ok && tracked.files.length > 0;
  fog.status.trackedError = tracked.ok ? null : tracked.error;
  return fog;
}

const settingsFile = writeHarnessSettings(HARNESS_DIR, {
  helperPath: HELPER_PATH,
  pipeName: PIPE_NAME,
});

// Attached only once the native helper exists (step 2). Wiring hooks to a
// missing binary would fire on every Task and Bash call and invoke nothing.
const helperExists = fs.existsSync(HELPER_PATH);
const ARGS = buildClaudeArgs({ settingsFile, helperExists });

if (!helperExists) {
  console.log('[host] hook helper absent — running without hooks:', HELPER_PATH);
}

// The bridge must be listening BEFORE claude starts, otherwise every matched
// tool call pays the helper's full connect timeout waiting for a listener that
// never appears -- strictly worse than not hooking at all.
const REGISTRY_DIR = process.env.CLAUDE_CUSTOM_REGISTRY || path.join(__dirname, '..', 'registry');
// Portraits live with the agents, in the agent-creator repo, not here: they are
// a property of the agent roster, which more than one project consumes. The
// forge writes there and the harness reads from there.
const PORTRAITS_DIR =
  process.env.CLAUDE_CUSTOM_PORTRAITS ||
  'C:\\Users\\ricar\\VibeCode\\agent-creator\\portraits';
const theme = resolveTheme(CWD, { registryDir: REGISTRY_DIR });
console.log('[host] theme          :', theme.name);

const mood = createMoodMachine();
const processes = createProcessTracker();
const store = createStore({ dir: path.join(HARNESS_DIR, 'state') });
const cooldowns = createCooldowns({ store });
// The agent list comes from the mood stack, so a finished turn can say how
// many agents ran rather than just that something ended.
// Tracks whether a cooldown list was last non-empty, so the falling edge is
// broadcast too. Without it the panel is never told the list emptied and the
// final row stays on screen.
let cooldownsWere = 0;

const attention = createAttention({
  project: path.basename(CWD),
  agents: () => mood.stack(),
});
attention.on('attention', e => broadcastControl({ type: 'attention', ...e }));

// Provider is fixed at spawn: the pty environment cannot change under a running
// process, so switching backend means a new session rather than a hot swap.
const providerConfig = store.read('provider', { provider: 'claude-max' });
const provider = describeProvider(providerConfig);
let providerEnv = {};
try {
  providerEnv = buildProviderEnv(providerConfig);
} catch (err) {
  // Refuse to half-apply: running against Anthropic while the UI claims
  // OpenRouter would put spend somewhere unexpected.
  console.log('[host] provider config invalid, using default:', err.message);
}
console.log('[host] provider      :', provider.label, provider.metered ? '(metered)' : '(subscription)');
const describe = (agent, state) => ({ agent, state, portrait: portraitFor(agent, state, { portraitsDir: PORTRAITS_DIR }) });

// Generated once per project folder and reused by every context window on it.
const BACKGROUNDS_DIR = process.env.CLAUDE_CUSTOM_BACKGROUNDS || path.join(__dirname, '..', 'backgrounds');
const background = backgroundFor(CWD, { dir: BACKGROUNDS_DIR });
console.log('[host] background     :', path.basename(background.path), background.created ? '(new)' : '(existing)');

// The session id arrives on the SessionStart hook. Until it does, only the
// project total is knowable -- readUsage handles that rather than blocking.
let sessionId = null;
let lastUsage = null;

// WHEN to announce lives in host/milestones.js, not here. It used to be a
// private function in this file, which nothing can require -- so the tests
// written for it scored a copy of the algorithm re-implemented inside the test
// file, and deleting the real high-water mark left every test green.
const announcer = createAnnouncer();

// A crossing that happened while nothing was attached. The pty deliberately
// outlives the window, so a milestone reached during a detached session was
// broadcast to an empty client set and lost forever.
let pendingMilestone = null;
let pendingQuotaWarning = null;
// Folders this session has already granted via /add-dir. In memory only: the
// grant lives in the running `claude` process, so it dies with the process and
// must not outlive it in a file that would re-grant on the next boot.
const grantedDirs = [];

// A counter, never a limit -- so this reports where you ARE and what is next,
// and has no concept of anything running out.
function decorateUsage(usage) {
  const total = usage && usage.project ? usage.project.total : 0;
  const reached = milestoneFor(total);
  const next = nextMilestone(total);
  return {
    ...usage,
    milestone: {
      reached,
      next,
      progress: progressTo(total),
      // Same numbers, framed by what they COST: on a subscription the marginal
      // cost inside quota is zero, so a playful counter is honest; on a metered
      // provider it is somebody's bill.
      spend: describeSpend(usage && usage.project, { metered: !!provider.metered }),
    },
  };
}

// Reading the transcripts is ASYNCHRONOUS, so this returns the last reading
// rather than taking one; `refreshUsage` is what takes one. The split exists
// because the attach handshake is built synchronously and must not be the thing
// that waits 300ms on a cold 64MB read -- see host/usage.js.
function currentUsage() {
  // Before the first reading lands, report ABSENCE rather than zero. `ok:false`
  // is what stops the milestone announcer seeding a baseline from a figure that
  // simply has not been read yet.
  if (!lastUsage) {
    return decorateUsage({ ok: false, unreadable: 0, session: { ...EMPTY }, project: { ...EMPTY } });
  }
  return lastUsage;
}

// Miguel, B1: hold the PROMISE, not a boolean. A boolean guard makes a
// coalesced caller receive `lastUsage`, which is null until the first read
// lands -- and the interval is installed at module scope alongside the boot
// read, so the very first tick can arrive while that read is still in flight.
// The timer then dereferenced null and logged an error naming the wrong cause.
// Sharing the promise gives every caller the real result instead.
let usagePending = null;
function refreshUsage() {
  if (usagePending) return usagePending;
  usagePending = readUsage({ cwd: CWD, sessionId })
    .then((u) => {
      lastUsage = decorateUsage(u);
      return lastUsage;
    })
    .finally(() => { usagePending = null; });
  return usagePending;
}

// Announce a newly reached milestone once. Deliberately separate from the usage
// broadcast: the flourish is an EVENT, and folding it into a value that is
// re-sent every few seconds would replay the celebration forever.
function checkMilestone(usage) {
  const total = usage && usage.project ? usage.project.total : 0;
  // `ok === false` means readUsage could not read the transcripts at all. That
  // is absence, not zero, and seeding or baselining from it announced the whole
  // ladder on the next good tick.
  const hit = announcer.see(total, usage ? usage.ok !== false : false);
  if (!hit) return;

  console.log('[host] milestone      :', hit.name, hit.icon);
  const message = { type: 'milestone', milestone: hit, total };

  // At least one OPEN client, not merely a non-empty set: a socket that is
  // CLOSING is still in `clients` (it is removed on 'close'), so size alone
  // said "someone is listening" while sendControl skipped it -- dropping the
  // milestone rather than holding it, which is the loss this guard prevents.
  const listening = [...clients].some(ws => ws.readyState === ws.OPEN);
  if (!listening) {
    pendingMilestone = message;
    return;
  }
  broadcastControl(message);
}

// How much of the Max plan is left. A NETWORK read, unlike everything else on
// this page, so it is deliberately slow-polled and never on the critical path:
// the account's own windows are 5 hours and 7 days, so a minute of staleness is
// invisible, and a failed call must never hold the loop the hook bridge runs on.
let lastQuota = null;
let quotaPending = null;
const quotaAnnouncer = createQuotaAnnouncer();

function refreshQuota() {
  if (quotaPending) return quotaPending;
  quotaPending = readQuota({})
    .then((q) => {
      lastQuota = q;
      checkQuotaWarning(q);
      return q;
    })
    .catch((err) => {
      // readQuota already turns every failure into an `absent` result, so
      // reaching here means a bug rather than a network problem. Say so, and
      // keep ABSENCE rather than a stale-but-confident figure.
      console.log('[host] quota read threw:', err && err.message);
      lastQuota = { ok: false, state: 'absent', windows: [], error: 'read failed' };
      return lastQuota;
    })
    .finally(() => { quotaPending = null; });
  return quotaPending;
}

// A window crossing a threshold is an EVENT, announced once per window
// INSTANCE -- see host/quota.js for why the milestone announcer could not be
// reused verbatim (quota percent resets; lifetime spend does not).
function checkQuotaWarning(quota) {
  if (!quota || quota.ok === false) return;      // absence announces nothing
  const hit = quotaAnnouncer.check(quota.windows);
  if (!hit) return;

  console.log('[host] quota warning  :', hit.text);
  const message = { type: 'quotaWarning', warning: hit };
  // Held when nothing is attached, for the same reason a milestone is: the pty
  // outlives the window, so the crossing can easily happen with no observer --
  // and "you are at 95%" is worth more on attach than lost.
  const listening = [...clients].some(ws => ws.readyState === ws.OPEN);
  if (!listening) {
    pendingQuotaWarning = message;
    return;
  }
  broadcastControl(message);
}

// Files dropped on the window. Types their paths into the prompt and, for a
// file outside the project, grants the session read access to its folder.
//
// THE GRANT GOES THROUGH THE CLI'S OWN `/add-dir`, not through the settings
// file: the `claude` process is already running, it owns its own notion of
// which directories are allowed, and editing settings underneath it would
// either do nothing or fight it. Same "wrap the real CLI, never reimplement
// it" bet the rest of this harness rests on. `/add-dir` was verified present
// in the shipped binary before this was built.
//
// SEQUENCED, not fired in one write. Each /add-dir is a slash command that the
// TUI must accept and execute; typing the file paths in the same breath would
// race the command and land the paths inside its argument. So the grants go
// first, one per tick, and the paths only after the last one.
function handleDrop(msg, ws) {
  const entries = Array.isArray(msg.entries) ? msg.entries : [];
  if (!entries.length) return;

  // The renderer's isDirectory is a HINT from a File object, which guesses.
  // Stat it here, where the real filesystem is, and fall back to the hint only
  // if the stat fails (a path that vanished between drop and read).
  const stated = entries.map((e) => {
    let isDirectory = !!e.isDirectory;
    try { isDirectory = fs.statSync(e.path).isDirectory(); } catch { /* keep the hint */ }
    return { path: e.path, isDirectory };
  });

  const plan = planDrop({
    entries: stated,
    cwd: CWD,
    alreadyGranted: grantedDirs,
    home: os.homedir(),
  });

  if (plan.refused.length) {
    for (const r of plan.refused) console.log('[host] drop refused  :', r.dir, '-', r.why);
  }

  let delay = 0;
  for (const dir of plan.dirsToAdd) {
    grantedDirs.push(dir);
    console.log('[host] drop grants   :', dir);
    setTimeout(() => {
      try { term.write('/add-dir ' + dir + '\r'); } catch (err) {
        console.log('[host] add-dir failed:', err && err.message);
      }
    }, delay);
    delay += 350;
  }

  if (plan.text) {
    setTimeout(() => {
      try { term.write(plan.text); } catch (err) {
        console.log('[host] drop write failed:', err && err.message);
      }
    }, delay);
  }

  // Told to the CLIENT, not only the log. The user made a gesture; what it
  // widened has to be visible to them, not buried in a host console they are
  // not looking at.
  const note = { granted: plan.dirsToAdd, refused: plan.refused, truncated: plan.truncated };
  if (plan.dirsToAdd.length || plan.refused.length || plan.truncated) {
    try { sendControl(ws, { type: 'dropped', note }); } catch { /* the client went away */ }
  }
}

// Per-agent career stats: tokens spent and time worked IN THIS PROJECT, across
// every session on the folder. Cached and refreshed when an agent finishes
// rather than polled -- it reads every transcript in the project, so a timer
// would put that cost on a clock for a figure that only changes on a finish.
let lastAgentStats = { ok: false, agents: [], unresolved: 0 };
let agentStatsPending = null;

function refreshAgentStats() {
  if (agentStatsPending) return agentStatsPending;
  agentStatsPending = readAgentStats({ cwd: CWD })
    .then((stats) => { lastAgentStats = stats; return stats; })
    .catch((err) => {
      console.error('[host] agent stats failed:', err && err.message);
      return lastAgentStats;
    })
    .finally(() => { agentStatsPending = null; });
  return agentStatsPending;
}

// The OpenRouter catalogue and the council seats.
//
// The catalogue endpoint is PUBLIC, so this needs no key and spends nothing --
// which is why the browser works today and the council does not. Loaded lazily
// on the first request rather than at boot: a session that never opens the
// panel should not make a network call at all.
const CATALOGUE_CACHE = path.join(HARNESS_DIR, 'state', 'openrouter-catalogue.json');
let cataloguePending = null;

function currentCatalogue({ force = false } = {}) {
  if (cataloguePending && !force) return cataloguePending;
  cataloguePending = loadCatalogue({ cacheFile: CATALOGUE_CACHE, force })
    .then(r => ({ ...r, models: normalizeCatalogue(r.rows), rows: undefined }))
    .finally(() => { cataloguePending = null; });
  return cataloguePending;
}

// Seats persist, so a council survives a restart. Stored as the thin shape
// seats.js produces -- id, name, provider -- never a whole catalogue row, which
// would freeze stale pricing into a file someone later reads as current.
function readSeats() {
  const saved = store.read('council', { seats: [] });
  return Array.isArray(saved.seats) ? saved.seats : [];
}

function seatPayload(seats) {
  return { type: 'seats', seats, max: MAX_SEATS, warnings: seatWarnings(seats) };
}

let hookBridge = null;
if (helperExists) {
  hookBridge = createHookBridge({ pipeName: PIPE_NAME });
  hookBridge.on('event', (ev) => {
    if (ev.event === 'SessionStart' && ev.payload && ev.payload.session_id) {
      sessionId = ev.payload.session_id;
      console.log('[host] session id     :', sessionId);
    }
    if (ev.event === 'SubagentStop') {
      // The transcript is on disk by the time this fires, so its tokens and
      // timestamps are already there to read.
      refreshAgentStats()
        .then((stats) => broadcastControl({ type: 'agentStats', stats }))
        .catch(() => { /* the next finish will carry it */ });
      // agent_type when the payload carries it; the top of the stack only as a
      // fallback. Cooldowns applied to the wrong agent are worse than none.
      const finished = (ev.payload && ev.payload.agent_type)
        || mood.stack()[mood.stack().length - 1];
      if (finished) {
        cooldowns.finished(finished);
        // Broadcast, or the panel only learns about a cooldown on reattach --
        // which is exactly when it is least useful.
        broadcastControl({ type: 'cooldowns', cooldowns: cooldowns.list() });
      }
    }
    // Logged because the roster silently showed nothing when agents ran, and
    // there was no way to tell whether hooks were arriving at all.
    const what = ev.payload && (ev.payload.tool_input?.subagent_type || ev.payload.tool_name);
    console.log(`[hook] ${ev.event}${what ? ' ' + what : ''}`);
    // The shape Claude Code actually sends is the one thing no local test can
    // assert, because every test supplies the shape it expects.
    if (process.env.CLAUDE_CUSTOM_HOOK_DEBUG) {
      const pl = ev.payload || {};
      // The FULL payload, for verify/probe-payloads.js to check against
      // host/payload-contract.js. The projection below is for reading by eye.
      console.log('[hook:full] ' + JSON.stringify(pl));
      console.log('[hook:raw] ' + JSON.stringify({
        hook_event_name: pl.hook_event_name,
        tool_name: pl.tool_name,
        tool_input_keys: pl.tool_input ? Object.keys(pl.tool_input) : null,
        subagent_type: pl.tool_input && pl.tool_input.subagent_type,
        top_keys: Object.keys(pl),
      }));
    }
    attention.handle(ev);
    mood.handle(ev);
    processes.handle(ev);
    broadcastControl({ type: 'processes', running: processes.list(), party: mood.stack() });
  });
  hookBridge.on('parse-error', e => console.log('[hook!] unparseable line:', e.line.slice(0, 80)));
  hookBridge.on('error', e => console.log('[hook!] bridge error:', e.message));
  hookBridge.listening
    .then(() => console.log('[host] hook bridge listening on', PIPE_NAME))
    .catch(e => console.log('[host] hook bridge FAILED to bind:', e.message));
}

console.log('[host] claude binary :', CLAUDE_BIN);
console.log('[host] cwd           :', CWD);

// Inherited CLAUDE_CODE_* markers must not leak into the hosted session.
// Measured: launching the host from inside an existing claude session passes
// CLAUDE_CODE_CHILD_SESSION down, and the child silently disables transcript
// saving — which would take `--resume` with it. The harness owns a top-level
// session, never a child one.
// Explicit denylist, NOT a CLAUDE_CODE_* wildcard: that namespace also carries
// legitimate user configuration (e.g. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS),
// which the harness has no business dropping. Only session-identity markers go.
const INHERITED_SESSION_VARS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDECODE',
];

function cleanEnv() {
  const env = { ...process.env };
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  return env;
}

const term = pty.spawn(CLAUDE_BIN, ARGS, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: CWD,
  env: {
    ...cleanEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Marks this session as harness-hosted; the hook bridge keys off it later.
    CLAUDE_CUSTOM_SESSION: '1',
    ...providerEnv,
  },
});

console.log('[host] pty pid       :', term.pid);

// --- attach surface ---------------------------------------------------------
// The session token. Taken from the environment when the Electron main process
// supplies one (it spawns both the host and the window, so it can hand the same
// secret to both), otherwise generated here and written to a 0600 file that
// local tools -- the probes -- can read. A web page cannot read a local file,
// which is the whole point: this separates "a program on this machine" from
// "a page the user happened to visit".
//
// NEVER passed through the pty. It travels host <-> client only.
const TOKEN_FILE = path.join(HARNESS_DIR, 'session-token');
const SESSION_TOKEN = process.env.CLAUDE_CUSTOM_TOKEN || newToken();
try {
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, SESSION_TOKEN, { mode: 0o600 });
} catch (err) {
  console.log('[host] could not write the session token file:', err.message);
}

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  // Refused at the HANDSHAKE, before a socket exists. Browsers do not apply
  // CORS to WebSocket, so without this any page the user visits could connect
  // and send {type:'input'} into a pty running with permissions bypassed.
  verifyClient: ({ origin, req }, done) => {
    const token = new URL(req.url, 'ws://127.0.0.1').searchParams.get('token');
    const verdict = allowConnection({ origin, token }, { expectedToken: SESSION_TOKEN });
    if (!verdict.ok) {
      console.log('[host] refused a connection:', verdict.reason);
      return done(false, 403, 'Forbidden');
    }
    done(true);
  },
});
const clients = new Set();

// Authoritative screen, so a GUI attaching later gets the CURRENT state rather
// than nothing until the TUI happens to repaint.
const termState = createTerminalState({ cols: 120, rows: 30 });

// The TUI is the only authority on the current permission mode: the user can
// change it with shift+tab at any moment. Read it back out of the screen we
// already maintain rather than tracking it independently.
let permissionMode = null;
function refreshPermissionMode() {
  const lines = termState.lines();
  const next = parsePermissionMode(lines);
  if (next && next !== permissionMode) {
    permissionMode = next;
    console.log('[host] permission mode:', permissionMode);
    broadcastControl({ type: 'mode', mode: permissionMode });
  }
}

// Protocol: BINARY frames are raw pty bytes, TEXT frames are control JSON.
// Distinguishing by content would be wrong -- terminal output can contain
// anything, including a leading '{'.
const sendControl = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
const broadcastControl = msg => { for (const ws of clients) sendControl(ws, msg); };

term.onData((data) => {
  termState.write(data);
  const frame = Buffer.from(data, 'utf8');
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
  }
});

// The machine is deliberately passive: it schedules nothing itself, so the host
// owns the clock and the transitions stay reproducible in tests.
mood.on('change', ({ agent, state }) => broadcastControl({ type: 'mood', ...describe(agent, state) }));
const moodTimer = setInterval(() => {
  mood.tick();
  processes.sweep();
  // Re-broadcast so elapsed times tick up in the GUI without the view having to
  // own a clock of its own.
  refreshPermissionMode();
  if (processes.list().length) {
    broadcastControl({ type: 'processes', running: processes.list(), party: mood.stack() });
  }
  // The FALLING EDGE matters as much as the rising one. Broadcasting only a
  // non-empty list means the panel is never told the last cooldown expired, so
  // the final row stays on screen claiming an agent is still unavailable.
  const cooling = cooldowns.list();
  if (cooling.length || cooldownsWere) {
    broadcastControl({ type: 'cooldowns', cooldowns: cooling });
  }
  cooldownsWere = cooling.length;
}, 1000);
moodTimer.unref();

// Usage is re-read from the transcripts on a timer rather than tracked here:
// the transcripts are authoritative, and they already account for spend this
// harness never saw. Polled rather than watched because the file is appended to
// constantly and only the total is displayed.
const usageTimer = setInterval(() => {
  const before = lastUsage && lastUsage.session.total;
  const beforeProject = lastUsage && lastUsage.project.total;
  refreshUsage().then(usage => {
    // Gated on EITHER total. The milestone payload is project-scoped, so gating
    // only on the session figure let another window advance the project past a
    // rung while this window's bar kept showing the old one -- the UI
    // celebrating and denying the same event at once.
    if (usage.session.total !== before || usage.project.total !== beforeProject) {
      broadcastControl({ type: 'usage', usage });
    }
    // Checked on every tick, not only when the session total moved: the PROJECT
    // total can advance because another window on the same folder did work.
    checkMilestone(usage);
    if (usage && usage.unreadable) {
      // Said out loud rather than absorbed: an unreadable transcript makes the
      // project total an UNDERCOUNT, which is why `ok` goes false and the
      // milestone announcer stops trusting it. Permanently unreadable is a
      // broken state worth seeing, not one to paper over.
      console.log('[host] usage         :', usage.unreadable, 'transcript(s) unreadable');
    }
  }).catch(err => console.error('[host] usage read failed:', err && err.message));
}, 5000);
usageTimer.unref();

// Account limits, polled far slower than usage: this one is a NETWORK call, and
// the windows it reports are 5 hours and 7 days, so a minute of staleness is
// invisible while a tight loop would be a request per few seconds against
// someone else's service for a number that barely moves. Broadcast only on a
// CHANGE, so an idle session is silent on the wire.
const QUOTA_POLL_MS = 60_000;
const quotaTimer = setInterval(() => {
  const before = JSON.stringify(lastQuota && lastQuota.windows);
  refreshQuota().then((quota) => {
    if (JSON.stringify(quota && quota.windows) !== before) {
      broadcastControl({ type: 'quota', quota });
    }
  });
}, QUOTA_POLL_MS);
quotaTimer.unref();

// The first reading immediately, for the same reason usage does: a header that
// says "reading…" for a full minute reads as broken rather than as honest.
refreshQuota().then((quota) => broadcastControl({ type: 'quota', quota }));

// The first reading immediately rather than five seconds in. A cold read of
// this project's transcripts is ~330ms, so waiting a full tick would show the
// counter at "not read yet" for the whole of a window's first impression.
refreshUsage().then(usage => {
  checkMilestone(usage);
  broadcastControl({ type: 'usage', usage });
}).catch(() => {});

// The careers are HISTORY, so they are worth reading once at boot rather than
// waiting for an agent to finish -- a window attached to a project with a long
// past would otherwise show nothing beside every portrait.
refreshAgentStats().then((stats) => {
  broadcastControl({ type: 'agentStats', stats });
}).catch(() => {});

term.onExit(({ exitCode, signal }) => {
  console.log(`[host] claude exited code=${exitCode} signal=${signal}`);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({ type: 'exit', exitCode, signal })
      );
    }
  }
  process.exit(exitCode ?? 0);
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[host] client attached (${clients.size} total)`);

  // Attach handshake: everything the view needs to draw itself, then the
  // current screen. The view holds no session state of its own, so this is the
  // only place it learns the theme, the roster or what is on the terminal.
  sendControl(ws, {
    type: 'hello',
    cwd: CWD,
    theme,
    hooks: helperExists,
    background: background.path,
    usage: currentUsage(),
    roster: mood.roster().map(r => describe(r.agent, r.state)),
    running: processes.list(),
    party: mood.stack(),
    mode: permissionMode,
    modes: MODES,
    provider,
    cooldowns: cooldowns.list(),
    health: healthState,
    agentStats: lastAgentStats,
    // May still be null on a fast attach; the renderer draws "reading…" for
    // that, never three bars at zero.
    quota: lastQuota,
    // Seats travel with the handshake; the CATALOGUE does not. It is a network
    // call, and a session that never opens the panel should not make one.
    seats: readSeats(),
    maxSeats: MAX_SEATS,
  });
  // The handshake above carries `lastUsage`, which is ABSENCE until the first
  // read lands (~340ms cold). Nothing corrected it: the boot broadcast fires
  // while `clients` is still empty, and the 5s tick only broadcasts on a
  // CHANGE -- so a client that attached early sat on "reading..." until the
  // user happened to spend a token. Coalesces onto the in-flight boot read
  // rather than starting another.
  if (!lastUsage) {
    refreshUsage()
      .then((usage) => {
        if (ws.readyState === ws.OPEN) sendControl(ws, { type: 'usage', usage });
      })
      .catch(() => { /* the next tick will carry it */ });
  }

  // The careers have the SAME hazard, and it is worse: they refresh only when
  // an agent finishes, so a client that attached before the boot read landed
  // would show nothing beside every portrait until the next SubagentStop --
  // which on a project being read rather than worked is never.
  if (!lastAgentStats.ok) {
    refreshAgentStats()
      .then((stats) => {
        if (ws.readyState === ws.OPEN) sendControl(ws, { type: 'agentStats', stats });
      })
      .catch(() => { /* the next finish will carry it */ });
  }

  // A milestone reached while nothing was attached is delivered now rather than
  // lost: the pty outlives the window by design, so the crossing can easily
  // happen with no observer.
  if (pendingMilestone && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(pendingMilestone));
      // Cleared only on a SUCCESSFUL send. Clearing outside the try discarded
      // the held milestone when the send threw -- losing it for the same reason
      // holding it exists to prevent.
      pendingMilestone = null;
    } catch { /* keep it for the next client to attach */ }
  }

  // A quota threshold crossed while nothing was attached, delivered now for the
  // same reason: "you are at 95% of your 5-hour window" is worth more late than
  // never, and the pty runs on whether a window is open or not.
  if (pendingQuotaWarning && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(pendingQuotaWarning));
      pendingQuotaWarning = null;      // cleared only on a SUCCESSFUL send
    } catch { /* keep it for the next client to attach */ }
  }

  // A client that attached before the first quota read landed would otherwise
  // sit on "reading…" until the next poll a minute later.
  if (!lastQuota) {
    refreshQuota()
      .then((quota) => {
        if (ws.readyState === ws.OPEN) sendControl(ws, { type: 'quota', quota });
      })
      .catch(() => { /* the next poll will carry it */ });
  }

  const replay = termState.serialize();
  if (replay) ws.send(Buffer.from(replay, 'utf8'), { binary: true });

  ws.on('message', (raw, isBinary) => {
    // Control frames arrive as JSON; everything else is raw keystrokes.
    if (!isBinary) {
      const text = raw.toString();
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'resize') {
            term.resize(msg.cols, msg.rows);
            termState.resize(msg.cols, msg.rows);
            return;
          }
          if (msg.type === 'drop') {
      handleDrop(msg, ws);
      return;
    }
    if (msg.type === 'health') {
            // Caught: an unhandled rejection terminates Node by default.
            runHealth().catch(() => {});   // broadcasts on start and on finish
            return;
          }
          if (msg.type === 'input') {
            term.write(msg.data);
            return;
          }
          if (msg.type === 'models') {
            // Asynchronous and yielding for the same reason the fog read is:
            // the loop here also accepts the hook helper's named-pipe
            // connection, and it gives up after 80ms.
            currentCatalogue({ force: !!msg.force }).then(
              (c) => ws.send(JSON.stringify({
                type: 'models', models: c.models, source: c.source,
                fetchedAt: c.fetchedAt, stale: c.stale, error: c.error,
                seats: readSeats(), max: MAX_SEATS, warnings: seatWarnings(readSeats()),
              })),
              (err) => {
                // Tell the CLIENT, not only the log. A silent failure leaves
                // the panel reading "loading..." forever, which looks like a
                // slow host rather than a lost answer.
                console.log('[host] catalogue failed:', err.message);
                try {
                  ws.send(JSON.stringify({
                    type: 'models', models: [], source: 'none', stale: true,
                    error: err.message, seats: readSeats(), max: MAX_SEATS, warnings: [],
                  }));
                } catch { /* the socket went away */ }
              }
            );
            return;
          }
          if (msg.type === 'seat') {
            // add / remove. The RESULT is broadcast rather than returned to the
            // asking client alone: two windows on one project share a council,
            // and one of them silently disagreeing about who is seated is worse
            // than a redraw.
            const before = readSeats();
            let seats = before;
            let error = null;
            if (msg.action === 'remove') {
              seats = removeSeat(before, msg.id);
            } else {
              const model = (msg.model && typeof msg.model === 'object') ? msg.model : null;
              const r = addSeat(before, model);
              seats = r.seats;
              error = r.error;
            }
            if (seats !== before) store.write('council', { seats });
            broadcastControl({ ...seatPayload(seats), error });
            return;
          }
          if (msg.type === 'fog') {
            // Answered on demand, asynchronously, yielding as it goes -- the
            // read must never hold the loop past the helper's 80ms connect
            // timeout, or it drops the hook events this panel is drawn from.
            currentFog().then(
              fog => ws.send(JSON.stringify({ type: 'fog', ...fog })),
              err => {
                // Tell the CLIENT, not just the log. A silent failure left the
                // panel reading "reading the map..." forever, which looks like
                // a slow host rather than a lost answer.
                console.log('[host] fog read failed:', err.message);
                try {
                  ws.send(JSON.stringify({ type: 'fog', files: [], explored: 0, total: 0,
                    status: { failed: true, error: err.message } }));
                } catch { /* the client went away */ }
              });
            return;
          }
        } catch {
          // Not control JSON — fall through and treat as literal input.
        }
      }
      term.write(text);
      return;
    }
    term.write(raw.toString('utf8'));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[host] client detached (${clients.size} remain)`);
    // NOTE: the pty deliberately keeps running. This is the detachable-session
    // property the phone/Remote Control workflow depends on.
  });
});

console.log(`[host] listening on ws://127.0.0.1:${PORT}`);

// A test run outlives the host unless it is killed here. With shell:true the
// child is cmd.exe, so an orphaned npm/node keeps running with no parent and
// no window -- invisible, and still holding the repo's build output.
function shutdown() {
  try { term.kill(); } catch {}
  killTree(healthChild);
  if (hookBridge) { hookBridge.close().catch(() => {}); }
}

// SIGINT is not how this host usually dies: main.js spawns it DETACHED so it
// survives the window closing. SIGTERM and exit are the paths that actually
// fire, and leaving them unhandled is what orphans the child.
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', () => { killTree(healthChild); });

