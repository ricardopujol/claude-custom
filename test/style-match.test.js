'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { matchLook, readLook, setLook, setBackground, LOOK_DIR_NAME, NO_PALETTE_REASON } = require('../host/style');
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

test('matchLook saves a readable look seeded by the background, and says so', () => {
  const cwd = tmpDir('cc-match-');
  const r = matchLook({ cwd, seeds: ['#2a5a8a', '#d08040'], rng: mulberry32(4) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const saved = readLook(cwd);
  assert.deepStrictEqual(lookFailures(saved), []);
  assert.deepStrictEqual(COLOURS.map((k) => saved[k]), COLOURS.map((k) => r.look[k]));
  const gap = Math.abs(hexToOklch(saved.appColor).h - hexToOklch('#2a5a8a').h);
  assert.ok(Math.min(gap, 360 - gap) < 15, 'the app colour is the background\'s hue');
});

test('matchLook keeps the background and the darkness, like a re-roll does', () => {
  const cwd = tmpDir('cc-match-bg-');
  const src = tmpDir('cc-match-src-');
  const png = path.join(src, 'p.png');
  fs.writeFileSync(png, 'png-bytes');
  setBackground({ source: png, cwd });
  setLook({ cwd, patch: { darkness: 0.8 } });
  assert.strictEqual(matchLook({ cwd, seeds: ['#2a5a8a'], rng: mulberry32(1) }).ok, true);
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

test('matchLook with no readable palette says so and leaves look.json byte-identical', () => {
  const cwd = tmpDir('cc-match-nopal-');
  setLook({ cwd, patch: { appColor: '#123456' } });
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  // black CLI text: no dark app colour can carry it, so no palette passes
  const r = matchLook({ cwd, seeds: ['#2a5a8a'], rng: mulberry32(1), terminalForeground: '#000000' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, NO_PALETTE_REASON);
  assert.strictEqual(NO_PALETTE_REASON, 'No readable palette in this background; kept your colours');
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
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
