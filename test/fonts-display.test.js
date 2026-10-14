'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fd = require('../app/fonts-display');

test('sanitizeFamily keeps a plain family name and refuses anything that could break out of a CSS font stack', () => {
  assert.strictEqual(fd.sanitizeFamily('Cascadia Mono'), 'Cascadia Mono');
  assert.strictEqual(fd.sanitizeFamily('  Fira Code  '), 'Fira Code');
  for (const bad of ['', '   ', 'a"b', 'a\\b', 'a;b', 'a{b', 'a}b', 'a<b', 'a>b', 'a\nb', 'a\u0000b', 'x'.repeat(101), null, undefined, 5, {}, []]) {
    assert.strictEqual(fd.sanitizeFamily(bad), null, JSON.stringify(bad));
  }
});

test('sanitizeSize rounds into 10..24 and treats a non-number as unset (never a confident zero)', () => {
  assert.strictEqual(fd.sanitizeSize(14), 14);
  assert.strictEqual(fd.sanitizeSize(13.6), 14);
  assert.strictEqual(fd.sanitizeSize(3), 10);
  assert.strictEqual(fd.sanitizeSize(99), 24);
  for (const bad of [null, undefined, '16', NaN, Infinity, {}, true]) assert.strictEqual(fd.sanitizeSize(bad), null, String(bad));
});

test('sanitizeSettings defaults every field and drops unknown keys', () => {
  assert.deepStrictEqual(fd.sanitizeSettings(undefined), { terminalFont: null, terminalSize: null, uiFont: null });
  assert.deepStrictEqual(fd.sanitizeSettings('x'), { terminalFont: null, terminalSize: null, uiFont: null });
  assert.deepStrictEqual(
    fd.sanitizeSettings({ terminalFont: 'Fira Code', terminalSize: 16, uiFont: 'Segoe UI', extra: 1 }),
    { terminalFont: 'Fira Code', terminalSize: 16, uiFont: 'Segoe UI' });
  assert.deepStrictEqual(fd.sanitizeSettings({ terminalFont: 'a;b', terminalSize: '16', uiFont: 3 }),
    { terminalFont: null, terminalSize: null, uiFont: null });
});

test('stackFor puts the pick first and always keeps the fallback stack behind it', () => {
  const mono = fd.stackFor(null, 'mono');
  assert.match(mono, /monospace$/);
  assert.strictEqual(fd.stackFor('Fira Code', 'mono'), `"Fira Code", ${mono}`);
  const ui = fd.stackFor(null, 'ui');
  assert.match(ui, /sans-serif$/);
  assert.strictEqual(fd.stackFor('Inter', 'ui'), `"Inter", ${ui}`);
  assert.strictEqual(fd.stackFor('a"b', 'ui'), ui, 'an unsafe family never reaches the stack');
});

test('effectiveTerminal: project override wins over the app-wide pick, which wins over the theme', () => {
  const theme = { family: 'Theme Font, monospace', size: 12 };
  const settings = { terminalFont: 'Global', terminalSize: 18, uiFont: null };
  assert.deepStrictEqual(fd.effectiveTerminal({ settings, projectFont: 'Project', themeFont: theme }),
    { fontFamily: fd.stackFor('Project', 'mono'), fontSize: 18 });
  assert.deepStrictEqual(fd.effectiveTerminal({ settings, projectFont: null, themeFont: theme }),
    { fontFamily: fd.stackFor('Global', 'mono'), fontSize: 18 });
  assert.deepStrictEqual(fd.effectiveTerminal({ settings: fd.sanitizeSettings(null), projectFont: null, themeFont: theme }),
    { fontFamily: 'Theme Font, monospace', fontSize: 12 });
  assert.deepStrictEqual(fd.effectiveTerminal({ settings: fd.sanitizeSettings(null), projectFont: null, themeFont: null }),
    { fontFamily: fd.stackFor(null, 'mono'), fontSize: fd.DEFAULT_TERMINAL_SIZE });
});

test('effectiveTerminal: a project override keeps its pick even when the app-wide font is unset', () => {
  const r = fd.effectiveTerminal({ settings: fd.sanitizeSettings(null), projectFont: 'Project', themeFont: { size: 13 } });
  assert.strictEqual(r.fontFamily, fd.stackFor('Project', 'mono'));
  assert.strictEqual(r.fontSize, 13);
});

test('isFixedWidth is true only when narrow and wide glyphs measure alike', () => {
  assert.strictEqual(fd.isFixedWidth(() => 8), true);
  assert.strictEqual(fd.isFixedWidth((t) => (t.startsWith('i') ? 4 : 11)), false);
  assert.strictEqual(fd.isFixedWidth(() => NaN), false);
  assert.strictEqual(fd.isFixedWidth(() => 0), false, 'a font that measures nothing is not a fixed-width font');
  assert.strictEqual(fd.isFixedWidth(() => { throw new Error('x'); }), false);
  assert.strictEqual(fd.isFixedWidth(null), false);
});

test('parseFamilyList sorts, dedupes and drops blanks, vertical (@) and oversize names', () => {
  const out = fd.parseFamilyList('Zed\r\nArial\n\n@Vertical\nArial\n  Consolas  \n' + 'x'.repeat(200) + '\n');
  assert.deepStrictEqual(out, ['Arial', 'Consolas', 'Zed']);
  assert.deepStrictEqual(fd.parseFamilyList(undefined), []);
  assert.deepStrictEqual(fd.parseFamilyList(42), []);
});

test('filterFonts searches case-insensitively and can keep only fixed-width families', () => {
  const list = ['Arial', 'Cascadia Mono', 'Cascadia Code', 'Consolas'];
  const fixed = new Set(['Cascadia Mono', 'Cascadia Code', 'Consolas']);
  const isFixed = (f) => fixed.has(f);
  assert.deepStrictEqual(fd.filterFonts(list, 'cas'), ['Cascadia Mono', 'Cascadia Code']);
  assert.deepStrictEqual(fd.filterFonts(list, '', { fixedOnly: true, isFixed }), ['Cascadia Mono', 'Cascadia Code', 'Consolas']);
  assert.deepStrictEqual(fd.filterFonts(list, 'a', { fixedOnly: true, isFixed }), ['Cascadia Mono', 'Cascadia Code', 'Consolas']);
  assert.deepStrictEqual(fd.filterFonts(list, 'zzz'), []);
  assert.deepStrictEqual(fd.filterFonts(null, 'a'), []);
  assert.deepStrictEqual(fd.filterFonts(list, '  ARIAL '), ['Arial'], 'the query is trimmed');
  assert.deepStrictEqual(fd.filterFonts(list, undefined), list);
});

test('sectionView says "reading" before the settings are known and never shows a guessed size', () => {
  const unknown = fd.sectionView(null, null);
  assert.strictEqual(unknown.known, false);
  assert.strictEqual(unknown.size, null);
  const v = fd.sectionView({ terminalFont: 'Fira Code', terminalSize: null, uiFont: null }, 'Project Font');
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.size, fd.DEFAULT_TERMINAL_SIZE);
  assert.strictEqual(v.terminalFont, 'Fira Code');
  assert.strictEqual(v.uiFont, null);
  assert.strictEqual(v.projectFont, 'Project Font');
});
