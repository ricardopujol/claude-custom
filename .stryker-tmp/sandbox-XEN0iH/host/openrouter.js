// @ts-nocheck
'use strict';

/**
 * The OpenRouter model catalogue: fetched, cached, and honest about which.
 *
 * The catalogue endpoint is PUBLIC — no key, no spend, no account. Verified:
 * 445 models, 377 of them declaring tool support. So the browser works before
 * the council has a key, and a key never needs to exist for it to keep working.
 *
 * CACHED TO DISK ON PURPOSE, and the cache is the point rather than an
 * optimisation:
 *
 *   - the panel opens instantly instead of after a network round trip
 *   - it works with no network at all, which is the ordinary case on a plane
 *     or behind a flaky connection
 *   - the catalogue changes a few times a week, not a few times a second
 *
 * WHAT IT REFUSES TO DO IS PRETEND. Every result says where it came from and
 * how old it is, because a stale price shown as current is the failure that
 * costs money: a model that was free last month and is not any more would keep
 * reading as free forever. `stale` and `fetchedAt` travel with the data so the
 * panel can say "prices from 3 days ago" instead of implying they are live.
 *
 * NO API KEY IS EVER SENT HERE. This endpoint does not take one, and sending a
 * key to an endpoint that does not need it is how keys end up in logs.
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
const https = require('https');
const fsp = require('fs/promises');
const {
  renameWithRetryAsync
} = require('./atomic-write');
const path = require('path');
const CATALOGUE_URL = stryMutAct_9fa48("395") ? "" : (stryCov_9fa48("395"), 'https://openrouter.ai/api/v1/models');

// A few times a week is how often this actually changes. An hour keeps a long
// session from re-fetching while still noticing a new model the same day.
const FRESH_MS = stryMutAct_9fa48("396") ? 60 * 60 / 1000 : (stryCov_9fa48("396"), (stryMutAct_9fa48("397") ? 60 / 60 : (stryCov_9fa48("397"), 60 * 60)) * 1000);
const REQUEST_TIMEOUT_MS = 15000;

// The catalogue is ~1MB of JSON. A ceiling so a wrong endpoint or a captive
// portal cannot stream indefinitely into memory.
const MAX_BYTES = stryMutAct_9fa48("398") ? 8 * 1024 / 1024 : (stryCov_9fa48("398"), (stryMutAct_9fa48("399") ? 8 / 1024 : (stryCov_9fa48("399"), 8 * 1024)) * 1024);
function fetchCatalogue(url = CATALOGUE_URL) {
  if (stryMutAct_9fa48("400")) {
    {}
  } else {
    stryCov_9fa48("400");
    return new Promise((resolve, reject) => {
      if (stryMutAct_9fa48("401")) {
        {}
      } else {
        stryCov_9fa48("401");
        const req = https.get(url, stryMutAct_9fa48("402") ? {} : (stryCov_9fa48("402"), {
          timeout: REQUEST_TIMEOUT_MS
        }), res => {
          if (stryMutAct_9fa48("403")) {
            {}
          } else {
            stryCov_9fa48("403");
            if (stryMutAct_9fa48("406") ? res.statusCode === 200 : stryMutAct_9fa48("405") ? false : stryMutAct_9fa48("404") ? true : (stryCov_9fa48("404", "405", "406"), res.statusCode !== 200)) {
              if (stryMutAct_9fa48("407")) {
                {}
              } else {
                stryCov_9fa48("407");
                if (stryMutAct_9fa48("408")) {
                  ;
                } else {
                  stryCov_9fa48("408");
                  res.resume();
                }
                reject(new Error(stryMutAct_9fa48("410") ? `` : (stryCov_9fa48("410"), `catalogue returned HTTP ${res.statusCode}`)));
                return;
              }
            }
            let body = stryMutAct_9fa48("411") ? "Stryker was here!" : (stryCov_9fa48("411"), '');
            let bytes = 0;
            res.setEncoding(stryMutAct_9fa48("413") ? "" : (stryCov_9fa48("413"), 'utf8'));
            res.on(stryMutAct_9fa48("415") ? "" : (stryCov_9fa48("415"), 'data'), chunk => {
              if (stryMutAct_9fa48("416")) {
                {}
              } else {
                stryCov_9fa48("416");
                stryMutAct_9fa48("417") ? bytes -= Buffer.byteLength(chunk) : (stryCov_9fa48("417"), bytes += Buffer.byteLength(chunk));
                if (stryMutAct_9fa48("421") ? bytes <= MAX_BYTES : stryMutAct_9fa48("420") ? bytes >= MAX_BYTES : stryMutAct_9fa48("419") ? false : stryMutAct_9fa48("418") ? true : (stryCov_9fa48("418", "419", "420", "421"), bytes > MAX_BYTES)) {
                  if (stryMutAct_9fa48("422")) {
                    {}
                  } else {
                    stryCov_9fa48("422");
                    if (stryMutAct_9fa48("423")) {
                      ;
                    } else {
                      stryCov_9fa48("423");
                      req.destroy();
                    }
                    reject(new Error(stryMutAct_9fa48("425") ? "" : (stryCov_9fa48("425"), 'catalogue response exceeded the size ceiling')));
                    return;
                  }
                }
                stryMutAct_9fa48("426") ? body -= chunk : (stryCov_9fa48("426"), body += chunk);
              }
            });
            res.on(stryMutAct_9fa48("428") ? "" : (stryCov_9fa48("428"), 'end'), () => {
              if (stryMutAct_9fa48("429")) {
                {}
              } else {
                stryCov_9fa48("429");
                try {
                  if (stryMutAct_9fa48("430")) {
                    {}
                  } else {
                    stryCov_9fa48("430");
                    const parsed = JSON.parse(body);
                    const rows = (stryMutAct_9fa48("433") ? parsed || Array.isArray(parsed.data) : stryMutAct_9fa48("432") ? false : stryMutAct_9fa48("431") ? true : (stryCov_9fa48("431", "432", "433"), parsed && Array.isArray(parsed.data))) ? parsed.data : null;
                    if (stryMutAct_9fa48("436") ? false : stryMutAct_9fa48("435") ? true : stryMutAct_9fa48("434") ? rows : (stryCov_9fa48("434", "435", "436"), !rows)) {
                      if (stryMutAct_9fa48("437")) {
                        {}
                      } else {
                        stryCov_9fa48("437");
                        reject(new Error(stryMutAct_9fa48("439") ? "" : (stryCov_9fa48("439"), 'catalogue response had no data array')));
                        return;
                      }
                    }
                    if (stryMutAct_9fa48("440")) {
                      ;
                    } else {
                      stryCov_9fa48("440");
                      resolve(rows);
                    }
                  }
                } catch (err) {
                  if (stryMutAct_9fa48("441")) {
                    {}
                  } else {
                    stryCov_9fa48("441");
                    reject(new Error(stryMutAct_9fa48("443") ? `` : (stryCov_9fa48("443"), `catalogue response was not JSON: ${err.message}`)));
                  }
                }
              }
            });
          }
        });
        req.on(stryMutAct_9fa48("445") ? "" : (stryCov_9fa48("445"), 'timeout'), () => {
          if (stryMutAct_9fa48("446")) {
            {}
          } else {
            stryCov_9fa48("446");
            req.destroy(new Error(stryMutAct_9fa48("448") ? "" : (stryCov_9fa48("448"), 'catalogue request timed out')));
          }
        });
        req.on(stryMutAct_9fa48("450") ? "" : (stryCov_9fa48("450"), 'error'), reject);
      }
    });
  }
}
async function readCache(file) {
  if (stryMutAct_9fa48("451")) {
    {}
  } else {
    stryCov_9fa48("451");
    try {
      if (stryMutAct_9fa48("452")) {
        {}
      } else {
        stryCov_9fa48("452");
        const parsed = JSON.parse(await fsp.readFile(file, stryMutAct_9fa48("453") ? "" : (stryCov_9fa48("453"), 'utf8')));
        if (stryMutAct_9fa48("456") ? (!parsed || !Array.isArray(parsed.rows)) && !parsed.rows.length : stryMutAct_9fa48("455") ? false : stryMutAct_9fa48("454") ? true : (stryCov_9fa48("454", "455", "456"), (stryMutAct_9fa48("458") ? !parsed && !Array.isArray(parsed.rows) : stryMutAct_9fa48("457") ? false : (stryCov_9fa48("457", "458"), (stryMutAct_9fa48("459") ? parsed : (stryCov_9fa48("459"), !parsed)) || (stryMutAct_9fa48("460") ? Array.isArray(parsed.rows) : (stryCov_9fa48("460"), !Array.isArray(parsed.rows))))) || (stryMutAct_9fa48("461") ? parsed.rows.length : (stryCov_9fa48("461"), !parsed.rows.length)))) return null;
        // A missing or unusable timestamp is NULL, not 0. Zero only looks ancient
        // because the epoch is far away, which makes the freshness rule depend on
        // an accident of arithmetic rather than on saying what it means. Null is
        // "we do not know when this was fetched", and that is never fresh.
        const stamp = Number(parsed.fetchedAt);
        return stryMutAct_9fa48("462") ? {} : (stryCov_9fa48("462"), {
          rows: parsed.rows,
          fetchedAt: (stryMutAct_9fa48("465") ? Number.isFinite(stamp) || stamp > 0 : stryMutAct_9fa48("464") ? false : stryMutAct_9fa48("463") ? true : (stryCov_9fa48("463", "464", "465"), Number.isFinite(stamp) && (stryMutAct_9fa48("468") ? stamp <= 0 : stryMutAct_9fa48("467") ? stamp >= 0 : stryMutAct_9fa48("466") ? true : (stryCov_9fa48("466", "467", "468"), stamp > 0)))) ? stamp : null
        });
      }
    } catch {
      if (stryMutAct_9fa48("469")) {
        {}
      } else {
        stryCov_9fa48("469");
        return null;
      }
    }
  }
}
async function writeCache(file, rows, now) {
  if (stryMutAct_9fa48("470")) {
    {}
  } else {
    stryCov_9fa48("470");
    try {
      if (stryMutAct_9fa48("471")) {
        {}
      } else {
        stryCov_9fa48("471");
        await fsp.mkdir(path.dirname(file), stryMutAct_9fa48("472") ? {} : (stryCov_9fa48("472"), {
          recursive: stryMutAct_9fa48("473") ? false : (stryCov_9fa48("473"), true)
        }));
        // Written via a temp file and renamed: a half-written cache that still
        // parses would be a truncated catalogue silently presented as the whole one.
        const tmp = stryMutAct_9fa48("474") ? `` : (stryCov_9fa48("474"), `${file}.tmp`);

        // The temp is cleaned up on failure, like the other two write-and-rename
        // sites. Miguel: the cleanup landed at two of three, and one site
        // differing is how the next reader concludes the pattern is optional.
        // Harmless here on its own -- the fixed `.tmp` name bounds it at one
        // orphan and a model catalogue holds no secrets -- which is precisely why
        // the reason to do it is consistency rather than risk.
        try {
          if (stryMutAct_9fa48("475")) {
            {}
          } else {
            stryCov_9fa48("475");
            await fsp.writeFile(tmp, JSON.stringify(stryMutAct_9fa48("476") ? {} : (stryCov_9fa48("476"), {
              fetchedAt: now,
              rows
            })), stryMutAct_9fa48("477") ? "" : (stryCov_9fa48("477"), 'utf8'));
            // Retried. Dexter, Finding 5: this is the third write-and-rename in the
            // codebase and was the only one left unretried, precisely BECAUSE it
            // never threw -- the catch below swallowed it. On the machine the retry
            // exists for, a handle is briefly held on every write, so this rename
            // failed every time, the cache was never written at all, and every
            // launch silently paid a network fetch.
            //
            // The ASYNC sibling, not renameWithRetry: this caller can yield, so it
            // must, rather than freezing the event loop the way Atomics.wait does.
            await renameWithRetryAsync(tmp, file);
          }
        } catch (err) {
          if (stryMutAct_9fa48("478")) {
            {}
          } else {
            stryCov_9fa48("478");
            try {
              if (stryMutAct_9fa48("479")) {
                {}
              } else {
                stryCov_9fa48("479");
                await fsp.unlink(tmp);
              }
            } catch {/* best effort, as elsewhere */}
            throw err;
          }
        }
      }
    } catch (err) {
      if (stryMutAct_9fa48("480")) {
        {}
      } else {
        stryCov_9fa48("480");
        // A cache that cannot be written is a slower panel, not a broken one, so
        // this still degrades rather than throwing. But it SAYS SO now.
        //
        // Miguel: the retry above removed the CAUSE and left the DETECTOR missing.
        // An empty catch makes an exhausted write indistinguishable from a working
        // cache -- the hidden outage Finding 5 was about, every launch paying a
        // network fetch forever with nothing reporting it. Degrading is right;
        // degrading undetectably is the bug.
        //
        // COST, worth knowing: writeCache is awaited on the network path, so on a
        // machine where the rename fails PERMANENTLY every refresh now pays the
        // full 300ms backoff before loadCatalogue resolves, where it previously
        // paid none. Justified while the failure is transient -- that is the fix --
        // and pure cost when it is permanent, which is a second reason this
        // warning matters: 300ms of silence is worse than 0ms of silence.
        console.warn(stryMutAct_9fa48("482") ? "" : (stryCov_9fa48("482"), '[openrouter] could not write the catalogue cache:'), stryMutAct_9fa48("485") ? err || err.message : stryMutAct_9fa48("484") ? false : stryMutAct_9fa48("483") ? true : (stryCov_9fa48("483", "484", "485"), err && err.message));
      }
    }
  }
}

/**
 * The catalogue, with its provenance.
 *
 * Returns `{ rows, source, fetchedAt, stale, error }` where source is
 * 'network' | 'cache' | 'none'. `rows` is raw — host/models.js decides what a
 * row means.
 *
 * A network failure with a cache present is NOT an error the caller has to
 * handle: it returns the cache, marked stale, with the reason attached. A
 * network failure with no cache returns an empty list and says so, rather than
 * an empty list that looks like "OpenRouter offers no models".
 */
async function loadCatalogue({
  cacheFile,
  now = Date.now(),
  force = stryMutAct_9fa48("486") ? true : (stryCov_9fa48("486"), false),
  fetchImpl = fetchCatalogue
} = {}) {
  if (stryMutAct_9fa48("487")) {
    {}
  } else {
    stryCov_9fa48("487");
    const at = (stryMutAct_9fa48("490") ? typeof now !== 'function' : stryMutAct_9fa48("489") ? false : stryMutAct_9fa48("488") ? true : (stryCov_9fa48("488", "489", "490"), typeof now === (stryMutAct_9fa48("491") ? "" : (stryCov_9fa48("491"), 'function')))) ? now() : now;
    const cached = cacheFile ? await readCache(cacheFile) : null;
    if (stryMutAct_9fa48("494") ? !force && cached && cached.fetchedAt !== null || at - cached.fetchedAt < FRESH_MS : stryMutAct_9fa48("493") ? false : stryMutAct_9fa48("492") ? true : (stryCov_9fa48("492", "493", "494"), (stryMutAct_9fa48("496") ? !force && cached || cached.fetchedAt !== null : stryMutAct_9fa48("495") ? true : (stryCov_9fa48("495", "496"), (stryMutAct_9fa48("498") ? !force || cached : stryMutAct_9fa48("497") ? true : (stryCov_9fa48("497", "498"), (stryMutAct_9fa48("499") ? force : (stryCov_9fa48("499"), !force)) && cached)) && (stryMutAct_9fa48("501") ? cached.fetchedAt === null : stryMutAct_9fa48("500") ? true : (stryCov_9fa48("500", "501"), cached.fetchedAt !== null)))) && (stryMutAct_9fa48("504") ? at - cached.fetchedAt >= FRESH_MS : stryMutAct_9fa48("503") ? at - cached.fetchedAt <= FRESH_MS : stryMutAct_9fa48("502") ? true : (stryCov_9fa48("502", "503", "504"), (stryMutAct_9fa48("505") ? at + cached.fetchedAt : (stryCov_9fa48("505"), at - cached.fetchedAt)) < FRESH_MS)))) {
      if (stryMutAct_9fa48("506")) {
        {}
      } else {
        stryCov_9fa48("506");
        return stryMutAct_9fa48("507") ? {} : (stryCov_9fa48("507"), {
          rows: cached.rows,
          source: stryMutAct_9fa48("508") ? "" : (stryCov_9fa48("508"), 'cache'),
          fetchedAt: cached.fetchedAt,
          stale: stryMutAct_9fa48("509") ? true : (stryCov_9fa48("509"), false),
          error: null
        });
      }
    }
    try {
      if (stryMutAct_9fa48("510")) {
        {}
      } else {
        stryCov_9fa48("510");
        const rows = await fetchImpl();
        if (stryMutAct_9fa48("512") ? false : stryMutAct_9fa48("511") ? true : (stryCov_9fa48("511", "512"), cacheFile)) await writeCache(cacheFile, rows, at);
        return stryMutAct_9fa48("513") ? {} : (stryCov_9fa48("513"), {
          rows,
          source: stryMutAct_9fa48("514") ? "" : (stryCov_9fa48("514"), 'network'),
          fetchedAt: at,
          stale: stryMutAct_9fa48("515") ? true : (stryCov_9fa48("515"), false),
          error: null
        });
      }
    } catch (err) {
      if (stryMutAct_9fa48("516")) {
        {}
      } else {
        stryCov_9fa48("516");
        const message = stryMutAct_9fa48("519") ? err && err.message && String(err) : stryMutAct_9fa48("518") ? false : stryMutAct_9fa48("517") ? true : (stryCov_9fa48("517", "518", "519"), (stryMutAct_9fa48("521") ? err || err.message : stryMutAct_9fa48("520") ? false : (stryCov_9fa48("520", "521"), err && err.message)) || String(err));
        if (stryMutAct_9fa48("523") ? false : stryMutAct_9fa48("522") ? true : (stryCov_9fa48("522", "523"), cached)) {
          if (stryMutAct_9fa48("524")) {
            {}
          } else {
            stryCov_9fa48("524");
            // Stale beats empty, but only if it SAYS it is stale. A month-old price
            // shown as current is the failure that costs money.
            return stryMutAct_9fa48("525") ? {} : (stryCov_9fa48("525"), {
              rows: cached.rows,
              source: stryMutAct_9fa48("526") ? "" : (stryCov_9fa48("526"), 'cache'),
              fetchedAt: cached.fetchedAt,
              stale: stryMutAct_9fa48("527") ? false : (stryCov_9fa48("527"), true),
              error: message
            });
          }
        }
        // Empty AND an error, never a bare empty list: "no models" and "could not
        // ask" look identical on screen otherwise.
        return stryMutAct_9fa48("528") ? {} : (stryCov_9fa48("528"), {
          rows: stryMutAct_9fa48("529") ? ["Stryker was here"] : (stryCov_9fa48("529"), []),
          source: stryMutAct_9fa48("530") ? "" : (stryCov_9fa48("530"), 'none'),
          fetchedAt: 0,
          stale: stryMutAct_9fa48("531") ? false : (stryCov_9fa48("531"), true),
          error: message
        });
      }
    }
  }
}
module.exports = stryMutAct_9fa48("532") ? {} : (stryCov_9fa48("532"), {
  loadCatalogue,
  fetchCatalogue,
  CATALOGUE_URL,
  FRESH_MS
});