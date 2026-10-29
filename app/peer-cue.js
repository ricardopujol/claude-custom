'use strict';
/**
 * The cue for a cross-session message held for approval (BACKLOG #156, Ricardo 2026-10-29): an envelope badge with a count on the
 * tab, the taskbar flash, a toast naming the sender and the first line, and the wooden knock, once.
 *
 * host/attention.js decides THAT a message is held, from the CLI's own Notification hook. This file is the page's half and is
 * pure but for `knock`: what the toast says, when the knock sounds, the knock, the mute switch and the count. Nothing here accepts,
 * refuses or answers a message: the CLI's own prompt is the only way to let one in.
 *
 * THE ONLY SOUND IN THE APP (until the sound pack, #152): synthesized with Web Audio, no file. Two short low square-wave knocks,
 * 220 Hz then 196 Hz, 90 ms each, 120 ms apart.
 *
 * WRAPPED IN AN IIFE (see app/career-display.js's header): the renderer loads every script into ONE global scope. One name
 * leaves this file: `peerCue`.
 */
(function (root) {

const KNOCK = [{ freq: 220, at: 0, dur: 0.09 }, { freq: 196, at: 0.12, dur: 0.09 }];
const PEAK_GAIN = 0.12;
const MUTE_KEY = 'cueSoundMuted';
const FROM_MAX = 60;
const FIRST_MAX = 160;
const COUNT_MAX = 99;
const GENERIC_BODY = 'A message from another session needs your approval';

// The CLI draws a held message in a bordered dialog; these are its own words (2.1.312 bundle), and the box characters around them go.
const TITLE_RE = /Held message from another session/;
const FROM_RE = /Another Claude session sent a message: from (.*?)\.?\s*$/;
const BODY_RE = /Message body \(this is what will be delivered\):/;
const BORDER_RE = /^[\s│|┃║]+|[\s│|┃║]+$/g;
const CONTROL_RE = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u001f\u007f]/g;

const clean = (s, max) => {
  const t = String(s).replace(CONTROL_RE, '').replace(BORDER_RE, '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/**
 * The newest held-message dialog among `lines` (the visible terminal text, top to bottom) -> { from, first }, each null when
 * the dialog doesn't show it; null when there is no dialog at all. Only names a message: never read as a decision.
 */
function scanHeldMessage(lines) {
  if (!Array.isArray(lines)) return null;
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (typeof lines[i] === 'string' && TITLE_RE.test(lines[i])) { at = i; break; }
  }
  if (at === -1) return null;
  let from = null;
  let first = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = typeof lines[i] === 'string' ? lines[i] : '';
    if (from === null) {
      const m = FROM_RE.exec(line.replace(BORDER_RE, ''));
      if (m) { from = clean(m[1], FROM_MAX); continue; }
    }
    if (BODY_RE.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const text = typeof lines[j] === 'string' ? clean(lines[j], FIRST_MAX) : null;
        if (text !== null) { first = text; break; }
      }
      break;
    }
  }
  return { from, first };
}

/** What the OS toast says, given what the scan found (or null). */
function toastFor(project, found) {
  const name = typeof project === 'string' && project !== '' ? project : '';
  const from = found && typeof found.from === 'string' && found.from !== '' ? found.from : null;
  const first = found && typeof found.first === 'string' && found.first !== '' ? found.first : null;
  const title = from ? (name ? `${name}: message from ${from}` : `Message from ${from}`)
    : (name ? `${name} has a message for you` : 'A message for you');
  return { title, body: first || GENERIC_BODY };
}

/** The knock sounds unless you are looking at that tab (selected, window focused) or it is muted. Only a real `true` counts. */
function shouldKnock({ looking, muted } = {}) {
  return looking !== true && muted !== true;
}

/** Schedules the two notes on `ctx` (a Web Audio context); returns how many it scheduled. Never throws. */
function playKnock(ctx) {
  if (!ctx || typeof ctx.createOscillator !== 'function') return 0;
  try {
    const t0 = ctx.currentTime;
    for (const n of KNOCK) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = n.freq;
      const start = t0 + n.at;
      const end = start + n.dur;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
    return KNOCK.length;
  } catch {
    return 0;
  }
}

let shared = null;
/** The knock on the page's own audio context, made on first use (Electron's autoplay policy is set in main). 0 when it can't play. */
function knock(win) {
  try {
    const Ctor = win && (win.AudioContext || win.webkitAudioContext);
    if (!Ctor) return 0;
    if (!shared) shared = new Ctor();
    if (shared.state === 'suspended' && typeof shared.resume === 'function') shared.resume();
    return playKnock(shared);
  } catch {
    return 0;
  }
}

function readMuted(storage) {
  try { return !!storage && storage.getItem(MUTE_KEY) === 'true'; } catch { return false; }
}
function writeMuted(storage, muted) {
  try { if (storage) storage.setItem(MUTE_KEY, muted === true ? 'true' : 'false'); } catch { /* a full or blocked store: the switch lasts until the page closes */ }
}

/** The tab's held-message count after one more: 1..99. Anything that isn't a count starts again at 1. */
function bumpCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? Math.min(COUNT_MAX, n + 1) : 1;
}

const peerCue = { scanHeldMessage, toastFor, shouldKnock, playKnock, knock, readMuted, writeMuted, bumpCount,
  KNOCK, MUTE_KEY, FROM_MAX, FIRST_MAX, COUNT_MAX };

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module system.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { peerCue };
} else {
  root.peerCue = peerCue;
}

})(typeof window !== 'undefined' ? window : globalThis);
