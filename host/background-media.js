'use strict';
/**
 * What a background file may be (backlog #34): an image or a short video loop,
 * the size cap for each, and whether a video's first bytes really are one.
 *
 * PURE. No fs: host/style.js reads the head of the file and hands it in, so every
 * rule here is testable with a Buffer.
 *
 * The signature check is a fence against the wrong file wearing the right name
 * (a renamed .exe), not a codec validator -- a file that passes and then cannot
 * be decoded is the renderer's unplayable-video note, and the file stays.
 * Images are NOT sniffed: the cap and the extension were always their whole
 * check, and an image the engine cannot draw simply draws nothing.
 */

const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const VIDEO_EXTENSIONS = Object.freeze(['webm', 'mp4']);

// Short loops, copied into the project like images; nothing streams.
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// How much of the file's head the signature needs: the EBML magic is 4 bytes,
// an MP4's `ftyp` box tag ends at offset 8.
const SNIFF_BYTES = 12;

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const FTYP = Buffer.from('ftyp', 'latin1');
const FTYP_OFFSET = 4;

function normal(ext) {
  return typeof ext === 'string' ? ext.toLowerCase() : '';
}

/** 'image' | 'video' | null for an extension without its dot. */
function kindOfExt(ext) {
  const e = normal(ext);
  if (IMAGE_EXTENSIONS.includes(e)) return 'image';
  if (VIDEO_EXTENSIONS.includes(e)) return 'video';
  return null;
}

/** The size cap for this extension's kind, or null for an extension nobody accepts. */
function maxBytesFor(ext) {
  const kind = kindOfExt(ext);
  if (kind === 'image') return MAX_IMAGE_BYTES;
  if (kind === 'video') return MAX_VIDEO_BYTES;
  return null;
}

/**
 * Do the file's first bytes fit its extension? A webm opens with the EBML
 * header; an mp4 has an `ftyp` box starting at byte 4. Anything that is not a
 * Buffer -- an unread head included -- is a refusal, never a pass.
 */
function signatureMatches(ext, head) {
  const e = normal(ext);
  const kind = kindOfExt(e);
  if (kind === null) return false;
  if (kind === 'image') return true;
  if (!Buffer.isBuffer(head)) return false;
  if (e === 'webm') return head.length >= EBML.length && head.subarray(0, EBML.length).equals(EBML);
  return head.length >= FTYP_OFFSET + FTYP.length &&
    head.subarray(FTYP_OFFSET, FTYP_OFFSET + FTYP.length).equals(FTYP);
}

module.exports = {
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, SNIFF_BYTES,
  kindOfExt, maxBytesFor, signatureMatches,
};
