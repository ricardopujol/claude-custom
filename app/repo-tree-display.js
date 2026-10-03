'use strict';
/**
 * The Files tab's tree (#45), as data: the rows drawn from the listing, the overlay and the filter. Pure;
 * app/repo-files-panel.js draws what this returns.
 *
 *   rows({ children, expanded, overlay, onlyTouched }) -> Row[]
 *       children  Map<folder, [{ name, path, kind }]>, the folders the host has listed so far ('' = the root)
 *       expanded  Set<folder> the person has opened
 *       overlay   { files: [{ path, tier, edits }], dirs: [{ path, edits, edited, read }] } from the host
 *                 (host/repo-overlay.js), or null before it arrives
 *       Row       { kind: 'dir' | 'file' | 'loading' | 'more', path, name, depth, state, badge, title,
 *                   expanded?, count? }
 *       state     'edited' | 'read' | 'none';  badge  '' or '●N' (N = Claude's edits, summed for a folder)
 *   indexOverlay(overlay) -> { files: Map, dirs: Map }   Maps, so a file named `__proto__` is just a key
 *   overlayNote(overlay, status) -> { text, warn }       the line above the tree
 *
 * "ONLY WHAT CLAUDE TOUCHED" is built from the OVERLAY's files, not filtered out of the listing, so it
 * can neither drop a touched file the listing hasn't loaded yet nor keep an untouched one; the listing and
 * the expanded set are ignored under it. test/repo-tree-display-properties.test.js holds that.
 *
 * ABSENT IS NOT ZERO: before the overlay arrives, or when no transcripts exist, the note says so rather
 * than "Claude hasn't touched any file" (the absence-reported-as-zero this project keeps catching).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoTreeDisplay`.
 */
(function (root) {

const ROW_CAP = 2000;
const DOT = '●';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function indexOverlay(overlay) {
  const files = new Map();
  const dirs = new Map();
  if (overlay && Array.isArray(overlay.files)) for (const f of overlay.files) if (f && typeof f.path === 'string') files.set(f.path, f);
  if (overlay && Array.isArray(overlay.dirs)) for (const d of overlay.dirs) if (d && typeof d.path === 'string') dirs.set(d.path, d);
  return { files, dirs };
}

function fileLook(f) {
  if (!f) return { state: 'none', badge: '', title: '' };
  const edits = isNum(f.edits) ? f.edits : 0;
  if (f.tier === 'edited') {
    return { state: 'edited', badge: edits > 0 ? `${DOT}${edits}` : DOT, title: `edited ${plural(edits, 'time', 'times')} by Claude` };
  }
  if (f.tier === 'read') return { state: 'read', badge: '', title: 'read by Claude' };
  return { state: 'none', badge: '', title: '' };
}

function dirLook(d) {
  if (!d) return { state: 'none', badge: '', title: '' };
  const edits = isNum(d.edits) ? d.edits : 0;
  const edited = isNum(d.edited) ? d.edited : 0;
  const read = isNum(d.read) ? d.read : 0;
  if (edited > 0) return { state: 'edited', badge: `${DOT}${edits}`, title: `${plural(edits, 'edit', 'edits')} in ${plural(edited, 'file', 'files')}${read ? `, ${plural(read, 'more file', 'more files')} read` : ''}` };
  if (read > 0) return { state: 'read', badge: '', title: `${plural(read, 'file', 'files')} read by Claude` };
  return { state: 'none', badge: '', title: '' };
}

const byName = (a, b) => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

// The touched files as a tree of their own: every folder above one, all open, in the listing's order.
function touchedRows(ix) {
  const tree = new Map([['', new Map()]]);
  for (const path of ix.files.keys()) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const full = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;
      if (!tree.has(parent)) tree.set(parent, new Map());
      if (!isFile && !tree.has(full)) tree.set(full, new Map());
      tree.get(parent).set(parts[i], { name: parts[i], path: full, kind: isFile ? 'file' : 'dir' });
    }
  }
  const out = [];
  const walk = (dir, depth) => {
    const all = [...(tree.get(dir) || new Map()).values()];
    for (const e of [...all.filter(x => x.kind === 'dir').sort(byName), ...all.filter(x => x.kind === 'file').sort(byName)]) {
      if (e.kind === 'dir') {
        out.push({ ...e, depth, expanded: true, ...dirLook(ix.dirs.get(e.path)) });
        walk(e.path, depth + 1);
      } else {
        out.push({ ...e, depth, ...fileLook(ix.files.get(e.path)) });
      }
    }
  };
  walk('', 0);
  return out;
}

function listedRows(children, expanded, ix) {
  const out = [];
  const walk = (dir, depth) => {
    const entries = children.get(dir);
    if (!entries) { if (dir !== '') out.push({ kind: 'loading', path: dir, name: '', depth, state: 'none', badge: '', title: '' }); return; }
    for (const e of entries) {
      if (e.kind === 'dir') {
        const open = expanded.has(e.path);
        out.push({ kind: 'dir', path: e.path, name: e.name, depth, expanded: open, ...dirLook(ix.dirs.get(e.path)) });
        if (open) walk(e.path, depth + 1);
      } else {
        out.push({ kind: 'file', path: e.path, name: e.name, depth, ...fileLook(ix.files.get(e.path)) });
      }
    }
  };
  walk('', 0);
  return out;
}

function rows({ children, expanded, overlay, onlyTouched } = {}) {
  const ix = indexOverlay(overlay);
  const all = onlyTouched === true
    ? touchedRows(ix)
    : listedRows(children instanceof Map ? children : new Map(), expanded instanceof Set ? expanded : new Set(), ix);
  if (all.length <= ROW_CAP) return all;
  const cut = all.slice(0, ROW_CAP);
  cut.push({ kind: 'more', path: '', name: '', depth: 0, state: 'none', badge: '', title: '', count: all.length - ROW_CAP });
  return cut;
}

function overlayNote(overlay, status) {
  if (overlay === null || overlay === undefined) return { text: 'reading what Claude touched…', warn: false };
  if (overlay.ok === false) return { text: String(overlay.error || 'the overlay could not be read'), warn: true };
  if (!status || typeof status !== 'object') return { text: "what Claude touched isn't known yet", warn: false };
  const errors = isNum(status.transcriptErrors) ? status.transcriptErrors : 0;
  const unreadable = errors > 0 ? ` · ${plural(errors, 'transcript', 'transcripts')} unreadable, so some files may be missing here` : '';
  if (status.transcriptsMissing === true) {
    return { text: `no transcripts for this worktree yet, so nothing is recorded as touched${unreadable}`, warn: true };
  }
  const ix = indexOverlay(overlay);
  const top = ix.dirs.get('');
  const base = top && (top.edited > 0 || top.read > 0)
    ? `${top.edited} edited · ${top.read} read by Claude`
    : "Claude hasn't touched any file here yet";
  return { text: base + unreadable, warn: errors > 0 };
}

const API = { rows, indexOverlay, overlayNote, ROW_CAP };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoTreeDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
