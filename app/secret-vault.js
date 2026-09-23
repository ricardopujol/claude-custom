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
const { normalizeProjectPath, samePath } = require('../host/project-path');
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

  // THE DERIVED KEY, IN MEMORY ONLY.
  //
  // Ricardo's threat model: "in case he has to leave his computer and someone
  // could enter the vault." His own `melt` requirement is what makes this real
  // cryptography rather than a UI gate -- melt only makes sense when there is
  // genuinely no way back, and a UI gate is always recoverable by editing a
  // file.
  //
  // So the password derives a key that WRAPS the ciphertext safeStorage has
  // already produced. Two layers, both required: the OS keyring binds the file
  // to this user account, the password binds it to this person. Someone who
  // copies the file gets neither.
  //
  // This variable is the only place the key ever exists. It is never written,
  // never derivable from anything stored, and never crosses to the renderer.
  // That is why the vault relocks on restart -- not a policy, just the absence
  // of anywhere for it to survive. Ricardo chose that over staying open across
  // launches, knowing the trade.
  let sessionKey = state.lock ? null : undefined;

  // `undefined` = no key has ever been set (open by default).
  // `null`      = a key exists and we do not have it (locked).
  // Buffer      = a key exists and we hold it (open).
  const isLocked = () => sessionKey === null;
  const hasKey = () => !!state.lock;

  function deriveKey(password, saltB64) {
    // scrypt, not a bare hash: the cost parameter is what makes guessing the
    // password expensive, and a vault key is exactly the thing worth guessing.
    return crypto_.scryptSync(String(password), Buffer.from(saltB64, 'base64'), 32);
  }

  // Wraps/unwraps the safeStorage ciphertext with the derived key. AES-GCM so
  // a wrong key FAILS rather than returning plausible garbage -- which is what
  // lets `unlock` answer honestly instead of guessing.
  function wrap(buf, key) {
    const iv = crypto_.randomBytes(12);
    const c = crypto_.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }

  function unwrap(b64, key) {
    const all = Buffer.from(b64, 'base64');
    const d = crypto_.createDecipheriv('aes-256-gcm', key, all.subarray(0, 12));
    d.setAuthTag(all.subarray(12, 28));
    return Buffer.concat([d.update(all.subarray(28)), d.final()]);
  }

  // Re-wraps every entry from one key to another. `from`/`to` are a key or
  // null meaning "safeStorage only". Used by setKey, removeKey and rekey --
  // one function, so the three cannot disagree about the format.
  function rewrapAll(from, to) {
    return state.entries.map((e) => {
      const raw = from ? unwrap(e.secret, from) : Buffer.from(e.secret, 'base64');
      return { ...e, secret: to ? wrap(raw, to) : raw.toString('base64') };
    });
  }

  function requireOpen(what) {
    if (isLocked()) throw new Error(`the vault is locked: ${what} needs it open`);
  }

  function lockState() {
    return { hasKey: hasKey(), locked: isLocked() };
  }

  /** Set the first key, or replace an existing one. Requires the vault open. */
  function setKey(password) {
    requireOpen('setting a key');
    const pw = String(password == null ? '' : password);
    if (!pw) throw new Error('a key is required');

    const salt = crypto_.randomBytes(16).toString('base64');
    const next = deriveKey(pw, salt);
    const entries = rewrapAll(sessionKey || null, next);

    // The verifier is what lets `unlock` tell a wrong key from a right one
    // without decrypting anything real. It is a known constant under the same
    // key, so a wrong password fails its auth tag and answers honestly.
    const check = wrap(Buffer.from('claude-custom vault'), next);
    const nextState = { ...state, entries, lock: { salt, check } };
    persist(nextState);
    state = nextState;
    sessionKey = next;
  }

  /** Try to open a locked vault. Returns whether it worked; never throws. */
  function unlock(password) {
    if (!hasKey()) return true;                 // nothing to open
    if (!isLocked()) return true;               // already open
    let candidate;
    try {
      candidate = deriveKey(password, state.lock.salt);
      const proof = unwrap(state.lock.check, candidate).toString('utf8');
      if (proof !== 'claude-custom vault') return false;
    } catch {
      // A wrong key fails the auth tag. It must not damage anything: a wrong
      // guess is not permission to destroy what it could not read.
      return false;
    }
    sessionKey = candidate;
    return true;
  }

  /** Close an open vault. Deliberately does NOT need the key. */
  function lock() {
    if (!hasKey()) return false;
    sessionKey = null;                          // stepping away must be one click
    return true;
  }

  /** Destroy the key, leaving the vault permanently open with secrets intact. */
  function removeKey() {
    requireOpen('destroying the key');
    if (!hasKey()) return false;
    const entries = rewrapAll(sessionKey, null);
    const { lock: _dropped, ...rest } = state;
    const nextState = { ...rest, entries };
    persist(nextState);
    state = nextState;
    sessionKey = undefined;
    return true;
  }

  /**
   * The only way back from a forgotten key, and it is honest about the cost:
   * every secret is gone. Not archived, not recoverable. It exists because the
   * alternative to an irreversible lock is a lock that was never real.
   */
  function melt() {
    const nextState = { format: FORMAT, entries: [] };
    persist(nextState);
    state = nextState;
    sessionKey = undefined;
    return true;
  }


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
   *
   * WHAT THIS STILL DOES NOT SOLVE, named here so it is not rediscovered as a
   * bug (Miguel): `commit` spreads the IN-MEMORY state, which may be stale if
   * a second app instance wrote the vault since `load()`. Last writer wins
   * across processes. Pre-existing and out of scope for the retry, but this is
   * the exact line someone would be looking at when they hit it.
   */
  function commit(nextEntries) {
    const next = { ...state, entries: nextEntries };
    persist(next);
    state = next;
  }

  // `candidate` is REQUIRED, deliberately. Miguel: a default of `state` is the
  // dangerous one -- a future bare `persist()` would silently restore "write
  // whatever memory currently holds", which is the exact mental model F1
  // removed.
  //
  // This guard is UNREACHABLE through the public API and cannot be tested
  // (Mortimer measured its mutant as equivalent for exactly that reason):
  // `persist` is a closure with one caller, `commit`, which always passes a
  // candidate. It is a tripwire for the next editor of this file, not a
  // runtime check -- said plainly, because an earlier version of this comment
  // asked for a test that cannot be written.
  function persist(candidate) {
    if (!candidate) throw new Error('persist: a candidate state is required');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    // Write-and-rename: a crash mid-write leaves the old vault intact rather
    // than a truncated one, which would be every secret gone instead of none.
    const tmp = path.join(dir, `.secrets-${process.pid}-${Date.now()}.tmp`);
    if (onWrite) onWrite(tmp);
    // The WRITE is inside the try as well as the rename. Miguel, review of the
    // fixed branch: wrapping only the rename left a writeFileSync failure --
    // ENOSPC, a quota, a transient EACCES -- abandoning a partially written
    // temp, which is the same leak Dexter's Finding 9 was about, through the
    // other door.
    try {
      // 0o600 is near-inert on Windows -- Node honours only the read-only bit
      // there -- so it is right on POSIX and documents intent, and the threat
      // model must not lean on it on this machine (Miguel). DPAPI binding the
      // ciphertext to the logged-in user is what actually carries the weight.
      fs.writeFileSync(tmp, JSON.stringify(candidate), { mode: 0o600 });
      // Retried: on Windows the rename fails with EPERM / EACCES / EBUSY while
      // anything holds a handle for a moment, and the antivirus scan of the
      // file just written routinely does. MEASURED against this very file on
      // 2026-09-18. It still THROWS if the rename never lands -- returning the
      // entry while the file was never replaced would tell the user a secret
      // is stored when it is not. See host/atomic-write.js.
      renameWithRetry(tmp, file);
    } catch (err) {
      // BEST EFFORT, and deliberately described as such. Each abandoned temp
      // holds the WHOLE vault, and only the `secret` field is encrypted, so
      // every one is a readable copy of every label and note -- with a
      // millisecond in its name, so they accumulate.
      //
      // But this cleanup is most likely to fail under exactly the condition
      // that triggers it: the rename failed because something holds a handle
      // on the temp, and unlinkSync on a held handle fails the same way. So
      // this reduces the leak, it does not close it, and claiming otherwise
      // would be the kind of comment that stops the next person looking.
      //
      // What IS guaranteed is that a failed cleanup never replaces the error
      // the caller needs to see.
      try { fs.unlinkSync(tmp); } catch { /* nothing more we can do about it */ }
      throw err;
    }
    if (onWrite) onWrite(file);
  }

  function available() {
    try { return !!crypto.isEncryptionAvailable(); } catch { return false; }
  }

  function add({ label, secret, note, project, shared } = {}) {
    // Fail closed. Storing plaintext because the OS keyring is unavailable is
    // the one outcome that must never happen quietly: the user believes it is
    // encrypted, since that is the entire point of the feature.
    if (!available()) {
      throw new Error('encryption is unavailable on this machine; refusing to store a secret in plaintext');
    }
    // Same fail-closed shape, one layer out: writing while locked would need
    // the key we do not have, so it refuses rather than storing something the
    // user could never read back.
    requireOpen('storing a secret');
    const cleanLabel = String(label == null ? '' : label).trim();
    if (!cleanLabel) throw new Error('a label is required: the list is all labels');
    const value = String(secret == null ? '' : secret);
    if (!value) throw new Error('a secret is required');

    // SCOPE, and THE TWO NULLS. Dexter, PR #40, Finding 1.
    //
    // `normalizeProjectPath` returns null for two different things: "shared"
    // and "I cannot use this input". Every reader below fails CLOSED on that
    // null -- visibleFrom, get and remove all treat it as deny-unless-shared.
    // This line used to read it as an INTENTION, so one value meant
    // deny-everything in three places and grant-everyone here.
    //
    // Measured: add({ project: '   ', shared: false }) stored a secret
    // readable from every project on the machine, with the box unticked. And
    // it is reachable through the real wiring -- main.js takes PROJECT_CWD
    // from CLAUDE_CUSTOM_CWD, and a single space is truthy.
    //
    // A scope that cannot be determined is not a scope. Refuse, the way
    // available() already refuses to store plaintext when the cipher is gone:
    // the one outcome that must never happen quietly is the user believing a
    // secret is contained when it is not.
    const scope = shared === true ? null : normalizeProjectPath(project);
    if (shared !== true && scope === null) {
      throw new Error(
        'refusing to store a secret with no scope: pass a usable project, ' +
        'or mark it shared deliberately');
    }
    const entry = {
      id: crypto_.randomUUID(),
      label: cleanLabel,
      note: String(note == null ? '' : note).trim(),
      // safeStorage first, then the key layer when the vault has one. Both
      // are required to read it back.
      secret: sessionKey
        ? wrap(Buffer.from(crypto.encryptString(value)), sessionKey)
        : Buffer.from(crypto.encryptString(value)).toString('base64'),
      createdAt: Date.now(),
      project: scope,
    };
    commit([...state.entries, entry]);
    return { id: entry.id, label: entry.label, note: entry.note, createdAt: entry.createdAt };
  }

  // What the window renders. The secret is not in it, by construction.
  // Is this entry visible from `project`?
  //
  // An entry with NO `project` key predates scoping and is treated as shared.
  // Narrowing those retroactively would make secrets vanish from projects that
  // rely on them -- a disappearance the user cannot debug, to fix a problem
  // they never saw.
  //
  // `project: null` is stored deliberately and means the same thing: shared.
  function visibleFrom(entry, project) {
    const scope = entry.project === undefined ? null : entry.project;
    if (scope === null) return true;
    return samePath(scope, project);
  }

  function list({ project } = {}) {
    // A LABEL IS A SECRET. "client-x prod database" tells a passerby who the
    // client is and that there is a production database, without revealing
    // one character of the value. A locked vault shows nothing.
    if (isLocked()) return [];
    return state.entries
      .filter(e => visibleFrom(e, project))
      .map(e => ({
        id: e.id,
        label: e.label,
        note: e.note || '',
        createdAt: e.createdAt || 0,
        // Said out loud. The original defect was that scope was INVISIBLE; a
        // shared secret that does not announce itself is the same surprise in
        // a new place.
        shared: (e.project === undefined ? null : e.project) === null,
      }));
  }

  // Scope is enforced HERE, not only in `list`. The renderer asks by id, so a
  // window for one project could otherwise reveal another project's secret by
  // replaying an id it should never have had.
  function get(id, { project } = {}) {
    if (isLocked()) return null;
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return null;
    if (!visibleFrom(entry, project)) return null;
    try {
      const stored = sessionKey
        ? unwrap(entry.secret, sessionKey)
        : Buffer.from(entry.secret, 'base64');
      return crypto.decryptString(stored);
    } catch {
      // One unreadable entry must not take the others with it: partial loss
      // beats total loss, and the caller can tell the user which one broke.
      return null;
    }
  }

  function remove(id, { project } = {}) {
    // Deleting what you cannot see is the same harm as reading it, one step on.
    if (isLocked()) return false;
    // Same enforcement as `get`: without it a window could delete a secret it
    // is not allowed to see.
    const target = state.entries.find(e => e.id === id);
    if (!target || !visibleFrom(target, project)) return false;
    const before = state.entries.length;
    const next = state.entries.filter(e => e.id !== id);
    if (next.length === before) return false;
    commit(next);
    return true;
  }

  return { add, list, get, remove, available, file,
           lockState, setKey, unlock, lock, removeKey, melt };
}

module.exports = { createVault, CLIPBOARD_CLEAR_MS };
