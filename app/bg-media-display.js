'use strict';
/**
 * What the project's background IS and when it may move (BACKLOG #34).
 *
 * PURE decisions, like app/portrait-media-display.js: the renderer only turns
 * what this returns into DOM.
 *
 *   - `mediaFor({ kind, url })`: the descriptor for the background layer, a
 *     muted looping `<video>` or a CSS background image. A host that names no
 *     kind is an older one, and every background it ever had was an image.
 *   - `shouldPlay({ visible, minimised, onBattery, reducedMotion })`: a video
 *     plays while the window is VISIBLE -- an unfocused window that is still on
 *     screen keeps playing, because that is the point of a background -- and
 *     stops when it is minimised or hidden, on battery, or when the person asked
 *     the OS for reduced motion (which gets a still frame, never playback).
 *   - `applyPlayback(video, state)`: carries the decision out on a real element.
 *   - `unplayableNote(error)`: the Style tab's words for a video the engine
 *     refused (codec, corruption). The file stays; there is just no background.
 *
 * "Not yet known" is asymmetric on purpose. `visible` must be exactly `true`:
 * a window that has not said it is on screen is not decoding video. The three
 * stoppers only stop on exactly `true`: a desktop with no battery reports
 * nothing, and an unknown must not silently disable the feature forever.
 *
 * WRAPPED IN AN IIFE, and publishes ONE global (`bgMedia`) -- see
 * app/career-display.js's header: the renderer loads every script as a plain
 * <script> sharing one global scope, and no unit test can see a collision.
 * Enforced by test/renderer-scope.test.js.
 */

(function (root) {

function shouldPlay(state) {
  const s = state && typeof state === 'object' ? state : {};
  return s.visible === true && s.minimised !== true && s.onBattery !== true && s.reducedMotion !== true;
}

/** 'play', 'pause', or 'still' (reduced motion: the first frame, held). */
function playbackAction(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (s.reducedMotion === true) return 'still';
  return shouldPlay(s) ? 'play' : 'pause';
}

/**
 * Do what `playbackAction` says to a video element. Tolerant of a missing or
 * half-made element and of play() being refused (an autoplay policy answers
 * with a rejected promise, which must not surface as an unhandled rejection).
 */
function applyPlayback(video, state) {
  const action = playbackAction(state);
  if (!video || typeof video !== 'object') return action;
  if (action === 'play') {
    if (typeof video.play === 'function') {
      try {
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => { /* refused: it stays paused */ });
      } catch { /* detached */ }
    }
    return action;
  }
  try { if (typeof video.pause === 'function') video.pause(); } catch { /* detached */ }
  if (action === 'still') {
    // Frame zero, not wherever it happened to stop: a still background should
    // not depend on when the person asked for less motion.
    try { if (video.currentTime !== 0) video.currentTime = 0; } catch { /* not seekable yet */ }
  }
  return action;
}

function mediaFor(bg) {
  const b = bg && typeof bg === 'object' ? bg : null;
  if (!b || typeof b.url !== 'string' || !b.url) return null;
  if (b.kind === 'video') {
    return { tag: 'video', attrs: { src: b.url, muted: true, loop: true, playsinline: true } };
  }
  return { tag: 'image', url: b.url };
}

/**
 * A file:// URL for the background's path. `encodeURI`, then the two characters
 * it leaves alone that a path can hold and a URL cannot: a project under
 * "C:\a#b" must not lose half its path. `version` busts the cache -- a replaced
 * background.webm keeps its name.
 */
function fileUrl(filePath, version) {
  const encoded = encodeURI(String(filePath).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return 'file:///' + encoded + (version ? '?v=' + encodeURIComponent(version) : '');
}

// HTMLMediaElement's MediaError codes, in words a person can act on.
const REASONS = {
  1: 'loading was stopped',
  2: 'the file could not be read',
  3: "it's damaged or can't be decoded",
  4: "this format or codec isn't supported here",
};

function unplayableNote(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  const reason = Object.prototype.hasOwnProperty.call(REASONS, code) ? REASONS[code] : 'the player gave no reason';
  return `This video can't be played: ${reason}`;
}

const API = { shouldPlay, playbackAction, applyPlayback, mediaFor, fileUrl, unplayableNote };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.bgMedia = API;

})(typeof window !== 'undefined' ? window : globalThis);
