'use strict';
/**
 * The Games dock panel (BACKLOG #41): Stack the PRs, Merge 2048 and Pipeline, drawn on one canvas, one at a time.
 *
 * This file is the wiring and the drawing. Every rule is in app/games-rules.js, every question about the round (the clock, the
 * hand-back, who gets keys, when to draw) is in app/games-round.js, and the best scores are kept by host/game-scores.js through
 * `bridge`. What is left here is turning DOM events into those calls and the result into pixels, with every outside thing
 * injected (`raf`, `now`, `rng`, `css`, `focusTerminal`, `terminalHasFocus`), so a test drives it with a fake document.
 *
 * THE HAND-BACK. renderer.js calls `handBack()` on every attention message (Claude needs Ricardo, or its turn finished). A
 * running round pauses, the cover says "Claude needs you", and keyboard focus goes to the terminal. The round resumes when
 * Ricardo clicks or focuses the panel again, never by itself. Keys are taken from the panel's own keydown and only while the
 * terminal does not have focus, so a keystroke meant for Claude can't land in a game.
 *
 * No sounds. The panel stops drawing, and the round stops its clock, whenever it is not on screen (hidden tab, minimised
 * window, lean mode): `setView` is told by the renderer.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one global scope (test/renderer-scope.test.js).
 * The page sees one name, `gamesDisplay`.
 */
(function (root) {

const rules = typeof module !== 'undefined' && module.exports ? require('./games-rules') : root.gamesRules;
const round = typeof module !== 'undefined' && module.exports ? require('./games-round') : root.gamesRound;

const { FIELD } = rules;
const ORDER = ['stack', 'merge', 'pipeline'];
const LABEL = { stack: 'Stack the PRs', merge: 'Merge 2048', pipeline: 'Pipeline' };
const SHORT = { stack: 'Stack', merge: 'Merge', pipeline: 'Pipeline' };
const HINT = {
  stack: 'Space or click to drop the block. A perfect drop grows it back.',
  merge: 'Arrow keys (click the board first) or swipe. Equal tiles merge.',
  pipeline: 'Click tiles to turn them. Connect src to tests.',
};
const PHYSICS_STEP = 0.05;     // the longest step a game's own motion takes in one frame (the round clock counts real time, see games-round)
const FLASH = 0.35;           // seconds "perfect!" stays up
const KEY_DIR = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D' };
const SWIPE_MOVE = { L: 'L', R: 'R', U: 'U', D: 'D' };

/** The title line: every game's best, in the panel's header. */
function bestLine(bests) {
  return ORDER.map(g => `${SHORT[g]} ${bests && Number.isInteger(bests[g]) ? bests[g] : 0}`).join(' · ');
}

// --- the three games: state, input, stepping and drawing -------------------------------------------------------------------

function makeGames(rng, theme) {
  const c = theme;     // theme(name) -> a CSS colour from the project's tokens
  const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

  const stack = {
    s: null,
    reset() { this.s = { stack: rules.stackStart(), cur: null, flash: 0 }; this.s.cur = rules.stackBlock(this.s.stack); },
    step(dt) {
      const s = this.s;
      s.cur = rules.stackStep(s.cur, rules.stackSpeed(s.stack), dt);
      s.flash = Math.max(0, s.flash - dt);
    },
    // -> 'missed' when the drop ended the round
    drop() {
      const r = rules.stackDrop(this.s.stack, this.s.cur);
      if (r.over) return 'missed';
      this.s.stack = r.stack;
      if (r.perfect) this.s.flash = FLASH;
      this.s.cur = rules.stackBlock(r.stack);
      return null;
    },
    key(e) { if (e.key === ' ' || e.code === 'Space') return this.drop(); return undefined; },
    point() { return this.drop(); },
    score() { return rules.stackScore(this.s.stack); },
    draw(x) {
      const { stack: st, cur, flash } = this.s;
      const acc = c('--accent');
      x.fillStyle = c('--chrome'); x.fillRect(0, 0, FIELD.width, FIELD.height);
      const h = 18; const base = 292; const off = Math.max(0, st.length - 13) * h;
      st.forEach((b, k) => {
        x.fillStyle = k === 0 ? c('--dim') : mix(acc, 55 + (k % 3) * 15, c('--panel'));
        x.fillRect(b.x, base - (k + 1) * h + off, b.w, h - 2);
        if (k) { x.fillStyle = c('--bg'); x.font = '10px monospace'; x.fillText(`#${146 + k}`, b.x + 4, base - k * h - 6 + off); }
      });
      x.fillStyle = acc; x.fillRect(cur.x, base - (st.length + 1) * h + off, cur.w, h - 2);
      if (flash) {
        x.fillStyle = c('--ok'); x.font = '600 14px sans-serif'; x.globalAlpha = flash / FLASH;
        x.fillText('perfect!', 170, 30); x.globalAlpha = 1;
      }
    },
  };

  const merge = {
    s: null,
    reset() { this.s = { board: rules.mergeStart(rng), points: 0, swipe: null }; },
    step() {},
    move(dir) {
      const r = rules.mergeStep(this.s.board, dir, rng);
      this.s.board = r.board; this.s.points += r.gained;
      return r.over ? 'full' : null;
    },
    key(e) { const d = KEY_DIR[e.key]; return d ? this.move(d) : undefined; },
    down(x, y) { this.s.swipe = [x, y]; },
    cancel() { this.s.swipe = null; },
    up(x, y) {
      const from = this.s.swipe; this.s.swipe = null;
      if (!from) return undefined;
      const d = rules.swipeDir(x - from[0], y - from[1]);
      return d ? this.move(SWIPE_MOVE[d]) : undefined;
    },
    score() { return this.s.points; },
    draw(x) {
      const acc = c('--accent');
      x.fillStyle = c('--chrome'); x.fillRect(0, 0, FIELD.width, FIELD.height);
      const size = 66; const ox = 66; const oy = 14;
      this.s.board.forEach((v, k) => {
        const px = ox + (k % 4) * (size + 2); const py = oy + Math.floor(k / 4) * (size + 2);
        x.fillStyle = v ? mix(acc, Math.min(95, 20 + Math.log2(v) * 9), c('--panel')) : c('--panel');
        x.fillRect(px, py, size, size);
        if (v) {
          x.fillStyle = Math.log2(v) > 5 ? c('--bg') : c('--text');
          x.font = `600 ${v > 512 ? 16 : 20}px monospace`; x.textAlign = 'center';
          x.fillText(String(v), px + size / 2, py + size / 2 + 7); x.textAlign = 'start';
        }
      });
    },
  };

  const pipeline = {
    s: null,
    reset() { this.s = { solved: 0, board: rules.pipeBoard(rules.pipeSize(0), rng) }; },
    step() {},
    // field-pixel point
    point(px, py) {
      const i = rules.pipeCellAt(this.s.board.n, px, py);
      if (i < 0) return undefined;
      this.s.board = rules.pipeTurn(this.s.board, i);
      if (rules.pipeSolved(this.s.board)) {
        this.s.solved += 1;
        this.s.board = rules.pipeBoard(rules.pipeSize(this.s.solved), rng);
      }
      return null;
    },
    score() { return this.s.solved; },
    draw(x) {
      const { board } = this.s; const n = board.n; const g = rules.pipeGeometry(n);
      x.fillStyle = c('--chrome'); x.fillRect(0, 0, FIELD.width, FIELD.height);
      x.fillStyle = c('--dim'); x.font = '10px monospace';
      x.fillText('src →', g.x - 34, g.y + g.size / 2 + 3);
      x.fillText('→ tests', g.x + g.size * n + 4, g.y + g.size * n - g.size / 2 + 3);
      board.cells.forEach((cell, k) => {
        const px = g.x + (k % n) * g.size; const py = g.y + Math.floor(k / n) * g.size;
        x.fillStyle = c('--panel'); x.fillRect(px + 1, py + 1, g.size - 2, g.size - 2);
        x.strokeStyle = c('--accent'); x.lineWidth = Math.max(4, g.size / 7); x.lineCap = 'round';
        const cx = px + g.size / 2; const cy = py + g.size / 2;
        rules.pipeEnds(cell).forEach((d) => {
          const dx = [0, 1, 0, -1][d]; const dy = [-1, 0, 1, 0][d];
          x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + dx * g.size / 2, cy + dy * g.size / 2); x.stroke();
        });
      });
    },
  };

  return { stack, merge, pipeline };
}

// --- the panel -----------------------------------------------------------------------------------------------------------

/**
 * mount({ doc, root, bridge, focusTerminal, terminalHasFocus, raf, caf, now, rng, css, context })
 *   root              the panel's element; its contents are replaced
 *   bridge            { scores(): Promise<bests>, submit(game, score): Promise<bests|null> } or null (no saved bests)
 *   focusTerminal()   gives keyboard focus back to the terminal
 *   terminalHasFocus() does the terminal hold it right now
 *   raf(fn) -> id, caf(id)  requestAnimationFrame and cancelAnimationFrame
 *   now()             milliseconds, for the frame delta
 *   css(name)         a colour from the project's tokens (--accent, --chrome ...)
 *   context           a canvas 2D context; default is the canvas's own
 * -> the controller { handBack, setView, refreshBests, state }
 */
function mount(opts) {
  const { doc, root: panel, bridge, focusTerminal, terminalHasFocus } = opts;
  const raf = opts.raf; const caf = opts.caf;
  const nowMs = opts.now;
  const rng = opts.rng || Math.random;
  const theme = opts.css;

  const el = (tag, attrs, kids) => {
    const n = doc.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else n.setAttribute(k, v); });
    (kids || []).forEach(k => n.appendChild(k));
    return n;
  };

  // --- DOM
  const bestEl = el('span', { class: 'games-best' });
  const head = el('div', { class: 'games-head' }, [el('span', { class: 'games-title', text: 'Games' }), bestEl]);
  const pickBtns = ORDER.map(g => el('button', { type: 'button', class: 'games-pick', 'data-game': g, text: LABEL[g] }));
  const pick = el('div', { class: 'games-picks', role: 'group', 'aria-label': 'Choose a game' }, pickBtns);
  const scoreEl = el('b', { class: 'games-score', text: '0' });
  const timeEl = el('b', { class: 'games-time', text: String(round.ROUND_SECONDS) });
  const bar = el('div', { class: 'games-bar' }, [
    el('span', { text: 'score ' }), scoreEl, el('span', { class: 'games-sp' }), el('span', { text: 'time ' }), timeEl, el('span', { text: 's' }),
  ]);
  const canvas = el('canvas', { class: 'games-canvas', width: String(FIELD.width), height: String(FIELD.height), tabindex: '0', 'aria-label': 'Wait game board' });
  const coverText = el('p', { class: 'games-cover-text' });
  const coverNote = el('p', { class: 'games-cover-note' });
  const coverBtn = el('button', { type: 'button', class: 'games-cover-btn', 'data-act': 'go' });
  const cover = el('div', { class: 'games-cover', role: 'status' }, [el('div', {}, [coverText, coverNote, coverBtn])]);
  const stage = el('div', { class: 'games-stage' }, [canvas, cover]);
  panel.textContent = '';
  [head, pick, bar, stage].forEach(n => panel.appendChild(n));

  const ctx = opts.context || (typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null);
  // The colour tokens are read from the page once per frame, not once per block or tile (each read can force a style recalc).
  let tokens = null;
  const tok = (name) => { if (tokens === null) tokens = {}; if (!(name in tokens)) tokens[name] = theme(name); return tokens[name]; };
  const games = makeGames(rng, tok);

  // --- state
  let current = 'stack';
  let s = round.idle();
  let view = { shown: false, pageVisible: true, lean: false };
  let bests = { stack: 0, merge: 0, pipeline: 0 };
  let loop = null;
  let last = 0;
  let paintedPick = null;
  games[current].reset();

  const game = () => games[current];
  const drawing = () => round.shouldDraw(view);

  // a frame paints 60 times a second: write a label only when its text changed
  const put = (n, v) => { if (n.textContent !== v) n.textContent = v; };
  function paintLabels() {
    put(bestEl, bestLine(bests));
    put(scoreEl, String(s.score));
    put(timeEl, String(round.secondsLeft(s)));
    if (paintedPick !== current) {
      paintedPick = current;
      pickBtns.forEach((b) => { b.classList.toggle('on', b.getAttribute('data-game') === current); b.setAttribute('aria-pressed', String(b.getAttribute('data-game') === current)); });
    }
    const cv = round.cover(s, HINT[current]);
    cover.hidden = cv === null;
    if (cv) { put(coverText, cv.text); put(coverNote, cv.note); put(coverBtn, cv.button); }
  }

  function draw() {
    if (ctx && drawing()) { tokens = null; game().draw(ctx); }
  }

  function cancel() { if (loop !== null) { if (caf) caf(loop); loop = null; } }
  // A loop STARTS (begin, resume, shown again) with a fresh stamp; a running loop re-arms WITHOUT one, so the time a frame spends
  // working still counts against the round.
  function schedule() { if (loop === null && s.phase === 'running' && drawing()) { last = nowMs(); loop = raf(frame); } }
  function rearm() { if (loop === null && s.phase === 'running' && drawing()) loop = raf(frame); }

  function bank() {
    const score = s.score;
    if (!bridge || !(score > 0)) return;
    const g = current;
    Promise.resolve(bridge.submit(g, score)).then((b) => { if (b && typeof b === 'object') { bests = { ...bests, ...b }; paintLabels(); } }, () => {});
  }

  function settleRound() {
    cancel();
    bank();
  }

  // the game says what happened: 'missed' / 'full' end the round, anything else keeps going
  function after(result) {
    s = round.withScore(s, game().score());
    if (result === 'missed' || result === 'full') s = round.finish(s, result);
    if (s.phase === 'over') settleRound();
  }

  function frame() {
    loop = null;
    if (!drawing()) { s = round.hide(s); paintLabels(); return; }
    if (s.phase !== 'running') return;
    const t = nowMs();
    const dt = Math.max(0, (t - last) / 1000);
    last = t;
    s = round.tick(s, dt);
    game().step(Math.min(dt, PHYSICS_STEP));
    after(undefined);
    draw(); paintLabels();
    rearm();
  }

  function begin() {
    game().reset();
    s = round.start();
    paintLabels(); draw();
    if (typeof canvas.focus === 'function') canvas.focus();
    schedule();
  }

  function choose(id) {
    if (!ORDER.includes(id) || id === current) return;
    if (s.phase === 'running' || s.phase === 'paused') { s = round.finish(s, 'time'); settleRound(); }
    current = id;
    game().reset();
    s = round.idle();
    paintLabels(); draw();
  }

  function comeBack() {
    if (!round.shouldResume(s, true, drawing())) return;
    cancelGesture();
    s = round.comeBack(s);
    paintLabels(); draw();
    if (typeof canvas.focus === 'function') canvas.focus();
    schedule();
  }

  // --- input
  const fieldPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return [NaN, NaN];
    return [(e.clientX - r.left) * FIELD.width / r.width, (e.clientY - r.top) * FIELD.height / r.height];
  };
  const live = () => s.phase === 'running' && drawing();
  // a half-made gesture (a swipe's press) never survives a pause: the press that resumes, or one cut short, is not a move
  function cancelGesture() { if (typeof game().cancel === 'function') game().cancel(); }

  panel.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const pickEl = t.closest('[data-game]');
    if (pickEl) { choose(pickEl.getAttribute('data-game')); return; }
    if (t.closest('[data-act="go"]')) { if (s.phase === 'paused') comeBack(); else begin(); return; }
    if (skipClick) { skipClick = false; return; }
    if (t === canvas && live() && typeof game().point === 'function') {
      const [x, y] = fieldPoint(e);
      const r = game().point(x, y);
      if (r !== undefined) { after(r); draw(); paintLabels(); }
    }
  });
  // Coming back to the board resumes a paused round. The cover's own button is left to its click (which resumes too), and the
  // click that resumes is not also a move: the cover is over the board.
  const onBoard = t => !!t && stage.contains(t) && t !== coverBtn;
  let skipClick = false;               // the click that follows a resuming pointerdown
  panel.addEventListener('pointerdown', (e) => {
    skipClick = false;
    if (s.phase === 'paused') { if (onBoard(e.target)) { comeBack(); skipClick = true; } return; }
    if (e.target === canvas && live() && typeof game().down === 'function') {
      // captured, so the release counts on the board even when the pointer ends outside it
      if (typeof canvas.setPointerCapture === 'function' && e.pointerId !== undefined) { try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ } }
      const [x, y] = fieldPoint(e); game().down(x, y);
    }
  });
  panel.addEventListener('pointerup', (e) => {
    if (e.target !== canvas || !live() || typeof game().up !== 'function') return;
    const [x, y] = fieldPoint(e);
    const r = game().up(x, y);
    if (r !== undefined) { after(r); draw(); paintLabels(); }
  });
  panel.addEventListener('pointercancel', () => { cancelGesture(); });
  panel.addEventListener('focusin', (e) => { if (round.shouldResume(s, onBoard(e.target), drawing(), 'focus')) comeBack(); });
  panel.addEventListener('keydown', (e) => {
    // A key reaches here only from inside the panel; the check is the rule, so it also holds if that ever changes.
    const focus = { panel: panel.contains(e.target), terminal: terminalHasFocus() === true };
    if (e.repeat === true) return;       // a held key is one press: held Space would drop block after block
    if (!round.acceptsKeys(s, focus) || !drawing() || typeof game().key !== 'function') return;
    const r = game().key(e);
    if (r === undefined) return;
    e.preventDefault();
    after(r); draw(); paintLabels();
  });

  // --- controller
  paintLabels();
  return {
    /** Claude needs Ricardo, or its turn finished: freeze a running round, say so, and give the terminal the keyboard. */
    handBack() {
      const was = s.phase === 'running';
      s = round.handBack(s);
      if (!was) return false;
      cancel();
      cancelGesture();
      bank();
      paintLabels();
      focusTerminal();
      return true;
    },
    /** The renderer's word on whether the panel is on screen: { shown, pageVisible, lean }. Missing keys keep their value. */
    setView(next) {
      const before = drawing();
      view = { ...view, ...next };
      if (drawing()) {
        if (!before) { loadBests(); draw(); }
        schedule();
      } else {
        cancel();
        if (s.phase === 'running') { s = round.hide(s); cancelGesture(); bank(); }
      }
      paintLabels();
    },
    // the board's own state, for tests and the probe: a copy, never the live object
    peek() { return JSON.parse(JSON.stringify(game().s)); },
    refreshBests: loadBests,
    /** The page is going away (pagehide): bank what the round has, best effort. */
    bankNow() { bank(); },
    state() { return { ...s, game: current, bests: { ...bests }, drawing: drawing(), looping: loop !== null }; },
  };

  function loadBests() {
    if (!bridge) return Promise.resolve();
    return Promise.resolve(bridge.scores()).then((b) => { if (b && typeof b === 'object') { bests = { ...bests, ...b }; paintLabels(); } }, () => {});
  }
}

const API = { mount, bestLine, makeGames, ORDER, LABEL, HINT };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.gamesDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
