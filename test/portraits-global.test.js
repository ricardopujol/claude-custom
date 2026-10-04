'use strict';
/**
 * BACKLOG C #3: a user-set GLOBAL default agent picture, the 'global' tier.
 *
 * Chain (highest first): uploaded per-state, uploaded per-agent default, forge
 * per-agent per-state, GLOBAL, forge _default, shipped, text. The user's
 * explicit choice beats the generated shared character, but never an
 * agent-specific asset.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const { portraitFor, globalPortrait, GLOBAL_AGENT } = require('../host/portraits');

const AGENT = 'code-reviewer';
const STATE = 'working';

function put(dir, rel) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
}

// The six file tiers in priority order, each with where it lives.
const LAYERS = [
  { tier: 'uploaded', dir: 'uploadsDir', rel: `${AGENT}/${STATE}.png` },
  { tier: 'uploaded', dir: 'uploadsDir', rel: `${AGENT}/default.png` },
  { tier: 'forge', dir: 'portraitsDir', rel: `${AGENT}/${STATE}.png` },
  { tier: 'global', dir: 'uploadsDir', rel: `${GLOBAL_AGENT}/default.png` },
  { tier: 'forge', dir: 'portraitsDir', rel: `_default/${STATE}.png` },
  { tier: 'shipped', dir: 'shippedDir', rel: 'portrait-default.png' },
];

test('the reserved agent segment is _global', () => {
  assert.strictEqual(GLOBAL_AGENT, '_global');
});

test('a global default covers an agent with nothing of its own', () => {
  const uploadsDir = tmpDir('cc-glob-');
  put(uploadsDir, '_global/default.webm');
  const p = portraitFor(AGENT, STATE, { uploadsDir });
  assert.strictEqual(p.tier, 'global');
  assert.strictEqual(p.kind, 'file');
  assert.strictEqual(p.media, 'video');
});

test('the global default beats the forge shared _default character', () => {
  const uploadsDir = tmpDir('cc-glob-');
  const portraitsDir = tmpDir('cc-glob-forge-');
  put(uploadsDir, '_global/default.png');
  put(portraitsDir, `_default/${STATE}.png`);
  assert.strictEqual(portraitFor(AGENT, STATE, { uploadsDir, portraitsDir }).tier, 'global');
});

test('the global default loses to an agent-specific forge portrait', () => {
  const uploadsDir = tmpDir('cc-glob-');
  const portraitsDir = tmpDir('cc-glob-forge-');
  put(uploadsDir, '_global/default.png');
  put(portraitsDir, `${AGENT}/${STATE}.png`);
  assert.strictEqual(portraitFor(AGENT, STATE, { uploadsDir, portraitsDir }).tier, 'forge');
});

test('the global default loses to a per-agent uploaded default', () => {
  const uploadsDir = tmpDir('cc-glob-');
  put(uploadsDir, '_global/default.png');
  put(uploadsDir, `${AGENT}/default.png`);
  assert.strictEqual(portraitFor(AGENT, STATE, { uploadsDir }).tier, 'uploaded');
});

test('an agent literally named _global is reserved: it never reads the global folder as its own upload', () => {
  const uploadsDir = tmpDir('cc-glob-');
  put(uploadsDir, '_global/working.png');
  const p = portraitFor(GLOBAL_AGENT, 'working', { uploadsDir });
  assert.strictEqual(p.kind, 'placeholder');
  assert.strictEqual(p.tier, 'text');
});

test('globalPortrait reports the file, or null when nothing is set', () => {
  const uploadsDir = tmpDir('cc-glob-');
  assert.strictEqual(globalPortrait(uploadsDir), null);
  assert.strictEqual(globalPortrait(undefined), null);
  put(uploadsDir, '_global/default.gif');
  const g = globalPortrait(uploadsDir);
  assert.strictEqual(g.file, 'default.gif');
  assert.strictEqual(g.path, path.join(uploadsDir, '_global', 'default.gif'));
  assert.strictEqual(g.media, 'image');
});

test('PROPERTY (a): for any subset of present tiers, the highest-priority present one answers and names itself', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: LAYERS.length, maxLength: LAYERS.length }), (present) => {
      const dirs = {
        uploadsDir: tmpDir('cc-prop-up-'),
        portraitsDir: tmpDir('cc-prop-fg-'),
        shippedDir: tmpDir('cc-prop-sh-'),
      };
      present.forEach((on, i) => { if (on) put(dirs[LAYERS[i].dir], LAYERS[i].rel); });
      const firstPresent = present.findIndex(Boolean);
      const p = portraitFor(AGENT, STATE, dirs);
      if (firstPresent === -1) {
        assert.strictEqual(p.tier, 'text');
        assert.strictEqual(p.kind, 'placeholder');
      } else {
        assert.strictEqual(p.tier, LAYERS[firstPresent].tier);
        assert.strictEqual(p.path, path.join(dirs[LAYERS[firstPresent].dir], ...LAYERS[firstPresent].rel.split('/')));
      }
    }),
    { numRuns: 64 },
  );
});
