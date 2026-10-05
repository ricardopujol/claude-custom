'use strict';
/**
 * The policy that wraps the page Claude wrote for its panel (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md).
 *
 * THE PAGE IS UNTRUSTED. It runs in `<iframe sandbox="allow-scripts">` (an opaque origin: no preload bridge, no
 * parent, no storage) and this module builds the one thing that stops it reaching the network: a Content-Security-Policy
 * <meta> written BEFORE the page, so the page's own looser <meta> can't loosen it (the first policy wins; measured in
 * verify/probe-canvas-sandbox.js, which also pins that Chromium enforces what is built here).
 *
 * `connect-src` lists only the hosts the person approved for this panel; everything else is 'none'. Every host goes
 * through `hostOrigin`, so no string can add a directive, a wildcard or a second source: the property test in
 * test/canvas-csp.test.js feeds it hostile strings. A host this panel was never given is simply not in the policy.
 *
 * THE SHIM. A blocked fetch is silent. The host-written shim turns a `connect-src` violation into a message to the
 * parent ("this panel tried to reach <url>"), which is what lets the panel ask "Allow for this panel / Deny". The
 * page can fake that message, but all that does is make the panel ask a question; the CSP, not the shim, is the wall.
 *
 * WRAPPED IN AN IIFE: the renderer loads scripts as plain <script> tags sharing one global scope (CLAUDE.md, the first
 * trap). One name leaves it: `canvasCsp`.
 */
(function (root) {

// The policy's directive count: the property test holds the CSP to it, so no input can ever add one.
const CSP_DIRECTIVES = 8;

const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;

/**
 * A plain http(s) origin from whatever string the panel or the list gave, else null. A bare host is https. Credentials,
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

/** The host a blocked connection should ask about, from the violation's `blockedURI`; null for 'inline', 'eval', etc. */
function violationHost(blockedUri) {
  return typeof blockedUri === 'string' && blockedUri.includes('://') ? hostOrigin(blockedUri) : null;
}

/** The policy text for a list of approved hosts. Invalid entries are dropped, repeats listed once, order kept. */
function buildCsp(hosts) {
  const list = [];
  for (const h of Array.isArray(hosts) ? hosts : []) {
    const o = hostOrigin(h);
    if (o && !list.includes(o)) list.push(o);
  }
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    `connect-src ${list.length ? list.join(' ') : "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

// Runs in the sandboxed frame. No quotes or `<` inside, so it needs no escaping in the srcdoc.
const SHIM = "document.addEventListener('securitypolicyviolation',function(e){"
  + "if(String(e.violatedDirective).indexOf('connect-src')!==0)return;"
  + "try{parent.postMessage({kind:'canvas-need-host',url:String(e.blockedURI).slice(0,300)},'*')}catch(_){}});";

/**
 * The document the frame loads: the host's policy and shim first, then Claude's page verbatim. The page lands in <body>:
 * a <head> or <html> of its own merges into ours and its tags there are ignored, which is harmless.
 */
function buildSrcdoc(html, hosts) {
  const page = typeof html === 'string' ? html : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${buildCsp(hosts)}">`
    + `<script>${SHIM}</script></head><body>${page}`;
}

const API = { hostOrigin, violationHost, buildCsp, buildSrcdoc, CSP_DIRECTIVES };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.canvasCsp = API;

})(typeof window !== 'undefined' ? window : globalThis);
