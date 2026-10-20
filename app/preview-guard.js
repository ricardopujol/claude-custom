'use strict';
/**
 * The Preview panel's one URL rule (BACKLOG #119 A4). Pure: no Electron, no clock, no network.
 *
 * THE PANEL SHOWS A DEV SERVER THE CLI STARTED, and nothing else. So an address is accepted only if it is plain http, on one of
 * three loopback hosts (127.0.0.1, localhost, [::1]), with a port in 1-65535 and no credentials. Everything else is refused, and
 * the refusal is shown on a line of the header. main wires this to every way a page can move: will-navigate, will-redirect,
 * will-frame-navigate, window.open and a typed address (app/preview-views.js).
 *
 * WHY EXACT HOST NAMES. A prefix or suffix test would pass `127.0.0.1.evil.example` or `localhost.evil.example`. The URL class
 * also normalises the odd spellings (`http://127.1`, `http://0x7f.0.0.1`) to `127.0.0.1`, so the hostname compared is the
 * normalised one and those are, correctly, loopback. A trailing-dot `localhost.` is a different name and is refused.
 *
 * WHY NO HTTPS. A dev server on loopback speaks http; an https address there would mean a certificate the panel cannot check,
 * and the rule is kept to one scheme so there is one thing to reason about.
 */

const { externalUrl } = require('./external-link');

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
// Long enough for a GET form or an API call with a big query on loopback (PR #198 Dexter 5); the cap exists only to bound what is parsed.
const MAX_LENGTH = 32768;
// THE APP'S OWN LOOPBACK PORTS (PR #198 Miguel Y3): the session hosts' range (host/port-for-project.js). The page may never reach them, by
// navigation or by request: each demands a token, and this is the second wall. `extra` adds ports the caller knows (the probe driver's).
const { PORT_BASE, PORT_SPAN } = require('../host/port-for-project');
const isAppPort = (port, extra) => (port >= PORT_BASE && port < PORT_BASE + PORT_SPAN) || (Array.isArray(extra) && extra.includes(port));

const refuse = (reason) => ({ ok: false, reason });

/** previewUrl(input, { denyPorts }) -> { ok: true, url, host, port } | { ok: false, reason }. Total: never throws. */
function previewUrl(input, opts) {
  if (typeof input !== 'string') return refuse('not an address');
  const s = input.trim();
  if (s === '' || s.length > MAX_LENGTH) return refuse('not an address');
  let u;
  try { u = new URL(s); } catch { return refuse('not an address'); }
  if (u.protocol !== 'http:') return refuse('only http addresses can be previewed');
  if (u.username !== '' || u.password !== '') return refuse('an address with a name or password in it');
  if (!LOOPBACK_HOSTS.includes(u.hostname)) return refuse('only this computer (localhost, 127.0.0.1 or [::1]) can be previewed');
  const port = u.port === '' ? 80 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse('the port must be between 1 and 65535');
  if (isAppPort(port, opts && opts.denyPorts)) return refuse('that port belongs to this app');
  if (u.href.length > MAX_LENGTH) return refuse('not an address');
  return { ok: true, url: u.href, host: u.hostname, port };
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PORT_ONLY = /^:?(\d{1,5})$/;

/** What the URL field accepts: a bare port (`3000`, `:3000`), `host:port/path`, or a full http address. Same verdicts as previewUrl. */
function fromTyped(text) {
  if (typeof text !== 'string') return refuse('not an address');
  const s = text.trim();
  if (s === '') return refuse('not an address');
  const bare = PORT_ONLY.exec(s);
  if (bare) return previewUrl(`http://localhost:${Number(bare[1])}/`);
  return previewUrl(HAS_SCHEME.test(s) ? s : `http://${s}`);
}

/** The loopback address of a listening port, or a refusal when the port is not an integer in 1-65535. */
function forPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse('the port must be between 1 and 65535');
  return previewUrl(`http://localhost:${port}/`);
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * The line the header shows when a navigation was refused: what the page reached for, in a few plain words. Never the path or the
 * query (they can carry a token) and never credentials.
 */
function blockedLabel(target, opts) {
  const odd = 'blocked: an address that is not a web address';
  if (typeof target !== 'string') return odd;
  if (target.length > MAX_LENGTH) return `blocked: an address longer than ${MAX_LENGTH} characters`;
  let u;
  try { u = new URL(target.trim()); } catch { return odd; }
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname) && isAppPort(u.port === '' ? 80 : Number(u.port), opts && opts.denyPorts)) return 'blocked: a port this app uses';
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname ? `blocked: ${clip(u.hostname, 60)}` : odd;
  if (u.protocol === 'file:') return 'blocked: a file address';
  if (/^[a-z][a-z0-9+.-]{0,20}:$/.test(u.protocol)) return `blocked: a ${u.protocol} address`;
  return odd;
}

const SCHEME_WITHOUT_SLASHES = /^(javascript|data|vbscript|blob|about|view-source|mailto|tel):/i;

/** blockedLabel for a typed address that fromTyped refused (it may have no scheme: `example.com`, `70000`). */
function typedLabel(text) {
  const odd = 'blocked: an address that is not a web address';
  if (typeof text !== 'string') return odd;
  const s = text.trim();
  if (s === '') return odd;
  if (PORT_ONLY.test(s)) return 'blocked: a port that is not 1-65535';
  return blockedLabel(HAS_SCHEME.test(s) || SCHEME_WITHOUT_SLASHES.test(s) ? s : `http://${s}`);
}

/**
 * May the panel's page make THIS request? The session filter behind the navigation rule: it also covers images, scripts, sockets and
 * frames, and an address given as an IP literal (which needs no DNS, so the process-wide resolver rule does not stop it). Loopback http
 * and ws on any port (a dev server's own assets and hot-reload socket), the page-internal data: and blob:, and the DevTools window's own
 * scheme. Nothing that leaves this computer.
 */
function requestAllowed(url, opts) { return requestVerdict(url, opts).ok; }

const BLOB_LOOPBACK = /^blob:http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:(\d+))?\//;

/** requestAllowed with the reason a header line needs: { ok } or { ok: false, tooLong: true } (a loopback request cut for its length). */
function requestVerdict(url, opts) {
  const no = { ok: false };
  if (typeof url !== 'string' || url === '') return no;
  if (url.length > MAX_LENGTH) return { ok: false, tooLong: true };
  let u;
  try { u = new URL(url); } catch { return no; }
  if (u.protocol === 'data:' || u.protocol === 'devtools:') return { ok: true };
  if (u.protocol === 'blob:') {
    const m = BLOB_LOOPBACK.exec(url);
    return m && !isAppPort(m[3] === undefined ? 80 : Number(m[3]), opts && opts.denyPorts) ? { ok: true } : no;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return no;
  if (u.username !== '' || u.password !== '') return no;
  if (!LOOPBACK_HOSTS.includes(u.hostname)) return no;
  return isAppPort(u.port === '' ? 80 : Number(u.port), opts && opts.denyPorts) ? no : { ok: true };
}

/**
 * May a FRAME (an iframe, in any depth) go to this address? ONE rule with the request filter above, which is why it is built on it (PR #198
 * Dexter 2 / Miguel Y4): the page's own loopback http pages, a blob: of the previewed loopback origin, a data: document and about:srcdoc/blank
 * (their origin is opaque, they reach nothing the page itself could not, and every request they make passes the filter). Never another site.
 * The MAIN frame is stricter: previewUrl only.
 */
function frameAllowed(url, opts) {
  if (typeof url !== 'string') return false;
  if (url === 'about:srcdoc' || url === 'about:blank') return true;
  if (previewUrl(url, opts).ok) return true;
  return /^(data|blob):/i.test(url.trim()) && requestAllowed(url.trim(), opts);
}

/** What may be handed to the operating system's browser: http(s) only, by the same rule links in the terminal follow. */
function openExternalTarget(url) { return externalUrl(url); }

module.exports = { previewUrl, fromTyped, forPort, blockedLabel, typedLabel, openExternalTarget, requestAllowed, requestVerdict, frameAllowed, isAppPort, MAX_LENGTH, LOOPBACK_HOSTS };
