'use strict';
/**
 * The bug vault: one record per distinct bug CLASS, structured so a recurring
 * defect category is a visible COUNT rather than something hand-carried
 * between review rounds in PR comments and chat transcripts.
 *
 * WHY THIS EXISTS. This project runs a mandatory multi-agent review gate --
 * four reviewer agents, dozens of findings a round. Today those findings live
 * nowhere durable: they are read once, fixed (or not), and the next session
 * starts cold. The vault is where a finding goes to keep meaning something
 * after the PR that produced it merges.
 *
 * See GAMIFICATION_DESIGN.md, section 4 ("Bug vault"), for the spec. The
 * generated creature portrait per bug class it describes is explicitly OUT of
 * scope here -- the forge pipeline is in use elsewhere right now -- and the
 * emoji placeholder rule (also in that doc) covers the gap until that lands.
 *
 * PATTERN, NOT LOG. A flat list of "bugs found" is a changelog; grouping by
 * category is what turns it into a pattern a team can act on -- "six of our
 * last ten defects are silent-failure exit codes" is a process finding, "bug
 * #47 was a silent failure" is not. `groupByCategory` and `detectionBreakdown`
 * exist because the doc is explicit that the point is patterns surfacing, not
 * a bigger list.
 *
 * ABSENCE, AGAIN. A bug entered without a `detectedBy` must not be folded into
 * "reading the code" or any other real method just because that method is
 * common -- that would credit a method for work it never did. It gets its own
 * `null` bucket in `detectionBreakdown`, same principle as `usage-display.js`
 * and `career-display.js`: an unknown is a different fact from a zero.
 *
 * PERSISTENCE. Through `host/store.js`, under the `vault` key -- the file
 * `.harness/state/vault.json` the shared-foundation section of the design doc
 * already named. One file per concern, same as every other feature; this
 * module invents no format of its own.
 */

const STORE_KEY = 'vault';

function trimmedOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

let seq = 0;
function makeId(now) {
  // Time plus a per-process counter, not a random string: good enough for a
  // locally-persisted list nobody else writes to concurrently, and it sorts
  // roughly by creation order for free.
  return `bug_${now}_${(seq++).toString(36)}`;
}

/**
 * Validate and normalize one bug report into a stored record.
 *
 * Returns `{ ok, record }` or `{ ok: false, error }` -- never throws on bad
 * input, because this is the function a form submission runs through, and a
 * thrown error has nowhere good to land on that path. Same shape as
 * `host/seats.js`'s `addSeat`.
 */
function createRecord(input, { now = Date.now } = {}) {
  const category = trimmedOrNull(input && input.category);
  const summary = trimmedOrNull(input && input.summary);

  // Refused rather than defaulted to "uncategorised": a bug filed nowhere in
  // particular contributes to no pattern, which is the one thing this feature
  // exists to surface.
  if (!category) return { ok: false, error: 'a bug needs a category — the class it belongs to' };
  if (!summary) return { ok: false, error: 'a bug needs a one-line summary' };

  const t = now();
  const record = {
    id: makeId(t),
    category,
    summary,
    whereFound: trimmedOrNull(input && input.whereFound),
    detectedBy: trimmedOrNull(input && input.detectedBy),
    survived: trimmedOrNull(input && input.survived),
    wouldHaveCaught: trimmedOrNull(input && input.wouldHaveCaught),
    // Strict `=== true`, not truthiness. A checkbox's stray string value ("false"
    // is truthy) must not flip a bug to fixed -- the same coercion trap as
    // `Number(null) === 0`, one type over.
    fixed: (input && input.fixed) === true,
    foundAt: trimmedOrNull(input && input.foundAt) || new Date(t).toISOString(),
    fixedAt: null,
  };
  if (record.fixed) {
    record.fixedAt = trimmedOrNull(input && input.fixedAt) || new Date(t).toISOString();
  }
  return { ok: true, record };
}

/**
 * Group records by category, most frequent first -- that ordering IS the
 * feature: "six bugs found by measurement, none by reading" only reads as a
 * fact if the biggest group is not buried under insertion order.
 */
function groupByCategory(bugs) {
  const list = Array.isArray(bugs) ? bugs : [];
  const map = new Map();
  for (const b of list) {
    if (!b || typeof b.category !== 'string' || !b.category) continue;
    if (!map.has(b.category)) map.set(b.category, []);
    map.get(b.category).push(b);
  }
  return [...map.entries()]
    .map(([category, items]) => ({
      category,
      total: items.length,
      fixed: items.filter(b => b.fixed).length,
      unfixed: items.filter(b => !b.fixed).length,
      bugs: items,
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

/**
 * How bugs are actually being FOUND, across every category. This is the
 * counterpart grouping the design doc calls out by name: "six bugs found by
 * measurement, none by reading" is a statement about detection method, not
 * category, and needs its own tally to be visible at all.
 */
function detectionBreakdown(bugs) {
  const list = Array.isArray(bugs) ? bugs : [];
  const map = new Map();
  let unknown = 0;
  for (const b of list) {
    if (!b) continue;
    const key = trimmedOrNull(b.detectedBy);
    if (!key) { unknown++; continue; }
    map.set(key, (map.get(key) || 0) + 1);
  }
  const out = [...map.entries()]
    .map(([detectedBy, count]) => ({ detectedBy, count }))
    .sort((a, b) => b.count - a.count || a.detectedBy.localeCompare(b.detectedBy));
  // Appended last and kept as an explicit `null` row rather than folded into a
  // real method or silently dropped -- an unrecorded detection method is a gap
  // in the vault's own data and worth seeing as one.
  if (unknown) out.push({ detectedBy: null, count: unknown });
  return out;
}

// Seed data already earned in this session (GAMIFICATION_DESIGN.md, section 4)
// -- each one an incident this project actually paid for, entered through the
// same validator as anything typed into the add form. An empty vault on day
// one would teach a feature built specifically to show patterns nothing at
// all.
const SEED_BUGS = [
  {
    category: 'silent failure exit code',
    summary: 'exit 0 masking a failure',
    whereFound: 'forge tuning pipeline (tune.py, piped through a trailing tail)',
    detectedBy: 'reading the actual output rather than trusting the exit code',
    survived: 'one full tuning run before the real failure was noticed',
    wouldHaveCaught: 'asserting on the exit code of the piped command directly, not the tail it fed into',
    fixed: true,
  },
  {
    category: 'rendering regression',
    summary: 'WebGL breaking terminal transparency',
    whereFound: "renderer.js (xterm's WebGL addon vs. the per-project background art)",
    detectedBy: 'reading the rendered output',
    survived: 'until the background-art feature was first looked at in a real window',
    wouldHaveCaught: 'a real-window screenshot check on any change touching the WebGL addon',
    fixed: true,
  },
  {
    category: 'event loop blocked by a synchronous spawn',
    summary: 'spawnSync blocking the event loop and corrupting a benchmark',
    whereFound: 'hook bridge latency benchmark (verify/measure-hook-latency.js)',
    detectedBy: 'measurement — an in-process client scored 12/12 against spawned clients scoring 4/12, isolating the bridge rather than the helper',
    survived: 'one full benchmark run, reported as 4/35 delivery before being caught',
    wouldHaveCaught: 'running the bridge in its own process from the start, matching production',
    fixed: true,
  },
  {
    category: 'third-party API shape change silently accepted',
    summary: 'a transformers 5.x API change silently discarding every generated state',
    whereFound: 'forge identity gate (get_image_features)',
    detectedBy: 'a runtime crash (AttributeError) after every state had already been generated',
    survived: 'the whole generation run — every state was produced then thrown away before the crash surfaced',
    wouldHaveCaught: "checking the returned shape against both API versions before trusting it, rather than assuming last year's shape still held",
    fixed: true,
  },
  {
    category: 'token-limit truncation dropping load-bearing text',
    summary: 'CLIP truncation collapsing four states into one',
    whereFound: 'forge portrait pipeline (CLIP text encoder, 77-token limit)',
    detectedBy: 'measurement — counting prompt tokens per agent against the real appearances file',
    survived: "four of eight agents' portraits, each losing a different amount of the shared art direction, until measured",
    wouldHaveCaught: 'counting prompt tokens before generation, not after',
    fixed: true,
  },
  {
    category: 'prompt vocabulary register desaturating every render',
    summary: 'photographic vocabulary desaturating thirteen consecutive images',
    whereFound: 'forge art-direction style block (shot / lighting / background phrasing)',
    detectedBy: 'measurement — mean HSV saturation across renders, isolated component by component',
    survived: 'every rendered agent, until saturation was measured rather than judged by eye',
    wouldHaveCaught: 'measuring saturation before writing one art direction into every prompt at once',
    fixed: true,
  },
];

/**
 * The persisted vault: read/write through `host/store.js`, never a file of
 * its own -- the whole point of the shared store is that a corrupt vault costs
 * only this feature, and this module gets that for free by using it.
 */
function createBugVault({ store, now = Date.now } = {}) {
  if (!store) throw new Error('createBugVault: store is required');

  /**
   * Dexter F1. This used to read `store.read(KEY, null)` and treat null as
   * first run -- but null is what that call returns for a corrupt file too, so
   * a vault damaged by a partial write or a disk error was SEEDED OVER and the
   * records were gone, with nothing said to the user.
   *
   * Seeding is the destructive branch, so it gets the narrow condition:
   * `missing` and nothing else. Every other outcome returns an error and
   * leaves the file exactly as it was, for a person to look at. This is the
   * only store consumer whose contents cannot be regenerated, which is what
   * makes "start fresh" the wrong default here and the right one everywhere
   * else in store.js.
   */
  function load() {
    const state = store.readState(STORE_KEY);

    if (state.status === 'ok') {
      if (state.value && Array.isArray(state.value.bugs)) return { bugs: state.value.bugs };
      // Parsed, and not a vault. Still somebody's file: "the wrong shape" is
      // not "nothing is there".
      return { bugs: [], error: 'the vault file parsed but holds no bug list; it was left untouched' };
    }

    if (state.status !== 'missing') {
      return { bugs: [], error: `the vault file is ${state.status} and was left untouched` };
    }

    // Nothing there. Seed with what this project has already earned, written
    // back immediately so it happens exactly once -- a later empty list (the
    // user cleared it) is a valid `{ bugs: [] }` and is never reseeded.
    const seeded = { bugs: SEED_BUGS.map(s => createRecord(s, { now }).record) };
    try {
      store.write(STORE_KEY, seeded);
    } catch (err) {
      // Dexter F2. This write runs on the ATTACH path, and the handshake that
      // calls it has no catch above it, so a throw here used to take the host
      // and the pty with it. It reports EMPTY rather than handing back the
      // seeds it holds in memory: PR #30's secret vault shipped exactly that
      // lie -- serving records a failed write never stored -- and this is the
      // same lie in a different panel.
      return { bugs: [], error: `could not create the vault file: ${err && err.message}` };
    }
    return seeded;
  }

  function list() {
    return load().bugs;
  }

  function add(input) {
    const result = createRecord(input, { now });
    if (!result.ok) return result;
    const data = load();
    // Writing one record over a damaged vault finishes the destruction the
    // seeding path was just stopped from doing.
    if (data.error) return { ok: false, error: data.error };
    data.bugs = [...data.bugs, result.record];
    try {
      store.write(STORE_KEY, data);
    } catch (err) {
      return { ok: false, error: `could not write the vault: ${err && err.message}` };
    }
    return { ok: true, record: result.record };
  }

  function setFixed(id, fixed) {
    // Dexter F5. `fixedAt: fixed === true ? now : null` fails closed for the
    // FLAG -- nothing truthy-but-not-true can mark a bug fixed -- but the
    // `null` on the other side was unconditional, so `setFixed(id)` with no
    // second argument silently cleared a recorded fix date. "Reopen this bug"
    // and "you forgot to say" are different instructions, and this is the one
    // store holding records nobody will retype.
    if (fixed !== true && fixed !== false) {
      return { ok: false, error: `setFixed: fixed must be true or false, got ${JSON.stringify(fixed)}` };
    }
    const data = load();
    if (data.error) return { ok: false, error: data.error };
    let found = null;
    data.bugs = data.bugs.map((b) => {
      if (!b || b.id !== id) return b;
      found = {
        ...b,
        fixed,
        // Cleared, not left standing, on an EXPLICIT reopen -- a bug marked
        // unfixed must not still claim a fixedAt from a previous round. Only
        // reachable with a real `false` now, never with an absent argument.
        fixedAt: fixed ? new Date(now()).toISOString() : null,
      };
      return found;
    });
    if (!found) return { ok: false, error: `no bug with id ${id}` };
    try {
      store.write(STORE_KEY, data);
    } catch (err) {
      return { ok: false, error: `could not write the vault: ${err && err.message}` };
    }
    return { ok: true, record: found };
  }

  function summary() {
    const data = load();
    const bugs = data.bugs;
    // The error travels with the numbers. An empty list on its own is a claim
    // that the user has recorded nothing, which is a different statement from
    // "the vault could not be read" -- the absence-reported-as-zero bug this
    // project keeps catching, one panel over.
    return {
      total: bugs.length,
      byCategory: groupByCategory(bugs),
      byDetection: detectionBreakdown(bugs),
      error: data.error || null,
    };
  }

  /**
   * What the attach handshake sends. Dexter F2.
   *
   * TOTAL BY CONSTRUCTION -- this is the one call in the vault whose caller
   * has no catch above it. `host.js` builds the `hello` frame inside
   * `wss.on('connection')`, outside `handleFrame`'s try, and the host owns the
   * pty; an exception escaping here kills the running Claude session. Because
   * it is on the attach path, the failure shape is "every window you open
   * kills the session", not "one feature is broken".
   *
   * Everything above already returns errors rather than raising them, so this
   * catch should be unreachable. It is here anyway: the promise that a future
   * store implementation never throws is not one this call can afford to
   * depend on, and store.test.js already states the rule -- one feature's
   * state must not be able to take the session down.
   */
  function payload() {
    try {
      return { bugs: list(), summary: summary() };
    } catch (err) {
      return {
        bugs: [],
        summary: {
          total: 0, byCategory: [], byDetection: [],
          error: `the vault could not be read: ${err && err.message}`,
        },
      };
    }
  }

  return { list, add, setFixed, summary, payload };
}

/**
 * Route one `bugvault` control frame to the vault. Dexter, PR #29 review, F4.
 *
 * THIS USED TO BE AN IF-CHAIN INSIDE host.js's `dispatchControl`, with
 * `result` initialised to `{ ok: true }` and reassigned only by the branches
 * that recognised the action. Any other action fell through untouched and was
 * broadcast with `error: null` -- a success reply for work that never
 * happened, in the one function whose whole job is deciding what is ours.
 * Fail-open in a gatekeeper.
 *
 * It lives here for the reason every drawing decision lives in
 * app/*-display.js: inline in host.js it cannot be tested without a live pty,
 * and "what are this feature's actions?" is the vault's question anyway.
 *
 * The inputs are NOT pre-coerced. host.js used to pass
 * `(msg.record && typeof msg.record === 'object') ? msg.record : {}`, which
 * turns a malformed frame into an empty one and reports the validator's
 * "category is required" instead of "that was not a record". `createRecord`
 * already refuses a non-object; handing it the raw value keeps the refusal
 * honest about what was wrong.
 */
function applyVaultAction(vault, msg) {
  const action = msg && msg.action;
  if (action === 'add') return vault.add(msg.record);
  if (action === 'setFixed') return vault.setFixed(msg.id, msg.fixed);
  return { ok: false, error: `unknown vault action ${JSON.stringify(action)}` };
}

module.exports = {
  createRecord, groupByCategory, detectionBreakdown, createBugVault, applyVaultAction, SEED_BUGS,
};
