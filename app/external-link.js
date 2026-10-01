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
 * click away. That is the protection the confirm() was standing in for.
 */

const MAX_LENGTH = 8192;
const OPENABLE = new Set(['http:', 'https:']);

function externalUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (s === '' || s.length > MAX_LENGTH) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (!OPENABLE.has(url.protocol) || url.hostname === '') return null;
  // `https://github.com@evil.example/` reads as GitHub and goes elsewhere: a
  // link carrying credentials is refused (PR #81, Miguel #2).
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

module.exports = { externalUrl, MAX_LENGTH };
