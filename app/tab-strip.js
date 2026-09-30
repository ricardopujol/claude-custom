'use strict';
/**
 * The tab strip's painter (PR 2, worktree tabs). It draws what main pushes
 * (`{ model, selectedKey, notice, mode }`, model = app/tab-model.js's
 * stripModel plus `starting` / `startError`) and reports clicks. It holds no
 * state of its own and decides nothing; the pane text is the one pure function
 * here (`paneFor`), exported so a test can pin it.
 *
 * Labels are branch names -- somebody else's strings -- so everything goes in
 * with textContent, never innerHTML.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js); this page has its
 * own scope, but the habit costs nothing. One name leaves it: `tabStrip`.
 */
(function (root) {

const GLYPHS = {
  open: String.fromCodePoint(0x1f513),      // open padlock: a second session, on purpose
  warn: String.fromCodePoint(0x26a0),       // warning sign: no lock could be taken
  blocked: String.fromCodePoint(0x1f512),   // padlock: another session holds the worktree
};
const GLYPH_TITLES = {
  open: 'Second session in this worktree (lock overridden, not saved)',
  warn: 'No session lock: a second window on this worktree would not be stopped',
  blocked: 'Another session is running in this worktree',
};

/**
 * What the area under the strip says while the selected tab has no page of its
 * own yet: null when the tab's view covers it. `retry` names the tab to
 * re-select (selecting a failed tab starts it again).
 */
function paneFor(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const model = Array.isArray(p.model) ? p.model : [];
  const sel = model.find(e => e && e.selected);
  if (!sel) return { text: typeof p.notice === 'string' && p.notice ? p.notice : 'No worktrees yet.', retry: null };
  if (sel.started) return null;
  if (sel.starting) return { text: `Starting ${sel.label}…`, retry: null };
  if (typeof sel.startError === 'string' && sel.startError) {
    return { text: `Couldn't start ${sel.label}: ${sel.startError}`, retry: sel.key };
  }
  return { text: `${sel.label} is not started yet.`, retry: sel.key };
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function paintTab(doc, entry, bridge) {
  const cls = ['tab'];
  if (entry.selected) cls.push('selected');
  if (!entry.started) cls.push('dim');
  if (entry.isDev) cls.push('dev');
  const tab = el(doc, 'div', cls.join(' '));
  tab.dataset.key = entry.key;
  tab.title = entry.startError ? `${entry.label}: ${entry.startError}` : entry.label;
  if (entry.working) tab.appendChild(el(doc, 'span', 'dot working')).title = 'Working';
  if (entry.needsInput) tab.appendChild(el(doc, 'span', 'dot needs')).title = 'Needs your input';
  tab.appendChild(el(doc, 'span', 'label', entry.label));
  if (entry.lockGlyph && GLYPHS[entry.lockGlyph]) {
    const g = tab.appendChild(el(doc, 'span', `glyph ${entry.lockGlyph}`, GLYPHS[entry.lockGlyph]));
    g.title = GLYPH_TITLES[entry.lockGlyph];
  }
  if (entry.health) tab.appendChild(el(doc, 'span', 'health', entry.health));
  if (entry.closable) {
    const x = tab.appendChild(el(doc, 'button', 'x', '×'));
    x.type = 'button';
    x.title = 'Close tab (ends its session; the folder stays)';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); bridge.close(entry.key); });
  }
  tab.addEventListener('click', () => bridge.select(entry.key));
  tab.addEventListener('contextmenu', (ev) => { ev.preventDefault(); bridge.contextMenu(entry.key); });
  return tab;
}

/** Paint `payload` into the page. Everything is rebuilt: the strip is small. */
function paint(doc, payload, bridge) {
  const tabs = doc.getElementById('tabs');
  const pane = doc.getElementById('pane');
  const model = payload && Array.isArray(payload.model) ? payload.model : [];
  tabs.replaceChildren(...model.map(e => paintTab(doc, e, bridge)));
  const info = paneFor(payload);
  pane.hidden = info === null;
  const text = doc.getElementById('pane-text');
  const retry = doc.getElementById('pane-retry');
  text.textContent = info ? info.text : '';
  retry.hidden = !(info && info.retry);
  retry.onclick = info && info.retry ? () => bridge.select(info.retry) : null;
}

const api = { paneFor, paint, GLYPHS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabStrip = api;
  if (root.strip && typeof root.strip.onModel === 'function') {
    root.strip.onModel((payload) => paint(root.document, payload, root.strip));
  }
}

})(typeof window !== 'undefined' ? window : globalThis);
