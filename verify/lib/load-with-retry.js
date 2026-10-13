'use strict';
/* Open a probe window and load a page into it, retrying a load that fails or hangs.
 *
 * On a busy machine (other lanes' probes running) `win.loadFile` sometimes never settles, or settles with
 * ERR_FAILED (-2); the header-fit probe then died at 90 s with "1 width(s) clip" though nothing had been measured.
 * Each attempt gets a fresh window; a failed one is destroyed before the next, so no stray window is left behind.
 *
 *   const win = await loadWithRetry({ open: () => new BrowserWindow(...), load: (w) => w.loadFile(file) });
 */

const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});

async function loadWithRetry({ open, load, attempts = 3, timeoutMs = 15000 }) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    const win = open();
    try {
      await withTimeout(Promise.resolve().then(() => load(win)), timeoutMs, 'page load');
      return win;
    } catch (err) {
      lastErr = err;
      try { win.destroy(); } catch (_) { /* already gone */ }
    }
  }
  throw new Error(`page load failed after ${attempts} attempts: ${lastErr && lastErr.message}`);
}

module.exports = { loadWithRetry };
