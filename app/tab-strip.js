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
// PR 3: a merged worktree (finishing, removing, kept), or one that failed to go.
const BADGES = { merged: 'merged', warn: String.fromCodePoint(0x26a0) };
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
const nonEmpty = s => typeof s === 'string' && s !== '';
const objectOr = (o, fallback) => (o && typeof o === 'object' ? o : fallback);

function paneFor(payload) {
  const p = objectOr(payload, {});
  const model = Array.isArray(p.model) ? p.model : [];
  const sel = model.find(e => e && e.selected);
  if (!sel) return { text: nonEmpty(p.notice) ? p.notice : 'No worktrees yet.', retry: null };
  if (sel.started) return null;
  if (sel.starting) return { text: `Starting ${sel.label}…`, retry: null };
  // PR 3: a tab the + made waits for its setup (Contract E) before its session.
  const setup = objectOr(sel.setup, null);
  if (setup && setup.running === true) {
    return { text: `Setting up ${sel.label}…${nonEmpty(setup.line) ? ` ${setup.line}` : ''}`, retry: null };
  }
  const create = objectOr(p.create, null);
  if (create && create.phase === 'running' && create.branch === sel.label) {
    return { text: `Creating ${sel.label}…`, retry: null };
  }
  if (typeof sel.startError === 'string' && sel.startError) {
    return { text: `Couldn't start ${sel.label}: ${sel.startError}`, retry: sel.key };
  }
  return { text: `${sel.label} is not started yet.`, retry: sel.key };
}

/**
 * The one line in the strip itself (the pane below is covered by the selected
 * tab's view): `{ text, kind: 'bad' | 'info' }` or null. A failed stop first
 * (Dexter, PR #75 F3), then the branch form's creation, then what the selected
 * tab's phase says (app/tab-model.js phaseText, computed by the shell).
 */
function alertFor(payload) {
  const p = objectOr(payload, {});
  if (nonEmpty(p.closeNotice)) return { text: p.closeNotice, kind: 'bad' };
  const create = objectOr(p.create, null);
  if (create && create.phase === 'failed' && nonEmpty(create.error)) return { text: create.error, kind: 'bad' };
  if (create && create.phase === 'running') {
    return { text: `Creating ${nonEmpty(create.branch) ? create.branch : 'the worktree'}…`, kind: 'info' };
  }
  const model = Array.isArray(p.model) ? p.model : [];
  const sel = model.find(e => e && e.selected);
  if (sel && nonEmpty(sel.phaseText)) return { text: sel.phaseText, kind: sel.badge === 'warn' ? 'bad' : 'info' };
  return null;
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Worktree occupancy (#44 + #47, take B "hatched edge"): what app/occupancy-display.js tabOccupancy said about
 * this tab, or null. Anything that isn't a usable object with at least one tag is "nobody is here": a
 * malformed model draws nothing rather than a half-mark.
 */
function occupancyOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const tags = Array.isArray(o.tags) ? o.tags.filter(nonEmpty) : [];
  if (tags.length === 0) return null;
  return {
    tags,
    more: Number.isInteger(o.more) && o.more > 0 ? o.more : 0,
    warn: o.warn === true,
    lines: Array.isArray(o.lines) ? o.lines.filter(nonEmpty) : [],
  };
}

function paintTab(doc, entry, bridge) {
  const cls = ['tab'];
  if (entry.selected) cls.push('selected');
  if (!entry.started) cls.push('dim');
  if (entry.isDev) cls.push('dev');
  // #31: the model decides who pulses (never the selected tab); this only names the look.
  if (entry.pulse === 'needs' || entry.pulse === 'done') cls.push(`pulse-${entry.pulse}`);
  // The hatched lower edge. It NEVER animates: movement on the strip means "needs you".
  const occ = occupancyOf(entry.occupancy);
  if (occ) cls.push(occ.warn ? 'occupied occupied-warn' : 'occupied');
  // Backlog #52: a /bedtime night turns the tab deep blue. Distinct from #31's pulse, which still wins while the tab
  // needs you (the pulse animates the background; the night is a still colour).
  const night = entry.night === true;
  if (night) cls.push('night');
  const tab = el(doc, 'div', cls.join(' '));
  tab.dataset.key = entry.key;
  if (entry.startError) tab.title = `${entry.label}: ${entry.startError}`;
  else tab.title = nonEmpty(entry.phaseText) ? `${entry.label}: ${entry.phaseText}` : entry.label;
  // One line per agent under the name, from the model (it has the minutes and the two-writers line).
  if (occ && occ.lines.length) tab.title = [tab.title, ...occ.lines].join('\n');
  // Backlog #39: the local model's "where are we", under every other line. The shell worked the lines out
  // (app/summary-display.js hoverLines, labelled as a local model's); this only draws them.
  const said = Array.isArray(entry.summaryLines) ? entry.summaryLines.filter(nonEmpty) : [];
  if (said.length) tab.title = [tab.title, ...said].join('\n');
  if (entry.working) tab.appendChild(el(doc, 'span', 'dot working')).title = 'Working';
  if (entry.needsInput) tab.appendChild(el(doc, 'span', 'dot needs')).title = 'Needs your input';
  // #40: the person's own mark on the tab; its meaning on hover.
  const mark = entry.mark;
  if (mark && typeof mark === 'object' && nonEmpty(mark.emoji)) {
    tab.appendChild(el(doc, 'span', 'mark', mark.emoji)).title = nonEmpty(mark.meaning) ? mark.meaning : '';
  }
  tab.appendChild(el(doc, 'span', 'label', entry.label));
  if (occ) {
    const tags = tab.appendChild(el(doc, 'span', 'agent-tags'));
    for (const t of occ.tags) tags.appendChild(el(doc, 'span', 'agent-tag', t));
    if (occ.more > 0) tags.appendChild(el(doc, 'span', 'agent-tag', `+${occ.more}`));
  }
  if (night) tab.appendChild(el(doc, 'span', 'moon', '🌙')).title = 'An overnight (/bedtime) run is going in this session';
  if (entry.lockGlyph && GLYPHS[entry.lockGlyph]) {
    const g = tab.appendChild(el(doc, 'span', `glyph ${entry.lockGlyph}`, GLYPHS[entry.lockGlyph]));
    g.title = GLYPH_TITLES[entry.lockGlyph];
  }
  if (entry.health) tab.appendChild(el(doc, 'span', 'health', entry.health));
  if (entry.badge === 'merged' || entry.badge === 'warn') {
    const b = tab.appendChild(el(doc, 'span', `badge ${entry.badge}`, BADGES[entry.badge]));
    if (nonEmpty(entry.phaseText)) b.title = entry.phaseText;
  }
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

// The one piece of state here: whether the ▾ menu is open, so a repaint while
// it is can't free the button early.
let backgroundBusy = false;

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
  // ▾: the running-sessions menu (Windowless sessions PR 2). Busy until main's
  // menu closes -- listing takes ~1-2 s -- and freed even when it fails.
  const bg = doc.getElementById('bg');
  if (bg) {
    bg.disabled = backgroundBusy;
    bg.onclick = () => {
      if (backgroundBusy) return;
      backgroundBusy = true;
      bg.disabled = true;
      const done = () => { backgroundBusy = false; bg.disabled = false; };
      let asked;
      try { asked = Promise.resolve(bridge.background()); } catch (err) { asked = Promise.reject(err); }
      asked.then(done, done);
    };
  }
  // In the STRIP, because the pane below is covered by the selected tab's
  // view. Dexter, PR #75 F3.
  const alertEl = doc.getElementById('strip-alert');
  if (alertEl) {
    const a = alertFor(payload);
    alertEl.textContent = a ? a.text : '';
    alertEl.title = a ? a.text : '';
    alertEl.className = a ? a.kind : '';
    alertEl.hidden = !a;
  }
  paintPlus(doc, payload, bridge);
}

// PR 3: the + (main pops its menu) and the branch form. The form is STATIC in
// tab-strip.html, outside #tabs, and its value is never touched by a repaint
// -- every poll repaints, and Ricardo may be typing -- except when it opens.
function paintPlus(doc, payload, bridge) {
  const p = objectOr(payload, {});
  const plus = doc.getElementById('plus');
  if (plus) {
    plus.hidden = p.mode !== 'tabs';
    plus.onclick = () => bridge.plus();
  }
  const form = doc.getElementById('create');
  const input = doc.getElementById('create-branch');
  if (!form || !input) return;
  const create = p.mode === 'tabs' ? objectOr(p.create, null) : null;
  const phase = create && nonEmpty(create.phase) ? create.phase : '';
  const was = form.dataset.phase || '';
  form.hidden = !create;
  input.disabled = phase === 'running';
  if (phase === 'input' && was !== 'input') { input.value = ''; input.focus(); }
  if (phase === 'failed' && was === 'running') input.focus();
  form.dataset.phase = phase;
  form.onsubmit = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    bridge.create(String(input.value));
  };
  input.onkeydown = (ev) => {
    if (!ev || ev.key !== 'Escape') return;
    ev.preventDefault();
    bridge.cancelCreate();
  };
  const cancel = doc.getElementById('create-cancel');
  if (cancel) cancel.onclick = () => bridge.cancelCreate();
}

/**
 * Layout pass L2 (#28): main loads the strip with `?frameless=1` when this
 * window was created without an OS frame. Then the strip is the title bar: the
 * body class turns on its drag regions, and it draws its own minimise and
 * close. Exactly '1' or nothing: a framed window must never lose its buttons'
 * absence to a stray value. Runs once; the buttons live outside #tabs, so
 * repaints never touch them.
 */
function windowChrome(doc, search, bridge) {
  let frameless = false;
  try { frameless = new URLSearchParams(typeof search === 'string' ? search : '').get('frameless') === '1'; } catch { /* framed */ }
  if (!frameless) return false;
  doc.body.classList.add('frameless');
  const min = doc.getElementById('win-min');
  const close = doc.getElementById('win-close');
  if (min) { min.hidden = false; min.onclick = () => bridge.winMinimize(); }
  if (close) { close.hidden = false; close.onclick = () => bridge.winClose(); }
  return true;
}

/**
 * The accent the person chose (#64). The strip is its own document, so its
 * `--accent` is set here when main pushes the selected tab's accent. Only a
 * #rrggbb is accepted: it goes into a style property.
 */
function paintAccent(doc, hex) {
  if (!doc || !doc.documentElement || typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  doc.documentElement.style.setProperty('--accent', hex);
  return true;
}

const api = { paneFor, alertFor, paint, paintAccent, windowChrome, GLYPHS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabStrip = api;
  if (root.strip && typeof root.strip.winMinimize === 'function') {
    windowChrome(root.document, root.location && root.location.search, root.strip);
  }
  if (root.strip && typeof root.strip.onAccent === 'function') {
    root.strip.onAccent((hex) => paintAccent(root.document, hex));
  }
  if (root.strip && typeof root.strip.onModel === 'function') {
    root.strip.onModel((payload) => paint(root.document, payload, root.strip));
  }
}

})(typeof window !== 'undefined' ? window : globalThis);
