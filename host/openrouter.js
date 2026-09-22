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

const https = require('https');
const fsp = require('fs/promises');
const { renameWithRetryAsync } = require('./atomic-write');
const path = require('path');

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';

// A few times a week is how often this actually changes. An hour keeps a long
// session from re-fetching while still noticing a new model the same day.
const FRESH_MS = 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15000;

// The catalogue is ~1MB of JSON. A ceiling so a wrong endpoint or a captive
// portal cannot stream indefinitely into memory.
const MAX_BYTES = 8 * 1024 * 1024;

function fetchCatalogue(url = CATALOGUE_URL) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`catalogue returned HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) {
          req.destroy();
          reject(new Error('catalogue response exceeded the size ceiling'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const rows = parsed && Array.isArray(parsed.data) ? parsed.data : null;
          if (!rows) {
            reject(new Error('catalogue response had no data array'));
            return;
          }
          resolve(rows);
        } catch (err) {
          reject(new Error(`catalogue response was not JSON: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('catalogue request timed out')); });
    req.on('error', reject);
  });
}

async function readCache(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) return null;
    // A missing or unusable timestamp is NULL, not 0. Zero only looks ancient
    // because the epoch is far away, which makes the freshness rule depend on
    // an accident of arithmetic rather than on saying what it means. Null is
    // "we do not know when this was fetched", and that is never fresh.
    const stamp = Number(parsed.fetchedAt);
    return { rows: parsed.rows, fetchedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : null };
  } catch {
    return null;
  }
}

async function writeCache(file, rows, now) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Written via a temp file and renamed: a half-written cache that still
    // parses would be a truncated catalogue silently presented as the whole one.
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ fetchedAt: now, rows }), 'utf8');
    // Retried. Dexter, Finding 5: this is the third write-and-rename in the
    // codebase and was the only one left unretried, precisely BECAUSE it never
    // threw -- the catch below swallows it. On the machine the retry exists
    // for, a handle is briefly held on every write, so this rename failed
    // every time and the cache was never written at all, with every launch
    // silently paying a network fetch. A graceful catch around a write that
    // never succeeds is not graceful degradation, it is a hidden outage.
    //
    // The ASYNC sibling, not renameWithRetry: this caller can yield, so it
    // must, rather than freezing the host's event loop the way Atomics.wait
    // would.
    await renameWithRetryAsync(tmp, file);
  } catch (err) {
    // A cache that cannot be written is a slower panel, not a broken one --
    // so this still degrades rather than throwing. But it SAYS SO now.
    //
    // Miguel, review of the fixed branch: the retry above removed the CAUSE
    // and left the DETECTOR missing. An empty catch here means an exhausted
    // write is indistinguishable from a working cache, which is precisely the
    // hidden outage Dexter's Finding 5 was about -- every launch paying a
    // network fetch, forever, with nothing anywhere reporting it. Degrading is
    // right; degrading undetectably is the bug.
    console.warn('[openrouter] could not write the catalogue cache:', err && err.message);
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
async function loadCatalogue({ cacheFile, now = Date.now(), force = false, fetchImpl = fetchCatalogue } = {}) {
  const at = typeof now === 'function' ? now() : now;
  const cached = cacheFile ? await readCache(cacheFile) : null;

  if (!force && cached && cached.fetchedAt !== null && at - cached.fetchedAt < FRESH_MS) {
    return { rows: cached.rows, source: 'cache', fetchedAt: cached.fetchedAt, stale: false, error: null };
  }

  try {
    const rows = await fetchImpl();
    if (cacheFile) await writeCache(cacheFile, rows, at);
    return { rows, source: 'network', fetchedAt: at, stale: false, error: null };
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (cached) {
      // Stale beats empty, but only if it SAYS it is stale. A month-old price
      // shown as current is the failure that costs money.
      return {
        rows: cached.rows, source: 'cache', fetchedAt: cached.fetchedAt,
        stale: true, error: message,
      };
    }
    // Empty AND an error, never a bare empty list: "no models" and "could not
    // ask" look identical on screen otherwise.
    return { rows: [], source: 'none', fetchedAt: 0, stale: true, error: message };
  }
}

module.exports = { loadCatalogue, fetchCatalogue, CATALOGUE_URL, FRESH_MS };
