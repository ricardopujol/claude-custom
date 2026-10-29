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

/**
 * The same, with the mute read from the store NOW. Every tab is its own page and a hidden one is what knocks, so a switch flipped in
 * another tab has to apply here without a reload: never a value cached at load (PR #224, Miguel B1).
 */
function shouldKnockFrom(storage, looking) {
  return shouldKnock({ looking, muted: readMuted(storage) });
}

// A held dialog can be notified again while it is still open: the page counts MESSAGES, so it names a dialog by its sender and first
// line and counts each once until a look. A dialog it cannot read has no identity and every arrival counts.
const HELD_MAX = 100;
const identityOf = (found) => (found && (found.from || found.first) ? `${found.from || ''}|${found.first || ''}` : null);
function createHeldSet() {
  const seen = new Set();
  return {
    admit(found) {
      const id = identityOf(found);
      if (id === null) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > HELD_MAX) seen.delete(seen.values().next().value);
      return true;
    },
    clear() { seen.clear(); },
    size: () => seen.size,
  };
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

const IDLE_SUSPEND_MS = 700;      // after the last note (it ends ~0.23 s in), a context that sits running keeps an audio thread up
let shared = null;
let idleTimer = null;
const swallow = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
/** The knock on the page's own audio context. Made on first use, rebuilt if it was closed, resumed if it was suspended, suspended again
 *  when idle. 0 when it can't play. Never throws and never leaves a rejected promise behind. */
function knock(win) {
  try {
    const Ctor = win && (win.AudioContext || win.webkitAudioContext);
    if (!Ctor) return 0;
    if (shared && shared.state === 'closed') shared = null;
    if (!shared) shared = new Ctor();
    if (shared.state === 'suspended' && typeof shared.resume === 'function') swallow(shared.resume());
    const played = playKnock(shared);
    const timers = { set: win.setTimeout ? win.setTimeout.bind(win) : setTimeout, clear: win.clearTimeout ? win.clearTimeout.bind(win) : clearTimeout };
    if (idleTimer !== null) timers.clear(idleTimer);
    idleTimer = timers.set(() => {
      idleTimer = null;
      try { if (shared && shared.state === 'running' && typeof shared.suspend === 'function') swallow(shared.suspend()); } catch { /* gone */ }
    }, IDLE_SUSPEND_MS);
    return played;
  } catch {
    return 0;
  }
}
function _resetKnock() { shared = null; idleTimer = null; }

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

const peerCue = { scanHeldMessage, toastFor, shouldKnock, shouldKnockFrom, playKnock, knock, readMuted, writeMuted, bumpCount,
  identityOf, createHeldSet, _resetKnock, KNOCK, MUTE_KEY, FROM_MAX, FIRST_MAX, COUNT_MAX, HELD_MAX };

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module system.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { peerCue };
} else {
  root.peerCue = peerCue;
}

})(typeof window !== 'undefined' ? window : globalThis);
