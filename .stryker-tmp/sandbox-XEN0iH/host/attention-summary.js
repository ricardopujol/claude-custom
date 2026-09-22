// @ts-nocheck
'use strict';
/**
 * What a notification SAYS, in ten words or fewer.
 *
 * A toast is read sideways, mid-sentence, from another window. The only thing
 * it has to answer is which of these just happened:
 *
 *   Need permission?        -> and for WHAT, since that decides whether to move
 *   Waiting for input?
 *   Turn finished?
 *   Agents finished work?   -> and how many
 *
 * Anything past that is truncated by the OS anyway, so the useful part goes
 * first and the budget is enforced here rather than hoped for.
 */

const MAX_WORDS = 10;

const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function trimToBudget(text) {
  const words = clean(text).split(' ').filter(Boolean);
  if (words.length <= MAX_WORDS) return words.join(' ');
  // The ellipsis says "there was more", which a hard stop mid-sentence does not
  // -- and the difference matters when the message was a question.
  return words.slice(0, MAX_WORDS - 1).join(' ') + '…';
}

// Claude Code phrases these as "Claude needs your permission to use <Tool>".
// The tool name is the single most useful token in the whole message.
// Deliberately requires the full "to use <Tool>" form. A looser pattern turned
// the plain sentence "Permission needed" into "Needs permission: needed".
const PERMISSION = /permission\s+to\s+use\s+([A-Za-z][\w-]*)/i;

function summarize(event, payload, context) {
  const p = payload || {};
  const ctx = context || {};
  const message = clean(p.message);

  if (event === 'Stop') {
    const agents = Array.isArray(ctx.agents) ? ctx.agents : [];
    if (agents.length) {
      const n = agents.length;
      return `${n} agent${n === 1 ? '' : 's'} finished — turn complete`;
    }
    return 'Task finished';
  }

  // Rewritten only when a tool is actually named; otherwise the message is
  // already about as short as anything written here would be.
  const tool = PERMISSION.exec(message);
  if (tool) return `Needs permission: ${tool[1]}`;

  if (message) return trimToBudget(message);

  // Notification fires for anything that wants you back, so failing open to
  // "something wants you" beats an empty toast body.
  return event === 'Notification' ? 'Waiting for your input' : 'Needs your attention';
}

module.exports = { summarize, MAX_WORDS };
