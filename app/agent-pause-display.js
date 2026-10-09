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
 *   idle ──Pause typed──> pausing ──agent seen not running──> paused ──Resume typed──> resuming ──agent seen running──> idle
 *     ^                     │ (still running after the timeout: the stop did not happen)         │ (not running after the timeout)
 *     └─────────────────────┘                                                                    └──> paused
 *
 * "Paused" is only ever claimed after the agent was SEEN stopped following a Pause we sent. A Pause is offered only for an agent
 * with exactly one running instance (with two, "the agent" names neither). A session end (/clear kills background agents) forgets
 * every pause.
 *
 * WRAPPED IN AN IIFE (see app/career-display.js): the renderer loads every script as a plain <script> tag sharing ONE global
 * scope. One name leaves it: `agentPauseDisplay`.
 */
(function (root) {

const PAUSE_TIMEOUT_MS = 90_000;
const NAME_RE = /^[A-Za-z0-9 _.:-]{1,200}$/;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);

const plainName = n => typeof n === 'string' && NAME_RE.test(n);

/** The line typed into the session, or null when the verb or the name is not plain. One line, no quotes of the agent's own. */
function commandFor(verb, agent) {
  if (!plainName(agent)) return null;
  if (verb === 'pause') {
    return `Stop the background agent "${agent}" with TaskStop so it can be resumed later with its conversation kept. Do nothing else.`;
  }
  if (verb === 'resume') {
    return `Resume the stopped agent "${agent}": send it a message with SendMessage to continue where it stopped, with its earlier context. Do nothing else.`;
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
  const state = new Map();   // agent -> { phase: 'pausing' | 'paused' | 'resuming', at, since }

  return {
    /** A Pause or Resume was typed: only from the right phase. True when the phase moved. */
    begin(agent, verb, at) {
      const s = state.get(agent);
      if (verb === 'pause' && !s) { state.set(agent, { phase: 'pausing', at, since: null }); return true; }
      if (verb === 'resume' && s && s.phase === 'paused') { state.set(agent, { phase: 'resuming', at, since: s.since }); return true; }
      return false;
    },
    /** The typing was refused (the gate said no, the box was not empty): the phase goes back to where it was. */
    refused(agent) {
      const s = state.get(agent);
      if (!s) return;
      if (s.phase === 'pausing') state.delete(agent);
      else if (s.phase === 'resuming') state.set(agent, { phase: 'paused', at: s.at, since: s.since });
    },
    /** A roster refresh: `running` is Map<agent, instances>. This is where the agent is SEEN stopped or running again. */
    seen(running, at) {
      for (const [agent, s] of [...state]) {
        const n = running instanceof Map && typeof running.get(agent) === 'number' ? running.get(agent) : 0;
        if (s.phase === 'pausing') {
          if (n === 0) state.set(agent, { phase: 'paused', at, since: at });
          else if (at - s.at >= PAUSE_TIMEOUT_MS) state.delete(agent);
        } else if (s.phase === 'paused') {
          if (n > 0) state.delete(agent);           // it runs again (woken some other way): nothing is paused
        } else if (s.phase === 'resuming') {
          if (n > 0) state.delete(agent);
          else if (at - s.at >= PAUSE_TIMEOUT_MS) state.set(agent, { phase: 'paused', at, since: s.since });
        }
      }
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

const API = { PAUSE_TIMEOUT_MS, commandFor, clickAction, createAgentPauses, html };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.agentPauseDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
