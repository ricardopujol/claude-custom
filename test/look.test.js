'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  parseHex, formatHex, sanitizeLook, derivePalette, terminalOverride,
  DEFAULT_LOOK, MAX_DARKNESS,
} = require('../host/look');

const HEX = /^#[0-9a-f]{6}$/;
const hexArb = fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 })).map(([r, g, b]) => formatHex({ r, g, b }));

const BASE_CHROME = Object.freeze({
  bg: '#0b1018', panel: '#111827', border: '#1f2b3d', text: '#c3d2e4', dim: '#6b7d94', accent: '#4fa3d9',
});

// --- hex helpers --------------------------------------------------------------

test('parseHex reads #rrggbb, case-insensitive, and nothing else', () => {
  assert.deepStrictEqual(parseHex('#FF8000'), { r: 255, g: 128, b: 0 });
  for (const bad of ['', 'ff8000', '#fff', '#ff80001', '#gg0000', null, undefined, 0, {}]) {
    assert.strictEqual(parseHex(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});

test('property: formatHex/parseHex round trip is the identity', () => {
  fc.assert(fc.property(hexArb, (hex) => formatHex(parseHex(hex)) === hex));
});

// --- sanitizeLook -------------------------------------------------------------

test('sanitizeLook of garbage is the default look, never a throw', () => {
  for (const raw of [undefined, null, 42, 'x', [], [1], true]) {
    assert.deepStrictEqual(sanitizeLook(raw), DEFAULT_LOOK);
  }
});

test('sanitizeLook keeps valid colours, lowercased, and drops invalid ones', () => {
  const look = sanitizeLook({ appColor: '#AA0033', textColor: 'red' });
  assert.strictEqual(look.appColor, '#aa0033');
  assert.strictEqual(look.textColor, null);
});

test('sanitizeLook clamps darkness and treats a non-number as absent, not zero', () => {
  const d = (darkness) => sanitizeLook({ darkness }).darkness;
  assert.strictEqual(d(2), MAX_DARKNESS);
  assert.strictEqual(d(-1), 0);
  assert.strictEqual(d(0.4), 0.4);
  // Number(null) is 0 -- the trap this codebase keeps paying for. Absent must
  // fall back to the default, not become a confident "no darkening".
  assert.strictEqual(d(null), DEFAULT_LOOK.darkness);
  assert.strictEqual(d('0.9'), DEFAULT_LOOK.darkness);
  assert.strictEqual(d(NaN), DEFAULT_LOOK.darkness);
  assert.strictEqual(d(Infinity), DEFAULT_LOOK.darkness);
});

test('sanitizeLook refuses a background file that is not a bare background.<ext> name', () => {
  for (const file of ['../evil.png', 'sub/background.png', 'sub\\background.png', 'C:\\x.png',
    '/etc/passwd', 'background.exe', 'notes.png', '', 7, null]) {
    assert.strictEqual(sanitizeLook({ background: { file } }).background, null, `refuses ${JSON.stringify(file)}`);
  }
  assert.strictEqual(sanitizeLook({ background: { file: 'background.JPG' } }).background.file, 'background.jpg');
});

test('sanitizeLook keeps setAt only when it is a parseable timestamp', () => {
  const at = (setAt) => sanitizeLook({ background: { file: 'background.png', setAt } }).background.setAt;
  assert.strictEqual(at('2026-09-26T10:00:00.000Z'), '2026-09-26T10:00:00.000Z');
  assert.strictEqual(at('yesterday'), null);
  assert.strictEqual(at(0), null);
});

test('sanitizeLook keeps darkness even with no background, so the slider survives a reset', () => {
  assert.strictEqual(sanitizeLook({ darkness: 0.3 }).darkness, 0.3);
});

test('property: sanitizeLook is idempotent over arbitrary JSON', () => {
  fc.assert(fc.property(fc.jsonValue(), (raw) => {
    const once = sanitizeLook(raw);
    assert.deepStrictEqual(sanitizeLook(once), once);
  }));
});

test('property: sanitizeLook is idempotent over look-shaped input', () => {
  const lookArb = fc.record({
    appColor: fc.oneof(hexArb, fc.string()),
    textColor: fc.oneof(hexArb, fc.constant(null)),
    darkness: fc.oneof(fc.double(), fc.constant(null)),
    background: fc.oneof(fc.constant(null), fc.record({
      file: fc.constantFrom('background.png', 'background.webp', '../x.png', 'a.png'),
      setAt: fc.oneof(fc.constant('2026-01-01T00:00:00.000Z'), fc.string()),
    })),
  }, { requiredKeys: [] });
  fc.assert(fc.property(lookArb, (raw) => {
    const once = sanitizeLook(raw);
    assert.deepStrictEqual(sanitizeLook(once), once);
  }));
});

// --- derivePalette ------------------------------------------------------------

test('derivePalette with no overrides returns the base chrome untouched', () => {
  assert.deepStrictEqual(derivePalette(DEFAULT_LOOK, BASE_CHROME), { ...BASE_CHROME });
});

test('derivePalette uses appColor as the background and derives panel/border from it', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#402020' }, BASE_CHROME);
  assert.strictEqual(p.bg, '#402020');
  assert.notStrictEqual(p.panel, BASE_CHROME.panel);
  assert.notStrictEqual(p.border, BASE_CHROME.border);
  assert.strictEqual(p.text, BASE_CHROME.text, 'text is not touched by the app colour');
  assert.strictEqual(p.accent, BASE_CHROME.accent, 'keys it does not own pass through');
});

test('derivePalette lightens a dark app colour and darkens a light one', () => {
  const lum = (hex) => { const { r, g, b } = parseHex(hex); return r + g + b; };
  const dark = derivePalette({ ...DEFAULT_LOOK, appColor: '#101010' }, BASE_CHROME);
  assert.ok(lum(dark.border) > lum(dark.bg));
  const light = derivePalette({ ...DEFAULT_LOOK, appColor: '#f0f0f0' }, BASE_CHROME);
  assert.ok(lum(light.border) < lum(light.bg));
});

test('derivePalette uses textColor for text and derives dim toward the background', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#000000', textColor: '#ffffff' }, BASE_CHROME);
  assert.strictEqual(p.text, '#ffffff');
  const { r } = parseHex(p.dim);
  assert.ok(r > 0 && r < 255, `dim ${p.dim} sits between text and bg`);
});

test('property: every derived colour is valid #rrggbb and panel/border differ from bg', () => {
  fc.assert(fc.property(hexArb, fc.option(hexArb, { nil: null }), (appColor, textColor) => {
    const p = derivePalette({ ...DEFAULT_LOOK, appColor, textColor }, BASE_CHROME);
    for (const k of ['bg', 'panel', 'border', 'text', 'dim']) assert.match(p[k], HEX, k);
    assert.notStrictEqual(p.panel, p.bg);
    assert.notStrictEqual(p.border, p.bg);
    assert.notStrictEqual(p.border, p.panel);
  }));
});

// --- terminalOverride ---------------------------------------------------------

test('terminalOverride sets only the terminal background, never the CLI text colours', () => {
  const base = { background: '#0b1018', foreground: '#c3d2e4', cursor: '#4fa3d9' };
  assert.deepStrictEqual(terminalOverride({ ...DEFAULT_LOOK, textColor: '#ffffff' }, base), base);
  const t = terminalOverride({ ...DEFAULT_LOOK, appColor: '#402020', textColor: '#ffffff' }, base);
  assert.deepStrictEqual(t, { ...base, background: '#402020' });
});

// --- unfocused-window dim (install-wide, one value for every window) -----------

test('sanitizeDim clamps to [0, MAX_DIM] and treats a non-number as the default', () => {
  const { sanitizeDim, DEFAULT_DIM, MAX_DIM } = require('../host/look');
  assert.strictEqual(sanitizeDim(0.3), 0.3);
  assert.strictEqual(sanitizeDim(0), 0, 'zero is a real choice: "never dim"');
  assert.strictEqual(sanitizeDim(5), MAX_DIM);
  assert.strictEqual(sanitizeDim(-1), 0);
  for (const v of [undefined, null, '0.3', NaN, Infinity, {}]) {
    assert.strictEqual(sanitizeDim(v), DEFAULT_DIM, JSON.stringify(v));
  }
  assert.ok(MAX_DIM < 1, 'a fully black unfocused window would hide which project it is');
});

// --- applyLook: the registry theme with this project's look merged in ----------

test('applyLook merges the look into chrome and terminal, and leaves font alone', () => {
  const { applyLook } = require('../host/look');
  const theme = {
    terminal: { background: '#0b1018', foreground: '#c3d2e4' },
    chrome: { ...BASE_CHROME },
    font: { family: 'X', size: 14 },
  };
  const out = applyLook(theme, { ...DEFAULT_LOOK, appColor: '#402020', textColor: '#eeeeee' });
  assert.strictEqual(out.chrome.bg, '#402020');
  assert.strictEqual(out.chrome.text, '#eeeeee');
  assert.strictEqual(out.terminal.background, '#402020');
  assert.strictEqual(out.terminal.foreground, '#c3d2e4');
  assert.deepStrictEqual(out.font, theme.font);
  assert.strictEqual(theme.chrome.bg, BASE_CHROME.bg, 'the base theme is never mutated');
});

test('applyLook with the default look is a deep copy of the theme', () => {
  const { applyLook } = require('../host/look');
  const theme = { terminal: { background: '#000000' }, chrome: { ...BASE_CHROME }, font: {} };
  assert.deepStrictEqual(applyLook(theme, DEFAULT_LOOK), theme);
  assert.deepStrictEqual(applyLook(theme, undefined), theme);
});

test('applyLook tolerates a theme with no chrome or terminal', () => {
  const { applyLook } = require('../host/look');
  const out = applyLook({}, { ...DEFAULT_LOOK, appColor: '#402020' });
  assert.strictEqual(out.chrome.bg, '#402020');
  assert.strictEqual(out.terminal.background, '#402020');
});

// --- Dexter F4: contrast is guaranteed, not hoped for ----------------------------

const { contrastRatio } = require('../host/look');

test('F4: an app colour equal to the terminal foreground does not hide the CLI text', () => {
  const base = { background: '#11131a', foreground: '#c7cede' };
  const t = terminalOverride({ ...DEFAULT_LOOK, appColor: '#c7cede' }, base);
  assert.ok(contrastRatio(t.background, t.foreground) >= 4.5, t.background);
});

test('F4: a text colour equal to the app colour is still readable', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#402020', textColor: '#402020' }, BASE_CHROME);
  assert.ok(contrastRatio(p.text, p.bg) >= 4.5, `${p.text} on ${p.bg}`);
  assert.notStrictEqual(p.dim, p.bg);
});

test('property F4: the terminal background always reads against its own foreground', () => {
  fc.assert(fc.property(hexArb, hexArb, (appColor, foreground) => {
    const t = terminalOverride({ ...DEFAULT_LOOK, appColor }, { background: '#000000', foreground });
    assert.ok(contrastRatio(t.background, t.foreground) >= 4.5, `${t.background} vs ${t.foreground}`);
  }));
});

test('property F4 (+Miguel #4): UI text reads against the bg for any app/text pair, either one unset', () => {
  fc.assert(fc.property(fc.option(hexArb, { nil: null }), fc.option(hexArb, { nil: null }), (appColor, textColor) => {
    fc.pre(appColor !== null || textColor !== null);
    const p = derivePalette({ ...DEFAULT_LOOK, appColor, textColor }, BASE_CHROME);
    for (const k of ['bg', 'panel', 'border', 'text', 'dim']) assert.match(p[k], HEX, k);
    assert.ok(contrastRatio(p.text, p.bg) >= 4.5, `${p.text} on ${p.bg}`);
  }));
});

// --- accent and secondary text (Ricardo's manual test: tabs, sliders and the gray
// secondary text could not be changed) ---------------------------------------------

test('sanitizeLook keeps accent and secondary colours, lowercased, and drops invalid ones', () => {
  const look = sanitizeLook({ accentColor: '#E0A030', secondaryColor: 'gray' });
  assert.strictEqual(look.accentColor, '#e0a030');
  assert.strictEqual(look.secondaryColor, null);
  assert.strictEqual(DEFAULT_LOOK.accentColor, null);
  assert.strictEqual(DEFAULT_LOOK.secondaryColor, null);
});

test('derivePalette uses accentColor for accent and secondaryColor for dim', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, accentColor: '#e0a030', secondaryColor: '#a09070' }, BASE_CHROME);
  assert.strictEqual(p.accent, '#e0a030');
  assert.strictEqual(p.dim, '#a09070');
  assert.strictEqual(p.bg, BASE_CHROME.bg, 'the app colour is not touched');
});

test('an unset accent keeps the theme accent; an unset secondary keeps the derived dim', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#000000', textColor: '#ffffff' }, BASE_CHROME);
  assert.strictEqual(p.accent, BASE_CHROME.accent);
  assert.notStrictEqual(p.dim, BASE_CHROME.dim);
});

test('property: a set accent or secondary colour always reads against the bg', () => {
  fc.assert(fc.property(fc.option(hexArb, { nil: null }), hexArb, hexArb, (appColor, accentColor, secondaryColor) => {
    const p = derivePalette({ ...DEFAULT_LOOK, appColor, accentColor, secondaryColor }, BASE_CHROME);
    for (const k of ['accent', 'dim']) {
      assert.match(p[k], HEX, k);
      assert.ok(contrastRatio(p[k], p.bg) >= 4.5, `${k} ${p[k]} on ${p.bg}`);
    }
  }));
});

// Dexter (accent review) #1: the inner-agent pill draws its label ON the accent.
test('the label drawn on a chosen accent reads against it, even on a light app colour', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#ffffff', accentColor: '#000080' }, BASE_CHROME);
  assert.ok(contrastRatio(p.onAccent, p.accent) >= 4.5, `${p.onAccent} on ${p.accent}`);
});

test('property: the label on a chosen accent always reads', () => {
  fc.assert(fc.property(fc.option(hexArb, { nil: null }), hexArb, (appColor, accentColor) => {
    const p = derivePalette({ ...DEFAULT_LOOK, appColor, accentColor }, BASE_CHROME);
    assert.match(p.onAccent, HEX);
    assert.ok(contrastRatio(p.onAccent, p.accent) >= 4.5, `${p.onAccent} on ${p.accent}`);
  }));
});

// Dexter (accent review) #3: tabs and the header sit on the PANEL, not the bg.
test('a chosen accent reads against the panel too, not only the bg', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#000000', accentColor: '#767676' }, BASE_CHROME);
  assert.ok(contrastRatio(p.accent, p.panel) >= 4.5, `${p.accent} on panel ${p.panel}`);
});

// On the panel the bar is "4.5:1, or the best black/white can do": for a
// mid-tone app colour (#7265b1, found by this property) no colour reaches 4.5:1
// on both the bg and its slightly lighter panel.
test('property: set text, accent and secondary colours read on the bg, and as well as possible on the panel', () => {
  fc.assert(fc.property(fc.option(hexArb, { nil: null }), hexArb, hexArb, hexArb,
    (appColor, textColor, accentColor, secondaryColor) => {
      const p = derivePalette({ ...DEFAULT_LOOK, appColor, textColor, accentColor, secondaryColor }, BASE_CHROME);
      const extreme = contrastRatio('#ffffff', p.bg) >= contrastRatio('#000000', p.bg) ? '#ffffff' : '#000000';
      const panelBar = Math.min(4.5, contrastRatio(extreme, p.panel));
      for (const k of ['text', 'accent', 'dim']) {
        assert.ok(contrastRatio(p[k], p.bg) >= 4.5, `${k} ${p[k]} on bg ${p.bg}`);
        assert.ok(contrastRatio(p[k], p.panel) >= panelBar - 1e-9, `${k} ${p[k]} on panel ${p.panel}`);
      }
    }));
});

test('a colour that already reads is left exactly as chosen', () => {
  const p = derivePalette({ ...DEFAULT_LOOK, appColor: '#101010', textColor: '#f0f0f0' }, BASE_CHROME);
  assert.strictEqual(p.text, '#f0f0f0');
  const t = terminalOverride({ ...DEFAULT_LOOK, appColor: '#101010' }, { background: '#000000', foreground: '#f0f0f0' });
  assert.strictEqual(t.background, '#101010');
});
