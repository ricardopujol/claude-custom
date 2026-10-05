'use strict';
/**
 * Which navigations a tab page's frames may make (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md).
 *
 * The panel's page is untrusted and lives in a sandboxed iframe. A Content-Security-Policy has no `navigate-to`, so
 * the frame could still send itself to a denied server by setting its own `location`; measured by
 * verify/probe-canvas-sandbox.js (denied server hit with no guard, 0 hits with this one). main.js cancels, on every
 * tab view, any frame navigation this refuses.
 *
 * The one navigation a subframe may make is the load of its own `srcdoc` (`about:srcdoc`), which is how the renderer
 * puts the panel's page in. The page's own (main frame) navigations are left to the code that already governs them.
 * Anything that is not unmistakably the main frame is judged as a subframe.
 */
function allowFrameNavigation(d) {
  if (d === null || typeof d !== 'object') return false;
  if (d.isMainFrame === true) return true;
  return d.url === 'about:srcdoc';
}

module.exports = { allowFrameNavigation };
