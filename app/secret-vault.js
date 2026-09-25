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
      secret: Buffer.from(crypto.encryptString(value)).toString('base64'),
      createdAt: Date.now(),
      project: scope,
    };
    commit([...state.entries, entry]);
    return { id: entry.id, label: entry.label, note: entry.note, createdAt: entry.createdAt };
  }

  // Is this entry visible from `project`?
  //
  // An entry with NO `project` key predates scoping and is treated as shared.
  // Narrowing those retroactively would make secrets vanish from projects that
  // rely on them -- a disappearance the user cannot debug, to fix a problem
  // they never saw.
  //
  // `project: null` is stored deliberately and means the same thing: shared.
  // ONE definition of the rule, deliberately. Miguel, PR #40, A4: this line and
  // the `shared` flag in `list` both carried `e.project === undefined ? null :
  // e.project`, written out twice. One decides VISIBILITY, the other decides
  // what the marker SAYS -- so if they ever drifted, the marker would lie about
  // exactly the thing it exists to announce. That is this branch's founding
  // defect, reintroduced by copy-paste.
  function scopeOf(entry) {
    return entry.project === undefined ? null : entry.project;
  }

  function visibleFrom(entry, project) {
    const scope = scopeOf(entry);
    if (scope === null) return true;
    return samePath(scope, project);
  }

  function list({ project } = {}) {
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
        shared: scopeOf(e) === null,
      }));
  }

  // Scope is enforced HERE, not only in `list`. The renderer asks by id, so a
  // window for one project could otherwise reveal another project's secret by
  // replaying an id it should never have had.
  function get(id, { project } = {}) {
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return null;
    if (!visibleFrom(entry, project)) return null;
    try {
      return crypto.decryptString(Buffer.from(entry.secret, 'base64'));
    } catch {
      // One unreadable entry must not take the others with it: partial loss
      // beats total loss, and the caller can tell the user which one broke.
      return null;
    }
  }

  function remove(id, { project } = {}) {
    // Same enforcement as `get`: without it a window could delete a secret it
    // is not allowed to see.
    const target = state.entries.find(e => e.id === id);
    if (!target || !visibleFrom(target, project)) return false;

    // FILTER BY IDENTITY, NOT BY ID. Dexter, PR #40, F5: `filter(e => e.id !== id)`
    // authorized ONE entry and deleted EVERY entry carrying that id. With two
    // entries sharing an id under different projects, a window scoped to the
    // first passes the guard above and destroys the second -- a secret it was
    // never allowed to see, with `remove` returning true and nothing raised.
    //
    // Duplicate ids cannot arise through this API (`randomUUID` at add-time),
    // so this is not reachable today. It needs a hand-edited vault, a restored
    // `secrets.enc` from another install, or a future sync feature -- which is
    // exactly the sort of thing this file will grow. Identity is correct
    // however the duplicate arrived, and costs nothing.
    //
    // The old `before`/`next.length` equality check went with it: `target` was
    // found by id, so the filter always removed at least one and the guard was
    // unreachable. Dead code that reads as load-bearing (Miguel, suggestions).
    commit(state.entries.filter(e => e !== target));
    return true;
  }

  return { add, list, get, remove, available, file };
}

module.exports = { createVault, CLIPBOARD_CLEAR_MS };
