'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  styleDisplay, describeSource, reduceStyle, emptyStyleState, reduceVideoError,
} = require('../app/style-display');

const bg = (background) => styleDisplay({ background }).find((s) => s.id === 'background').view;
const NOTE = "This video can't be played: it's damaged or can't be decoded";
const ISO = new Date('2026-10-02T10:00:00.000Z').toISOString();

test('describeSource says "your video" for a video override, "your image" otherwise', () => {
  assert.ok(describeSource({ source: 'override', kind: 'video', setAt: ISO }).startsWith('your video, set '));
  assert.strictEqual(describeSource({ source: 'override', kind: 'video' }), 'your video');
  assert.strictEqual(describeSource({ source: 'override', kind: 'image' }), 'your image');
  assert.strictEqual(describeSource({ source: 'override' }), 'your image', 'an older host names no kind');
  assert.strictEqual(describeSource({ source: 'generated', kind: 'image' }), 'generated for this project');
});

test('the background view says whether it is a video, carries the unplayable note, and gates Match colours', () => {
  const ok = bg({ source: 'override', kind: 'video' });
  assert.strictEqual(ok.isVideo, true);
  assert.strictEqual(ok.note, null);
  assert.strictEqual(ok.canMatch, true);

  const broken = bg({ source: 'override', kind: 'video', videoError: NOTE });
  assert.strictEqual(broken.note, NOTE);
  assert.strictEqual(broken.canMatch, false, 'there is no frame to take colours from');

  const image = bg({ source: 'override', kind: 'image' });
  assert.strictEqual(image.isVideo, false);
  assert.strictEqual(image.canMatch, true);

  const generated = bg({ source: 'generated', kind: 'image' });
  assert.strictEqual(generated.canMatch, false, 'only the person\'s own background is matched');
  assert.strictEqual(bg({}).canMatch, false);
  assert.strictEqual(bg({ source: 'override', videoError: '' }).note, null, 'an empty note is no note');
});

test('reduceStyle carries the kind through', () => {
  const next = reduceStyle(emptyStyleState(), { type: 'style', style: { source: 'override', kind: 'video', setAt: ISO, look: {} } });
  assert.strictEqual(next.background.kind, 'video');
  const hello = reduceStyle(emptyStyleState(), { source: 'generated', look: {} });
  assert.strictEqual(hello.background.kind, 'image', 'no kind named is an image');
});

test('reduceVideoError records the note, and null clears it', () => {
  const s = reduceVideoError(emptyStyleState(), NOTE);
  assert.strictEqual(s.background.videoError, NOTE);
  assert.strictEqual(reduceVideoError(s, null).background.videoError, null);
  assert.strictEqual(reduceVideoError(s, '').background.videoError, null);
  assert.strictEqual(reduceVideoError(s, 42).background.videoError, s.background.videoError, 'only a string lands');
});

test('the note belongs to the file: a new file clears it, a re-announce of the same one keeps it', () => {
  const msg = (setAt, kind = 'video') => ({ type: 'style', style: { source: 'override', kind, setAt, look: { darkness: 0.5 } } });
  let s = reduceStyle(emptyStyleState(), msg(ISO));
  s = reduceVideoError(s, NOTE);
  // a darkness change re-announces the same background: it is not reloaded, so the note stands
  assert.strictEqual(reduceStyle(s, msg(ISO)).background.videoError, NOTE);
  // a different file (new version) is tried afresh
  assert.strictEqual(reduceStyle(s, msg('2026-10-02T11:00:00.000Z')).background.videoError, null);
  // so is the same time with another kind, and a reset to generated
  assert.strictEqual(reduceStyle(s, msg(ISO, 'image')).background.videoError, null);
  assert.strictEqual(reduceStyle(s, { type: 'style', style: { source: 'generated', kind: 'image', look: {} } }).background.videoError, null);
});

test('a refusal leaves the note alone', () => {
  const s = reduceVideoError(emptyStyleState(), NOTE);
  assert.strictEqual(reduceStyle(s, { type: 'style', error: 'nope', ask: 'background' }).background.videoError, NOTE);
});
