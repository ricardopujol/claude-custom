'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveTheme, FALLBACK_FONTS } = require('../host/themes');

function registry(projects, themes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-themes-'));
  fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2));
  for (const [name, body] of Object.entries(themes)) {
    fs.writeFileSync(path.join(dir, 'themes', name + '.json'), JSON.stringify(body, null, 2));
  }
  return dir;
}

const AMBER = {
  name: 'amber-warm',
  terminal: { background: '#1a1410', foreground: '#e8d5b7', cursor: '#d08c4a' },
  chrome: { bg: '#120e0a', accent: '#d08c4a' },
  font: { family: 'CaskaydiaCove Nerd Font', size: 14 },
};

test('resolves a project to its configured theme', () => {
  const dir = registry({ 'C:/work/komodo': 'amber-warm' }, { 'amber-warm': AMBER });
  const t = resolveTheme('C:/work/komodo', { registryDir: dir });
  assert.strictEqual(t.name, 'amber-warm');
  assert.strictEqual(t.terminal.background, '#1a1410');
});

test('path matching ignores slash direction', () => {
  // The registry is keyed by path and the host may receive either form.
  const dir = registry({ 'C:/work/komodo': 'amber-warm' }, { 'amber-warm': AMBER });
  const t = resolveTheme('C:\\work\\komodo', { registryDir: dir });
  assert.strictEqual(t.name, 'amber-warm');
});

test('path matching ignores case on Windows', () => {
  const dir = registry({ 'C:/Work/Komodo': 'amber-warm' }, { 'amber-warm': AMBER });
  const t = resolveTheme('c:/work/komodo', { registryDir: dir });
  assert.strictEqual(t.name, 'amber-warm');
});

test('a trailing separator does not defeat the match', () => {
  const dir = registry({ 'C:/work/komodo': 'amber-warm' }, { 'amber-warm': AMBER });
  assert.strictEqual(resolveTheme('C:/work/komodo/', { registryDir: dir }).name, 'amber-warm');
});

test('falls back to the "*" entry for unlisted projects', () => {
  const dir = registry({ 'C:/work/komodo': 'amber-warm', '*': 'amber-warm' }, { 'amber-warm': AMBER });
  assert.strictEqual(resolveTheme('C:/somewhere/else', { registryDir: dir }).name, 'amber-warm');
});

test('falls back to the built-in default when nothing matches', () => {
  const dir = registry({}, {});
  const t = resolveTheme('C:/anywhere', { registryDir: dir });
  assert.strictEqual(t.name, 'default');
  assert.ok(t.terminal.background, 'default theme must be usable as-is');
});

test('a missing registry directory yields the default rather than throwing', () => {
  // The registry is optional; a first run has no themes at all.
  const t = resolveTheme('C:/anywhere', { registryDir: path.join(os.tmpdir(), 'cc-absent-' + Date.now()) });
  assert.strictEqual(t.name, 'default');
});

test('malformed projects.json yields the default rather than crashing the host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-themes-'));
  fs.writeFileSync(path.join(dir, 'projects.json'), '{ this is not json');
  const t = resolveTheme('C:/anywhere', { registryDir: dir });
  assert.strictEqual(t.name, 'default');
});

test('a project pointing at a missing theme file yields the default', () => {
  const dir = registry({ 'C:/work/komodo': 'does-not-exist' }, {});
  assert.strictEqual(resolveTheme('C:/work/komodo', { registryDir: dir }).name, 'default');
});

test('a partial theme file is completed from the default', () => {
  // Otherwise a theme specifying only a background produces an unusable GUI.
  const dir = registry({ '*': 'sparse' }, { sparse: { name: 'sparse', terminal: { background: '#000000' } } });
  const t = resolveTheme('C:/anywhere', { registryDir: dir });
  assert.strictEqual(t.terminal.background, '#000000');
  assert.ok(t.terminal.foreground, 'foreground should come from the default');
  assert.ok(t.chrome && t.chrome.bg, 'chrome should come from the default');
});

test('the font stack always ends in glyph-complete fallbacks', () => {
  // Claude Code's TUI uses box-drawing and braille spinners. A per-project font
  // without that coverage renders the UI as tofu, so the chain is enforced
  // rather than trusted to whoever wrote the theme file.
  const dir = registry({ '*': 'fancy' }, { fancy: { name: 'fancy', font: { family: 'Some Display Face' } } });
  const t = resolveTheme('C:/anywhere', { registryDir: dir });
  assert.ok(t.font.family.startsWith('"Some Display Face"'), t.font.family);
  for (const f of FALLBACK_FONTS) {
    assert.ok(t.font.family.includes(f), `missing fallback ${f} in ${t.font.family}`);
  }
});

test('an exact project entry beats the wildcard', () => {
  const dir = registry(
    { 'C:/work/komodo': 'amber-warm', '*': 'cold' },
    { 'amber-warm': AMBER, cold: { name: 'cold', terminal: { background: '#0b1020' } } }
  );
  assert.strictEqual(resolveTheme('C:/work/komodo', { registryDir: dir }).name, 'amber-warm');
});

test('exposes a 16-colour ANSI palette for the terminal', () => {
  const dir = registry({}, {});
  const t = resolveTheme('C:/anywhere', { registryDir: dir });
  for (const key of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
                     'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
                     'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.terminal[key] || ''), `bad or missing ANSI ${key}`);
  }
});
