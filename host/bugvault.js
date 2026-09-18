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

  function load() {
    const data = store.read(STORE_KEY, null);
    if (data && Array.isArray(data.bugs)) return data;
    // First run (or a corrupt file, which store.js already defaults to null):
    // seed with what this project has already earned. Written back immediately
    // so the seed happens exactly once -- a later empty list (the user cleared
    // it) is a valid `{ bugs: [] }` and is never reseeded.
    const seeded = { bugs: SEED_BUGS.map(s => createRecord(s, { now }).record) };
    store.write(STORE_KEY, seeded);
    return seeded;
  }

  function list() {
    return load().bugs;
  }

  function add(input) {
    const result = createRecord(input, { now });
    if (!result.ok) return result;
    const data = load();
    data.bugs = [...data.bugs, result.record];
    store.write(STORE_KEY, data);
    return { ok: true, record: result.record };
  }

  function setFixed(id, fixed) {
    const data = load();
    let found = null;
    data.bugs = data.bugs.map((b) => {
      if (!b || b.id !== id) return b;
      found = {
        ...b,
        fixed: fixed === true,
        // Cleared, not left standing, when reopened -- a bug marked unfixed
        // must not still claim a fixedAt from a previous round.
        fixedAt: fixed === true ? new Date(now()).toISOString() : null,
      };
      return found;
    });
    if (!found) return { ok: false, error: `no bug with id ${id}` };
    store.write(STORE_KEY, data);
    return { ok: true, record: found };
  }

  function summary() {
    const bugs = list();
    return { total: bugs.length, byCategory: groupByCategory(bugs), byDetection: detectionBreakdown(bugs) };
  }

  return { list, add, setFixed, summary };
}

module.exports = { createRecord, groupByCategory, detectionBreakdown, createBugVault, SEED_BUGS };
