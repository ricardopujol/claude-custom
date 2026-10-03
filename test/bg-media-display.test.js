'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  shouldPlay, playbackAction, applyPlayback, mediaFor, fileUrl, unplayableNote,
} = require('../app/bg-media-display');

const BASE = { visible: true, minimised: false, onBattery: false, reducedMotion: false };

// --- shouldPlay: the whole truth table ----------------------------------------

test('shouldPlay: plays while the window is visible, on mains, with motion allowed', () => {
  assert.strictEqual(shouldPlay(BASE), true);
});

test('shouldPlay: an unfocused but visible window keeps playing (focus is not an input)', () => {
  assert.strictEqual(shouldPlay({ ...BASE, focused: false }), true);
});

test('shouldPlay: each stopping input stops it on its own', () => {
  assert.strictEqual(shouldPlay({ ...BASE, visible: false }), false, 'hidden');
  assert.strictEqual(shouldPlay({ ...BASE, minimised: true }), false, 'minimised');
  assert.strictEqual(shouldPlay({ ...BASE, onBattery: true }), false, 'on battery');
  assert.strictEqual(shouldPlay({ ...BASE, reducedMotion: true }), false, 'reduced motion');
});

test('shouldPlay: not knowing the window is visible is not playing; not knowing the rest does not stop it', () => {
  assert.strictEqual(shouldPlay({ minimised: false, onBattery: false, reducedMotion: false }), false);
  assert.strictEqual(shouldPlay({ ...BASE, visible: 'true' }), false, 'only a real true counts');
  assert.strictEqual(shouldPlay({ visible: true }), true, 'a desktop with no battery reports nothing');
  assert.strictEqual(shouldPlay({ ...BASE, onBattery: null, minimised: null }), true);
});

test('shouldPlay: nothing at all is a no', () => {
  assert.strictEqual(shouldPlay(), false);
  assert.strictEqual(shouldPlay(null), false);
});

test('PROPERTY: shouldPlay is true exactly when visible and none of the three stoppers is set', () => {
  const tri = fc.constantFrom(true, false, null, undefined);
  fc.assert(fc.property(tri, tri, tri, tri, (visible, minimised, onBattery, reducedMotion) => {
    const expected = visible === true && minimised !== true && onBattery !== true && reducedMotion !== true;
    assert.strictEqual(shouldPlay({ visible, minimised, onBattery, reducedMotion }), expected);
  }));
});

test('PROPERTY: reduced motion never plays, whatever else is true', () => {
  const tri = fc.constantFrom(true, false, null, undefined);
  fc.assert(fc.property(tri, tri, tri, (visible, minimised, onBattery) => {
    assert.notStrictEqual(playbackAction({ visible, minimised, onBattery, reducedMotion: true }), 'play');
  }));
});

// --- playbackAction / applyPlayback --------------------------------------------

test('playbackAction: play, pause, or a still frame for reduced motion', () => {
  assert.strictEqual(playbackAction(BASE), 'play');
  assert.strictEqual(playbackAction({ ...BASE, minimised: true }), 'pause');
  assert.strictEqual(playbackAction({ ...BASE, onBattery: true }), 'pause');
  assert.strictEqual(playbackAction({ ...BASE, visible: false }), 'pause');
  assert.strictEqual(playbackAction({ ...BASE, reducedMotion: true }), 'still');
  assert.strictEqual(playbackAction({ ...BASE, reducedMotion: true, minimised: true }), 'still');
});

function fakeVideo({ rejectPlay = false, currentTime = 5 } = {}) {
  const v = { calls: [], currentTime };
  v.play = () => { v.calls.push('play'); return rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(); };
  v.pause = () => v.calls.push('pause');
  return v;
}

test('applyPlayback plays, pauses, or rewinds to the first frame and holds', () => {
  const v = fakeVideo();
  assert.strictEqual(applyPlayback(v, BASE), 'play');
  assert.deepStrictEqual(v.calls, ['play']);
  assert.strictEqual(applyPlayback(v, { ...BASE, minimised: true }), 'pause');
  assert.deepStrictEqual(v.calls, ['play', 'pause']);
  assert.strictEqual(v.currentTime, 5, 'a pause keeps its place');
  assert.strictEqual(applyPlayback(v, { ...BASE, reducedMotion: true }), 'still');
  assert.deepStrictEqual(v.calls, ['play', 'pause', 'pause']);
  assert.strictEqual(v.currentTime, 0, 'a still frame is frame zero, not wherever it stopped');
});

test('applyPlayback survives a refused play() and a missing video', async () => {
  const v = fakeVideo({ rejectPlay: true });
  assert.strictEqual(applyPlayback(v, BASE), 'play');
  await new Promise((r) => setImmediate(r));   // an unhandled rejection would fail the run
  assert.strictEqual(applyPlayback(null, BASE), 'play');
  assert.strictEqual(applyPlayback({}, BASE), 'play');
  assert.strictEqual(applyPlayback({}, { ...BASE, reducedMotion: true }), 'still');
});

test('applyPlayback does not rewind a video that is already at the first frame', () => {
  let sets = 0;
  const v = { currentTime: 0, pause() {}, play() {} };
  Object.defineProperty(v, 'currentTime', { get: () => 0, set: () => { sets++; } });
  applyPlayback(v, { ...BASE, reducedMotion: true });
  assert.strictEqual(sets, 0);
});

// --- mediaFor ------------------------------------------------------------------

test('mediaFor: a video is a muted looping <video> with no audio and no controls', () => {
  const d = mediaFor({ kind: 'video', url: 'file:///C:/p/background.webm?v=1' });
  assert.strictEqual(d.tag, 'video');
  assert.strictEqual(d.attrs.src, 'file:///C:/p/background.webm?v=1');
  assert.strictEqual(d.attrs.muted, true);
  assert.strictEqual(d.attrs.loop, true);
  assert.strictEqual(d.attrs.playsinline, true);
  assert.strictEqual(d.attrs.controls, undefined);
});

test('mediaFor: an image, and any kind a host does not name, is a CSS background image', () => {
  assert.deepStrictEqual(mediaFor({ kind: 'image', url: 'file:///a.png' }), { tag: 'image', url: 'file:///a.png' });
  assert.strictEqual(mediaFor({ url: 'file:///a.png' }).tag, 'image', 'an older host sends no kind');
  assert.strictEqual(mediaFor({ kind: 'hologram', url: 'file:///a.png' }).tag, 'image');
});

test('mediaFor: nothing to show is null', () => {
  assert.strictEqual(mediaFor(null), null);
  assert.strictEqual(mediaFor({ kind: 'video' }), null);
  assert.strictEqual(mediaFor({ kind: 'video', url: '' }), null);
});

// --- fileUrl -------------------------------------------------------------------

test('fileUrl: forward slashes, percent-encoded spaces and the two characters a URL cannot hold', () => {
  assert.strictEqual(fileUrl('C:\\my proj\\a#b\\c?d\\background.webm', ''), 'file:///C:/my%20proj/a%23b/c%3Fd/background.webm');
});

test('fileUrl: the version rides along so a replaced file of the same name is reloaded', () => {
  assert.strictEqual(fileUrl('C:/p/background.webm', '2026-10-02T10:00:00.000Z'),
    'file:///C:/p/background.webm?v=2026-10-02T10%3A00%3A00.000Z');
  assert.ok(!fileUrl('C:/p/background.webm', null).includes('?'));
  assert.ok(!fileUrl('C:/p/background.webm').includes('?'));
});

// --- unplayableNote --------------------------------------------------------------

test('unplayableNote names the reason from the media error code', () => {
  const note = (code) => unplayableNote({ code });
  assert.match(note(1), /^This video can't be played: /);
  assert.match(note(2), /read/);
  assert.match(note(3), /damaged|decoded/);
  assert.match(note(4), /format|codec/);
  const all = [1, 2, 3, 4].map(note);
  assert.strictEqual(new Set(all).size, 4, 'one distinct sentence per code');
});

test('unplayableNote: no code is said honestly, never a blank reason', () => {
  for (const e of [null, undefined, {}, { code: 99 }, { code: null }]) {
    assert.match(unplayableNote(e), /^This video can't be played: .{5,}/);
    assert.doesNotMatch(unplayableNote(e), /undefined|null/);
  }
});
