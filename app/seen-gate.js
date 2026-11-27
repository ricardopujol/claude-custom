'use strict';
/**
 * The Resources service polls fast only while somebody looks at a window (single-instance PR 2). With one window per process that was
 * that window's own minimise / hide / show; with several it is "any window is seen", worked out here over the registry so one window
 * minimising can't put the sampler to sleep under another that is in view. Pure.
 *
 * `registry.list()` gives the windows and each has `isUnseen()` (minimised, hidden to the tray, not made yet or gone).
 */
function createSeenGate({ registry, getResources }) {
  return function seenChanged() {
    const resources = getResources();
    if (!resources) return;
    resources.setMinimised(registry.list().every((pw) => pw.isUnseen()));
  };
}

module.exports = { createSeenGate };
