'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, SNIFF_BYTES,
  kindOfExt, maxBytesFor, signatureMatches,
} = require('../host/background-media');

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)]);

test('the extension lists and the caps are pinned', () => {
  assert.deepStrictEqual([...IMAGE_EXTENSIONS], ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
  assert.deepStrictEqual([...VIDEO_EXTENSIONS], ['webm', 'mp4']);
  assert.strictEqual(MAX_IMAGE_BYTES, 25 * 1024 * 1024);
  assert.strictEqual(MAX_VIDEO_BYTES, 100 * 1024 * 1024);
});

test('kindOfExt names image, video, or nothing -- case-insensitively', () => {
  for (const e of IMAGE_EXTENSIONS) assert.strictEqual(kindOfExt(e), 'image');
  for (const e of VIDEO_EXTENSIONS) assert.strictEqual(kindOfExt(e), 'video');
  assert.strictEqual(kindOfExt('MP4'), 'video');
  assert.strictEqual(kindOfExt('exe'), null);
  assert.strictEqual(kindOfExt(''), null);
  assert.strictEqual(kindOfExt(undefined), null);
});

test('maxBytesFor is per kind', () => {
  assert.strictEqual(maxBytesFor('png'), MAX_IMAGE_BYTES);
  assert.strictEqual(maxBytesFor('webm'), MAX_VIDEO_BYTES);
  assert.strictEqual(maxBytesFor('mp4'), MAX_VIDEO_BYTES);
  assert.strictEqual(maxBytesFor('exe'), null);
});

test('signatureMatches: a webm needs the EBML header, an mp4 the ftyp box at offset 4', () => {
  assert.strictEqual(signatureMatches('webm', WEBM), true);
  assert.strictEqual(signatureMatches('mp4', MP4), true);
  assert.strictEqual(signatureMatches('WEBM', WEBM), true);
});

test('signatureMatches refuses a renamed executable, text, an empty or a short head', () => {
  const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff', 'latin1');
  for (const ext of VIDEO_EXTENSIONS) {
    assert.strictEqual(signatureMatches(ext, exe), false, ext);
    assert.strictEqual(signatureMatches(ext, Buffer.alloc(0)), false, ext);
    assert.strictEqual(signatureMatches(ext, Buffer.from('hello world, not a video')), false, ext);
    assert.strictEqual(signatureMatches(ext, null), false, ext);
    assert.strictEqual(signatureMatches(ext, 'ftypftypftyp'), false, 'a string is not a buffer');
  }
});

test('signatureMatches does not accept one container under the other extension', () => {
  assert.strictEqual(signatureMatches('mp4', WEBM), false);
  assert.strictEqual(signatureMatches('webm', MP4), false);
});

test('signatureMatches pins the boundaries: ftyp must sit at exactly offset 4, and 8 bytes are needed', () => {
  assert.strictEqual(signatureMatches('mp4', Buffer.concat([Buffer.alloc(3), Buffer.from('ftyp')])), false);
  assert.strictEqual(signatureMatches('mp4', Buffer.concat([Buffer.alloc(5), Buffer.from('ftyp')])), false);
  assert.strictEqual(signatureMatches('mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp')])), true);
  assert.strictEqual(signatureMatches('webm', WEBM.subarray(0, 3)), false);
  assert.strictEqual(signatureMatches('webm', WEBM.subarray(0, 4)), true);
  assert.ok(SNIFF_BYTES >= 8);
});

test('images are not sniffed: any head is accepted for an image extension', () => {
  assert.strictEqual(signatureMatches('png', Buffer.from('x')), true);
  assert.strictEqual(signatureMatches('svg', null), true);
});

test('an unknown extension never matches', () => {
  assert.strictEqual(signatureMatches('exe', WEBM), false);
});

test('PROPERTY: a head that matches an extension is never accepted for the other video extension', () => {
  fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
    const head = Buffer.from(bytes);
    assert.ok(!(signatureMatches('webm', head) && signatureMatches('mp4', head)));
  }));
});
