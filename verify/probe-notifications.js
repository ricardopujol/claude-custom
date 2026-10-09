'use strict';
/* Which Windows notifications fire, and when?   (re-runnable, offline, free: stubbed hook events only)

   Backlog #78. Ricardo's rule (Inbox 2026-10-08 21:11): "windows notifications should happen only when users input is
   needed or claude finished all its tasks".

   EVERY PLACE A NOTIFICATION CAN BE RAISED (grep Notification in app/ and host/, 2026-10-09):
     host/attention.js          the ONLY producer. Emits 'attention' {kind: 'input-needed' | 'finished'}.
     host/host.js:536-540       wires it to the control channel -> the tab's renderer.
     app/renderer.js            on 'attention': app/attention-surface.js decides the surfaces, then
                                window.harness.attention -> main (preferred) or `new Notification` (fallback).
     app/main.js 'attention'    the one `new Notification(...)` that shows an OS toast, plus the taskbar flash.
   So the decision is made in host/attention.js + app/attention-surface.js, both pure. This probe drives the REAL
   modules with stubbed hook payloads. It does not launch Electron: the OS toast itself can't be observed, and
   everything that decides whether one is raised is in these two modules.

   Run:  node verify/probe-notifications.js        (exit 0 always; it prints the table)  */
const { createAttention } = require('../host/attention');
const { surfacesFor } = require('../app/attention-surface');

const RUN = (id, type = 'subagent') => ({ id, type, status: 'running', agent_type: 'general-purpose' });
const SH = { id: 'sh1', type: 'shell', status: 'running', description: 'npm run dev' };

// Each scenario is a list of hook events; the table says what each EVENT raised.
const scenarios = [
  ['A. plain turn end',
    [['Stop', { background_tasks: [] }]]],
  ['B. subagent stops mid-work (turn still going)',
    [['SubagentStop', { agent_id: 'r1' }]]],
  ['C. turn ends while a subagent runs; it stops; the CLI resumes and ends',
    [['Stop', { background_tasks: [RUN('r1')] }], ['SubagentStop', { agent_id: 'r1' }], ['Stop', { background_tasks: [] }]]],
  ['D. same, but nothing resumes: the CLI idle prompt',
    [['Stop', { background_tasks: [RUN('r1')] }], ['SubagentStop', { agent_id: 'r1' }],
     ['Notification', { notification_type: 'idle_prompt' }]]],
  ['E. background Bash task ends (tool hooks only)',
    [['PreToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true } }], ['PostToolUse', { tool_name: 'Bash' }]]],
  ['F. permission prompt',
    [['Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }]]],
  ['G. question / elicitation',
    [['Notification', { notification_type: 'elicitation_dialog', message: 'Claude has a question' }]]],
  ['H. turn ends while a background SHELL still runs (a dev server)',
    [['Stop', { background_tasks: [SH] }]]],
  ['I. turn ends while a subagent AND a shell run',
    [['Stop', { background_tasks: [RUN('r1'), SH] }]]],
  ['J. idle reminder 60 s after a finished turn',
    [['Stop', { background_tasks: [] }], ['Notification', { notification_type: 'idle_prompt' }]]],
];

function run(events, focused = false) {
  let now = 1_000_000;
  const out = [];
  const a = createAttention({ now: () => now, project: 'proj' });
  let current = null;
  a.on('attention', e => current.push(e));
  for (const [event, payload] of events) {
    current = [];
    a.handle({ event, payload });
    now += 10_000;
    const e = current[0];
    const s = e ? surfacesFor(e, { focused }) : null;
    out.push({ event, kind: e ? e.kind : '-', toast: s && s.toast ? (s.toast.silent ? 'quiet toast' : 'urgent toast + flash') : (e ? 'cue only (focused)' : '-') });
  }
  return out;
}

for (const [name, events] of scenarios) {
  console.log(name);
  for (const r of run(events)) console.log(`    ${r.event.padEnd(16)} -> ${r.kind.padEnd(13)} ${r.toast}`);
}
console.log('\nSame scenario A with the window focused:', JSON.stringify(run(scenarios[0][1], true)));
