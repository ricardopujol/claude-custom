'use strict';
/**
 * The OS toasts claude-custom raises (BACKLOG #145).
 *
 * Electron delivers a toast's click through the JS Notification object. Nothing else referenced it, so once it was
 * garbage-collected the click had no handler: Windows then activates the app by its shared id, which with several
 * claude-custom windows open lands on some other one. The holder keeps each toast until it is clicked, closed or
 * failed, and remembers which tab view raised it.
 *
 * deps: Notification (Electron's class), onClick(sender), log(msg)
 */
function createToastHolder(deps) {
  const held = new Set();
  const log = deps.log || (() => {});

  function show(toast, sender) {
    const n = new deps.Notification({
      title: String((toast && toast.title) || 'claude-custom'),
      body: String((toast && toast.body) || ''),
      silent: !!(toast && toast.silent),
    });
    held.add(n);
    const release = () => { held.delete(n); };
    n.on('click', () => {
      release();
      try { deps.onClick(sender); } catch (err) { log(`[main] toast click failed: ${err && err.message}`); }
    });
    n.on('close', release);
    n.on('failed', release);
    n.show();
    return n;
  }

  return { show, held: () => held.size };
}

module.exports = { createToastHolder };
