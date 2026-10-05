'use strict';
/**
 * The page Claude wrote for its panel, wrapped in the host's policy (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md).
 *
 * THE PAGE IS UNTRUSTED. It runs in a WebContentsView of its own (app/canvas-views.js: its own partition, a dead proxy,
 * no DNS, no app bridge) and this module builds the first wall around it: a Content-Security-Policy <meta> written BEFORE
 * the page, so the page's own looser <meta> can't loosen it (the first policy wins; measured by
 * verify/probe-canvas-sandbox.js, which also shows what the CSP alone does NOT stop: WebRTC and DNS prefetch).
 *
 * `connect-src` is always 'none'. The panel's `fetch` is replaced, before any page code runs, by the shim below: it
 * calls the two-function bridge the panel's preload exposes (`window.claudePanel`), and main makes the request, only to
 * a host the person approved for that panel (app/canvas-fetch.js). That is also what lets the panel ask "Allow for this
 * panel / Deny" the moment the page first reaches for a new host, with no reload.
 */

// The policy's directive count: the property test holds the CSP to it.
const CSP_DIRECTIVES = 8;

const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;

/**
 * A plain http(s) origin from whatever string the page or the list gave, else null. A bare host is https. Credentials,
 * wildcards, other schemes, anything with a space or a quote: refused. Default ports fold away (URL does it).
 */
function hostOrigin(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw.includes('://') ? raw : 'https://' + raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!HOST_NAME.test(u.hostname)) return null;
  return `${u.protocol}//${u.host}`;
}

/** The policy text. No input: nothing the panel is shown can add a source. */
function buildCsp() {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

// Runs in the panel's page before anything the page wrote. Written as a function so it reads and lints as code, then sent as
// its source. It carries no `</script` and no template placeholders: it is placed in the document verbatim.
function shim() {
  const panel = window.claudePanel;
  if (!panel || typeof panel.fetch !== 'function') return;
  const NO_BODY = { 101: 1, 204: 1, 205: 1, 304: 1 };
  const toBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const headerObject = (h) => {
    const out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => { out[k] = v; });
    else if (Array.isArray(h)) h.forEach((p) => { out[p[0]] = p[1]; });
    else Object.keys(h).forEach((k) => { out[k] = h[k]; });
    return out;
  };
  window.fetch = function (input, init) {
    return new Promise((resolve, reject) => {
      try {
        const asRequest = typeof Request === 'function' && input instanceof Request;
        const url = asRequest ? input.url : String(input);
        const opts = init || {};
        if (opts.body !== undefined && opts.body !== null && typeof opts.body !== 'string') throw new TypeError('Only a string body can be sent from this panel');
        panel.fetch(url, {
          method: opts.method || (asRequest ? input.method : 'GET'),
          headers: headerObject(opts.headers || (asRequest ? input.headers : null)),
          body: typeof opts.body === 'string' ? opts.body : undefined,
        }).then((r) => {
          if (!r || r.ok !== true) { reject(new TypeError('Failed to fetch: ' + (r && r.error ? r.error : 'refused'))); return; }
          resolve(new Response(NO_BODY[r.status] ? null : toBytes(r.bodyBase64), { status: r.status, statusText: r.statusText, headers: r.headers }));
        }, (err) => reject(new TypeError('Failed to fetch: ' + (err && err.message ? err.message : 'refused'))));
      } catch (err) { reject(err); }
    });
  };
}
const PANEL_SHIM = `(${shim.toString()})();`;

/**
 * The document the panel's view loads: the host's policy and shim first, then Claude's page verbatim. The page lands in
 * <body>: a <head> or <html> of its own merges into ours and its tags there are ignored, which is harmless.
 */
function buildPage(html) {
  const page = typeof html === 'string' ? html : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${buildCsp()}">`
    + `<script>${PANEL_SHIM}</script></head><body>${page}`;
}

module.exports = { hostOrigin, buildCsp, buildPage, PANEL_SHIM, CSP_DIRECTIVES };
