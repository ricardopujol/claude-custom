'use strict';
/**
 * What a link clicked in a tab may open in the person's browser
 * (fix/terminal-links, 2026-10-01): an http(s) URL, normalised, or null.
 *
 * WHY. Claude Code prints its links as OSC 8 hyperlinks. With no handler of
 * our own, xterm.js 5.5 ran its default one: a confirm() ("Do you want to
 * navigate to…"), then window.open() with NO url, meant to be filled in
 * afterwards. main's setWindowOpenHandler saw `about:blank`, handed it to
 * shell.openExternal, and Windows answered that no app opens that link. The
 * real URL never left the page.
 *
 * Only http and https reach the OS: shell.openExternal launches whatever
 * Windows associates with a scheme, so a `file:`, `ms-settings:` or
 * `javascript:` link printed by anything in the terminal must not be one
 * click away. (xterm 5.5 already drops non-http(s) OSC 8 links; this is the
 * boundary for everything else that reaches main.)
 *
 * What this does NOT cover (PR #81 Dexter F1): an OSC 8 link's visible text
 * can name one site and point at another. The old confirm() showed the real
 * target; now the hover line does (app/link-click.js targetText), and the
 * click opens without a prompt, as Ricardo chose on 2026-10-01.
 */

const MAX_LENGTH = 8192;
const OPENABLE = new Set(['http:', 'https:']);

function externalUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (s === '' || s.length > MAX_LENGTH) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  // (No empty-host check: `new URL` already throws for `https://`. Dexter F4.)
  if (!OPENABLE.has(url.protocol)) return null;
  // `https://github.com@evil.example/` reads as GitHub and goes elsewhere: a
  // link carrying credentials is refused (PR #81, Miguel #2).
  if (url.username !== '' || url.password !== '') return null;
  // The cap holds for what is opened too: percent-encoding can grow a link
  // nine-fold (Dexter F3), and normalising must stay idempotent.
  if (url.href.length > MAX_LENGTH) return null;
  return url.href;
}

module.exports = { externalUrl, MAX_LENGTH };
