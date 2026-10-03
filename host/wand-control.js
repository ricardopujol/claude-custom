'use strict';
/**
 * The host's side of the wand's protocol (BACKLOG #51), the same shape as host/loadout-control.js.
 *
 *   hello         carries `wand: payload()`
 *   wand-add      { emoji, skill, args }          client -> host
 *   wand-update   { id, patch: { emoji?, skill?, args? } }
 *   wand-delete   { id }
 *   wand-move     { id, to }                      `to` is the id's index in the resulting list
 *   wand-skills   (no fields)                     rescan the skill directories now (the module opened)
 *   wand          the answer, BROADCAST to every window
 *
 * The frame is `{ type:'wand', ok, reason, quiet?, status, favourites, unavailable, dropped, skills,
 * skillsError }`. `status` is wand.load()'s: 'ok' | 'missing' (the default set is showing) |
 * 'unavailable' (`favourites` is NULL and `unavailable` says why). A refusal is `ok:false` with a
 * `reason` and carries the TRUE current state, so a window that asked for something impossible redraws
 * from the truth.
 *
 * NO ANSWER FRAME IS EVER `quiet`; the watcher echoes (changed(), skillsChanged()) are, on purpose
 * (PR #64 N1): a refusal on screen must survive a refresh.
 *
 * AN EDIT NEVER WRITES OVER A FILE IT COULD NOT READ. Corrupt, unreadable, the wrong shape or a newer
 * version: refused with "nothing was changed", the file untouched. Only a MISSING file is written, and
 * then with the whole default set plus the edit, so the first edit persists what the user was looking at.
 *
 * THE FILE IS RE-READ ON EVERY MESSAGE, never cached, and the read-modify-write runs inside the store's
 * cross-process lock (`.harness/state` is install-wide and two hosts can be open): a cached copy would
 * erase the other window's edit, and a favourites list is typed by hand, unlike a regenerable belt. A
 * lock that cannot be taken is a refusal, never a crash.
 *
 * THE SKILL LIST (host/wand-skills.js) is cached and rescanned on a module open (`wand-skills`) and by
 * the debounced watch (skillsChanged()), not on every hello. A reader that throws is an EMPTY list with
 * `skillsError` set: the panel must not read "could not look" as "no such skill" and dim every button.
 */

const wand = require('./wand');

const STORE_KEY = 'wand';
// Every message type this control answers. host/control.js CONTROL_TYPES must list each, or the frame is
// typed into the pty as literal JSON (test/wand-wiring.test.js checks both lists against each other).
const WAND_TYPES = Object.freeze(['wand-add', 'wand-update', 'wand-delete', 'wand-move', 'wand-skills']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);


function createWandControl({ store, readSkills, log = () => {}, emit = null, retryMs = 250, maxRetries = 20 } = {}) {
  if (!store) throw new Error('createWandControl: store is required');
  if (typeof readSkills !== 'function') throw new Error('createWandControl: readSkills is required');

  // The last view that came from a READABLE file. A read that fails for a moment (the antivirus scan of a file
  // just renamed holds it, measured on this machine) must never put "unavailable" on a healthy panel, nor drop
  // an editor the user is typing in: while it is busy the windows keep this (Dexter D6).
  let lastGood = null;

  /** The file's state and what wand.load() makes of it. Never throws. */
  function snapshot() {
    let state;
    try {
      if (typeof store.readState === 'function') {
        state = store.readState(STORE_KEY);
      } else {
        const v = store.read(STORE_KEY, undefined);
        state = v === undefined ? { status: 'missing', value: null } : { status: 'ok', value: v };
      }
    } catch (error) {
      state = { status: 'unreadable', value: null, error };
    }
    const loaded = wand.load(state);
    if (!loaded.transient) lastGood = viewOf(loaded);
    return { state, loaded };
  }

  const fileName = (() => { try { return typeof store.pathOf === 'function' ? store.pathOf(STORE_KEY) : null; } catch { return null; } })();
  const viewOf = (loaded) => ({
    status: loaded.status, favourites: loaded.favourites, unavailable: loaded.status === 'unavailable' ? loaded.reason : null,
    dropped: loaded.dropped, file: fileName, retrying: !!loaded.transient,
  });
  /** What the windows should see for a snapshot: the last good view while the file is only busy. */
  const shown = (loaded) => (loaded.transient && lastGood ? lastGood : viewOf(loaded));

  // --- skills ---------------------------------------------------------------------------------------
  let skills = null;
  let skillsError = null;
  let toldSkills = '';
  // What is broken RIGHT NOW, logged once per breakage: a line is forgotten when it stops being true, so a
  // skill that is fixed and breaks again is said again (Miguel S4).
  let logged = new Set();
  function logScan(r) {
    const now = new Set();
    const say = (line) => { now.add(line); if (!logged.has(line)) log(line); };
    for (const s of Array.isArray(r && r.skipped) ? r.skipped : []) say(`[wand] skipped ${s.file}: ${s.reason}`);
    for (const u of Array.isArray(r && r.unread) ? r.unread : []) say(`[wand] could not read ${u.file}: ${u.reason}`);
    logged = now;
  }
  function scan() {
    try {
      const r = readSkills();
      skills = Array.isArray(r && r.skills) ? r.skills : [];
      logScan(r);
      // A source that exists but could not be read is NOT "no such skill": say so, and the panel dims nothing.
      const unread = Array.isArray(r && r.unread) ? r.unread : [];
      skillsError = unread.length === 0 ? null
        : `${unread[0].file}: ${unread[0].reason}${unread.length > 1 ? ` (and ${unread.length - 1} more)` : ''}`;
    } catch (err) {
      skills = [];
      skillsError = err && err.message ? err.message : 'unknown error';
    }
    toldSkills = JSON.stringify([skills, skillsError]);
  }
  const skillsView = () => { if (skills === null) scan(); return { skills, skillsError }; };

  // The state the windows of THIS host were last told about (hello, an answer, a watcher frame): what lets
  // changed() tell "another host wrote" from "nothing happened" and from "I wrote it myself".
  const key = (view) => JSON.stringify([view.status, view.favourites, view.unavailable, view.dropped]);
  let told = key(shown(snapshot().loaded));

  // A busy read is looked at again shortly, bounded: no further fs event is coming to say "look again".
  let retryTimer = null;
  let retries = 0;
  function scheduleRetry() {
    if (typeof emit !== 'function' || retryTimer !== null || retries >= maxRetries) return;
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      let f = null;
      try { f = changed(); } catch { /* the next event retries */ }
      if (f) { try { emit(f); } catch { /* a bad emitter must not kill the host */ } }
    }, retryMs);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  // Deliberately does NOT update `told`: a fresh window attaching learns the state, but the windows already
  // open have not, and changed() must still announce it to them.
  function payload() {
    const { loaded } = snapshot();
    if (loaded.transient) scheduleRetry();
    return { ...shown(loaded), ...skillsView() };
  }

  const frame = (fields) => ({ type: 'wand', ok: true, reason: null, ...fields });

  function changed() {
    let snap;
    try { snap = snapshot(); } catch { return null; }
    // A rename in flight can make the file unreadable for a moment on Windows: no frame now (the panel never
    // flashes "wand unavailable" for a write that is about to land), and a retry shortly, because the write's
    // own event has already come and gone (Dexter D6).
    if (snap.loaded.transient) { scheduleRetry(); return null; }
    retries = 0;
    const view = viewOf(snap.loaded);
    const k = key(view);
    if (k === told) return null;
    told = k;
    return frame({ quiet: true, ...view, ...skillsView() });
  }

  function skillsChanged() {
    const before = skills === null ? null : toldSkills;
    scan();
    if (before !== null && toldSkills === before) return null;
    let snap;
    try { snap = snapshot(); } catch { return null; }
    return frame({ quiet: true, ...shown(snap.loaded), ...skillsView() });
  }

  // --- edits ----------------------------------------------------------------------------------------
  const OPS = {
    'wand-add': (favs, m) => wand.add(favs, { emoji: m.emoji, skill: m.skill, args: m.args }),
    'wand-update': (favs, m) => (isObj(m.patch) ? wand.update(favs, m.id, m.patch)
      : { ok: false, favourites: favs, reason: 'Nothing to change.' }),
    'wand-delete': (favs, m) => wand.remove(favs, m.id),
    'wand-move': (favs, m) => wand.moveTo(favs, m.id, m.to),
  };

  const locked = (fn) => (typeof store.withLock === 'function' ? store.withLock(STORE_KEY, fn) : fn());

  /** The answer to one control message. Never throws. */
  function handle(msg) {
    const m = isObj(msg) ? msg : {};

    if (m.type === 'wand-skills') {
      scan();
      // A skills answer says nothing about the favourites: quiet, so it can never be mistaken for the answer to
      // an edit, and never carries a busy read's "unavailable" over a healthy panel.
      return frame({ quiet: true, ...shown(snapshot().loaded), ...skillsView() });
    }

    const truth = () => shown(snapshot().loaded);
    const refusal = (reason, view) => {
      const v = view || truth();
      told = key(v);                                     // the answer below carries this
      return frame({ ok: false, reason, ...v, ...skillsView() });
    };

    const op = Object.prototype.hasOwnProperty.call(OPS, m.type) ? OPS[m.type] : null;
    if (!op) return refusal('That is not a wand action.');

    let outcome;
    try {
      outcome = locked(() => {
        const { loaded } = snapshot();
        if (loaded.status === 'unavailable') return { blocked: shown(loaded), transient: loaded.transient, why: loaded.reason };
        // Favourites the file holds that did not load are text the user typed: an edit would write the kept ones
        // back and erase the rest for good. Refused instead, until the file is fixed (Dexter D2 / Miguel I1).
        if (loaded.dropped > 0) {
          const n = loaded.dropped;
          return { refused: `${n} favourite${n === 1 ? '' : 's'} in ${fileName || 'the wand file'} ${n === 1 ? "isn't" : "aren't"} valid, so editing is off and nothing was changed. Fix or remove ${n === 1 ? 'it' : 'them'} in the file.`, view: viewOf(loaded) };
        }
        const r = op(loaded.favourites, m);
        if (!r.ok) return { refused: r.reason, view: viewOf(loaded) };
        store.write(STORE_KEY, wand.serialize(r.favourites));
        return { done: { status: 'ok', favourites: r.favourites, unavailable: null, dropped: 0 } };
      });
    } catch (err) {
      return refusal(`Could not save the wand: ${err && err.message ? err.message : 'unknown error'}`);
    }

    if (outcome.blocked) {
      if (outcome.transient) {
        return refusal(`The wand file could not be read just now (${outcome.why}), so nothing was changed. Try again.`, outcome.blocked);
      }
      return refusal(`The wand is unavailable (${outcome.blocked.unavailable}), so nothing was changed.`, outcome.blocked);
    }
    if (outcome.refused !== undefined) return refusal(outcome.refused, outcome.view);
    told = key(outcome.done);
    return frame({ ...outcome.done, ...skillsView() });
  }

  const handles = (type) => WAND_TYPES.includes(type);

  return { payload, handle, changed, skillsChanged, handles };
}

module.exports = { createWandControl, STORE_KEY, WAND_TYPES };
