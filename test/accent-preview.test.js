'use strict';
/**
 * The live accent preview (backlog #64, Miguel F3 + F4 + F5): it paints what a
 * saved look would paint, at most once per frame, and "chosen" means what the
 * host's real palette says it means.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { previewChrome, frameThrottle } = require('../app/accent-preview');
const { chosenAccent, cueColour, withChosenAccent } = require('../app/top-bar-display');
const { derivePalette } = require('../host/look');
const { DEFAULT_THEME } = require('../host/themes');

const hex6 = fc.integer({ min: 0, max: 0xffffff }).map((n) => '#' + n.toString(16).padStart(6, '0'));
const BASE = { bg: '#11131a', panel: '#171a23', border: '#262b38', text: '#c7cede', dim: '#6d7689', accent: '#d08c4a' };

test('F4: the preview paints exactly what a saved look would, so the colour does not jump on commit', () => {
  fc.assert(fc.property(hex6, hex6, hex6, (accent, bg, panel) => {
    const chrome = { ...BASE, bg, panel };
    const saved = derivePalette({ accentColor: accent }, chrome);
    const live = previewChrome(accent, chrome);
    return live.accent === saved.accent && live.onAccent === saved.onAccent;
  }), { numRuns: 300 });
});

test('F4: a low-contrast pick is moved to a readable one in the preview too', () => {
  const live = previewChrome('#12141c', BASE);     // all but the panel's own colour
  assert.notStrictEqual(live.accent, '#12141c');
  assert.strictEqual(live.accent, derivePalette({ accentColor: '#12141c' }, BASE).accent);
  assert.strictEqual(previewChrome('#00ff88', BASE).accent, '#00ff88', 'a colour that already reads is untouched');
});

test('previewChrome: nothing to preview for a non-colour, and no chrome yet is fine', () => {
  for (const bad of ['red', '#fff', '', null, undefined, 5]) assert.strictEqual(previewChrome(bad, BASE), null);
  assert.deepStrictEqual(previewChrome('#00FF88', null).accent, '#00ff88');
});

test('F5: chosenAccent agrees with the real derivePalette, with and without an accent', () => {
  const chrome = DEFAULT_THEME.chrome;
  assert.ok(chrome && chrome.bg, 'the real default theme\'s chrome');
  const chosen = { chrome: derivePalette({ accentColor: '#00ff88' }, chrome) };
  assert.strictEqual(chosenAccent(chosen), chosen.chrome.accent, 'a look with an accent is a choice');
  assert.strictEqual(cueColour('opus', chosen), chosen.chrome.accent);
  for (const look of [{}, { appColor: '#202020' }, { textColor: '#eeeeee', secondaryColor: '#aaaaaa' }]) {
    const t = { chrome: derivePalette(look, chrome) };
    assert.strictEqual(chosenAccent(t), null, `no accent chosen in ${JSON.stringify(look)}`);
  }
});

test('withChosenAccent takes the preview\'s label colour, so chips read during the drag', () => {
  const t = withChosenAccent({ chrome: { accent: '#d08c4a' } }, '#ffffff', '#000000');
  assert.strictEqual(t.chrome.onAccent, '#000000');
  assert.strictEqual(withChosenAccent({ chrome: { onAccent: '#111111' } }, '#ffffff').chrome.onAccent, '#111111');
});

test('F3: frameThrottle runs once per frame, with the last argument', () => {
  const frames = [];
  const seen = [];
  const call = frameThrottle((cb) => frames.push(cb), (v) => seen.push(v));
  call('#000001');
  call('#000002');
  call('#000003');
  assert.strictEqual(frames.length, 1, 'one frame scheduled, however many inputs');
  assert.deepStrictEqual(seen, []);
  frames.shift()();
  assert.deepStrictEqual(seen, ['#000003']);
  call('#000004');
  assert.strictEqual(frames.length, 1, 'the next frame can be scheduled again');
  frames.shift()();
  assert.deepStrictEqual(seen, ['#000003', '#000004']);
});

test('property: n inputs in one frame cause exactly one call, with the last value', () => {
  fc.assert(fc.property(fc.array(hex6, { minLength: 1, maxLength: 50 }), (values) => {
    const frames = [];
    const seen = [];
    const call = frameThrottle((cb) => frames.push(cb), (v) => seen.push(v));
    values.forEach(call);
    frames.forEach((f) => f());
    return frames.length === 1 && seen.length === 1 && seen[0] === values[values.length - 1];
  }));
});
