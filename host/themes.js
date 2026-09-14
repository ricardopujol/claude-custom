'use strict';
/**
 * Theme registry, keyed by project path.
 *
 * Central by design: several of the target folders are not git repos, and
 * claude-custom must not litter them with config. Layout:
 *
 *   <registryDir>/projects.json    { "C:/path/to/project": "amber-warm", "*": "default" }
 *   <registryDir>/themes/<name>.json
 *
 * Every failure here resolves to the built-in default rather than throwing: the
 * registry is optional, a first run has none, and a typo in a colour file must
 * not take the session down.
 */

const fs = require('fs');
const path = require('path');

// Claude Code's TUI draws with box-drawing characters and braille spinners. A
// per-project font without that coverage renders as tofu, so these are appended
// to whatever a theme asks for rather than trusted to the theme author.
const FALLBACK_FONTS = [
  '"CaskaydiaCove Nerd Font"',
  '"Cascadia Mono"',
  'Consolas',
  'monospace',
];

const DEFAULT_THEME = {
  name: 'default',
  terminal: {
    background: '#11131a',
    foreground: '#c7cede',
    cursor: '#d08c4a',
    selectionBackground: '#2d3446',
    black: '#11131a', red: '#cc5f5f', green: '#5fb07a', yellow: '#d0a44a',
    blue: '#5f84cc', magenta: '#a77ccc', cyan: '#5fb0b0', white: '#c7cede',
    brightBlack: '#6d7689', brightRed: '#e07878', brightGreen: '#78c894',
    brightYellow: '#e8c06a', brightBlue: '#7a9ee0', brightMagenta: '#c098e0',
    brightCyan: '#78c8c8', brightWhite: '#e8edf7',
  },
  chrome: {
    bg: '#11131a',
    panel: '#171a23',
    border: '#262b38',
    text: '#c7cede',
    dim: '#6d7689',
    accent: '#d08c4a',
    ok: '#5fb07a',
    bad: '#cc5f5f',
  },
  font: { family: null, size: 14, lineHeight: 1.2 },
};

// Windows paths arrive with either slash direction and any casing.
function normalize(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function buildFontStack(family) {
  const chain = [...FALLBACK_FONTS];
  if (family) {
    const quoted = /[",]/.test(family) ? family : `"${family}"`;
    // A theme's own face goes first; the glyph-complete faces stay behind it.
    return [quoted, ...chain.filter(f => f !== quoted)].join(', ');
  }
  return chain.join(', ');
}

function merge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(base[k] || {}, v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function resolveTheme(projectPath, { registryDir } = {}) {
  const finish = theme => {
    const merged = merge(DEFAULT_THEME, theme || {});
    merged.font = { ...merged.font, family: buildFontStack(theme && theme.font && theme.font.family) };
    return merged;
  };

  if (!registryDir) return finish(null);

  const projects = readJson(path.join(registryDir, 'projects.json'));
  if (!projects || typeof projects !== 'object') return finish(null);

  const target = normalize(projectPath);
  let chosen = null;
  for (const [key, value] of Object.entries(projects)) {
    if (key !== '*' && normalize(key) === target) { chosen = value; break; }
  }
  if (!chosen && projects['*']) chosen = projects['*'];
  if (!chosen) return finish(null);

  const body = readJson(path.join(registryDir, 'themes', chosen + '.json'));
  if (!body) return finish(null);

  return finish(body);
}

module.exports = { resolveTheme, DEFAULT_THEME, FALLBACK_FONTS };
