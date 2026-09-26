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
