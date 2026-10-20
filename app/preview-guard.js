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
const MAX_LENGTH = 2048;

const refuse = (reason) => ({ ok: false, reason });

/** previewUrl(input) -> { ok: true, url, host, port } | { ok: false, reason }. Total: never throws. */
function previewUrl(input) {
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
function blockedLabel(target) {
  const odd = 'blocked: an address that is not a web address';
  if (typeof target !== 'string') return odd;
  let u;
  try { u = new URL(target.trim()); } catch { return odd; }
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
function requestAllowed(url) {
  if (typeof url !== 'string' || url === '' || url.length > MAX_LENGTH * 4) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'devtools:') return u.protocol !== 'blob:' || /^blob:http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url);
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false;
  if (u.username !== '' || u.password !== '') return false;
  return LOOPBACK_HOSTS.includes(u.hostname);
}

/** What may be handed to the operating system's browser: http(s) only, by the same rule links in the terminal follow. */
function openExternalTarget(url) { return externalUrl(url); }

module.exports = { previewUrl, fromTyped, forPort, blockedLabel, typedLabel, openExternalTarget, requestAllowed, LOOPBACK_HOSTS };
