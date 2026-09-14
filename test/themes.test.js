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

test('a theme face goes first, and the fallbacks all stay behind it', () => {
  // RENAMED. This was called "the font stack always ends in glyph-complete
  // fallbacks" and asserted that the chain contains every entry of
  // FALLBACK_FONTS -- which is true by construction, whatever the list happens
  // to say. It never checked coverage, so it passed just as happily when the
  // list led with a font nobody has and carried Consolas, which cannot draw a
  // single braille dot, one position behind the only complete face.
  //
  // Coverage cannot be measured here: it depends on what is installed. That is
  // verify/probe-fonts.js, which reads each font's cmap. This pins the part
  // that IS a pure function -- the ordering contract.
  const dir = registry({ '*': 'fancy' }, { fancy: { name: 'fancy', font: { family: 'Some Display Face' } } });
  const t = resolveTheme('C:/anywhere', { registryDir: dir });
  assert.ok(t.font.family.startsWith('"Some Display Face"'), t.font.family);
  for (const f of FALLBACK_FONTS) {
    assert.ok(t.font.family.includes(f), `missing fallback ${f} in ${t.font.family}`);
  }
});

test('the fallbacks keep their declared order in the resolved stack', () => {
  // That the RESOLVER preserves order. Worth having on its own -- buildFontStack
  // filters and re-joins, and a filter that reordered would be silent.
  const t = resolveTheme('C:/anywhere', { registryDir: registry({}, {}) });
  const chain = t.font.family.split(',').map(x => x.trim());
  const positions = FALLBACK_FONTS.map(f => chain.indexOf(f));
  assert.ok(positions.every(p => p >= 0), `${t.font.family}`);
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      `${FALLBACK_FONTS[i]} must stay behind ${FALLBACK_FONTS[i - 1]} in ${t.font.family}`);
  }
});

test('the fallback ORDER is what was measured, pinned literally', () => {
  // The test above uses FALLBACK_FONTS as its own oracle, so it cannot notice
  // the LIST being reordered -- swapping two entries left it green. Found by
  // mutation, and it is the third self-referential assertion this project has
  // shipped: a test whose expected value is derived from the thing under test
  // can only ever agree with it.
  //
  // So the order is pinned to literals. CSS falls through per family and per
  // CHARACTER, which makes this ordering load-bearing rather than cosmetic: a
  // partially-covered face early in the chain hands over its own broken subset
  // before a complete face behind it is consulted.
  //
  // Changing this list is a decision, not a tidy-up. Re-run
  // verify/probe-fonts.js against real cmaps and update the measurements in
  // host/themes.js in the same commit.
  assert.deepStrictEqual(FALLBACK_FONTS, [
    '"CaskaydiaCove Nerd Font"',
    '"Cascadia Mono"',
    '"Cascadia Code"',
    '"Segoe UI Symbol"',
    'monospace',
  ]);
});

test('the generic family is last, so nothing is stranded behind it', () => {
  // `monospace` matches everything, so any face listed after it is unreachable.
  assert.strictEqual(FALLBACK_FONTS[FALLBACK_FONTS.length - 1], 'monospace');
  assert.strictEqual(FALLBACK_FONTS.filter(f => f === 'monospace').length, 1);
});

test('no font known to lack braille is in the stack', () => {
  // Measured by verify/probe-fonts.js against the real cmaps on 2026-09-14:
  // Consolas covers box drawing 11/11 and blocks 8/8 but braille 0/7. Claude
  // Code's spinner is braille, so a chain that can reach Consolas can render
  // the spinner as tofu. It bought nothing over generic `monospace` -- which on
  // Windows typically resolves to Consolas anyway -- so it is out.
  const KNOWN_INCOMPLETE = ['Consolas', '"Consolas"'];
  for (const bad of KNOWN_INCOMPLETE) {
    assert.ok(!FALLBACK_FONTS.includes(bad),
      `${bad} cannot draw braille and must not be in the fallback chain`);
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
