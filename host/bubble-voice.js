'use strict';
/**
 * Whose voice a bubble speaks in (BACKLOG #80): the agent's own `.md`, project first (`<cwd>/.claude/agents/<name>.md`), then
 * the install's (`<config dir>/agents/<name>.md`). host/bubble-prompt.js's voiceFromMd turns the text into
 * { description, signOff }. No file, an unreadable one or a bad name: null, a neutral voice. Read-only.
 *
 * The name comes from a hook payload, so it is checked before it becomes part of a path (plain characters, no separators, no
 * leading dot). Results, nulls included, are cached for ttlMs so a busy agent doesn't re-read its file on every state change.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { voiceFromMd } = require('./bubble-prompt');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;

const validAgentName = (n) => typeof n === 'string' && NAME_RE.test(n) && !n.includes('..');

function createVoiceReader({ configDir, cwd, readFile = (p) => fsp.readFile(p, 'utf8'), now = Date.now, ttlMs = TTL_MS } = {}) {
  const cache = new Map();

  async function load(name) {
    const dirs = [cwd && path.join(cwd, '.claude', 'agents'), configDir && path.join(configDir, 'agents')].filter(Boolean);
    for (const dir of dirs) {
      let raw;
      try { raw = await readFile(path.join(dir, name + '.md')); } catch { continue; }
      return voiceFromMd(raw);
    }
    return null;
  }

  async function voiceOf(name) {
    if (!validAgentName(name)) return null;
    const hit = cache.get(name);
    if (hit && now() - hit.at < ttlMs) return hit.voice;
    const voice = await load(name);
    cache.delete(name);
    cache.set(name, { voice, at: now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return voice;
  }

  return { voiceOf };
}

module.exports = { createVoiceReader, validAgentName };
