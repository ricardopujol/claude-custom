'use strict';
/**
 * How much of the Max plan is left, and when it resets.
 *
 * Ricardo: "I want the meters of how much Claude from my max account I have
 * left until my reset (daily, weekly and fable)."
 *
 * DELIBERATELY SEPARATE FROM host/usage.js. That module answers "what has been
 * spent", counted from transcripts on disk. This one answers "how much is
 * left", which only the account knows. Different source, different failure
 * modes, no shared state -- and merging them would put a network call on the
 * path of a figure that must keep working offline.
 *
 * THE REQUEST DID NOT MATCH REALITY, and the endpoint was measured before any
 * of this was designed. There is NO daily window. The account reports:
 *
 *   session        a 5-HOUR rolling window        \
 *   weekly_all     the week                        > the three meters drawn
 *   weekly_scoped  the week, scoped to one model  /   (scope carries "Fable")
 *
 * Shipping a "daily" meter would have drawn a window that does not exist --
 * the same class of thing the display audit spent a day pulling out of the
 * career panel.
 *
 * THE SECOND MEASURED CONSTRAINT: `limit_dollars`, `used_dollars` and
 * `remaining_dollars` are all null on this plan. Percent and reset time are
 * the only magnitudes that exist, so they are the only ones this module
 * reports. Nothing here converts a percentage into tokens or dollars.
 *
 * WHY limits[] AND NOT THE TOP-LEVEL KEYS. The response also carries
 * `five_hour`, `seven_day`, and about a dozen null codenames (`tangelo`,
 * `nimbus_quill`, `iguana_necktie`...) that look like server-side flags
 * waiting to be switched on. `limits[]` is self-describing -- kind, group,
 * percent, resets_at, severity, scope -- and is the only form that can
 * express a model-scoped window at all. Reading it means a window Anthropic
 * adds later shows up on its own instead of needing a code change here.
 */

const fsp = require('fs/promises');
const path = require('path');
const { claudeConfigDir } = require('./claude-config-dir');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Percent-used rungs at which a window announces itself. Stated as a ladder
// rather than buried in a branch so the numbers are reviewable, and so a test
// can assert against them instead of restating them.
const QUOTA_THRESHOLDS = Object.freeze([80, 95]);

// Short labels, because these sit in a header strip beside a token counter.
// `weekly_scoped` is deliberately absent: its label comes from the API's own
// `scope.model.display_name`, so the Fable meter is not a hardcoded model
// name and follows the account if the scoping changes.
const KNOWN_LABELS = Object.freeze({
  session: '5h',
  weekly_all: 'week',
});

function defaultCredentialsPath() {
  return path.join(claudeConfigDir(), '.credentials.json');
}

// A readable label for a window we have no name for. Better than dropping the
// row: a window that exists and is not drawn is a limit the user cannot see
// coming.
function fallbackLabel(kind) {
  return String(kind || 'limit').replace(/_/g, ' ');
}

function labelFor(row) {
  const scoped = row && row.scope && row.scope.model && row.scope.model.display_name;
  if (scoped) return String(scoped);
  return KNOWN_LABELS[row && row.kind] || fallbackLabel(row && row.kind);
}

/**
 * The drawable windows, in the order the API returns them.
 *
 * Every row keeps its own identity (`key`) and its reset timestamp, because
 * the announcer keys its ladder on the pair -- see createQuotaAnnouncer.
 */
function normalizeWindows(body) {
  const rows = body && Array.isArray(body.limits) ? body.limits : [];
  return rows.map((row) => ({
    // The kind ALONE is not an identity. Two model-scoped weekly windows --
    // which the response already anticipates, carrying `seven_day_opus` as a
    // null waiting to be switched on -- would both be `weekly_scoped`, share
    // one announcer ladder, and silence each other. The scope is the only field
    // that tells them apart, so it belongs in the key.
    key: row.scope && row.scope.model && row.scope.model.display_name
      ? String(row.kind) + ':' + String(row.scope.model.display_name)
      : String(row.kind),
    label: labelFor(row),
    // Strictly a number: `Number(null)` is 0, so a coercing check would turn
    // a window the API could not report into one reading 0% used.
    percent: (typeof row.percent === 'number' && Number.isFinite(row.percent)) ? row.percent : null,
    resetsAt: row.resets_at || null,
    severity: row.severity || 'normal',
    isActive: row.is_active === true,
    // Present and null on purpose: this plan reports no money, and a caller
    // reading `undefined` cannot tell "no such field" from "not on this plan".
    usedDollars: null,
    remainingDollars: null,
    lockedReason: row.locked_reason || null,
  }));
}

/**
 * Read the account's current limits.
 *
 * Returns `{ ok, state, windows, error }` where `state` is:
 *
 *   fresh   read this tick.
 *   absent  we could not read it, and therefore know NOTHING. `windows` is
 *           empty -- never a set of windows at 0%, which would read as "you
 *           have used nothing" and is the exact opposite of unknown.
 *
 * There is deliberately no `stale` here: unlike a transcript total, a quota
 * figure has a reset time, so a held figure can be wrong in a way that a held
 * token count cannot. Holding is the CALLER's decision, made with the
 * timestamp in hand.
 */
async function readQuota({
  credentialsPath = defaultCredentialsPath(),
  fetchImpl = (...args) => fetch(...args),
  url = USAGE_URL,
} = {}) {
  let token;
  try {
    const raw = await fsp.readFile(credentialsPath, 'utf8');
    token = JSON.parse(raw).claudeAiOauth.accessToken;
  } catch (err) {
    // No credentials, unreadable, or not the shape we expect. All of them mean
    // the same thing to a caller: we do not know the numbers.
    return { ok: false, state: 'absent', windows: [], error: reason(err, 'no credentials') };
  }
  if (!token) {
    return { ok: false, state: 'absent', windows: [], error: 'no access token' };
  }

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return { ok: false, state: 'absent', windows: [], error: reason(err, 'request failed') };
  }

  if (!res || !res.ok) {
    // The status is worth carrying: a 401 means the token expired and Claude
    // Code will refresh it in the credentials file on its own -- the next read
    // picks that up. This module never attempts a refresh itself, because a
    // second writer to that file is a race nobody needs.
    return {
      ok: false, state: 'absent', windows: [],
      error: `usage endpoint returned ${res ? res.status : 'no response'}`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, state: 'absent', windows: [], error: reason(err, 'unparseable response') };
  }

  return { ok: true, state: 'fresh', windows: normalizeWindows(body), error: null };
}

// Never let an error object carry the token into a log line or a payload. The
// token is only ever in an Authorization header; this keeps it that way even
// if a future fetch implementation decides to quote the request in its error.
function reason(err, fallback) {
  const msg = err && err.message ? String(err.message) : fallback;
  return msg.length > 200 ? msg.slice(0, 200) : msg;
}

/**
 * Announces a window crossing a threshold -- once per window INSTANCE.
 *
 * THE TRAP THIS EXISTS TO AVOID. host/milestones.js announces a rung once and
 * refuses to celebrate downward:
 *
 *     if (highest && highest.at >= hit.at) return null;
 *
 * That is exactly right for lifetime token spend, which is MONOTONIC -- it
 * only ever grows. Quota percent is not: it climbs toward 100 and drops to
 * zero every five hours. Keyed on a global highest, "80% of your 5-hour
 * window" would announce once and then stay silent for the life of the
 * account.
 *
 * So the ladder is keyed on `key + resetsAt` -- the window INSTANCE. When the
 * window rolls over its `resets_at` changes, the old entry is dropped, and the
 * same rung can announce again for the new window. Within one instance a rung
 * still announces once, and a falling percentage still says nothing.
 */
function createQuotaAnnouncer() {
  // instanceKey -> highest threshold already announced for it.
  const announced = new Map();

  function check(windows) {
    if (!Array.isArray(windows)) return null;
    let hit = null;
    let hitInstance = null;

    for (const w of windows) {
      // STRICTLY a number. `Number('96')` is 96 and `Number(null)` is 0, and a
      // value the normaliser classifies as unknown must not announce anything.
      // This module bans that coercion by name three files over; it was using
      // it here.
      if (!w || typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue;

      // A window with NO reset time gets no ladder entry at all. Keying it on a
      // literal 'no-reset' collapsed every instance of that window onto one
      // entry that could never expire -- which is precisely the milestones.js
      // behaviour this function exists to escape, restored whenever the
      // discriminator happens to be missing. Better to risk announcing twice
      // than to go permanently silent.
      const instance = w.resetsAt ? `${w.key}@${w.resetsAt}` : null;

      const reached = QUOTA_THRESHOLDS.filter(t => w.percent >= t).pop();
      if (reached === undefined) continue;

      if (instance) {
        const already = announced.get(instance);
        if (already !== undefined && already >= reached) continue;
      }

      // The HIGHEST crossing in this batch wins, so one long turn that jumps
      // two rungs announces the rung it actually reached.
      if (!hit || reached > hit.threshold) {
        hit = {
          key: w.key,
          label: w.label,
          threshold: reached,
          percent: w.percent,
          resetsAt: w.resetsAt,
          text: `${w.label} usage at ${Math.round(w.percent)}%`,
        };
        hitInstance = instance;
      }
    }

    // RECORDED ONLY FOR WHAT IS ACTUALLY ANNOUNCED. Writing the ladder inside
    // the loop marked every crossing in the batch as announced and then
    // returned one of them -- so two windows crossing in the same 60s poll
    // meant the loser was recorded as told and never told, permanently. A
    // crossing that loses this round must resurface on the next one.
    if (hit && hitInstance) announced.set(hitInstance, hit.threshold);

    // NOT PRUNED ON ABSENCE. A window missing from one batch -- a partial
    // response, or `limits: []`, which readQuota reports as ok:true -- used to
    // delete its ladder, so the next poll re-announced a rung already
    // announced: absence rewriting memory. An entry is dropped only when that
    // window reappears under a NEW reset time, which is the only evidence that
    // the old instance is genuinely over.
    for (const w of windows) {
      if (!w || !w.resetsAt) continue;
      const prefix = `${w.key}@`;
      const live = `${w.key}@${w.resetsAt}`;
      for (const k of [...announced.keys()]) {
        if (k.startsWith(prefix) && k !== live) announced.delete(k);
      }
    }

    return hit;
  }

  return { check, state: () => new Map(announced) };
}

module.exports = {
  readQuota, normalizeWindows, createQuotaAnnouncer,
  QUOTA_THRESHOLDS, USAGE_URL, defaultCredentialsPath,
};
