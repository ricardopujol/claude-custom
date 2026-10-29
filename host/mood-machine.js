'use strict';
/**
 * Mechanical, deterministic mood state machine.
 *
 * No model calls: free, instant, and explainable — which is what matters when a
 * face is wrong and you need to know why. Every transition below is traceable
 * to one hook event or one elapsed timeout.
 *
 *   PreToolUse(Agent|Task)  -> working   (opens an invocation, parent-linked)
 *   SendMessage resumed it  -> working   (reopens that ended run, background)
 *   a queued message woke it-> working   (its first event after its end)
 *   PostToolUse ok          -> working
 *   PostToolUse error       -> stressed (err++)
 *   PostToolUseFailure      -> stressed (err++)  -- a failed call's ONLY event
 *   same tool x3 running    -> stressed
 *   SubagentStop, err == 0  -> happy    (flash) -> sleeping
 *   SubagentStop, err > 0   -> stressed (flash) -> sleeping
 *   interrupt (Esc)         -> that run + foreground descendants end; never err++
 *   Stop                    -> the main session's foreground runs finish
 *   SessionEnd              -> every run ends, background included
 *   stall / invocation cap  -> that run ends (never while a foreground child runs)
 *   idle > idleMs           -> sleeping  (only if NOT still running -- FF2)
 *
 * A card is working while any invocation of its name is open; a parent stays
 * open while a foreground child it waits on runs. Background runs are their
 * own roots.
 *
 * DETAIL (BACKLOG #55). `state` is the four above and never changes meaning:
 * the roster's sort, hide rule, ring and portrait files all key on it. On top
 * of it each card has a `detail`, the finer name it shows, which equals `state`
 * unless the card is working (or stressed) AND one of these holds. Best first:
 *
 *   waiting   a PermissionRequest hook (a permission prompt or question is about
 *             to be shown) that names the agent by agent_id. A Notification
 *             can't say whose it is (the CLI never puts agent_id on one), so
 *             none marks a card; a PermissionRequest without agent_id is the
 *             main session's own. Ends with the agent's next hooked event or
 *             its end, and is never judged by silence or reaped while it waits.
 *   stuck     the retry detector (same call x3) or twenty silent minutes with
 *             nothing in flight and no background work launched
 *   helper    a FOREGROUND child it launched is still running (a background
 *             child leaves its parent free, so it isn't waiting)
 *   bgwait    (BACKLOG #155) it launched BACKGROUND work (a backgrounded Bash or
 *             child: `quiet`), has nothing else in flight and has been silent
 *             for WAIT_GRACE_MS: it waits on a task that emits no hook of its
 *             own. `bgwaitlate` from WAIT_RED_MS (30 min) of it. Never asleep or
 *             reaped meanwhile: its own silence limit is QUIET_STALL_MS.
 *   running   a Bash call in flight, PreToolUse .. PostToolUse
 *   writing   Edit | Write | NotebookEdit    (working only; an error shows stressed)
 *   reading   Read | Grep | Glob
 *
 * `waiting` has a second source (BACKLOG #119 A2): the claude-custom mod's agent snapshot, see observeAgents().
 *
 * Reading and writing come from PreToolUse alone (their PostToolUse isn't
 * hooked: host/settings-writer.js), so they last TOOL_LINGER_MS. A run's calls
 * are sequential: its newest call (a Pre, or a Post of a call whose only hook
 * is its Post) ends every older one, so the newest of {a Bash in flight, the
 * last file tool} is the only one that can show.
 *
 * Time is injected and transitions are applied by `tick()`, so the host owns
 * scheduling and the machine stays testable without wall-clock waits.
 */

const { EventEmitter } = require('events');

const SLEEPING = 'sleeping';
const WORKING = 'working';
const HAPPY = 'happy';
const STRESSED = 'stressed';

// The finer names. Each is also a portrait slot (host/portraits.js NEAREST_STATE).
const READING = 'reading';
const WRITING = 'writing';
const RUNNING = 'running';
const WAITING = 'waiting';
const STUCK = 'stuck';
const HELPER = 'helper';
const BGWAIT = 'bgwait';
const BGWAIT_LATE = 'bgwaitlate';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const RETRY_LIMIT = 3;
// How long a reading/writing detail outlives the PreToolUse that raised it.
const TOOL_LINGER_MS = 5_000;
// Silence, with nothing in flight, that reads as stuck rather than thinking.
// Hooks see no WebSearch, WebFetch, MCP or TaskOutput, so a long call of those
// is silent too (PR #154, Dexter 4): the bar is high (two thirds of STALL_MS,
// which reaps), and an agent that launched background work is never judged
// by silence at all.
const STUCK_MS = 20 * 60_000;
// A run with background work launched shows "waiting..." after this much silence (a thinking agent is silent a moment too), red
// after WAIT_RED_MS (Ricardo, 2026-10-29: "after 30 minutes"). What it waits on emits no hook, so its silence limit is longer
// than a run's STALL_MS: the stall clock would have reaped it at the very minute it turned red.
const WAIT_GRACE_MS = 30_000;
const WAIT_RED_MS = 30 * 60_000;
const QUIET_STALL_MS = 2 * 60 * 60_000;
const WAIT_ON_MAX = 60;
// What an agent waits on, for the card: one line, capped. Null when there's nothing to say.
function waitText(...candidates) {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const line = c.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ');
    if (line) return line.length > WAIT_ON_MAX ? line.slice(0, WAIT_ON_MAX - 1) + '…' : line;
  }
  return null;
}

// Claude Code's hook payloads are not strongly shaped, so failure detection is
// deliberately permissive: treating a stringy "1" as success would make the
// mood engine quietly wrong rather than loudly broken.
//
// `interrupted: true` is NOT here any more: an interrupt is decided before this
// is asked, and is never a failure (backlog #7).
function isFailure(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.success === false) return true;
  const code = response.exit_code ?? response.exitCode ?? response.code;
  if (code === undefined || code === null) return false;
  return Number(code) !== 0;
}

// How long a RUNNING agent may be silent before we conclude it died rather
// than that it is thinking. FF2.
//
// Two thresholds, because there are two different questions. `idleMs` asks
// "has this agent been quiet long enough to look idle?" -- fine for an agent
// with no live invocation. A running agent needs the other question: "has it
// been quiet so long that SubagentStop can only have been lost?" Ninety
// seconds answers the first and badly misanswers the second; agents routinely
// think for minutes without emitting a hook.
//
// It is still a guess, because hooks are the only liveness signal there is.
// Set where it is: long enough that no real turn reaches it, short enough that
// a crashed subagent does not read as working for the rest of the session.
const STALL_MS = 30 * 60_000;

// The idle clock and the happy/stressed flash. Exported so the Ask explainer (host/ask-explainer.js, BACKLOG #33) keeps the
// same timings as an agent's card rather than restating them.
const IDLE_MS = 90_000;
const FLASH_MS = 8_000;

// The longest ONE INVOCATION may live before it is presumed stranded.
//
// Dexter, PR #33, Finding 7. `lastActivity` is refreshable -- it has to be, or
// a thinking agent reads as asleep (FF2), and F5 widened that refresh to the
// whole delegation chain because a parent whose child is working is waiting,
// not stalled. But once every stack member is refreshed by any session
// activity, a silence clock can only fire when the WHOLE SESSION goes quiet,
// so a stranded entry -- one whose SubagentStop was dropped, which
// host/usage.js records happening 31 times in 35 events -- never reaps at all.
//
// One refreshable clock cannot answer two questions. `lastActivity` answers
// "is it thinking". `startedAt` answers "how long has this invocation
// existed", and NOTHING refreshes it.
const MAX_INVOCATION_MS = 45 * 60_000;

// The tool that launches a subagent. Claude Code calls it "Agent"; older
// versions called it "Task". Verified against the real CLI, which sends
// tool_name:"Agent" with subagent_type in tool_input -- this repo had assumed
// "Task" everywhere, so the roster stayed empty in every real session while
// every test passed on hand-written "Task" fixtures.
const AGENT_TOOLS = new Set(['Agent', 'Task']);

// A spawn's own result says how it was launched. Measured on real sessions:
// background -> { isAsync: true, status: "async_launched", agentId }, at once;
// foreground -> { status: "completed", agentId, ... }, when the agent is done.
const isAsyncLaunch = r => !!r && typeof r === 'object' && (r.isAsync === true || r.status === 'async_launched');
const isCompleted = r => !!r && typeof r === 'object' && r.status === 'completed';
// The id a spawn's result names: `agentId` for the async/foreground results,
// `agent_id` for a teammate's.
const resultAgentId = r => {
  if (!r || typeof r !== 'object') return null;
  for (const v of [r.agentId, r.agent_id]) if (typeof v === 'string' && v) return v;
  return null;
};

// A TEAMMATE HAS TWO IDENTITIES, and the spawn result only names one.
// Measured on a real session (2026-10-03, transcript 525f765a-*):
//   spawn result  agent_id "mortimer-release@session-2e134ac8"   (an ADDRESS:
//                 name@team, reusable, never seen on a hook event so far)
//   its runtime   agentId  "amortimer-release-5a5bc27d7582b9b2"  ("a" + name +
//                 "-" + 16 hex: the transcript file name and, for every
//                 ordinary subagent measured, the hook's agent_id)
// What the hook agent_type of a teammate's own calls is -- its name, or the
// type it was spawned as -- is NOT measured, so every one is accepted. A
// teammate's record keeps both identities (an "alias") and is found by any.
const isTeammateResult = r => !!r && typeof r === 'object'
  && (r.status === 'teammate_spawned' || (typeof r.agent_id === 'string' && r.agent_id.includes('@')));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mateMatches(mate, agentId, agentType) {
  if (agentId === mate.address || agentId === mate.runtimeId) return true;
  if (typeof agentId === 'string' && new RegExp(`^a${escapeRe(mate.name)}-[0-9a-f]{8,}$`).test(agentId)) return true;
  return typeof agentType === 'string' && (agentType === mate.name || agentType === mate.address);
}

// How many ended identities are remembered. A late echo arrives within
// seconds; this is hundreds of spawns of headroom, not a history.
const REMEMBER_MAX = 1024;
function remember(set, value) {
  set.delete(value);
  set.add(value);
  if (set.size > REMEMBER_MAX) set.delete(set.values().next().value);
}

function createMoodMachine({ now = Date.now, idleMs = IDLE_MS, stallMs = STALL_MS,
                            maxInvocationMs = MAX_INVOCATION_MS, flashMs = FLASH_MS,
                            toolLingerMs = TOOL_LINGER_MS, stuckMs = STUCK_MS, waitGraceMs = WAIT_GRACE_MS,
                            waitRedMs = WAIT_RED_MS, quietStallMs = QUIET_STALL_MS } = {}) {
  const machine = new EventEmitter();

  // CARDS, keyed by agent NAME: the face the roster shows.
  // name -> { state, errors, lastActivity, flashUntil, lastSignature, repeats }
  //
  // Errors stay name-scoped on purpose (see test/mood-machine.test.js, "a
  // failure is not cleared by a sibling finishing cleanly"): a name that
  // recorded a failure shows it until every instance of it has finished.
  const agents = new Map();

  // INVOCATIONS: every subagent run that has started and not ended, in start
  // order. Backlog #7. The old structure was a name-keyed stack whose nesting
  // was IMPLIED by order, which cannot say whose child an agent is, and so
  // could neither end a chain nor keep a parent alive on its own child's
  // account without keeping every other agent alive too.
  //
  //   { id, key, name, agentId, parent, background, description,
  //     startedAt, lastActivity }
  //
  // key      the spawn's tool_use_id (null on older payloads without one).
  // agentId  the subagent's own agent_id, once known. NOTHING in the spawn
  //          names it: PreToolUse(Agent) carries tool_use_id, the subagent's
  //          calls carry agent_id, and only the spawn's RESULT
  //          (tool_response.agentId) joins the two -- at once for a
  //          background launch, at the end for a foreground one. Until then
  //          the first sighting of an unknown agent_id binds it to the oldest
  //          unbound invocation of the same type (see bind()).
  // parent   the spawner's invocation, or null for the main session (a spawn
  //          with no agent_id is the main session's, as every call is).
  // background  a background run is its own root: it outlives its spawner's
  //          turn (Stop fires while it runs -- measured), does not keep its
  //          spawner's card working, and is not ended with its spawner.
  const invs = [];
  // key -> OPEN invocation. An entry leaves when its run ends and a bounded
  // tombstone stays in `endedKeys`, so a repeated or late event for that
  // tool_use_id is recognised without keeping every run the host has ever
  // seen (Dexter #8 / Miguel M1, PR #56: it used to grow forever).
  const spawns = new Map();
  const endedKeys = new Set();
  let serial = 0;
  // Has this CLI ever said whose call is whose? The current CLI puts agent_id
  // on every subagent call and on nothing of the main session's, so once one
  // has arrived, a call WITHOUT one is the main session's own (Dexter, PR #56,
  // #3). Before that, it may be an older CLI that labels nobody.
  let saysWho = false;
  // agent_id -> NAME of each run that has ENDED here. "Ended" and "never
  // seen" are different facts: without this, a duplicate or late event from
  // an ended run took the next unbound sibling of its type and ended THAT
  // (Dexter, PR #56, #4). The name is the card a RESUME reopens it under.
  // Bounded, oldest out: ids are unique per session, so only a late echo or
  // a resume needs remembering, not the whole history. One map, not a set
  // and a map beside it: a resume took an id out of one and not the other,
  // and their eviction points drifted apart (Dexter, PR #69, F7).
  const endedIds = new Map();
  function rememberEnded(inv) {
    endedIds.delete(inv.agentId);
    endedIds.set(inv.agentId, inv.name);
    if (endedIds.size > REMEMBER_MAX) endedIds.delete(endedIds.keys().next().value);
  }
  // agent_ids of runs holding a message they haven't drained yet (see
  // message()). Bounded like the rest.
  const queued = new Set();
  // TEAMMATES, by name: { name, card, address, runtimeId, ended, reaped, wake }.
  // A teammate outlives one run: it goes idle and is woken by SendMessage, so
  // its identity is remembered after its record closes. Bounded, oldest out.
  const mates = new Map();
  // agent_ids of BACKGROUND runs the stall clock reaped: silence is not death
  // (one long tool call is silent), so such a run's next event brings it back.
  const reapedIds = new Set();
  function rememberMate(mate) {
    mates.delete(mate.name);
    mates.set(mate.name, mate);
    if (mates.size > REMEMBER_MAX) mates.delete(mates.keys().next().value);
  }

  // What an invocation tracks for its detail: Bash calls in flight (id -> when
  // they began), the newest file tool ({kind, at}), and an open prompt.
  // `quiet`: it launched background work, so what it waits on emits no hook of its own.
  const idleTools = () => ({ bash: new Map(), tool: null, waiting: false, modWaiting: false, modWaitingAt: 0, clearedAt: -Infinity, quiet: false, waitOn: null });
  // It launched background work: what it then waits on emits no hook of its own. `what` is the one-line thing it waits on.
  function holdFor(inv, what) { inv.quiet = true; inv.waitOn = what; }

  const isOpen = inv => invs.includes(inv);
  const running = name => invs.some(i => i.name === name);
  const current = () => (invs.length ? invs[invs.length - 1] : null);

  function ensure(agent) {
    let a = agents.get(agent);
    if (!a) {
      a = { state: SLEEPING, detail: SLEEPING, errors: 0, lastActivity: now(), flashUntil: 0, lastSignature: null, repeats: 0 };
      agents.set(agent, a);
    }
    return a;
  }

  // The card's finer name for `state` (see DETAIL, in the header): the best of
  // what its invocations show, or `state` itself.
  const RANK = { [WAITING]: 6, [STUCK]: 5, [HELPER]: 4, [RUNNING]: 3, [WRITING]: 3, [READING]: 3, [BGWAIT_LATE]: 2.5, [BGWAIT]: 2 };
  // The wait on its own background work: nothing in flight, no foreground child, silent long enough.
  const bgWaiting = (inv, t) => inv.quiet && inv.bash.size === 0 && fgChildren(inv).length === 0 && t - inv.lastActivity >= waitGraceMs;
  function refine(agent, a, state) {
    if (state !== WORKING && state !== STRESSED) return state;
    const t = now();
    const repeating = a.repeats >= RETRY_LIMIT;
    let best = state;
    const take = d => { if ((RANK[d] || 0) > (RANK[best] || 0)) best = d; };
    for (const inv of invs) {
      if (inv.name !== agent) continue;
      if (inv.waiting || inv.modWaiting) { take(WAITING); continue; }
      const kids = fgChildren(inv).length > 0;
      // A Bash in flight for longer than the stall clock isn't: its result was lost (PR #154, Dexter 2).
      const flying = [...inv.bash.values()].filter(at => t - at <= stallMs);
      if (repeating || (!kids && !inv.quiet && flying.length === 0 && t - inv.lastActivity > stuckMs)) { take(STUCK); continue; }
      if (kids) { take(HELPER); continue; }
      if (inv.quiet && flying.length === 0 && bgWaiting(inv, t)) take(t - inv.lastActivity >= waitRedMs ? BGWAIT_LATE : BGWAIT);
      if (state !== WORKING) continue;       // an error outranks what the tool is
      let newest = null;
      for (const at of flying) if (!newest || at >= newest.at) newest = { kind: RUNNING, at };
      if (inv.tool && t - inv.tool.at <= toolLingerMs && (!newest || inv.tool.at > newest.at)) newest = inv.tool;
      if (newest) take(newest.kind);
    }
    return best;
  }

  function setState(agent, a, state) {
    const detail = refine(agent, a, state);
    if (a.state === state && a.detail === detail) return;
    a.state = state;
    a.detail = detail;
    machine.emit('change', { agent, state, detail });
  }

  // Re-asks every card for its detail: time passing (a linger ending, a silence
  // growing) and a tool event both move it without moving `state`.
  function settle() {
    for (const [agent, a] of agents) setState(agent, a, a.state);
  }

  // agent_id -> its invocation. An id seen for the first time is bound to the
  // OLDEST open invocation of its type that has no id yet: agents of one type
  // start in the order they were spawned. When two same-type siblings are
  // bound crosswise the CARD is unaffected -- both are the same name -- and
  // the spawn's result, which names its agentId, corrects it (see adopt()).
  function bind(agentId, agentType) {
    if (!agentId) return null;
    const known = invs.find(i => i.agentId === agentId);
    if (known) return known;
    // A teammate's first sighting under its RUNTIME id: found by any of its
    // identities, then bound to the id its events really carry.
    const mate = invs.find(i => i.mate && !i.agentId && mateMatches(i.mate, agentId, agentType));
    if (mate) { mate.agentId = agentId; mate.mate.runtimeId = agentId; return mate; }
    if (endedIds.has(agentId)) return null;                // over: not a new run
    // A teammate record is NOT up for first-come binding: it binds only through
    // its own identities (above), or a plain same-type agent that speaks first
    // takes it and its stop finishes the teammate (Dexter, PR #94, R2-1).
    const free = agentType ? invs.find(i => !i.agentId && !i.mate && i.name === agentType) : undefined;
    if (!free) return null;          // never started here: not ours to credit
    free.agentId = agentId;
    return free;
  }

  // The spawn's result names the id for certain; a guess that went the other
  // way is swapped when BOTH runs are still open. Returns whether the result
  // really is about `inv`'s run -- false when it can't be:
  //   - the id it names has already ended: a crosswise binding already
  //     closed that run under the other record, so `inv` holds someone
  //     else's live run;
  //   - `inv` is bound to a DIFFERENT live id and nobody holds the named one
  //     to swap with.
  // Acting on it then ended a live run (Dexter, PR #56, #1): the result is
  // ignored instead, and that run ends on its own SubagentStop.
  //
  // A swap moves each record's CHILDREN along with its id. A child attached
  // through its spawner's agent_id, so it belongs to that RUN, not to the
  // record the run was guessed onto. Moving the id alone left A's child on
  // the record that then finished as B, cutting a live child off (Dexter,
  // PR #56, R1).
  //
  // Nobody holding the named id is not proof `inv`'s id is right, either. If
  // the named run never spoke, the id `inv` holds was a first-come guess that
  // belongs to an UNBOUND sibling of its type, and that sibling takes it. With
  // no such sibling there's nothing to swap with, and the result is refused.
  // (Found by the property generator once it could drop a SubagentStop: the
  // result was refused, and the finished run showed working until the stall.)
  function adopt(inv, agentId) {
    if (inv.agentId === agentId) return true;
    if (endedIds.has(agentId)) return false;
    let other = invs.find(i => i.agentId === agentId);
    if (!other && inv.agentId) {
      other = invs.find(i => i !== inv && !i.agentId && i.name === inv.name);
      if (!other) return false;
    }
    if (other) {
      for (const c of invs) {
        if (c.parent === inv) c.parent = other;
        else if (c.parent === other) c.parent = inv;
      }
      other.agentId = inv.agentId;
    }
    inv.agentId = agentId;
    return true;
  }

  const fgChildren = inv => invs.filter(c => c.parent === inv && !c.background);

  // `inv` and every FOREGROUND descendant: what ends when it ends. A
  // background descendant is its own root and carries on.
  function subtree(inv) {
    const out = [inv];
    for (let k = 0; k < out.length; k++) out.push(...fgChildren(out[k]));
    return out;
  }

  // Foreground all the way up to the main session: the work a turn owns. An
  // ORPHAN root -- spawned by an agent we can't place -- is not the main
  // session's either (Dexter, PR #56, #5).
  function mainForeground(inv) {
    for (let i = inv; i; i = i.parent) if (i.background || i.orphan) return false;
    return true;
  }

  // THE WHOLE CHAIN IS ALIVE, not just its innermost link (Dexter, PR #33,
  // F5): a parent whose child is working is waiting, not stalled. Walked up
  // the PARENT LINK now, and stopped at a background edge, because background
  // work does not keep its spawner's card working.
  function refresh(inv) {
    const t = now();
    for (let i = inv; i && isOpen(i); i = i.parent) {
      i.lastActivity = t;
      const card = agents.get(i.name);
      if (card) card.lastActivity = t;
      if (i.background) break;
    }
  }

  // A payload with no agent_id at all comes from an older CLI that does not
  // say whose call it is, so it keeps the old rule: the whole set is alive.
  function refreshAll() {
    for (const i of invs) refresh(i);
  }

  // Ends `list`. `completed` says whether the run FINISHED (SubagentStop, a
  // completed result, the turn ending) or was CUT OFF (Esc, /clear, a reap).
  // A finished card flashes happy/stressed; a cut-off one just sleeps, because
  // celebrating a run that did not finish is the display lying.
  //
  // ONE INSTANCE ENDING IS NOT THE AGENT ENDING: the card is derived from
  // whether any invocation of the name remains (F3), in this one place.
  function end(list, completed, reaped = false) {
    const names = new Map();         // name -> finished (any of its ended runs)
    for (const inv of list) {
      const at = invs.indexOf(inv);
      if (at === -1) continue;
      invs.splice(at, 1);
      if (inv.agentId) rememberEnded(inv);
      if (inv.mate) { inv.mate.ended = true; inv.mate.reaped = reaped; inv.mate.wake = false; }
      else if (reaped && inv.background && inv.agentId) remember(reapedIds, inv.agentId);
      if (inv.key !== null) { spawns.delete(inv.key); remember(endedKeys, inv.key); }
      names.set(inv.name, names.get(inv.name) || completed(inv));
    }
    for (const [name, finished] of names) {
      const a = ensure(name);
      a.lastActivity = now();
      if (running(name)) {
        setState(name, a, a.errors > 0 ? STRESSED : WORKING);
      } else if (finished) {
        a.flashUntil = now() + flashMs;
        setState(name, a, a.errors > 0 ? STRESSED : HAPPY);
      } else {
        a.flashUntil = 0;
        setState(name, a, SLEEPING);
      }
    }
  }

  // The invocation that ran to its end, finished; its foreground descendants,
  // which it could not have finished without, were cut off.
  const finish = inv => end(subtree(inv), i => i === inv);
  const cutOff = list => end(list, () => false);
  const reap = list => end(list, () => false, true);

  // A completed result for a spawn whose RECORD already closed. Usually an
  // echo of a run that's over (its id is in endedIds), and ignored. But a
  // crosswise binding can close the record under the OTHER run's
  // SubagentStop, and the run the result names then lives on another record,
  // bound to it when it spoke late. The result names that id for certain, so
  // its holder finishes. Without this, a run whose own SubagentStop was
  // dropped stayed working until the stall reaper (property generator, once
  // it could drop a SubagentStop). A run that never spoke is held by nobody,
  // and is left to the reapers: any unbound record of its type could be a
  // different live run.
  function lateResult(event, p) {
    const r = p.tool_response;
    if (event !== 'PostToolUse' || !isCompleted(r) || !resultAgentId(r)) return;
    const holder = invs.find(i => i.agentId === resultAgentId(r));
    if (holder) finish(holder);
  }

  // The spawn's own result: PostToolUse / PostToolUseFailure of the Agent
  // tool, matched by tool_use_id. It is the SPAWNER's call, never the child's.
  function spawnResult(inv, event, p, interrupted) {
    if (!inv || !isOpen(inv)) { lateResult(event, p); return; }
    if (interrupted) { cutOff(subtree(inv)); return; }
    if (event === 'PostToolUseFailure') {
      ensure(inv.name).errors++;
      finish(inv);
      return;
    }
    const r = p.tool_response;
    // A TEAMMATE: the id its result names is an address, not the id its own
    // events carry, so it is recorded as an alias and never adopted -- adopting
    // it left every event of the run unattributed, and a reused name (an
    // address, not a run id) was refused as "already ended" (Dexter, PR #94,
    // F1/F3). It is background whatever else is true of the result.
    if (isTeammateResult(r)) {
      const address = resultAgentId(r);
      const name = (typeof r.name === 'string' && r.name) || (p.tool_input && p.tool_input.name)
        || (address && address.split('@')[0]);
      if (name) {
        const mate = mates.get(name) || { name };
        Object.assign(mate, { card: inv.name, address: address || mate.address || null,
          runtimeId: null, ended: false, reaped: false, wake: false });
        rememberMate(mate);
        inv.mate = mate;
      }
      inv.background = true;
      if (inv.parent) holdFor(inv.parent, waitText(inv.description, inv.name));
      return;
    }
    const named = typeof r?.agentId === 'string' && r.agentId ? r.agentId : null;
    if (named) {
      saysWho = true;
      if (!adopt(inv, named)) return;
    }
    if (isCompleted(r)) { finish(inv); return; }
    if (isAsyncLaunch(r)) { inv.background = true; if (inv.parent) holdFor(inv.parent, waitText(inv.description, inv.name)); return; }
    // A status we don't know that still names a run: assume it is RUNNING.
    // `completed` is the only status that means done; guessing the other way
    // was the original bug (Miguel, PR #94, #1). Logged, so a renamed status
    // is visible rather than silently wrong.
    if (r && typeof r === 'object' && resultAgentId(r)) {
      console.log(`[mood] unrecognised spawn status ${JSON.stringify(r.status)} naming a run: treated as background`);
      inv.background = true;
      if (inv.parent) holdFor(inv.parent, waitText(inv.description, inv.name));
    }
  }

  // A RUN THAT COMES BACK. The CLI runs a finished agent again on its OLD
  // agent_id, with no Agent call: its calls and SubagentStop carry an id
  // bind() drops as a late echo of the ended run. So a run this host watched
  // end reopens as a new invocation bound to that id. It's background work:
  // the main turn ends while it runs. Returns it, or null for an id this host
  // never saw end (or one that's running: those aren't in endedIds).
  function reopen(agentId, key, nameOverride, mate) {
    const name = nameOverride !== undefined ? nameOverride : endedIds.get(agentId);
    if (name === undefined) return null;
    endedIds.delete(agentId);
    reapedIds.delete(agentId);
    queued.delete(agentId);
    const a = ensure(name);
    if (!running(name)) {
      a.errors = 0;
      a.repeats = 0;
      a.lastSignature = null;
    }
    a.flashUntil = 0;
    a.lastActivity = now();
    const inv = {
      id: ++serial, key, name, agentId, parent: null, orphan: false, background: true,
      description: undefined, startedAt: now(), lastActivity: now(), ...idleTools(),
    };
    if (mate) { inv.mate = mate; mate.ended = false; mate.reaped = false; mate.wake = false; mate.runtimeId = agentId; }
    invs.push(inv);
    if (key !== null) spawns.set(key, inv);
    setState(name, a, WORKING);
    return inv;
  }

  // What a SendMessage did, read from its own RESULT, which names the run for
  // certain however `to` addressed it: an id, a name, or "name [ref]".
  // Measured with the real CLI (verify/probe-resume-queued-message.js):
  //   { success: true, resumedAgentId, pin: { id } }   a run that had ended,
  //       RESUMED ("Resuming agent ...");
  //   { success: true, pin: { id } }   a run still going: "queued for
  //       delivery ... at its next tool round";
  //   { success: false }   nobody reachable by that name; nothing happened.
  // Not on PreToolUse, which is only intent: a send that was denied, blocked
  // or Esc'd has no result, and opening on it left a working card behind for
  // the whole stall window (Dexter F5 / Miguel M1, PR #69). And not by
  // resolving `to` here: the CLI gives a name to the newest agent that TOOK
  // it, and a foreground pair's ids can be bound crosswise, so the host
  // resumed the wrong run both ways (Dexter F1, F2).
  function message(p) {
    const r = p.tool_response;
    if (!r || typeof r !== 'object' || r.success !== true) return;
    const key = p.tool_use_id ?? null;
    if (key !== null && (spawns.has(key) || endedKeys.has(key))) return;   // delivered twice
    // A message to an idle TEAMMATE wakes it without any resumedAgentId (an
    // inbox delivery, not a transcript resume): mark it, and its next event
    // reopens it (Dexter, PR #94, F2). Addressed by name or by address.
    const to = p.tool_input && p.tool_input.to;
    const mate = typeof to === 'string' ? mates.get(to.split('@')[0]) : undefined;
    if (mate && mate.ended) mate.wake = true;
    if (typeof r.resumedAgentId === 'string' && r.resumedAgentId) { reopen(r.resumedAgentId, key); return; }
    // A run still going drains the message at its next tool round. If it has
    // none left, because it's writing its last reply, it ENDS first, and the
    // message wakes it afterwards on the same id (the probe's "late" timing:
    // Dexter F3). So the id is marked until one of its calls shows the
    // message drained, and a marked run's next event after its end reopens it.
    const id = r.pin && typeof r.pin.id === 'string' ? r.pin.id : null;
    if (id && invs.some(i => i.agentId === id)) remember(queued, id);
  }

  // A marked run's event after it ended: the queued message woke it. Not a
  // SubagentStop, which a duplicate of the run's own stop would be: that
  // would spend the wake. (A woken run that makes no call at all shows
  // nothing.)
  //
  // KNOWN LIMITATION (Dexter F6, PR #69): once a run is open again, a late
  // echo of its PREVIOUS run's events lands on it: nothing in the payload
  // tells the two apart. A late SubagentStop then finishes the resumed run
  // early. That echo would have to lag a whole model turn, so it's accepted,
  // like the crosswise binding.
  function wake(agentId, agentType) {
    if (queued.has(agentId)) reopen(agentId, null);   // a no-op while the run is still going
    // A REAPED background run speaking again was only quiet, not dead.
    else if (reapedIds.has(agentId)) reopen(agentId, null);
    // A teammate whose run ended and that either was woken by a message or was
    // only reaped for silence (Dexter, PR #94, F2/F5).
    else {
      for (const mate of mates.values()) {
        if (!mate.ended || !(mate.wake || mate.reaped)) continue;
        if (!mateMatches(mate, agentId, agentType)) continue;
        if (invs.some(i => i.mate === mate)) continue;
        reopen(agentId, null, mate.card, mate);
        break;
      }
    }
  }

  // A tool call began. The main session's own (no agent_id) touches no card.
  function noteTool(p) {
    const t = now();
    const inv = p.agent_id ? bind(p.agent_id, p.agent_type) : null;
    if (!inv) return;
    refresh(inv);
    inv.waiting = false;                               // its next call: the prompt was answered
    inv.modWaiting = false;
    inv.clearedAt = now();
    // Calls of one run are sequential, and a Bash that was denied, blocked by a hook or lost never gets a result:
    // a new call means the older ones are over (PR #154, Dexter 2).
    inv.bash.clear();
    inv.tool = null;
    const tool = p.tool_name;
    if (tool === 'Bash') {
      // A background command returns at once; its end is not hooked, so it is never "running" -- and what the run
      // then waits on (TaskOutput) is hooked by nothing, so silence no longer means stuck.
      if (p.tool_input && p.tool_input.run_in_background === true) { holdFor(inv, waitText(p.tool_input.description, p.tool_input.command)); return; }
      inv.bash.set(p.tool_use_id ?? `anon:${++serial}`, t);
    } else if (READ_TOOLS.has(tool)) {
      inv.tool = { kind: READING, at: t };
    } else if (WRITE_TOOLS.has(tool)) {
      inv.tool = { kind: WRITING, at: t };
    }
  }

  function clearBash(inv, toolUseId) {
    if (toolUseId != null) inv.bash.delete(toolUseId);
    else if (inv.bash.size) inv.bash.delete(inv.bash.keys().next().value);
  }

  // The PermissionRequest hook: a permission prompt or question is about to be shown for a tool call. Its input is built with the
  // tool-use context (CLI 2.1.296, executePermissionRequestHooks: $d(session, mode, ..., toolUseContext)), so inside a subagent it carries
  // that agent's agent_id; without one it is the main session's own prompt, which has its own attention cue and no card. (A Notification
  // never carries agent_id, so it can't say whose it is: PR #154 round 2, N1.)
  function permissionRequest(p) {
    const inv = p.agent_id ? bind(p.agent_id, p.agent_type) : null;
    if (inv) inv.waiting = true;
  }

  function handleEvent({ event, payload }) {
    const p = payload || {};
    const tool = p.tool_name;
    if (p.agent_id) {
      saysWho = true;
      if (event !== 'SubagentStop') wake(p.agent_id, p.agent_type);
      // A tool round of that run COMPLETED, so a message queued for it drained.
      if (event === 'PostToolUse' || event === 'PostToolUseFailure') queued.delete(p.agent_id);
    }

    // A SendMessage's result may bring a run back. The call itself is then the
    // sender's own, handled below like any other.
    if (event === 'PostToolUse' && tool === 'SendMessage') message(p);

    if (event === 'PreToolUse' && AGENT_TOOLS.has(tool)) {
      const input = p.tool_input || {};
      const agent = input.subagent_type;
      if (!agent) return;                     // nothing identifiable to light up
      // The same spawn delivered twice, or echoed after it ended, is not a
      // second run.
      const key = p.tool_use_id ?? null;
      if (key !== null && (spawns.has(key) || endedKeys.has(key))) return;
      const a = ensure(agent);
      // "A fresh run starts clean" -- but only if it IS a fresh run (Dexter
      // F4): a parallel second instance must not wipe the first's errors.
      if (!running(agent)) {
        a.errors = 0;
        a.repeats = 0;
        a.lastSignature = null;
      }
      a.flashUntil = 0;
      a.lastActivity = now();
      const parent = p.agent_id ? bind(p.agent_id, p.agent_type) : null;
      const inv = {
        id: ++serial, key, name: agent, agentId: null, parent,
        // A spawner that names itself but can't be found (reaped, ended,
        // never seen -- or the host restarted) is some AGENT, not the main
        // session. "Unknown" used to be merged into "main session", so Stop
        // and a main-session Esc ended a run that wasn't the turn's. An
        // orphan ends only on its own events, SessionEnd and the reapers.
        orphan: !!p.agent_id && !parent,
        background: input.run_in_background === true, description: input.description,
        startedAt: now(), lastActivity: now(), ...idleTools(),
      };
      invs.push(inv);
      if (inv.key !== null) spawns.set(inv.key, inv);
      if (parent) {
        refresh(parent);
        parent.waiting = false;                  // launching a helper is a tool call: its prompt was answered
        parent.modWaiting = false;
        parent.clearedAt = now();
        parent.bash.clear();
        parent.tool = null;
        if (inv.background) holdFor(parent, waitText(input.description, agent));
      }
      setState(agent, a, WORKING);
      return;
    }
    if (event === 'PreToolUse') { noteTool(p); return; }
    if (event === 'PermissionRequest') { permissionRequest(p); return; }

    const failureEvent = event === 'PostToolUseFailure';
    if (event === 'PostToolUse' || failureEvent) {
      // AN INTERRUPT IS NOBODY'S FAILURE, on either path (Dexter F4).
      //
      // Only PostToolUseFailure `is_interrupt` CUTS A RUN OFF: the call was
      // aborted and its result never came. A PostToolUse carrying
      // `interrupted: true` did arrive, so the agent's turn goes on -- only
      // that command was killed (Dexter, PR #56, #2). Measured, read-only,
      // 2026-09-27: 32,137 real Bash results carry interrupted:false and none
      // carry true; a timeout comes back as an error, an Esc as "[Request
      // interrupted by user for tool use]". So the flag ends the call, is
      // never an error, and the run continues.
      const interrupted = failureEvent && p.is_interrupt === true;
      const callInterrupted = !failureEvent && !!p.tool_response
        && typeof p.tool_response === 'object' && p.tool_response.interrupted === true;

      const spawnKey = AGENT_TOOLS.has(tool) && p.tool_use_id != null ? p.tool_use_id : null;
      const spawned = spawnKey !== null ? spawns.get(spawnKey) : undefined;
      if (spawned || (spawnKey !== null && endedKeys.has(spawnKey))) {
        const spawner = p.agent_id ? bind(p.agent_id, p.agent_type) : null;
        if (spawner) { refresh(spawner); spawner.waiting = false; spawner.modWaiting = false; spawner.clearedAt = now(); spawner.bash.clear(); spawner.tool = null; }
        spawnResult(spawned, event, p, interrupted);
        return;
      }

      // WHOSE call. Measured: a subagent's calls carry agent_id + agent_type, a
      // main-session call carries neither. A FAILURE with no agent_id is the
      // main session's (Dexter F1) -- and an interrupted one means Esc aborted
      // the main turn, which ends its foreground chain (Stop does not fire).
      if (failureEvent && !p.agent_id) {
        if (interrupted) cutOff(invs.filter(mainForeground));
        return;
      }
      // A PostToolUse with no agent_id is the main session's own call on a CLI
      // that labels subagent calls, and touches no subagent's state, errors
      // or clocks (Dexter, PR #56, #3: every main-session call used to be
      // pinned on the youngest open agent). Only a CLI that has never labelled
      // anything keeps the old fallback, and then only onto the main
      // session's own foreground work -- never a background run.
      let inv;
      if (p.agent_id) inv = bind(p.agent_id, p.agent_type);
      else if (!saysWho) inv = [...invs].reverse().find(mainForeground);
      if (!inv) return;                       // no running agent to attribute to
      if (p.agent_id) refresh(inv); else refreshAll();
      inv.waiting = false;
      inv.modWaiting = false;
      inv.clearedAt = now();
      if (tool === 'Bash') clearBash(inv, p.tool_use_id);
      else { inv.bash.clear(); inv.tool = null; }      // a call whose only hook is its Post (SendMessage, Artifact) is a newer call too

      // The interrupted invocation ends, with its foreground descendants.
      if (interrupted) { cutOff(subtree(inv)); return; }

      const agent = inv.name;
      const a = ensure(agent);
      if (!callInterrupted && (failureEvent || isFailure(p.tool_response))) {
        a.errors++;
        a.repeats = 0;
        a.lastSignature = null;
        setState(agent, a, STRESSED);
        return;
      }

      // A repeated identical call reads as a retry loop even when each
      // individual call reports success.
      const signature = tool + ':' + JSON.stringify(p.tool_input ?? null);
      a.repeats = signature === a.lastSignature ? a.repeats + 1 : 1;
      a.lastSignature = signature;

      setState(agent, a, a.repeats >= RETRY_LIMIT ? STRESSED : WORKING);
      return;
    }

    if (event === 'SubagentStop') {
      // The payload NAMES the agent, so use it (verify/probe-payloads.js).
      // Older versions send no agent_id: then the youngest invocation of the
      // named type, and with no name at all the youngest invocation.
      let inv;
      if (p.agent_id) inv = bind(p.agent_id, p.agent_type);
      else if (p.agent_type) inv = [...invs].reverse().find(i => i.name === p.agent_type);
      else inv = current();
      if (!inv) return;                       // never started here; not ours to end
      finish(inv);
      return;
    }

    if (event === 'Stop') {
      // THE TURN IS OVER, so the foreground work it owned is over: one still
      // open lost its close, and it finished (Stop does not fire on Esc).
      //
      // NOT background work. Measured (test/hooks-real-subagent-failure):
      // Stop fires while a background agent still runs, and lists it in
      // `background_tasks` -- even one launched with no run_in_background.
      //
      // An ENDED id listed as running is not proof it came back: the list
      // races the run's own SubagentStop, and names a run 1 ms before that
      // stop arrives (verify/probe-resume-queued-message.js). So it's skipped,
      // not reopened.
      for (const task of Array.isArray(p.background_tasks) ? p.background_tasks : []) {
        if (!task || !task.id || endedIds.has(task.id)) continue;
        // By id when we know it. Otherwise by name, but only among the runs
        // Stop is about to end (the only ones a wrong guess can hurt), and
        // only when exactly one fits: an ambiguous guess re-keyed the wrong
        // run and ended the listed one (Dexter, PR #56, #7).
        let inv = invs.find(i => i.agentId === task.id);
        if (!inv) {
          const fits = invs.filter(i => !i.agentId && mainForeground(i) && i.name === task.agent_type
            && (task.description == null || i.description === task.description));
          if (fits.length === 1) inv = fits[0];
        }
        if (!inv) continue;
        inv.agentId = task.id;
        inv.background = true;
      }
      finishAll(invs.filter(mainForeground));
      return;
    }

    if (event === 'SessionEnd') {
      // Measured: /clear fires SessionEnd and KILLS background agents
      // (verify/probe-clear-background.js). Everything is cut off, and no
      // queued message will wake anything.
      cutOff([...invs]);
      queued.clear();
    }
  }

  function handle(ev) {
    handleEvent(ev);
    settle();
  }

  function finishAll(list) { end(list, () => true); }

  function tick() {
    const t = now();

    // BACKSTOPS, PER INVOCATION. Two clocks, because there are two questions
    // (Dexter F7): `lastActivity` asks "is it thinking" and is refreshed up
    // the parent link; `startedAt` asks "how long has this run existed" and
    // NOTHING refreshes it, so a run whose SubagentStop was dropped is reaped
    // even while the rest of the session is busy.
    //
    // Newest first, and never an invocation with a live FOREGROUND child: a
    // parent is never ended while a descendant it is waiting on still runs.
    // Children are younger, so they cross their own limits first and the
    // parent follows them out -- in this same pass, when it is stale too.
    // A mod `waiting` is only as good as its last snapshot: with none newer inside the stall window it lapses, and the stall clock below
    // applies again (a mod gone quiet must not keep a run from being reaped for ever).
    for (const inv of invs) if (inv.modWaiting && t - inv.modWaitingAt > stallMs) inv.modWaiting = false;
    const gone = new Set();
    for (let k = invs.length - 1; k >= 0; k--) {
      const inv = invs[k];
      // The age cap is for a run NOTHING refreshes but its own spawner's
      // chain. A background run is its own root: refresh() stops at its edge,
      // so only its OWN events keep it alive, and the stall clock is already
      // the right question -- the cap reaped a healthy multi-hour run (a
      // mutation gate) at 45 minutes. Only once the CLI labels its calls: an
      // older one has refreshAll() touching everything, so there the cap stays.
      const capped = !(inv.background && saysWho) && !inv.quiet && t - inv.startedAt > maxInvocationMs;
      // An open prompt is the person's to answer, not a silent run: the stall clock doesn't reap it (the age cap above still does).
      const stale = capped || (!inv.waiting && !inv.modWaiting && t - inv.lastActivity > (inv.quiet ? quietStallMs : stallMs));
      if (stale && !fgChildren(inv).some(c => !gone.has(c))) gone.add(inv);
    }
    // A reaped run was cut off, so it sleeps at once -- not whenever the idle
    // clock catches up (test/mood-machine-kills.test.js).
    if (gone.size) reap([...gone]);

    for (const [agent, a] of agents) {
      if (a.state === SLEEPING) continue;

      // A finished agent holds its happy/stressed flash, then sleeps --
      // UNLESS IT IS STILL RUNNING (Dexter, PR #33, F3). `flashUntil` is only
      // set when no invocation of the name remains and PreToolUse zeroes it,
      // so the WORKING side is unreachable today (measured by Mortimer); it is
      // kept as the defence against the class that produced F3.
      if (a.flashUntil) {
        if (t > a.flashUntil) {
          a.flashUntil = 0;
          setState(agent, a, running(agent) ? WORKING : SLEEPING);
        }
        continue;
      }

      // A RUNNING card is judged by its invocations' clocks above. The idle
      // clock is the rule for a card that is awake and NOT running -- which no
      // path produces today (every ending either flashes or sleeps), kept so
      // the next path that does is not immortal.
      if (running(agent)) continue;
      if (t - a.lastActivity > idleMs) setState(agent, a, SLEEPING);
    }
    settle();
  }

  // BACKLOG #119 A2: the claude-custom mod's `$.agent.list()` snapshot, a SECOND source for the finer `waiting` detail. The hooks keep
  // identity and lifecycle: this only marks a run they have already opened AND bound to an agent_id, never opens, binds, ends or
  // sleeps one, and ignores every status but `waiting` (a status the CLI adds later changes nothing until it is named here). A
  // snapshot is the whole truth of the moment: an agent it no longer lists as waiting is cleared, and so is one whose own next
  // hooked event arrives (the clear sites of `waiting`).
  function observeAgents(list, at) {
    const waiting = new Set();
    if (Array.isArray(list)) {
      for (const a of list) if (a && typeof a === 'object' && typeof a.id === 'string' && a.status === 'waiting') waiting.add(a.id);
    }
    // `at` is when the mod took the snapshot. One older than the agent's last clearing hook (its next tool call, a launched helper) says
    // what was true before that hook and never re-raises `waiting`; without an `at` the snapshot is taken as current.
    for (const inv of invs) {
      const listed = typeof inv.agentId === 'string' && waiting.has(inv.agentId);
      const stale = typeof at === 'number' && Number.isFinite(at) && at < inv.clearedAt;
      const on = listed && !stale;
      if (on) inv.modWaitingAt = now();
      inv.modWaiting = on;
    }
    settle();
  }

  machine.handle = handle;
  machine.observeAgents = observeAgents;
  machine.tick = tick;
  machine.stateOf = agent => (agents.get(agent) || { state: SLEEPING }).state;
  // Every live invocation's NAME, in start order -- one entry per running
  // instance, unchanged for every consumer (host.js draws this as `party`,
  // app/agent-card-display.js counts it for the ×N badge).
  machine.stack = () => invs.map(i => i.name);
  machine.detailOf = agent => (agents.get(agent) || { detail: SLEEPING }).detail;
  machine.roster = () => [...agents].map(([agent, a]) => ({ agent, state: a.state, detail: a.detail }));
  // Sizes of the per-host bookkeeping, for the test that it stays bounded.
  machine.bookkeeping = () => ({ spawns: spawns.size, endedKeys: endedKeys.size, endedIds: endedIds.size,
    queued: queued.size });
  // Whether this machine watched the run with that agent_id end, for the agent
  // log's "finished" (host/agent-log-session.js). Bounded by REMEMBER_MAX.
  machine.watchedEnd = agentId => typeof agentId === 'string' && endedIds.has(agentId);
  // The task line the newest open run of this agent was spawned with (the Agent call's `description`), or undefined. Read-only;
  // the speech bubbles (host/bubbles.js) put it, trimmed, in their prompt.
  // What the card's "waiting..." says (BACKLOG #155): { on, since } of the longest-waiting run of this agent, while the card shows the
  // wait; null otherwise. `on` is one line or null; `since` is when the run last said anything (ms).
  machine.waitOf = agent => {
    const a = agents.get(agent);
    if (!a || (a.detail !== BGWAIT && a.detail !== BGWAIT_LATE)) return null;
    const t = now();
    let best = null;
    for (const inv of invs) {
      if (inv.name !== agent || !inv.quiet || inv.waiting || inv.modWaiting || !bgWaiting(inv, t)) continue;
      if (best === null || inv.lastActivity < best.lastActivity) best = inv;
    }
    return best ? { on: best.waitOn, since: best.lastActivity } : null;
  };
  machine.taskOf = agent => {
    for (let i = invs.length - 1; i >= 0; i--) {
      if (invs[i].name === agent && typeof invs[i].description === 'string' && invs[i].description) return invs[i].description;
    }
    return undefined;
  };
  // The live invocation tree, read-only, for tests and diagnostics.
  machine.invocations = () => invs.map(i => ({
    id: i.id, name: i.name, key: i.key, agentId: i.agentId,
    parentId: i.parent ? i.parent.id : null, background: i.background,
  }));

  return machine;
}

module.exports = {
  createMoodMachine, STALL_MS, IDLE_MS, FLASH_MS, REMEMBER_MAX, SLEEPING, WORKING, HAPPY, STRESSED,
  READING, WRITING, RUNNING, WAITING, STUCK, HELPER, TOOL_LINGER_MS, STUCK_MS,
  BGWAIT, BGWAIT_LATE, WAIT_GRACE_MS, WAIT_RED_MS, QUIET_STALL_MS,
};
