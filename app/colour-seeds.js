'use strict';
/**
 * The few colours a picture is made of (BACKLOG #34, "Match colours to this
 * background").
 *
 * PURE. The renderer draws the image, or the video's current frame, onto a
 * small canvas and hands the RGBA bytes here; what leaves is up to five #rrggbb
 * strings, NEVER the pixels -- the host that turns them into a look
 * (host/palette-gen.js generateLookFrom) never sees the picture.
 *
 * Clustering is k-means in OKLab, the Cartesian form of the OKLCH that
 * palette-gen works in, so "close" means close to the eye and a dark blue is
 * not merged with a dark red just because their RGB sums agree. It is
 * DETERMINISTIC (farthest-point seeding, fixed iteration count): the same frame
 * gives the same seeds, so a re-roll's variety comes from palette-gen's rng and
 * nowhere else. Slightly more clusters are fitted than asked for, and the
 * biggest kept, so one stray bright pixel cannot take a real colour's place.
 * A cluster under `minShare` of the picture is a speck, not a colour.
 *
 * Transparent pixels are not colours; a picture with none that count has no
 * colours -- an empty answer, never an invented one.
 *
 * WRAPPED IN AN IIFE, and publishes ONE global (`colourSeeds`) -- see
 * app/career-display.js's header for why. Enforced by test/renderer-scope.test.js.
 */

(function (root) {

const MAX_COLOURS = 5;
const EXTRA_CLUSTERS = 2;
const DEFAULT_MIN_SHARE = 0.02;
const ITERATIONS = 10;
const OPAQUE_AT = 128;
// Two points closer than this in OKLab are the same colour for seeding.
const SAME_COLOUR = 1e-4;

const toLinear = (c) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

function toHexByte(lin) {
  const x = Math.min(1, Math.max(0, lin));
  const s = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(s * 255).toString(16).padStart(2, '0');
}

function oklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function readable(rgba) {
  const ok = rgba && typeof rgba === 'object' && (ArrayBuffer.isView(rgba) || Array.isArray(rgba));
  return !!ok && rgba.length > 0 && rgba.length % 4 === 0;
}

/**
 * The dominant colours of an RGBA buffer, biggest first:
 * `[{ hex: '#rrggbb', share }]`, `share` being the fraction of the counted
 * (opaque) pixels it stands for. `count` is clamped to MAX_COLOURS.
 */
function dominantColours(rgba, { count = MAX_COLOURS, minShare = DEFAULT_MIN_SHARE } = {}) {
  if (!readable(rgba)) return [];
  const want = Math.min(MAX_COLOURS, Math.max(0, Math.trunc(Number(count)) || 0));
  if (want === 0) return [];

  const lin = [];
  const lab = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (!(rgba[i + 3] >= OPAQUE_AT)) continue;
    // A plain Array can hold anything; a pixel with a channel that isn't a number is no colour
    // (Dexter D4, PR #91: one NaN made every centroid NaN and the clustering threw).
    if (!Number.isFinite(rgba[i]) || !Number.isFinite(rgba[i + 1]) || !Number.isFinite(rgba[i + 2])) continue;
    const r = toLinear(rgba[i]);
    const g = toLinear(rgba[i + 1]);
    const b = toLinear(rgba[i + 2]);
    lin.push([r, g, b]);
    lab.push(oklab(r, g, b));
  }
  const n = lab.length;
  if (n === 0) return [];

  // Seeding: the first centroid is the point farthest from the mean, each next the point farthest
  // from every one chosen. (The mean itself is never a centroid: a small, vivid minority barely
  // moves it, and a real colour that happened to sit near it would then look like a duplicate.)
  const mean = [0, 0, 0];
  for (const p of lab) { mean[0] += p[0] / n; mean[1] += p[1] / n; mean[2] += p[2] / n; }
  const k = want + EXTRA_CLUSTERS;
  const centroids = [];
  let nearest = lab.map((p) => dist2(p, mean));
  while (centroids.length < k) {
    let far = -1;
    let farD = centroids.length ? SAME_COLOUR : -1;
    for (let i = 0; i < n; i++) if (nearest[i] > farD) { farD = nearest[i]; far = i; }
    if (far < 0) break;
    centroids.push([...lab[far]]);
    if (centroids.length === 1) nearest = lab.map((p) => dist2(p, lab[far]));
    else for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], dist2(lab[i], lab[far]));
  }

  const owner = new Array(n).fill(0);
  for (let it = 0; it < ITERATIONS; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist2(lab[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      owner[i] = best;
    }
    const sum = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sum[owner[i]];
      s[0] += lab[i][0]; s[1] += lab[i][1]; s[2] += lab[i][2]; s[3]++;
    }
    sum.forEach((s, c) => { if (s[3]) centroids[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }

  const acc = centroids.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (let i = 0; i < n; i++) {
    const a = acc[owner[i]];
    a.r += lin[i][0]; a.g += lin[i][1]; a.b += lin[i][2]; a.n++;
  }
  const floor = Number.isFinite(minShare) ? Math.max(0, minShare) : DEFAULT_MIN_SHARE;
  return acc
    .filter((a) => a.n > 0 && a.n / n >= floor)
    .map((a) => ({ hex: '#' + toHexByte(a.r / a.n) + toHexByte(a.g / a.n) + toHexByte(a.b / a.n), share: a.n / n }))
    .sort((x, y) => y.share - x.share || (x.hex < y.hex ? -1 : 1))
    .slice(0, want);
}

/** Just the hex strings, in order: the whole of what the host is told. */
function seedsOf(rgba, opts) {
  return dominantColours(rgba, opts).map((c) => c.hex);
}

const API = { dominantColours, seedsOf, MAX_COLOURS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.colourSeeds = API;

})(typeof window !== 'undefined' ? window : globalThis);
