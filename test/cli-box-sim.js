'use strict';
/**
 * A model of the CLI's input box for tests of the review-comment typing (PR #199 Dexter r2): the screen it draws, and what the keys do to it.
 * The two behaviours that matter were MEASURED on the real CLI (verify/probe-ctrl-u-wrapped.js):
 *   - Ctrl-U kills only the LAST wrapped row of the line (80 columns: 3 rows -> 2 left);
 *   - Ctrl-E followed by text appends at the end of the line.
 * In vim mode the box is in NORMAL (keys are motions) until `i` or `A`; the footer shows `-- INSERT --` only in INSERT.
 */
const MARK = String.fromCharCode(0x276f);

function createBox({ cols = 80, box = '', vim = false, insert = true, pre = '' } = {}) {
  const sim = { cols, box, vim, insert: vim ? insert : true, keys: [], ctrlU: 0 };
  const rowWidth = () => Math.max(1, cols - 2);
  sim.screen = () => {
    const rule = '─'.repeat(cols - 1);
    const rows = [];
    const w = rowWidth();
    if (sim.box === '') rows.push(MARK);
    for (let i = 0; i < sim.box.length; i += w) rows.push((i === 0 ? `${MARK} ` : '  ') + sim.box.slice(i, i + w));
    return [pre, rule, ...rows, rule, '  footer', ...(sim.vim && sim.insert ? ['-- INSERT --'] : [])].filter(l => l !== '' || false);
  };
  sim.press = (data) => {
    sim.keys.push(data);
    if (data === '\x05') return;
    if (data === '\x15') {
      sim.ctrlU += 1;
      const w = rowWidth();
      if (sim.box.length) sim.box = sim.box.slice(0, Math.floor((sim.box.length - 1) / w) * w);
      return;
    }
    if (sim.vim && !sim.insert) {
      if (data === 'i' || data === 'A') sim.insert = true;
      return;                                    // anything else is a motion
    }
    sim.box += data;
  };
  sim.pressAll = (keys) => { for (const k of keys) sim.press(k); };
  sim.esc = () => { if (sim.vim) sim.insert = false; };
  return sim;
}

module.exports = { createBox, MARK };
