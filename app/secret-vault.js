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

// KEY DERIVATION, PINNED AND VERSIONED. Miguel, PR #42, A4.
//
// These were Node's scryptSync defaults, which are scrypt's 2009 minimum:
// N=16384 measured at 26ms on this machine, about 38 guesses per second per
// core for anyone who walks off with the file. 2^17 measures ~200ms, which is
// nothing for an action a human performs by hand.
//
// Pinned because this project has shipped unpinned constants three times
// (STALL_MS, ROSTER_SHARE) and because a silent change to Node's defaults would
// make every existing vault unopenable, with melt as the only way out.
//
// VERSIONED because parameters that live only in code cannot be raised later:
// doing so walls off every vault created before the change. So they are written
// into the lock record and read back when deriving. `maxmem` has to rise with
// N -- the default 32MB is not enough at 2^17 with r=8, and scryptSync throws.
const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 });

// What a vault written before A4 used. A lock record with no params is one of
// those, and must keep opening.
const SCRYPT_LEGACY = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, maxmem: 32 * 1024 * 1024 });

// The abandoned-temp name, in one place. `persist` writes it and `melt` sweeps
// for it; two spellings would mean melt silently stopping finding them.
const TEMP_PREFIX = '.secrets-';
const TEMP_SUFFIX = '.tmp';

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHECK_PLAINTEXT = 'claude-custom vault';

/**
 * The lock header is damaged -- as distinct from "the password is wrong".
 *
 * Dexter, PR #42, F1, the finding he said to fix first. `unlock` used one catch
 * over derivation, unwrap and comparison, so a truncated verifier or a missing
 * salt returned exactly what a wrong password returns: `false`. The user is then
 * told "that key does not open this vault" while holding the correct key, and
 * the only other thing the panel offers is melt -- which permanently destroys
 * secrets that were still wrapped under a recoverable key.
 *
 * Distinguishing the two is the whole point. A wrong password means try again;
 * a damaged header means DO NOT MELT, because the data is probably still there.
 */
/**
 * A checksum over the lock record, so damage is detectable WITHOUT the password.
 *
 * This is the part of F1 that shape-checking alone cannot reach, and finding out
 * why took a failing test. AES-GCM's authentication tag has exactly one failure
 * mode: "this did not decrypt under this key." It cannot tell a wrong password
 * from a corrupted ciphertext, because from the cipher's point of view those are
 * the same event. So truncating `lock.check` by four base64 characters still
 * lands in the auth-tag branch, and the correct password still reads as wrong.
 *
 * A digest over the record fixes that, because it does not involve the password
 * at all: if `check` no longer matches what was written beside it, the record is
 * damaged, whoever is typing.
 *
 * NOT A SECURITY CONTROL, and it must not be described as one. Anyone who can
 * edit the file can recompute this. It detects ACCIDENTAL damage -- a torn
 * write, a truncated sync, a bad restore -- which is precisely the case where
 * the user holds the right key and would otherwise be told to melt.
 *
 * Tamper-resistance would need the digest bound to the derived key, and that
 * cannot work here: it would have to be verified before we know the password is
 * right, which is the thing being decided.
 */
function lockFingerprint(lock) {
  return crypto_.createHash('sha256')
    .update(`${lock.salt}|${lock.check}|${JSON.stringify(lock.scrypt || null)}`)
    .digest('base64');
}

class LockHeaderDamaged extends Error {
  constructor(why) {
    super(`the vault's lock header is damaged (${why}) -- this is NOT a wrong key, `
      + 'and melting would destroy secrets that may still be recoverable');
    this.name = 'LockHeaderDamaged';
    this.damaged = true;
  }
}

/**
 * Is this a lock record we can act on at all?
 *
 * Dexter F4 + Miguel B2(b). `load()` validated only that `entries` was an
 * array, and `sessionKey` was decided by the TRUTHINESS of `state.lock`. So
 * `"lock": 0` in the file -- a partial write, a hand edit, two schema versions
 * merged -- read as "no key", after which:
 *
 *   - the panel announced "no key set, anyone at this machine can read the
 *     vault" and listed every label, while every entry was still wrapped;
 *   - the next `setKey` wrapped the already-wrapped bytes a SECOND time,
 *     because `Buffer.from(b64, 'base64')` never throws on malformed input.
 *     Those entries are unreadable forever, silently.
 *
 * And Miguel's half: deleting the `lock` field outright reopened the vault and
 * listed every label and note, since both are stored in cleartext. The values
 * stayed safe, but the inventory did not.
 *
 * So a `lock` that is PRESENT must be well-formed or the file is refused, the
 * same way an unparseable file already is. Absent is fine -- that is a vault
 * with no key. Present-but-wrong is a damaged file, not an open vault.
 */
function validLockRecord(lock) {
  if (lock === undefined) return true;                      // no key, fine
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false;
  if (lock.fp !== undefined && typeof lock.fp !== 'string') return false;
  if (typeof lock.salt !== 'string' || typeof lock.check !== 'string') return false;
  if (Buffer.from(lock.salt, 'base64').length !== SALT_BYTES) return false;
  // A verifier must at least carry an IV and a tag, or it cannot be unwrapped.
  if (Buffer.from(lock.check, 'base64').length <= IV_BYTES + TAG_BYTES) return false;
  if (lock.scrypt !== undefined) {
    const s = lock.scrypt;
    if (!s || typeof s !== 'object') return false;
    for (const k of ['N', 'r', 'p', 'keylen']) {
      if (!Number.isInteger(s[k]) || s[k] <= 0) return false;
    }
  }
  return true;
}

function createVault({ file, crypto, onWrite, scrypt = SCRYPT } = {}) {
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
  // `!== undefined`, not truthiness. `load()` now refuses a malformed `lock`
  // outright, so this can only ever see a well-formed record or nothing -- but
  // the truthiness test was the actual mechanism of Dexter's F4, and leaving it
  // here would mean the fix depended entirely on a check one screen away.
  let sessionKey = state.lock !== undefined ? null : undefined;

  // The generation token this handle last saw on disk (F9). `undefined` when the
  // file does not exist yet, which is a legitimate starting point.
  let loadedGen = state.gen;

  // Read ONLY the token, and tolerate everything: a file that has gone missing,
  // become unreadable or stopped being JSON must not turn an ordinary write into
  // a crash. Any of those means the state we hold is no longer the file's, so
  // returning a value that cannot match is the right answer.
  function currentGen() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed.gen : null;
    } catch {
      // No file yet is the same as the fresh state we loaded; anything else
      // unreadable is a mismatch we must not write over.
      return fs.existsSync(file) ? Symbol('unreadable') : undefined;
    }
  }

  // `scrypt` is injectable for ONE reason: the real cost is ~200ms per
  // derivation by design, and a suite that unlocks dozens of times would spend
  // minutes proving nothing about the cost. Tests pass cheap parameters; the
  // real ones are pinned by their own test, and every vault writes whatever it
  // used into its own lock record, so a cheap test vault stays openable and can
  // never be mistaken for a real one.

  // `undefined` = no key has ever been set (open by default).
  // `null`      = a key exists and we do not have it (locked).
  // Buffer      = a key exists and we hold it (open).
  const isLocked = () => sessionKey === null;
  const hasKey = () => state.lock !== undefined;   // presence, not truthiness (F4)

  function deriveKey(password, saltB64, params) {
    // scrypt, not a bare hash: the cost parameter is what makes guessing the
    // password expensive, and a vault key is exactly the thing worth guessing.
    //
    // Miguel A4. The defaults were N=16384, r=8, p=1 -- scrypt's 2009 minimum,
    // measured at 26ms on this machine, about 38 guesses/second/core for anyone
    // who copies the file. Now pinned, named, and WRITTEN INTO THE LOCK RECORD,
    // because parameters that live only in code cannot be raised without
    // bricking every vault created before the change. A vault that predates
    // this carries no params and gets the old defaults, so it still opens.
    const p = { ...SCRYPT_LEGACY, ...(params || {}) };
    const salt = Buffer.from(String(saltB64 == null ? '' : saltB64), 'base64');
    if (salt.length !== SALT_BYTES) {
      // Not a wrong password -- a damaged header. F1 depends on telling these
      // apart, so this must not be swallowed by unlock's catch as "try again".
      throw new LockHeaderDamaged(`salt is ${salt.length} bytes, expected ${SALT_BYTES}`);
    }
    return crypto_.scryptSync(String(password), salt,
      p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: p.maxmem });
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
    // Too short to BE a wrapped value: this is a damaged record, not a wrong
    // key, and F1 turns on not confusing the two. Checked explicitly because
    // createDecipheriv on a short buffer throws something that reads like an
    // auth failure.
    if (all.length <= IV_BYTES + TAG_BYTES) {
      throw new LockHeaderDamaged(`wrapped value is ${all.length} bytes, too short to decrypt`);
    }
    const d = crypto_.createDecipheriv('aes-256-gcm', key, all.subarray(0, IV_BYTES));
    d.setAuthTag(all.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([d.update(all.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
  }

  // Re-wraps every entry from one key to another. `from`/`to` are a key or
  // null meaning "safeStorage only". Used by setKey, removeKey and rekey --
  // one function, so the three cannot disagree about the format.
  // PER-ENTRY TOLERANT, like every read path in this module. Dexter, PR #42, F3.
  //
  // This used `.map`, so the first throw aborted the whole call -- and one entry
  // with a truncated ciphertext (a torn write, a sync tool, a restored backup)
  // made `setKey` and `removeKey` throw FOREVER. The key became permanently
  // unchangeable and undestroyable, with a raw OpenSSL string rendered above the
  // melt button, which was the only thing the panel then offered.
  //
  // That contradicted this module's own stated principle, one screen down at
  // `get`: "One unreadable entry must not take the others with it: partial loss
  // beats total loss." The rule was right; this function was the exception.
  //
  // So a bad entry is REPORTED and CARRIED THROUGH UNCHANGED rather than
  // aborting the rekey. Carried, not dropped: silently discarding a secret to
  // fix a format problem is the disappearance this module refuses everywhere
  // else. The caller decides what to tell the user, and `remove(id)` still
  // works, so there is a way out that does not cost the other secrets.
  function rewrapAll(from, to) {
    const failed = [];
    const entries = state.entries.map((e) => {
      try {
        const raw = from ? unwrap(e.secret, from) : Buffer.from(e.secret, 'base64');
        return { ...e, secret: to ? wrap(raw, to) : raw.toString('base64') };
      } catch (err) {
        failed.push({ id: e.id, label: e.label, why: err.message });
        return e;
      }
    });
    return { entries, failed };
  }

  function requireOpen(what) {
    if (isLocked()) throw new Error(`the vault is locked: ${what} needs it open`);
  }

  // `count` is here because it is the only thing that makes melt a decision
  // rather than a slogan, and `list()` cannot supply it -- a locked vault
  // returns [] by design, which is correct and must stay that way.
  //
  // Dexter F5 / Miguel B3, found independently. A count is not a secret: it
  // reveals no label, no note and no value, and the user about to destroy it is
  // the owner. What it buys is the difference between "All 6 secrets in it are
  // destroyed permanently" and "Everything in it is destroyed permanently" --
  // and the second is the sentence this module was written to avoid.
  function lockState() {
    return { hasKey: hasKey(), locked: isLocked(), count: state.entries.length };
  }

  /** Set the first key, or replace an existing one. Requires the vault open. */
  function setKey(password) {
    requireOpen('setting a key');
    const pw = String(password == null ? '' : password);
    if (!pw) throw new Error('a key is required');

    const salt = crypto_.randomBytes(SALT_BYTES).toString('base64');
    const next = deriveKey(pw, salt, scrypt);
    const { entries, failed } = rewrapAll(sessionKey || null, next);

    // The verifier is what lets `unlock` tell a wrong key from a right one
    // without decrypting anything real. It is a known constant under the same
    // key, so a wrong password fails its auth tag and answers honestly.
    const check = wrap(Buffer.from(CHECK_PLAINTEXT), next);
    // `scrypt` rides in the record so the cost can be raised later without
    // walling off vaults written today (A4).
    const lock = { salt, check, scrypt: { ...scrypt } };
    lock.fp = lockFingerprint(lock);        // so damage is detectable without the key (F1)
    const nextState = { ...state, entries, lock };
    persist(nextState);
    state = nextState;
    sessionKey = next;
    return { ok: true, failed };
  }

  /**
   * Try to open a locked vault. Never throws; returns what went wrong.
   *
   * THREE OUTCOMES, NOT TWO. Dexter, PR #42, F1, the finding he said to fix
   * first, and he was right about why: the old version had one `catch` over
   * derivation, unwrap and comparison, and returned a bare `false` for all of
   * them. So `j.lock.check.slice(0, -4)` -- four characters off the verifier --
   * made the CORRECT password read as wrong, permanently, while every entry was
   * still wrapped under `deriveKey(K, salt)` and recoverable in six lines. The
   * only other button the panel offers is the irreversible one.
   *
   * The app was telling the user to melt a vault it could have opened.
   *
   * So: a wrong key is `{ ok: false, wrongKey: true }` -- ordinary, try again.
   * A damaged header is `{ ok: false, damaged: true }` with a reason, and the
   * caller must NOT offer melt as the remedy. Both still leave the vault
   * untouched; a failed guess is not permission to destroy what it could not
   * read.
   */
  function unlock(password) {
    if (!hasKey()) return { ok: true };          // nothing to open
    if (!isLocked()) return { ok: true };        // already open

    if (!validLockRecord(state.lock)) {
      return { ok: false, damaged: true, error: new LockHeaderDamaged('malformed lock record').message };
    }

    // The password-independent damage check. A vault written before this carries
    // no `fp` and skips it -- it still gets the shape checks and the auth tag,
    // which is exactly the behaviour it had, so an old vault is never newly
    // refused.
    if (state.lock.fp !== undefined && state.lock.fp !== lockFingerprint(state.lock)) {
      return {
        ok: false,
        damaged: true,
        error: new LockHeaderDamaged('the lock record does not match its own checksum').message,
      };
    }

    let candidate;
    try {
      candidate = deriveKey(password, state.lock.salt, state.lock.scrypt);
    } catch (err) {
      // Derivation cannot fail because of a wrong password -- scrypt accepts
      // any string. Anything thrown here is the header, not the guess.
      return { ok: false, damaged: true, error: err.message };
    }

    let proof;
    try {
      proof = unwrap(state.lock.check, candidate).toString('utf8');
    } catch (err) {
      // A GCM auth-tag failure on a well-formed verifier IS the wrong key --
      // that is the whole point of the verifier. Anything else is damage.
      if (err instanceof LockHeaderDamaged) return { ok: false, damaged: true, error: err.message };
      return { ok: false, wrongKey: true };
    }

    // Unwrapped cleanly but says the wrong thing: the key is right and the
    // verifier's CONTENT is not what we wrote. That is damage, not a wrong
    // guess, and it is the one case that cannot be reached by guessing.
    if (proof !== CHECK_PLAINTEXT) {
      return { ok: false, damaged: true, error: new LockHeaderDamaged('verifier content does not match').message };
    }

    sessionKey = candidate;
    return { ok: true };
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
    if (!hasKey()) return { ok: false, failed: [] };
    const { entries, failed } = rewrapAll(sessionKey, null);
    const { lock: _dropped, ...rest } = state;
    const nextState = { ...rest, entries };
    persist(nextState);
    state = nextState;
    sessionKey = undefined;
    return { ok: true, failed };
  }

  /**
   * The only way back from a forgotten key, and it is honest about the cost:
   * every secret is gone. Not archived, not recoverable. It exists because the
   * alternative to an irreversible lock is a lock that was never real.
   */
  function melt() {
    // ONLY FROM THE LOCKED SIDE. Miguel, PR #42, A5. `vaultLockDisplay` already
    // refuses to draw the button anywhere else, and there is a test for it --
    // but that is drawing POLICY, in the renderer, which is the least
    // trustworthy layer in the app. The harness's one irreversible action had
    // its only guard there.
    //
    // This is melt's declared purpose in its own docstring: the way back from a
    // FORGOTTEN key. An open vault never needs it -- destroy the key instead and
    // keep the secrets.
    if (!isLocked()) {
      throw new Error('melt is for a forgotten key: the vault is open, '
        + 'so destroy the key instead and keep the secrets');
    }

    const nextState = { format: FORMAT, entries: [] };
    persist(nextState);
    state = nextState;
    sessionKey = undefined;

    // AND THE COPIES. Dexter, PR #42, F2.
    //
    // melt used to write exactly one path, and the panel told the user in words
    // that there is "no backup and no recovery". That was not true. `persist`
    // writes a temp and renames it, and when all five rename attempts fail --
    // the Windows EPERM case measured against this very file on 2026-09-18 --
    // the cleanup unlink is best-effort by its own comment, and most likely to
    // fail under exactly the condition that caused it.
    //
    // What is left behind is `JSON.stringify` of the WHOLE vault: the lock, every
    // wrapped ciphertext, and every label and note IN CLEARTEXT, since only
    // `secret` is ever encrypted. So the user melts, is told nothing survives,
    // and the directory still holds the complete inventory plus ciphertext that
    // anyone who later learns the password can read.
    //
    // The existing test checked `readFileSync(file)` -- the one file guaranteed
    // clean, and none of the copies that are not.
    //
    // Reported rather than thrown: a leftover we could not remove must not make
    // melt look like it failed, because the main file IS gone and re-melting
    // will not help. The user needs to be told which file to delete by hand.
    const leftovers = sweepTemps();
    return { ok: true, leftovers };
  }

  // Every temp `persist` could have abandoned, matching the name it builds.
  function sweepTemps() {
    const dir = path.dirname(file);
    const stuck = [];
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return stuck;                    // cannot enumerate; nothing to promise
    }
    for (const name of names) {
      // Anchored on both ends, from the same constants persist writes with, so
      // this can never match the vault itself or an unrelated file.
      if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
      const full = path.join(dir, name);
      try {
        fs.unlinkSync(full);
      } catch (err) {
        stuck.push({ path: full, why: err.message });
      }
    }
    return stuck;
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
      // A `lock` field that is PRESENT must be well-formed. Dexter F4 /
      // Miguel B2(b): the old check validated `entries` only, and `sessionKey`
      // was decided by the truthiness of `state.lock` -- so `"lock": 0` read as
      // "no key", announced the vault as unprotected, listed every label, and
      // then double-wrapped every entry on the next setKey. Absent is fine, that
      // is a vault with no key. Present-but-wrong is a damaged file.
      if (!validLockRecord(parsed.lock)) throw new Error('lock record is malformed');
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
    // ONE definition of the temp's name, shared with `sweepTemps`. melt has to
    // find every copy this line can leave behind (Dexter F2), and two
    // independent spellings of the same pattern is how melt would silently stop
    // finding them after a rename here.
    const tmp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${Date.now()}${TEMP_SUFFIX}`);
    // REFUSE A WRITE ONTO A FILE THAT MOVED UNDER US. Dexter, PR #42, F9.
    //
    // `commit` spreads this process's in-memory `{ ...state }`, so a stale
    // instance's ordinary `add` rewrote the WHOLE file from what it last read.
    // Before the lock that cost one entry, and the note two screens up says
    // last-writer-wins was accepted for exactly that reason. The lock changes
    // the payload: a stale instance now writes the file back with NO `lock`
    // field and every entry unwrapped -- silently undoing a key it never held,
    // with both processes reporting success. On the next launch the vault opens
    // with no password and every label and secret readable.
    //
    // NOT FIXED WITH `app.requestSingleInstanceLock()`, which is what a review
    // of this branch alone would suggest. PR #41 (`--new`) SPAWNS A SECOND
    // ELECTRON PROCESS against the same project, on purpose, because Ricardo
    // asked for a second window in the same folder. A single-instance lock would
    // delete that feature to fix this. Two live instances are the intended
    // shape, so the vault has to be safe under them.
    //
    // `gen` is a token rewritten on every successful persist. We re-read it
    // immediately before replacing the file: if it is not the one we loaded,
    // another instance wrote in between and this write would erase their work.
    // Refuse, and say what to do -- the caller cannot merge two vaults and
    // neither can we.
    const onDisk = currentGen();
    if (onDisk !== loadedGen) {
      throw new Error('another window changed the vault since this one read it; '
        + 'reopen the secrets panel to pick up the change, then try again');
    }
    candidate.gen = crypto_.randomBytes(8).toString('hex');

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
      loadedGen = candidate.gen;        // our write is now the one on disk
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
        shared: scopeOf(e) === null,
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

  return { add, list, get, remove, available, file,
           lockState, setKey, unlock, lock, removeKey, melt };
}

module.exports = {
  createVault,
  CLIPBOARD_CLEAR_MS,
  // Exported so the tests can PIN them rather than restate them. Miguel A4:
  // a derivation parameter nobody asserts is a parameter that can move under
  // every existing vault, and this project has shipped three unpinned
  // constants already.
  SCRYPT,
  SCRYPT_LEGACY,
  SALT_BYTES,
  IV_BYTES,
  TAG_BYTES,
  TEMP_PREFIX,
  TEMP_SUFFIX,
  LockHeaderDamaged,
  validLockRecord,
};
