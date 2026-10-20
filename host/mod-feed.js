'use strict';
/**
 * What the claude-custom mod (mods/claude-custom, loaded into `claude` with --plugin-dir) posts to this host (BACKLOG #119 A2).
 *
 * The mod reads the CLI's own usage (`$.session.usage()` / the `session.measure` event), its subagents' states (`$.agent.list()`)
 * and its permission asks (`tool.check` resolving to `ask`), and POSTs one small JSON record per observation to
 * http://127.0.0.1:<port>/mod with `Authorization: Bearer <token>` (a URL ends up in logs, a header does not). This module is the host's
 * half: it validates a record and serves the route.
 *
 *   - STRICT typeof validation. A figure that is absent stays absent: `Number(null)` is 0 (CLAUDE.md), so nothing here coerces.
 *     A wrong-typed field refuses the WHOLE record rather than dropping the field, because a half-read record is a guess.
 *   - THE ROUTE is a second tiny HTTP server on 127.0.0.1, an ephemeral port. Reasons it is not the WebSocket server: that one's
 *     HTTP side answers only upgrades (host/host.js), and its token is the window's, which the pty must never carry. This token is
 *     minted once per HOST PROCESS (not per spawn: a restart or resume of the session in the same host keeps it; the route would need a
 *     mutable expected token to rotate it, and the exposure is the same either way, see the limit below). It travels in the child's
 *     environment (CLAUDE_CUSTOM_MOD_TOKEN) and authorises posting records and nothing else.
 *   - KNOWN LIMIT: everything `claude` spawns inherits that environment (Bash tool commands, MCP servers, other plugins), so any of them can
 *     post a forged record. The validators are strict and nothing executes, so the effect is cosmetic (a wrong header number, a toast), with
 *     one non-cosmetic side: a forged `usage` record with rate limits makes the OAuth poller yield for up to two minutes (host/quota-share.js
 *     modCovers). Records for a session other than the host's own are dropped (host/mod-records.js), which stops a second `claude` that
 *     loaded the mod, not a forger who copies the session id.
 *   - A browser can reach 127.0.0.1 as well as the mod can, so a request that carries an Origin is refused, and the Host header
 *     must be exactly this address and port (DNS rebinding). Body at most 64 KB.
 *
 * Nothing here decides anything about the session: the mod only observes, and so does this.
 */

const http = require('http');
const { allowConnection } = require('./gatekeeper');

const RECORD_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT = 200;
const MAX_AGENTS = 64;
const MAX_RATE_LIMITS = 32;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v !== '' && v.length <= MAX_TEXT;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (error) => ({ ok: false, error });

function readContext(c) {
  if (!isObj(c)) return null;
  const out = {};
  for (const k of ['tokens', 'window', 'percent']) {
    if (c[k] === undefined) continue;
    if (!isNum(c[k])) return null;
    out[k] = c[k];
  }
  return out;
}

function readUsage(u) {
  if (!isObj(u) || !Array.isArray(u.rateLimits) || u.rateLimits.length > MAX_RATE_LIMITS) return null;
  const rateLimits = [];
  for (const r of u.rateLimits) {
    if (!isObj(r) || !isText(r.kind) || !isNum(r.percentUsed)) return null;
    if (r.resetsAt !== undefined && !isText(r.resetsAt)) return null;
    rateLimits.push(r.resetsAt === undefined ? { kind: r.kind, percentUsed: r.percentUsed } : { kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt });
  }
  const out = { rateLimits };
  if (u.context !== undefined) { const c = readContext(u.context); if (c === null) return null; out.context = c; }
  if (u.cost !== undefined) { if (!isObj(u.cost) || !isNum(u.cost.usd)) return null; out.cost = { usd: u.cost.usd }; }
  if (u.startedAt !== undefined) { if (!isNum(u.startedAt)) return null; out.startedAt = u.startedAt; }
  return out;
}

function readAgents(list) {
  if (!Array.isArray(list) || list.length > MAX_AGENTS) return null;
  const out = [];
  for (const a of list) {
    if (!isObj(a) || !isText(a.id) || !isText(a.status)) return null;
    const row = { id: a.id, status: a.status };
    for (const k of ['type', 'name', 'parentId']) {
      if (a[k] === undefined) continue;
      if (!isText(a[k])) return null;
      row[k] = a[k];
    }
    out.push(row);
  }
  return out;
}

/** `{ ok: true, record }` with only the fields this host knows, or `{ ok: false, error }`. */
function parseRecord(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return bad('not JSON'); }
  if (!isObj(raw)) return bad('not an object');
  if (raw.v !== RECORD_VERSION) return bad('unknown version');
  if (!isText(raw.sessionId)) return bad('no session id');
  if (!isNum(raw.at)) return bad('no time');
  const head = { v: RECORD_VERSION, kind: raw.kind, sessionId: raw.sessionId, at: raw.at };
  switch (raw.kind) {
    case 'usage': {
      const usage = readUsage(raw.usage);
      return usage === null ? bad('bad usage') : { ok: true, record: { ...head, usage } };
    }
    case 'agents': {
      const agents = readAgents(raw.agents);
      return agents === null ? bad('bad agents') : { ok: true, record: { ...head, agents } };
    }
    case 'ask': {
      const a = raw.ask;
      if (!isObj(a) || !isText(a.tool) || (a.agentId !== undefined && !isText(a.agentId))) return bad('bad ask');
      return { ok: true, record: { ...head, ask: a.agentId === undefined ? { tool: a.tool } : { tool: a.tool, agentId: a.agentId } } };
    }
    case 'end': {
      if (raw.reason !== undefined && !isText(raw.reason)) return bad('bad end');
      return { ok: true, record: raw.reason === undefined ? head : { ...head, reason: raw.reason } };
    }
    default:
      return bad('unknown kind');
  }
}

// --- the shapes the host's displays already read ------------------------------------------------------------------------

// quota.js's names for the two windows the CLI reports. Any other kind keeps its own name (a gateway's `spend_limit`).
const WINDOW_NAMES = Object.freeze({ five_hour: { key: 'session', label: '5h' }, seven_day: { key: 'weekly_all', label: 'week' } });

/**
 * The quota windows (host/quota.js normalizeWindows' shape) for the mod's rate limits. The CLI reports no money, no severity and no
 * lock, so those are the same "none" a poll gives (`severity: 'normal'` lets the display colour by percent). The CLI does not say
 * which window binds either: the fullest one is shown as the binding limit.
 */
function windowsFromRateLimits(list) {
  const rows = (Array.isArray(list) ? list : []).filter(r => isObj(r) && typeof r.kind === 'string' && r.kind !== '' && isNum(r.percentUsed));
  const top = rows.reduce((m, r) => (m === null || r.percentUsed > m ? r.percentUsed : m), null);
  let marked = false;
  return rows.map((r) => {
    const named = WINDOW_NAMES[r.kind];
    const isActive = !marked && r.percentUsed === top;
    if (isActive) marked = true;
    return {
      key: named ? named.key : r.kind,
      label: named ? named.label : r.kind.replace(/_/g, ' '),
      percent: r.percentUsed,
      resetsAt: typeof r.resetsAt === 'string' && r.resetsAt !== '' ? r.resetsAt : null,
      severity: 'normal',
      isActive,
      usedDollars: null,
      remainingDollars: null,
      lockedReason: null,
    };
  });
}

/** The context window as host/hook-session.js readContext shapes it: `{ used, size }`, or null when the record cannot say. */
function contextFromUsage(usage) {
  const c = usage && typeof usage === 'object' ? usage.context : null;
  if (!isObj(c) || !isNum(c.window) || c.window <= 0) return null;
  if (isNum(c.tokens) && c.tokens >= 0) return { used: c.tokens, size: c.window };
  if (isNum(c.percent) && c.percent >= 0) {
    const used = Math.round((c.percent * c.window) / 100);
    return Number.isFinite(used) ? { used, size: c.window } : null;      // two huge finite numbers can still overflow
  }
  return null;
}

// --- the route ------------------------------------------------------------------------------------------------------

// `Authorization: Bearer <token>` -> the token, or '' for anything else (a query string is never read).
function bearerOf(header) {
  const m = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
  return m ? m[1] : '';
}

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::ffff:127.0.0.1';
}

function createModServer({ token, onRecord = () => {}, maxBytes = MAX_BODY_BYTES, log = () => {} } = {}) {
  let port = null;

  const reply = (res, status, close = false) => {
    res.writeHead(status, close ? { connection: 'close', 'content-length': '0' } : { 'content-length': '0' });
    res.end();
  };

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return reply(res, 403, true);
    // A web page can reach this address; it always sends an Origin, and the mod never does.
    if (req.headers.origin !== undefined) return reply(res, 403, true);
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403, true);
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return reply(res, 400, true); }
    if (url.pathname !== '/mod') return reply(res, 404, true);
    if (req.method !== 'POST') return reply(res, 405, true);
    const verdict = allowConnection({ origin: undefined, token: bearerOf(req.headers.authorization) }, { expectedToken: token });
    if (!verdict.ok) return reply(res, 401, true);

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.on('finish', () => req.socket.destroySoon());
      return reply(res, 413, true);
    }
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (c) => {
      if (refused) return;
      size += c.length;
      if (size > maxBytes) {
        refused = true;
        res.on('finish', () => req.socket.destroySoon());
        reply(res, 413, true);
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { /* the client went away */ });
    req.on('end', () => {
      if (refused) return;
      const parsed = parseRecord(Buffer.concat(chunks).toString('utf8'));
      if (!parsed.ok) return reply(res, 400);
      reply(res, 204);
      // After the answer: the mod never waits on what the host does with a record, and a consumer that throws is the host's bug.
      try { onRecord(parsed.record); } catch (err) { log(`mod record handler threw: ${err && err.message}`); }
    });
  });
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          port = server.address().port;
          resolve(port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
    address: () => server.address(),
    port: () => port,
  };
}

module.exports = {
  parseRecord, windowsFromRateLimits, contextFromUsage, createModServer, isLoopbackAddress,
  RECORD_VERSION, MAX_BODY_BYTES, MAX_AGENTS, MAX_RATE_LIMITS,
};
