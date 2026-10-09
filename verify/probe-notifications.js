'use strict';
/* Which Windows notifications fire, and when?   (re-runnable, offline, free: stubbed hook events only)

   Backlog #78. Ricardo's rule (Inbox 2026-10-08 21:11): "windows notifications should happen only when users input is
   needed or claude finished all its tasks".

   EVERY PLACE A NOTIFICATION CAN BE RAISED (grep Notification in app/ and host/, 2026-10-09):
     host/attention.js, createAttention   the ONLY producer. Emits 'attention' {kind: 'input-needed' | 'finished'}.
     host/host.js, the hookBridge handler wires it (attention.on('attention') -> broadcastControl) to the tab's renderer.
     app/renderer.js, the 'attention' control message: app/attention-surface.js (surfacesFor) decides the surfaces,
                                          then window.harness.attention -> main (preferred) or `new Notification`.
     app/main.js, ipcMain 'attention'     the one `new Notification(...)` that shows an OS toast, plus the taskbar flash.
   So the decision is made in host/attention.js + app/attention-surface.js, both pure. This probe drives the REAL
   modules with stubbed hook payloads (the shapes in test/hooks-real-subagent-failure.fixture.jsonl and the comment above
   `isRunningAgent` in host/attention.js; the shell entry is NOT a real capture, see scenario H). It does not launch
   Electron: the OS toast can't be observed, and everything that decides whether one is raised is in these two modules.

   Each event row prints what happened, what Ricardo's rule expects, and MATCH / DIFFERS / DIFFERS-OPEN.
   Outcomes besides a raised kind: "ignored by design" (an event that never notifies), "held (subagent running)"
   (a Stop that waits for the agents), "duplicate suppressed" (an idle prompt after a finished already went out).
   Two columns: window unfocused / focused (the one input surfacesFor has).

   Run:  node verify/probe-notifications.js        (exit 0 always; it prints the table and a summary line)  */
const { createAttention } = require('../host/attention');
const { surfacesFor } = require('../app/attention-surface');

const RUN = (id, type = 'subagent') => ({ id, type, status: 'running', agent_type: 'general-purpose' });
const SH = { id: 'sh1', type: 'shell', status: 'running', description: 'npm run dev' };

// expect: 'fire' (the rule wants a notification here) or 'none'. open: a design question decides it (BACKLOG #78).
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
  ['E. background Bash task ends (tool hooks only)',
    [['PreToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true } }, 'none'],
     ['PostToolUse', { tool_name: 'Bash' }, 'none']]],
  ['F. permission prompt',
    [['Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 'fire']]],
  ['G. question / elicitation',
    [['Notification', { notification_type: 'elicitation_dialog', message: 'Claude has a question' }, 'fire']]],
  ['H. turn ends while a background SHELL still runs (a dev server)',
    [['Stop', { background_tasks: [SH] }, 'none', 'open']]],
  ['I. turn ends while a subagent AND a shell run',
    [['Stop', { background_tasks: [RUN('r1'), SH] }, 'none']]],
  ['J. idle reminder 60 s after a finished turn',
    [['Stop', { background_tasks: [] }, 'fire'], ['Notification', { notification_type: 'idle_prompt' }, 'none']]],
];

const hasRunningAgent = p => Array.isArray(p.background_tasks) && p.background_tasks.some(t => t && t.type === 'subagent');

function surfaceLabel(e, focused) {
  const s = surfacesFor(e, { focused });
  if (!s.toast) return 'cue only';
  return s.toast.silent ? 'quiet toast' : 'urgent toast+flash';
}

function run(events) {
  let now = 1_000_000;
  const a = createAttention({ now: () => now, project: 'proj' });
  let current = [];
  let finishedSeen = false;
  a.on('attention', e => current.push(e));
  return events.map(([event, payload, expect, open]) => {
    current = [];
    a.handle({ event, payload });
    now += 10_000;
    const e = current[0];
    let outcome;
    if (e) { outcome = e.kind; if (e.kind === 'finished') finishedSeen = true; }
    else if (event === 'Stop' && hasRunningAgent(payload)) outcome = 'held (subagent running)';
    else if (event === 'Notification' && payload.notification_type === 'idle_prompt' && finishedSeen) outcome = 'duplicate suppressed';
    else outcome = 'ignored by design';
    const fired = !!e;
    const verdict = fired === (expect === 'fire') ? 'MATCH' : open ? 'DIFFERS-OPEN' : 'DIFFERS';
    return {
      event, outcome, expect, verdict, open,
      unfocused: e ? surfaceLabel(e, false) : '-',
      focused: e ? surfaceLabel(e, true) : '-',
    };
  });
}

const tally = { MATCH: 0, DIFFERS: 0, 'DIFFERS-OPEN': 0 };
for (const [name, events] of scenarios) {
  console.log(name);
  for (const r of run(events)) {
    tally[r.verdict]++;
    console.log(`    ${r.event.padEnd(14)} -> ${r.outcome.padEnd(24)} unfocused: ${r.unfocused.padEnd(19)} focused: ${r.focused.padEnd(9)} ` +
      `rule: ${r.expect.padEnd(4)} ${r.verdict}${r.open ? ' (BACKLOG #78 open question: should finished wait for a background shell?)' : ''}`);
  }
}
console.log(`\nSummary: ${tally.MATCH} MATCH, ${tally.DIFFERS} DIFFERS, ${tally['DIFFERS-OPEN']} DIFFERS-OPEN (design question pending)`);
