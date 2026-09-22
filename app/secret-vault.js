'use strict';
/**
 * Local secret store — passwords, keys, tokens.
 *
 * Lives in the MAIN process on purpose. The host owns the pty, so a secret that
 * never reaches the host cannot be written into the session by any accident of
 * wiring. That is structural rather than careful, which is the only kind of
 * guarantee worth having here.
 *
 * Encrypted at rest through Electron's safeStorage -- DPAPI on Windows, so the
 * file is bound to the logged-in user and useless on another machine. The
 * cipher is injected so this is testable without Electron.
 *
 * ONLY the secret is encrypted. Labels and notes stay readable: they have to be
 * listed and searched, and encrypting them would buy nothing while turning
 * every render into a decrypt storm.
 *
 * Deliberately NOT stored through store.js, which writes plain JSON.
 *
 * THE LIMIT THIS CANNOT ESCAPE: anything pasted into a session is written to
 * ~/.claude/projects/<project>/<session>.jsonl in plaintext, permanently. This
 * makes a secret easy to REACH; it cannot make pasting one into a session safe.
 * That is a property of the transcript, not of this file.
 */

const fs = require('fs');
const path = require('path');
const crypto_ = require('crypto');
const { renameWithRetry } = require('../host/atomic-write');

// Long enough to switch windows and paste; short enough that a key is not still
// sitting on the clipboard an hour later.
const CLIPBOARD_CLEAR_MS = 30000;

const FORMAT = 1;

function createVault({ file, crypto, onWrite } = {}) {
  if (!file) throw new Error('createVault: file is required');
  if (!crypto) throw new Error('createVault: crypto is required');

  let state = load();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { format: FORMAT, entries: [] };    // a missing vault is an empty one
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) throw new Error('shape');
      return parsed;
    } catch (err) {
      // Never overwrite what cannot be read: replacing it with an empty vault
      // would delete every secret in it to fix a display problem.
      throw new Error(`secret vault at ${file} is unreadable, refusing to replace it: ${err.message}`);
    }
  }

  /**
   * Write a CANDIDATE state, and only let memory agree with disk once it lands.
   *
   * Dexter, logic review 2026-09-21, Finding 1. Every mutation used to update
   * `state` first and persist second, so a rename that never landed left the
   * two disagreeing: `add` threw and reported the failure, while `list`, `get`,
   * `reveal` and `copy` all went on serving a secret that was not on disk --
   * until a restart took it away. That is precisely the harm this module's
   * docstring names, the user believing it is safe to discard the original,
   * and the retry only made it rarer.
   *
   * Worse, the divergence persisted: the NEXT successful write flushed it, so
   * an operation the user had been told failed completed later, unannounced.
   *
   * Passing the candidate through means the failure path cannot leave anything
   * behind to be committed by accident -- there is no partial state to roll
   * back, because nothing was assigned in the first place.
   */
  function commit(nextEntries) {
    const next = { ...state, entries: nextEntries };
    persist(next);
    state = next;
  }

  function persist(candidate = state) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    // Write-and-rename: a crash mid-write leaves the old vault intact rather
    // than a truncated one, which would be every secret gone instead of none.
    const tmp = path.join(dir, `.secrets-${process.pid}-${Date.now()}.tmp`);
    if (onWrite) onWrite(tmp);
    fs.writeFileSync(tmp, JSON.stringify(candidate), { mode: 0o600 });
    // Retried: on Windows the rename fails with EPERM / EACCES / EBUSY while
    // anything holds a handle for a moment, and the antivirus scan of the
    // file just written routinely does. MEASURED against this very file on
    // 2026-09-18. It still THROWS if the rename never lands -- returning the
    // entry while the file was never replaced would tell the user a secret is
    // stored when it is not. See host/atomic-write.js.
    try {
      renameWithRetry(tmp, file);
    } catch (err) {
      // Dexter, Finding 9. The temp name carries a millisecond, so it is unique
      // per failure and nothing ever collects them. Each one holds the WHOLE
      // vault, and only the `secret` field is encrypted -- so every abandoned
      // temp is a readable copy of every label and note. Cleaned on the way
      // out, and the original error is still what the caller sees.
      try { fs.unlinkSync(tmp); } catch { /* nothing more we can do about it */ }
      throw err;
    }
    if (onWrite) onWrite(file);
  }

  function available() {
    try { return !!crypto.isEncryptionAvailable(); } catch { return false; }
  }

  function add({ label, secret, note } = {}) {
    // Fail closed. Storing plaintext because the OS keyring is unavailable is
    // the one outcome that must never happen quietly: the user believes it is
    // encrypted, since that is the entire point of the feature.
    if (!available()) {
      throw new Error('encryption is unavailable on this machine; refusing to store a secret in plaintext');
    }
    const cleanLabel = String(label == null ? '' : label).trim();
    if (!cleanLabel) throw new Error('a label is required: the list is all labels');
    const value = String(secret == null ? '' : secret);
    if (!value) throw new Error('a secret is required');

    const entry = {
      id: crypto_.randomUUID(),
      label: cleanLabel,
      note: String(note == null ? '' : note).trim(),
      secret: Buffer.from(crypto.encryptString(value)).toString('base64'),
      createdAt: Date.now(),
    };
    commit([...state.entries, entry]);
    return { id: entry.id, label: entry.label, note: entry.note, createdAt: entry.createdAt };
  }

  // What the window renders. The secret is not in it, by construction.
  function list() {
    return state.entries.map(e => ({
      id: e.id,
      label: e.label,
      note: e.note || '',
      createdAt: e.createdAt || 0,
    }));
  }

  function get(id) {
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return null;
    try {
      return crypto.decryptString(Buffer.from(entry.secret, 'base64'));
    } catch {
      // One unreadable entry must not take the others with it: partial loss
      // beats total loss, and the caller can tell the user which one broke.
      return null;
    }
  }

  function remove(id) {
    const before = state.entries.length;
    const next = state.entries.filter(e => e.id !== id);
    if (next.length === before) return false;
    commit(next);
    return true;
  }

  return { add, list, get, remove, available, file };
}

module.exports = { createVault, CLIPBOARD_CLEAR_MS };
