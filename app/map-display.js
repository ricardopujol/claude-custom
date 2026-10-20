'use strict';
/**
 * The Map dock panel (BACKLOG #120): this project's sessions and agents as a live graph, with warm particle streams flowing along the
 * edges of whatever is working. The only Map module that touches the DOM; what is drawn is decided by app/map-model.js (nodes, edges,
 * conflicts, rates, zoom arithmetic) and where it sits by app/map-layout.js (the force layout). Every outside thing is injected (`raf`,
 * `now`, `css`, `dpr`, `observe`, `makeImage`, `storage`, `later`), so a test drives it with a fake document.
 *
 * THE FRAME BUDGET (the rule this panel exists under; BACKLOG #99/#100/#192 measured a breathing border at 12-20% of a core):
 *   - it ANIMATES only while the panel is shown, the window is focused and lean mode is off (map-model shouldAnimate), and particles
 *     also need prefers-reduced-motion to be off;
 *   - otherwise it draws ONE static frame (settled layout, no particles) and its rAF loop is not running;
 *   - hidden or lean: it draws nothing at all, and asks for no frame;
 *   - even animating, the loop STOPS by itself when the layout has settled and nothing is flowing, and wakes on the next change;
 *   - it runs at ~30 fps, and halves its particle budget when a frame takes over 40 ms (map-model adaptBudget).
 *
 * TEXT IS CRISP because the canvas is sized in device pixels (css size x devicePixelRatio) and drawn through a transform that includes
 * both the ratio and the zoom, so text and lines are rasterised at their final size, never scaled up from a smaller bitmap.
 *
 * Names are somebody else's strings: everything the DOM gets is textContent, never markup.
 *
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing ONE global scope (test/renderer-scope.test.js). One name
 * leaves it: `mapDisplay`.
 */
(function (root) {

const model = typeof module !== 'undefined' && module.exports ? require('./map-model') : root.mapModel;
const layoutLib = typeof module !== 'undefined' && module.exports ? require('./map-layout') : root.mapLayout;

const FRAME_MIN_MS = 30;           // ~30 fps while animating
const PACE_SLACK_MS = 1;           // the timer waits the rest of the slot PLUS this, so the animation frame it asks for is never too early to draw (one wake-up a frame)
const STEPS_PER_FRAME = 2;         // layout ticks a frame while it is still settling
const SAVE_AFTER_MS = 700;
const TOKENS_TTL_MS = 400;
const IMAGES_MAX = 120;
const LABEL_MIN_ZOOM = 0.55;
const WORDS = { working: 'working', needs: 'needs you', done: 'done', error: 'error', idle: 'idle', unknown: 'not reported' };
const LEGEND = [['working', 'running'], ['needs', 'needs you'], ['done', 'done'], ['idle', 'idle']];

const isNum = n => typeof n === 'number' && Number.isFinite(n);
const isStr = s => typeof s === 'string' && s !== '';

const hashOf = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; };

// --- what the hover card says -------------------------------------------------------------------------------------------------

function ago(ms, wall) {
  return isNum(ms) && isNum(wall) ? model.duration(wall - ms) : '—';
}

/** The words for a hovered node or conflict edge: { title, lines }. Pure; `wall` is the epoch clock. */
function cardFor(item, wall) {
  if (!item) return null;
  if (item.kind === 'conflict') {
    return {
      title: `Conflict · ${item.label}`,
      lines: item.claims.map(c => `${isStr(c.agent) ? c.agent : 'an agent'} wrote here ${ago(c.lastAt, wall)} ago`),
    };
  }
  const d = item.data || {};
  if (item.kind === 'project') return { title: item.label, lines: [item.sub] };
  if (item.kind === 'session') {
    const lines = [WORDS[item.state] || WORDS.unknown];
    if (item.self) lines.push('this window');
    if (isStr(d.folder)) lines.push(d.folder);
    return { title: item.label, lines };
  }
  if (item.kind === 'more') return { title: `${item.label} more agents`, lines: ['Not drawn; the Agents panel lists them'] };
  const lines = [
    `state: ${WORDS[item.state] || WORDS.unknown}${isStr(d.detail) && d.detail !== d.state ? ` (${d.detail})` : ''}`,
    `model: ${isStr(d.model) ? d.model : '—'}`,
    `tokens: ${isNum(d.tokens) ? model.compact(d.tokens) + ' in this project' : '—'}`,
    `tool: ${isStr(d.tool) ? d.tool : '—'}`,
  ];
  if (isNum(d.since)) lines.push(`elapsed: ${ago(d.since, wall)}`);
  if (isStr(d.worktree)) lines.push(`worktree: ${model.baseOfPath(d.worktree) || d.worktree}`);
  return { title: isStr(d.role) ? `${d.role} · ${item.label}` : item.label, lines };
}

/** A roster portrait -> { url, initials, hue } for the canvas. A video, a missing file or images off all become initials. */
function portraitSpec(portrait, name, { imagesEnabled, fileUrl } = {}) {
  const p = portrait && typeof portrait === 'object' ? portrait : null;
  const fb = p && (p.kind === 'placeholder' ? p : p.fallback);
  const initials = fb && isStr(fb.initials) ? fb.initials : (isStr(name) ? Array.from(name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0] || '?').slice(0, 2).join('').toUpperCase() : '?');
  const hue = fb && isNum(fb.hue) ? fb.hue : hashOf(String(name)) % 360;
  const url = imagesEnabled === true && p && p.kind === 'file' && p.media !== 'video' && isStr(p.path) && typeof fileUrl === 'function'
    ? fileUrl(p.path, p.mtimeMs) : null;
  return { url, initials, hue };
}

// --- the panel ------------------------------------------------------------------------------------------------------------

/**
 * mount({ doc, root, raf, caf, now, wall, later, css, dpr, reducedMotion, observe, makeImage, storage, onSession, onAgent, context, seed })
 *   root            the panel's element; its contents are replaced
 *   raf(fn) -> id, caf(id)   requestAnimationFrame and cancelAnimationFrame
 *   now()           milliseconds on the frame clock (performance.now); wall() epoch milliseconds (Date.now), for "elapsed"
 *   later(fn, ms)   setTimeout (the debounced save)
 *   pace(fn, ms) -> id, unpace(id)   setTimeout / clearTimeout for the wait between two frames of the loop (optional: without them it uses animation frames)
 *   css(name)       a colour or font from the project's tokens (--accent, --chrome ...)
 *   dpr()           devicePixelRatio; reducedMotion() -> bool
 *   observe(el, fn) -> disposer   calls fn when el's size changes (ResizeObserver)
 *   makeImage()     a new Image (portraits are drawn from these)
 *   storage         { read(key) -> string|null, write(key, string) } or null: the picture and the view are kept per project
 *   onSession(sessionData), onAgent(name)   clicks
 *   context         a canvas 2D context; default is the canvas's own
 * -> the controller { setData, setView, fit, redraw, screenPos, state }
 */
function mount(opts) {
  const { doc, root: panel } = opts;
  const raf = opts.raf; const caf = opts.caf;
  const nowMs = opts.now;
  const wall = opts.wall || (() => Date.now());
  const later = opts.later || ((fn, ms) => setTimeout(fn, ms));
  const theme = opts.css;
  const dprOf = opts.dpr || (() => 1);
  const reduced = opts.reducedMotion || (() => false);

  const el = (tag, attrs, kids) => {
    const n = doc.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else n.setAttribute(k, v); });
    (kids || []).forEach(k => n.appendChild(k));
    return n;
  };

  // --- DOM
  const stat = (key, text) => el('span', { class: 'map-stat', 'data-stat': key, text });
  const statTasks = stat('tasks', 'tasks —');
  const statEvents = stat('events', 'events —');
  const statActive = stat('active', 'active —');
  const statUp = stat('uptime', 'up —');
  const zoomEl = el('span', { class: 'map-zoom', text: '100%', title: 'Wheel to zoom, drag to pan' });
  const fitBtn = el('button', { type: 'button', class: 'map-fit', title: 'Fit everything in view (double-click the map too)', text: 'Fit' });
  const strip = el('div', { class: 'map-strip' }, [statTasks, statEvents, statActive, statUp, el('span', { class: 'map-sp' }), zoomEl, fitBtn]);
  const canvas = el('canvas', { class: 'map-canvas', tabindex: '0', role: 'img', 'aria-label': 'Map of this project\'s sessions and agents' });
  const cardTitle = el('div', { class: 'map-card-title' });
  const cardBody = el('div', { class: 'map-card-body' });
  const card = el('div', { class: 'map-card', role: 'status' }, [cardTitle, cardBody]);
  card.hidden = true;
  const legend = el('div', { class: 'map-legend' }, LEGEND.map(([state, text]) => el('span', { class: 'map-key', 'data-state': state }, [el('i', { class: 'map-dot', 'data-state': state }), el('span', { text })])));
  const stage = el('div', { class: 'map-stage' }, [canvas, card, legend]);
  panel.textContent = '';
  panel.appendChild(el('div', { class: 'map-root' }, [strip, stage]));

  const ctx = opts.context || (typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: false }) : null);

  // --- state
  let viewState = { shown: false, focused: null, lean: null };
  let graph = model.buildGraph(null);
  let input = null;
  let signature = '';
  const layout = layoutLib.createLayout({ seed: opts.seed === undefined ? 7 : opts.seed });
  let particles = model.newParticles();
  let budget = 1;
  let view = { x: 0, y: 0, k: 1 };
  let userView = false;              // the person panned or zoomed: stop re-fitting under them
  let size = { w: 0, h: 0, dpr: 0 };
  let loop = null;                   // a pending animation frame
  let pacer = null;                  // a pending wait for the next ~30 fps slot (a timer: the page is not woken on every vsync to do nothing)
  let lastFrameAt = null;
  let frames = 0;
  let lastCost = 0;
  let hover = null;                  // { kind: 'node', id } | { kind: 'conflict', id }
  let drag = null;                   // { x, y, moved }
  let projectKey = null;
  let saveTimer = null;
  let tokens = null;
  let tokensAt = -Infinity;          // the page's colours are read a few times a second, not every frame (each read is a style lookup)
  let rngState = 12345;
  const rng = () => { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296; };
  const images = new Map();
  const sprites = new Map();
  const put = (n, v) => { if (n.textContent !== v) n.textContent = v; };

  const tok = (name) => { if (tokens === null) tokens = {}; if (!(name in tokens)) tokens[name] = theme(name); return tokens[name]; };
  const colourOf = (state) => {
    switch (state) {
      case 'working': return tok('--accent') || '#d08c4a';
      case 'needs': return tok('--cue') || tok('--warn') || '#e6c34a';
      case 'done': return tok('--ok') || '#5fb07a';
      case 'error': return tok('--bad') || '#cc5f5f';
      default: return tok('--dim') || '#6d7689';
    }
  };
  const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

  const animating = () => model.shouldAnimate(viewState);
  const drawing = () => model.shouldDraw(viewState);
  const particlesOn = () => model.particlesOn(viewState, reduced() === true);
  const flowsOf = () => graph.edges.filter(e => e.flow > 0).map(e => ({ id: e.id, rate: e.flow }));
  const nodeById = (id) => graph.nodes.find(n => n.id === id) || null;

  // --- size
  // The stage's size is asked of the layout once, then kept until the size observer says it changed: a rect read every frame is a forced
  // layout whenever anything else on the page is dirty. (Without an observer it is read every time.)
  let measured = null;
  let observing = false;
  function measure() {
    const dpr = Math.max(1, dprOf() || 1);
    if (observing && measured) return { w: measured.w, h: measured.h, dpr };
    const r = stage.getBoundingClientRect();
    const w = r && isNum(r.width) ? r.width : 0;
    const h = r && isNum(r.height) ? r.height : 0;
    measured = { w, h };
    return { w, h, dpr };
  }

  function fit() {
    const m = measure();
    view = model.fitView(graph.nodes, m.w, m.h, 34);
    userView = false;
    paintZoom();
    redraw();
  }
  function paintZoom() { put(zoomEl, `${Math.round(view.k * 100)}%`); }

  // --- keeping the picture per project
  const keyFor = () => (projectKey ? `claude-custom.map.${hashOf(projectKey).toString(36)}` : null);
  function save() {
    saveTimer = null;
    const key = keyFor();
    if (!key || !opts.storage) return;
    try { opts.storage.write(key, JSON.stringify({ v: 1, pos: layoutLib.snapshot(layout), view: userView ? view : null })); } catch { /* storage is full or gone: the picture just isn't kept */ }
  }
  function saveSoon() {
    if (!opts.storage || saveTimer !== null) return;
    saveTimer = later(save, SAVE_AFTER_MS);
  }
  function loadKept() {
    const key = keyFor();
    if (!key || !opts.storage) return;
    let kept = null;
    try { const raw = opts.storage.read(key); kept = raw ? JSON.parse(raw) : null; } catch { kept = null; }
    if (!kept || typeof kept !== 'object' || kept.v !== 1) return;
    layoutLib.restore(layout, kept.pos);
    const v = kept.view;
    if (v && isNum(v.x) && isNum(v.y) && isNum(v.k) && v.k >= model.ZOOM_MIN && v.k <= model.ZOOM_MAX && Math.abs(v.x) < 1e5 && Math.abs(v.y) < 1e5) { view = { x: v.x, y: v.y, k: v.k }; userView = true; paintZoom(); }
  }

  // --- images and sprites
  function imageFor(url) {
    if (!isStr(url) || typeof opts.makeImage !== 'function') return null;
    let e = images.get(url);
    if (!e) {
      if (images.size >= IMAGES_MAX) images.delete(images.keys().next().value);
      const img = opts.makeImage();
      e = { img, ok: false };
      images.set(url, e);
      img.onload = () => { e.ok = true; gver += 1; redraw(); };
      img.onerror = () => { e.bad = true; };
      img.src = url;
    }
    return e.ok ? e.img : null;
  }
  /** [r, g, b] of a #rgb, #rrggbb or rgb()/rgba() colour; null for anything else (a hsl(), a color-mix(), a name). */
  function rgbOf(css) {
    const s = String(css || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return m[1].split('').map(c => parseInt(c + c, 16));
    m = /^#([0-9a-f]{6})/i.exec(s);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  /** The colour with this opacity. A canvas gradient interpolates WITHOUT premultiplying, so fading to 'transparent' (black, alpha 0) leaves a dark fringe: fade to the same colour at alpha 0. */
  const alphaOf = (css, a) => { const c = rgbOf(css); return c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : mix(css, Math.round(a * 100), 'transparent'); };

  /** A soft round particle. On a dark panel: a white-hot core in the state's colour, drawn additively. On a light one: solid colour, drawn normally. */
  function spriteFor(colour, dpr, dark) {
    const key = `${colour}|${dpr}|${dark ? 1 : 0}`;
    if (sprites.has(key)) return sprites.get(key);
    let out = null;
    const c = doc.createElement('canvas');
    if (typeof c.getContext === 'function') {
      const px = Math.round(32 * dpr);
      c.width = px; c.height = px;
      const g = c.getContext('2d');
      if (g) {
        const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
        if (dark) {
          grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.2, alphaOf(colour, 1)); grad.addColorStop(0.55, alphaOf(colour, 0.35)); grad.addColorStop(1, alphaOf(colour, 0));
        } else {
          grad.addColorStop(0, alphaOf(colour, 1)); grad.addColorStop(0.45, alphaOf(colour, 0.85)); grad.addColorStop(1, alphaOf(colour, 0));
        }
        g.fillStyle = grad; g.fillRect(0, 0, px, px);
        out = c;
      }
    }
    sprites.set(key, out);
    return out;
  }

  // --- drawing
  // THREE PASSES, because most of what is on screen does not change from one frame to the next. The BACK pass (background, grid, edges)
  // and the FRONT pass (nodes and their labels) are each drawn onto their own offscreen canvas and re-drawn only when something they show
  // changed (the view, the layout, the data, the hover, the colours, the size). Every frame is then: blit the back, draw the DYNAMIC pass
  // (particles and the working agents' pulse rings, the only things that move), blit the front. Nodes stay on top of the streams, and a
  // frame's cost is the number of particles, not the number of labels. Without offscreen canvases (a test's fake document) the same three
  // passes are drawn straight onto the visible canvas every frame.
  const bendOf = (e) => (e.kind === 'conflict' ? 34 : ((hashOf(e.id) % 7) - 3) * 5);
  const TOKEN_NAMES = ['--bg', '--chrome', '--accent', '--ok', '--bad', '--dim', '--text', '--warn', '--cue', '--font-ui'];
  let back = null; let front = null;     // { canvas, g } | null: the two offscreen layers
  let layersAt = '';                     // size + ratio the layers were made for
  let backKey = ''; let frontKey = '';   // what each layer was last drawn from
  let gver = 0;                          // bumped whenever what the nodes or edges look like may have changed (data, layout, a portrait loaded)

  /** The perceived lightness of a CSS colour (0 dark .. 1 light); unknown forms count as dark. */
  function lightnessOf(css) {
    const c = rgbOf(css);
    return c ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : 0;
  }

  function makeLayer(w, h) {
    const c = doc.createElement('canvas');
    if (typeof c.getContext !== 'function') return null;
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    return g ? { canvas: c, g } : null;
  }

  /** Back: the background, a faint dot grid that moves with the view, and every edge. */
  function paintBack(g, dpr, fontUi) {
    const k = view.k;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = tok('--bg') || '#11131a';
    g.fillRect(0, 0, size.w, size.h);
    const glow = typeof g.createRadialGradient === 'function' ? g.createRadialGradient(size.w / 2, size.h / 2, 0, size.w / 2, size.h / 2, Math.max(size.w, size.h) * 0.7) : null;
    if (glow) {
      glow.addColorStop(0, mix(colourOf('working'), 9, tok('--chrome') || '#171a23'));
      glow.addColorStop(1, tok('--bg') || '#11131a');
      g.fillStyle = glow;
      g.fillRect(0, 0, size.w, size.h);
    }
    const step = 40 * k;
    if (step >= 14) {
      g.fillStyle = mix(tok('--dim') || '#6d7689', 30, 'transparent');
      const ox = ((view.x % step) + step) % step; const oy = ((view.y % step) + step) % step;
      g.beginPath();
      for (let gx = ox; gx < size.w; gx += step) for (let gy = oy; gy < size.h; gy += step) g.rect(Math.round(gx), Math.round(gy), 1.5, 1.5);
      g.fill();
    }
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
    g.lineCap = 'round';
    const pos = new Map(graph.nodes.map(n => [n.id, n]));
    const curve = (a, b, bend) => {
      const c = model.curvePoint(a, b, 0.5, bend);
      g.beginPath(); g.moveTo(a.x, a.y);
      g.quadraticCurveTo(2 * c.x - (a.x + b.x) / 2, 2 * c.y - (a.y + b.y) / 2, b.x, b.y);
      return c;
    };
    for (const e of graph.edges) {
      const a = pos.get(e.from); const b = pos.get(e.to);
      if (!a || !b || !isNum(a.x) || !isNum(b.x)) continue;
      const hot = hover && hover.id === e.id;
      if (e.kind === 'conflict') {
        g.strokeStyle = colourOf('error'); g.lineWidth = (hot ? 2.6 : 1.8) / k; g.setLineDash([6 / k, 5 / k]);
        const c = curve(a, b, bendOf(e));
        g.stroke(); g.setLineDash([]);
        if (k >= LABEL_MIN_ZOOM) {
          g.font = `600 10px ${fontUi}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = colourOf('error');
          g.fillText(model.shorten(e.label, 22), c.x, c.y - 7);
        }
        continue;
      }
      curve(a, b, bendOf(e));
      if (e.flow > 0) { g.strokeStyle = mix(colourOf(e.state), 14, 'transparent'); g.lineWidth = 6 / k; g.stroke(); curve(a, b, bendOf(e)); }   // a soft glow under a stream
      g.strokeStyle = mix(colourOf(e.state), e.flow > 0 ? 72 : 38, 'transparent'); g.lineWidth = (e.flow > 0 ? 1.8 : 1.2) / k; g.setLineDash([]);
      g.stroke();
    }
  }

  /** Front: every node and its label, over the streams. */
  function paintFront(g, dpr, fontUi) {
    const k = view.k;
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const chrome = tok('--chrome') || '#171a23';
    const text = tok('--text') || '#c7cede';
    const dim = tok('--dim') || '#6d7689';
    const showLabels = k >= LABEL_MIN_ZOOM;
    for (const n of graph.nodes) {
      if (!isNum(n.x) || !isNum(n.y)) continue;
      const colour = colourOf(n.state);
      const hot = hover && hover.id === n.id;
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      if (n.kind === 'project') {
        const halo = typeof g.createRadialGradient === 'function' ? g.createRadialGradient(n.x, n.y, n.r * 0.6, n.x, n.y, n.r * 2.8) : null;
        if (halo) { halo.addColorStop(0, mix(colourOf('working'), 26, 'transparent')); halo.addColorStop(1, mix(colourOf('working'), 0, 'transparent')); g.fillStyle = halo; g.beginPath(); g.arc(n.x, n.y, n.r * 2.8, 0, Math.PI * 2); g.fill(); }
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        g.fillStyle = mix(colourOf('working'), 16, chrome); g.fill();
        g.lineWidth = 2.2 / k; g.strokeStyle = colourOf('working'); g.stroke();
        g.beginPath(); g.arc(n.x, n.y, n.r * 0.38, 0, Math.PI * 2); g.fillStyle = colourOf('working'); g.fill();
        g.fillStyle = text; g.font = `600 13px ${fontUi}`; g.fillText(model.shorten(n.label, 26), n.x, n.y + n.r + 17);
        g.fillStyle = dim; g.font = `11px ${fontUi}`; g.fillText(n.sub, n.x, n.y + n.r + 31);
      } else if (n.kind === 'session') {
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        g.fillStyle = mix(colour, 18, chrome); g.fill();
        g.lineWidth = (hot ? 3 : 2) / k; g.strokeStyle = colour; g.stroke();
        g.beginPath(); g.arc(n.x, n.y, 4.5, 0, Math.PI * 2); g.fillStyle = colour; g.fill();
        if (n.self) { g.beginPath(); g.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2); g.lineWidth = 1 / k; g.strokeStyle = mix(text, 55, 'transparent'); g.stroke(); }
        if (showLabels) { g.fillStyle = text; g.font = `12px ${fontUi}`; g.fillText(model.shorten(n.label, 22), n.x, n.y + n.r + 16); }
      } else if (n.kind === 'agent') {
        const d = n.data || {};
        const spec = d.portrait && typeof d.portrait === 'object' ? d.portrait : { initials: '?', hue: 0, url: null };
        const img = imageFor(spec.url);
        g.save();
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2); g.clip();
        if (img) {
          g.drawImage(img, n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
        } else {
          g.fillStyle = `hsl(${isNum(spec.hue) ? spec.hue : 0} 42% 52%)`; g.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
          g.fillStyle = '#fff'; g.font = `700 ${n.r * 0.85}px ${fontUi}`; g.textBaseline = 'middle';
          g.fillText(String(spec.initials || '?').slice(0, 2), n.x, n.y + 0.5);
          g.textBaseline = 'alphabetic';
        }
        g.restore();
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2); g.lineWidth = (hot ? 3 : 2) / k; g.strokeStyle = colour; g.stroke();
        if (showLabels) { g.fillStyle = n.state === 'idle' ? dim : text; g.font = `10.5px ${fontUi}`; g.fillText(model.shorten(n.label, 16), n.x, n.y + n.r + 13); }
      } else {
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2); g.setLineDash([3 / k, 3 / k]); g.lineWidth = 1.5 / k; g.strokeStyle = dim; g.stroke(); g.setLineDash([]);
        g.fillStyle = dim; g.font = `600 11px ${fontUi}`; g.textBaseline = 'middle'; g.fillText(n.label, n.x, n.y + 0.5); g.textBaseline = 'alphabetic';
      }
    }
  }

  /** Dynamic: what moves. Pulse rings round working agents, and the particles (additive glow on a dark panel, solid on a light one). */
  function paintDynamic(g, dpr, t, moving) {
    const k = view.k;
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
    g.globalAlpha = 1;
    g.lineCap = 'round';
    for (const n of graph.nodes) {
      if (n.kind !== 'agent' || n.state !== 'working' || !isNum(n.x) || !isNum(n.y)) continue;
      const pulse = moving ? 0.5 + 0.5 * Math.sin(t / 340 + (hashOf(n.id) % 6)) : 0.4;
      g.beginPath(); g.arc(n.x, n.y, n.r + 3 + pulse * 3, 0, Math.PI * 2);
      g.lineWidth = 1.5 / k; g.strokeStyle = mix(colourOf('working'), 28 + pulse * 40, 'transparent'); g.stroke();
    }
    if (!(moving && particlesOn() && particles.list.length)) return;
    const dark = lightnessOf(tok('--bg')) < 0.45;
    const pos = new Map(graph.nodes.map(n => [n.id, n]));
    const byId = new Map(graph.edges.map(e => [e.id, e]));
    g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    for (const p of particles.list) {
      const e = byId.get(p.e);
      if (!e) continue;
      const a = pos.get(e.from); const b = pos.get(e.to);
      if (!a || !b) continue;
      const colour = colourOf(e.state);
      const sprite = spriteFor(colour, dpr, dark);
      const bend = bendOf(e);
      for (let i = 0; i < 3; i += 1) {
        const tt = p.t - i * 0.03;
        if (tt < 0) break;
        const q = model.curvePoint(a, b, tt, bend);
        const sz = (15 - i * 3.5) / k;
        g.globalAlpha = i === 0 ? 1 : i === 1 ? 0.55 : 0.28;
        if (sprite) g.drawImage(sprite, q.x - sz / 2, q.y - sz / 2, sz, sz);
        else { g.fillStyle = colour; g.beginPath(); g.arc(q.x, q.y, sz / 3, 0, Math.PI * 2); g.fill(); }
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  function drawFrame(t) {
    if (!ctx) return;
    if (tokens === null || t - tokensAt > TOKENS_TTL_MS) { tokens = {}; tokensAt = t; }
    const m = measure();
    if (m.w <= 0 || m.h <= 0) return;
    const sizeKey = `${m.w}x${m.h}@${m.dpr}`;
    if (m.w !== size.w || m.h !== size.h || m.dpr !== size.dpr) {
      size = m;
      canvas.width = Math.round(m.w * m.dpr);
      canvas.height = Math.round(m.h * m.dpr);
      if (!userView) view = model.fitView(graph.nodes, m.w, m.h, 34);
      paintZoom();
    }
    const dpr = size.dpr;
    const moving = animating();
    const fontUi = tok('--font-ui') || 'system-ui, sans-serif';
    if (layersAt !== sizeKey) {
      layersAt = sizeKey;
      back = makeLayer(canvas.width, canvas.height);
      front = back ? makeLayer(canvas.width, canvas.height) : null;
      if (!front) back = null;
      backKey = ''; frontKey = '';
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (back && front) {
      const tokenKey = TOKEN_NAMES.map(tok).join('|');
      const viewKey = `${view.x},${view.y},${view.k}`;
      const bKey = `${gver}|${viewKey}|${hover ? hover.id : ''}|${tokenKey}`;
      if (bKey !== backKey) { backKey = bKey; paintBack(back.g, dpr, fontUi); }
      if (bKey !== frontKey) { frontKey = bKey; front.g.setTransform(1, 0, 0, 1, 0, 0); front.g.clearRect(0, 0, canvas.width, canvas.height); paintFront(front.g, dpr, fontUi); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(back.canvas, 0, 0);
      paintDynamic(ctx, dpr, t, moving);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(front.canvas, 0, 0);
    } else {
      paintBack(ctx, dpr, fontUi);
      paintDynamic(ctx, dpr, t, moving);
      paintFront(ctx, dpr, fontUi);
    }
    frames += 1;
  }

  // --- the loop
  const wantLoop = () => animating() && (!layoutLib.settled(layout) || (particlesOn() && (flowsOf().length > 0 || particles.list.length > 0)));

  function settleNow() {
    let n = 0;
    while (!layoutLib.settled(layout) && n < layoutLib.MAX_STEPS + 50) { layoutLib.step(layout, graph); n += 1; }
    layoutLib.apply(layout, graph);
  }

  function frame() {
    loop = null;
    if (!drawing()) return;
    const t = nowMs();
    const moving = animating();
    if (moving && lastFrameAt !== null && t - lastFrameAt < FRAME_MIN_MS) { loop = raf(frame); return; }
    const dt = lastFrameAt === null ? 1 / 30 : Math.min(0.1, (t - lastFrameAt) / 1000);
    lastFrameAt = t;
    const wasSettled = layoutLib.settled(layout);
    if (moving) {
      for (let i = 0; i < STEPS_PER_FRAME; i += 1) layoutLib.step(layout, graph);
      layoutLib.apply(layout, graph);
      if (!wasSettled) gver += 1;
      if (particlesOn()) particles = model.stepParticles(particles, flowsOf(), dt, budget, rng);
      else if (particles.list.length) particles = model.newParticles();
    } else {
      settleNow();
      if (!wasSettled) gver += 1;
      if (particles.list.length) particles = model.newParticles();
    }
    if (!wasSettled && layoutLib.settled(layout)) {
      if (!userView) { const m = measure(); view = model.fitView(graph.nodes, m.w, m.h, 34); paintZoom(); }
      saveSoon();
    } else if (!userView && moving && !layoutLib.settled(layout)) {
      const m = measure(); view = model.fitView(graph.nodes, m.w, m.h, 34); paintZoom();      // keep everything in view while it unfolds
    }
    drawFrame(t);
    lastCost = nowMs() - t;
    budget = model.adaptBudget(budget, lastCost);
    if (wantLoop()) arm(t);
    else lastFrameAt = null;
  }

  // Ask for the NEXT frame of the loop: a timer for most of the wait, then one animation frame, so ~30 fps costs ~30 wake-ups a second.
  function arm(t) {
    const wait = FRAME_MIN_MS - (nowMs() - t) + PACE_SLACK_MS;
    if (typeof opts.pace === 'function' && wait >= 2) pacer = opts.pace(() => { pacer = null; if (drawing()) loop = raf(frame); }, wait);
    else loop = raf(frame);
  }

  function cancel() {
    if (loop !== null) { if (caf) caf(loop); loop = null; }
    if (pacer !== null) { if (opts.unpace) opts.unpace(pacer); pacer = null; }
    lastFrameAt = null;
  }
  /** Ask for a frame. One is enough: while the loop runs it draws the next change itself. */
  function redraw() {
    if (loop !== null || pacer !== null || !drawing()) return;
    lastFrameAt = null;
    loop = raf(frame);
  }

  // --- text parts of the panel
  function paintStrip() {
    const lanes = input && input.lanes;
    put(statTasks, lanes && isNum(lanes.open) ? `tasks ${lanes.open}${isNum(lanes.withPr) && lanes.withPr > 0 ? ` · ${lanes.withPr} PR` : ''}` : 'tasks —');
    const feed = input && input.feed;
    put(statEvents, `events ${feed && isNum(feed.events) ? model.compact(feed.events) : '—'}`);
    put(statActive, `active ${graph.counts.activeAgents} / ${graph.counts.totalAgents}`);
    put(statUp, `up ${feed && isNum(feed.uptimeMs) ? model.duration(feed.uptimeMs) : '—'}`);
    const label = `Map of this project: ${graph.counts.sessions} session${graph.counts.sessions === 1 ? '' : 's'}, ${graph.counts.activeAgents} agent${graph.counts.activeAgents === 1 ? '' : 's'} active`;
    if (canvas.getAttribute('aria-label') !== label) canvas.setAttribute('aria-label', label);
  }

  // --- hover card
  function showCard(item, px, py) {
    const c = cardFor(item, wall());
    if (!c) { card.hidden = true; return; }
    put(cardTitle, c.title);
    const text = c.lines.join('\n');
    if (cardBody.getAttribute('data-text') !== text) {
      cardBody.textContent = '';
      for (const line of c.lines) cardBody.appendChild(el('div', { class: 'map-card-line', text: line }));
      cardBody.setAttribute('data-text', text);
    }
    card.style.left = `${Math.round(Math.max(6, Math.min(px + 14, size.w - 236)))}px`;
    card.style.top = `${Math.round(Math.max(6, Math.min(py + 14, size.h - 130)))}px`;
    card.hidden = false;
  }
  function setHover(next, px, py) {
    const same = (!hover && !next) || (hover && next && hover.id === next.id);
    hover = next;
    if (!next) { if (!card.hidden) card.hidden = true; } else showCard(next.item, px, py);
    if (!same) redraw();
  }

  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (isNum(e.clientX) ? e.clientX : 0) - (r.left || 0), y: (isNum(e.clientY) ? e.clientY : 0) - (r.top || 0) };
  }
  function nearConflict(wx, wy) {
    const tol = 6 / view.k;
    for (const e of graph.conflicts) {
      const a = nodeById(e.from); const b = nodeById(e.to);
      if (!a || !b) continue;
      for (let i = 0; i <= 14; i += 1) {
        const q = model.curvePoint(a, b, i / 14, bendOf(e));
        if (Math.hypot(q.x - wx, q.y - wy) <= tol) return e;
      }
    }
    return null;
  }
  function pick(px, py) {
    const w = model.toWorld(view, px, py);
    const n = model.hitTest(graph.nodes, w.x, w.y, 3 / view.k);
    if (n) return { id: n.id, item: n };
    const c = nearConflict(w.x, w.y);
    return c ? { id: c.id, item: c } : null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = pointer(e);
    drag = { x: p.x, y: p.y, moved: false };
    if (typeof canvas.setPointerCapture === 'function' && e.pointerId !== undefined) { try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointer(e);
    if (drag) {
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < 4) return;
      drag.moved = true;
      view = { x: view.x + (p.x - drag.x), y: view.y + (p.y - drag.y), k: view.k };
      drag.x = p.x; drag.y = p.y;
      userView = true;
      setHover(null);
      redraw();
      return;
    }
    setHover(pick(p.x, p.y), p.x, p.y);
  });
  const release = (e) => {
    const was = drag;
    drag = null;
    if (!was) return;
    if (was.moved) { saveSoon(); return; }
    const p = pointer(e);
    const hit = pick(p.x, p.y);
    if (!hit) return;
    const n = hit.item;
    if (n.kind === 'session' && typeof opts.onSession === 'function') opts.onSession(n.data);
    else if (n.kind === 'agent' && typeof opts.onAgent === 'function') opts.onAgent(n.data.name);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointerleave', () => { drag = null; setHover(null); });
  canvas.addEventListener('wheel', (e) => {
    const p = pointer(e);
    const f = Math.exp(-(isNum(e.deltaY) ? e.deltaY : 0) * 0.0015);
    e.preventDefault();
    view = model.zoomAt(view, f, p.x, p.y);
    userView = true;
    paintZoom();
    saveSoon();
    redraw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => fit());
  fitBtn.addEventListener('click', () => fit());
  canvas.addEventListener('keydown', (e) => {
    const m = measure();
    if (e.key === '+' || e.key === '=') view = model.zoomAt(view, 1.2, m.w / 2, m.h / 2);
    else if (e.key === '-' || e.key === '_') view = model.zoomAt(view, 1 / 1.2, m.w / 2, m.h / 2);
    else if (e.key === '0') { fit(); e.preventDefault(); return; }
    else return;
    userView = true; paintZoom(); saveSoon(); redraw(); e.preventDefault();
  });
  if (typeof opts.observe === 'function') observing = typeof opts.observe(stage, () => { measured = null; size = { w: 0, h: 0, dpr: 0 }; redraw(); }) === 'function';

  // --- the controller
  paintStrip();
  return {
    /** The graph's inputs (see map-model buildGraph) plus `lanes` { open, withPr } and `feed` { events, uptimeMs }. */
    setData(next) {
      input = next && typeof next === 'object' ? next : null;
      const key = input && input.project && isStr(input.project.name) ? input.project.name : null;
      if (key !== projectKey) { projectKey = key; if (key) loadKept(); }
      graph = model.buildGraph(input);
      paintStrip();
      const sig = JSON.stringify([graph.nodes.map(n => [n.id, n.label, n.sub, n.state, n.data && n.data.portrait ? n.data.portrait.url : null]), graph.edges.map(e => [e.id, e.state, e.flow, e.label])]);
      const changedShape = layoutLib.sync(layout, graph);
      layoutLib.apply(layout, graph);
      if (hover) {
        const again = hover.item.kind === 'conflict' ? graph.conflicts.find(c => c.id === hover.id) : nodeById(hover.id);
        if (again) { hover.item = again; showCard(again, parseFloat(card.style.left) - 14 || 0, parseFloat(card.style.top) - 14 || 0); } else setHover(null);
      }
      if (sig === signature && !changedShape) return;
      signature = sig;
      gver += 1;
      if (!userView && size.w > 0) { view = model.fitView(graph.nodes, size.w, size.h, 34); paintZoom(); }
      redraw();
    },
    /** The renderer's word on the three facts only it knows: { shown, focused, lean }. Missing keys keep their value. */
    setView(next) {
      const before = { draw: drawing(), anim: animating() };
      viewState = { ...viewState, ...next };
      if (!drawing()) { cancel(); if (!card.hidden) card.hidden = true; hover = null; return; }
      if (!before.draw || before.anim !== animating()) {
        cancel();
        redraw();           // one frame: static when not animating, the first of the loop when it is
      }
    },
    fit,
    redraw,
    /** Where a node is on the panel, in CSS pixels, for tests and the probe. */
    screenPos(id) { const n = nodeById(id); return n && isNum(n.x) ? model.toScreen(view, n.x, n.y) : null; },
    /** The point `t` (0..1) along an edge, on screen, for tests and the probe. */
    edgePos(id, t) {
      const e = graph.edges.find(x => x.id === id);
      const a = e && nodeById(e.from); const b = e && nodeById(e.to);
      if (!a || !b || !isNum(a.x) || !isNum(b.x)) return null;
      const q = model.curvePoint(a, b, isNum(t) ? t : 0.5, bendOf(e));
      return model.toScreen(view, q.x, q.y);
    },
    /** For tests and the probe: a copy, never the live objects. */
    state() {
      return {
        drawing: drawing(), animating: animating(), looping: loop !== null || pacer !== null, frames, lastCost, budget,
        settled: layoutLib.settled(layout), particles: particles.list.length, flows: flowsOf().length,
        particleEdges: [...new Set(particles.list.map(p => p.e))],
        zoom: view.k, view: { ...view }, size: { ...size },
        nodes: graph.nodes.map(n => ({ id: n.id, kind: n.kind, label: n.label, state: n.state, x: n.x, y: n.y, r: n.r })),
        edges: graph.edges.map(e => ({ id: e.id, kind: e.kind, from: e.from, to: e.to, state: e.state, flow: e.flow, label: e.label })),
        conflicts: graph.conflicts.length, counts: { ...graph.counts },
        hover: hover ? hover.id : null, cardShown: !card.hidden, userView, images: images.size,
      };
    },
  };
}

const API = { mount, cardFor, portraitSpec, WORDS, LEGEND, FRAME_MIN_MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.mapDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
