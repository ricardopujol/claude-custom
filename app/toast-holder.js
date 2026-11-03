'use strict';
/**
 * The OS toasts claude-custom raises (BACKLOG #145).
 *
 * Electron delivers a toast's click through the JS Notification object. Nothing else referenced it, so once it was
 * garbage-collected the click had no handler: Windows then activates the app by its shared id, which with several
 * claude-custom windows open lands on some other one. The holder keeps each toast and remembers which tab view
 * raised it.
 *
 * It does NOT release on `close`: on Windows `close` also fires when the toast times out into the Action Center,
 * where it can still be clicked. It releases on `click` and `failed`, and holds at most MAX_HELD toasts, dropping the
 * oldest, so unclicked toasts (and the views they name) can't pile up for the life of the app.
 *
 * deps: Notification (Electron's class), onClick(sender), log(msg)
 */
const MAX_HELD = 20;

function createToastHolder(deps) {
  const held = new Set();      // insertion order: the first entry is the oldest
  const log = deps.log || (() => {});

  function show(toast, sender) {
    const n = new deps.Notification({
      title: String((toast && toast.title) || 'claude-custom'),
      body: String((toast && toast.body) || ''),
      silent: !!(toast && toast.silent),
    });
    const release = () => { held.delete(n); };
    n.on('click', () => {
      release();
      try { deps.onClick(sender); } catch (err) { log(`[main] toast click failed: ${err && err.message}`); }
    });
    n.on('failed', release);
    held.add(n);
    while (held.size > MAX_HELD) held.delete(held.values().next().value);
    try {
      n.show();
    } catch (err) {
      // A toast that can't show is nothing to click: don't hold it, and don't let the throw end the caller.
      release();
      log(`[main] toast show failed: ${err && err.message}`);
      return null;
    }
    return n;
  }

  return { show, held: () => held.size };
}

module.exports = { createToastHolder, MAX_HELD };
