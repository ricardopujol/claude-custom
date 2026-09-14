'use strict';
/**
 * What the window is allowed to ask the vault for.
 *
 * Separate from main.js so these rules can be asserted without Electron. They
 * are the rules that decide whether a secret reaches somewhere it should not,
 * which makes them worth testing rather than reviewing.
 *
 * The window gets: labels, and actions. It does NOT get secret values, except
 * through reveal(), which exists because a value you can never see cannot be
 * checked against the service it belongs to.
 */

const { CLIPBOARD_CLEAR_MS } = require('./secret-vault');

function createSecretService({
  vault,
  clipboard,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  clearAfterMs = CLIPBOARD_CLEAR_MS,
} = {}) {
  if (!vault) throw new Error('createSecretService: vault is required');
  if (!clipboard) throw new Error('createSecretService: clipboard is required');

  let pendingClear = null;
  let lastCopied = null;

  function available() {
    try { return !!vault.available(); } catch { return false; }
  }

  function list({ query } = {}) {
    let entries;
    try { entries = vault.list(); } catch { return []; }
    const q = String(query || '').trim().toLowerCase();
    if (!q) return entries;
    // Labels and notes only. Matching secret VALUES would put a secret on
    // screen for a typo, and the person typing would not know they had.
    return entries.filter(e =>
      String(e.label || '').toLowerCase().includes(q) ||
      String(e.note || '').toLowerCase().includes(q));
  }

  function add({ label, secret, note } = {}) {
    try {
      return { ok: true, entry: vault.add({ label, secret, note }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function remove(id) {
    try { return { ok: !!vault.remove(id) }; } catch (err) { return { ok: false, error: err.message }; }
  }

  function reveal(id) {
    const secret = vault.get(id);
    if (secret == null) return { ok: false, error: 'not found or could not be decrypted' };
    return { ok: true, secret };
  }

  function copy(id) {
    const secret = vault.get(id);
    if (secret == null) return { ok: false, error: 'not found or could not be decrypted' };

    clipboard.writeText(secret);
    lastCopied = secret;

    // Cancel any previous clear first: the timer from an earlier copy would
    // otherwise fire against THIS secret and wipe it seconds after copying.
    if (pendingClear !== null) clearTimer(pendingClear);
    // unref'd: a pending clipboard wipe must not be a reason the app stays
    // alive, and in tests it must not hold the runner open for 30 seconds.
    const handle = setTimer(() => {
      pendingClear = null;
      // Only clear what we put there. Clearing unconditionally destroys
      // whatever the user copied in the meantime -- their work, lost to a
      // feature they were not using at the time.
      let current = '';
      try { current = clipboard.readText(); } catch { return; }
      if (current === lastCopied) clipboard.clear();
      lastCopied = null;
    }, clearAfterMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
    pendingClear = handle;

    // Deliberately does NOT return the secret. The window asked for a copy.
    return { ok: true, clearsInMs: clearAfterMs };
  }

  return { available, list, add, remove, reveal, copy };
}

module.exports = { createSecretService };
