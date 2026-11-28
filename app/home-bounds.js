'use strict';
/**
 * Where Jiandu Home opens (the brief's default: Home remembers its size and place). Pure.
 *
 *   boundsToUse(saved, workAreas) -> { x, y, width, height } | null
 *       The saved bounds, when their title bar is on some screen's work area: at least GRAB_W px across and the top TITLE_H px inside
 *       it, so the window can always be dragged. The size grows to MIN_SIZE and shrinks to that screen. Null (centre at DEFAULT_SIZE)
 *       when nothing was saved, the value is not four strict whole numbers (`Number(null)` is 0), or the screen it was on is gone.
 *   boundsToSave(b) -> { x, y, width, height } | null   the four numbers only.
 */

const DEFAULT_SIZE = Object.freeze({ width: 980, height: 680 });
const MIN_SIZE = Object.freeze({ width: 520, height: 360 });
const GRAB_W = 100;
const TITLE_H = 30;

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isRect = (b) => !!b && typeof b === 'object' && !Array.isArray(b) && isInt(b.x) && isInt(b.y) && isInt(b.width) && isInt(b.height);

function boundsToSave(b) {
  return isRect(b) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

function boundsToUse(saved, workAreas) {
  if (!isRect(saved) || !Array.isArray(workAreas)) return null;
  for (const a of workAreas) {
    if (!isRect(a) || a.width < 1 || a.height < 1) continue;
    const r = {
      x: saved.x, y: saved.y,
      width: Math.min(Math.max(saved.width, MIN_SIZE.width), a.width),
      height: Math.min(Math.max(saved.height, MIN_SIZE.height), a.height),
    };
    if (r.width < MIN_SIZE.width || r.height < MIN_SIZE.height) continue;     // a screen smaller than the minimum
    const across = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x);
    if (across >= GRAB_W && r.y >= a.y && r.y + TITLE_H <= a.y + a.height) return r;
  }
  return null;
}

module.exports = { boundsToUse, boundsToSave, DEFAULT_SIZE, MIN_SIZE };
