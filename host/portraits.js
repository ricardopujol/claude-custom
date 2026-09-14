'use strict';
/**
 * Portrait lookup — convention over configuration.
 *
 *   portraits/<agent-name>/<state>.png   exists? -> use it
 *   else                                         -> generated placeholder
 *
 * Keyed on the agent's filename, so this requires ZERO edits to any agent .md
 * file. That matters: editing those triggers the mandatory /align-agents sync.
 *
 * v1 generates ~15 named agents x 4 states. The other ~65 agents must still
 * render, hence placeholders being a first-class result rather than an error.
 */

const fs = require('fs');
const path = require('path');

const BUILTIN_STATES = ['sleeping', 'working', 'happy', 'stressed'];

// Agent names key straight into a filesystem path. A name is only ever a single
// path segment; anything else is refused rather than resolved.
function safeSegment(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (path.isAbsolute(name)) return null;
  return name;
}

// Stable per-agent hue so an agent keeps the same placeholder between frames;
// one that changed colour would read as a different agent entirely.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function placeholderFor(agent) {
  const name = String(agent || '?');
  const words = name.split(/[-_\s]+/).filter(Boolean);
  const initials = (words.length >= 2
    ? words[0][0] + words[1][0]
    : name.slice(0, 2)
  ).toUpperCase();

  return { kind: 'placeholder', agent: name, initials, hue: hashString(name) % 360 };
}

function listStates({ portraitsDir } = {}) {
  if (portraitsDir) {
    try {
      const raw = fs.readFileSync(path.join(portraitsDir, 'states.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* unconfigured is the normal case */ }
  }
  return [...BUILTIN_STATES];
}

function portraitFor(agent, state, { portraitsDir } = {}) {
  const safeAgent = safeSegment(agent);
  const safeState = safeSegment(state);
  if (!portraitsDir || !safeAgent || !safeState) return placeholderFor(agent);

  const file = path.join(portraitsDir, safeAgent, safeState + '.png');
  try {
    if (fs.statSync(file).isFile()) return { kind: 'file', agent: safeAgent, state: safeState, path: file };
  } catch { /* fall through to the placeholder */ }

  return placeholderFor(agent);
}

module.exports = { portraitFor, placeholderFor, listStates, BUILTIN_STATES };
