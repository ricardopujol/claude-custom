'use strict';
/**
 * How the project list should be DRAWN, given how well each row is known.
 *
 * Extracted from renderer.js for the reason app/usage-display.js,
 * app/career-display.js and app/quota-display.js were: a decision living inside
 * a browser script is a decision nothing can test.
 *
 * The rules this file exists to keep, both of them absence rules:
 *
 *   A failed read of ~/.claude/projects is NOT an empty history. One means "we
 *   could not find out", the other "you have not opened anything else". Drawn
 *   the same, the first silently becomes the second.
 *
 *   A project with no recorded usage is NOT a project with zero tokens.
 *   `Number(null)` is 0 -- this codebase's named trap -- so a coercing format
 *   turns "we have no usage for this" into a confident claim about the project.
 *
 * WRAPPED IN AN IIFE. The renderer loads these as plain <script> tags sharing
 * ONE global scope, and a top-level `const` here would collide with an
 * identically named one in a sibling file and kill this whole file silently --
 * which is exactly how `quotaDisplay` once ended up undefined. No unit test can
 * see that; each test requires the module into its own scope.
 */

(function (root) {

// Strict, not coercing. `typeof` rather than Number.isFinite(Number(x)),
// because Number(null) is 0 and Number('') is 0.
const known = v => typeof v === 'number' && Number.isFinite(v);

function formatTokens(tokens) {
  if (!known(tokens)) return null;              // absence, not zero
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M tokens`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k tokens`;
  return `${tokens} tokens`;
}

function rowFor(p) {
  const tokens = formatTokens(p && p.tokens);
  const bits = [];
  if (tokens) bits.push(tokens);
  if (known(p && p.sessions) && p.sessions > 0) {
    bits.push(`${p.sessions} session${p.sessions === 1 ? '' : 's'}`);
  }

  return {
    path: p.path,
    name: p.name || p.path,
    current: !!p.current,
    // NOT openable when current -- that would spawn a window onto the session
    // you are already looking at -- and NOT openable when APPROXIMATE either
    // (Dexter, Finding 6). An approximate row's `path` is the lossy
    // ~/.claude/projects folder name, not a path: clicking it resolved that
    // name against the CURRENT project and reported a folder that has never
    // existed. A row that cannot open must not look like a button.
    openable: !p.current && !p.approximate,
    approximate: !!p.approximate,
    detail: bits.join(' · '),
    title: p.approximate
      ? `${p.path}\n(approximate -- recovered from the folder name, which is a lossy encoding of the path)`
      : p.path,
  };
}

function projectsDisplay(payload) {
  const ok = !!(payload && payload.ok);
  const projects = (payload && payload.projects) || [];
  const rows = projects.map(rowFor);

  let note = '';
  if (!ok) {
    note = 'could not read your project history';
  } else if (!rows.some(r => r.openable)) {
    note = 'no other projects yet -- open one from the command line with  claude-custom <folder>';
  }

  return { rows, note };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { projectsDisplay, formatTokens };
} else {
  root.projectsDisplay = projectsDisplay;
}

})(typeof window !== 'undefined' ? window : globalThis);
