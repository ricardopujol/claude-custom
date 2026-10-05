'use strict';
/**
 * The indexing assistant's accuracy gate, the arithmetic (backlog #66, DESIGN_INDEXING_ASSISTANT.md "Accuracy gate").
 * verify/probe-indexing-accuracy.js asks the real model; this decides what its answers score.
 *
 *   backlogFor(titles, case)  -> the backlog text the model is shown for one case (a "new" note's own item left out:
 *                                it didn't exist when the note was written)
 *   judge(expected, got)      -> { right, swap }   right: kind AND target exact.  swap: history <-> backlog.
 *   summarize(rows)           -> { right, total, pct, swaps, passed }   passed: pct >= 85 and no swap
 */

const BAR_PCT = 85;

const isHistory = (target) => target === 'history';
const isBacklog = (target) => target === 'new' || Number.isInteger(target);

function backlogFor(titles, c) {
  const keep = (Array.isArray(titles) ? titles : []).filter(t => !(c && Number.isInteger(c.exclude) && t.startsWith(`## ${c.exclude}. `)));
  return '# Backlog\n\n' + keep.join('\n') + '\n';
}

function judge(expected, got) {
  const g = got || {};
  const right = g.kind === expected.kind && g.target === expected.target;
  const swap = (isHistory(expected.target) && isBacklog(g.target)) || (isBacklog(expected.target) && isHistory(g.target));
  return { right, swap };
}

function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const right = list.filter(r => r.right).length;
  const swaps = list.filter(r => r.swap).length;
  const total = list.length;
  const pct = total === 0 ? 0 : Math.round((right / total) * 1000) / 10;
  return { right, total, pct, swaps, passed: total > 0 && pct >= BAR_PCT && swaps === 0 };
}

module.exports = { backlogFor, judge, summarize, BAR_PCT };
