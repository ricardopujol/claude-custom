'use strict';
/* What does a /bedtime run emit, and what rule starts, paces and ends a night?   (re-runnable)

   Backlog #52 (documentation/DESIGN_TERMINAL_BAR.md) drew the bedtime rule from what the skill is SUPPOSED to do:
   "starts on a /bedtime prompt or the first ScheduleWakeup, next wake = call + delaySeconds, ends on
   `stop: true` or 15 minutes overdue". This measures what the CLI really emits before a state machine is built.

   TWO MODES

     node verify/probe-bedtime-signal.js            REPLAY (free, offline; the default, exit 0 = every check held)
        Reads test/bedtime-signal.fixture.jsonl -- real hook payloads from --capture, plus the ScheduleWakeup
        calls and wake records read out of real overnight transcripts -- and checks the rule in
        host/bedtime-state.js against them.

     node verify/probe-bedtime-signal.js --capture  one minimal REAL interactive CLI run (haiku, bills the plan,
        about two minutes). It arms ScheduleWakeup for 60 s, lets the CLI wake it, has the woken turn call
        ScheduleWakeup { stop: true }, and records every hook payload to test/bedtime-signal.fixture.jsonl.

     node verify/probe-bedtime-signal.js --mine     re-read this machine's own transcripts (~/.claude/projects) for
        every ScheduleWakeup call and wake, and print the table the fixture's `transcript` rows came from.

   WHAT --capture SETTLES (what a transcript can't say, because a transcript doesn't record hooks):
     1. a ScheduleWakeup call reaches PreToolUse with tool_input { delaySeconds, reason, prompt, noop } and no
        agent_id, and a stop call with { stop: true } alone
     2. WHEN THE CLI WAKES, does UserPromptSubmit fire, and with what `prompt`?
     3. the wake time against call time + delaySeconds

   An interactive run: the CLI is started in this checkout (its parent folder is a trusted one) with a throwaway
   --settings, in a pty, and killed by PID. Deletes ELECTRON_RUN_AS_NODE, CLAUDECODE, every CLAUDE_CUSTOM_* and
   ANTHROPIC_API_KEY (a probe never bills a key; a CLI started inside another session's environment refuses to).
   NEVER kills by name: the only process ended is the pty this started. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'bedtime-signal.fixture.jsonl');

// --- hook mode: append one payload and exit ---------------------------------
if (process.argv[2] === '--log') {
  const [, , , event, file] = process.argv;
  let body = '';
  process.stdin.on('data', d => { body += d; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = { unparseable: body }; }
    fs.appendFileSync(file, JSON.stringify({ kind: 'hook', event, at: Date.now(), payload }) + '\n');
    process.exit(0);
  });
  return;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (label, detail) => console.log(`NOTE  ${label}  -- ${detail}`);

// --- --capture ---------------------------------------------------------------
async function capture() {
  const pty = require('node-pty');
  const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-bedtime-'));
  const logFile = path.join(base, 'hooks.jsonl').replace(/\\/g, '/');
  const self = __filename.replace(/\\/g, '/');
  const node = process.execPath.replace(/\\/g, '/');
  const hook = (matcher, event) => ({
    matcher, hooks: [{ type: 'command', command: `"${node}" "${self}" --log ${event} "${logFile}"`, timeout: 10 }],
  });
  const settings = { hooks: {
    PreToolUse: [hook('ScheduleWakeup', 'PreToolUse')],
    PostToolUse: [hook('ScheduleWakeup', 'PostToolUse')],
    UserPromptSubmit: [hook('', 'UserPromptSubmit')],
    SessionStart: [hook('', 'SessionStart')],
    SessionEnd: [hook('', 'SessionEnd')],
    Stop: [hook('', 'Stop')],
    Notification: [hook('', 'Notification')],
  } };
  const settingsFile = path.join(base, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;

  const events = () => (fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const count = (name) => events().filter(e => e.event === name).length;

  const prompt = 'Call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "bedtime probe", noop false and '
    + 'prompt "bedtime probe tick: call ScheduleWakeup with stop true, then reply with the single word WOKE". '
    + 'Then end your turn with the single word ARMED.';

  console.log('starting claude (haiku, interactive) in a pty; this takes about two minutes...');
  const claudeBin = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const term = pty.spawn(claudeBin, ['--model', 'haiku', '--settings', settingsFile, '--dangerously-skip-permissions'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: ROOT, env,
  });
  let screen = '';
  term.onData(d => { screen += d; });
  const killed = () => { try { killPidTree(term.pid); } catch { /* gone */ } };
  process.on('exit', killed);
  try {
    await sleep(9000);
    note('trust dialog?', /trust/i.test(screen) && /folder|files/i.test(screen) ? 'YES, the CLI stopped at a trust dialog' : 'no');
    term.write(prompt);
    await sleep(600);
    term.write('\r');
    // 1. armed: the first UserPromptSubmit, the ScheduleWakeup PreToolUse, a Stop
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000 && !(count('Stop') >= 1)) await sleep(1000);
    // 2. the wake: a second turn (UserPromptSubmit or, if it doesn't fire, a second PreToolUse / Stop)
    const t1 = Date.now();
    while (Date.now() - t1 < 150_000 && !(count('Stop') >= 2)) await sleep(1000);
    await sleep(3000);
  } finally {
    killed();
  }
  const got = events();
  const out = got.map(e => JSON.stringify(e)).join('\n') + '\n';
  const tmp = FIXTURE + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, FIXTURE);          // atomic: never open the fixture 'w' before the write is sure
  console.log(`captured ${got.length} hook events -> ${FIXTURE}`);
  for (const e of got) {
    const p = e.payload || {};
    console.log(' ', new Date(e.at).toISOString(), e.event, p.tool_name || '', JSON.stringify(p.tool_input || p.prompt || p.source || '').slice(0, 200));
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp */ }
}

// --- --mine: this machine's own overnight transcripts --------------------------------------------------
// Every ScheduleWakeup call (and its result's scheduledFor) in ~/.claude/projects. Prints the table the
// fixture's `transcript` rows summarise; nothing the person wrote is kept, only: the delay asked for, whether the
// prompt names bedtime, whether it starts with it, and how far scheduledFor lay from call + delay.
function mine() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const rows = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'subagents') walk(p); } else if (p.endsWith('.jsonl')) scan(p);
    }
  };
  const scan = (p) => {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
    if (!text.includes('"name":"ScheduleWakeup"')) return;
    const pending = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const c = o.message && o.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'ScheduleWakeup') pending.set(b.id, { at: Date.parse(o.timestamp), input: b.input || {} });
        if (o.type === 'user' && b.type === 'tool_result' && pending.has(b.tool_use_id)) {
          const r = pending.get(b.tool_use_id);
          const sf = o.toolUseResult && o.toolUseResult.scheduledFor;
          rows.push({
            kind: 'transcript', stop: r.input.stop === true,
            delaySeconds: Number.isFinite(r.input.delaySeconds) ? r.input.delaySeconds : null,
            mentionsBedtime: /\bbedtime\b/i.test(r.input.prompt || ''),
            startsWithBedtime: /^\s*\/?bedtime\b/i.test(r.input.prompt || ''),
            sentinel: /autonomous-loop/.test(r.input.prompt || ''),
            scheduledForMinusCallSeconds: typeof sf === 'number' ? Math.round((sf - r.at) / 1000) : null,
          });
        }
      }
    }
  };
  walk(root);
  return rows;
}

function printMine(rows) {
  const sched = rows.filter(r => !r.stop);
  const n = (f) => sched.filter(f).length;
  console.log(`ScheduleWakeup calls: ${rows.length} (${sched.length} schedules, ${rows.length - sched.length} stops)`);
  console.log(`  name bedtime: ${n(r => r.mentionsBedtime)}  (start with it: ${n(r => r.startsWithBedtime)})`);
  console.log(`  sentinel ticks: ${n(r => r.sentinel)}  other polls: ${n(r => !r.mentionsBedtime && !r.sentinel)}`);
  const extra = sched.filter(r => r.scheduledForMinusCallSeconds !== null && r.delaySeconds !== null).map(r => r.scheduledForMinusCallSeconds - r.delaySeconds);
  if (extra.length) console.log(`  scheduledFor minus (call + delay): ${Math.min(...extra)}..${Math.max(...extra)} s over ${extra.length} calls`);
}

// --- replay (the default): the fixture through the rule in host/ ---------------------------------------
function replay() {
  const { createBedtime, mentionsBedtime } = require(path.join(ROOT, 'host', 'bedtime-state'));
  const { createPromptKeeper } = require(path.join(ROOT, 'host', 'prompt-keeper'));
  let rows;
  try { rows = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) {
    check('the fixture is readable (run with --capture to make it)', false, FIXTURE + ': ' + e.message);
    return;
  }
  const hooks = rows.filter(r => r.kind === 'hook');
  const transcript = rows.filter(r => r.kind === 'transcript');
  check('the fixture holds a real capture', hooks.length >= 8, `${hooks.length} hook events, ${transcript.length} transcript rows`);

  const by = (event, pred = () => true) => hooks.filter(h => h.event === event && pred(h.payload));
  const sched = by('PreToolUse', p => p.tool_name === 'ScheduleWakeup' && !p.tool_input.stop)[0];
  const stopCall = by('PreToolUse', p => p.tool_name === 'ScheduleWakeup' && p.tool_input.stop === true)[0];
  const post = by('PostToolUse', p => p.tool_name === 'ScheduleWakeup' && !p.tool_input.stop)[0];
  check('1: a ScheduleWakeup call reaches PreToolUse as { delaySeconds, reason, prompt, noop }, with no agent_id',
    !!sched && Number.isFinite(sched.payload.tool_input.delaySeconds) && typeof sched.payload.tool_input.prompt === 'string'
      && typeof sched.payload.tool_input.reason === 'string' && sched.payload.agent_id === undefined,
    sched ? JSON.stringify(Object.keys(sched.payload.tool_input)) : 'no ScheduleWakeup PreToolUse');
  check('1: ...and the stop call as { stop: true } alone', !!stopCall && Object.keys(stopCall.payload.tool_input).join() === 'stop', stopCall ? JSON.stringify(stopCall.payload.tool_input) : 'none');
  check('1: ...and PostToolUse carries tool_response.scheduledFor (epoch ms) and clampedDelaySeconds',
    !!post && Number.isFinite(post.payload.tool_response && post.payload.tool_response.scheduledFor)
      && Number.isFinite(post.payload.tool_response.clampedDelaySeconds), post ? JSON.stringify(post.payload.tool_response) : 'none');

  const wakePrompt = sched && sched.payload.tool_input.prompt;
  const wake = hooks.find(h => h.event === 'UserPromptSubmit' && sched && h.at > sched.at && h.payload.prompt === wakePrompt);
  check('2: WHEN THE CLI WAKES, UserPromptSubmit fires with the scheduled prompt verbatim', !!wake,
    wake ? `prompt "${wake.payload.prompt.slice(0, 40)}..."` : 'no second UserPromptSubmit carrying the scheduled prompt');
  check('2: ...and no agent_id (the keeper counts it as the main session\'s prompt)', !!wake && wake.payload.agent_id === undefined);
  if (wake && post) {
    const late = wake.at - post.payload.tool_response.scheduledFor;
    check('3: the wake lands within seconds AFTER scheduledFor, never before it', late >= 0 && late < 10_000, `${late} ms after`);
    const asked = sched.payload.tool_input.delaySeconds * 1000;
    const over = post.payload.tool_response.scheduledFor - sched.at - asked;
    check('3: scheduledFor is the call + delaySeconds plus the runtime\'s rounding (0..60 s), not a different clock', over > -5000 && over <= 61_000, `${over} ms over`);
  }

  check('4: the loop prompt names bedtime, and the typed request was the only other prompt',
    mentionsBedtime(wakePrompt) && hooks.filter(h => h.event === 'UserPromptSubmit').length === 2);

  // The rule over the real events, in time order
  let t = 0;
  const night = createBedtime({ now: () => t });
  const keeper = createPromptKeeper({ now: () => t });
  const trace = [];
  for (const h of hooks) {
    t = h.at;
    night.handle({ event: h.event, payload: h.payload });
    keeper.handle({ event: h.event, payload: h.payload });
    const v = night.view(t);
    trace.push(`${h.event}${h.payload.tool_name ? ':' + h.payload.tool_name : ''}=${v === null ? 'off' : v.awake ? 'awake' : 'asleep'}`);
  }
  note('the rule over the capture', trace.join('  '));
  check('5: the night starts on the ScheduleWakeup, is asleep after the turn, awake on the wake, over after stop',
    trace.some(x => x === 'PreToolUse:ScheduleWakeup=awake') && trace.some(x => x === 'Stop=asleep')
      && trace.includes('UserPromptSubmit=awake') && trace[trace.length - 1] === 'Stop=off', trace.join(' '));
  check('5: the typed request, before any ScheduleWakeup, started nothing', trace[1] === 'UserPromptSubmit=off', trace[1]);
  check('6: the prompt keeper ends on the wake\'s prompt (the latest main-session UserPromptSubmit)',
    !!wake && keeper.snapshot() !== null && keeper.snapshot().text === wakePrompt);

  if (transcript.length) {
    const sc = transcript.filter(r => !r.stop);
    const share = sc.filter(r => !r.mentionsBedtime && !r.sentinel).length / sc.length;
    check('7: the real transcripts contain polls that are not bedtime (so "the first ScheduleWakeup" is not a start)',
      sc.some(r => !r.mentionsBedtime), `${Math.round(share * 100)}% other polls, ${Math.round(sc.filter(r => r.sentinel).length / sc.length * 100)}% sentinel`);
    check('7: ...and bedtime prompts that do not start with /bedtime exist (so the rule is the word, not a prefix)',
      sc.some(r => r.mentionsBedtime && !r.startsWithBedtime), `${sc.filter(r => r.mentionsBedtime && !r.startsWithBedtime).length} of ${sc.filter(r => r.mentionsBedtime).length}`);
    const extra = sc.filter(r => r.scheduledForMinusCallSeconds !== null && r.delaySeconds !== null).map(r => r.scheduledForMinusCallSeconds - r.delaySeconds);
    check('7: scheduledFor lies within 90 s of call + delay, either side (the runtime rounds to the minute; the 15 min grace is far longer)',
      extra.length > 0 && Math.max(...extra) <= 90 && Math.min(...extra) >= -90, `${Math.min(...extra)}..${Math.max(...extra)} s over ${extra.length} calls`);
  }
}

if (process.argv.includes('--capture')) {
  capture().then(() => process.exit(0), (e) => { console.log('FAIL  capture crashed  -- ' + (e && e.stack || e)); process.exit(1); });
} else if (process.argv.includes('--mine')) {
  const rows = mine();
  printMine(rows);
  if (process.argv.includes('--write')) {
    // keep the real hook rows, replace the transcript summary
    let keep = [];
    try { keep = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).filter(l => JSON.parse(l).kind === 'hook'); } catch { /* none yet */ }
    const tmp = FIXTURE + '.tmp';
    fs.writeFileSync(tmp, [...keep, ...rows.map(r => JSON.stringify(r))].join('\n') + '\n');
    fs.renameSync(tmp, FIXTURE);
    console.log(`wrote ${rows.length} transcript rows beside ${keep.length} hook rows -> ${FIXTURE}`);
  }
} else {
  replay();
  console.log(failures ? `\nprobe-bedtime-signal: ${failures} FAILED` : '\nprobe-bedtime-signal: every check held');
  process.exit(failures ? 1 : 0);
}
