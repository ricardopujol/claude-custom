'use strict';
/**
 * The GitHub page of a PR, from `origin`'s URL (documentation/DESIGN_GIT_TREE.md, "Enhancement #46":
 * *Open PR #N*). Pure.
 *
 *   repoUrl(remote)      'https://github.com/<owner>/<repo>' or null
 *   prUrl(repoUrl, n)    '<repoUrl>/pull/<n>' or null
 *
 * Null (no remote, not GitHub, unreadable) disables the action and it says why. Only the owner and the
 * repo come out of a remote's URL: a token in it (`https://user:token@github.com/o/r.git`) is dropped
 * and never reaches a message, a page or the browser.
 */

const HOST = 'github\\.com';
const SCP = new RegExp(`^[\\w.-]+@${HOST}:([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`, 'i');
const URL_FORM = new RegExp(`^(?:https?|ssh|git)://(?:[^@/\\s]+@)?${HOST}(?::\\d+)?/([^/\\s?#]+)/([^/\\s?#]+?)(?:\\.git)?/?$`, 'i');
const NAME = /^[A-Za-z0-9_.-]+$/;

/** `{ owner, repo }` for a GitHub remote URL (https, ssh, git or scp-like), else null. */
function parseRemoteUrl(remote) {
  if (typeof remote !== 'string') return null;
  const s = remote.trim();
  const m = URL_FORM.exec(s) || SCP.exec(s);
  if (!m) return null;
  const [, owner, repo] = m;
  const ok = n => NAME.test(n) && n !== '.' && n !== '..';
  return ok(owner) && ok(repo) ? { owner, repo } : null;
}

function repoUrl(remote) {
  const p = parseRemoteUrl(remote);
  return p ? `https://github.com/${p.owner}/${p.repo}` : null;
}

function prUrl(repo, n) {
  if (typeof repo !== 'string' || !repo) return null;
  return Number.isInteger(n) && n > 0 ? `${repo}/pull/${n}` : null;
}

module.exports = { repoUrl, prUrl, parseRemoteUrl };
