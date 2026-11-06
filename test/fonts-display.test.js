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

test('nextChatZoom: a number of whole steps, +1 = 10 % bigger, clamped at both ends; anything but a whole number is no step', () => {
  assert.strictEqual(fd.nextChatZoom(100, 1), 110);
  assert.strictEqual(fd.nextChatZoom(100, -1), 90);
  assert.strictEqual(fd.nextChatZoom(100, 3), 130);
  assert.strictEqual(fd.nextChatZoom(200, 1), 200);
  assert.strictEqual(fd.nextChatZoom(70, -2), 70);
  assert.strictEqual(fd.nextChatZoom(null, 1), 110, 'unset starts from 100 %');
  for (const none of [0, NaN, undefined, '1', 0.5, Infinity]) assert.strictEqual(fd.nextChatZoom(120, none), 120, `no step for ${String(none)}`);
  assert.strictEqual(fd.CHAT_ZOOM_DEFAULT, 100);
});

// PR #233 F10 (Dexter 4, Miguel M2): one step per 100 px of wheel TRAVEL, not per event: a touchpad pinch is a burst of small deltas.
const run = (events) => { let acc = null; let steps = 0; for (const [dy, t, mode] of events) { const r = fd.wheelZoomSteps(acc, dy, mode || 0, t); acc = r.acc; steps += r.steps; } return { acc, steps }; };

test('wheelZoomSteps: a mouse notch (100 px) is one step; up (negative deltaY) zooms in', () => {
  assert.strictEqual(run([[-100, 0]]).steps, 1);
  assert.strictEqual(run([[100, 0]]).steps, -1);
  assert.strictEqual(run([[-100, 0], [-100, 50], [-100, 100]]).steps, 3);
  assert.strictEqual(run([[-3, 0, 1]]).steps, 1, 'deltaMode 1: three lines are one notch');
});

test('wheelZoomSteps: a touchpad burst of 15 events of -4 px (60 px) is less than one step; 25 of them (100 px) is one', () => {
  assert.strictEqual(run(Array.from({ length: 15 }, (_, i) => [-4, i * 16])).steps, 0);
  assert.strictEqual(run(Array.from({ length: 25 }, (_, i) => [-4, i * 16])).steps, 1);
});

test('wheelZoomSteps: a change of direction and a quiet gap both start the travel again; zero and non-finite deltas are no step and change nothing', () => {
  const dir = run([[-60, 0], [60, 10]]);
  assert.strictEqual(dir.steps, 0);
  assert.strictEqual(dir.acc.sum, 60, 'the travel back started from zero');
  assert.strictEqual(run([[-60, 0], [-60, 1000]]).steps, 0, 'a quiet gap: the second 60 px is a new gesture');
  assert.strictEqual(run([[-60, 0], [-60, 100]]).steps, 1, 'one gesture: 120 px');
  for (const bad of [0, NaN, Infinity, -Infinity, undefined, '5']) {
    const r = fd.wheelZoomSteps({ sum: -50, at: 0 }, bad, 0, 10);
    assert.strictEqual(r.steps, 0, String(bad));
    assert.deepStrictEqual(r.acc, { sum: -50, at: 0 }, `${String(bad)} leaves the travel as it was`);
  }
});

test('property: any run of wheel events gives at most one step per 100 px of travel, and the zoom stays a 10 % step inside 70..200', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.array(fc.tuple(fc.double({ min: -300, max: 300, noNaN: true }), fc.integer({ min: 0, max: 400 })), { maxLength: 80 }), (evs) => {
    let acc = null; let t = 0; let z = 100; let travel = 0; let steps = 0;
    for (const [dy, gap] of evs) {
      t += gap;
      const r = fd.wheelZoomSteps(acc, dy, 0, t);
      acc = r.acc; steps += Math.abs(r.steps); travel += Math.abs(dy);
      z = fd.nextChatZoom(z, r.steps);
      assert.ok(z >= 70 && z <= 200 && z % 10 === 0, String(z));
    }
    assert.ok(steps <= Math.floor(travel / 100) + 0, `${steps} steps for ${travel} px`);
  }), { numRuns: 300 });
});

// PR #233 F12 (Dexter 5, Miguel L5): the zoom's save, as a small machine the page drives (schedule/cancel are its timers, save its fonts:set).
function saver() {
  const saves = []; const timers = new Map(); let id = 0;
  const s = fd.createChatZoomSaver({ save: (z) => saves.push(z), schedule: (fn) => { timers.set(++id, fn); return id; }, cancel: (h) => timers.delete(h) });
  const fire = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(f => f()); };
  return { s, saves, fire, pending: () => timers.size };
}

test('the zoom saver: a wheel run is saved once, after it settles; a record that arrives meanwhile does not undo it (the pending-run guard)', () => {
  const { s, saves, fire } = saver();
  assert.strictEqual(s.record(120), 120, 'the record sets what shows');
  s.zoomed(130); s.zoomed(140);
  assert.strictEqual(s.record(120), 140, 'a record arriving mid-run (another window, an old answer) is ignored: the run is newer');
  fire();
  assert.deepStrictEqual(saves, [140]);
  assert.strictEqual(s.record(140), 140);
  assert.strictEqual(s.record(110), 110, 'once saved, a later record (another window\'s zoom) shows');
});

test('the zoom saver: a wheel before the record has loaded is kept and saved once it loads, not reverted', () => {
  const { s, saves, fire } = saver();
  s.zoomed(150);
  fire();
  assert.deepStrictEqual(saves, [], 'nothing to patch yet: main has not answered');
  assert.strictEqual(s.record(null), 150, 'the stored value does not undo the wheel');
  assert.deepStrictEqual(saves, [150], 'saved exactly once, as soon as the record is known');
  assert.strictEqual(s.record(150), 150);
  assert.deepStrictEqual(saves, [150]);
});

test('the zoom saver: flush (the page going away) saves a run that has not settled yet, at once', () => {
  const { s, saves, pending } = saver();
  s.record(100);
  s.zoomed(170);
  s.flush();
  assert.deepStrictEqual(saves, [170]);
  assert.strictEqual(pending(), 0);
  s.flush();
  assert.deepStrictEqual(saves, [170], 'nothing pending: nothing more');
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
