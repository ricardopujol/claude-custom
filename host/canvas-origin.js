'use strict';
/**
 * What counts as a host for Claude's panel (BACKLOG #71): ONE rule, used by the panel's main-process side (app/canvas-csp.js,
 * app/canvas-fetch.js, app/canvas-views.js) and by the host's store (host/canvas-store.js). It lives on the host side, which the app
 * may require and the host never needs to reach into app/ for (PR #122 Miguel G8).
 */

// A DNS name is at most 253 characters: a longer one is the page filling the person's list (and memory) with junk, not a host (PR #122 Miguel G3).
const MAX_HOST_CHARS = 253;
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
  if (u.hostname.length > MAX_HOST_CHARS || !HOST_NAME.test(u.hostname)) return null;
  return `${u.protocol}//${u.host}`;
}

module.exports = { hostOrigin, MAX_HOST_CHARS };
