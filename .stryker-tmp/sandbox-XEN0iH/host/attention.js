// @ts-nocheck
'use strict';
/**
 * When a session wants you back.
 *
 * Two moments matter, and they are not the same:
 *
 *   Notification -> the session is BLOCKED waiting for input. Urgent: nothing
 *                   progresses until you answer.
 *   Stop         -> the turn finished. Worth knowing, not urgent.
 *
 * Deliberately NOT SubagentStop: subagents stop constantly during one piece of
 * work, and notifying on those would fire dozens of times per task, which
 * trains you to ignore the notifications entirely.
 *
 * The host decides WHAT is worth raising; app/attention-surface.js decides
 * where it goes. An OS toast only appears when the window is NOT focused —
 * if you are already looking at it, the in-window cue has said it.
 */

const { EventEmitter } = require('events');
const { summarize } = require('./attention-summary');

// Stop can fire more than once around a single turn ending, and two toasts for
// one event is how a notification system loses its credibility.
const DEFAULT_DEBOUNCE_MS = 4000;

// `agents` is a provider, not a value: the roster changes between the moment
// attention is wired up and the moment a turn ends.
function createAttention({ now = Date.now, project = '', agents = () => [],
                          debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const emitter = new EventEmitter();
  // Debounced per KIND, not globally: a request for input must not be swallowed
  // because a turn happened to end a moment earlier.
  const lastSent = new Map();

  function raise(kind, { title, body, urgent }) {
    const t = now();
    const previous = lastSent.get(kind);
    if (previous !== undefined && t - previous < debounceMs) return;
    lastSent.set(kind, t);
    emitter.emit('attention', { kind, project, title, body, urgent, at: t });
  }

  function handle({ event, payload }) {
    const p = payload || {};

    if (event === 'Notification') {
      raise('input-needed', {
        title: project ? `${project} needs you` : 'Claude needs you',
        body: summarize('Notification', p, {}),
        urgent: true,
      });
      return;
    }

    if (event === 'Stop') {
      raise('finished', {
        title: project ? `${project} finished` : 'Claude finished',
        body: summarize('Stop', p, { agents: agents() }),
        urgent: false,
      });
    }
  }

  emitter.handle = handle;
  return emitter;
}

module.exports = { createAttention, DEFAULT_DEBOUNCE_MS };
