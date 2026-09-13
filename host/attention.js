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
 * The host decides WHAT is worth raising. The GUI decides how loudly to raise
 * it (see app/attention-surface.js) but never whether to raise it at all: an
 * earlier version skipped the toast whenever the window had focus, which
 * silenced the exact case this exists for — sitting watching a long task run,
 * waiting to be told it finished.
 */

const { EventEmitter } = require('events');

// Stop can fire more than once around a single turn ending, and two toasts for
// one event is how a notification system loses its credibility.
const DEFAULT_DEBOUNCE_MS = 4000;

function createAttention({ now = Date.now, project = '', debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
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
        body: String(p.message || 'Waiting for your input').slice(0, 200),
        urgent: true,
      });
      return;
    }

    if (event === 'Stop') {
      raise('finished', {
        title: project ? `${project} finished` : 'Claude finished',
        body: String(p.message || 'The turn is complete').slice(0, 200),
        urgent: false,
      });
    }
  }

  emitter.handle = handle;
  return emitter;
}

module.exports = { createAttention, DEFAULT_DEBOUNCE_MS };
