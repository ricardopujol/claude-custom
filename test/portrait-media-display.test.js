'use strict';
/**
 * app/portrait-media-display.js: which element a face becomes (BACKLOG C #13),
 * when a video may run, and the "agent images off" override (#18).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  mediaElementFor, faceMediaHtml, visibilityAction, unloadVideo, fileUrl, tierTitle,
} = require('../app/portrait-media-display');

const PLACEHOLDER = { kind: 'placeholder', tier: 'text', agent: 'code-reviewer', initials: 'CR', hue: 120 };
const file = (over = {}) => ({
  kind: 'file', tier: 'uploaded', media: 'image', agent: 'code-reviewer', state: 'working',
  path: 'C:\\h\\portraits\\code-reviewer\\working.png', mtimeMs: 1234,
  fallback: { initials: 'CR', hue: 120 }, ...over,
});

// --- mediaElementFor ---------------------------------------------------------

test('an image result becomes an <img> whose src is a file URL', () => {
  const d = mediaElementFor(file(), { imagesEnabled: true });
  assert.strictEqual(d.tag, 'img');
  assert.match(d.attrs.src, /^file:\/\/\/C:\/h\/portraits\/code-reviewer\/working\.png/);
});

test('a video result becomes a looping, muted, autoplaying, inline <video>', () => {
  const d = mediaElementFor(file({ media: 'video', path: 'C:\\h\\a\\working.webm' }), { imagesEnabled: true });
  assert.strictEqual(d.tag, 'video');
  for (const flag of ['autoplay', 'loop', 'muted', 'playsinline']) assert.strictEqual(d.attrs[flag], true, flag);
  assert.match(d.attrs.src, /working\.webm/);
});

test('a GIF stays an <img>, never a <video>', () => {
  const d = mediaElementFor(file({ media: 'image', path: 'C:\\h\\a\\working.gif' }), { imagesEnabled: true });
  assert.strictEqual(d.tag, 'img');
});

test('the URL carries the file mtime, so a same-extension re-upload is not served from cache', () => {
  const a = mediaElementFor(file({ mtimeMs: 1 }), { imagesEnabled: true }).attrs.src;
  const b = mediaElementFor(file({ mtimeMs: 2 }), { imagesEnabled: true }).attrs.src;
  assert.notStrictEqual(a, b);
  assert.match(a, /\?v=1$/);
});

test('a result with no known mtime gets no cache-buster, not "?v=undefined"', () => {
  const src = mediaElementFor(file({ mtimeMs: undefined }), { imagesEnabled: true }).attrs.src;
  assert.doesNotMatch(src, /\?|undefined/);
});

test('fileUrl percent-encodes spaces, %, #, ? and astral characters without throwing', () => {
  assert.strictEqual(fileUrl('C:\\My Pics\\a#b.png', null), 'file:///C:/My%20Pics/a%23b.png');
  assert.strictEqual(fileUrl('C:\\100%\\a.png', null), 'file:///C:/100%25/a.png');
  assert.strictEqual(fileUrl('C:\\a?b.png', null), 'file:///C:/a%3Fb.png');
  assert.strictEqual(fileUrl('C:\\\uD83D\uDE00\\a.png', null), 'file:///C:/%F0%9F%98%80/a.png');
});

test('a placeholder result stays a placeholder with its initials and hue', () => {
  const d = mediaElementFor(PLACEHOLDER, { imagesEnabled: true });
  assert.strictEqual(d.tag, 'placeholder');
  assert.strictEqual(d.attrs.initials, 'CR');
  assert.strictEqual(d.attrs.hue, 120);
});

test('null/undefined results draw the "??" placeholder rather than throwing', () => {
  assert.strictEqual(mediaElementFor(null, { imagesEnabled: true }).attrs.initials, '??');
  assert.strictEqual(mediaElementFor(undefined, { imagesEnabled: false }).tag, 'placeholder');
});

test('images off: a file result draws the coloured-initials placeholder from its fallback', () => {
  const d = mediaElementFor(file({ media: 'video' }), { imagesEnabled: false });
  assert.strictEqual(d.tag, 'placeholder');
  assert.strictEqual(d.attrs.initials, 'CR');
  assert.strictEqual(d.attrs.hue, 120);
});

test('images off: a file result with no fallback still draws a placeholder, not an image', () => {
  const r = file(); delete r.fallback;
  const d = mediaElementFor(r, { imagesEnabled: false });
  assert.strictEqual(d.tag, 'placeholder');
  assert.strictEqual(d.attrs.initials, '??');
});

test('an unknown toggle (undefined, null, "true") is not "on": nothing is loaded until it is known', () => {
  for (const v of [undefined, null, 'true', 1]) {
    assert.strictEqual(mediaElementFor(file(), { imagesEnabled: v }).tag, 'placeholder', String(v));
  }
  assert.strictEqual(mediaElementFor(file()).tag, 'placeholder');
});

test('PROPERTY (b): with images off, no result of any shape ever yields img or video', () => {
  const arbResult = fc.oneof(
    fc.record({
      kind: fc.constant('file'),
      tier: fc.constantFrom('uploaded', 'forge', 'global', 'shipped'),
      media: fc.constantFrom('image', 'video'),
      agent: fc.string(),
      path: fc.string(),
      mtimeMs: fc.option(fc.double(), { nil: undefined }),
      fallback: fc.option(fc.record({ initials: fc.string(), hue: fc.integer() }), { nil: undefined }),
    }),
    fc.record({ kind: fc.constant('placeholder'), tier: fc.constant('text'), initials: fc.string(), hue: fc.integer() }),
    fc.constant(null), fc.constant(undefined), fc.anything(),
  );
  fc.assert(fc.property(arbResult, fc.constantFrom(false, undefined, null, 0, 'yes'), (result, flag) => {
    const d = mediaElementFor(result, { imagesEnabled: flag });
    assert.strictEqual(d.tag, 'placeholder');
    const html = faceMediaHtml(result, { imagesEnabled: flag });
    assert.doesNotMatch(html, /<video|<img|file:\/\//i);
  }));
});

// --- faceMediaHtml --------------------------------------------------------------

test('faceMediaHtml renders a video with its boolean attributes and an escaped src', () => {
  const html = faceMediaHtml(file({ media: 'video', path: 'C:\\a"b\\w.webm' }), { imagesEnabled: true });
  assert.match(html, /^<video class="face-media" /);
  assert.match(html, / autoplay loop muted playsinline/);
  assert.doesNotMatch(html, /a"b/);
});

test('faceMediaHtml renders an <img> with an empty alt and the tier wording as its title', () => {
  const html = faceMediaHtml(file(), { imagesEnabled: true });
  assert.match(html, /^<img class="face-media" /);
  assert.match(html, /alt=""/);
  assert.match(html, /title="your upload"/);
});

test('faceMediaHtml escapes markup smuggled through the initials of a placeholder', () => {
  const html = faceMediaHtml({ ...PLACEHOLDER, initials: '<b>x</b>' }, { imagesEnabled: true });
  assert.doesNotMatch(html, /<b>/);
});

test('a non-numeric hue is forced to 0 so it cannot carry markup into the style', () => {
  const html = faceMediaHtml({ ...PLACEHOLDER, hue: '1);}</style><script>' }, { imagesEnabled: true });
  assert.match(html, /hsl\(0 42% 62%\)/);
  assert.doesNotMatch(html, /<script>/);
});

test('images off says so in the placeholder title instead of "no picture yet"', () => {
  const html = faceMediaHtml(file(), { imagesEnabled: false });
  assert.match(html, /agent images are turned off/);
});

// --- tierTitle ------------------------------------------------------------------

test('tierTitle has wording for every tier, and the global one says it is the global default', () => {
  assert.strictEqual(tierTitle({ tier: 'uploaded' }), 'your upload');
  assert.strictEqual(tierTitle({ tier: 'forge' }), 'generated');
  assert.strictEqual(tierTitle({ tier: 'shipped' }), 'default picture');
  assert.strictEqual(tierTitle({ tier: 'text' }), 'no picture yet');
  assert.match(tierTitle({ tier: 'global' }), /global default/);
  assert.strictEqual(tierTitle({ tier: 'nonsense' }), '');
  assert.strictEqual(tierTitle({ tier: 'toString' }), '');
  assert.strictEqual(tierTitle(null), 'no picture yet');
});

// --- visibilityAction -------------------------------------------------------------

test('visibilityAction plays only when the face is on screen AND the document is visible', () => {
  assert.strictEqual(visibilityAction(true, true), 'play');
  assert.strictEqual(visibilityAction(false, true), 'pause');
  assert.strictEqual(visibilityAction(true, false), 'pause');
  assert.strictEqual(visibilityAction(false, false), 'pause');
});

test('PROPERTY (c): visibilityAction is pause whenever either input is not exactly true', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), (a, b) => {
    assert.strictEqual(visibilityAction(a, b), a === true && b === true ? 'play' : 'pause');
  }));
  fc.assert(fc.property(fc.boolean(), fc.boolean(), (a, b) => {
    if (!a || !b) assert.strictEqual(visibilityAction(a, b), 'pause');
  }));
});

// --- unloadVideo ------------------------------------------------------------------

test('unloadVideo pauses, drops the src and calls load() so the decoder is released', () => {
  const calls = [];
  unloadVideo({
    pause: () => calls.push('pause'),
    removeAttribute: (a) => calls.push('remove:' + a),
    load: () => calls.push('load'),
  });
  assert.deepStrictEqual(calls, ['pause', 'remove:src', 'load']);
});

test('unloadVideo carries on when pause() throws, and tolerates a non-video', () => {
  const calls = [];
  unloadVideo({
    pause: () => { throw new Error('detached'); },
    removeAttribute: (a) => calls.push('remove:' + a),
    load: () => calls.push('load'),
  });
  assert.deepStrictEqual(calls, ['remove:src', 'load']);
  assert.doesNotThrow(() => unloadVideo(null));
  assert.doesNotThrow(() => unloadVideo({}));
});

// --- lean mode (BACKLOG #62): the portraits-only strip draws STILL faces ---------------------------------

test('stillFaceHtml: an image that may animate (any name but a known-static one) is drawn into a canvas, never an animating <img> (Dexter F4)', () => {
  const { stillFaceHtml } = require('../app/portrait-media-display');
  const { mayAnimate } = require('../app/lean-display');
  const opts = { imagesEnabled: true, mayAnimate };
  for (const p of ['C:/p/a b.gif', 'C:/p/a.webp', 'C:/p/a.png', 'C:/p/a.svg']) {
    const html = stillFaceHtml({ agent: 'a', kind: 'file', path: p, media: 'image', tier: 'uploaded' }, opts);
    assert.match(html, /^<canvas /, p);
    assert.doesNotMatch(html, /<img|<video/, p);
  }
  assert.ok(stillFaceHtml({ kind: 'file', path: 'C:/p/a b.gif', media: 'image' }, opts).includes('data-still-src="file:///C:/p/a%20b.gif"'));
  assert.match(stillFaceHtml({ kind: 'file', path: 'C:/p/a.webp', media: 'image' }, { imagesEnabled: true }), /^<canvas /, 'no rule given: may animate');
});

test('stillFaceHtml: a jpg stays an <img>', () => {
  const { stillFaceHtml } = require('../app/portrait-media-display');
  const { mayAnimate } = require('../app/lean-display');
  assert.match(stillFaceHtml({ kind: 'file', path: 'C:/p/a.jpg', media: 'image', tier: 'forge' }, { imagesEnabled: true, mayAnimate }), /^<img /);
});

test('stillFaceHtml: a video face is a canvas painted from the video\'s first frame, never a <video> (Dexter F8)', () => {
  const { stillFaceHtml } = require('../app/portrait-media-display');
  const v = stillFaceHtml({ kind: 'file', path: 'C:/p/a.webm', media: 'video', tier: 'uploaded' }, { imagesEnabled: true });
  assert.match(v, /^<canvas /);
  assert.match(v, /data-still-kind="video"/);
  assert.doesNotMatch(v, /<video/);
});

test('stillFaceHtml: images off or unknown is the placeholder, as for the roster', () => {
  const { stillFaceHtml } = require('../app/portrait-media-display');
  assert.match(stillFaceHtml({ kind: 'file', path: 'C:/p/a.gif', media: 'image' }, { imagesEnabled: false }), /face-placeholder/);
  assert.match(stillFaceHtml(null, { imagesEnabled: null }), /face-placeholder/);
});
