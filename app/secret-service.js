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
  // WHICH PROJECT THIS WINDOW IS. Every vault call carries it, so a window can
  // only ever see and reveal secrets scoped to its own project, plus the ones
  // explicitly marked shared. Supplied once by main.js rather than passed in
  // from the renderer: a scope the window could choose is not a scope.
  //
  // NO DEFAULT. Dexter, PR #40, Finding 1, counterexample 1: with `project`
  // defaulting to null, `createSecretService({ vault, clipboard })` produced a
  // service whose every add stored a SHARED secret while the user left the box
  // unticked. A default here is a silent grant, so there is none -- the
  // constructor refuses instead, like the two above it.
  project,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  clearAfterMs = CLIPBOARD_CLEAR_MS,
} = {}) {
  if (!vault) throw new Error('createSecretService: vault is required');
  if (!clipboard) throw new Error('createSecretService: clipboard is required');
  if (typeof project !== 'string' || !project.trim()) {
    throw new Error('createSecretService: project is required -- secrets are scoped to one');
  }

  let pendingClear = null;
  let lastCopied = null;

  // --- the lock ---------------------------------------------------------------
  //
  // Thin on purpose: every decision lives in the vault, where it is tested. The
  // service's whole job here is to be the one place that catches a throw and
  // turns it into something the renderer can render, because an unhandled
  // rejection across the bridge shows the user nothing at all.
  //
  // The PASSWORD crosses the bridge inward, which is unavoidable -- the user
  // types it in the window. Nothing ever crosses back out: the derived key
  // stays in the vault's closure, in main.
  // FAILS CLOSED. Dexter F6 / Miguel A2, found independently.
  //
  // This used to answer `{hasKey: false, locked: false}` -- which is not merely
  // a guess, it is the MOST PERMISSIVE of the four states. Fed to
  // `vaultLockDisplay` it yields `open-no-key`, `showList: true`, and the note
  // "no key set, anyone at this machine can read the vault", about a vault whose
  // state we just failed to determine.
  //
  // `app/main.js` already answers an unauthorized sender `{hasKey: true,
  // locked: true}`. Two layers of one path had opposite doctrines, and the inner
  // one was the permissive one. Now they agree.
  //
  // Neither reviewer could construct a live throw today, and both said so:
  // `vault.lockState()` is a pure read over a `state` that is always an object.
  // It goes live the moment it grows anything that can throw -- the cross-process
  // staleness re-read contemplated in secret-vault.js, for one.
  function lockState() {
    try { return vault.lockState(); }
    catch { return { hasKey: true, locked: true, count: null }; }
  }

  function setKey(key) {
    // `failed` carries the entries a rekey could not carry (Dexter F3). It must
    // reach the window: those are secrets that survived but did not move, and
    // the user is the only one who can decide what to do about them.
    try { const r = vault.setKey(key); return { ok: true, failed: (r && r.failed) || [] }; }
    catch (err) { return { ok: false, error: err.message }; }
  }

  function unlock(key) {
    // Deliberately not an exception path: a wrong key is an ordinary event, not
    // a failure, and the caller needs to tell the two apart.
    //
    // THREE OUTCOMES now, not two (Dexter F1). A damaged lock header must not
    // reach the user as "wrong key", because the only other thing the panel
    // offers is melt -- and melting a vault whose header is damaged destroys
    // secrets that are still wrapped under a key the user may well have.
    try {
      const r = vault.unlock(key);
      if (r && r.ok) return { ok: true };
      if (r && r.damaged) return { ok: false, damaged: true, error: r.error };
      return { ok: false, wrongKey: true };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  function lock() {
    try { return { ok: vault.lock() === true }; }
    catch (err) { return { ok: false, error: err.message }; }
  }

  function removeKey() {
    try { const r = vault.removeKey(); return { ok: !!(r && r.ok), failed: (r && r.failed) || [] }; }
    catch (err) { return { ok: false, error: err.message }; }
  }

  function melt() {
    // `leftovers` are copies melt could not delete (Dexter F2). Reported rather
    // than swallowed: the vault IS gone so melt succeeded, but the promise the
    // user was shown -- no backup, no recovery -- is not true until those are
    // gone too, and only they can remove them.
    try { const r = vault.melt(); return { ok: !!(r && r.ok), leftovers: (r && r.leftovers) || [] }; }
    catch (err) { return { ok: false, error: err.message }; }
  }

  function available() {
    try { return !!vault.available(); } catch { return false; }
  }

  function list({ query } = {}) {
    let entries;
    try { entries = vault.list({ project }); } catch { return []; }
    const q = String(query || '').trim().toLowerCase();
    if (!q) return entries;
    // Labels and notes only. Matching secret VALUES would put a secret on
    // screen for a typo, and the person typing would not know they had.
    return entries.filter(e =>
      String(e.label || '').toLowerCase().includes(q) ||
      String(e.note || '').toLowerCase().includes(q));
  }

  function add({ label, secret, note, shared } = {}) {
    try {
      return { ok: true, entry: vault.add({ label, secret, note, project, shared }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function remove(id) {
    try { return { ok: !!vault.remove(id, { project }) }; } catch (err) { return { ok: false, error: err.message }; }
  }

  function reveal(id) {
    const secret = vault.get(id, { project });
    if (secret == null) return { ok: false, error: 'not found or could not be decrypted' };
    return { ok: true, secret };
  }

  function copy(id) {
    const secret = vault.get(id, { project });
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

  return { available, list, add, remove, reveal, copy,
    lockState, setKey, unlock, lock, removeKey, melt };
}

module.exports = { createSecretService };
