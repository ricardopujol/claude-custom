'use strict';
/**
 * The reader's Compare view (#50): the disk's version against yours, line by line.
 *
 *   linesOf(text)              -> string[]   the lines (a trailing newline is not another line)
 *   diffLines(disk, mine)      -> [{ kind: 'same' | 'del' | 'add', text, diskNo, mineNo }]
 *       'del' is a line only the disk has, 'add' one only yours has; `diskNo` / `mineNo` are 1-based line numbers
 *       on that side, null on the side that doesn't have the row. Reading the rows back gives exactly the two
 *       texts (the property tests pin it): this only decides how they line up.
 *   MAX_CELLS                  the size of the table it will build before giving up on aligning the middle
 *
 * A longest-common-subsequence alignment of what is left after the shared head and tail are peeled off. The
 * table is lines-by-lines, so a middle bigger than MAX_CELLS (two 2000-line rewrites) is shown as every disk
 * line removed then every line of yours added: still complete and correct, just not aligned.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoLineDiff`.
 */
(function (root) {

const MAX_CELLS = 4000000;

function linesOf(text) {
  const s = String(text);
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function diffLines(disk, mine) {
  const a = linesOf(disk);
  const b = linesOf(mine);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const rows = [];
  const push = (kind, text, d, m) => rows.push({ kind, text, diskNo: d, mineNo: m });
  for (let i = 0; i < head; i += 1) push('same', a[i], i + 1, i + 1);

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < n; i += 1) push('del', a[head + i], head + i + 1, null);
    for (let j = 0; j < m; j += 1) push('add', b[head + j], null, head + j + 1);
  } else {
    // lcs[i][j] = the common length of a[head+i ..] and b[head+j ..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = a[head + i] === b[head + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[head + i] === b[head + j]) { push('same', a[head + i], head + i + 1, head + j + 1); i += 1; j += 1; }
      else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { push('del', a[head + i], head + i + 1, null); i += 1; }
      else { push('add', b[head + j], null, head + j + 1); j += 1; }
    }
  }

  for (let k = 0; k < tail; k += 1) push('same', a[a.length - tail + k], a.length - tail + k + 1, b.length - tail + k + 1);
  return rows;
}

const API = { linesOf, diffLines, MAX_CELLS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoLineDiff = API;

})(typeof window !== 'undefined' ? window : globalThis);
