'use strict';
/**
 * The tab strip's model (PR 2, worktree tabs).
 *
 * Joins the reducer's `state.tabs` (host/tab-lifecycle.js: `{ path, branch,
 * isDev, phase, hostSeen, error? }`) with the shell's RUNTIME facts, and
 * answers the questions the strip asks: what to draw, what a click selects,
 * where Ctrl+Tab goes, what is selected after a close. The shell renders ONLY
 * from `stripModel`.
 *
 * KEYS ARE OPAQUE STRINGS supplied by the caller (main uses `normPath(path)`),
 * through `keyOf(path)` in an options object. Nothing here requires
 * host/project-layout: this file must load in a browser page too.
 *
 * RUNTIME, per key: `{ started, port, token, status }` where `status` is
 * `{ working, needsInput, lock, health }` as that tab's renderer last reported
 * it (app/tab-status.js), or `null` before it reports. `runtime` is a
 * `Map<key, runtime>` or a plain object keyed by key.
 *
 * Absence is never drawn as a value: no status means working/needsInput
 * false and lockGlyph/health null. An unknown lock draws no glyph.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `tabModel`.
 */
(function (root) {

const isString = s => typeof s === 'string';
const identity = p => p;

function baseName(p) {
  if (!isString(p)) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function runtimeOf(runtime, key) {
  if (runtime instanceof Map) return runtime.get(key) || null;
  if (runtime && typeof runtime === 'object' && Object.prototype.hasOwnProperty.call(runtime, key)) {
    return runtime[key] || null;
  }
  return null;
}

function lockStateOf(lock) {
  if (isString(lock)) return lock;
  return lock && isString(lock.state) ? lock.state : null;
}

function glyphFor(lock) {
  const s = lockStateOf(lock);
  if (s === 'override') return 'open';
  if (s === 'unlocked') return 'warn';
  if (s === 'blocked') return 'blocked';
  return null;
}

/**
 * stripModel({ tabs }, runtime, selectedKey, { keyOf }) ->
 *   [{ key, label, isDev, selected, started, closable, working, needsInput,
 *      lockGlyph, health, phase, error }]
 * Dev first (order otherwise as given). Exactly one entry is selected: the one
 * matching `selectedKey`, else dev (else the first entry).
 */
function stripModel(state, runtime, selectedKey, { keyOf = identity } = {}) {
  const tabs = state && Array.isArray(state.tabs) ? state.tabs.filter(t => t && isString(t.path)) : [];
  const devFirst = [...tabs.filter(t => t.isDev === true), ...tabs.filter(t => t.isDev !== true)];
  const keys = devFirst.map(t => keyOf(t.path));
  let selIdx = keys.indexOf(selectedKey);
  if (selIdx < 0) selIdx = devFirst.findIndex(t => t.isDev === true);
  if (selIdx < 0 && devFirst.length) selIdx = 0;
  const single = devFirst.length <= 1;
  return devFirst.map((t, i) => {
    const key = keys[i];
    const rt = runtimeOf(runtime, key);
    const st = rt && rt.status ? rt.status : null;
    return {
      key,
      label: isString(t.branch) && t.branch !== '' ? t.branch : baseName(t.path),
      isDev: t.isDev === true,
      selected: i === selIdx,
      started: !!rt && rt.started === true,
      closable: t.isDev !== true && !single,
      working: !!st && st.working === true,
      needsInput: !!st && st.needsInput === true,
      lockGlyph: st ? glyphFor(st.lock) : null,
      health: st && isString(st.health) && st.health !== '' ? st.health : null,
      phase: isString(t.phase) ? t.phase : null,
      error: t.error === undefined ? null : t.error,
    };
  });
}

const selectedKeyOf = model => {
  const s = model.find(e => e.selected);
  return s ? s.key : null;
};

/** The key if the model has it, else the current selection, unchanged. */
function select(model, key) {
  return model.some(e => e.key === key) ? key : selectedKeyOf(model);
}

/** Ctrl+Tab (+1) / Ctrl+Shift+Tab (-1), wrapping. An unknown key steps from the selection. */
function neighbour(model, key, step) {
  if (model.length === 0) return null;
  let i = model.findIndex(e => e.key === key);
  if (i < 0) i = Math.max(0, model.findIndex(e => e.selected));
  const n = model.length;
  return model[(((i + step) % n) + n) % n].key;
}

/**
 * What is selected after `closedKey` is closed. `model` is the model BEFORE
 * the removal. A closed tab that wasn't selected leaves the selection alone;
 * else the right-hand neighbour, else the left; never the closed key.
 */
function afterClose(model, closedKey, selectedKey) {
  const dev = model.find(e => e.isDev);
  const fallback = () => (model.some(e => e.key === selectedKey && e.key !== closedKey)
    ? selectedKey
    : (dev && dev.key !== closedKey ? dev.key : null));
  if (closedKey !== selectedKey) return fallback();
  const i = model.findIndex(e => e.key === closedKey);
  if (i < 0) return fallback();
  if (i + 1 < model.length) return model[i + 1].key;
  if (i - 1 >= 0) return model[i - 1].key;
  return null;
}

/**
 * The tab a window opens on: the one whose path equals or contains
 * `launchedFrom` (deepest wins), else dev, else the first tab, else null.
 * `isInside(child, parent)` is injected (host/project-layout's, in main).
 */
function initialSelection(tabs, launchedFrom, { keyOf = identity, isInside = () => false } = {}) {
  const list = Array.isArray(tabs) ? tabs.filter(t => t && isString(t.path)) : [];
  const dev = list.find(t => t.isDev === true) || list[0];
  const fallbackKey = dev ? keyOf(dev.path) : null;
  if (!isString(launchedFrom) || launchedFrom === '') return fallbackKey;
  const want = keyOf(launchedFrom);
  const exact = list.find(t => keyOf(t.path) === want);
  if (exact) return keyOf(exact.path);
  const containing = list.filter(t => isInside(launchedFrom, t.path));
  if (containing.length === 0) return fallbackKey;
  containing.sort((a, b) => b.path.length - a.path.length);
  return keyOf(containing[0].path);
}

const api = { stripModel, select, neighbour, afterClose, initialSelection };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabModel = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
