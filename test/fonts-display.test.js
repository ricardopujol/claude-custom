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
  assert.deepStrictEqual(fd.sanitizeSettings(undefined), { terminalFont: null, terminalSize: null, uiFont: null, chatZoom: null });
  assert.deepStrictEqual(fd.sanitizeSettings('x'), { terminalFont: null, terminalSize: null, uiFont: null, chatZoom: null });
  assert.deepStrictEqual(
    fd.sanitizeSettings({ terminalFont: 'Fira Code', terminalSize: 16, uiFont: 'Segoe UI', chatZoom: 130, extra: 1 }),
    { terminalFont: 'Fira Code', terminalSize: 16, uiFont: 'Segoe UI', chatZoom: 130 });
  assert.deepStrictEqual(fd.sanitizeSettings({ terminalFont: 'a;b', terminalSize: '16', uiFont: 3, chatZoom: '130' }),
    { terminalFont: null, terminalSize: null, uiFont: null, chatZoom: null });
});

// --- #172: Ctrl+wheel over the chat view zooms its text, in steps of 10 %, 70 % to 200 %, remembered app-wide with the fonts ---------------

test('sanitizeChatZoom: a real number, clamped into 70..200 and rounded to a 10 % step; anything else is unset, never a confident 0', () => {
  assert.strictEqual(fd.sanitizeChatZoom(100), 100);
  assert.strictEqual(fd.sanitizeChatZoom(134), 130);
  assert.strictEqual(fd.sanitizeChatZoom(135), 140);
  assert.strictEqual(fd.sanitizeChatZoom(10), 70);
  assert.strictEqual(fd.sanitizeChatZoom(500), 200);
  for (const bad of [null, undefined, '130', NaN, Infinity, -Infinity, {}, true, []]) assert.strictEqual(fd.sanitizeChatZoom(bad), null, String(bad));
});

test('nextChatZoom: wheel up (a negative deltaY) is one step bigger, wheel down one step smaller, clamped at both ends', () => {
  assert.strictEqual(fd.nextChatZoom(100, -100), 110);
  assert.strictEqual(fd.nextChatZoom(100, 100), 90);
  assert.strictEqual(fd.nextChatZoom(100, -3), 110, 'a trackpad\'s small delta is still one step');
  assert.strictEqual(fd.nextChatZoom(200, -100), 200);
  assert.strictEqual(fd.nextChatZoom(70, 100), 70);
  assert.strictEqual(fd.nextChatZoom(null, -100), 110, 'unset starts from 100 %');
  for (const none of [0, NaN, undefined, '1']) assert.strictEqual(fd.nextChatZoom(120, none), 120, `no step for ${String(none)}`);
  assert.strictEqual(fd.CHAT_ZOOM_DEFAULT, 100);
});

test('property: from any start, any run of wheel ticks stays a 10 % step inside 70..200, and each tick moves at most one step', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.oneof(fc.constant(null), fc.double({ noNaN: false })), fc.array(fc.double({ min: -1000, max: 1000, noNaN: true }), { maxLength: 60 }), (start, deltas) => {
    let z = fd.nextChatZoom(start, 0);
    assert.strictEqual(z, fd.sanitizeChatZoom(start) === null ? 100 : fd.sanitizeChatZoom(start));
    for (const d of deltas) {
      const n = fd.nextChatZoom(z, d);
      assert.ok(n >= 70 && n <= 200 && n % 10 === 0, `${z} -> ${n}`);
      assert.ok(Math.abs(n - z) <= 10);
      if (d < 0 && z < 200) assert.strictEqual(n, z + 10);
      if (d > 0 && z > 70) assert.strictEqual(n, z - 10);
      z = n;
    }
  }), { numRuns: 300 });
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
    { fontFamily: fd.stackForChain(['Project', 'Global'], 'mono'), fontSize: 18 });
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

test('a family that is a mis-decoded name (U+FFFD) is refused everywhere, a real non-ASCII one is kept', () => {
  assert.strictEqual(fd.sanitizeFamily('Se\ufffdor Mono'), null);
  const out = fd.parseFamilyList('Arial\nSe\ufffdor Mono\n\u6e38\u30b4\u30b7\u30c3\u30af\nSe\u00f1or Mono\n');
  assert.ok(out.includes('Se\u00f1or Mono') && out.includes('\u6e38\u30b4\u30b7\u30c3\u30af') && out.includes('Arial'));
  assert.ok(!out.some((n) => n.includes('\ufffd')));
});

test('Dexter 2: an override naming an uninstalled font still shows the app-wide pick behind it, then the fallbacks', () => {
  const r = fd.effectiveTerminal({ settings: { terminalFont: 'JetBrains Mono' }, projectFont: 'Iosevka', themeFont: null });
  assert.strictEqual(r.fontFamily, `"Iosevka", "JetBrains Mono", ${fd.FALLBACK_MONO}`);
  assert.strictEqual(fd.effectiveTerminal({ settings: { terminalFont: 'Same' }, projectFont: 'Same' }).fontFamily, `"Same", ${fd.FALLBACK_MONO}`, 'no repeat');
  assert.strictEqual(fd.stackForChain(['A', 'a;b', null, 'B'], 'ui'), `"A", "B", ${fd.FALLBACK_UI}`);
});

test('Dexter 7: with no size picked the theme size is kept exactly, and the slider shows the real size', () => {
  const none = fd.sanitizeSettings(null);
  for (const size of [28, 9, 13.5]) assert.strictEqual(fd.effectiveTerminal({ settings: none, themeFont: { size } }).fontSize, size);
  assert.strictEqual(fd.effectiveTerminal({ settings: none, themeFont: { size: 'big' } }).fontSize, fd.DEFAULT_TERMINAL_SIZE);
  assert.strictEqual(fd.effectiveTerminal({ settings: { terminalSize: 16 }, themeFont: { size: 28 } }).fontSize, 16, 'a pick still wins');
  assert.strictEqual(fd.sectionView(none, null, 13).size, 13);
  assert.strictEqual(fd.sectionView(none, null, undefined).size, fd.DEFAULT_TERMINAL_SIZE);
  assert.strictEqual(fd.sectionView({ terminalSize: 20 }, null, 13).size, 20);
});

test('symbol and icon fonts never reach the terminal list, even if they measure fixed', () => {
  const list = ['Wingdings', 'Webdings', 'Segoe MDL2 Assets', 'Segoe Fluent Icons', 'Segoe UI Emoji', 'Symbol', 'Consolas'];
  assert.deepStrictEqual(fd.filterFonts(list, '', { fixedOnly: true, isFixed: () => true }), ['Consolas']);
  assert.strictEqual(fd.filterFonts(list, '', { fixedOnly: false }).length, list.length, 'the interface list keeps them');
});

test('F2: the list is asked for only once the Fonts section is in front of the person, and again only after the window', () => {
  const base = { haveList: false, lastAt: 0, now: 1000, ttlMs: 30000, busy: false };
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: false }), false, 'not opened: no enumeration');
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: undefined }), false);
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: true }), true);
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: true, busy: true }), false);
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: true, haveList: true, lastAt: 500 }), false, 'fresh');
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: true, haveList: true, lastAt: 500, now: 31000 }), true, 'stale: a new font appears');
  assert.strictEqual(fd.shouldAskForList({ ...base, visible: false, haveList: true, lastAt: 0, now: 99999 }), false);
});
