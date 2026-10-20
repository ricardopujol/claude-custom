'use strict';
/**
 * The tray icon's pixels (BACKLOG #119 A8), drawn in code: no asset to ship, no canvas in the main process, and the badge
 * digit can be any count without a file per count.
 *
 *   renderTrayIcon(badgeText) -> { width, height, bgra }
 *
 * `bgra` is premultiplied BGRA, the order Electron's nativeImage.createFromBitmap takes on Windows (app/main.js's drag icon
 * is built the same way). The base is an accent rounded square with a prompt (`>_`); a non-empty `badgeText` adds a red pill
 * at the bottom right with the text in white (app/tray-model.js badgeText: '1'..'9', '9+'). Edges are anti-aliased by 4x4
 * sampling, so 32 px stays readable when Windows scales it to 16 at 100% DPI.
 *
 * Main-process only (required, never a page <script>).
 */

const SIZE = 32;
const ACCENT = [0xd9, 0x77, 0x57];          // RGB: the app's warm orange
const GLYPH = [0x1b, 0x1b, 0x1f];
const BADGE = [0xe5, 0x48, 0x4d];
const WHITE = [0xff, 0xff, 0xff];
const BADGE_BGRA = Object.freeze([BADGE[2], BADGE[1], BADGE[0], 255]);
const WHITE_BGRA = Object.freeze([255, 255, 255, 255]);

// 3 x 5 glyphs, one string per row.
const FONT = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '001', '010', '010'], 8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'], '+': ['000', '010', '111', '010', '000'],
};
const SCALE = 2;
const GLYPH_W = 3 * SCALE;
const GLYPH_GAP = 2;
const PILL_H = 18;

// --- shapes: coverage tests at a point (pixel space, y down) -----------------------------------------------------------
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const inPrompt = (x, y) =>
  distToSegment(x, y, 8, 9, 15, 16) <= 1.7 || distToSegment(x, y, 15, 16, 8, 23) <= 1.7 ||
  (x >= 17 && x <= 25 && y >= 21.5 && y <= 24.5);

function pillBox(text) {
  const w = Math.min(30, 18 + 6 * (text.length - 1));
  return { x0: SIZE - w, y0: SIZE - PILL_H, x1: SIZE, y1: SIZE };
}

// The pixels of the digits as a Set of "x,y", centred in the pill.
function textPixels(text, box) {
  const glyphs = [...text].filter(ch => FONT[ch]);
  const out = new Set();
  if (!glyphs.length) return out;
  const totalW = glyphs.length * GLYPH_W + (glyphs.length - 1) * GLYPH_GAP;
  let left = Math.round(box.x0 + ((box.x1 - box.x0) - totalW) / 2);
  const top = Math.round(box.y0 + (PILL_H - 5 * SCALE) / 2);
  for (const ch of glyphs) {
    FONT[ch].forEach((row, gy) => {
      for (let gx = 0; gx < 3; gx++) {
        if (row[gx] !== '1') continue;
        for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) out.add(`${left + gx * SCALE + dx},${top + gy * SCALE + dy}`);
      }
    });
    left += GLYPH_W + GLYPH_GAP;
  }
  return out;
}

const SUB = 4;

function renderTrayIcon(badgeText) {
  const text = typeof badgeText === 'string' ? badgeText : '';
  const bgra = Buffer.alloc(SIZE * SIZE * 4);
  const box = text !== '' ? pillBox(text) : null;
  const digits = box ? textPixels(text, box) : null;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Layers, bottom to top, each with its coverage of this pixel; composited "over" in premultiplied space.
      let r = 0, g = 0, b = 0, a = 0;
      const over = (rgb, cov) => {
        if (cov <= 0) return;
        r = rgb[0] * cov + r * (1 - cov); g = rgb[1] * cov + g * (1 - cov); b = rgb[2] * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      };
      const cover = (fn) => {
        let hit = 0;
        for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) if (fn(x + (sx + 0.5) / SUB, y + (sy + 0.5) / SUB)) hit++;
        return hit / (SUB * SUB);
      };
      over(ACCENT, cover((px, py) => inRoundRect(px, py, 0, 0, SIZE, SIZE, 7)));
      over(GLYPH, cover((px, py) => inRoundRect(px, py, 0, 0, SIZE, SIZE, 7) && inPrompt(px, py)));
      if (box) {
        // A 1 px ring in the base colour keeps the pill apart from the square behind it.
        over(ACCENT, cover((px, py) => inRoundRect(px, py, box.x0 - 1, box.y0 - 1, box.x1, box.y1, PILL_H / 2 + 1)));
        over(BADGE, cover((px, py) => inRoundRect(px, py, box.x0, box.y0, box.x1, box.y1, PILL_H / 2)));
        if (digits.has(`${x},${y}`)) over(WHITE, 1);
      }
      const i = (y * SIZE + x) * 4;
      // r,g,b are premultiplied: "over" weights each colour by its coverage and keeps what is below by (1 - coverage).
      bgra[i] = Math.round(b); bgra[i + 1] = Math.round(g); bgra[i + 2] = Math.round(r); bgra[i + 3] = Math.round(a * 255);
    }
  }
  return { width: SIZE, height: SIZE, bgra };
}

module.exports = { renderTrayIcon, SIZE, BADGE_BGRA, WHITE_BGRA };
