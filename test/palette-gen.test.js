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
  let calls = 0;
  generateLook(mulberry32(7), {
    terminalForeground: '#000000',
    candidate: () => { calls++; return { ...SAFE_LOOK }; },
  });
  assert.strictEqual(calls, MAX_ATTEMPTS, 'SAFE_LOOK fails under black CLI text, so every draw is refused');
});

test('Dexter F1: the fallback is re-checked -- under a theme SAFE_LOOK fails, the answer is null, never a failing look', () => {
  // A light-background terminal theme: no dark app colour carries its text.
  for (const fg of ['#202020', '#000000']) {
    assert.ok(lookFailures(SAFE_LOOK, { terminalForeground: fg }).length > 0, `premise: SAFE_LOOK fails on ${fg}`);
    assert.strictEqual(generateLook(mulberry32(3), { terminalForeground: fg }), null, fg);
  }
});

test('Dexter F1: whatever generateLook returns passes for the foreground it was given', () => {
  fc.assert(fc.property(fc.integer(), fc.stringMatching(/^#[0-9a-f]{6}$/), (seed, fg) => {
    const look = generateLook(mulberry32(seed), { terminalForeground: fg });
    if (look !== null) assert.deepStrictEqual(lookFailures(look, { terminalForeground: fg }), []);
  }), { numRuns: 200 });
});

// --- generateLookFrom: a look seeded by a background's own colours (#34) --------

const {
  generateLookFrom, drawLookFrom, seedParts, hexToOklch, tameDraw, noSeedsReason,
} = require('../host/palette-gen');

const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

test('hexToOklch inverts oklchToHex for in-gamut colours, and reads black, white and grey as no chroma', () => {
  for (const hex of ['#ff0000', '#00ff00', '#3a6ea5', '#e0a060', '#16181f']) {
    const { L, C, h } = hexToOklch(hex);
    assert.strictEqual(oklchToHex(L, C, h), hex);
  }
  assert.ok(Math.abs(hexToOklch('#ffffff').L - 1) < 1e-3);
  assert.ok(hexToOklch('#000000').L < 1e-3);
  assert.ok(hexToOklch('#808080').C < 1e-3);
  assert.strictEqual(hexToOklch('nope'), null);
  assert.strictEqual(hexToOklch(null), null);
});

test('seedParts keeps only real colours, the first chromatic one is the base, and nothing usable is null', () => {
  assert.strictEqual(seedParts([]), null);
  assert.strictEqual(seedParts('#ff0000'), null);
  assert.strictEqual(seedParts(null), null);
  assert.strictEqual(seedParts(['nope', 3, null, '#12']), null);
  const red = hexToOklch('#c04030');
  const p = seedParts(['nope', '#c04030', '#3050c0']);
  assert.ok(hueGap(p.base.h, red.h) < 1e-6, 'the base is the first VALID chromatic seed');
  assert.ok(p.accent && hueGap(p.accent.h, hexToOklch('#3050c0').h) < 1e-6, 'the accent seed is another hue');
});

test('seedParts: a grey background picture has a neutral base and no accent seed', () => {
  const p = seedParts(['#202020', '#808080', '#f0f0f0']);
  assert.ok(p.base.C < 0.02);
  assert.strictEqual(p.accent, null);
});

test('seedParts skips a grey first seed for the chromatic one behind it', () => {
  const p = seedParts(['#101010', '#2060c0']);
  assert.ok(hueGap(p.base.h, hexToOklch('#2060c0').h) < 1e-6);
});

test('seedParts takes at most 8 seeds', () => {
  const many = Array.from({ length: 50 }, (_, i) => (i < 8 ? '#101010' : '#ff0000'));
  assert.strictEqual(seedParts(many).accent, null, 'the red seeds past the 8th are never read');
});

test('generateLookFrom returns a look that passes every gate, tinted with the seed hue', () => {
  const rng = mulberry32(11);
  const seeds = ['#2a5a8a', '#d08040'];
  const look = generateLookFrom(seeds, rng);
  assert.deepStrictEqual(lookFailures(look), []);
  const bg = hexToOklch(look.appColor);
  assert.ok(hueGap(bg.h, hexToOklch('#2a5a8a').h) < 12, `the app colour follows the first seed's hue (${bg.h})`);
  const accent = hexToOklch(look.accentColor);
  assert.ok(hueGap(accent.h, hexToOklch('#d08040').h) < 12, `the accent follows the other seed's hue (${accent.h})`);
});

test('generateLookFrom is deterministic for a given rng and honours the injected rng', () => {
  const a = generateLookFrom(['#2a5a8a', '#d08040'], mulberry32(5));
  const b = generateLookFrom(['#2a5a8a', '#d08040'], mulberry32(5));
  const c = generateLookFrom(['#2a5a8a', '#d08040'], mulberry32(6));
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c, 'a re-roll gives a different look');
});

test('generateLookFrom defaults to Math.random', () => {
  const orig = Math.random;
  let used = 0;
  Math.random = () => { used++; return 0.5; };
  try { generateLookFrom(['#2a5a8a']); } finally { Math.random = orig; }
  assert.ok(used > 0);
});

test('generateLookFrom refuses honestly: nothing usable, or no look reads against this terminal', () => {
  for (const s of [undefined, null, [], ['nope'], 'x', 5]) assert.strictEqual(generateLookFrom(s, mulberry32(1)), null, String(s));
  assert.strictEqual(generateLookFrom(['#2a5a8a'], mulberry32(1), { terminalForeground: '#000000' }), null);
  assert.match(noSeedsReason(), /seed|colour/i);
});

test('generateLookFrom retries a failing candidate, then uses the tame draw, then refuses', () => {
  let calls = 0;
  const bad = { ...SAFE_LOOK, textColor: '#202020' };
  const look = generateLookFrom(['#2a5a8a'], mulberry32(2), { candidate: () => { calls++; return bad; } });
  assert.strictEqual(calls, MAX_ATTEMPTS);
  assert.deepStrictEqual(lookFailures(look), [], 'the fallback is a passing, seeded look');
  assert.ok(hueGap(hexToOklch(look.appColor).h, hexToOklch('#2a5a8a').h) < 12, 'and it is still the background\'s hue');
  // the first passing draw wins
  let n = 0;
  const first = generateLookFrom(['#2a5a8a'], mulberry32(2), { candidate: () => (++n === 3 ? SAFE_LOOK : bad) });
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(first, { ...SAFE_LOOK });
  // a tame draw that cannot pass either (black CLI text) is a refusal
  assert.strictEqual(generateLookFrom(['#2a5a8a'], mulberry32(2),
    { terminalForeground: '#000000', candidate: () => bad }), null);
});

test('the tame draw is exported and passes on its own for any hue', () => {
  for (const h of [0, 60, 120, 180, 240, 300]) {
    const parts = { base: { L: 0.5, C: 0.1, h }, accent: null };
    assert.deepStrictEqual(lookFailures(tameDraw(parts)), [], `hue ${h}`);
  }
});

test('PROPERTY: any seeds and any rng give a passing look or an honest refusal, never a failing look', () => {
  const seeds = fc.array(fc.oneof(fc.stringMatching(/^#[0-9a-f]{6}$/), fc.string(), fc.constant(null)), { maxLength: 12 });
  fc.assert(fc.property(seeds, fc.integer(), fc.stringMatching(/^#[0-9a-f]{6}$/), (s, seed, fg) => {
    const look = generateLookFrom(s, mulberry32(seed), { terminalForeground: fg });
    if (look === null) return;
    assert.deepStrictEqual(lookFailures(look, { terminalForeground: fg }), []);
    for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) assert.match(look[k], HEX);
  }), { numRuns: 400 });
});

test('PROPERTY: for the default terminal, valid chromatic seeds always yield a look (the draw is not secretly always refusing)', () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^#[0-9a-f]{6}$/), { minLength: 1, maxLength: 6 }), fc.integer(), (s, seed) => {
    assert.notStrictEqual(generateLookFrom(s, mulberry32(seed)), null);
  }), { numRuns: 300 });
});

test('PROPERTY: the app colour stays dark whatever the seeds are', () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^#[0-9a-f]{6}$/), { minLength: 1, maxLength: 6 }), fc.integer(), (s, seed) => {
    const look = generateLookFrom(s, mulberry32(seed));
    assert.ok(luminance(look.appColor) <= MAX_BG_LUMINANCE);
  }), { numRuns: 200 });
});

test('drawLookFrom is a plain draw: it can be wrong, the gates are what make it safe', () => {
  const d = drawLookFrom(mulberry32(1), seedParts(['#2a5a8a', '#d08040']));
  for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) assert.match(d[k], HEX);
});

test('the seeded draw nearly always passes first time, so a match is a draw and not the tame fallback', () => {
  let first = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const rng = mulberry32(i);
    const hex = oklchToHex(0.3 + rng() * 0.5, 0.04 + rng() * 0.2, rng() * 360);
    const parts = seedParts([hex, oklchToHex(0.6, 0.15, rng() * 360)]);
    if (lookFailures(drawLookFrom(rng, parts)).length === 0) first++;
  }
  assert.ok(first / trials >= 0.95, `${first}/${trials} draws passed first time`);
});

test('M7: the tame draw is a function named like one, tameDraw, and the constant-style name is gone', () => {
  const pg = require('../host/palette-gen');
  assert.strictEqual(typeof pg.tameDraw, 'function');
  assert.strictEqual(pg.TAME_PARTS_DRAW, undefined);
});

// Dexter D1 (PR #91): a grey picture has no hue. It was read as hue 0 (red), so every grey picture's
// accent came out green-cyan and its secondary text pink.
const isGrey = (hex) => hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7);

test('D1: a grey has no hue -- null, not 0 (which is red)', () => {
  for (const g of ['#808080', '#000000', '#ffffff', '#202020']) assert.strictEqual(hexToOklch(g).h, null, g);
  assert.strictEqual(seedParts(['#808080']).base.h, null);
});

test('D1: a grey picture gives a neutral palette, every colour grey, the accent too, and it passes the gates', () => {
  for (let seed = 0; seed < 60; seed++) {
    const look = generateLookFrom(['#808080'], mulberry32(seed));
    assert.ok(look, `seed ${seed}`);
    assert.deepStrictEqual(lookFailures(look), [], `seed ${seed}`);
    for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) assert.ok(isGrey(look[k]), `${k} ${look[k]} (seed ${seed})`);
  }
  const tame = tameDraw(seedParts(['#202020', '#808080', '#f0f0f0']));
  assert.deepStrictEqual(lookFailures(tame), []);
  for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) assert.ok(isGrey(tame[k]), `tame ${k} ${tame[k]}`);
});

test('PROPERTY D1: any all-grey seed list gives a look with no hue at all', () => {
  const grey = fc.integer({ min: 0, max: 255 }).map((v) => '#' + v.toString(16).padStart(2, '0').repeat(3));
  fc.assert(fc.property(fc.array(grey, { minLength: 1, maxLength: 8 }), fc.integer(), (s, seed) => {
    const look = generateLookFrom(s, mulberry32(seed));
    assert.ok(look);
    for (const k of ['appColor', 'textColor', 'accentColor', 'secondaryColor']) assert.ok(isGrey(look[k]), `${k} ${look[k]}`);
  }), { numRuns: 200 });
});

// Dexter D3 (PR #91): the 30° accent gap was checked on the SEEDS, then ±3° of jitter on each side
// could bring the drawn accent to 24° from the drawn app colour.
const { drawHues, ACCENT_HUE_GAP } = require('../host/palette-gen');
const scripted = (...vals) => { let i = 0; return () => (i < vals.length ? vals[i++] : 0.5); };

test('D3: seeds exactly at the gap, jittered towards each other, still draw an accent at least the gap away', () => {
  const parts = { base: { L: 0.5, C: 0.1, h: 100 }, accent: { L: 0.6, C: 0.12, h: 130 } };
  // first draw near 1: hue ~103; second draw 0: accent ~127 -- 24° apart before the fix
  const { hue, accentHue } = drawHues(scripted(0.9999, 0), parts);
  assert.ok(hueGap(hue, accentHue) >= ACCENT_HUE_GAP - 1e-9, `${hue} vs ${accentHue}`);
  assert.ok(accentHue > hue, 'pushed out on its own side, not flipped across the app colour');
  // across 0°/360° too
  const wrapped = drawHues(scripted(0, 0.9999), { base: { L: 0.5, C: 0.1, h: 2 }, accent: { L: 0.6, C: 0.12, h: 332 } });
  assert.ok(hueGap(wrapped.hue, wrapped.accentHue) >= ACCENT_HUE_GAP - 1e-9, JSON.stringify(wrapped));
});

test('PROPERTY D3: whenever an accent seed is chosen, the drawn accent is at least the gap from the drawn app hue', () => {
  const hue = fc.double({ min: 0, max: 359.999, noNaN: true });
  fc.assert(fc.property(hue, fc.double({ min: ACCENT_HUE_GAP, max: 180, noNaN: true }), fc.boolean(), fc.integer(),
    (h, gap, up, seed) => {
      const parts = { base: { L: 0.5, C: 0.1, h }, accent: { L: 0.6, C: 0.12, h: ((up ? h + gap : h - gap) + 360) % 360 } };
      const d = drawHues(mulberry32(seed), parts);
      assert.ok(hueGap(d.hue, d.accentHue) >= ACCENT_HUE_GAP - 1e-9, JSON.stringify({ h, gap, d }));
    }), { numRuns: 500 });
});
