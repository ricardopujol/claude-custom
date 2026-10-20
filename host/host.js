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
const { writeHarnessSettings, buildClaudeArgs, findUserStatusLine, findUserTheme } = require('./settings-writer');
const { claudeConfigDir, setConfigAnchor } = require('./claude-config-dir');
const { createHookBridge } = require('./hook-bridge');
const { createTerminalState } = require('./terminal-state');
const { killTree, killPidTree } = require('./kill-tree');
const { createMoodMachine } = require('./mood-machine');
const { resolveTheme } = require('./themes');
const { portraitFor, globalPortrait } = require('./portraits');
const { userGlobalDir, migrationCandidates, adoptOnStart } = require('./global-portrait-store');
const { handlePortraitMessage, handleGlobalPortraitMessage } = require('./portrait-upload');
const { watchGlobalDir } = require('./global-watch');
const { createHiddenAgents, validRosterMsg } = require('./hidden-agents');
const { createMedals } = require('./medals');
const { createUsageCounters } = require('./usage-counters');
const { validGive, validRemove } = require('../app/medals-display');
const { createBubbles, createBubbleSettings } = require('./bubbles');
const { createBubbleGate } = require('./bubble-gate');
const { createActivity: createBubbleActivity } = require('./bubble-activity');
const { createVoiceReader } = require('./bubble-voice');
const { createAskOllama } = require('./ask-ollama');
const { createChangeWatch } = require('./state-watch');
const { readUsage, EMPTY } = require('./usage');
const { readAgentStats, createStatsMemo } = require('./agent-stats');
const { createLogSession } = require('./agent-log-session');
const { wholeRoster, scanProjects } = require('./roster-index');
const { lifetimeAgentTokens, readCacheSeed } = require('./agent-stats-cache');
const { readSessionModel, defaultProjectsDir, createSessionModelRefresher } = require('./session-model');
const { createProcessesBroadcast } = require('./processes-broadcast');
const { projectDirName } = require('./project-dir');
const { projectLabel } = require('./project-path');
const { currentBranch } = require('./git-branch');
const { readHistory, readOrigin } = require('./git-history');
const { readGraph, createGitGraphService } = require('./git-graph');
const { loadLedger, updateLedger, saveLedger } = require('./branch-ledger');
const { readOpenPrs, parseOpenPrs } = require('./open-prs');
const { readSeams, announce, fixtureReader } = require('./probe-seams');
const { createReader: createReviewReader } = require('./review-reports');
const { createGitTreeService, ledgerFileFor } = require('./git-tree-service');
const { loadCatalogue } = require('./openrouter');
const { normalizeCatalogue } = require('./models');
const { createCatalogueCache } = require('./catalogue-cache');
const { addSeat, removeSeat, seatWarnings, MAX_SEATS } = require('./seats');
const { backgroundFor } = require('./background');
const { setBackground, resetBackground, resolveStyle, setLook, setMode, readLook, seedLookIfNew, rerollLook, matchLook } = require('./style');
const { hasClaudeHistory } = require('./recent');
const { projectRoots } = require('./project-roots');
const { applyLook, cliThemeFor } = require('./look');
const { createProcessTracker } = require('./processes');
const { createStore } = require('./store');
const { createBugVault, applyVaultAction } = require('./bugvault');
const { parsePermissionMode, MODES } = require('./mode');
const { readSessionHook, readStatus, readContext, readStatusFields } = require('./hook-session');
const { buildProviderEnv, describeProvider } = require('./providers');
const { createCooldowns } = require('./cooldowns');
const { createLoadoutControl } = require('./loadout-control');
const { watchLoadout } = require('./loadout-watch');
const { createWandControl } = require('./wand-control');
const { discoverSkills, claudeHomeOf, isSkillEvent } = require('./wand-skills');
const { watchDir } = require('./wand-watch');
const { createCanvasControl } = require('./canvas-control');
const { canvasMcpEnabled } = require('./canvas-settings');
const { validResizeDims, handleFrame, validAgentLogRequest, raiseTargets, idleStopVerdict, leftAsWindow,
        CONTROL_TYPES, isControlClient } = require('./control');
const { acceptOverride } = require('./layout-override');
const { readQuota, createQuotaAnnouncer } = require('./quota');
const { createHostQuota, recordModWindows } = require('./quota-share');
const { createModServer } = require('./mod-feed');
const { createContextSource } = require('./context-source');
const { modEnabled, modPluginDirFor, modOffReason, readCliVersion } = require('./cc-mod-settings');
const { createModRecordHandler } = require('./mod-records');
const { planDrop, quote, MAX_DROP_FILES } = require('./drop');
const { createAttention } = require('./attention');
const { createTurnState } = require('./turn-state');
const { createPromptKeeper } = require('./prompt-keeper');
const { createBedtime, isBedtimeOnly } = require('./bedtime-state');
const { createNightStatus } = require('./night-status');
const { createSchedulesControl, isSchedulesOnly } = require('./schedules-control');
const { countNightPrs } = require('./night-prs');
const { createSummaryService, TICK_MS } = require('./summary-service');
const { createScheduler } = require('./summary-scheduler');
const { createSlot } = require('./summary-slot');
const { createOllamaClient } = require('./summary-ollama');
const { createSummaryStore } = require('./summary-store');
const { createPowerProbe } = require('./summary-power');
const { createLeanGate } = require('./lean-gate');
const { createDriftService, TICK_MS: DRIFT_TICK_MS, GENERATE_TIMEOUT_MS: DRIFT_GENERATE_MS } = require('./drift-service');
const { createDriftStore } = require('./drift-store');
const { createDriftGit } = require('./drift-git');
const { readDocsDir } = require('./drift-docs-fs');
const { milestoneFor, nextMilestone, progressTo, describeSpend,
        createAnnouncer } = require('./milestones');
const { detectRunner, parseResults, healthFrom } = require('./health');
const { createCappedBuffer } = require('./capped-buffer');
const { readFog } = require('./fog');
const { createRepoService } = require('./repo-service');
// "Ask the repo" (BACKLOG #33): the panel's questions and explanations, answered from this worktree's index (host/ask-service.js).
const { createAskService, createRepoFactory, EXPLAINER_AGENT } = require('./ask-service');
const { createExplainer: createAskExplainer } = require('./ask-explainer');
const { createAskCounts } = require('./ask-counts');
const { createIndex: createAskIndex } = require('./ask-index');
const { createClaudeAnswerer } = require('./ask-claude');
const { createModels: createAskModels } = require('./ask-models');
const { allowConnection, newToken } = require('./gatekeeper');
const { portForCwd } = require('./port-for-project');
const { writeIdentity, fileFor, readIdentity, readTokenFile } = require('./host-identity');
const { pickerPayload, createProjectsReader } = require('./project-picker');
const { resolveLaunchTarget } = require('./launch-target');
const { samePath } = require('./project-path');
const { lockPathFor, acquire: acquireSessionLock, release: releaseSessionLock,
        updateOwn: updateSessionLock, readHolder } = require('./session-lock');
const { createSelfStartTime, isAlive: procAlive, startTimes } = require('./proc-start');
// BACKLOG #81: a tab's read-only side session is a host of its own (host/side-session.js).
const { isSideEnv, siblingSessions } = require('./side-session');
const { identitiesIn } = require('./background-hosts');
// Worktree occupancy (backlog #44 + #47): which worktree each of this session's subagents is working in,
// as claim files the other windows read. See host/occupancy-producer.js.
const { createOccupancyProducer, isOccupancyOnly, teammateFromMeta, withoutFileText } = require('./occupancy-producer');
const { createClaimWriter, occupancyDir, sweepDead } = require('./occupancy-store');
const { judge: judgeClaims } = require('./occupancy-live');
const { createRootsProvider } = require('./worktree-roots');
const { readLock } = require('./lock-breaker');
// The one-shot client for ANOTHER host's controls; `sendControl` below is ours to our windows.
const { sendControl: sendHostControl } = require('./host-client');
const { stopHolder } = require('./stop-holder');
const { windowCount } = require('./window-count');
const { gateFromAcquire, gateOverride, gateOnBootError, gateAfterRecheck, gateRecheck, createIdleWatch } =
  require('./session-gate');
const { liveSessionsIn } = require('./session-registry');
const { worktreeEnv, worktreeRoot } = require('./worktree-env');
const { allocate: allocatePortBlock, excludedRanges } = require('./port-blocks');
const { branchHealth } = require('./branch-health');

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
// A relative CLAUDE_CONFIG_DIR means a folder under THIS tab's cwd (where its `claude` runs), not the host process's.
setConfigAnchor(CWD);
// CWD is this tab's worktree: the pty, the session lock and everything git.
// PROJECT_ROOT and STATE_ROOT are the project's (theme, label / look, style):
// one set shared by every tab of a container. For a flat repo all three are
// one folder (host/project-roots.js).
const { projectRoot: PROJECT_ROOT, stateRoot: STATE_ROOT } = projectRoots(process.env, CWD);

// Derived from the project, so two projects can be open at once and reopening
// a window finds the host it left running. An explicit CLAUDE_CUSTOM_PORT still
// wins -- main.js sets it, having already resolved collisions by probing, and
// the probe's answer must not be second-guessed here.
const PORT = Number(process.env.CLAUDE_CUSTOM_PORT) || portForCwd(CWD);

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

// killTree moved to host/kill-tree.js (Miguel, PR #61 review H3): a probe
// needed the exact same "kill the whole tree, not just the top pid" guarantee
// and was about to reimplement a thinner copy of it. That module is now the
// single source of truth; both this file and verify/ probes require it.

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

// Attached only once the native helper exists (step 2). Wiring hooks to a
// missing binary would fire on every Task and Bash call and invoke nothing.
const helperExists = fs.existsSync(HELPER_PATH);
// Claude's panel's MCP server (BACKLOG #71, host/canvas-mcp.js) rides in on --mcp-config, added to the user's own servers, unless the
// setting (host/canvas-settings.js) turns it off. It learns its session through this host's pointer file, which the control keeps.
const CANVAS_POINTER_FILE = path.join(HARNESS_DIR, 'state', 'canvas', `_tab-${PORT}.json`);
const canvasMcp = helperExists && canvasMcpEnabled({ env: process.env, stateDir: path.join(HARNESS_DIR, 'state') })
  ? { nodePath: process.versions.electron ? 'node' : process.execPath, scriptPath: path.join(__dirname, 'canvas-mcp.js'),
    root: path.join(HARNESS_DIR, 'state'), pointerFile: CANVAS_POINTER_FILE }
  : null;
// A side host runs claude in plan mode, takes no session lock (below) and says so in its identity, so it never holds the
// worktree's writer role and the port walk never mistakes it for the folder's own host.
const SIDE = isSideEnv(process.env);
// This build's identity files: which other hosts serve this folder (a side host and the folder's own host see each other).
const INSTALL = path.join(__dirname, '..');
function ownIdentities() {
  try { return identitiesIn(INSTALL); } catch { return []; }
}

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
// FF7's other two tiers. Both are PER-INSTALL: HARNESS_DIR sits beside this
// file, not in the project folder, so an upload made in one project shows in
// every project -- an agent is the same character everywhere (Ricardo,
// 2026-09-28, after Dexter F7 / Miguel I3 caught this comment claiming
// "per-project"). Each worktree checkout has its own. SHIPPED_DIR's
// app/assets/portrait-default.* does not exist on disk
// today, deliberately, so most installs land on the text placeholder until
// someone adds one.
// CLAUDE_CUSTOM_UPLOADS lets a probe point the uploads at a throwaway folder
// instead of the developer's real pictures (Miguel I1, PR #64).
const UPLOADS_DIR = process.env.CLAUDE_CUSTOM_UPLOADS || path.join(HARNESS_DIR, 'portraits');
const SHIPPED_DIR = path.join(__dirname, '..', 'app', 'assets');
// The default agent picture is USER-WIDE (BACKLOG #3, Ricardo 2026-10-09): one folder in the user
// profile for every project, worktree and install, not UPLOADS_DIR's per-install `_global`. The
// first run with none there adopts the newest per-install one (a copy; the old files stay).
const GLOBAL_PORTRAIT_DIR = userGlobalDir({ env: process.env, home: os.homedir() });
// Assumes the repo layout: each checkout (dev, feat-*) keeps its pictures in <checkout>/.harness/portraits.
// Best effort and one-shot (a Reset is remembered); a probe's override keeps it inside its own folder.
adoptOnStart({
  userDir: GLOBAL_PORTRAIT_DIR,
  candidateDirs: () => migrationCandidates({ env: process.env, uploadsDir: UPLOADS_DIR, hostDir: __dirname }),
  log: (line) => console.log(line),
});
const theme = resolveTheme(PROJECT_ROOT, { registryDir: REGISTRY_DIR });
console.log('[host] theme          :', theme.name);

const mood = createMoodMachine();
const processes = createProcessTracker();
const store = createStore({ dir: path.join(HARNESS_DIR, 'state') });
const usageCounters = createUsageCounters({ store, log: (...a) => console.log(...a) });      // invisible: which features get used (scripts/usage-report.js); above its users (canvasControl's emit)
// The Git panel's data. The branch ledger is the PROJECT's (every tab of it shares one), so it
// lives in <project>\.claude-custom\ beside the look, behind the same `*` .gitignore, and never
// through a linked folder (ledgerFileFor).
// Probe seams (host/probe-seams.js), unset in real use: a file of `gh pr list` JSON stands in for
// gh, and the transcripts and the review reports come from the probe's own folders. Logged when set.
const seams = readSeams(process.env);
announce(seams, (line) => console.log(line));
const gitTree = createGitTreeService({
  cwd: CWD, projectRoot: PROJECT_ROOT, projectsDir: seams.projectsDir || defaultProjectsDir(),
  ledgerFile: () => ledgerFileFor(STATE_ROOT),
  readHistory, loadLedger, updateLedger, saveLedger, currentBranch, now: Date.now,
  readOpenPrs: seams.openPrsFixture
    ? fixtureReader(seams.openPrsFixture, { parse: parseOpenPrs, log: (line) => console.log(line) })
    : readOpenPrs,
  // The drawer (Enhancement #46): origin's URL for *Open PR*, and ~/.claude/reviews/<project>/ verdicts.
  readRemote: readOrigin,
  readReviews: createReviewReader({ project: projectLabel(PROJECT_ROOT), reviewsRoot: seams.reviewsDir || undefined }),
});
// The Git panel's Graph view: the last 50 commits of develop, main and the open branches, with their lanes.
const gitGraph = createGitGraphService({ cwd: CWD, read: readGraph });
// The repo browser and code reader (#45 / #32): list / overlay / read / stat / diff for THIS host's worktree
// (host/repo-service.js). The watch starts on the first ask; a change is announced to every window.
const repoService = createRepoService({
  root: CWD, projectsDir: seams.projectsDir || undefined, announce: (msg) => broadcastControl(msg),
});
// The `ask` conversation (BACKLOG #33). Local answers come from Ollama; a Claude model answers through the real claude CLI on the
// person's plan (host/ask-claude.js: no tools, no API key in its environment). The index is per worktree, kept under the harness state.
const askOllama = createAskOllama({ baseUrl: seams.ollamaUrl || undefined });
const askIndex = createAskIndex({ dir: seams.askIndexDir || path.join(HARNESS_DIR, 'state', 'ask-index'), embed: (t) => askOllama.embed(t), embedModel: askOllama.embedModel });
const askClaude = createClaudeAnswerer({ claudeBin: CLAUDE_BIN, anchor: CWD });
// The explainer joins the roster (BACKLOG #33 gamification): its live state (host/ask-explainer.js, told by the service what happened) and its
// two counts (host/ask-counts.js, install-wide like the medals). Every window of this host gets them as an `explainer` frame; the page puts it
// on the roster only once the person has named it.
const askExplainer = createAskExplainer();
const askCounts = createAskCounts({ store });
const explainerFrame = () => {
  const s = askExplainer.snapshot();
  return { type: 'explainer', state: s.state, detail: s.detail, panels: s.panels, counts: askCounts.read(), portrait: describe(EXPLAINER_AGENT, s.state, s.detail).portrait };
};
const broadcastExplainer = () => broadcastControl(explainerFrame());
askExplainer.on('change', broadcastExplainer);
// The counts are install-wide and another tab's host may raise them: tell OUR windows (polled from the 1 s clock, like the medals).
const askCountsWatch = createChangeWatch({ read: () => askCounts.read(), onChange: broadcastExplainer });
const askService = createAskService({
  log: (...a) => console.log(...a), explainer: askExplainer, counts: askCounts, onCounts: () => { askCountsWatch.note(askCounts.read()); broadcastExplainer(); },
  cwd: CWD, index: askIndex, ollama: askOllama, claude: askClaude,
  models: createAskModels({ localModel: askOllama.answerModel, readRecord: seams.askRecord ? () => fs.readFileSync(seams.askRecord, 'utf8') : undefined }),
  repoFor: createRepoFactory({ index: askIndex, ollama: askOllama, claude: askClaude }),
  // the explainer's picture is an agent's picture: uploaded through `portrait set`, chosen from the forge's generated agents
  portraitOf: (agent, state) => portraitOf(agent, state),
  forgeAgents: () => fs.readdirSync(PORTRAITS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name).sort(),
});
const cooldowns = createCooldowns({ store });
const loadoutControl = createLoadoutControl({ store });
// The loadout is install-wide and another host may change it: tell OUR windows.
// The frame is QUIET (host/loadout-control.js changed()), so it never touches a
// refusal on screen. PR #68, Dexter F1.
watchLoadout({
  dir: path.join(HARNESS_DIR, 'state'),
  onChange: () => {
    const frame = loadoutControl.changed();
    if (frame) broadcastControl(frame);
  },
});
// Claude's panel (BACKLOG #71): the page the running Claude builds for it, and the hosts the person approved for it, live in
// .harness/state/canvas/<cli-session-id>/ (host/canvas-store.js). The session id arrives with the SessionStart hook, which
// re-points the watch (sessionChanged); the page itself is only sent to a window that asks for it (host/canvas-control.js).
const canvasControl = createCanvasControl({
  stateDir: path.join(HARNESS_DIR, 'state'),
  getSessionId: () => sessionId,
  emit: (frame) => { if (frame && frame.type === 'canvas' && frame.changed === true) usageCounters.bump('canvas:render'); broadcastControl(frame); },
  watch: watchDir,
  log: (line) => console.log(line),
  pointerFile: canvasMcp ? CANVAS_POINTER_FILE : null,        // no tools offered, no pointer to keep (PR #125 Miguel S5)
});
// The wand (BACKLOG #51): favourite skills as emoji buttons, .harness/state/wand.json, install-wide. The skill
// list is read from the CLI's own directories (host/wand-skills.js); the claude-home override is a probe seam
// (host/probe-seams.js), unset in real use.
const CLAUDE_HOME = claudeHomeOf({ seam: seams.claudeHome, env: process.env, home: os.homedir() });
// The control logs what is broken once per breakage (a debounced rescan finds the same file again).
// `emit`: a busy read of wand.json is looked at again shortly, and what it finds is broadcast (host/wand-control.js).
const wandControl = createWandControl({ store, log: (line) => console.log(line), emit: (frame) => broadcastControl(frame),
  readSkills: () => discoverSkills({ claudeHome: CLAUDE_HOME, projectDir: CWD }) });
// The wand watches the state file (another host's edit) and the skill directories (a skill added while the
// harness runs). Both frames are QUIET, so neither touches a refusal on screen. The CLI's directories are
// watched, never created: only the state dir is ours.
watchDir({
  dir: path.join(HARNESS_DIR, 'state'),
  create: true,
  match: (f) => f === 'wand.json',
  onChange: () => {
    const frame = wandControl.changed();
    if (frame) broadcastControl(frame);
  },
});
const onSkillsChanged = () => {
  const frame = wandControl.skillsChanged();
  if (frame) broadcastControl(frame);
};
watchDir({ dir: path.join(CLAUDE_HOME, 'skills'), recursive: true, match: isSkillEvent, onChange: onSkillsChanged });
watchDir({ dir: path.join(CLAUDE_HOME, 'plugins'), match: (f) => f === 'installed_plugins.json', onChange: onSkillsChanged });
// a plugin switched on or off in settings.json changes which plugin skills exist
watchDir({ dir: CLAUDE_HOME, match: (f) => f === 'settings.json', onChange: onSkillsChanged });
watchDir({ dir: path.join(CWD, '.claude', 'skills'), recursive: true, match: isSkillEvent, onChange: onSkillsChanged });
// One record per distinct bug CLASS, so a recurring defect category is a
// visible count instead of a memory hand-carried between review rounds in PR
// comments. Persisted through the shared store under `vault.json`, same as
// every other feature -- this module invents no file format of its own.
// `project: CWD` stamps each record with where it was filed from. The vault
// itself stays install-wide -- the seed data settles that, since four of its
// six entries come from another project entirely -- but a record with no
// attribution cannot be given one later, so the field goes in now while it is
// one line rather than an archaeology problem.
const bugVault = createBugVault({ store, project: CWD });
// BACKLOG #14: agents the user has hidden from the Active roster, per project.
// The host is authoritative -- see host/hidden-agents.js.
const hiddenAgents = createHiddenAgents({ store, project: CWD });
// Dexter F2: this is called while building the `hello` frame inside
// `wss.on('connection')`, which has NO catch above it -- unlike control-frame
// dispatch, which `handleFrame` wraps. The host owns the pty, so a throw here
// killed the running Claude session, and because it is on the attach path the
// shape was "every window you open kills the session". `payload()` is total by
// construction; see host/bugvault.js.
const vaultPayload = () => bugVault.payload();
// The agent list comes from the mood stack, so a finished turn can say how
// many agents ran rather than just that something ended.
// Tracks whether a cooldown list was last non-empty, so the falling edge is
// broadcast too. Without it the panel is never told the list emptied and the
// final row stays on screen.
let cooldownsWere = 0;

// FF21: the header's "project/branch" label. Polled rather than watched -- a
// checkout is a human-paced action, and `fs.watch` on `.git/HEAD` fires on
// every commit too, which is not a branch change. Tracks the last VALUE, not
// just truthiness, so a branch-to-branch switch broadcasts (cooldowns only
// needed the falling edge; this needs every edge).
let branchWas = currentBranch(CWD);

const attention = createAttention({
  project: path.basename(CWD),
  agents: () => mood.stack(),
});
attention.on('attention', e => broadcastControl({ type: 'attention', ...e }));
// Is a main-session turn running, or a dialog open? Measured from the CLI's hooks only (PR #93 Dexter F1/F2):
// the Git drawer's Type /merged types into this session, and the subagent roster can't see a turn with no
// agent in it. null until SessionStart: a host without hooks never claims idle.
const turnState = createTurnState();
// Backlog #49: the main session's latest prompt, for the terminal bar. A reconnecting window gets it in `hello`.
const promptKeeper = createPromptKeeper();

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
// The ONE portrait lookup in this file, carrying all three tiers: the Inactive
// tab's call sites once passed only portraitsDir, so an upload showed there as
// "no picture yet" (Dexter F2, PR #35; pinned by test/portrait-upload.test.js).
const portraitOf = (agent, state, baseState) => portraitFor(agent, state, {
  portraitsDir: PORTRAITS_DIR, uploadsDir: UPLOADS_DIR, shippedDir: SHIPPED_DIR, globalDir: GLOBAL_PORTRAIT_DIR, baseState,
});
// `detail` is the card's finer state (BACKLOG #55: reading, waiting, stuck ...); its portrait falls back to the
// nearest of the four (host/portraits.js NEAREST_STATE). `state` stays what every older consumer reads.
const describe = (agent, state, detail) => {
  const d = detail || state;
  return { agent, state, detail: d, portrait: portraitOf(agent, d, state) };
};

// Generated once per project folder and reused by every context window on it.
const BACKGROUNDS_DIR = process.env.CLAUDE_CUSTOM_BACKGROUNDS || path.join(__dirname, '..', 'backgrounds');
const background = backgroundFor(PROJECT_ROOT, { dir: BACKGROUNDS_DIR });
console.log('[host] background     :', path.basename(background.path), background.created ? '(new)' : '(existing)');

// Backlog #15: a NEW project -- no look.json and no Claude history for the
// folder -- gets a random, contrast-checked look, once, here at startup and
// before the CLI is spawned (the spawn is what creates the history). Every
// other state is left exactly as found; host/style.js seedLookIfNew decides.
try {
  const seeded = seedLookIfNew({ cwd: STATE_ROOT, hasHistory: () => hasClaudeHistory(STATE_ROOT),
    terminalForeground: theme.terminal && theme.terminal.foreground });
  console.log('[host] look seed      :', seeded.seeded ? `new project, generated ${seeded.look.appColor}` : seeded.reason);
} catch (err) {
  console.log('[host] look seed failed:', err && err.message);
}

// The theme the CLI is STARTED with: it reads it once, so a later flip of the project's mode shows in the Style tab
// as "switches next time" until the next launch (app/style-display.js coloursSectionView).
// The person's own theme (null: none found) keeps its daltonized / ANSI family across a flip, and is what an old project
// with no chosen mode is running, so the Style tab can tell when a flip differs from it.
const USER_CLI_THEME = findUserTheme({ configDir: claudeConfigDir(), cwd: CWD });
const LAUNCH_CLI_THEME = cliThemeFor(readLook(STATE_ROOT), USER_CLI_THEME);
const RUNNING_CLI_THEME = LAUNCH_CLI_THEME || USER_CLI_THEME;

// PORT-KEYED. The contents name this host's own pipe, so the filename has to
// be this host's too -- otherwise a second host starting during this one's
// module init redirects our claude's hooks into its bridge. See the header of
// writeHarnessSettings; the shared copy is still written for the probes.
//
// The statusLine relay is FF12's truth source (see host/status-relay.js). It
// runs under `node` from PATH -- this process's execPath is electron, which
// is only node with ELECTRON_RUN_AS_NODE set, and that must not be relied on
// in the pty. Under plain node (the probes) the exact binary is used instead.
const settingsFile = writeHarnessSettings(HARNESS_DIR, {
  helperPath: HELPER_PATH,
  // BACKLOG #25: the CLI's colour theme follows the project's mode, read AFTER the new-project seed above so a
  // project that has just been given a random look starts its CLI in the matching theme. Null: leave the CLI alone.
  theme: LAUNCH_CLI_THEME,
  pipeName: PIPE_NAME,
  // Read/Edit/Write/NotebookEdit PreToolUse, for the occupancy claim only (consumed below, never forwarded).
  occupancy: true,
  // ScheduleWakeup Pre + Post, for the bedtime night only (consumed below, never forwarded).
  bedtime: true,
  // CronCreate / CronDelete Pre + Post, for the Schedules panel only (consumed below, never forwarded).
  schedules: true,
  // PermissionRequest, observe-only, so "waiting on you" can name the agent (BACKLOG #55; host/settings-writer.js).
  permissionRequest: true,
  statusRelay: {
    nodePath: process.versions.electron ? 'node' : process.execPath,
    scriptPath: path.join(__dirname, 'status-relay.js'),
    userStatusLine: findUserStatusLine({ configDir: claudeConfigDir(), cwd: CWD }),
    // BACKLOG #27: "status line in the header" quiets the CLI's row. Written by
    // app/window-chrome-bridge.js into the same install-wide state dir.
    quietWhen: path.join(HARNESS_DIR, 'state', 'chrome-global.json'),
  },
  // The tool belt (BACKLOG #17): rewrites an Agent spawn from state/loadout.json.
  // Same node-from-PATH reasoning as the relay above; the hook re-reads the file
  // on every spawn, so an equip needs no restart.
  loadoutHook: {
    nodePath: process.versions.electron ? 'node' : process.execPath,
    scriptPath: path.join(__dirname, 'loadout-hook.js'),
    stateDir: path.join(HARNESS_DIR, 'state'),
  },
}, PORT);
const ARGS_OPTIONS = { settingsFile, helperExists, canvasMcp, side: SIDE };
// Rebuilt once, at boot, with the claude-custom mod when its switch, the CLI's version and its directory allow it (prepareMod below).
let ARGS = buildClaudeArgs(ARGS_OPTIONS);

// The project's own look -- colours, darkness and an optional background copy
// in <CWD>/.claude-custom/ (host/style.js). Resolved fresh on every read, so a
// look edited from another window of the same folder is what this one sends.
// Falls back to the generated background above whenever there is no copy.
// `theme` is the registry theme with the look merged in (host/look.js), so the
// view paints a look with the same applyTheme it paints a registry theme with.
function currentStyle() {
  const r = resolveStyle(STATE_ROOT, background.path);
  return {
    background: r.background, source: r.source, kind: r.kind, setAt: r.setAt, look: r.look,
    cliTheme: RUNNING_CLI_THEME,
    theme: applyLook(theme, r.look),
  };
}

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
const quotaAnnouncer = createQuotaAnnouncer();
// ONE host per machine polls the usage endpoint (a lease in ~/.claude-custom, per account); every
// host, this one included, shows what the shared file says. BACKLOG #83, host/quota-share.js.
const hostQuota = createHostQuota({
  readQuota,
  log: (m) => console.log('[host]', m),
  onQuota: (q) => { lastQuota = q; checkQuotaWarning(q); },
});

function refreshQuota() { return hostQuota.refresh(); }

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
// One writer to the pty, one line at a time.
//
// The first version used a per-drop `setTimeout` chain at 350ms intervals, which
// is an open-loop guess wearing a mechanism's clothes: two drops 100ms apart
// interleaved, and 25 files from 25 folders put the prompt text 8.75 SECONDS
// after the first grant, with every user keystroke landing in between. A fixed
// delay is not a completion signal.
//
// This is not a completion signal either -- the honest fix watches the TUI's own
// acknowledgement through term.onData -- but it is at least ONE ordering for the
// whole host rather than one per gesture, and it makes the interleaving
// impossible. The remaining risk is a slow TUI, which is recorded rather than
// pretended away.
const PTY_LINE_GAP_MS = 350;
const CTRL_U = String.fromCharCode(21);      // clear the input line
const ptyQueue = [];
let ptyDraining = false;

function enqueuePty(text) {
  ptyQueue.push(text);
  if (ptyDraining) return;
  ptyDraining = true;
  const step = () => {
    const next = ptyQueue.shift();
    if (next === undefined) { ptyDraining = false; return; }
    // A window the session lock blocked has no pty yet: nothing to type into.
    if (!term) { console.log('[host] no session yet; dropped a queued pty line'); setTimeout(step, 0); return; }
    try { term.write(next); } catch (err) {
      console.log('[host] pty write failed:', err && err.message);
    }
    setTimeout(step, PTY_LINE_GAP_MS);
  };
  step();
}

function handleDrop(msg, ws) {
  const entries = Array.isArray(msg.entries) ? msg.entries : [];
  if (!entries.length) return;

  // SLICED BEFORE STATTING. `statSync` is synchronous and this loop runs on the
  // one event loop that must accept the hook helper's named-pipe connection
  // inside 80ms; a client sending 10,000 entries would otherwise do 10,000
  // blocking stats, and a single unreachable UNC path blocks for seconds.
  const capped = entries.slice(0, MAX_DROP_FILES);

  // REALPATH, not just stat. A symlink or junction defeats every refusal in
  // planDrop, because the string it judges is innocent and the target is not:
  // `mklink /J C:\tmp\notes.txt C:\Users\ricar` needs no elevation, and
  // statSync FOLLOWS it, so the old code learned the type from the filesystem
  // and then granted the link path -- which the CLI resolves back to the home
  // directory this module swears it never grants. Dexter, 2026-09-17.
  const resolved = capped.map((e) => {
    const raw = typeof e.path === 'string' ? e.path : '';
    let real = raw;
    let isDirectory = !!e.isDirectory;      // the renderer's hint, a File guess
    try {
      real = fs.realpathSync.native(raw);
      isDirectory = fs.statSync(real).isDirectory();
    } catch { /* vanished or unreadable: judge the raw path, which fails closed */ }
    return { path: real, isDirectory };
  });

  const plan = planDrop({
    entries: resolved,
    cwd: CWD,
    alreadyGranted: grantedDirs,
    home: os.homedir(),
    configDir: claudeConfigDir(),
  });

  for (const r of plan.refused) console.log('[host] drop refused  :', r.dir, '-', r.why);

  // A SINGLE SERIALISED QUEUE, not a setTimeout chain per drop. Two drops
  // 100ms apart used to interleave -- drop B's grant landing between drop A's
  // grant and A's path text -- which is exactly the race the delay was meant to
  // prevent. One writer, one line at a time, in order.
  const granted = [];
  for (const dir of plan.dirsToAdd) {
    // QUOTED. `/add-dir C:\Users\ricar\Documents Backup` unquoted grants
    // `...\Documents` -- a strict superset of what was dragged, on a path shape
    // that is entirely ordinary on Windows. The module already had `quote()`
    // for the prompt text and the grant path never called it. Dexter, 2026-09-17.
    //
    // LINE-CLEARED FIRST (Ctrl+U). Typed blind onto a prompt the user has
    // already started, `/add-dir ...` does not begin with `/` any more -- so the
    // CR submits their half-written message to the model and grants nothing.
    enqueuePty(CTRL_U + '/add-dir ' + quote(dir) + '\r');
    granted.push(dir);
  }
  if (plan.text) enqueuePty(plan.text);

  // Recorded only for what we actually tried to write, and described as
  // REQUESTED rather than granted: nothing here can confirm the CLI accepted
  // the command, and telling the user their read scope widened when it did not
  // corrodes trust exactly as fast as the reverse.
  for (const dir of granted) {
    grantedDirs.push(dir);
    console.log('[host] drop requests :', dir);
  }

  const note = {
    requested: granted,
    refused: plan.refused,
    truncated: plan.truncated + Math.max(0, entries.length - capped.length),
    unusable: plan.unusable,
  };
  if (granted.length || plan.refused.length || note.truncated || note.unusable) {
    // BROADCAST, not sent to one socket. Two windows can be attached to one
    // host; the other one's user watches the session's read scope widen with no
    // notice at all.
    broadcastControl({ type: 'dropped', note });
  }
  void ws;
}

// Dropping a file on an agent's face uploads a portrait for its CURRENT
// state: {type:'portrait', action:'set', agent, state, path}. The decision
// (extension, size, path safety) and the copy itself both live in
// host/portrait-upload.js, tested in isolation; this is only the wiring.
//
// BROADCAST, like the drop note above and the seat result below it in
// dispatchControl -- two windows on one project share a roster, and one of
// them silently disagreeing about whose upload just landed, or why one was
// refused, is worse than a redraw.
// What the Style tab's "Default agent picture" row shows: set or not, never
// blank, and the file's own name so the row can say where the picture came from.
function globalPortraitInfo() {
  const g = globalPortrait(GLOBAL_PORTRAIT_DIR);
  return g ? { set: true, file: g.file, media: g.media } : { set: false, file: null, media: null };
}

// A file-tier change under _global alters what EVERY face without its own
// picture resolves to, so re-describe all of them rather than guessing which.
function repaintAllPortraits() {
  for (const r of mood.roster()) broadcastControl({ type: 'mood', ...describe(r.agent, r.state, r.detail) });
  lastRosterIndex = {
    ...lastRosterIndex,
    agents: lastRosterIndex.agents.map(a => ({ ...a, portrait: portraitOf(a.agent, 'sleeping') })),
  };
  broadcastControl({ type: 'rosterIndex', rosterIndex: lastRosterIndex });
}

// Every project window is its own host, but the global picture is user-wide:
// a change to the global picture made in ANOTHER window must reach this one, or
// its idle faces keep pointing at a deleted file (Dexter F3, PR #64). `quiet`
// tells the renderer to update the Style row without announcing a change this
// window's user did not make.
watchGlobalDir(path.join(GLOBAL_PORTRAIT_DIR, '_global'), () => {
  broadcastControl({ type: 'portrait', global: true, ok: true, quiet: true, globalPortrait: globalPortraitInfo() });
  repaintAllPortraits();
});

// {type:'portrait', action:'set-global'|'reset-global'[, path]}: the user's
// default picture for every agent (BACKLOG C #3). BROADCAST for the same
// reason as the per-agent upload above.
function handleGlobalPortrait(msg) {
  const out = handleGlobalPortraitMessage(msg, {
    uploadsDir: GLOBAL_PORTRAIT_DIR,
    stat: (p) => fs.lstatSync(p),
    resolve: () => (globalPortrait(GLOBAL_PORTRAIT_DIR) || {}).path || null,
  });
  if (!out.reply.ok) console.log('[host] global portrait refused:', msg && msg.action, '-', out.reply.reason);
  broadcastControl({ type: 'portrait', ...out.reply, globalPortrait: globalPortraitInfo() });
  if (out.changed) repaintAllPortraits();
}

function handlePortraitUpload(msg) {
  const out = handlePortraitMessage(msg, {
    uploadsDir: UPLOADS_DIR,
    // lstat, not stat: a symlink is refused, never followed (Miguel S1, PR #64).
    stat: (p) => fs.lstatSync(p),
    resolve: (agent, state) => portraitOf(agent, state).path,
    liveState: (agent) => {
      const row = mood.roster().find(r => r.agent === agent);
      return row ? row.state : null;
    },
  });
  if (!out.reply.ok) console.log('[host] portrait upload refused:', out.reply.agent, out.reply.state, '-', out.reply.reason);
  broadcastControl({ type: 'portrait', ...out.reply });
  if (out.reply.ok && out.reply.agent === EXPLAINER_AGENT) broadcastExplainer();      // the explainer's card wears its new picture
  // Re-describe rather than assuming the tier that now applies -- describe()
  // re-reads the real filesystem, so a stale idea of "the upload obviously
  // won" can never disagree with what portraitFor actually resolves.
  if (out.mood) {
    const row = mood.roster().find(r => r.agent === out.mood.agent);
    broadcastControl({ type: 'mood', ...describe(out.mood.agent, out.mood.state, row && row.state === out.mood.state ? row.detail : undefined) });
  }
  if (out.repaintIndex) {
    lastRosterIndex = {
      ...lastRosterIndex,
      agents: lastRosterIndex.agents.map(a => (a.agent === out.reply.agent
        ? { ...a, portrait: portraitOf(a.agent, 'sleeping') } : a)),
    };
    broadcastControl({ type: 'rosterIndex', rosterIndex: lastRosterIndex });
  }
}

// {type:'roster', action:'hide'|'unhide', agent} (BACKLOG #14). BROADCAST like
// the portrait upload above: two windows on one project share the hidden set.
// A refused hide (the agent woke between the click and now) still re-broadcasts
// the set, so the asking window redraws to the truth rather than guessing.
function broadcastHidden() {
  broadcastControl({ type: 'hidden', hidden: hiddenAgents.list() });
}
// The set a new window starts with, reconciled first. If that cleared anything
// the OTHER open windows are told too, as the mood path does (Miguel M6).
function hiddenAtAttach() {
  if (hiddenAgents.reconcile(mood.roster()).cleared.length) broadcastHidden();
  return hiddenAgents.list();
}
function handleRosterMessage(msg) {
  if (!validRosterMsg(msg)) {
    // Logged and answered with the truth, never dropped in silence (Dexter F4):
    // the asking window redraws to what the host actually holds.
    console.log('[host] roster message refused: malformed');
    broadcastHidden();
    return;
  }
  if (msg.action === 'hide') {
    const out = hiddenAgents.hide(msg.agent, mood.roster());
    if (!out.ok) console.log('[host] hide refused:', msg.agent, '-', out.reason);
    else if (out.persisted === false) console.log('[host] hidden agents could not be saved:', msg.agent);
  } else {
    const out = hiddenAgents.unhide(msg.agent);
    if (out.persisted === false) console.log('[host] hidden agents could not be saved:', msg.agent);
  }
  broadcastHidden();
}

// Per-agent career stats: tokens spent and time worked IN THIS PROJECT, across
// every session on the folder. Cached and refreshed when an agent finishes
// rather than polled -- it reads every transcript in the project, so a timer
// would put that cost on a clock for a figure that only changes on a finish.
let lastAgentStats = { ok: false, agents: [], unresolved: 0 };
let agentStatsPending = null;
// Remembers each finished transcript's result by (mtime, size), so a SubagentStop re-reads only what changed
// (BACKLOG #74 D: the full re-read cost ~5 CPU-s and ~600 MB per finish on a 664 MB project).
const agentStatsMemo = createStatsMemo();

function refreshAgentStats() {
  if (agentStatsPending) return agentStatsPending;
  agentStatsPending = readAgentStats({ cwd: CWD, memo: agentStatsMemo })
    .then((stats) => { lastAgentStats = stats; return stats; })
    .catch((err) => {
      console.error('[host] agent stats failed:', err && err.message);
      return lastAgentStats;
    })
    .finally(() => { agentStatsPending = null; });
  return agentStatsPending;
}

// The WHOLE roster (BACKLOG D #16): Active/Inactive tabs need every agent
// definition and history entry ACROSS EVERY PROJECT, not just this one, sorted
// by lifetime tokens. Both halves -- host/roster-index.js's identity walk and
// host/agent-stats-cache.js's cached, incremental token sum -- read every
// project under ~/.claude/projects/, which MEASURED at 1232 transcripts across
// 48 projects (~1.2GB) taking ~14s cold. So this is fired once, in the
// BACKGROUND, well after the pty and the ws server exist, and only ever
// broadcast when it resolves -- never awaited by anything that could block
// startup or the control channel.
//
// PR #59 review: `scanProjects` is computed ONCE per pass and handed to BOTH
// `wholeRoster` and `lifetimeAgentTokens` (Dexter F5 perf half / Miguel M1) --
// before this, each independently walked and identity-resolved every project,
// reading every top-level session transcript on the machine TWICE per launch,
// and the two walks could disagree if the tree changed between them (Dexter
// F10). `wholeRoster` is the one that folds `scan.errors` into its own
// `unreadable` (see its header); `lifetime.unreadable` never repeats them, so
// the sum below double-counts nothing (Miguel L2).
const ROSTER_LIFETIME_CACHE = path.join(HARNESS_DIR, 'state', 'roster-lifetime.json');
let lastRosterIndex = { ok: false, agents: [], complete: false, unreadable: 0 };
let rosterIndexPending = null;

function rosterAgentRow(agent, lifetime, unresolvedNames, infos) {
  const info = infos && infos.get(agent);
  return {
    agent,
    // BACKLOG #76: the persona ("Miguel") and the one-line function, read from the agent file's description.
    // `null` for an agent known only from history (no file), never an invented name.
    persona: info && info.persona ? info.persona : null,
    fn: info && info.fn ? info.fn : null,
    // Never used shows NO count -- `null`, not a coerced zero (Number(null)
    // is 0, the exact trap CLAUDE.md names for this repo). `.has` is the
    // strict presence check that makes that hold.
    tokens: lifetime.agents.has(agent) ? lifetime.agents.get(agent) : null,
    portrait: portraitOf(agent, 'sleeping'),
    // Dexter F3 / Miguel L1: an agent resolved only through an unresolved hook
    // LABEL (in either the identity walk or the token sum -- a run can be
    // orphaned in one project and confirmed in another) is flagged rather than
    // drawn as an indistinguishable peer of a real `subagent_type`.
    resolved: !unresolvedNames.has(agent) && !lifetime.unresolvedAgents.has(agent),
    // Dexter N2, PR #59 R2: an agent that DID run but whose only transcript(s)
    // this pass could not read must not be pixel-identical to a definition
    // that has never run at all -- `tokens` is `null` either way, so this is
    // the ONLY signal that tells the two apart.
    unreadable: lifetime.unreadableAgents.has(agent),
  };
}

function refreshRosterIndex() {
  if (rosterIndexPending) return rosterIndexPending;
  rosterIndexPending = (async () => {
    const scan = await scanProjects();
    const [roster, lifetime] = await Promise.all([
      wholeRoster({ cwd: CWD, scan }),
      lifetimeAgentTokens({ cacheFile: ROSTER_LIFETIME_CACHE, scan }),
    ]);
    const agents = roster.names.map((agent) => rosterAgentRow(agent, lifetime, roster.unresolvedNames, roster.infos));
    lastRosterIndex = {
      ok: roster.unreadable === 0 && lifetime.unreadable === 0,
      agents,
      // TRUE the moment one full pass has resolved, however it went --
      // `ok` (above) carries whether it was CLEAN, separately, the same
      // split host/agent-stats.js and host/usage.js already make.
      complete: true,
      unreadable: roster.unreadable + lifetime.unreadable,
    };
    return lastRosterIndex;
  })()
    .catch((err) => {
      console.error('[host] roster index failed:', err && err.message);
      return lastRosterIndex;
    })
    .finally(() => { rosterIndexPending = null; });
  return rosterIndexPending;
}

// Dexter F5 (lower-bound half, PR #59 R1): before this, `lastRosterIndex`
// stayed `{ agents: [] }` for the WHOLE ~14s first pass, so the "≥ until the
// first full pass completes" state the spec calls for (item 4) was dead code
// -- there was never a total on screen to prefix with "≥" until the pass had
// already finished and stopped needing one. This reads a LOWER-BOUND snapshot
// left by the last successful scan (any previous host run) and publishes it
// immediately, `complete: false`, so a client attaching during this launch's
// own (still-running) scan sees last-known totals rather than nothing at all.
// A cold install with no prior cache simply has nothing to seed, which is the
// correct starting state, not a failure.
//
// USES `readCacheSeed`, NOT `readCacheSummary` (Dexter N1, PR #59 R2): the raw
// summary alone is not a lower bound once a transcript can be DELETED between
// host launches (Claude Code's own retention cleanup, for instance) --
// `readCacheSeed` stat-checks the files behind each total and drops any that
// vanished, so what this publishes can never be larger than the truth.
//
// NEVER OVERWRITES A COMPLETED PASS (Dexter N3, PR #59 R2): `seedRosterIndex`
// and `refreshRosterIndex` both run at boot, and on a small install the real
// pass can resolve BEFORE this cheap disk read does. Without the guard below,
// this function would then unconditionally replace a `complete:true` result
// with a stale `complete:false` snapshot, and a client attaching in that
// window would see totals regress until the boot chain's second
// `refreshRosterIndex()` call (test/host-roster-index.test.js) finishes.
async function seedRosterIndex() {
  const seed = await readCacheSeed(ROSTER_LIFETIME_CACHE).catch(() => ({}));
  const names = Object.keys(seed);
  if (!names.length) return;
  if (lastRosterIndex.complete) return; // Dexter N3: a finished pass is never regressed
  lastRosterIndex = {
    ok: false, // a snapshot, not a verified-against-the-current-tree read
    complete: false,
    unreadable: 0,
    agents: names.map((agent) => ({
      agent,
      tokens: Number.isFinite(seed[agent] && seed[agent].tokens) ? seed[agent].tokens : null,
      portrait: portraitOf(agent, 'sleeping'),
      persona: null, // the seed doesn't carry descriptions either; the real pass fills them in
      fn: null,
      // The seed doesn't carry identity provenance -- assume confirmed rather
      // than flagging every row; `refreshRosterIndex`'s real pass corrects
      // this within moments.
      resolved: true,
      unreadable: false, // likewise unknown at seed time; not claimed either way
    })),
  };
}

// The model each agent ACTUALLY used, read from its own transcript -- never
// the Agent tool_input's REQUESTED model, which is a different fact. See
// host/session-model.js. Recomputed on SessionStart (the session id just
// became known) and on SubagentStop (a subagent's transcript just landed).
//
// The coalescing, the merge that keeps known models through a failed read, and
// the "broadcast only on a CHANGE" rule all live in createSessionModelRefresher,
// where they are tested (Dexter, PR #34, Findings 3 and 4). A payload that reads
// identically to what clients already have is not news -- same as quota.js.
const sessionModels = createSessionModelRefresher({
  read: (id) => readSessionModel({
    projectsDir: defaultProjectsDir(),
    projectDir: projectDirName(CWD),
    sessionId: id,
    // The same project as readAgentStats, so one memo serves both (#74 D, PR #131 M3). Both can run at once on a
    // SubagentStop: each entry is set as one (stat, value) pair, and a concurrent prune can only cause a miss.
    memo: agentStatsMemo,
  }),
  currentSessionId: () => sessionId,
  onChange: (m) => broadcastControl({ type: 'sessionModel', ...m }),
});

// Backlog #39 job 1: the "where are we" summary of THIS session, written by a local model (Ollama, llama3.2:3b) from
// the tail of the session's transcript (host/summary-service.js, documentation/DESIGN_SLAVE_MODE_SUMMARY.md). READ-ONLY:
// it never types into the session and never edits a project's files; it writes only its own summaries and a GPU slot
// that makes jobs one-at-a-time across every host. The probe seams (host/probe-seams.js) point it at a fake Ollama.
const SUMMARY_DIR = seams.summaryDir || path.join(HARNESS_DIR, 'state', 'summaries');
const summaryStore = createSummaryStore({ dir: SUMMARY_DIR });
const summary = createSummaryService({
  sessionId: () => sessionId,
  transcriptFile: (id) => path.join(seams.projectsDir || defaultProjectsDir(), projectDirName(CWD), id + '.jsonl'),
  ollama: createOllamaClient({ baseUrl: seams.ollamaUrl || undefined }),
  store: summaryStore,
  scheduler: createScheduler(),
  slot: createSlot({ file: path.join(SUMMARY_DIR, '.job.lock') }),
  onBattery: seams.summaryPower ? async () => seams.summaryPower === 'battery' : createPowerProbe().onBattery,
  broadcast: (m) => broadcastControl(m),
  log: (...a) => console.log(...a),
});
// Lean mode (#62): while every attached window is lean the summary job's only reader (the terminal bar) is hidden, so no job is started
// (host/lean-gate.js). The tick only starts jobs, so a paused tick costs nothing and a resumed one catches up at once.
const leanGate = createLeanGate();
const summaryTimer = setInterval(() => {
  if (leanGate.paused(clients.size)) return;
  summary.tick().catch(() => { /* logged inside */ });
}, TICK_MS);
summaryTimer.unref();
summaryStore.sweep().catch(() => { /* best effort */ });     // one prune sweep at start: old summaries, orphan temp files

// Backlog #39 job 2: docs drift. After a merge into develop the local model reads the diff next to the build log's "Now" and
// the design docs it touches, and flags sentences the merge now contradicts (host/drift-service.js). READ-ONLY toward the
// project: it reads documentation\ and git, and writes only its own notes under .harness\state\docs-drift. It shares the
// summaries' GPU slot, so one Ollama job runs at a time across every tab; each tab's host looks, and the shared mark in the
// notes file keeps a merge from being read twice.
const DRIFT_FILE = path.join(seams.summaryDir ? path.join(seams.summaryDir, 'docs-drift') : path.join(HARNESS_DIR, 'state', 'docs-drift'),
  require('crypto').createHash('sha1').update(String(STATE_ROOT).toLowerCase()).digest('hex').slice(0, 16) + '.json');
const drift = createDriftService({
  git: createDriftGit({ cwd: STATE_ROOT }),
  readDocs: () => readDocsDir(path.join(STATE_ROOT, 'documentation')),
  ollama: createAskOllama({ baseUrl: seams.ollamaUrl || undefined, generateTimeoutMs: DRIFT_GENERATE_MS }),
  store: createDriftStore({ file: DRIFT_FILE }),
  slot: createSlot({ file: path.join(SUMMARY_DIR, '.job.lock') }),
  broadcast: (m) => broadcastControl(m),
  log: (...a) => console.log(...a),
});
const driftTimer = setInterval(() => { drift.tick().catch(() => { /* logged inside */ }); }, DRIFT_TICK_MS);
driftTimer.unref();
const driftFirst = setTimeout(() => { drift.tick().catch(() => { /* logged inside */ }); }, 10_000);
driftFirst.unref();

// Backlog #80 (+ #55's bubbles): medals Ricardo gives agents (install-wide, host/medals.js) and the speech bubbles a LOCAL model
// writes on a state change (host/bubbles.js). The bubbles share the summaries' GPU slot file, so a bubble never runs beside a
// summary; they are decoration only and never an error (Ollama down: nothing). The probe seams point both at a fake Ollama.
const medals = createMedals({ store });
const bubbleSettings = createBubbleSettings({ store });
const bubbleActivity = createBubbleActivity();
const bubbles = createBubbles({
  gate: createBubbleGate(),
  ollama: createAskOllama({ baseUrl: seams.ollamaUrl || undefined, generateTimeoutMs: 20_000 }),
  slot: createSlot({ file: path.join(SUMMARY_DIR, '.job.lock') }),
  voiceOf: createVoiceReader({ configDir: claudeConfigDir(), cwd: CWD }).voiceOf,
  contextOf: (agent) => ({ ...bubbleActivity.of(agent), task: mood.taskOf(agent) }),
  settings: bubbleSettings,
  broadcast: (m) => broadcastControl(m),
  log: (...a) => console.log(...a),
});
function handleMedalMessage(msg) {
  let out;
  if (msg.action === 'give') {
    const req = validGive(msg);
    out = req ? medals.give(req.agent, req.kind, req.reason) : { ok: false, reason: 'invalid', medals: medals.all() };
  } else if (msg.action === 'remove') {
    const req = validRemove(msg);
    out = req ? medals.remove(req.agent, req.id) : { ok: false, reason: 'invalid', medals: medals.all() };
  } else {
    out = { ok: false, reason: 'invalid', medals: medals.all() };
  }
  if (out.ok === true && msg.action === 'give') usageCounters.bump('medal:given');
  if (out.ok === false) console.log('[host] medal refused:', msg.action, '-', out.reason);
  broadcastControl({ type: 'medals', medals: out.medals, ok: out.ok !== false, reason: out.reason || null });
  medalsWatch.note(out.medals);
}
// The medals and the bubbles' switch are install-wide files, but every tab is its own host: a change made through ANOTHER host reaches
// this host's windows through these watches (polled from the 1 s clock below, host/state-watch.js).
const medalsWatch = createChangeWatch({ read: () => medals.all(), onChange: (v) => broadcastControl({ type: 'medals', medals: v, ok: true, reason: null }) });
const bubblesWatch = createChangeWatch({ read: () => { const v = bubbleSettings.peek(); if (v === null) throw new Error('bubbles setting unreadable'); return v; }, onChange: (v) => broadcastControl({ type: 'bubbles', enabled: v }) });
// A window tells its host whether it can show a bubble (agent images off, lean mode): per SOCKET, so one window can't cancel another,
// and a window that closes stops counting (dropViewer in its close handler).
function handleBubblesMessage(msg, ws) {
  if (msg.action === 'set-enabled') {
    const out = bubbleSettings.set(msg.enabled);
    if (!out.ok) console.log('[host] bubbles setting refused:', out.reason);
    const told = bubbleSettings.enabled();
    broadcastControl({ type: 'bubbles', enabled: told });
    bubblesWatch.note(told);      // what was just said, not a second read
  } else if (msg.action === 'visible') {
    bubbles.setViewer(ws, msg.visible === true);
  }
}

// The OpenRouter catalogue and the council seats.
//
// The catalogue endpoint is PUBLIC, so this needs no key and spends nothing --
// which is why the browser works today and the council does not.
//
// BACKLOG E #5, step 2 (Ricardo, 2026-09-27): warmed once at boot below,
// rather than staying lazy-on-first-request as this comment used to say. A
// session that opens the Models tab should not sit through a cold network
// round trip the host had the whole boot sequence to start already. Still
// exactly ONE request in flight at a time -- host/catalogue-cache.js dedupes
// the boot warm-up against a tab opened while it is still in the air, and a
// forced (Refresh) call against any OTHER forced or non-forced call still
// running -- and still no INTERVAL timer anywhere: this fires once, and every
// later freshness check is `loadCatalogue`'s own FRESH_MS comparison, driven
// by a client asking (see the 'models' branch further down) or by a Refresh
// click's `force`.
//
// Pulled into its own module (Dexter/Miguel, PR #60 review, F5/S1): the
// dedupe bookkeeping had a bug (a settling promise could null the shared slot
// out from under a still-running one) that shipped untested because host.js
// itself cannot be `require()`d into a unit test. See
// host/catalogue-cache.js's header for the bug and the fix.
const CATALOGUE_CACHE = path.join(HARNESS_DIR, 'state', 'openrouter-catalogue.json');
const catalogueCache = createCatalogueCache({
  loadCatalogue, cacheFile: CATALOGUE_CACHE, normalize: normalizeCatalogue,
});
const currentCatalogue = (opts) => catalogueCache.current(opts);

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

// Running processes and the party, from hook events and from the tick. Owns the
// falling edge the tick used to miss -- see host/processes-broadcast.js.
// A closure, not `broadcastControl` itself: that is a const declared further
// down, and reading it here at startup is a TDZ ReferenceError that stops the
// host before it serves anything. The closure reads it at first send, by which
// point the whole module has run.
const processesBroadcast = createProcessesBroadcast((msg) => broadcastControl(msg));

// Backlog #52: is this session in a /bedtime night, and when does it wake next? From the loop's own ScheduleWakeup
// calls (host/bedtime-state.js). The PR count is asked of gh in the project folder at the start and at each wake.
let nightWasOn = false;
function noteNight(payload) {     // usage counters: a night counts once, when it begins
  if (payload && !nightWasOn) usageCounters.bump('bedtime:start');
  nightWasOn = Boolean(payload);
}
// BACKLOG #119 A7: the Schedules panel. This session's wakeups, loops, bedtime night and cron jobs, kept in the install-wide
// .harness/state/schedules.json beside every other host's (host/schedules-control.js). Built BEFORE the night: a PR count that lands
// refreshes the bedtime row's detail.
const schedulesControl = createSchedulesControl({
  store,
  key: String(PORT),
  cwd: CWD,
  label: () => { const b = currentBranch(CWD); return `${projectLabel(PROJECT_ROOT)}${b ? ` / ${b}` : ''}`; },
  nightView: () => night.payload(),
  emit: (frame) => broadcastControl(frame),
  log: (line) => console.log(line),
});
schedulesControl.start();
// The Schedules panel lists every host's rows: another host's write must reach THIS host's windows (host/schedules-control.js).
watchDir({
  dir: path.join(HARNESS_DIR, 'state'),
  create: true,
  match: (f) => f === 'schedules.json',
  onChange: () => {
    const frame = schedulesControl.changed();
    if (frame) broadcastControl(frame);
  },
});
// ...and a host with rows says it is still alive (a neighbour reads three silent minutes as "session ended"); the clock text moves along.
setInterval(() => { schedulesControl.beat(); }, 30_000);
const night = createNightStatus({
  bedtime: createBedtime(),
  countPrs: (since) => countNightPrs(CWD, since),
  onChange: (payload) => { noteNight(payload); broadcastControl({ type: 'bedtime', bedtime: payload }); schedulesControl.touch(); },
});

// Worktree occupancy: this host writes a claim file when one of its subagents proves it is working in another
// worktree, and deletes it when the agent stops (or this host exits). Every window reads them.
const occupancyWriter = createClaimWriter({ stateRoot: STATE_ROOT, log: (...a) => console.log(...a) });
const occupancy = createOccupancyProducer({
  writer: occupancyWriter,
  roots: createRootsProvider({ cwd: CWD, log: (...a) => console.log(...a) }),
  ownRoot: CWD,
  fromBranch: () => currentBranch(CWD),
  hostPid: process.pid,
  hostStartedAt: () => (lockOwner && typeof lockOwner.processStartedAt === 'string' ? lockOwner.processStartedAt : null),
  nameOf: (agentId) => {
    const inv = mood.invocations().find(i => i.agentId === agentId);
    return inv ? inv.name : null;
  },
  // #81: what a side session's agents claim, they read.
  role: SIDE ? 'reader' : undefined,
  // A teammate's SubagentStop ends a turn, not the agent: its claim is kept while it idles.
  isTeammate: teammateFromMeta,
  log: (...a) => console.log(...a),
});
process.on('exit', () => { occupancyWriter.removeAll(); });

let hookBridge = null;
if (helperExists) {
  // Claims left by a host that died: this is the producer that deletes them (a reader never does).
  sweepDead(occupancyDir(STATE_ROOT), { judge: (claims) => judgeClaims(claims, startTimes), log: (...a) => console.log(...a) })
    .then((r) => { if (r.removed.length) console.log(`[occupancy] swept ${r.removed.length} dead claim(s)`); })
    .catch(() => { /* a sweep never blocks a host */ });
  hookBridge = createHookBridge({ pipeName: PIPE_NAME });
  hookBridge.on('event', (ev) => {
    // The statusLine document, forwarded by host/status-relay.js on every
    // status redraw. Not a hook: handled here and ONLY here, so the mood
    // engine, the process panel and the [hook] log never see it.
    if (ev.event === 'Status') {
      // Every document, even one without a model: a document that cannot say
      // must CLEAR the fill (unknown), never leave the last one standing.
      setContext(contextSource.fromRelay(readContext(ev.payload)));
      setStatusFields(readStatusFields(ev.payload));
      const status = readStatus(ev.payload);
      if (status.model !== undefined) setLiveModel(status.model);
      if (status.effort !== undefined) setEffort(status.effort);
      return;
    }
    // Worktree occupancy sees every hook event; the file-tool PreToolUse that only IT asked for goes no
    // further: their PostToolUse isn't hooked, so the Running panel would show every Read as running forever.
    // (Under hook debug their payload is printed here: they never reach the `[hook:full]` line below. Without
    // the text a Write or an Edit carries: this fires for every file an agent writes, a .env included, and
    // the probe that reads it only wants who touched which path.)
    if (process.env.CLAUDE_CUSTOM_HOOK_DEBUG && isOccupancyOnly(ev)) console.log('[hook:full] ' + JSON.stringify(withoutFileText(ev.payload)));
    occupancy.handle(ev);
    // The terminal bar (#49 + #52) sees every event too: the main session's own Read keeps a night awake.
    if (promptKeeper.handle(ev)) broadcastControl({ type: 'prompt', prompt: promptKeeper.snapshot() });
    night.handle(ev);
    // The Schedules panel (#119 A7) sees every event too: a wake is a UserPromptSubmit, a session's end clears its wakeups.
    schedulesControl.event(ev);
    // The turn state sees them too: a turn that only Reads and Edits (a blocked Stop's continuation, a turn an
    // agent's result opened) is live, and the early returns below would leave it 'idle' (BACKLOG #77 R1).
    if (turnState.handle(ev)) broadcastControl({ type: 'turn', turn: turnState.snapshot() });
    // And attention's shell wait: a main-session Read or Edit means the session is working, so a timer that would
    // raise "finished" is cancelled here (BACKLOG #78, PR #147 Dexter D1); `handle` below never sees these events.
    attention.activity(ev);
    // ...but the mood engine reads them for one thing only: which tool an agent is using now (reading, writing,
    // BACKLOG #55). They open no run and touch no panel; a Read is never a process.
    if (isOccupancyOnly(ev)) { mood.handle(ev); return; }
    // A ScheduleWakeup is the night's and nobody else's: the mood engine would read it as work, and the Running
    // panel would show it as a process.
    if (isBedtimeOnly(ev)) return;
    // ...and a CronCreate / CronDelete is the Schedules panel's: the mood engine would read it as work.
    if (isSchedulesOnly(ev)) return;
    // An Artifact publish is the panel's shelf's and nobody else's (host/canvas-shelf.js): the mood engine would read it as work.
    if (canvasControl.handlesShelfEvent(ev)) {
      canvasControl.shelfEvent(ev);
      return;
    }
    // The context was just replaced (/clear) or summarised (compaction): the
    // last fill is no longer true, whether or not the CLI re-fires the
    // statusLine right after. Unknown until a document says otherwise.
    if (ev.event === 'SessionStart' && ev.payload
        && (ev.payload.source === 'clear' || ev.payload.source === 'compact')) {
      contextSource.reset();           // and neither source's older figure may win a tie later
      setContext(null);
    }
    if (ev.event === 'SessionStart' && ev.payload && ev.payload.session_id) {
      sessionId = ev.payload.session_id;
      console.log('[host] session id     :', sessionId);
      if (SIDE) republishIdentity();     // the identity names it, for the producers that read transcripts
      canvasControl.sessionChanged(sessionId);
      // the roster cards match an agent's worktree claim on it (backlog #57): a /clear starts a new one
      broadcastControl({ type: 'session', sessionId });
      sessionModels.refresh().catch(() => { /* the next SubagentStop will carry it */ });
    }
    if (ev.event === 'SubagentStop') {
      // The transcript is on disk by the time this fires, so its tokens and
      // timestamps are already there to read. Refresh both the agent stats panel
      // AND the token count — before this change only agentStats was refreshed,
      // so the session token display lagged up to 5 seconds after each agent
      // finished (the timer eventually caught it, but the agents panel updated
      // instantly while the token headline stayed stale).
      refreshAgentStats()
        .then((stats) => broadcastControl({ type: 'agentStats', stats }))
        .catch(() => { /* the next finish will carry it */ });
      // The milestone rides along, or the headline crosses a rung while the
      // flourish waits for the next tick. announcer.see dedupes the timer's call.
      refreshUsage()
        .then((usage) => {
          broadcastControl({ type: 'usage', usage });
          checkMilestone(usage);
        })
        .catch(() => { /* the timer will carry it */ });
      // Same reasoning: the subagent's own transcript, including its true
      // model, is on disk by the time this fires.
      sessionModels.refresh().catch(() => { /* the next finish will carry it */ });
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
    // Main-session permission mode and effort, read by host/hook-session.js:
    // subagent payloads and SessionEnd say nothing (undefined), and a missing
    // effort.level is ABSENT (null) -- Haiku has none. permission_mode is a
    // handshake fallback only -- see its declaration below. effort IS
    // broadcast, gated on a change, including a change to absent.
    const said = readSessionHook(ev.payload);
    if (said.permissionMode !== undefined) lastHookPermissionMode = said.permissionMode;
    if (said.effort !== undefined) setEffort(said.effort);
    // Logged because the roster silently showed nothing when agents ran, and
    // there was no way to tell whether hooks were arriving at all.
    // A Notification names its notification_type: attention.js raises only the
    // types it knows, so a new one must at least be visible here (Dexter F4).
    const what = ev.payload && (ev.payload.tool_input?.subagent_type || ev.payload.tool_name || ev.payload.notification_type);
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
    bubbleActivity.note(ev);
    mood.handle(ev);
    // A backstop ending a call means that call's own close never arrived --
    // logged, because a lost event nobody can see is how PostToolUseFailure
    // went unhooked.
    const ended = processes.handle(ev);
    if (ended) console.log(`[processes] ${ev.event} ended ${ended} call(s) whose own close never arrived`);
    processesBroadcast.send(processes.list(), mood.stack());
  });
  hookBridge.on('parse-error', e => console.log('[hook!] unparseable line:', e.line.slice(0, 80)));
  hookBridge.on('error', e => console.log('[hook!] bridge error:', e.message));
  hookBridge.listening
    .then(() => console.log('[host] hook bridge listening on', PIPE_NAME))
    .catch(e => console.log('[host] hook bridge FAILED to bind:', e.message));
}

// --- the project picker ------------------------------------------------------

/**
 * The recent-projects list, for the sidebar's Projects panel.
 *
 * A FAILED read is reported as `ok:false` rather than as an empty list. "You
 * have not opened anything yet" and "we could not read your history" are
 * different facts, and an empty array tells them apart for nobody.
 */
// Holds its cache across calls. Without one, every open of the panel re-read
// every transcript on the machine -- measured 2.0s, 3.0s, 3.9s and rising,
// synchronously, on the event loop that delivers hook events. With it: 8ms.
const readProjects = createProjectsReader();

async function sendProjects(ws) {
  let recents = null;                       // null means the read failed
  try {
    recents = readProjects();
  } catch (err) {
    console.log('[host] could not list recent projects:', err.message);
  }
  ws.send(JSON.stringify({ type: 'projects', ...pickerPayload({ recents, current: CWD }) }));
}

/**
 * Open another project in its own window.
 *
 * Spawns the launcher rather than reusing this host: a host is bound to one
 * project by construction -- it holds a pty already running `claude` in this
 * cwd -- so "switch project" is a new host, not a mutation of this one. That
 * also means the session you are looking at survives switching away from it,
 * which is the same detach property the rest of this design rests on.
 *
 * The path is REVALIDATED here even though the picker only ever offers paths
 * this host sent it. The control channel is token-gated, so this is not the
 * last line of defence, but a stale list is enough on its own: a project
 * deleted since the panel was drawn would otherwise spawn a window onto a
 * folder that no longer exists.
 */
function openProject(msg, ws) {
  const asked = msg && msg.path;

  // ABSOLUTE ONLY. Dexter, Finding 6: `resolveLaunchTarget` resolves against
  // CWD, so a relative path silently anchors inside the CURRENT project. The
  // picker was the thing sending relative paths -- an approximate row carries
  // the lossy ~/.claude/projects folder name -- and if a folder with that
  // literal name happened to exist here, it would have opened THAT with no
  // warning. Every legitimate caller has an absolute path; refusing the rest
  // costs nothing and closes the only unintended resolution either reviewer
  // could find.
  if (typeof asked !== 'string' || !path.isAbsolute(asked)) {
    const why = `refusing a project path that is not absolute: ${JSON.stringify(asked)}`;
    console.log('[host]', why);
    ws.send(JSON.stringify({ type: 'projects', error: why }));
    return;
  }

  let target;
  try {
    target = resolveLaunchTarget(asked, { cwd: CWD });
  } catch (err) {
    console.log('[host] refusing to open:', err.message);
    ws.send(JSON.stringify({ type: 'projects', error: err.message }));
    return;
  }

  // ANSWERED, not silently dropped. Dexter, Finding 8: this used to be a bare
  // `return`, so the panel sat on "opening a window…" forever -- the dead
  // button with no feedback that the comment beside the click handler was
  // written to prevent. Reachable whenever two ~/.claude/projects folders
  // record the same cwd, which happens routinely via a junction or a second
  // drive mapping.
  if (samePath(target, CWD)) {
    ws.send(JSON.stringify({ type: 'projects', error: 'that project is already open in this window' }));
    return;
  }

  console.log('[host] opening project:', target);

  // Logged to a FILE, not discarded and not piped. stdio:'ignore' is what made
  // the first version of this unfixable from the outside: the launcher failed,
  // the panel said "opening a window…", and nothing anywhere said why. A pipe
  // would be worse than useless -- it belongs to this process, so the detached
  // child takes EPIPE the moment it writes after we go, which is the same trap
  // app/main.js records for the host's own log.
  let stdio = 'ignore';
  let logFd = null;
  try {
    fs.mkdirSync(HARNESS_DIR, { recursive: true });
    logFd = fs.openSync(path.join(HARNESS_DIR, 'launcher.log'), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch { /* a log we cannot open must not stop the window opening */ }

  const child = require('child_process').spawn(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'claude-custom.js'), target], {
    detached: true,
    stdio,
    // ELECTRON_RUN_AS_NODE is set ON PURPOSE and only for the launcher, which
    // is a node script while this process's execPath is electron. The launcher
    // strips it again before spawning the window -- see launchEnv, and the
    // trap it documents.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  // An 'error' event on an EventEmitter with NO listener THROWS (Miguel). That
  // would kill the host -- and the user's live pty session with it -- because a
  // window failed to spawn. This file already makes that argument twice, at
  // killTree and at the health runner; the launcher spawn was the one that
  // did not follow it.
  child.on('error', (err) => {
    console.error('[host] could not start the launcher:', err.message);
    try {
      ws.send(JSON.stringify({ type: 'projects', error: `could not open a window: ${err.message}` }));
    } catch { /* the window may already be gone */ }
  });

  // Node does NOT close fds handed to `stdio` -- that is the caller's job.
  // app/main.js has the same shape and pays it once per process; this pays it
  // once per project-open, in a host designed to run for days (Miguel).
  if (logFd !== null) {
    const closeLog = () => { try { fs.closeSync(logFd); } catch {} };
    child.once('spawn', closeLog);
    child.once('error', closeLog);
  }

  child.unref();
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
  // BACKLOG #119 A2: a host started from inside a harness tab inherits that tab's mod port and token; passing them on would send this
  // session's records to the other host. This host sets its own, or none.
  'CLAUDE_CUSTOM_MOD_PORT',
  'CLAUDE_CUSTOM_MOD_TOKEN',
];

function cleanEnv() {
  const env = { ...process.env };
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  return env;
}

// --- the session, behind the worktree's session lock (Extension X1) --------
// One live `claude` per worktree across every window and host: the lock is
// taken at boot (end of this file) BEFORE anything is spawned, so `term` is
// null until the session starts -- and stays null in a window the lock
// blocked, until the person picks *Open anyway*. Every use of `term` below is
// guarded for that. Design: documentation/PLAN_WORKTREE_TABS.md, Extension X.
let term = null;
const SESSION_LOCK = SIDE ? null : lockPathFor(CWD);
let lockOwner = null;                  // what we wrote into the lock, once taken
let lockState = { state: 'pending' };  // host/session-gate.js documents the shapes
// WORKTREE_NAME / COMPOSE_PROJECT_NAME / WORKTREE_PORT_BASE (Extension X3),
// worked out when a session starts -- never in a host the lock blocked, which
// would pay for a port block it never uses (Miguel, PR #71 Y2). After
// cleanEnv() so a worktree's own values win over whatever the launching shell
// exported; before providerEnv, which never sets them.
let sessionEnv = null;
let excludedPorts = [];                // Windows' excluded ranges, read at boot

function workOutSessionEnv() {
  try {
    // A port block belongs to the worktree, never a subfolder of it, and a
    // folder that is no worktree takes none.
    const root = worktreeRoot(CWD);
    return worktreeEnv(CWD, { portBase: root ? allocatePortBlock(root, { excluded: excludedPorts }) : null });
  } catch (err) {
    console.log('[host] worktree env failed, starting without it:', err && err.message);
    return {};
  }
}

function startSession() {
  if (term) return;
  if (sessionEnv === null) {
    sessionEnv = workOutSessionEnv();
    console.log('[host] worktree env  :', JSON.stringify(sessionEnv));
  }
  // At the size the window last asked for (Miguel, PR #71 R1): a resize that
  // arrived while blocked or booting only reached termState, which starts at
  // 120x30 and follows every validated resize since.
  const { cols, rows } = termState.size();
  term = pty.spawn(CLAUDE_BIN, ARGS, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: CWD,
    env: {
      ...cleanEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Marks this session as harness-hosted; the hook bridge keys off it later.
      CLAUDE_CUSTOM_SESSION: '1',
      // BACKLOG #119 A2: where the mod (loaded with --plugin-dir) posts, and the per-spawn token that authorises it. Only when the
      // mod server is up; the window's session token never goes here.
      ...(modPort === null ? {} : { CLAUDE_CUSTOM_MOD_PORT: String(modPort), CLAUDE_CUSTOM_MOD_TOKEN: MOD_TOKEN }),
      ...sessionEnv,
      ...providerEnv,
    },
  });
  console.log('[host] pty pid       :', term.pid);
  // Whoever this lock blocks can see which `claude` is holding the worktree.
  if (lockState.state === 'held') updateSessionLock(SESSION_LOCK, lockOwner, { claudePid: term.pid });
  // And the identity names it, so a stop (▾, `--stop`) waits for this claude
  // too, lock or no lock (Dexter, PR #83 F1).
  republishIdentity();
  wireTerm(term);
}

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
// Per-port as well as shared, because more than one host can now be running.
// The shared file is LAST-WRITER-WINS: a second project starting would
// overwrite it, and the first project's window would then reattach with the
// wrong token and be refused by the gatekeeper -- an auth failure whose cause
// is another project entirely.
//
// The shared file is still written, and still first, because eleven probes in
// verify/ read it by that exact path and they each run against a single host.
// Additive rather than moved: this fixes the window without touching them.
const PORT_TOKEN_FILE = path.join(HARNESS_DIR, 'hosts', `${PORT}.token`);
const SESSION_TOKEN = process.env.CLAUDE_CUSTOM_TOKEN || newToken();
// Written from the 'listening' event, NOT here (Dexter, PR #75 F2). A host that
// loses the bind (EADDRINUSE) must not have touched the winner's token files:
// a Retry after a slow start spawns a second host for the same port, and if it
// wrote first, every connect to the live host would present the loser's token.
function writeTokenFiles() {
  try {
    fs.mkdirSync(path.dirname(PORT_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, SESSION_TOKEN, { mode: 0o600 });
    fs.writeFileSync(PORT_TOKEN_FILE, SESSION_TOKEN, { mode: 0o600 });
  } catch (err) {
    console.log('[host] could not write the session token file:', err.message);
  }
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

// `permission_mode` also arrives on every hook payload but SessionEnd, mapped
// onto a MODES key by host/hook-session.js -- kept only as a HANDSHAKE
// fallback for the window that attaches before the TUI has drawn its first
// status line, when the scrape above is still null. The scrape stays authoritative once it has anything:
// FF12's brief is explicit that this must not replace it.
let lastHookPermissionMode = null;

// Effort is session-scoped (`/effort <level>`, never persisted) and arrives
// on main-session hook payloads as `effort.level` -- but only for a model
// that HAS effort levels: on Haiku it is absent from every event (measured).
// This is the truth source FF12's top-bar picker resolves a pending `/effort`
// switch against -- see app/top-bar-display.js's pendingResolver. `null`
// until a hook event carries it, and again whenever one stops carrying it;
// the top bar renders that as "—", never a guessed default.
let lastEffort = null;

// The main session's model as the statusLine reports it: the exact id, fresh
// ~1s after a /model. #34's sessionModel.session.model is the LAST ASSISTANT
// LINE of the transcript, so it cannot see a switch until the next reply
// (Dexter #2); this can. null until the first status document.
let lastLiveModel = null;

// Both broadcast only on a change, stamped with the host's clock: a pending
// switch in the renderer is confirmed only by a truth no older than itself
// (app/top-bar-display.js's pendingResolver).
function setEffort(level) {
  if (level === lastEffort) return;
  lastEffort = level;
  console.log('[host] effort         :', lastEffort);
  broadcastControl({ type: 'effort', level: lastEffort, at: Date.now() });
}

// The context window as the statusLine reports it: { used, size } or null
// (unknown -- see hook-session.js readContext). Broadcast only on a change.
let lastContext = null;
function setContext(ctx) {
  if ((ctx === null && lastContext === null)
    || (ctx && lastContext && ctx.used === lastContext.used && ctx.size === lastContext.size)) return;
  lastContext = ctx;
  broadcastControl({ type: 'context', context: lastContext, at: Date.now() });
}

// BACKLOG #27: cost / lines / duration / ctx>200k for the tab header, or null
// (unknown -- see hook-session.js readStatusFields). Broadcast only on a
// change; duration moves on most fires, so that's one small frame per status
// fire, the cadence of the CLI's own row.
let lastStatusFields = null;
function setStatusFields(fields) {
  if (JSON.stringify(fields) === JSON.stringify(lastStatusFields)) return;
  lastStatusFields = fields;
  broadcastControl({ type: 'statusFields', fields: lastStatusFields, at: Date.now() });
}

function setLiveModel(model) {
  if (model === lastLiveModel) return;
  lastLiveModel = model;
  console.log('[host] live model     :', lastLiveModel);
  broadcastControl({ type: 'liveModel', model: lastLiveModel, at: Date.now() });
}

// Protocol: BINARY frames are raw pty bytes, TEXT frames are control JSON.
// Distinguishing by content would be wrong -- terminal output can contain
// anything, including a leading '{'.
const sendControl = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
const broadcastControl = msg => { for (const ws of clients) sendControl(ws, msg); };

// Kicked off once, here, rather than waiting for the first attach: the
// whole-roster scan is install-wide (every project, not this one), so there is
// no reason to delay it until a window happens to connect. Fire-and-forget --
// the connection handler above already covers a client that attaches before
// this lands, and a client already attached gets the broadcast when it does.
//
// `seedRosterIndex()` runs FIRST (Dexter F5, PR #59 review): it publishes
// whatever the LAST successful scan knew, `complete: false`, so a client
// attaching in the first seconds of this launch sees last-known totals as a
// lower bound instead of nothing at all, while `refreshRosterIndex()`'s real
// (still ~14s-cold) pass runs behind it and replaces the seed the moment it
// resolves.
seedRosterIndex()
  .catch(() => { /* nothing cached yet, or unreadable: the real pass still lands */ })
  .then(() => refreshRosterIndex())
  .then((rosterIndex) => broadcastControl({ type: 'rosterIndex', rosterIndex }))
  .catch(() => { /* lastRosterIndex already reflects the failure; the next attach retries */ });

// The pty's two event handlers, attached when startSession() spawns it.
function wireTerm(t) {
  t.onData((data) => {
    termState.write(data);
    const frame = Buffer.from(data, 'utf8');
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
    }
  });

  t.onExit(({ exitCode, signal }) => {
    console.log(`[host] claude exited code=${exitCode} signal=${signal}`);
    releaseSessionLock(SESSION_LOCK, lockOwner);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({ type: 'exit', exitCode, signal })
        );
      }
    }
    process.exit(exitCode ?? 0);
  });
}

// The machine is deliberately passive: it schedules nothing itself, so the host
// owns the clock and the transitions stay reproducible in tests.
mood.on('change', ({ agent, state, detail }) => {
  broadcastControl({ type: 'mood', ...describe(agent, state, detail) });
  bubbles.onMood({ agent, state });      // fire and forget: never throws, never makes the card wait (host/bubbles.js)
  // An agent that woke is un-hidden here too (BACKLOG #14) -- the renderer
  // applies the same rule itself, but the host persists it and is authoritative.
  if (hiddenAgents.reconcile(mood.roster()).cleared.length) broadcastHidden();
});
let installWideTicks = 0;
const moodTimer = setInterval(() => {
  mood.tick();
  askExplainer.tick();       // the explainer's flash and idle clocks (host/ask-explainer.js)
  if (++installWideTicks % 3 === 0) { medalsWatch.tick(); bubblesWatch.tick(); askCountsWatch.tick(); }      // another tab's medals / switch / counts, every 3 s
  processes.sweep();
  occupancy.tick();          // an idle teammate's claim, once it has been quiet for long enough
  night.tick();              // a night that went overdue: a verdict of time, pushed when the clock makes it
  // Re-broadcast so elapsed times tick up in the GUI without the view having to
  // own a clock of its own -- and on both falling edges: a sweep that removed
  // the last row, and a party that shrank with nothing left running.
  // host/processes-broadcast.js owns both.
  refreshPermissionMode();
  processesBroadcast.tick(processes.list(), mood.stack());
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

// FF21: 3s rather than the 1s mood cadence -- a `git checkout` is a deliberate,
// human-paced action, not a per-second tick like elapsed time, and reading a
// tiny file three times a second for that would be pure waste. Broadcasts on
// every CHANGE of value, not just a falling edge -- checking out a second
// branch must update the header too, not just clear it.
// Every tenth tick (30s) it also re-counts branch health and re-checks for
// other sessions in this worktree -- both spawn a process, so not every 3s.
let branchTicks = 0;
const branchTimer = setInterval(() => {
  const branch = currentBranch(CWD);
  let changed = false;
  if (branch !== branchWas) {
    branchWas = branch;
    changed = true;
    broadcastControl({ type: 'branch', branch });
  }
  branchTicks++;                     // every tick, change or not (Miguel G3)
  checkIdle();
  if (changed || branchTicks % 10 === 0) refreshBranchHealth();
  if (branchTicks % 10 === 0) {
    refreshTerminals();
    recheckLock().catch((err) => console.log('[host] lock re-check failed:', err && err.message));
  }
}, 3000);
branchTimer.unref();

// --- the session lock, other sessions, branch health (Extension X1/X4) -----

function setLockState(lock) {
  lockState = lock;
  broadcastControl({ type: 'lock', lock });
}

// A host the lock blocked, with no session and no window, has nothing to keep
// alive: it goes once that has lasted a whole grace period (session-gate
// createIdleWatch). Checked on every timer tick -- so a host whose first
// window never connected goes too (Miguel Y3) -- and on every socket close. A
// window attaching resets the clock, so a reopen never races the exit (F2).
const idleWatch = createIdleWatch();
function checkIdle() {
  if (!idleWatch.update(lockState, term !== null, clients.size)) return;
  console.log('[host] blocked, no session and no window: exiting');
  shutdown();
  process.exit(0);
}

// One re-check or override at a time: both call acquire, which can take a
// second, and a second click must not start a second session.
let lockBusy = false;

// *Open anyway*, re-checked first (Dexter, PR #71 F1): if the holder has gone,
// the lock is TAKEN rather than overridden -- an unlocked session on a free
// lock would let the next window take it and start claude #2 unblocked.
async function overrideSession() {
  if (lockBusy) return;
  lockBusy = true;
  try {
    const g = gateAfterRecheck(await acquireSessionLock(SESSION_LOCK, lockOwner), lockState);
    if (term) return;                                  // started meanwhile
    console.log(g.lock.state === 'override'
      ? '[host] session lock overridden: a second session in this worktree'
      : `[host] Open anyway found the lock ${g.lock.state === 'held' ? 'free and took it' : 'unavailable'}`);
    setLockState(g.lock);
    if (g.start) startSession();
  } finally {
    lockBusy = false;
  }
}

// *Stop that session* (host/stop-holder.js): end the holder the pane showed --
// never one with a window open, never one that can't be proven to be the
// lock's process -- then re-check at once, so this window takes the lock
// without waiting out the 30 s timer. A changed lock is re-checked too: the
// pane then names whoever holds it now.
const STOP_RECHECKS = new Set(['stopped', 'gone', 'changed']);
const LOCK_BUSY_TEXT = 'The lock is being checked right now. Try again in a moment.';
const harnessOf = install => path.join(install, '.harness');
// The window says which holder it showed; only a pid and a start are taken from it.
const paneHolder = h => (h && typeof h === 'object' ? { pid: h.pid, startedAt: h.startedAt } : null);
let lastWindowLeftAt = null;           // stop-if-idle's grace (host/control.js)
async function stopLockHolder(shownHolder) {
  if (lockBusy) return;
  lockBusy = true;
  const holder = paneHolder(shownHolder);
  const shownPid = holder && Number.isInteger(holder.pid) ? holder.pid : '?';
  let r;
  try {
    r = await stopHolder({ lockPath: SESSION_LOCK, shown: holder }, {
      readLock,
      isAlive: procAlive,
      startTimes,
      readIdentity: ({ install, port }) => readIdentity({ dir: harnessOf(install), port }),
      readToken: (install, port) => readTokenFile({ dir: harnessOf(install), port }),
      sendControl: sendHostControl,
      windowCount,
      killPidTree,
      sleep: ms => new Promise(res => setTimeout(res, ms)),
      now: Date.now,
    });
  } catch (err) {
    console.log('[host] Stop that session failed:', err && err.message);
    r = { outcome: 'failed', text: "Couldn't stop that session.", how: null, reason: null };
  } finally {
    lockBusy = false;
  }
  console.log(`[host] Stop that session: ${r.outcome} (holder pid ${shownPid}, how ${r.how || 'none'}` +
    (r.reason ? `, controls skipped: ${r.reason}` : '') + ')');
  // Re-checked BEFORE the answer goes out: the re-check's `lock` repaint
  // clears the pane's note, so the answer has to land after it.
  if (STOP_RECHECKS.has(r.outcome)) await recheckLock();
  broadcastControl({ type: 'lock-note', outcome: r.outcome, text: r.text });
}

// Every 30 s for a host the lock kept out (session-gate gateRecheck): a
// blocked window whose holder has gone takes the lock and starts; an
// overridden session takes the lock once it is free, so the next window on
// this worktree IS blocked, as the badge promises.
async function recheckLock() {
  if (lockBusy || !lockOwner || (lockState.state !== 'blocked' && lockState.state !== 'override')) return;
  lockBusy = true;
  try {
    const g = gateRecheck(lockState, term !== null, await acquireSessionLock(SESSION_LOCK, lockOwner));
    if (!g) return;
    console.log('[host] lock re-check:', JSON.stringify(g.lock));
    setLockState(g.lock);
    if (g.lock.state === 'held' && term) updateSessionLock(SESSION_LOCK, lockOwner, { claudePid: term.pid });
    if (g.start) startSession();
  } finally {
    lockBusy = false;
  }
}

// Behind develop (a tab) or develop ahead of main (dev); counts are null when
// unknown, never 0. One run at a time: git on a slow disk can outlast a tick.
let branchHealthState = null;
let branchHealthRunning = false;
async function refreshBranchHealth() {
  if (branchHealthRunning) return;
  branchHealthRunning = true;
  try {
    const next = await branchHealth(CWD);
    if (JSON.stringify(next) !== JSON.stringify(branchHealthState)) {
      branchHealthState = next;
      broadcastControl({ type: 'branch-health', health: next });
    }
  } catch (err) {
    console.log('[host] branch health failed:', err && err.message);
  } finally {
    branchHealthRunning = false;
  }
}

// Other live `claude` sessions in this worktree -- a terminal one, typically.
// Warned about, never blocked. Our own session is excluded by pid and session
// id, and so is the lock holder's (the blocked view already names it).
let terminalSessions = null;
let terminalsRunning = false;

// Layout pass L1: this tab's own layout (*Just this tab*), or null to follow
// the global one. Memory only, on purpose: it survives the window reattaching
// and dies with the session (host/layout-override.js).
let layoutOverride = null;
async function refreshTerminals() {
  if (terminalsRunning) return;
  terminalsRunning = true;
  try {
    // The holder re-read from the lock (Dexter, PR #71 F8): a host blocked
    // before the holder wrote its claude pid in would otherwise list the
    // holder's own session as "another session in this worktree".
    const holder = lockState.holder ? (readHolder(SESSION_LOCK) || lockState.holder) : null;
    const pids = [term && term.pid, holder && holder.claudePid].filter(p => Number.isInteger(p));
    // #81: the folder's side host (or, in a side host, the folder's own host) is not "another session": it is the other half of
    // this one's pair, and never a second writer.
    const sibs = siblingSessions(ownIdentities(), { cwd: CWD, side: SIDE, ownPort: PORT });
    const next = await liveSessionsIn(CWD, { exclude: { pids: [...pids, ...sibs.pids], sessionIds: [...(sessionId ? [sessionId] : []), ...sibs.sessionIds] } });
    if (next.format === 'unknown' && (!terminalSessions || terminalSessions.format !== 'unknown')) {
      console.log('[host] session registry: unknown format -- terminal sessions not checked (see verify/probe-session-registry.js)');
    } else if (next.format === 'ok' && !next.verified && (!terminalSessions || terminalSessions.verified)) {
      console.log('[host] session registry: some sessions could not be confirmed (unreadable files or start times) -- no warning shown');
    }
    if (JSON.stringify(next) !== JSON.stringify(terminalSessions)) {
      terminalSessions = next;
      broadcastControl({ type: 'terminal-sessions', ...next });
    }
  } catch (err) {
    console.log('[host] terminal session check failed:', err && err.message);
  } finally {
    terminalsRunning = false;
  }
}

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
    // A used-up window is also re-sent every poll: the header's countdown (BACKLOG #90) ages the payload by its readAt, so a
    // figure that never changed must keep arriving fresh or the page would call it stale after four minutes.
    const usedUp = !!quota && quota.ok === true && Array.isArray(quota.windows)
      && quota.windows.some(w => w && ((typeof w.percent === 'number' && w.percent >= 100) || w.lockedReason));
    if (usedUp || JSON.stringify(quota && quota.windows) !== before) {
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

// BACKLOG E #5, step 2: warm the OpenRouter catalogue's disk cache at boot,
// same reasoning as usage/agentStats above -- a Models tab opened moments
// after launch should find a cache already fresh rather than starting a
// network round trip itself. NOT broadcast: nothing needs the catalogue until
// a client asks for it (the 'models' branch), so this only needs to have
// WRITTEN the cache by then, which currentCatalogue()'s own writeCache does.
// Swallowed on failure exactly like its siblings -- offline at launch is not
// fatal, `loadCatalogue` already reports it as `stale`/`error` to whichever
// client asks next.
currentCatalogue().catch(() => {});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  ws.openedAt = Date.now();
  // A one-shot control client (raise, stop) never gets what is held for the next WINDOW (PR #93 Dexter F8)
  const oneShot = isControlClient(req && req.url);
  console.log(`[host] client attached (${clients.size} total)`);

  // Dexter, logic review 2026-09-15: a malformed WEBSOCKET frame (invalid
  // UTF-8 in a text frame, RSV1 set, an invalid opcode) never reaches the
  // 'message' handler below -- `ws`'s Receiver rejects it and emits 'error'
  // on the socket instead. An EventEmitter emitting 'error' with no listener
  // throws and, with no process-level handler either, takes the whole host
  // down -- and the pty with it, defeating the detach/reattach property this
  // host exists to provide. One malformed frame from any client that clears
  // the gatekeeper, no control-message parsing involved at all.
  ws.on('error', (err) => {
    console.log('[host] client socket error:', err && err.message);
  });

  // Attach handshake: everything the view needs to draw itself, then the
  // current screen. The view holds no session state of its own, so this is the
  // only place it learns the theme, the roster or what is on the terminal.
  // `background` used to be `background.path` unconditionally -- resolved
  // through style.js instead, so a per-project override (FF6) wins over the
  // generated art without the Style panel needing a second round trip just to
  // learn what is already showing.
  const styleResolved = currentStyle();
  const summaryNow = summary.snapshot();
  sendControl(ws, {
    type: 'hello',
    // What this host accepts as control. host/host-client.js sends `stop` /
    // `raise` only to a host that lists them: an older one would type them into
    // the session as input (PR #75).
    controls: [...CONTROL_TYPES],
    cwd: CWD,
    // Whether the claude-custom mod is on, off or could not load, and why (PR #197 Miguel Y9): the diagnostics pane says it.
    modStatus,
    // This session's id, null before SessionStart: the roster cards match a worktree claim on it (backlog #57).
    sessionId,
    // FF21. `project` is the same source of truth as the OS window title
    // (FF3, `projectLabel`) rather than a second guess at the same string.
    // `branch` is null for "not a git repo"; for a detached HEAD it is a
    // `~`-prefixed short SHA (see host/git-branch.js) rather than a bare one,
    // so it can never read as a real branch of the same name.
    project: projectLabel(PROJECT_ROOT),
    branch: branchWas,
    // Extension X1/X4: whether this window has a session or was blocked by
    // another one in the same worktree, other live sessions here, and how far
    // the branch is from develop (null until first counted).
    lock: lockState,
    terminalSessions,
    branchHealth: branchHealthState,
    theme: styleResolved.theme,
    hooks: helperExists,
    background: styleResolved.background,
    style: { source: styleResolved.source, kind: styleResolved.kind, setAt: styleResolved.setAt, look: styleResolved.look, cliTheme: RUNNING_CLI_THEME },
    usage: currentUsage(),
    roster: mood.roster().map(r => describe(r.agent, r.state, r.detail)),
    // host/turn-state.js: 'idle' | 'turn' | 'prompt', or null before the session has started
    turn: turnState.snapshot(),
    // The terminal bar: the latest main-session prompt (null: none yet) and the bedtime night (null: no night).
    prompt: promptKeeper.snapshot(),
    bedtime: night.payload(),
    // BACKLOG #119 A7: everything scheduled in every session, grouped (host/schedules.js buildView).
    schedules: schedulesControl.payload(),
    // Backlog #39: this session's "where are we" summary (null: none yet) and why there is no fresh one (null: nothing wrong).
    summary: summaryNow.summary,
    summaryOff: summaryNow.off,
    // Backlog #39 job 2: docs that may be out of date after a merge into develop, and why the check is off (null: nothing wrong).
    docsDrift: drift.snapshot(),
    // Persisted across restarts (BACKLOG #14); reconciled first so a fresh
    // window never starts with a flag on an agent that is awake.
    hidden: hiddenAtAttach(),
    medals: medals.all(),
    explainer: explainerFrame(),
    bubbles: { enabled: bubbleSettings.enabled() },
    globalPortrait: globalPortraitInfo(),
    running: processes.list(),
    party: mood.stack(),
    // The scrape wins once it has anything; permission_mode off the hook
    // payload only fills the gap before the TUI has drawn a status line at
    // all -- see lastHookPermissionMode's declaration above.
    mode: permissionMode || lastHookPermissionMode,
    modes: MODES,
    provider,
    // FF12's top bar: null until the first hook payload carries effort.level,
    // which the panel renders as "—" rather than a guessed default.
    effort: lastEffort,
    liveModel: lastLiveModel,
    context: lastContext,
    statusFields: lastStatusFields,
    cooldowns: cooldowns.list(),
    // The tool belt: what is equipped on which agent type, plus the catalogue
    // the renderer draws from. Read off disk here, so a reattach is never stale.
    loadout: loadoutControl.payload(),
    // The wand: the favourites (or why they are unavailable) and the skills they can point at.
    wand: wandControl.payload(),
    // Claude's panel: whether the running session has built one (never the page: a window asks for it), and its hosts.
    canvas: canvasControl.payload(),
    // Layout pass L1: this tab's own layout, or null for the global one.
    layoutOverride,
    vault: vaultPayload(),
    health: healthState,
    agentStats: lastAgentStats,
    // The WHOLE roster (BACKLOG D #16) -- still `complete: false` on a fast
    // attach, before the first background scan across every project has
    // finished. The renderer draws every total as a lower bound until then.
    rosterIndex: lastRosterIndex,
    // May still be `{model:null,...}` on a fast attach, before SessionStart's
    // read lands -- the renderer draws "—" for that, never a guessed model.
    sessionModel: sessionModels.current(),
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

  // The whole-roster scan is install-wide, not per-project, so it is kicked
  // off once at boot (below, near `wss`'s creation) rather than per
  // connection -- but a client attaching before that first pass has landed
  // still deserves the update the moment it does, same reasoning as usage and
  // agentStats above.
  if (!lastRosterIndex.complete) {
    refreshRosterIndex()
      .then((rosterIndex) => {
        if (ws.readyState === ws.OPEN) sendControl(ws, { type: 'rosterIndex', rosterIndex });
      })
      .catch(() => { /* the next attach will carry it */ });
  }

  // A milestone reached while nothing was attached is delivered now rather than
  // lost: the pty outlives the window by design, so the crossing can easily
  // happen with no observer.
  if (!oneShot && pendingMilestone && ws.readyState === ws.OPEN) {
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
  if (!oneShot && pendingQuotaWarning && ws.readyState === ws.OPEN) {
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

  // BACKLOG #10: this window's open agent log, if any. One per window, closed
  // when the window detaches. `running` comes from the same invocations the
  // roster is drawn from, so "live" never disagrees with the card.
  const agentLog = createLogSession({
    cwd: CWD,
    invocations: () => mood.invocations(),
    watchedEnd: (agentId) => mood.watchedEnd(agentId),
    send: (frame) => sendControl(ws, frame),
  });

  const replay = termState.serialize();
  if (replay) ws.send(Buffer.from(replay, 'utf8'), { binary: true });

  // The actual side effects for each known control type. Kept as a plain
  // function (not inline in the message handler) so `handleFrame` -- the
  // classify/dispatch/fall-through SHAPE -- can be tested in host/control.js
  // against a fake dispatch, per Miguel and Dexter's 2026-09-15 finding that
  // the first version of this fix had no test for the property that actually
  // mattered: a throwing dispatch must never reach literal input.
  function dispatchControl(msg) {
    if (msg.type === 'resize') {
      // Validated before EITHER target is touched, and applied to both or
      // neither: node-pty throws on bad dims, @xterm/headless instead
      // silently clamps to a minimum of 2 columns, so an unvalidated resize
      // can desync the two permanently -- a serialized 2-column screen would
      // then be handed to every future attach.
      if (validResizeDims(msg.cols, msg.rows)) {
        if (term) term.resize(msg.cols, msg.rows);   // null while blocked
        termState.resize(msg.cols, msg.rows);
      } else {
        // Dexter, 2026-09-15: every other rejection path in this file logs;
        // a rejected resize previously said nothing, leaving the client's own
        // (already-resized) xterm silently disagreeing with the host.
        console.log('[host] rejected resize:', msg.cols, msg.rows);
      }
      return;
    }
    if (msg.type === 'drop') {
      // Dispatched here rather than from the ws handler, which is where this
      // branch originally put it: #18 landed in between and moved every
      // control frame behind parseControlFrame's allow-list. A `drop` frame
      // that is not on that list is not merely ignored -- it falls through to
      // `term.write` and is TYPED, verbatim JSON and all, into a session
      // running --dangerously-skip-permissions. That is the exact hole #18
      // exists to close, and it would have reopened silently on merge.
      handleDrop(msg, ws);
      return;
    }
    // RE-HOMED during the develop merge, and this is the second time this
    // exact conflict has hidden this exact defect. This handler lived in the
    // ws message handler's inline if-chain, which is the shape #18 replaced
    // with parseControlFrame + dispatchControl. Taking develop's side of the
    // conflict wholesale -- the obviously correct resolution, since that side
    // IS the newer architecture -- silently deletes this branch's only
    // feature, and a `bugvault` frame then falls through to `term.write` and
    // is TYPED, verbatim JSON and all, into a session running
    // --dangerously-skip-permissions. #24's `drop` handler was lost and
    // recovered the same way.
    if (msg.type === 'bugvault') {
      // Synchronous JSON, unlike fog's git walk -- answered inline, then
      // broadcast, same as the seat protocol: two windows on one project
      // share a vault, so one of them silently disagreeing about what is
      // recorded is worse than a redraw.
      // Routing lives in host/bugvault.js so it can be tested without a pty.
      // Dexter F4: the if-chain that used to stand here initialised `result`
      // to `{ ok: true }`, so an unrecognised action was broadcast as a
      // SUCCESS -- fail-open, in the dispatcher. F5: it also passed
      // `msg.fixed === true`, collapsing "explicitly false" and "absent" into
      // the same value before the vault could tell them apart.
      const result = applyVaultAction(bugVault, msg);
      broadcastControl({ type: 'bugvault', ...vaultPayload(), error: result.ok ? null : result.error });
      return;
    }
    if (msg.type === 'agent-log') {
      // Read-only: opens a transcript the CLI already wrote, never touches it.
      const req = validAgentLogRequest(msg);
      if (!req) {
        console.log('[host] rejected agent-log request:', msg.action);
        return;
      }
      if (req.action === 'open') {
        agentLog.open(req.agent).catch((err) => {
          console.log('[host] agent-log open failed:', err && err.message);
        });
      } else {
        agentLog.close();
      }
      return;
    }
    if (msg.type === 'projects') {
      sendProjects(ws);
      return;
    }
    if (msg.type === 'open') {
      openProject(msg, ws);
      return;
    }
    if (msg.type === 'health') {
      // Caught: an unhandled rejection terminates Node by default.
      runHealth().catch(() => {});   // broadcasts on start and on finish
      return;
    }
    if (msg.type === 'lean') {
      leanGate.set(ws, msg.on === true);
      return;
    }
    if (msg.type === 'input') {
      // Miguel, 2026-09-15: unvalidated, `term.write(undefined)` reaches
      // node-pty's deferred write queue and can throw OUTSIDE this function's
      // caller's try/catch if the pty is not yet ready -- an uncaught
      // exception that kills the host and the session with it.
      if (typeof msg.data === 'string' && term) term.write(msg.data);
      return;
    }
    if (msg.type === 'layout-override') {
      // *Just this tab* / *Reset to global* (layout pass L1). Broadcast, not
      // just stored: two windows can attach to one host, and the one that
      // didn't make the change must not keep drawing the old layout.
      const r = acceptOverride(msg.layout);
      if (!r.ok) {
        console.log('[host] rejected layout-override');
        return;
      }
      layoutOverride = r.value;
      broadcastControl({ type: 'layout-override', layout: layoutOverride });
      return;
    }
    if (msg.type === 'lock-override') {
      // *Open anyway* (Extension X1): only a BLOCKED window with no session
      // yet can start one past the lock. Not saved -- the next window on this
      // worktree is blocked again. overrideSession re-checks first.
      if (!gateOverride(lockState, term !== null)) {
        console.log('[host] lock-override ignored in state', lockState.state);
        return;
      }
      // A click during a re-check or a stop is answered, not dropped (Dexter, PR #76 F4).
      if (lockBusy) {
        sendControl(ws, { type: 'lock-note', text: LOCK_BUSY_TEXT });
        return;
      }
      overrideSession().catch((err) => console.log('[host] lock-override failed:', err && err.message));
      return;
    }
    if (msg.type === 'lock-stop-holder') {
      // *Stop that session*: only a BLOCKED window with no session of its own
      // asks. Once this host runs claude the holder is none of its business.
      if (lockState.state !== 'blocked' || term !== null) {
        console.log('[host] lock-stop-holder ignored in state', lockState.state);
        return;
      }
      if (lockBusy) {
        sendControl(ws, { type: 'lock-note', text: LOCK_BUSY_TEXT });
        return;
      }
      // The holder the PANE showed (Dexter F6): if a re-check repainted it to
      // another holder meanwhile, host/stop-holder.js answers 'changed'.
      stopLockHolder(msg.holder).catch((err) => console.log('[host] lock-stop-holder failed:', err && err.message));
      return;
    }
    if (msg.type === 'stop-if-idle') {
      // *Stop that session*, asked of THIS host by a window another one
      // blocked. Counted and acted on in one step (Dexter, PR #76 F2): a
      // session with a window -- or one that just left, likely reloading -- is
      // in use, so its windows come forward instead and nothing ends.
      const targets = raiseTargets(clients, ws);
      const v = idleStopVerdict({ windows: targets.length, lastWindowLeftAt, now: Date.now() });
      if (!v.stop) {
        console.log(`[host] stop-if-idle refused: ${v.windows} window(s)${v.recent ? ', one just left' : ''}`);
        for (const w of targets) sendControl(w, { type: 'raise' });
        sendControl(ws, { type: 'stop-if-idle', stopped: false, windows: v.windows, recent: Boolean(v.recent) });
        return;
      }
      console.log('[host] stop-if-idle: no window, stopping');
      // The answer is flushed before the host goes; a second later it goes
      // anyway. Whichever comes first exits, so the other never runs.
      setTimeout(() => { shutdown(); process.exit(0); }, 1000);
      ws.send(JSON.stringify({ type: 'stop-if-idle', stopped: true }), () => { shutdown(); process.exit(0); });
      return;
    }
    if (msg.type === 'stop') {
      // A tab closed by hand (worktree tabs). The same teardown SIGTERM runs:
      // release the lock, end the pty. Authorised like every control frame --
      // the connection already presented the session token at the handshake.
      console.log('[host] stop requested');
      shutdown();
      process.exit(0);
    }
    if (msg.type === 'raise') {
      // *Go to that session*: every window attached here comes forward, and
      // the sender learns how many there were (0 means nobody to raise). The
      // sender is a one-shot client, not a window, so it is not counted.
      const targets = raiseTargets(clients, ws);
      for (const w of targets) sendControl(w, { type: 'raise' });
      sendControl(ws, { type: 'raised', windows: targets.length });
      return;
    }
    if (msg.type === 'models') {
      // Asynchronous and yielding for the same reason the fog read is: the
      // loop here also accepts the hook helper's named-pipe connection, and
      // it gives up after 80ms. `.then(ok).catch(err)`, not
      // `.then(ok, err)` -- Dexter, 2026-09-15: the two-argument form does
      // NOT catch a throw from `ok` itself, which would become an unhandled
      // rejection.
      // `seq` is echoed back VERBATIM, whatever it is (a number, absent,
      // garbage) -- Dexter, PR #60 round 2, N1/N2. The client tags every
      // request with one and uses the echo to tell "the reply to MY click"
      // apart from an unrelated request's reply; the host has no reason to
      // interpret it, only to hand it straight back.
      currentCatalogue({ force: !!msg.force }).then(
        (c) => ws.send(JSON.stringify({
          type: 'models', models: c.models, source: c.source,
          fetchedAt: c.fetchedAt, stale: c.stale, error: c.error, seq: msg.seq,
          seats: readSeats(), max: MAX_SEATS, warnings: seatWarnings(readSeats()),
        }))
      ).catch((err) => {
        // Tell the CLIENT, not only the log. A silent failure leaves the
        // panel reading "loading..." forever, which looks like a slow host
        // rather than a lost answer.
        console.log('[host] catalogue failed:', err && err.message);
        try {
          ws.send(JSON.stringify({
            type: 'models', models: [], source: 'none', stale: true,
            error: err && err.message, seq: msg.seq, seats: readSeats(), max: MAX_SEATS, warnings: [],
          }));
        } catch { /* the socket went away */ }
      });
      return;
    }
    if (msg.type === 'seat') {
      // add / remove. The RESULT is broadcast rather than returned to the
      // asking client alone: two windows on one project share a council, and
      // one of them silently disagreeing about who is seated is worse than a
      // redraw.
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
    if (msg.type === 'portrait') {
      if (msg.action === 'set-global' || msg.action === 'reset-global') handleGlobalPortrait(msg);
      else handlePortraitUpload(msg);
      return;
    }
    if (msg.type === 'roster') {
      handleRosterMessage(msg);
      return;
    }
    if (msg.type === 'medal') {
      handleMedalMessage(msg);
      return;
    }
    if (msg.type === 'usage') {
      usageCounters.bump(msg.key);       // junk keys and a file it can't read are refused inside; never an answer, never an error
      return;
    }
    if (msg.type === 'bubbles') {
      handleBubblesMessage(msg, ws);
      return;
    }
    if (canvasControl.handles(msg.type)) {
      // Answered by a broadcast `canvas` frame (host/canvas-control.js), the refusal included.
      canvasControl.handle(msg);
      return;
    }
    if (schedulesControl.handles(msg.type)) {
      sendControl(ws, schedulesControl.reply(msg));
      return;
    }
    if (wandControl.handles(msg.type)) {
      // Broadcast, refusal included: the frame carries the true state, and two windows disagreeing about
      // a favourite is worse than a redraw. Answers are never `quiet` (host/wand-control.js).
      broadcastControl(wandControl.handle(msg));
      return;
    }
    if (msg.type === 'loadout-equip' || msg.type === 'loadout-unequip') {
      // Broadcast, refusal included: the frame carries the true state, and two
      // windows disagreeing about a belt is worse than a redraw. No frame from
      // host/loadout-control.js is `quiet` (PR #64 N1), so a refusal stays visible.
      broadcastControl(loadoutControl.handle(msg));
      return;
    }
    if (msg.type === 'fog') {
      // Answered on demand, asynchronously, yielding as it goes -- the read
      // must never hold the loop past the helper's 80ms connect timeout, or
      // it drops the hook events this panel is drawn from.
      currentFog().then(
        fog => ws.send(JSON.stringify({ type: 'fog', ...fog }))
      ).catch(err => {
        // Tell the CLIENT, not just the log. A silent failure left the panel
        // reading "reading the map..." forever, which looks like a slow host
        // rather than a lost answer.
        console.log('[host] fog read failed:', err && err.message);
        try {
          ws.send(JSON.stringify({ type: 'fog', files: [], explored: 0, total: 0,
            status: { failed: true, error: err && err.message } }));
        } catch { /* the client went away */ }
      });
      return;
    }
    if (msg.type === 'repo') {
      // Answered asynchronously, and the reply names the asking `seq`. The service never rejects: a
      // failure is { ok: false, why | error }, so the page can say so instead of waiting forever.
      repoService.handle(msg).then(reply => {
        try { ws.send(JSON.stringify(reply)); } catch { /* the client went away */ }
      });
      return;
    }
    if (msg.type === 'ask') {
      // Which windows have an Ask panel open (per socket, so one window can't cancel another): the explainer is Active while any does.
      // Not answered: it asks for nothing.
      if (msg.op === 'panel') { askExplainer.setPanel(ws, msg.open === true); return; }
      if (msg.op === 'ask') usageCounters.bump('ask:question');
      else if (msg.op === 'explain') usageCounters.bump('ask:explain');
      // Answered asynchronously, and the reply names the asking `seq`. The service never rejects: a failure is { ok: false, reason, ... }.
      askService.handle(msg).then(reply => {
        try { ws.send(JSON.stringify(reply)); } catch { /* the client went away */ }
      });
      return;
    }
    if (msg.type === 'docs-drift') {
      // Dismiss a note (hidden for good, on every window of the project) or ask for the list again. The host only ever
      // hides a note: no document is touched.
      if (msg.action === 'dismiss' && typeof msg.id === 'string') {
        const r = drift.dismiss(msg.id);
        // A good dismissal was just broadcast to every window (this one too); a failed one is said, to the window that asked.
        if (!r.ok) {
          console.log('[drift] dismiss failed:', r.error);
          sendControl(ws, { type: 'docs-drift', ...drift.snapshot(), error: `Couldn't hide that note: ${r.error}` });
        }
        return;
      }
      sendControl(ws, { type: 'docs-drift', ...drift.snapshot() });
      return;
    }
    if (msg.type === 'git-tree') {
      // The Git panel (documentation/PLAN_GIT_TREE.md). gitTree.get() never rejects: a failure
      // arrives as { ok: false, error }, so the panel can say so instead of waiting forever.
      gitTree.get().then(tree => {
        try { ws.send(JSON.stringify({ type: 'git-tree', ...tree })); } catch { /* the client went away */ }
      });
      return;
    }
    if (msg.type === 'git-graph') {
      // The Graph view. Like git-tree, it never rejects: a failure arrives as { ok: false, error }.
      gitGraph.get().then(graph => {
        try { ws.send(JSON.stringify({ type: 'git-graph', ...graph })); } catch { /* the client went away */ }
      });
      return;
    }
    if (msg.type === 'style') {
      // set-background / reset-background / set-look / reroll-look. A refusal answers ONLY the asking
      // client -- it is that action failing, not a state change anyone else
      // needs to hear about, the same distinction host/host.js already draws
      // for the project picker's 'open' errors. A successful change IS
      // broadcast: two windows can attach to one host and one of them silently
      // disagreeing about what is showing is worse than a redraw.
      //
      // `ask` names the Style-tab section that asked, echoed on the refusal and
      // on the broadcast, so the view files a refusal under the request it
      // ANSWERS rather than whichever was sent last (Dexter F2). Only known
      // section names are echoed.
      const ask = msg.ask === 'colours' || msg.ask === 'background' ? msg.ask : undefined;
      const refuse = (error) => ws.send(JSON.stringify({ type: 'style', ask, error }));
      const announce = () => broadcastControl({ type: 'style', ask, ...currentStyle() });
      if (msg.action === 'set-background') {
        const asked = msg && msg.path;
        if (typeof asked !== 'string' || !asked.trim()) {
          refuse('no file was given');
          return;
        }
        // Async (Miguel M1): the copy of a large video must not stall every viewer.
        setBackground({ source: asked, cwd: STATE_ROOT }).then((r) => {
          if (!r.ok) {
            console.log('[host] style refused :', r.reason);
            refuse(r.reason);
            return;
          }
          announce();
        }).catch((err) => refuse(`could not set the background: ${err && err.message}`));
        return;
      }
      if (msg.action === 'reset-background') {
        try {
          resetBackground({ cwd: STATE_ROOT });
        } catch (err) {
          refuse(`could not reset: ${err.message}`);
          return;
        }
        announce();
        return;
      }
      if (msg.action === 'reroll-look') {
        // The Style tab's "Random colours": host/style.js generates and saves,
        // with the same refusals set-look has.
        const r = rerollLook({ cwd: STATE_ROOT, terminalForeground: theme.terminal && theme.terminal.foreground });
        if (!r.ok) {
          refuse(r.reason);
          return;
        }
        announce();
        return;
      }
      if (msg.action === 'set-mode') {
        // Backlog #25: Dark / Light. host/style.js swaps the project's two looks (rolling a palette the first
        // time a mode is chosen); the CLI's own theme follows on the next launch (LAUNCH_CLI_THEME).
        const r = setMode({ cwd: STATE_ROOT, mode: msg.mode, userTheme: USER_CLI_THEME, terminalForeground: theme.terminal && theme.terminal.foreground });
        if (!r.ok) {
          refuse(r.reason);
          return;
        }
        announce();
        return;
      }
      if (msg.action === 'match-colours') {
        // "Match colours to this background" (#34): `seeds` are the few dominant colours the
        // renderer sampled from the picture or the video's current frame. Never the pixels.
        // `setAt` is the background the renderer sampled: a match for one that has since been reset or
        // replaced (by another window) is refused in host/style.js (Dexter D5).
        const r = matchLook({ cwd: STATE_ROOT, seeds: msg.seeds, setAt: msg.setAt,
          terminalForeground: theme.terminal && theme.terminal.foreground });
        if (!r.ok) {
          refuse(r.reason);
          return;
        }
        announce();
        return;
      }
      if (msg.action === 'set-look') {
        // Colours and darkness only -- host/style.js refuses any other key, so
        // this cannot point the background at a file it did not copy in.
        const r = setLook({ cwd: STATE_ROOT, patch: msg.look });
        if (!r.ok) {
          refuse(r.reason);
          return;
        }
        announce();
        return;
      }
      return;
    }
  }

  ws.on('message', (raw, isBinary) => {
    // Control frames arrive as JSON; everything else is raw keystrokes.
    if (!isBinary) {
      const text = raw.toString();
      const { error, msg } = handleFrame(text, dispatchControl, (t) => { if (term) term.write(t); });
      if (error) {
        // A handler that threw is not "not control JSON" -- `handleFrame`
        // guarantees this text was never passed to `term.write`. Log and
        // drop.
        console.log('[host] control message failed:', msg && msg.type, error && error.message);
      }
      return;
    }
    if (term) term.write(raw.toString('utf8'));   // keystrokes into a blocked window go nowhere
  });

  ws.on('close', () => {
    clients.delete(ws);
    leanGate.drop(ws);
    bubbles.dropViewer(ws);      // BACKLOG #80: a window that left can't show a bubble
    askExplainer.dropViewer(ws); // ... nor keep the Ask explainer Active
    // A WINDOW leaving (not a one-shot control client) starts stop-if-idle's
    // grace: it may be reloading, and its session is in use.
    if (leftAsWindow(ws.openedAt, Date.now())) lastWindowLeftAt = Date.now();
    agentLog.close();
    console.log(`[host] client detached (${clients.size} remain)`);
    // NOTE: the pty deliberately keeps running. This is the detachable-session
    // property the phone/Remote Control workflow depends on. A BLOCKED host has
    // no pty to keep: checkIdle starts its clock here, and the timer ends it.
    checkIdle();
  });
});

/**
 * The identity file is published from the 'listening' EVENT, and that ordering
 * is the whole fix for Dexter's Finding 1 (Critical).
 *
 * `new WebSocketServer({port})` binds ASYNCHRONOUSLY and does not throw. The
 * previous version published in the same synchronous tick as the constructor,
 * under a comment claiming it happened "after the socket is actually
 * accepting" -- which was simply false, and was the reassurance that would
 * have stopped the next reader checking.
 *
 * What that cost: two windows opening one project at once (a double-click on a
 * picker row is enough) both saw the port free and both spawned. The LOSER
 * wrote its token files over the winner's, spawned a real claude, published
 * its own pid as the identity for that port -- and only then died on
 * EADDRINUSE. `shutdown()` runs on SIGINT/SIGTERM only, so nothing repaired
 * it. The port was then held by the live winner while the identity named a
 * dead pid, so every later launch read it, decided 'unidentified', and STEPPED
 * PAST the live host to spawn an empty session. Silently, and forever: a
 * Remote Control session in that host could never be reached from the GUI
 * again. The recovery path reintroduced the exact failure class this feature
 * exists to remove.
 */
let boundPort = null;                 // set only once the bind has succeeded

wss.on('listening', () => {
  boundPort = PORT;
  console.log(`[host] listening on ws://127.0.0.1:${PORT}`);
  writeTokenFiles();
  try {
    console.log('[host] identity     :', writeIdentity({ dir: HARNESS_DIR, port: PORT, cwd: CWD, side: SIDE, sessionId: SIDE ? sessionId : undefined,
      processStartedAt: lockOwner ? lockOwner.processStartedAt : undefined, claudePid: term ? term.pid : undefined }));
  } catch (err) {
    // A host that cannot publish still works for the window that spawned it;
    // it just cannot be recognised later, so the next window steps to another
    // port rather than reattaching. Degraded, not broken -- and said out loud,
    // because "why did it open a second host" is otherwise unanswerable.
    console.error('[host] could not publish identity:', err.message);
  }
});

// Once claude starts (or restarts): the identity again, now naming it. Only by
// the host that bound the port, and only once the start time is known -- the
// exact proof stays; until then the bind or boot write adds it (Dexter, PR #83 F1).
function republishIdentity() {
  if (boundPort !== PORT || !lockOwner || typeof lockOwner.processStartedAt !== 'string') return;
  try {
    writeIdentity({ dir: HARNESS_DIR, port: PORT, cwd: CWD, side: SIDE, sessionId: SIDE ? sessionId : undefined, processStartedAt: lockOwner.processStartedAt, claudePid: term ? term.pid : undefined });
  } catch (err) {
    console.error('[host] could not add its claude to its identity:', err.message);
  }
}

/**
 * A bind that fails must not take the winner's files with it.
 *
 * Without this listener an 'error' event has no handler, which in Node THROWS
 * -- an uncaught exception, mid-startup, AFTER this process has already
 * overwritten the token files and spawned a real claude.
 *
 * `shutdown()` is called explicitly because the crash path never ran it: it is
 * wired to SIGINT/SIGTERM only, so the pty this process started would have
 * been orphaned -- a permission-bypassed claude with no host and no window.
 *
 * `boundPort` is what stops the cure being worse than the disease. shutdown()
 * unlinks the identity file for PORT, and this process never owned PORT --
 * unlinking it here would leave the host that DID bind unidentifiable, which
 * is the same defect approached from the other side.
 */
wss.on('error', (err) => {
  const ours = boundPort === PORT;
  console.error(`[host] could not listen on ${PORT}: ${err && err.code || err}` +
    (ours ? '' : ' (another host owns this port; leaving its files alone)'));
  shutdown({ removeIdentity: ours });
  process.exit(1);
});

// A test run outlives the host unless it is killed here. With shell:true the
// child is cmd.exe, so an orphaned npm/node keeps running with no parent and
// no window -- invisible, and still holding the repo's build output.
// `removeIdentity` defaults TRUE because the normal exit paths (SIGINT,
// SIGTERM) are this host tidying up after itself. It is false in exactly one
// case: a bind that failed, where this process never owned the port and the
// file belongs to whoever did. Deleting it there would make the LIVE host
// unidentifiable -- Finding 1 from the other direction.
function shutdown({ removeIdentity = true } = {}) {
  if (term) { try { term.kill(); } catch {} }
  try { modServer.close(); } catch {}
  try { repoService.close(); } catch {}
  try { canvasControl.close(); } catch {}
  try { schedulesControl.end(); } catch {}
  releaseSessionLock(SESSION_LOCK, lockOwner);
  killTree(healthChild);
  if (hookBridge) { hookBridge.close().catch(() => {}); }
  // Best effort. The reader already treats a leftover file as absent once the
  // pid is gone, so this is tidiness rather than correctness -- which is why it
  // is safe to swallow, and why the pid check exists instead of relying on it.
  if (removeIdentity) {
    try { fs.unlinkSync(fileFor(HARNESS_DIR, PORT)); } catch {}
  }
}

// SIGINT is not how this host usually dies: main.js spawns it DETACHED so it
// survives the window closing. SIGTERM and exit are the paths that actually
// fire, and leaving them unhandled is what orphans the child.
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
// The lock goes on every exit path that runs JS. A host that is killed
// outright leaves it behind with a dead pid, which the next window takes over
// silently -- release() only ever removes our own lock, so running it twice
// (here and in shutdown) is harmless.
process.on('exit', () => { killTree(healthChild); releaseSessionLock(SESSION_LOCK, lockOwner); });
// The quota poller's lease goes too, so another host polls on its next tick, not after the bound.
process.on('exit', () => { hostQuota.release(); });
// This session's scheduled work is over with it: neighbours see "session ended" at once (and a durable cron job stays on the list).
process.on('exit', () => { schedulesControl.end(); });

// --- the claude-custom mod (BACKLOG #119 A2) ------------------------------------------------------------------------
// mods/claude-custom is loaded into `claude` with --plugin-dir. It reads the CLI's own usage, subagent states and permission asks and
// POSTs them to the server below, which only this host's claude is given the port and token of (its environment, startSession).
// Decided once at boot: the switch (host/cc-mod-settings.js), the CLI's version and the directory. A host with no mod is the host as
// it was: the poller, the relay and the hooks are all still there, and each is only ever overruled by a FRESHER mod figure.
const MOD_DIR = path.join(__dirname, '..', 'mods', 'claude-custom');
const MOD_TOKEN = newToken();
const contextSource = createContextSource();
const modServer = createModServer({ token: MOD_TOKEN, onRecord: (rec) => handleModRecord(rec), log: (m) => console.log('[host]', m) });
let modPort = null;

// Why the mod is not loaded, if it is not: said once in the log and kept for the diagnostics pane (hello + `modStatus`), so a quiet feed
// is never a mystery (PR #197 Miguel Y9). null while it is on or before it has been decided.
let modStatus = null;
function setModStatus(status) {
  modStatus = status;
  broadcastControl({ type: 'modStatus', modStatus });
}

async function prepareMod() {
  try {
    const enabled = modEnabled({ env: process.env, stateDir: path.join(HARNESS_DIR, 'state') });
    // A stand-in binary asked for with CLAUDE_CUSTOM_MOD=1 has no version worth reading.
    const forced = !!process.env.CLAUDE_CUSTOM_BIN;
    const version = enabled && !forced ? await readCliVersion(CLAUDE_BIN) : null;
    const why = modOffReason({ enabled, version, dir: MOD_DIR, forced });
    if (why !== null) {
      console.log('[host] claude-custom mod: not loaded --', why);
      setModStatus({ state: enabled ? 'not-loaded' : 'off', reason: why });
      return;
    }
    modPort = await modServer.listen();
    ARGS = buildClaudeArgs({ ...ARGS_OPTIONS, modDir: modPluginDirFor({ enabled, version, dir: MOD_DIR, forced }) });
    console.log('[host] claude-custom mod: on, posts to 127.0.0.1:' + modPort + ' (CLI', version ? version.join('.') : 'stand-in', ')');
    setModStatus({ state: 'on', reason: null });
  } catch (err) {
    modPort = null;
    console.log('[host] claude-custom mod: not loaded:', err && err.message);
    setModStatus({ state: 'not-loaded', reason: 'the claude-custom mod failed to start: ' + (err && err.message) });
  }
}

// One record from the mod: host/mod-records.js says what each kind feeds, with these collaborators.
const handleModRecord = createModRecordHandler({
  getSessionId: () => sessionId,
  writeWindows: (windows) => recordModWindows({ windows }),
  readQuota: () => hostQuota.readNow(),
  lastWindowsKey: () => JSON.stringify(lastQuota && lastQuota.windows),
  broadcastQuota: (quota) => broadcastControl({ type: 'quota', quota }),
  contextSource,
  setContext,
  mood,
  attention,
  log: (m) => console.log('[host]', m),
});

// --- boot: the session lock, then the session (Extension X1/X3) -------------
// Our own OS start time (for the lock's pid-reuse check: one powershell.exe,
// ~250ms) and Windows' excluded port ranges (two netsh, in parallel, ~100ms)
// are asked for together, so `claude` starts after the slower of the two plus
// the lock itself -- measured ~0.3s, bounded by the 5s query timeouts. A host
// the lock blocks skips the port block entirely (workOutSessionEnv). A bug in
// any of this must not cost the person their session: see the catch.
(async () => {
  const [processStartedAt, excluded] = await Promise.all([createSelfStartTime()(), excludedRanges(), prepareMod()]);
  excludedPorts = excluded;
  lockOwner = { pid: process.pid, processStartedAt, startedAt: Date.now(), port: PORT, claudePid: null, install: path.join(__dirname, '..') };
  // The identity again, now with the OS start time: the exact proof the ▾
  // list needs before it may stop this pid (Dexter, PR 2 F1). Only by the host
  // that bound the port -- a loser must never write over the winner's file.
  if (boundPort === PORT && typeof processStartedAt === 'string') {
    try { writeIdentity({ dir: HARNESS_DIR, port: PORT, cwd: CWD, side: SIDE, sessionId: SIDE ? sessionId : undefined, processStartedAt, claudePid: term ? term.pid : undefined }); } catch (err) {
      console.error('[host] could not re-publish identity with its start time:', err.message);
    }
  }
  const gate = gateFromAcquire(await acquireSessionLock(SESSION_LOCK, lockOwner));
  // Recorded FIRST (Miguel, PR #71 Y1): if anything below throws, the catch
  // must still know a blocked verdict was reached.
  setLockState(gate.lock);
  console.log('[host] session lock  :', SESSION_LOCK || '(not a repo)', JSON.stringify(gate.lock));
  if (gate.start) startSession();
})().catch((err) => {
  // host/session-gate.js gateOnBootError: a blocked verdict stands, a taken
  // lock is kept, anything else starts unlocked -- never a second session.
  const g = gateOnBootError(lockState);
  console.error(`[host] boot failed (${g.start ? 'starting' : 'staying blocked'}):`, err && err.stack || err);
  setLockState(g.lock);
  if (g.start) {
    try { startSession(); } catch (e) { console.error('[host] could not start the session:', e && e.message); }
  }
}).finally(() => {
  refreshBranchHealth();
  refreshTerminals();
});

