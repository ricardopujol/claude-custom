'use strict';
/* Which Windows notifications fire, and when?   (re-runnable, offline, free: stubbed hook events only)

   Backlog #78. Ricardo's rule (Inbox 2026-10-08 21:11): "windows notifications should happen only when users input is
   needed or claude finished all its tasks". Decided 2026-10-09: "finished" waits for background shells, ignoring
   shells older than 10 minutes (a dev server or a watcher doesn't hold it back for ever).

   EVERY PLACE A NOTIFICATION CAN BE RAISED (grep Notification in app/ and host/, 2026-10-09):
     host/attention.js, createAttention   the ONLY producer. Emits 'attention' {kind: 'input-needed' | 'finished'}.
     host/host.js, the hookBridge handler wires it (attention.on('attention') -> broadcastControl) to the tab's renderer.
     app/renderer.js, the 'attention' control message: app/attention-surface.js (surfacesFor) decides the surfaces,
                                          then window.harness.attention -> main (preferred) or `new Notification`.
     app/main.js, ipcMain 'attention'     the one `new Notification(...)` that shows an OS toast, plus the taskbar flash.
   So the decision is made in host/attention.js + app/attention-surface.js, both pure. This probe drives the REAL
   modules with stubbed hook payloads and a fake clock (the shapes in test/hooks-real-subagent-failure.fixture.jsonl,
   the comment above `isRunningAgent` in host/attention.js, and the shell entry measured by
   verify/probe-background-shell.js). It does not launch Electron: the OS toast can't be observed, and everything
   that decides whether one is raised is in these two modules.

   Each event row prints what happened, what Ricardo's rule expects, and MATCH / DIFFERS / DIFFERS-OPEN.
   A row named "(+N min)" is time passing with no hook event: it can raise "finished" when a waiting shell turns 10
   minutes old.
   Outcomes besides a raised kind: "ignored by design" (an event that never notifies), "held (subagent or shell
   running)" (a Stop that waits), "duplicate suppressed" (an idle prompt after a finished already went out),
   "still waiting" (time passed and something still holds it back).
   Two columns: window unfocused / focused (the one input surfacesFor has).

   Run:  node verify/probe-notifications.js        (exit 0 always; it prints the table and a summary line)  */
const { createAttention } = require('../host/attention');
const { surfacesFor } = require('../app/attention-surface');

const MIN = 60000;
const T0 = 1_000_000_000;
const RUN = (id, type = 'subagent') => ({ id, type, status: 'running', agent_type: 'general-purpose' });
const SH = (id, extra = {}) => ({ id, type: 'shell', status: 'running', description: 'npm run dev', command: 'npm run dev', ...extra });
// Start times the (stubbed) task-output-file lookup answers with; an id missing here has an unreadable start.
const STARTED = { young: T0 - 2 * MIN, devserver: T0 - 30 * MIN, almost: T0 - 8 * MIN };
const PLUS = n => [`(+${n} min)`, { advance: n * MIN }];

// expect: 'fire' (the rule wants a notification here) or 'none'.
const scenarios = [
  ['A. plain turn end',
    [['Stop', { background_tasks: [] }, 'fire']]],
  ['B. subagent stops mid-work (turn still going)',
    [['SubagentStop', { agent_id: 'r1' }, 'none']]],
  ['C. turn ends while a subagent runs; it stops; the CLI resumes and ends',
    [['Stop', { background_tasks: [RUN('r1')] }, 'none'], ['SubagentStop', { agent_id: 'r1' }, 'none'],
     ['Stop', { background_tasks: [] }, 'fire']]],
  ['D. same, but nothing resumes: the CLI idle prompt',
    [['Stop', { background_tasks: [RUN('r1')] }, 'none'], ['SubagentStop', { agent_id: 'r1' }, 'none'],
     ['Notification', { notification_type: 'idle_prompt' }, 'fire']]],
  ['E. background Bash task starts and ends (tool hooks only)',
    [['PreToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true } }, 'none'],
     ['PostToolUse', { tool_name: 'Bash' }, 'none']]],
  ['F. permission prompt',
    [['Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 'fire']]],
  ['G. question / elicitation',
    [['Notification', { notification_type: 'elicitation_dialog', message: 'Claude has a question' }, 'fire']]],
  ['H1. turn ends while a YOUNG shell (2 min) runs; the shell ends; its notification starts a turn that ends',
    [['Stop', { background_tasks: [SH('young')] }, 'none'], PLUS(3).concat('none'), ['Stop', { background_tasks: [] }, 'fire']]],
  ['H2. turn ends while a dev server that has run 30 min is still up',
    [['Stop', { background_tasks: [SH('devserver')] }, 'fire']]],
  ['H3. turn ends while an 8 min shell runs; nothing else happens; it turns 10 min old',
    [['Stop', { background_tasks: [SH('almost')] }, 'none'], PLUS(1).concat('none'), PLUS(1).concat('fire')]],
  ['H4. a shell whose start can\'t be read: young for 10 min from the Stop, then no longer holds it',
    [['Stop', { background_tasks: [SH('mystery')] }, 'none'], PLUS(9).concat('none'), PLUS(1).concat('fire')]],
  ['H5. the main session works again before the shell ages out (its own Stop decides)',
    [['Stop', { background_tasks: [SH('young')] }, 'none'], ['PreToolUse', { tool_name: 'Read' }, 'none'],
     PLUS(20).concat('none'), ['Stop', { background_tasks: [SH('young')] }, 'fire']]],
  ['I. turn ends while a subagent AND a young shell run; the agent stops; the idle prompt; the shell ages out',
    [['Stop', { background_tasks: [RUN('r1'), SH('almost')] }, 'none'], ['SubagentStop', { agent_id: 'r1' }, 'none'],
     ['Notification', { notification_type: 'idle_prompt' }, 'none'], PLUS(2).concat('fire')]],
  ['J. idle reminder 60 s after a finished turn',
    [['Stop', { background_tasks: [] }, 'fire'], ['Notification', { notification_type: 'idle_prompt' }, 'none']]],
];

function hasRunningWork(p) {
  return Array.isArray(p.background_tasks) &&
    p.background_tasks.some(t => t && (t.type === 'subagent' || t.type === 'shell') && t.status === 'running');
}

function surfaceLabel(e, focused) {
  const s = surfacesFor(e, { focused });
  if (!s.toast) return 'cue only';
  return s.toast.silent ? 'quiet toast' : 'urgent toast+flash';
}

function run(events) {
  let now = T0;
  const timers = [];
  const a = createAttention({
    now: () => now, project: 'proj',
    shellStartedAt: (task) => (task.id in STARTED ? STARTED[task.id] : null),
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
  });
  let current = [];
  let finishedSeen = false;
  a.on('attention', e => current.push(e));
  return events.map(([event, payload, expect]) => {
    current = [];
    let outcomeIfQuiet = 'ignored by design';
    if (payload && payload.advance) {
      const to = now + payload.advance;
      for (;;) {
        const due = timers.filter(t => t.live && t.at <= to).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        now = due.at; due.live = false; due.fn();
      }
      now = to;
      outcomeIfQuiet = 'still waiting';
    } else {
      a.handle({ event, payload });
      if (event === 'Stop' && hasRunningWork(payload)) outcomeIfQuiet = 'held (subagent or shell running)';
      else if (event === 'Notification' && payload.notification_type === 'idle_prompt' && finishedSeen) outcomeIfQuiet = 'duplicate suppressed';
      else if (event === 'Notification' && payload.notification_type === 'idle_prompt') outcomeIfQuiet = 'still waiting';
    }
    const e = current[0];
    if (e && e.kind === 'finished') finishedSeen = true;
    const fired = !!e;
    return {
      event, expect, outcome: e ? e.kind : outcomeIfQuiet,
      verdict: fired === (expect === 'fire') ? 'MATCH' : 'DIFFERS',
      unfocused: e ? surfaceLabel(e, false) : '-',
      focused: e ? surfaceLabel(e, true) : '-',
    };
  });
}

const tally = { MATCH: 0, DIFFERS: 0 };
for (const [name, events] of scenarios) {
  console.log(name);
  for (const r of run(events)) {
    tally[r.verdict]++;
    console.log(`    ${r.event.padEnd(14)} -> ${r.outcome.padEnd(33)} unfocused: ${r.unfocused.padEnd(19)} focused: ${r.focused.padEnd(9)} ` +
      `rule: ${r.expect.padEnd(4)} ${r.verdict}`);
  }
}
console.log(`\nSummary: ${tally.MATCH} MATCH, ${tally.DIFFERS} DIFFERS`);
