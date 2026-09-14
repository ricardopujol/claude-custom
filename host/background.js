'use strict';
/**
 * Per-project background art.
 *
 * Generated ONCE per project folder and reused by every context window on it,
 * so a project is recognisable at a glance before you have read a single word.
 *
 * Procedural SVG rather than a diffusion model, deliberately: the image is
 * dimmed to 10% visibility, which throws away photographic detail by
 * construction. Vector output also costs nothing to store, scales to any window
 * size without resampling, needs no model weights, and is reproducible from the
 * project path alone.
 *
 * The art is seeded from the project path, so the same folder always produces
 * the same image on any machine, with no state to synchronise.
 */

const fs = require('fs');
const path = require('path');

// 90% black, per the requirement: the artwork must sit far enough back that
// light foreground text stays comfortably readable on top of it.
// Was 0.90, which rendered the art effectively invisible in practice -- the
// per-project identity it exists to provide could not be seen at all. 0.72
// keeps light terminal text comfortably readable while the art is actually
// present. Override with CLAUDE_CUSTOM_DIM to taste; 0.85+ is near-invisible,
// below ~0.6 starts to fight the text.
const DIM_OPACITY = Number(process.env.CLAUDE_CUSTOM_DIM) > 0
  ? Number(process.env.CLAUDE_CUSTOM_DIM)
  : 0.72;

const WIDTH = 1600;
const HEIGHT = 1000;

function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic PRNG so one seed reproduces the whole composition.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The filename must be one safe segment: the project path contains separators,
// dots and arbitrary characters that would otherwise escape the directory.
function fileNameFor(projectPath) {
  const norm = normalize(projectPath);
  const slug = (norm.split('/').filter(Boolean).pop() || 'project')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 40) || 'project';
  return `${slug}-${hash32(norm).toString(16).padStart(8, '0')}.svg`;
}

const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

function orbs(rand, baseHue) {
  let out = '';
  const count = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const hue = (baseHue + (rand() - 0.5) * 90 + 360) % 360;
    const cx = rand() * WIDTH;
    const cy = rand() * HEIGHT;
    const r = 180 + rand() * 420;
    out += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" ` +
           `fill="${hsl(hue, 62 + rand() * 24, 42 + rand() * 22)}" opacity="${(0.4 + rand() * 0.45).toFixed(2)}"/>`;
  }
  return out;
}

function ribbons(rand, baseHue) {
  let out = '';
  const count = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const hue = (baseHue + (rand() - 0.5) * 110 + 360) % 360;
    const y = rand() * HEIGHT;
    const amp = 90 + rand() * 220;
    const thickness = 60 + rand() * 180;
    out += `<path d="M -100 ${y.toFixed(0)} ` +
           `C ${(WIDTH * 0.3).toFixed(0)} ${(y - amp).toFixed(0)}, ` +
           `${(WIDTH * 0.7).toFixed(0)} ${(y + amp).toFixed(0)}, ` +
           `${WIDTH + 100} ${(y + (rand() - 0.5) * 300).toFixed(0)}" ` +
           `stroke="${hsl(hue, 66 + rand() * 22, 46 + rand() * 20)}" stroke-width="${thickness.toFixed(0)}" ` +
           `fill="none" opacity="${(0.35 + rand() * 0.4).toFixed(2)}" stroke-linecap="round"/>`;
  }
  return out;
}

function shards(rand, baseHue) {
  let out = '';
  const count = 6 + Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    const hue = (baseHue + (rand() - 0.5) * 80 + 360) % 360;
    const cx = rand() * WIDTH;
    const cy = rand() * HEIGHT;
    const s = 160 + rand() * 420;
    const pts = [];
    const sides = 3 + Math.floor(rand() * 3);
    for (let k = 0; k < sides; k++) {
      const ang = (k / sides) * Math.PI * 2 + rand() * 0.9;
      pts.push(`${(cx + Math.cos(ang) * s).toFixed(0)},${(cy + Math.sin(ang) * s * 0.75).toFixed(0)}`);
    }
    out += `<polygon points="${pts.join(' ')}" fill="${hsl(hue, 58 + rand() * 26, 40 + rand() * 24)}" ` +
           `opacity="${(0.35 + rand() * 0.4).toFixed(2)}"/>`;
  }
  return out;
}

const STYLES = [
  { name: 'orbs', draw: orbs, blur: 90 },
  { name: 'ribbons', draw: ribbons, blur: 70 },
  { name: 'shards', draw: shards, blur: 55 },
];

function renderSvg(projectPath) {
  const seed = hash32(normalize(projectPath));
  const rand = mulberry32(seed);

  const style = STYLES[seed % STYLES.length];
  const baseHue = rand() * 360;
  const bgA = hsl(baseHue, 48, 14);
  const bgB = hsl((baseHue + 60 + rand() * 120) % 360, 52, 8);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}"`,
    ` preserveAspectRatio="xMidYMid slice" data-style="${style.name}" data-seed="${seed}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/>`,
    `</linearGradient>`,
    `<filter id="soft" x="-25%" y="-25%" width="150%" height="150%">`,
    `<feGaussianBlur stdDeviation="${style.blur}"/></filter></defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>`,
    `<g filter="url(#soft)">`,
    style.draw(rand, baseHue),
    `</g>`,
    // MUST be last: SVG paints in document order, so an overlay placed earlier
    // would leave later artwork undimmed and unreadable behind text.
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#000000" opacity="${DIM_OPACITY}"/>`,
    `</svg>`,
  ].join('');
}

function backgroundFor(projectPath, { dir } = {}) {
  if (!dir) throw new Error('backgroundFor: dir is required');
  const file = path.join(dir, fileNameFor(projectPath));

  if (fs.existsSync(file)) return { path: file, created: false };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, renderSvg(projectPath), 'utf8');
  return { path: file, created: true };
}

module.exports = { backgroundFor, renderSvg, fileNameFor, DIM_OPACITY, WIDTH, HEIGHT };
