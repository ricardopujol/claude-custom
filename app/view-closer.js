'use strict';
/**
 * A closed window closes the pages it made (PR #256 Miguel B1).
 *
 * Electron does NOT destroy the webContents of a WebContentsView when the window that holds it closes (BrowserWindow destroys only its own
 * page). Before several windows lived in one process this never mattered: the last window closing ended the process. Now a closed window
 * of several would keep every tab renderer (xterm, its socket to its host), its canvas panels, previews and indexing views alive, and a
 * /bedtime night in one of its tabs would keep EVERY window lean (nights drop on the view's 'destroyed', which never came).
 *
 * No Electron here: the caller hands the views and the pieces that know about them.
 */

const quietly = (fn) => { try { fn(); } catch { /* going away: the next view still has to be closed */ } };

/**
 * Close every view in `views` (a Set of WebContentsViews that show tabs) and empty the set.
 * deps: { canvasViews, previewViews } (their destroyFor(webContents)), dropOwner(id) | null (the lean unit's night drop).
 */
function closeViews(views, { canvasViews, previewViews, dropOwner }) {
  for (const view of [...views]) {
    views.delete(view);
    const wc = view.webContents;
    quietly(() => canvasViews.destroyFor(wc));
    quietly(() => previewViews.destroyFor(wc));
    if (typeof dropOwner === 'function' && view.leanOwnerId !== undefined) quietly(() => dropOwner(view.leanOwnerId));
    quietly(() => { if (!wc.isDestroyed()) wc.close(); });
  }
}

/** Close the indexing overlay's views ({ toast, list }, each a view or null) and null them. removeChild(view) takes it off its window. */
function closeOverlayViews(views, { removeChild }) {
  for (const part of Object.keys(views)) {
    const v = views[part];
    views[part] = null;
    if (!v) continue;
    quietly(() => removeChild(v));
    quietly(() => { if (!v.webContents.isDestroyed()) v.webContents.close(); });
  }
}

module.exports = { closeViews, closeOverlayViews };
