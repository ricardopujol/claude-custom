'use strict';
/**
 * An agent's Pause and Resume on its roster card (BACKLOG #19, documentation/DESIGN_ROUND_2026-10-09B.md "Rounds 5-6"): "an agent's
 * Pause stops it and keeps its conversation, Resume wakes it with the same context". The founding bet applies: the CLI has the
 * mechanism, so it is asked for, never reimplemented. Pause asks the model, in the session, to stop that background agent with
 * its own TaskStop tool (which keeps the agent's transcript); Resume asks it to SendMessage the agent, which the CLI answers by
 * resuming the agent from its transcript. Both are typed through the page's existing submit gate (typeCommand), so they wait for
 * the box and obey its refusals like the wand does.
 *
 * What this file is: the page-side state machine and the card's controls. Pure: no DOM, no clock of its own (every call carries
 * `at`), no globals. The state per agent:
 *
 *   idle ──Pause typed──> pausing ──OUR TaskStop seen, and the agent seen not running──> paused ──Resume typed──> resuming ──agent seen running──> idle
 *     ^                     │ (nothing stopped it, and the turn has been idle for the timeout)        │ (not running after the idle timeout)
 *     └─────────────────────┘                                                                         └──> paused
 *
 * "PAUSED" IS CLAIMED ONLY FOR AN AGENT OUR PAUSE STOPPED (PR #158 Dexter 3). An agent leaving the roster has three causes: our TaskStop, its own
 * finish, and /clear. Only the first is a pause, so the page must have SEEN a TaskStop tool call start after the line was typed (`sawTaskStop`, fed
 * from the CLI's own hook feed) before a vanished agent counts. A finish with no TaskStop is never claimed.
 *
 * THE TIMEOUT RUNS ON IDLE TIME (Dexter 4). The typed line is queued while the session's turn runs, and the page cannot withdraw it; calling the
 * pause off after a fixed time while a long turn is still running would leave the agent stopped later with no card for it. So the timeout counts
 * only while the turn is idle: it is measured from the last moment the turn was seen busy.
 *
 * OUR TaskStop, not any TaskStop (PR #158 Dexter R2-1): the line names the run's id when the host knows it ("(task id X)"), and `sawTaskStop` takes the
 * task a TaskStop call stopped (host/processes.js `taskId`). It counts only when that is this agent's id or its name, so a TaskStop of a dev-server shell
 * never marks a pausing agent.
 *
 * THE TIMEOUT'S CLOCK IS THE TURN'S (R2-4): `turnIs` is fed by the host's own turn frames, so an idle edge is seen even when nothing else happened; an
 * unknown turn counts as busy, never as idle.
 *
 * A Pause is offered only for an agent with exactly one running instance (with two, "the agent" names neither). A new session id (/clear kills
 * background agents) forgets every pause (`sessionIs`, Dexter 5).
 *
 * WRAPPED IN AN IIFE (see app/career-display.js): the renderer loads every script as a plain <script> tag sharing ONE global
 * scope. One name leaves it: `agentPauseDisplay`.
 */
(function (root) {

const PAUSE_TIMEOUT_MS = 90_000;
// The CLI's tool-call time (host clock) against the page's click time (same machine): how much earlier than the click a TaskStop may start and still count.
const STOP_SLACK_MS = 1000;
const INPUT_KIND = 'agent-pause';   // the planTyping kind that accepts exactly these lines (app/top-bar-display.js AGENT_PAUSE_LINE)
const NAME_RE = /^[A-Za-z0-9 _.:-]{1,200}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);

const plainName = n => typeof n === 'string' && NAME_RE.test(n);

/**
 * The line typed into the session, or null when the verb, the name or the id is not plain. One line, no quotes of the agent's own. `id` (the run's
 * agent id, when the host knows exactly one) is named in the line so the model stops THAT task and the page can tell our TaskStop from another.
 */
function commandFor(verb, agent, id) {
  if (!plainName(agent)) return null;
  if (id !== undefined && id !== null && !(typeof id === 'string' && ID_RE.test(id))) return null;
  const idPart = typeof id === 'string' ? ` (task id ${id})` : '';
  if (verb === 'pause') {
    return `Stop the background agent "${agent}"${idPart} with TaskStop so it can be resumed later with its conversation kept. Do nothing else.`;
  }
  if (verb === 'resume') {
    return `Resume the stopped agent "${agent}"${idPart}: send it a message with SendMessage to continue where it stopped, with its earlier context. Do nothing else.`;
  }
  return null;
}

/** A click's data attributes -> { act, agent } or null. */
function clickAction(data) {
  if (!data || typeof data !== 'object') return null;
  if ((data.agentPauseAct !== 'pause' && data.agentPauseAct !== 'resume') || !plainName(data.agent)) return null;
  return { act: data.agentPauseAct, agent: data.agent };
}

function createAgentPauses() {
  const state = new Map();   // agent -> { phase: 'pausing' | 'paused' | 'resuming', at, busyAt, idleSeen, since, stopSeen, id }
  let sessionId = null;

  // The turn, as the host's frames say it. Anything but 'idle' (a busy turn, a dialog, an UNKNOWN turn) is busy: the timeout never runs on a guess.
  // The busy -> idle EDGE is stamped too: a quiet turn sends no other frame, so the first idle frame is the first moment it can be measured from.
  function stamp(turn, at) {
    for (const [agent, s] of state) {
      if (turn !== 'idle') { if (s.busyAt !== at || s.idleSeen) state.set(agent, { ...s, busyAt: at, idleSeen: false }); }
      else if (!s.idleSeen) state.set(agent, { ...s, busyAt: at, idleSeen: true });
    }
  }

  return {
    /** A Pause or Resume was typed: only from the right phase. `id` is the run's task id named in the line, if any. True when the phase moved. */
    begin(agent, verb, at, id) {
      const s = state.get(agent);
      if (verb === 'pause' && !s) { state.set(agent, { phase: 'pausing', at, busyAt: at, idleSeen: false, since: null, stopSeen: false, id: typeof id === 'string' ? id : null }); return true; }
      if (verb === 'resume' && s && s.phase === 'paused') { state.set(agent, { ...s, phase: 'resuming', at, busyAt: at, idleSeen: false }); return true; }
      return false;
    },
    /** The typing was refused (the gate said no, the box was not empty): the phase goes back to where it was. */
    refused(agent) {
      const s = state.get(agent);
      if (!s) return;
      if (s.phase === 'pausing') state.delete(agent);
      else if (s.phase === 'resuming') state.set(agent, { ...s, phase: 'paused', at: s.at, busyAt: s.at, idleSeen: false });
    },
    /**
     * A TaskStop tool call was seen starting (`startedAt`, the CLI's hook feed) with the task it stops (`taskId`). It counts for a pausing agent only if
     * it started after the line was typed AND it names THIS agent: its id from the line, or its name. A TaskStop of anything else, or one that names no
     * task, is not ours.
     */
    sawTaskStop(startedAt, taskId) {
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || typeof taskId !== 'string' || taskId === '') return;
      for (const [agent, s] of state) {
        if (s.phase !== 'pausing' || s.stopSeen || startedAt < s.at - STOP_SLACK_MS) continue;
        if (taskId === agent || (s.id !== null && taskId === s.id)) state.set(agent, { ...s, stopSeen: true, stopAt: startedAt });
      }
    },
    /**
     * The TaskStop that started at `startedAt` FAILED (the host keeps such a call listed, ended and flagged): it stopped nothing, so "stop seen" is
     * undone for the agent it named, and only for that call: a retry (a later start) stands (PR #158 Dexter R3 N4).
     */
    stopFailed(startedAt, taskId) {
      if (typeof startedAt !== 'number' || typeof taskId !== 'string' || taskId === '') return;
      for (const [agent, s] of state) {
        if (s.phase !== 'pausing' || !s.stopSeen || s.stopAt !== startedAt) continue;
        if (taskId === agent || (s.id !== null && taskId === s.id)) state.set(agent, { ...s, stopSeen: false, stopAt: null });
      }
    },
    /** Is any card pausing or resuming (its timeout, and so a redraw, is owed)? */
    waiting() { for (const s of state.values()) if (s.phase === 'pausing' || s.phase === 'resuming') return true; return false; },
    /** The session's turn state from a `turn` frame ('idle' | 'turn' | 'prompt' | null), when it arrives. */
    turnIs(turn, at) { stamp(turn, at); },
    /**
     * A roster refresh: `running` is Map<agent, instances>, `opts.turn` the session's turn state. This is where the agent is SEEN stopped or running
     * again; the timeout counts only idle time.
     */
    seen(running, at, opts) {
      stamp(opts && opts.turn, at);
      const busy = !(opts && opts.turn === 'idle');
      for (const [agent, s] of [...state]) {
        const n = running instanceof Map && typeof running.get(agent) === 'number' ? running.get(agent) : 0;
        const timedOut = !busy && s.idleSeen && at - s.busyAt >= PAUSE_TIMEOUT_MS;
        if (s.phase === 'pausing') {
          if (n === 0 && s.stopSeen) state.set(agent, { ...s, phase: 'paused', at, since: at });
          else if (timedOut) state.delete(agent);
        } else if (s.phase === 'paused') {
          if (n > 0) state.delete(agent);           // it runs again (woken some other way): nothing is paused
        } else if (s.phase === 'resuming') {
          if (n > 0) state.delete(agent);
          else if (timedOut) state.set(agent, { ...s, phase: 'paused', at, busyAt: at });
        }
      }
    },
    /** The session this roster belongs to (from `hello` and every `session` frame): a DIFFERENT id than the last known one (/clear) forgets every pause. An unknown id changes nothing. */
    sessionIs(id) {
      if (typeof id !== 'string' || id === '') return;
      if (sessionId !== null && id !== sessionId) state.clear();
      sessionId = id;
    },
    /** The session ended: every agent was killed or is gone. */
    reset() { state.clear(); },
    /** What the card shows: { kind: 'none' | 'pause' | 'pausing' | 'paused' | 'resuming', since? }. `instances` is the running count. */
    view(agent, instances) {
      const s = state.get(agent);
      if (!s) return { kind: instances === 1 ? 'pause' : 'none' };
      if (s.phase === 'paused') return { kind: 'paused', since: s.since };
      return { kind: s.phase };
    },
  };
}

function clockOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The card's control, as markup: '' when there is nothing to show. */
function html(view, agent) {
  const a = esc(agent);
  switch (view && view.kind) {
    case 'pause':
      return `<div class="agent-pause"><button type="button" class="agent-pause-btn" data-agent-pause-act="pause" data-agent="${a}" title="Stop ${a} and keep its conversation, to resume later">Pause</button></div>`;
    case 'pausing': return '<div class="agent-pause"><span class="agent-paused-badge">pausing…</span></div>';
    case 'resuming': return '<div class="agent-pause"><span class="agent-paused-badge">resuming…</span></div>';
    case 'paused':
      return `<div class="agent-pause"><span class="agent-paused-badge">${typeof view.since === 'number' ? `paused ${clockOf(view.since)}` : 'paused'}</span>`
        + `<button type="button" class="agent-pause-btn" data-agent-pause-act="resume" data-agent="${a}" title="Wake ${a} with its conversation">Resume</button></div>`;
    default: return '';
  }
}

const API = { PAUSE_TIMEOUT_MS, INPUT_KIND, commandFor, clickAction, createAgentPauses, html };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.agentPauseDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
