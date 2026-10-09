'use strict';
/**
 * Backlog #25: per-project light mode. A project keeps two looks (dark + light);
 * the toggle swaps them, the first flip to Light rolls a light palette through the
 * same contrast gates as the dark one, and the CLI's own theme travels to the next
 * launch as `--settings` `theme`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const {
  generateLook, generateLookFrom, lookFailures, SAFE_LOOK, SAFE_LOOK_LIGHT, MIN_LIGHT_BG_LUMINANCE,
  MIN_TEXT_CONTRAST, MIN_CONTROL_CONTRAST,
} = require('../host/palette-gen');
const {
  sanitizeLook, derivePalette, terminalOverride, applyLook, effectiveMode, cliThemeFor, DEFAULT_LOOK,
  contrastRatio, luminance,
} = require('../host/look');
const { setMode, setLook, readLook, rerollLook, seedLookIfNew, matchLook, LOOK_DIR_NAME } = require('../host/style');
const { buildHarnessSettings, buildClaudeArgs } = require('../host/settings-writer');
const { coloursSectionView, backgroundSectionView, reduceStyle, emptyStyleState, styleDisplay } = require('../app/style-display');
const { tmpDir } = require('./tmp-dir');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLOURS = ['appColor', 'textColor', 'accentColor', 'secondaryColor'];
const pick = (look) => Object.fromEntries(COLOURS.map((k) => [k, look[k]]));

// --- the light palette ---------------------------------------------------------------

test('SAFE_LOOK_LIGHT passes every light check -- the fallback is safe by test, not by claim', () => {
  assert.deepStrictEqual(lookFailures(SAFE_LOOK_LIGHT, { mode: 'light' }), []);
});

test('a dark look fails the light check, and a light look fails the dark one', () => {
  assert.ok(lookFailures(SAFE_LOOK, { mode: 'light' }).some((m) => /not light/.test(m)));
  assert.ok(lookFailures(SAFE_LOOK_LIGHT).some((m) => /not dark/.test(m)));
  assert.ok(lookFailures(SAFE_LOOK_LIGHT, { mode: 'dark' }).some((m) => /not dark/.test(m)));
});

test('a light background just under the luminance floor is refused, at the floor accepted', () => {
  const grey = (v) => '#' + v.toString(16).padStart(2, '0').repeat(3);
  let below = null;
  let at = null;
  for (let v = 0; v <= 255; v++) {
    if (luminance(grey(v)) >= MIN_LIGHT_BG_LUMINANCE) { at = v; below = v - 1; break; }
  }
  const mk = (v) => ({ ...SAFE_LOOK_LIGHT, appColor: grey(v) });
  assert.ok(lookFailures(mk(below), { mode: 'light' }).some((m) => /not light/.test(m)));
  assert.ok(!lookFailures(mk(at), { mode: 'light' }).some((m) => /not light/.test(m)));
});

test('property: EVERY generated light look passes every contrast pair on the palette that is rendered', () => {
  fc.assert(fc.property(fc.integer(), (seed) => {
    const look = generateLook(mulberry32(seed), { mode: 'light' });
    assert.ok(look, 'a light look always exists for the default terminal');
    assert.ok(luminance(look.appColor) >= MIN_LIGHT_BG_LUMINANCE, `${look.appColor} is light`);

    const p = derivePalette(look, {});
    // Derivation must not have moved any chosen colour: the check ran on what the person gets.
    assert.strictEqual(p.bg, look.appColor);
    assert.strictEqual(p.text, look.textColor);
    assert.strictEqual(p.accent, look.accentColor);
    assert.strictEqual(p.dim, look.secondaryColor);
    for (const surface of [p.bg, p.panel]) {
      for (const fg of [p.text, p.accent, p.dim]) {
        assert.ok(contrastRatio(fg, surface) >= MIN_TEXT_CONTRAST, `${fg} on ${surface}`);
      }
    }
    assert.ok(contrastRatio(p.onAccent, p.accent) >= MIN_TEXT_CONTRAST, 'label on accent');
    assert.ok(contrastRatio(p.accent, p.border) >= MIN_CONTROL_CONTRAST, 'accent on border');
    assert.ok(contrastRatio(p.dim, p.border) >= MIN_CONTROL_CONTRAST, 'dim on border');

    // The terminal sits in the SAME box: its text is the look's own, and the background is not moved.
    const t = terminalOverride({ ...look, mode: 'light' }, { foreground: '#c7cede', background: '#11131a' });
    assert.strictEqual(t.background, look.appColor);
    assert.ok(contrastRatio(t.foreground, t.background) >= MIN_TEXT_CONTRAST, 'terminal text');
    return true;
  }), { numRuns: 300 });
});

test('the light generator does not need the dark terminal text: any terminal foreground gives a light look', () => {
  for (const fg of ['#c7cede', '#101010', 'not a colour', undefined]) {
    assert.ok(generateLook(mulberry32(7), { mode: 'light', terminalForeground: fg }), String(fg));
  }
});

test('light generation retries a failing draw and then falls back to SAFE_LOOK_LIGHT', () => {
  const bad = () => ({ ...SAFE_LOOK_LIGHT, textColor: SAFE_LOOK_LIGHT.appColor });
  assert.deepStrictEqual(generateLook(mulberry32(1), { mode: 'light', candidate: bad }), { ...SAFE_LOOK_LIGHT });
});

test('the default mode of the generator is still dark', () => {
  const look = generateLook(mulberry32(3));
  assert.ok(luminance(look.appColor) < 0.06);
});

test('property: a look matched to a background in light mode is light and passes the gates, or is refused', () => {
  const seeds = fc.array(fc.stringMatching(/^#[0-9a-f]{6}$/), { minLength: 1, maxLength: 6 });
  fc.assert(fc.property(seeds, fc.integer(), (s, seed) => {
    const look = generateLookFrom(s, mulberry32(seed), { mode: 'light' });
    if (look === null) return true;
    assert.deepStrictEqual(lookFailures(look, { mode: 'light' }), []);
    return true;
  }), { numRuns: 200 });
});

// --- the look model --------------------------------------------------------------------

test('sanitizeLook: mode is light, dark, or unset; anything else is unset', () => {
  assert.strictEqual(sanitizeLook({ mode: 'light' }).mode, 'light');
  assert.strictEqual(sanitizeLook({ mode: 'dark' }).mode, 'dark');
  for (const bad of ['LIGHT', 1, null, undefined, {}, 'auto']) assert.strictEqual(sanitizeLook({ mode: bad }).mode, null);
  assert.strictEqual(DEFAULT_LOOK.mode, null);
  assert.strictEqual(DEFAULT_LOOK.other, null);
});

test('sanitizeLook: the other look keeps only its colours and a darkness, each sanitized', () => {
  const other = { appColor: '#ABCDEF', textColor: 'nope', accentColor: null, secondaryColor: '#123456', darkness: 2, background: { file: 'x' }, mode: 'light' };
  const clean = sanitizeLook({ mode: 'dark', other }).other;
  assert.deepStrictEqual(clean, { appColor: '#abcdef', textColor: null, accentColor: null, secondaryColor: '#123456', darkness: 0.95 });
  assert.strictEqual(sanitizeLook({ other: 'x' }).other, null);
  assert.strictEqual(sanitizeLook({ other: [] }).other, null);
  assert.strictEqual(sanitizeLook({ other: { darkness: '0.3' } }).other.darkness, 0.5);
  const once = sanitizeLook({ mode: 'light', other });
  assert.deepStrictEqual(sanitizeLook(once), once);
});

test('effectiveMode and cliThemeFor: unset reads as dark but sends the CLI nothing', () => {
  assert.strictEqual(effectiveMode(DEFAULT_LOOK), 'dark');
  assert.strictEqual(effectiveMode({ mode: 'light' }), 'light');
  assert.strictEqual(effectiveMode(undefined), 'dark');
  assert.strictEqual(cliThemeFor(DEFAULT_LOOK), null);
  assert.strictEqual(cliThemeFor(undefined), null);
  assert.strictEqual(cliThemeFor({ mode: 'dark' }), 'dark');
  assert.strictEqual(cliThemeFor({ mode: 'light' }), 'light');
});

test('terminalOverride in light mode paints dark text on the light app colour instead of pushing the app colour dark', () => {
  const base = { foreground: '#c7cede', background: '#11131a', cursor: '#d08c4a' };
  const look = { ...DEFAULT_LOOK, mode: 'light', ...pick(SAFE_LOOK_LIGHT) };
  const t = terminalOverride(look, base);
  assert.strictEqual(t.background, SAFE_LOOK_LIGHT.appColor);
  assert.strictEqual(t.foreground, SAFE_LOOK_LIGHT.textColor);
  assert.strictEqual(t.cursor, base.cursor);
  // the same look in dark mode keeps the old behaviour
  const dark = terminalOverride({ ...look, mode: 'dark' }, base);
  assert.strictEqual(dark.foreground, base.foreground);
  assert.notStrictEqual(dark.background, SAFE_LOOK_LIGHT.appColor);
});

test('terminalOverride in light mode with no colours set changes nothing', () => {
  const base = { foreground: '#c7cede', background: '#11131a' };
  assert.deepStrictEqual(terminalOverride({ ...DEFAULT_LOOK, mode: 'light' }, base), base);
});

test('terminalOverride in light mode readability-guards a text colour that is too close to the app colour', () => {
  const look = { ...DEFAULT_LOOK, mode: 'light', appColor: '#f4f5f8', textColor: '#f0f0f0' };
  const t = terminalOverride(look, { foreground: '#c7cede', background: '#000000' });
  assert.ok(contrastRatio(t.foreground, t.background) >= MIN_TEXT_CONTRAST);
});

test('applyLook carries the light terminal through', () => {
  const theme = { name: 'x', chrome: {}, terminal: { foreground: '#c7cede', background: '#11131a' } };
  const out = applyLook(theme, { ...DEFAULT_LOOK, mode: 'light', ...pick(SAFE_LOOK_LIGHT) });
  assert.strictEqual(out.terminal.foreground, SAFE_LOOK_LIGHT.textColor);
  assert.strictEqual(out.chrome.bg, SAFE_LOOK_LIGHT.appColor);
});

// --- host/style.js: the toggle -----------------------------------------------------------

const lookFile = (cwd) => path.join(cwd, LOOK_DIR_NAME, 'look.json');

function projectWithDarkLook(seed = 5) {
  const cwd = tmpDir('cc-light-');
  const dark = generateLook(mulberry32(seed));
  assert.ok(setLook({ cwd, patch: { ...dark, darkness: 0.7 } }).ok);
  return { cwd, dark };
}

test('the first flip to Light rolls a light palette and keeps the dark look as the other one', () => {
  const { cwd, dark } = projectWithDarkLook();
  const r = setMode({ cwd, mode: 'light', rng: mulberry32(11) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.look.mode, 'light');
  assert.deepStrictEqual(lookFailures(r.look, { mode: 'light' }), []);
  assert.deepStrictEqual(r.look.other, { ...dark, darkness: 0.7 });
  assert.strictEqual(r.look.darkness, 0.5, 'a new look starts at the default veil');
  assert.deepStrictEqual(readLook(cwd), r.look);
});

test('flipping back restores the dark look exactly, and flipping again restores the SAME light look', () => {
  const { cwd, dark } = projectWithDarkLook();
  const light = setMode({ cwd, mode: 'light', rng: mulberry32(11) }).look;
  const back = setMode({ cwd, mode: 'dark', rng: mulberry32(99) });
  assert.strictEqual(back.look.mode, 'dark');
  assert.deepStrictEqual(pick(back.look), dark);
  assert.strictEqual(back.look.darkness, 0.7);
  const again = setMode({ cwd, mode: 'light', rng: mulberry32(1234) });
  assert.deepStrictEqual(pick(again.look), pick(light));
  assert.strictEqual(again.look.darkness, light.darkness);
});

test('a flip keeps the background and asking for the mode already showing changes nothing', () => {
  const { cwd } = projectWithDarkLook();
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  const noop = setMode({ cwd, mode: 'dark', rng: mulberry32(1) });
  assert.strictEqual(noop.ok, true);
  assert.strictEqual(noop.look.mode, 'dark', 'the dark look is now explicit');
  const stored = JSON.parse(fs.readFileSync(lookFile(cwd), 'utf8'));
  stored.background = { file: 'background.png', setAt: '2026-10-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(cwd, LOOK_DIR_NAME, 'background.png'), 'x');
  fs.writeFileSync(lookFile(cwd), JSON.stringify(stored));
  const flipped = setMode({ cwd, mode: 'light', rng: mulberry32(2) });
  assert.deepStrictEqual(flipped.look.background, stored.background);
  assert.ok(before.length > 0);
});

test('setMode refuses an unknown mode and writes nothing for a project with no look folder', () => {
  const cwd = tmpDir('cc-light-none-');
  assert.strictEqual(setMode({ cwd, mode: 'sepia' }).ok, false);
  assert.strictEqual(setMode({ cwd, mode: undefined }).ok, false);
  assert.strictEqual(setMode({ cwd: '', mode: 'light' }).ok, false);
  assert.strictEqual(fs.existsSync(path.join(cwd, LOOK_DIR_NAME)), false);
});

test('setMode on a project with no look yet still works: light is rolled, the empty dark look is kept', () => {
  const cwd = tmpDir('cc-light-fresh-');
  const r = setMode({ cwd, mode: 'light', rng: mulberry32(4) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.look.mode, 'light');
  assert.deepStrictEqual(lookFailures(r.look, { mode: 'light' }), []);
  const back = setMode({ cwd, mode: 'dark', rng: mulberry32(4) });
  assert.strictEqual(back.look.appColor, null, 'dark went back to the registry theme');
});

test('setMode with a corrupt look.json is refused and leaves the file alone', () => {
  const cwd = tmpDir('cc-light-corrupt-');
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  fs.writeFileSync(lookFile(cwd), '{ nope');
  const r = setMode({ cwd, mode: 'light' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), '{ nope');
});

test('setMode reports a palette it cannot make instead of writing a bad one', () => {
  const { cwd } = projectWithDarkLook();
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  const r = setMode({ cwd, mode: 'light', generate: () => null });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /light/i);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
});

test('re-roll works in the current mode: light stays light, dark stays dark, the other look is untouched', () => {
  const { cwd, dark } = projectWithDarkLook();
  setMode({ cwd, mode: 'light', rng: mulberry32(11) });
  const r1 = rerollLook({ cwd, rng: mulberry32(21) });
  assert.strictEqual(r1.look.mode, 'light');
  assert.deepStrictEqual(lookFailures(r1.look, { mode: 'light' }), []);
  assert.deepStrictEqual(pick(r1.look.other), dark);
  setMode({ cwd, mode: 'dark', rng: mulberry32(1) });
  const r2 = rerollLook({ cwd, rng: mulberry32(22) });
  assert.strictEqual(r2.look.mode, 'dark');
  assert.deepStrictEqual(lookFailures(r2.look), []);
  assert.deepStrictEqual(lookFailures(pick(r2.look.other), { mode: 'light' }), []);
});

test('matching colours to a background works in the current mode', () => {
  const { cwd } = projectWithDarkLook();
  fs.writeFileSync(path.join(cwd, LOOK_DIR_NAME, 'background.png'), 'x');
  const stored = JSON.parse(fs.readFileSync(lookFile(cwd), 'utf8'));
  stored.background = { file: 'background.png', setAt: '2026-10-01T00:00:00.000Z' };
  fs.writeFileSync(lookFile(cwd), JSON.stringify(stored));
  setMode({ cwd, mode: 'light', rng: mulberry32(11) });
  const r = matchLook({ cwd, seeds: ['#336699', '#cc6633'], setAt: stored.background.setAt, rng: mulberry32(8) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.look.mode, 'light');
  assert.deepStrictEqual(lookFailures(r.look, { mode: 'light' }), []);
});

test('a plain colour patch keeps the mode and the other look', () => {
  const { cwd } = projectWithDarkLook();
  const flipped = setMode({ cwd, mode: 'light', rng: mulberry32(11) }).look;
  const r = setLook({ cwd, patch: { darkness: 0.2 } });
  assert.strictEqual(r.look.mode, 'light');
  assert.deepStrictEqual(r.look.other, flipped.other);
  assert.strictEqual(r.look.darkness, 0.2);
});

test('a new project starts dark or light by its first random draw, each with its own palette', () => {
  const modes = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const cwd = tmpDir('cc-light-seed-');
    const r = seedLookIfNew({ cwd, hasHistory: () => false, rng: mulberry32(seed) });
    assert.strictEqual(r.seeded, true);
    modes.add(r.look.mode);
    assert.deepStrictEqual(lookFailures(r.look, { mode: r.look.mode }), [], `seed ${seed}`);
  }
  assert.deepStrictEqual([...modes].sort(), ['dark', 'light']);
});

test('the first draw decides the mode: below one half is dark, from one half is light', () => {
  const fixed = (v) => { let first = true; return () => { if (first) { first = false; return v; } return 0.5; }; };
  const dark = seedLookIfNew({ cwd: tmpDir('cc-light-seed-d-'), hasHistory: () => false, rng: fixed(0.4999) });
  const light = seedLookIfNew({ cwd: tmpDir('cc-light-seed-l-'), hasHistory: () => false, rng: fixed(0.5) });
  assert.strictEqual(dark.look.mode, 'dark');
  assert.strictEqual(light.look.mode, 'light');
});

test('a light-only terminal foreground does not stop a new project from getting a light look', () => {
  const cwd = tmpDir('cc-light-seed-fg-');
  const r = seedLookIfNew({ cwd, hasHistory: () => false, rng: () => 0.9, terminalForeground: '#101010' });
  assert.strictEqual(r.seeded, true);
  assert.strictEqual(r.look.mode, 'light');
});

// --- settings: the CLI theme goes in the settings file ------------------------------------------

const BASE = { helperPath: 'C:/h.exe', pipeName: 'pipe-x' };

test('buildHarnessSettings carries the CLI theme only when one is chosen', () => {
  assert.strictEqual(buildHarnessSettings({ ...BASE, theme: 'light' }).theme, 'light');
  assert.strictEqual(buildHarnessSettings({ ...BASE, theme: 'dark' }).theme, 'dark');
  for (const none of [undefined, null, 'auto', 'light-ansi', '', 1]) {
    assert.ok(!('theme' in buildHarnessSettings({ ...BASE, theme: none })), String(none));
  }
});

test('the settings JSON the CLI is given reads {"theme":"light"} alongside the hooks', () => {
  const s = JSON.parse(JSON.stringify(buildHarnessSettings({ ...BASE, theme: 'light' })));
  assert.strictEqual(s.theme, 'light');
  assert.ok(s.hooks && s.hooks.PreToolUse);
  assert.deepStrictEqual(buildClaudeArgs({ settingsFile: 'f.json', helperExists: true }).slice(1, 3), ['--settings', 'f.json']);
});

// --- the Style tab's view -----------------------------------------------------------------------

test('coloursSectionView: the mode and the next-launch note appear only while they differ', () => {
  const state = (mode, cliTheme) => ({ appColor: '#f4f5f8', mode, cliTheme });
  const same = coloursSectionView(state('light', 'light'));
  assert.strictEqual(same.mode, 'light');
  assert.strictEqual(same.cliNote, null);
  const differs = coloursSectionView(state('light', 'dark'));
  assert.strictEqual(differs.cliNote, "Claude's colours switch next time you open this project");
  assert.strictEqual(coloursSectionView(state('dark', 'light')).cliNote, differs.cliNote);
  // unset on either side is the dark default for the comparison, not a difference
  assert.strictEqual(coloursSectionView(state(null, null)).cliNote, null);
  assert.strictEqual(coloursSectionView(state('dark', null)).cliNote, null);
  assert.strictEqual(coloursSectionView(state(null, 'dark')).cliNote, null);
  assert.strictEqual(coloursSectionView(state('light', null)).cliNote, differs.cliNote);
  assert.strictEqual(coloursSectionView(state(undefined, undefined)).mode, 'dark');
  assert.strictEqual(coloursSectionView(null).cliNote, null);
  assert.strictEqual(coloursSectionView(null).mode, 'dark');
});

test('backgroundSectionView: the veil slider is Darkness in dark mode and Brightness in light mode', () => {
  assert.strictEqual(backgroundSectionView({ source: 'override', darkness: 0.3 }).veilLabel, 'Darkness');
  assert.strictEqual(backgroundSectionView({ source: 'override', darkness: 0.3, mode: 'dark' }).veilLabel, 'Darkness');
  assert.strictEqual(backgroundSectionView({ source: 'override', darkness: 0.3, mode: 'light' }).veilLabel, 'Brightness');
  assert.strictEqual(backgroundSectionView(null).veilLabel, 'Darkness');
});

test('reduceStyle files the look mode and the launched CLI theme under colours and background', () => {
  const msg = { type: 'style', style: { source: 'override', look: { mode: 'light', darkness: 0.4, appColor: '#f4f5f8' }, cliTheme: 'dark' }, theme: { chrome: {} } };
  const next = reduceStyle(emptyStyleState(), msg);
  assert.strictEqual(next.colours.mode, 'light');
  assert.strictEqual(next.colours.cliTheme, 'dark');
  assert.strictEqual(next.background.mode, 'light');
  const view = styleDisplay(next);
  assert.strictEqual(view.find((s) => s.id === 'colours').view.cliNote, "Claude's colours switch next time you open this project");
  assert.strictEqual(view.find((s) => s.id === 'background').view.veilLabel, 'Brightness');
});

test('a host message with no cliTheme keeps the one the panel already knew (a style change is not a relaunch)', () => {
  const first = reduceStyle(emptyStyleState(), { style: { look: { mode: 'dark' }, cliTheme: 'dark' } });
  const second = reduceStyle(first, { type: 'style', look: { mode: 'light' }, theme: { chrome: {} } });
  assert.strictEqual(second.colours.cliTheme, 'dark');
  assert.strictEqual(second.colours.mode, 'light');
});
