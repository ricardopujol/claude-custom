// @ts-nocheck
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
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const USAGE_URL = stryMutAct_9fa48("533") ? "" : (stryCov_9fa48("533"), 'https://api.anthropic.com/api/oauth/usage');

// Percent-used rungs at which a window announces itself. Stated as a ladder
// rather than buried in a branch so the numbers are reviewable, and so a test
// can assert against them instead of restating them.
const QUOTA_THRESHOLDS = Object.freeze(stryMutAct_9fa48("534") ? [] : (stryCov_9fa48("534"), [80, 95]));

// Short labels, because these sit in a header strip beside a token counter.
// `weekly_scoped` is deliberately absent: its label comes from the API's own
// `scope.model.display_name`, so the Fable meter is not a hardcoded model
// name and follows the account if the scoping changes.
const KNOWN_LABELS = Object.freeze(stryMutAct_9fa48("535") ? {} : (stryCov_9fa48("535"), {
  session: stryMutAct_9fa48("536") ? "" : (stryCov_9fa48("536"), '5h'),
  weekly_all: stryMutAct_9fa48("537") ? "" : (stryCov_9fa48("537"), 'week')
}));
function defaultCredentialsPath() {
  if (stryMutAct_9fa48("538")) {
    {}
  } else {
    stryCov_9fa48("538");
    return path.join(os.homedir(), stryMutAct_9fa48("539") ? "" : (stryCov_9fa48("539"), '.claude'), stryMutAct_9fa48("540") ? "" : (stryCov_9fa48("540"), '.credentials.json'));
  }
}

// A readable label for a window we have no name for. Better than dropping the
// row: a window that exists and is not drawn is a limit the user cannot see
// coming.
function fallbackLabel(kind) {
  if (stryMutAct_9fa48("541")) {
    {}
  } else {
    stryCov_9fa48("541");
    return String(stryMutAct_9fa48("544") ? kind && 'limit' : stryMutAct_9fa48("543") ? false : stryMutAct_9fa48("542") ? true : (stryCov_9fa48("542", "543", "544"), kind || (stryMutAct_9fa48("545") ? "" : (stryCov_9fa48("545"), 'limit')))).replace(/_/g, stryMutAct_9fa48("546") ? "" : (stryCov_9fa48("546"), ' '));
  }
}
function labelFor(row) {
  if (stryMutAct_9fa48("547")) {
    {}
  } else {
    stryCov_9fa48("547");
    const scoped = stryMutAct_9fa48("550") ? row && row.scope && row.scope.model || row.scope.model.display_name : stryMutAct_9fa48("549") ? false : stryMutAct_9fa48("548") ? true : (stryCov_9fa48("548", "549", "550"), (stryMutAct_9fa48("552") ? row && row.scope || row.scope.model : stryMutAct_9fa48("551") ? true : (stryCov_9fa48("551", "552"), (stryMutAct_9fa48("554") ? row || row.scope : stryMutAct_9fa48("553") ? true : (stryCov_9fa48("553", "554"), row && row.scope)) && row.scope.model)) && row.scope.model.display_name);
    if (stryMutAct_9fa48("556") ? false : stryMutAct_9fa48("555") ? true : (stryCov_9fa48("555", "556"), scoped)) return String(scoped);
    return stryMutAct_9fa48("559") ? KNOWN_LABELS[row && row.kind] && fallbackLabel(row && row.kind) : stryMutAct_9fa48("558") ? false : stryMutAct_9fa48("557") ? true : (stryCov_9fa48("557", "558", "559"), KNOWN_LABELS[stryMutAct_9fa48("562") ? row || row.kind : stryMutAct_9fa48("561") ? false : stryMutAct_9fa48("560") ? true : (stryCov_9fa48("560", "561", "562"), row && row.kind)] || fallbackLabel(stryMutAct_9fa48("565") ? row || row.kind : stryMutAct_9fa48("564") ? false : stryMutAct_9fa48("563") ? true : (stryCov_9fa48("563", "564", "565"), row && row.kind)));
  }
}

/**
 * The drawable windows, in the order the API returns them.
 *
 * Every row keeps its own identity (`key`) and its reset timestamp, because
 * the announcer keys its ladder on the pair -- see createQuotaAnnouncer.
 */
function normalizeWindows(body) {
  if (stryMutAct_9fa48("566")) {
    {}
  } else {
    stryCov_9fa48("566");
    const rows = (stryMutAct_9fa48("569") ? body || Array.isArray(body.limits) : stryMutAct_9fa48("568") ? false : stryMutAct_9fa48("567") ? true : (stryCov_9fa48("567", "568", "569"), body && Array.isArray(body.limits))) ? body.limits : stryMutAct_9fa48("570") ? ["Stryker was here"] : (stryCov_9fa48("570"), []);
    return rows.map(stryMutAct_9fa48("571") ? () => undefined : (stryCov_9fa48("571"), row => stryMutAct_9fa48("572") ? {} : (stryCov_9fa48("572"), {
      // The kind ALONE is not an identity. Two model-scoped weekly windows --
      // which the response already anticipates, carrying `seven_day_opus` as a
      // null waiting to be switched on -- would both be `weekly_scoped`, share
      // one announcer ladder, and silence each other. The scope is the only field
      // that tells them apart, so it belongs in the key.
      key: (stryMutAct_9fa48("575") ? row.scope && row.scope.model || row.scope.model.display_name : stryMutAct_9fa48("574") ? false : stryMutAct_9fa48("573") ? true : (stryCov_9fa48("573", "574", "575"), (stryMutAct_9fa48("577") ? row.scope || row.scope.model : stryMutAct_9fa48("576") ? true : (stryCov_9fa48("576", "577"), row.scope && row.scope.model)) && row.scope.model.display_name)) ? String(row.kind) + (stryMutAct_9fa48("578") ? "" : (stryCov_9fa48("578"), ':')) + String(row.scope.model.display_name) : String(row.kind),
      label: labelFor(row),
      // Strictly a number: `Number(null)` is 0, so a coercing check would turn
      // a window the API could not report into one reading 0% used.
      percent: (stryMutAct_9fa48("581") ? typeof row.percent === 'number' || Number.isFinite(row.percent) : stryMutAct_9fa48("580") ? false : stryMutAct_9fa48("579") ? true : (stryCov_9fa48("579", "580", "581"), (stryMutAct_9fa48("583") ? typeof row.percent !== 'number' : stryMutAct_9fa48("582") ? true : (stryCov_9fa48("582", "583"), typeof row.percent === (stryMutAct_9fa48("584") ? "" : (stryCov_9fa48("584"), 'number')))) && Number.isFinite(row.percent))) ? row.percent : null,
      resetsAt: stryMutAct_9fa48("587") ? row.resets_at && null : stryMutAct_9fa48("586") ? false : stryMutAct_9fa48("585") ? true : (stryCov_9fa48("585", "586", "587"), row.resets_at || null),
      severity: stryMutAct_9fa48("590") ? row.severity && 'normal' : stryMutAct_9fa48("589") ? false : stryMutAct_9fa48("588") ? true : (stryCov_9fa48("588", "589", "590"), row.severity || (stryMutAct_9fa48("591") ? "" : (stryCov_9fa48("591"), 'normal'))),
      isActive: stryMutAct_9fa48("594") ? row.is_active !== true : stryMutAct_9fa48("593") ? false : stryMutAct_9fa48("592") ? true : (stryCov_9fa48("592", "593", "594"), row.is_active === (stryMutAct_9fa48("595") ? false : (stryCov_9fa48("595"), true))),
      // Present and null on purpose: this plan reports no money, and a caller
      // reading `undefined` cannot tell "no such field" from "not on this plan".
      usedDollars: null,
      remainingDollars: null,
      lockedReason: stryMutAct_9fa48("598") ? row.locked_reason && null : stryMutAct_9fa48("597") ? false : stryMutAct_9fa48("596") ? true : (stryCov_9fa48("596", "597", "598"), row.locked_reason || null)
    })));
  }
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
  fetchImpl = stryMutAct_9fa48("599") ? () => undefined : (stryCov_9fa48("599"), (...args) => fetch(...args)),
  url = USAGE_URL
} = {}) {
  if (stryMutAct_9fa48("600")) {
    {}
  } else {
    stryCov_9fa48("600");
    let token;
    try {
      if (stryMutAct_9fa48("601")) {
        {}
      } else {
        stryCov_9fa48("601");
        const raw = await fsp.readFile(credentialsPath, stryMutAct_9fa48("602") ? "" : (stryCov_9fa48("602"), 'utf8'));
        token = JSON.parse(raw).claudeAiOauth.accessToken;
      }
    } catch (err) {
      if (stryMutAct_9fa48("603")) {
        {}
      } else {
        stryCov_9fa48("603");
        // No credentials, unreadable, or not the shape we expect. All of them mean
        // the same thing to a caller: we do not know the numbers.
        return stryMutAct_9fa48("604") ? {} : (stryCov_9fa48("604"), {
          ok: stryMutAct_9fa48("605") ? true : (stryCov_9fa48("605"), false),
          state: stryMutAct_9fa48("606") ? "" : (stryCov_9fa48("606"), 'absent'),
          windows: stryMutAct_9fa48("607") ? ["Stryker was here"] : (stryCov_9fa48("607"), []),
          error: reason(err, stryMutAct_9fa48("608") ? "" : (stryCov_9fa48("608"), 'no credentials'))
        });
      }
    }
    if (stryMutAct_9fa48("611") ? false : stryMutAct_9fa48("610") ? true : stryMutAct_9fa48("609") ? token : (stryCov_9fa48("609", "610", "611"), !token)) {
      if (stryMutAct_9fa48("612")) {
        {}
      } else {
        stryCov_9fa48("612");
        return stryMutAct_9fa48("613") ? {} : (stryCov_9fa48("613"), {
          ok: stryMutAct_9fa48("614") ? true : (stryCov_9fa48("614"), false),
          state: stryMutAct_9fa48("615") ? "" : (stryCov_9fa48("615"), 'absent'),
          windows: stryMutAct_9fa48("616") ? ["Stryker was here"] : (stryCov_9fa48("616"), []),
          error: stryMutAct_9fa48("617") ? "" : (stryCov_9fa48("617"), 'no access token')
        });
      }
    }
    let res;
    try {
      if (stryMutAct_9fa48("618")) {
        {}
      } else {
        stryCov_9fa48("618");
        res = await fetchImpl(url, stryMutAct_9fa48("619") ? {} : (stryCov_9fa48("619"), {
          headers: stryMutAct_9fa48("620") ? {} : (stryCov_9fa48("620"), {
            Authorization: stryMutAct_9fa48("621") ? `` : (stryCov_9fa48("621"), `Bearer ${token}`),
            'Content-Type': stryMutAct_9fa48("622") ? "" : (stryCov_9fa48("622"), 'application/json')
          })
        }));
      }
    } catch (err) {
      if (stryMutAct_9fa48("623")) {
        {}
      } else {
        stryCov_9fa48("623");
        return stryMutAct_9fa48("624") ? {} : (stryCov_9fa48("624"), {
          ok: stryMutAct_9fa48("625") ? true : (stryCov_9fa48("625"), false),
          state: stryMutAct_9fa48("626") ? "" : (stryCov_9fa48("626"), 'absent'),
          windows: stryMutAct_9fa48("627") ? ["Stryker was here"] : (stryCov_9fa48("627"), []),
          error: reason(err, stryMutAct_9fa48("628") ? "" : (stryCov_9fa48("628"), 'request failed'))
        });
      }
    }
    if (stryMutAct_9fa48("631") ? !res && !res.ok : stryMutAct_9fa48("630") ? false : stryMutAct_9fa48("629") ? true : (stryCov_9fa48("629", "630", "631"), (stryMutAct_9fa48("632") ? res : (stryCov_9fa48("632"), !res)) || (stryMutAct_9fa48("633") ? res.ok : (stryCov_9fa48("633"), !res.ok)))) {
      if (stryMutAct_9fa48("634")) {
        {}
      } else {
        stryCov_9fa48("634");
        // The status is worth carrying: a 401 means the token expired and Claude
        // Code will refresh it in the credentials file on its own -- the next read
        // picks that up. This module never attempts a refresh itself, because a
        // second writer to that file is a race nobody needs.
        return stryMutAct_9fa48("635") ? {} : (stryCov_9fa48("635"), {
          ok: stryMutAct_9fa48("636") ? true : (stryCov_9fa48("636"), false),
          state: stryMutAct_9fa48("637") ? "" : (stryCov_9fa48("637"), 'absent'),
          windows: stryMutAct_9fa48("638") ? ["Stryker was here"] : (stryCov_9fa48("638"), []),
          error: stryMutAct_9fa48("639") ? `` : (stryCov_9fa48("639"), `usage endpoint returned ${res ? res.status : stryMutAct_9fa48("640") ? "" : (stryCov_9fa48("640"), 'no response')}`)
        });
      }
    }
    let body;
    try {
      if (stryMutAct_9fa48("641")) {
        {}
      } else {
        stryCov_9fa48("641");
        body = await res.json();
      }
    } catch (err) {
      if (stryMutAct_9fa48("642")) {
        {}
      } else {
        stryCov_9fa48("642");
        return stryMutAct_9fa48("643") ? {} : (stryCov_9fa48("643"), {
          ok: stryMutAct_9fa48("644") ? true : (stryCov_9fa48("644"), false),
          state: stryMutAct_9fa48("645") ? "" : (stryCov_9fa48("645"), 'absent'),
          windows: stryMutAct_9fa48("646") ? ["Stryker was here"] : (stryCov_9fa48("646"), []),
          error: reason(err, stryMutAct_9fa48("647") ? "" : (stryCov_9fa48("647"), 'unparseable response'))
        });
      }
    }
    return stryMutAct_9fa48("648") ? {} : (stryCov_9fa48("648"), {
      ok: stryMutAct_9fa48("649") ? false : (stryCov_9fa48("649"), true),
      state: stryMutAct_9fa48("650") ? "" : (stryCov_9fa48("650"), 'fresh'),
      windows: normalizeWindows(body),
      error: null
    });
  }
}

// Never let an error object carry the token into a log line or a payload. The
// token is only ever in an Authorization header; this keeps it that way even
// if a future fetch implementation decides to quote the request in its error.
function reason(err, fallback) {
  if (stryMutAct_9fa48("651")) {
    {}
  } else {
    stryCov_9fa48("651");
    const msg = (stryMutAct_9fa48("654") ? err || err.message : stryMutAct_9fa48("653") ? false : stryMutAct_9fa48("652") ? true : (stryCov_9fa48("652", "653", "654"), err && err.message)) ? String(err.message) : fallback;
    return (stryMutAct_9fa48("658") ? msg.length <= 200 : stryMutAct_9fa48("657") ? msg.length >= 200 : stryMutAct_9fa48("656") ? false : stryMutAct_9fa48("655") ? true : (stryCov_9fa48("655", "656", "657", "658"), msg.length > 200)) ? stryMutAct_9fa48("659") ? msg : (stryCov_9fa48("659"), msg.slice(0, 200)) : msg;
  }
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
  if (stryMutAct_9fa48("660")) {
    {}
  } else {
    stryCov_9fa48("660");
    // instanceKey -> highest threshold already announced for it.
    const announced = new Map();
    function check(windows) {
      if (stryMutAct_9fa48("661")) {
        {}
      } else {
        stryCov_9fa48("661");
        if (stryMutAct_9fa48("664") ? false : stryMutAct_9fa48("663") ? true : stryMutAct_9fa48("662") ? Array.isArray(windows) : (stryCov_9fa48("662", "663", "664"), !Array.isArray(windows))) return null;
        let hit = null;
        let hitInstance = null;
        for (const w of windows) {
          if (stryMutAct_9fa48("665")) {
            {}
          } else {
            stryCov_9fa48("665");
            // STRICTLY a number. `Number('96')` is 96 and `Number(null)` is 0, and a
            // value the normaliser classifies as unknown must not announce anything.
            // This module bans that coercion by name three files over; it was using
            // it here.
            if (stryMutAct_9fa48("668") ? (!w || typeof w.percent !== 'number') && !Number.isFinite(w.percent) : stryMutAct_9fa48("667") ? false : stryMutAct_9fa48("666") ? true : (stryCov_9fa48("666", "667", "668"), (stryMutAct_9fa48("670") ? !w && typeof w.percent !== 'number' : stryMutAct_9fa48("669") ? false : (stryCov_9fa48("669", "670"), (stryMutAct_9fa48("671") ? w : (stryCov_9fa48("671"), !w)) || (stryMutAct_9fa48("673") ? typeof w.percent === 'number' : stryMutAct_9fa48("672") ? false : (stryCov_9fa48("672", "673"), typeof w.percent !== (stryMutAct_9fa48("674") ? "" : (stryCov_9fa48("674"), 'number')))))) || (stryMutAct_9fa48("675") ? Number.isFinite(w.percent) : (stryCov_9fa48("675"), !Number.isFinite(w.percent))))) continue;

            // A window with NO reset time gets no ladder entry at all. Keying it on a
            // literal 'no-reset' collapsed every instance of that window onto one
            // entry that could never expire -- which is precisely the milestones.js
            // behaviour this function exists to escape, restored whenever the
            // discriminator happens to be missing. Better to risk announcing twice
            // than to go permanently silent.
            const instance = w.resetsAt ? stryMutAct_9fa48("676") ? `` : (stryCov_9fa48("676"), `${w.key}@${w.resetsAt}`) : null;
            const reached = stryMutAct_9fa48("677") ? QUOTA_THRESHOLDS.pop() : (stryCov_9fa48("677"), QUOTA_THRESHOLDS.filter(stryMutAct_9fa48("678") ? () => undefined : (stryCov_9fa48("678"), t => stryMutAct_9fa48("682") ? w.percent < t : stryMutAct_9fa48("681") ? w.percent > t : stryMutAct_9fa48("680") ? false : stryMutAct_9fa48("679") ? true : (stryCov_9fa48("679", "680", "681", "682"), w.percent >= t))).pop());
            if (stryMutAct_9fa48("685") ? reached !== undefined : stryMutAct_9fa48("684") ? false : stryMutAct_9fa48("683") ? true : (stryCov_9fa48("683", "684", "685"), reached === undefined)) continue;
            if (stryMutAct_9fa48("687") ? false : stryMutAct_9fa48("686") ? true : (stryCov_9fa48("686", "687"), instance)) {
              if (stryMutAct_9fa48("688")) {
                {}
              } else {
                stryCov_9fa48("688");
                const already = announced.get(instance);
                if (stryMutAct_9fa48("691") ? already !== undefined || already >= reached : stryMutAct_9fa48("690") ? false : stryMutAct_9fa48("689") ? true : (stryCov_9fa48("689", "690", "691"), (stryMutAct_9fa48("693") ? already === undefined : stryMutAct_9fa48("692") ? true : (stryCov_9fa48("692", "693"), already !== undefined)) && (stryMutAct_9fa48("696") ? already < reached : stryMutAct_9fa48("695") ? already > reached : stryMutAct_9fa48("694") ? true : (stryCov_9fa48("694", "695", "696"), already >= reached)))) continue;
              }
            }

            // The HIGHEST crossing in this batch wins, so one long turn that jumps
            // two rungs announces the rung it actually reached.
            if (stryMutAct_9fa48("699") ? !hit && reached > hit.threshold : stryMutAct_9fa48("698") ? false : stryMutAct_9fa48("697") ? true : (stryCov_9fa48("697", "698", "699"), (stryMutAct_9fa48("700") ? hit : (stryCov_9fa48("700"), !hit)) || (stryMutAct_9fa48("703") ? reached <= hit.threshold : stryMutAct_9fa48("702") ? reached >= hit.threshold : stryMutAct_9fa48("701") ? false : (stryCov_9fa48("701", "702", "703"), reached > hit.threshold)))) {
              if (stryMutAct_9fa48("704")) {
                {}
              } else {
                stryCov_9fa48("704");
                hit = stryMutAct_9fa48("705") ? {} : (stryCov_9fa48("705"), {
                  key: w.key,
                  label: w.label,
                  threshold: reached,
                  percent: w.percent,
                  resetsAt: w.resetsAt,
                  text: stryMutAct_9fa48("706") ? `` : (stryCov_9fa48("706"), `${w.label} usage at ${Math.round(w.percent)}%`)
                });
                hitInstance = instance;
              }
            }
          }
        }

        // RECORDED ONLY FOR WHAT IS ACTUALLY ANNOUNCED. Writing the ladder inside
        // the loop marked every crossing in the batch as announced and then
        // returned one of them -- so two windows crossing in the same 60s poll
        // meant the loser was recorded as told and never told, permanently. A
        // crossing that loses this round must resurface on the next one.
        if (stryMutAct_9fa48("709") ? hit || hitInstance : stryMutAct_9fa48("708") ? false : stryMutAct_9fa48("707") ? true : (stryCov_9fa48("707", "708", "709"), hit && hitInstance)) if (stryMutAct_9fa48("710")) {
          ;
        } else {
          stryCov_9fa48("710");
          announced.set(hitInstance, hit.threshold);
        }

        // NOT PRUNED ON ABSENCE. A window missing from one batch -- a partial
        // response, or `limits: []`, which readQuota reports as ok:true -- used to
        // delete its ladder, so the next poll re-announced a rung already
        // announced: absence rewriting memory. An entry is dropped only when that
        // window reappears under a NEW reset time, which is the only evidence that
        // the old instance is genuinely over.
        for (const w of windows) {
          if (stryMutAct_9fa48("711")) {
            {}
          } else {
            stryCov_9fa48("711");
            if (stryMutAct_9fa48("714") ? !w && !w.resetsAt : stryMutAct_9fa48("713") ? false : stryMutAct_9fa48("712") ? true : (stryCov_9fa48("712", "713", "714"), (stryMutAct_9fa48("715") ? w : (stryCov_9fa48("715"), !w)) || (stryMutAct_9fa48("716") ? w.resetsAt : (stryCov_9fa48("716"), !w.resetsAt)))) continue;
            const prefix = stryMutAct_9fa48("717") ? `` : (stryCov_9fa48("717"), `${w.key}@`);
            const live = stryMutAct_9fa48("718") ? `` : (stryCov_9fa48("718"), `${w.key}@${w.resetsAt}`);
            for (const k of stryMutAct_9fa48("719") ? [] : (stryCov_9fa48("719"), [...announced.keys()])) {
              if (stryMutAct_9fa48("720")) {
                {}
              } else {
                stryCov_9fa48("720");
                if (stryMutAct_9fa48("723") ? k.startsWith(prefix) || k !== live : stryMutAct_9fa48("722") ? false : stryMutAct_9fa48("721") ? true : (stryCov_9fa48("721", "722", "723"), (stryMutAct_9fa48("724") ? k.endsWith(prefix) : (stryCov_9fa48("724"), k.startsWith(prefix))) && (stryMutAct_9fa48("726") ? k === live : stryMutAct_9fa48("725") ? true : (stryCov_9fa48("725", "726"), k !== live)))) if (stryMutAct_9fa48("727")) {
                  ;
                } else {
                  stryCov_9fa48("727");
                  announced.delete(k);
                }
              }
            }
          }
        }
        return hit;
      }
    }
    return stryMutAct_9fa48("728") ? {} : (stryCov_9fa48("728"), {
      check,
      state: stryMutAct_9fa48("729") ? () => undefined : (stryCov_9fa48("729"), () => new Map(announced))
    });
  }
}
module.exports = stryMutAct_9fa48("730") ? {} : (stryCov_9fa48("730"), {
  readQuota,
  normalizeWindows,
  createQuotaAnnouncer,
  QUOTA_THRESHOLDS,
  USAGE_URL,
  defaultCredentialsPath
});