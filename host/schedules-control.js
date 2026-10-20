'use strict';
/**
 * One host's side of the Schedules panel (BACKLOG #119 A7). The model is host/schedules.js; this file is what keeps it between hosts.
 *
 * Every host is one session, and the panel lists EVERY session's scheduled work, so the hosts share one install-wide file,
 * `.harness/state/schedules.json`:
 *
 *   { version: 1, sessions: { [hostKey]: { key, cwd, label, pid, updatedAt, endedAt, rows } } }
 *
 * A host writes ONLY its own entry (inside the store's cross-process lock) and reads all of them; a watch on the file
 * (host/wand-watch.js, in host.js) tells it when another host wrote. The list is REGENERABLE (a wakeup is back the next time its session
 * schedules one), so a corrupt file is replaced; a file that merely could not be read just now (the antivirus holds it for a moment) is
 * left alone and the next event tries again. The panel always shows this host's own rows from memory, so an unwritable file never blanks
 * the session you are looking at.
 *
 * LIVENESS. A host that exits cleanly marks its entry `endedAt`. One that dies does not, so a host with rows refreshes `updatedAt` on a
 * heartbeat (beat(), every ~30 s) and a neighbour treats three silent minutes as "ended". Either way the rows are dimmed "session ended"
 * and dropped ten minutes later (host/schedules.js buildView), and any write prunes the entries that are already past that.
 * A host with NOTHING scheduled keeps no entry at all: an idle session costs no file traffic.
 *
 * AFTER A RESTART (start()): only this host's DURABLE cron jobs come back, because only those survive in the CLI itself
 * (.claude/scheduled_tasks.json). A wakeup or a session-only cron job died with the session it was scheduled in.
 *
 * The frames: hello carries `schedules: payload()`; every change is `{ type: 'schedules', schedules: payload }`, broadcast to every
 * window of this host; a window may ask `{ type: 'schedules' }` (when the panel opens) and gets the same frame back.
 */

const { createSessionSchedule, buildView, ENDED_DROP_MS, ENDED_STALE_MS } = require('./schedules');

const STORE_KEY = 'schedules';
const VERSION = 1;
const CONTROL_TYPE = 'schedules';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The Pre and Post of CronCreate / CronDelete: events only this feature asked for (host/settings-writer.js CRON_MATCHER). The host feeds
 * them here and goes no further: the mood engine would read the tool as work. (ScheduleWakeup's belong to the bedtime flag, isBedtimeOnly.)
 */
function isSchedulesOnly(ev) {
  return isObj(ev) && (ev.event === 'PreToolUse' || ev.event === 'PostToolUse')
    && isObj(ev.payload) && (ev.payload.tool_name === 'CronCreate' || ev.payload.tool_name === 'CronDelete');
}

/** An entry other hosts left that is already past the point buildView would drop it. */
function pastDropping(entry, now) {
  if (!isObj(entry)) return true;
  let endedAt = null;
  if (isNum(entry.endedAt)) endedAt = entry.endedAt;
  else if (isNum(entry.updatedAt)) endedAt = entry.updatedAt + ENDED_STALE_MS;
  else return true;
  return now - endedAt > ENDED_DROP_MS;
}

function createSchedulesControl({ store, key, cwd = null, label = () => '', now = Date.now, emit = () => {}, nightView = () => null, log = () => {} } = {}) {
  if (!store) throw new Error('createSchedulesControl: store is required');
  if (typeof key !== 'string' || key === '') throw new Error('createSchedulesControl: key is required');

  const model = createSessionSchedule({ now });
  let told = null;                 // JSON of the list the windows of THIS host were last told
  let loggedFailure = false;
  let ended = false;

  const say = (line) => { try { log(line); } catch { /* a logger must never stop the host */ } };

  /** { ok, sessions }: ok:false means "could not read it just now" (never overwrite), a corrupt file reads as empty. */
  function readFile() {
    let state;
    try { state = store.readState(STORE_KEY); } catch (err) { state = { status: 'unreadable', error: err }; }
    if (!state || state.status === 'unreadable') return { ok: false, sessions: {} };
    if (state.status === 'ok' && isObj(state.value) && isObj(state.value.sessions)) return { ok: true, sessions: state.value.sessions };
    return { ok: true, sessions: {} };               // missing, corrupt, or the wrong shape
  }

  function nightFor() {
    let v = null;
    try { v = nightView(); } catch { v = null; }
    return isObj(v) && isNum(v.startedAt)
      ? { startedAt: v.startedAt, wakes: isNum(v.wakes) ? v.wakes : 0, prs: isNum(v.prs) ? v.prs : null }
      : null;
  }

  function ownRows() {
    return model.rows().map(r => (r.kind === 'bedtime' ? { ...r, night: nightFor() } : r));
  }

  function ownEntry(at) {
    let name = '';
    try { name = String(label() || ''); } catch { name = ''; }
    return { key, cwd, label: name, pid: process.pid, updatedAt: at, endedAt: null, rows: ownRows() };
  }

  /** Write (or remove) this host's entry. Returns whether the file now says what memory says. */
  function persist({ markEnded = false } = {}) {
    const at = now();
    const rows = ownRows();
    try {
      return store.withLock(STORE_KEY, () => {
        const cur = readFile();
        if (!cur.ok) return false;
        const sessions = {};
        for (const [k, e] of Object.entries(cur.sessions)) if (k !== key && !pastDropping(e, at)) sessions[k] = e;
        if (rows.length > 0) {
          const mine = ownEntry(at);
          sessions[key] = markEnded ? { ...mine, endedAt: at } : mine;
        }
        const same = JSON.stringify(sessions) === JSON.stringify(cur.sessions);
        if (!same) store.write(STORE_KEY, { version: VERSION, sessions });
        return true;
      }) === true;
    } catch (err) {
      if (!loggedFailure) { loggedFailure = true; say(`[schedules] could not save: ${err && err.message ? err.message : err}`); }
      return false;
    }
  }

  /** The list the windows should see: every host's entry from the file, with this host's own taken from memory. */
  function currentView() {
    const at = now();
    const entries = {};
    const cur = readFile();
    for (const [k, e] of Object.entries(cur.sessions)) if (k !== key && isObj(e)) entries[k] = e;
    if (!ended) {
      const mine = ownEntry(at);
      if (mine.rows.length > 0) entries[key] = mine;
    } else if (isObj(cur.sessions[key])) {
      entries[key] = cur.sessions[key];
    }
    return buildView(entries, at);
  }

  const payload = () => {
    try { return currentView(); } catch (err) { say(`[schedules] view failed: ${err && err.message ? err.message : err}`); return buildView({}, now()); }
  };
  const frameOf = (view) => ({ type: 'schedules', schedules: view });

  /** Tell the windows when the list differs from what they were last told. */
  function announce() {
    const view = payload();
    const text = JSON.stringify(view);
    if (text === told) return false;
    told = text;
    try { emit(frameOf(view)); } catch { /* a bad listener must never wedge the hook handler */ }
    return true;
  }

  function start() {
    try {
      const cur = readFile();
      const mine = cur.sessions[key];
      if (isObj(mine)) model.restore(mine.rows);
    } catch { /* restoring is best effort */ }
    persist();
    told = JSON.stringify(payload());
  }

  /** One hook event. Returns whether this session's schedule changed. */
  function event(ev) {
    let changed = false;
    try { changed = model.handle(ev); } catch (err) { say(`[schedules] event failed: ${err && err.message ? err.message : err}`); }
    if (changed) { persist(); announce(); }
    return changed;
  }

  /** The night's PR count (or anything else the rows borrow) moved: rewrite this host's rows and tell the windows. */
  function touch() {
    if (model.rows().length === 0) return false;
    persist();
    return announce();
  }

  /** The heartbeat: keeps a host with rows "alive" for its neighbours, follows a branch rename, and moves "in 23 min" along. */
  function beat() {
    if (!ended && model.rows().length > 0) persist();
    announce();
  }

  /** A watched write by another host: the frame for this host's windows, or null when nothing they show has changed. */
  function changed() {
    let view;
    try { view = currentView(); } catch { return null; }
    const text = JSON.stringify(view);
    if (text === told) return null;
    told = text;
    return frameOf(view);
  }

  /** A clean exit: neighbours see "session ended" at once instead of after three silent minutes. */
  function end() {
    if (ended) return;
    persist({ markEnded: true });
    ended = true;
  }

  const handles = (type) => type === CONTROL_TYPE;
  const reply = () => frameOf(payload());

  return { start, event, touch, beat, changed, end, payload, handles, reply };
}

module.exports = { createSchedulesControl, isSchedulesOnly, STORE_KEY, CONTROL_TYPE };
