'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  matchLook, readLook, setLook, setBackground, resetBackground, LOOK_DIR_NAME, NO_PALETTE_REASON,
  NO_OWN_BACKGROUND_REASON, STALE_MATCH_REASON,
} = require('../host/style');
const { lookFailures, hexToOklch } = require('../host/palette-gen');
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
const lookFile = (cwd) => path.join(cwd, LOOK_DIR_NAME, 'look.json');
const COLOURS = ['appColor', 'textColor', 'accentColor', 'secondaryColor'];

// A Match is only ever for the person's own background (Dexter D5): give the project one, and
// answer the setAt the renderer would send for it.
async function ownBackground(cwd) {
  const src = tmpDir('cc-match-own-');
  const png = path.join(src, 'own.png');
  fs.writeFileSync(png, 'png-bytes');
  const r = await setBackground({ source: png, cwd });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.setAt;
}

test('matchLook saves a readable look seeded by the background, and says so', async () => {
  const cwd = tmpDir('cc-match-');
  const setAt = await ownBackground(cwd);
  const r = matchLook({ cwd, seeds: ['#2a5a8a', '#d08040'], setAt, rng: mulberry32(4) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const saved = readLook(cwd);
  assert.deepStrictEqual(lookFailures(saved), []);
  assert.deepStrictEqual(COLOURS.map((k) => saved[k]), COLOURS.map((k) => r.look[k]));
  const gap = Math.abs(hexToOklch(saved.appColor).h - hexToOklch('#2a5a8a').h);
  assert.ok(Math.min(gap, 360 - gap) < 15, 'the app colour is the background\'s hue');
});

test('matchLook keeps the background and the darkness, like a re-roll does', async () => {
  const cwd = tmpDir('cc-match-bg-');
  const src = tmpDir('cc-match-src-');
  const png = path.join(src, 'p.png');
  fs.writeFileSync(png, 'png-bytes');
  const { setAt } = await setBackground({ source: png, cwd });
  setLook({ cwd, patch: { darkness: 0.8 } });
  assert.strictEqual(matchLook({ cwd, seeds: ['#2a5a8a'], setAt, rng: mulberry32(1) }).ok, true);
  assert.strictEqual(readLook(cwd).darkness, 0.8);
  assert.strictEqual(readLook(cwd).background.file, 'background.png');
});

test('matchLook refuses a seed list with nothing usable, and writes nothing', () => {
  const cwd = tmpDir('cc-match-none-');
  for (const seeds of [undefined, null, 'x', [], ['nope', 3, null], {}]) {
    const r = matchLook({ cwd, seeds, rng: mulberry32(1) });
    assert.strictEqual(r.ok, false, JSON.stringify(seeds));
    assert.match(r.reason, /no usable colours/);
  }
  assert.ok(!fs.existsSync(path.join(cwd, LOOK_DIR_NAME)), 'no folder was created for a refusal');
});

test('matchLook with no readable palette says so and leaves look.json byte-identical', async () => {
  const cwd = tmpDir('cc-match-nopal-');
  const setAt = await ownBackground(cwd);
  setLook({ cwd, patch: { appColor: '#123456' } });
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  // a generator that finds nothing for these colours, whatever the terminal
  const r = matchLook({ cwd, seeds: ['#2a5a8a'], setAt, rng: mulberry32(1), generate: () => null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, NO_PALETTE_REASON);
  assert.strictEqual(NO_PALETTE_REASON, 'No readable palette in this background; kept your colours');
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
});

test('D2: with a light terminal theme the refusal names the theme\'s text colour, not the background', async () => {
  for (const fg of ['#24292f', '#000000']) {
    const cwd = tmpDir('cc-match-theme-');
    const setAt = await ownBackground(cwd);
    setLook({ cwd, patch: { appColor: '#123456' } });
    const before = fs.readFileSync(lookFile(cwd), 'utf8');
    const r = matchLook({ cwd, seeds: ['#1f4f9a'], setAt, rng: mulberry32(1), terminalForeground: fg });
    assert.strictEqual(r.ok, false, fg);
    assert.notStrictEqual(r.reason, NO_PALETTE_REASON, fg);
    assert.ok(r.reason.includes(`terminal text (${fg})`), r.reason);
    assert.match(r.reason, /kept your colours/);
    assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
  }
});

test('matchLook refuses a corrupt look folder exactly as setLook does', () => {
  const cwd = tmpDir('cc-match-corrupt-');
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  fs.writeFileSync(lookFile(cwd), '{not json');
  const r = matchLook({ cwd, seeds: ['#2a5a8a'], rng: mulberry32(1) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /look\.json can't be read/);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), '{not json');
});

test('D5: a Match landing after the background was reset to the generated art is refused, and writes nothing', async () => {
  const cwd = tmpDir('cc-match-reset-');
  const setAt = await ownBackground(cwd);
  setLook({ cwd, patch: { appColor: '#123456' } });
  resetBackground({ cwd });                                  // window 2, while window 1 was sampling
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  const r = matchLook({ cwd, seeds: ['#2a5a8a'], setAt, rng: mulberry32(1) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, NO_OWN_BACKGROUND_REASON);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
});

test('D5: a Match for a background that has since been replaced is refused as stale, and writes nothing', async () => {
  const cwd = tmpDir('cc-match-stale-');
  const sampled = await ownBackground(cwd);
  await new Promise((r) => setTimeout(r, 5));                 // a later setAt
  const current = await ownBackground(cwd);                   // window 2 dropped a new picture
  assert.notStrictEqual(current, sampled);
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  for (const setAt of [sampled, undefined, null, '', 42]) {
    const r = matchLook({ cwd, seeds: ['#2a5a8a'], setAt, rng: mulberry32(1) });
    assert.strictEqual(r.ok, false, String(setAt));
    assert.strictEqual(r.reason, STALE_MATCH_REASON);
  }
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
  assert.strictEqual(matchLook({ cwd, seeds: ['#2a5a8a'], setAt: current, rng: mulberry32(1) }).ok, true, 'the current one matches');
});

test('D5: with no background of your own at all, a Match is refused', () => {
  const cwd = tmpDir('cc-match-gen-');
  setLook({ cwd, patch: { appColor: '#123456' } });
  const r = matchLook({ cwd, seeds: ['#2a5a8a'], setAt: '2026-10-02T00:00:00.000Z', rng: mulberry32(1) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, NO_OWN_BACKGROUND_REASON);
});
