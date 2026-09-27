'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  generateLook, drawLook, lookFailures, oklchToHex, SAFE_LOOK, MAX_ATTEMPTS, DEFAULT_TERMINAL_FG,
  MIN_TEXT_CONTRAST, MIN_CONTROL_CONTRAST, MAX_BG_LUMINANCE,
} = require('../host/palette-gen');
const { derivePalette, terminalOverride, contrastRatio, luminance } = require('../host/look');

const HEX = /^#[0-9a-f]{6}$/;

// A small seeded generator, so a failing property names a seed that replays.
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

// --- oklchToHex: the conversion is written here, so it is pinned here ---------

test('oklchToHex maps the achromatic ends to black and white', () => {
  assert.strictEqual(oklchToHex(0, 0, 0), '#000000');
  assert.strictEqual(oklchToHex(1, 0, 0), '#ffffff');
});

test('oklchToHex reproduces the published OKLCH of sRGB primaries', () => {
  // Reference values: Björn Ottosson's OKLab, as printed by CSS Color 4 tools.
  assert.strictEqual(oklchToHex(0.627955, 0.257683, 29.2339), '#ff0000');
  assert.strictEqual(oklchToHex(0.86644, 0.294827, 142.4953), '#00ff00');
  assert.strictEqual(oklchToHex(0.452014, 0.313214, 264.052), '#0000ff');
});

test('oklchToHex pulls an out-of-gamut chroma back in instead of clipping channels', () => {
  // L=0.7 at chroma 0.4 is outside sRGB for every hue; the result must still be
  // a real colour at (close to) that lightness, not a channel-clipped jump.
  for (const h of [0, 90, 180, 270]) {
    const hex = oklchToHex(0.7, 0.4, h);
    assert.match(hex, HEX);
    const grey = oklchToHex(0.7, 0, 0);
    // Same OKLab lightness means close luminance; a clipped channel drifts far.
    assert.ok(Math.abs(luminance(hex) - luminance(grey)) < 0.08, `${hex} vs ${grey} at h=${h}`);
  }
});

// --- lookFailures: the check itself, fed hand-made bad looks -----------------

const GOOD = { ...SAFE_LOOK };

test('SAFE_LOOK passes every check -- the fallback must be safe by test, not by claim', () => {
  assert.deepStrictEqual(lookFailures(SAFE_LOOK), []);
});

test('lookFailures names a text colour too close to the background', () => {
  const f = lookFailures({ ...GOOD, textColor: '#303030' });
  assert.ok(f.some((m) => /text/.test(m)), f.join('; '));
});

test('lookFailures names a mid-tone background (luminance near 0.18)', () => {
  const f = lookFailures({ ...GOOD, appColor: '#7265b1' });
  assert.ok(f.some((m) => /mid-tone|background/.test(m)), f.join('; '));
});

test('lookFailures names a light background: the CLI text is light and not ours to change', () => {
  const f = lookFailures({ ...GOOD, appColor: '#f4f4f4', textColor: '#101010',
    accentColor: '#803000', secondaryColor: '#404040' });
  assert.ok(f.length > 0);
});

test('lookFailures names a secondary colour the derivation would have to move', () => {
  const f = lookFailures({ ...GOOD, secondaryColor: '#3a3a3a' });
  assert.ok(f.some((m) => /dim|secondary/.test(m)), f.join('; '));
});

test('lookFailures names an accent that would vanish', () => {
  const f = lookFailures({ ...GOOD, accentColor: '#202428' });
  assert.ok(f.some((m) => /accent/.test(m)), f.join('; '));
});

test('lookFailures checks the terminal foreground it is given, not a fixed one', () => {
  // A dark CLI text colour hides on any dark background.
  const f = lookFailures(GOOD, { terminalForeground: '#202020' });
  assert.ok(f.some((m) => /terminal/.test(m)), f.join('; '));
  assert.deepStrictEqual(lookFailures(GOOD, { terminalForeground: DEFAULT_TERMINAL_FG }), []);
});

test('lookFailures refuses a look with a colour missing', () => {
  for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) {
    assert.ok(lookFailures({ ...GOOD, [k]: null }).length > 0, k);
  }
});

// --- generateLook -------------------------------------------------------------

test('generateLook returns the four colours and NOT darkness (Dexter F2, Miguel #2)', () => {
  // darkness is the veil over a custom background image -- a Background
  // section control. Rolling it from "Random colours" dropped a person's 0.9
  // veil to 0.4 and left the CLI text at ~2:1 over a bright photo.
  const look = generateLook(mulberry32(1));
  assert.deepStrictEqual(Object.keys(look).sort(),
    ['accentColor', 'appColor', 'secondaryColor', 'textColor']);
  for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) assert.match(look[k], HEX, k);
  assert.ok(!('darkness' in SAFE_LOOK), 'the fallback does not carry a darkness either');
});

test('generateLook is deterministic for an injected rng', () => {
  assert.deepStrictEqual(generateLook(mulberry32(42)), generateLook(mulberry32(42)));
  assert.notDeepStrictEqual(generateLook(mulberry32(42)), generateLook(mulberry32(43)));
});

test('generateLook defaults to Math.random', () => {
  const look = generateLook();
  assert.deepStrictEqual(lookFailures(look), []);
});

test('property: EVERY generated look passes every contrast pair after derivation', () => {
  fc.assert(fc.property(fc.integer(), (seed) => {
    const look = generateLook(mulberry32(seed));
    assert.deepStrictEqual(lookFailures(look), [], `seed ${seed}: ${JSON.stringify(look)}`);

    // Restated here against derivePalette directly, so the property does not
    // rest on lookFailures alone being right.
    const p = derivePalette(look, {});
    assert.strictEqual(p.bg, look.appColor, 'bg rendered as generated');
    assert.strictEqual(p.text, look.textColor, 'text rendered as generated');
    assert.strictEqual(p.accent, look.accentColor, 'accent rendered as generated');
    assert.strictEqual(p.dim, look.secondaryColor, 'secondary rendered as generated');
    for (const surface of [p.bg, p.panel]) {
      for (const fg of [p.text, p.accent, p.dim]) {
        assert.ok(contrastRatio(fg, surface) >= MIN_TEXT_CONTRAST, `${fg} on ${surface}`);
      }
    }
    assert.ok(contrastRatio(p.onAccent, p.accent) >= MIN_TEXT_CONTRAST, 'pill label on accent');
    for (const control of [p.accent, p.dim]) {
      assert.ok(contrastRatio(control, p.border) >= MIN_CONTROL_CONTRAST, `${control} on border`);
    }
    assert.ok(luminance(p.bg) <= MAX_BG_LUMINANCE, `bg ${p.bg} is not dark`);
    const t = terminalOverride(look, { foreground: DEFAULT_TERMINAL_FG });
    assert.strictEqual(t.background, look.appColor, 'terminal background matches the app');
  }), { numRuns: 500 });
});

test('the property above is not passing on the fallback: a draw nearly always passes first time', () => {
  // Without this, "every generated look passes" would also be true of a
  // generator that always fell back to SAFE_LOOK.
  let firstTry = 0;
  const distinct = new Set();
  for (let seed = 0; seed < 1000; seed++) {
    if (lookFailures(drawLook(mulberry32(seed))).length === 0) firstTry++;
    const look = generateLook(mulberry32(seed));
    assert.notDeepStrictEqual(look, { ...SAFE_LOOK }, `seed ${seed} fell back`);
    distinct.add(look.appColor);
  }
  assert.ok(firstTry >= 990, `only ${firstTry}/1000 draws passed first time`);
  assert.ok(distinct.size > 900, `only ${distinct.size} distinct backgrounds in 1000 draws`);
});

test('generateLook retries a failing candidate and returns the first that passes', () => {
  let calls = 0;
  const bad = { ...SAFE_LOOK, textColor: '#202020' };
  const good = { ...SAFE_LOOK, accentColor: '#e8a060' };
  assert.deepStrictEqual(lookFailures(good), []);
  const look = generateLook(Math.random, { candidate: () => (++calls < 3 ? bad : good) });
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(look, good);
});

test('generateLook gives up after MAX_ATTEMPTS and falls back to SAFE_LOOK', () => {
  let calls = 0;
  const bad = { ...SAFE_LOOK, textColor: '#202020' };
  const look = generateLook(Math.random, { candidate: () => { calls++; return bad; } });
  assert.strictEqual(calls, MAX_ATTEMPTS);
  assert.deepStrictEqual(look, { ...SAFE_LOOK });
  assert.ok(MAX_ATTEMPTS >= 1 && MAX_ATTEMPTS <= 100);
});

test('generateLook passes the terminal foreground through to the check', () => {
  // With a foreground no dark background can carry, nothing passes: fallback.
  let calls = 0;
  const look = generateLook(mulberry32(7), {
    terminalForeground: '#000000',
    candidate: () => { calls++; return { ...SAFE_LOOK }; },
  });
  assert.strictEqual(calls, MAX_ATTEMPTS);
  assert.deepStrictEqual(look, { ...SAFE_LOOK });
});
