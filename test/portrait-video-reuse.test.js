'use strict';
/**
 * Dexter F1 / Miguel I2 (PR #64): a roster repaint must not restart a video.
 * The repaint runs about once a second while anything is running, so a
 * working.webm that is unloaded and recreated each time never gets past its
 * first second. The decision "which existing <video> nodes survive this paint"
 * is pure and lives in app/portrait-media-display.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { videoKey, planVideoReuse, faceMediaHtml } = require('../app/portrait-media-display');

const vid = (over = {}) => ({
  kind: 'file', tier: 'uploaded', media: 'video', agent: 'coder', state: 'working',
  path: 'C:\\h\\coder\\working.webm', mtimeMs: 5, fallback: { initials: 'CO', hue: 1 }, ...over,
});

test('a video face has a key made of the agent and the exact URL', () => {
  const k = videoKey(vid(), { imagesEnabled: true });
  assert.match(k, /coder/);
  assert.match(k, /working\.webm\?v=5/);
});

test('the same result gives the same key on every paint', () => {
  assert.strictEqual(videoKey(vid(), { imagesEnabled: true }), videoKey(vid(), { imagesEnabled: true }));
});

test('a replaced file (new mtime), another agent, or another file changes the key', () => {
  const base = videoKey(vid(), { imagesEnabled: true });
  assert.notStrictEqual(videoKey(vid({ mtimeMs: 6 }), { imagesEnabled: true }), base);
  assert.notStrictEqual(videoKey(vid({ agent: 'other' }), { imagesEnabled: true }), base);
  assert.notStrictEqual(videoKey(vid({ path: 'C:\\h\\coder\\happy.webm' }), { imagesEnabled: true }), base);
});

test('images, placeholders, and everything while images are off have no video key', () => {
  assert.strictEqual(videoKey(vid({ media: 'image', path: 'C:\\a.png' }), { imagesEnabled: true }), null);
  assert.strictEqual(videoKey(vid(), { imagesEnabled: false }), null);
  assert.strictEqual(videoKey(vid(), { imagesEnabled: null }), null);
  assert.strictEqual(videoKey(null, { imagesEnabled: true }), null);
});

test('the markup carries the key so the renderer can find the node again', () => {
  const html = faceMediaHtml(vid(), { imagesEnabled: true });
  assert.match(html, /data-face-key="[^"]*working\.webm\?v=5"/);
});

test('a key with markup characters cannot break out of its attribute', () => {
  const html = faceMediaHtml(vid({ agent: 'a"><script>' }), { imagesEnabled: true });
  assert.doesNotMatch(html, /<script>/);
});

test('planVideoReuse keeps nodes whose key is unchanged and drops the ones that went away', () => {
  const plan = planVideoReuse(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepStrictEqual([...plan.reuse].sort(), ['b', 'c']);
  assert.deepStrictEqual(plan.drop.sort(), ['a']);
});

test('planVideoReuse with an identical paint reuses everything and drops nothing', () => {
  const plan = planVideoReuse(['a', 'b'], ['a', 'b']);
  assert.deepStrictEqual([...plan.reuse].sort(), ['a', 'b']);
  assert.deepStrictEqual(plan.drop, []);
});

test('planVideoReuse tolerates duplicates and non-arrays', () => {
  assert.deepStrictEqual(planVideoReuse(['a', 'a'], ['a', 'a']).drop, []);
  assert.deepStrictEqual(planVideoReuse(undefined, ['a']).drop, []);
  assert.deepStrictEqual([...planVideoReuse(['a'], null).reuse], []);
});

test('PROPERTY: every old key is either reused or dropped, never both, never lost', () => {
  fc.assert(fc.property(fc.array(fc.string()), fc.array(fc.string()), (oldKeys, newKeys) => {
    const plan = planVideoReuse(oldKeys, newKeys);
    for (const k of new Set(oldKeys)) {
      assert.strictEqual(plan.reuse.has(k) !== plan.drop.includes(k), true, `key ${JSON.stringify(k)}`);
      assert.strictEqual(plan.reuse.has(k), newKeys.includes(k));
    }
  }));
});
