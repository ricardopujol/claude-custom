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
const SIDE_TITLE = 'A side session: it starts in plan mode and has only Read, Grep, Glob, WebFetch, WebSearch and TodoWrite. No Bash, PowerShell, Edit, Write or MCP, whatever mode it is switched to. It ends when this branch\'s tab closes.';
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
    // #81: only readers here (an agent of a read-only side session): shown, but nobody is WORKING in the folder.
    readersOnly: o.readersOnly === true,
    lines: Array.isArray(o.lines) ? o.lines.filter(nonEmpty) : [],
  };
}

/**
 * #63: the CPU warning chip -- `{ pct, level }` when this tab's session tree held over 40% CPU for 30 s, else
 * null. Strict: a percentage that is not a finite number, or a level that is not amber or red, draws nothing.
 */
function resourceWarnOf(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  if (typeof w.pct !== 'number' || !Number.isFinite(w.pct) || w.pct < 0) return null;
  if (w.level !== 'amber' && w.level !== 'red') return null;
  return { pct: Math.round(w.pct), level: w.level };
}

/** `#12 Fix the thing` for a tab's issue, or null: strict, so a malformed record draws nothing. */
function issueLine(i) {
  if (!i || typeof i !== 'object' || Array.isArray(i)) return null;
  if (!Number.isInteger(i.number) || i.number < 1) return null;
  return nonEmpty(i.title) ? `#${i.number} ${i.title}` : `#${i.number}`;
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
  if (occ) cls.push(occ.readersOnly ? 'reading' : (occ.warn ? 'occupied occupied-warn' : 'occupied'));
  // #81: a branch tab's read-only side session: a small tab, no close button of its own (it ends with its branch tab).
  if (entry.side === true) cls.push('side');
  // Backlog #52: a /bedtime night turns the tab deep blue. Distinct from #31's pulse, which still wins while the tab
  // needs you (the pulse animates the background; the night is a still colour).
  const night = entry.night === true;
  if (night) cls.push('night');
  const tab = el(doc, 'div', cls.join(' '));
  tab.dataset.key = entry.key;
  if (entry.startError) tab.title = `${entry.label}: ${entry.startError}`;
  else tab.title = nonEmpty(entry.phaseText) ? `${entry.label}: ${entry.phaseText}` : entry.label;
  if (entry.side === true) tab.title = [tab.title, SIDE_TITLE].join('\n');
  // #119 A6: the GitHub issue this lane was started from (right-click: Open issue).
  const issue = issueLine(entry.issue);
  if (issue) tab.title = [tab.title, issue].join('\n');
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
  const warn = resourceWarnOf(entry.resourceWarn);
  if (warn) {
    tab.appendChild(el(doc, 'span', `res-warn ${warn.level}`, `${warn.pct}%`)).title = 'Over 40% CPU for 30 s. Open Resources for details.';
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
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev && ev.ctrlKey === true) bridge.close(entry.key, true); else bridge.close(entry.key);
    });
  }
  // #77: Ctrl+click closes a merged, safe tab with no confirm (main decides; it asks when it isn't safe).
  tab.addEventListener('click', (ev) => {
    if (entry.closable && ev && ev.ctrlKey === true) bridge.close(entry.key, true);
    else bridge.select(entry.key);
  });
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
  const fresh = phase === 'input' && was !== 'input';
  if (fresh) { input.value = ''; input.focus(); }
  if (phase === 'failed' && was === 'running') input.focus();
  form.dataset.phase = phase;
  form.onsubmit = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    // #119 A6: a branch picked from an issue carries the issue's number, so main writes that issue's brief.
    if (issuePick.number !== null) bridge.create(String(input.value), issuePick.number);
    else bridge.create(String(input.value));
  };
  input.onkeydown = (ev) => {
    if (!ev || ev.key !== 'Escape') return;
    ev.preventDefault();
    bridge.cancelCreate();
  };
  input.oninput = () => { if (String(input.value).trim() === '') issuePick.number = null; };
  const cancel = doc.getElementById('create-cancel');
  if (cancel) cancel.onclick = () => bridge.cancelCreate();
  paintIssues(doc, { create, phase, fresh, input }, bridge);
}

// --- BACKLOG #119 A6: start a lane from a GitHub issue -----------------------------------------
// The form's second way to start. Main answers every question (host/issues.js: the list, the filter, the branch each
// issue makes); this draws it. The list is a panel over the area under the strip: main hides the selected tab's page
// while the shell's `create.picker` is true, because a tab's page is a native view that would cover it.
const issuePick = { number: null };                                  // the issue whose branch is in the field
const issueUi = { seq: 0, reply: null, query: '', wasOpen: false, drawn: undefined, drawnFor: null };   // the last answer, and which ask it answers

function issueRowNode(doc, row, onPick) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'issue-row';
  const parts = [`#${row.number}`, String(row.title)];
  const num = doc.createElement('span');
  num.className = 'issue-num';
  num.textContent = parts[0];
  const title = doc.createElement('span');
  title.className = 'issue-title';
  title.textContent = parts[1];
  b.appendChild(num);
  b.appendChild(title);
  for (const l of Array.isArray(row.labels) ? row.labels : []) {
    const chip = doc.createElement('span');
    chip.className = 'issue-label';
    chip.textContent = String(l);
    b.appendChild(chip);
  }
  const branch = doc.createElement('span');
  branch.className = 'issue-branch';
  branch.textContent = String(row.branch);
  b.appendChild(branch);
  b.title = `${row.branch}`;
  b.onclick = () => onPick(row);
  return b;
}

/** What the row and the panel say for main's last answer. Pure; exported for the test. */
function issuesView(reply) {
  if (!reply || typeof reply !== 'object') return { button: { text: 'From an issue ▾', enabled: true, dim: false, title: 'Pick one of this repo’s open GitHub issues' }, note: 'Loading issues…', rows: [] };
  if (reply.ok !== true) {
    const text = nonEmpty(reply.text) ? reply.text : 'Couldn’t read issues';
    return { button: { text, enabled: false, dim: true, title: text }, note: text, rows: [] };
  }
  const rows = Array.isArray(reply.rows) ? reply.rows : [];
  const total = Number.isInteger(reply.total) ? reply.total : rows.length;
  let note = '';
  if (rows.length === 0) note = total === 0 ? 'No open issues.' : 'No issue matches.';
  return {
    button: { text: 'From an issue ▾', enabled: true, dim: false, title: `${total} open issue${total === 1 ? '' : 's'}` },
    note, rows,
  };
}

function paintIssues(doc, { create, phase, fresh, input }, bridge) {
  const btn = doc.getElementById('create-issues');
  if (!btn || typeof bridge.issues !== 'function') return;
  const panel = doc.getElementById('issues-panel');
  const filter = doc.getElementById('issues-filter');
  const list = doc.getElementById('issues-list');
  const note = doc.getElementById('issues-note');
  const open = !!create && create.picker === true;

  const ask = (query, refresh) => {
    const mine = ++issueUi.seq;
    issueUi.query = query;
    let asked;
    try { asked = Promise.resolve(bridge.issues({ query, refresh })); } catch (err) { asked = Promise.reject(err); }
    asked.then((r) => { if (mine === issueUi.seq) { issueUi.reply = r; draw(); } },
      () => { if (mine === issueUi.seq) { issueUi.reply = { ok: false, text: 'Couldn’t read issues' }; draw(); } });
  };
  const closePicker = () => { if (typeof bridge.pickerClose === 'function') bridge.pickerClose(); input.focus(); };
  const pick = (row) => {
    input.value = String(row.branch);
    issuePick.number = Number.isInteger(row.number) ? row.number : null;
    closePicker();
  };
  function draw() {
    const v = issuesView(issueUi.reply);
    btn.textContent = v.button.text;
    btn.disabled = !v.button.enabled || phase === 'running';
    btn.title = v.button.title;
    btn.className = v.button.dim ? 'dim' : '';
    if (!panel) return;
    // Rebuilt only for a new answer: every poll repaints, and a button replaced under a click would eat the click.
    if (issueUi.drawn === issueUi.reply && issueUi.drawnFor === doc) return;
    issueUi.drawn = issueUi.reply;
    issueUi.drawnFor = doc;
    if (list) list.replaceChildren(...v.rows.map(r => issueRowNode(doc, r, pick)));
    if (note) { note.textContent = v.note; note.hidden = v.note === ''; }
  }

  // A fresh form: nothing carried over, and the repo's issues are read once now (refreshed on open) so the row
  // already says whether a pick is possible.
  if (fresh) {
    issuePick.number = null;
    issueUi.reply = null;
    ask('', true);
  }
  btn.onclick = () => { if (typeof bridge.pickerOpen === 'function') bridge.pickerOpen(); };
  if (panel) {
    panel.hidden = !open;
    if (open && !issueUi.wasOpen) {
      if (filter) { filter.value = ''; filter.focus(); }
      ask('', false);
    }
    if (filter) {
      filter.oninput = () => ask(String(filter.value), false);
      filter.onkeydown = (ev) => {
        if (!ev || ev.key !== 'Escape') return;
        ev.preventDefault();
        closePicker();
      };
    }
    const close = doc.getElementById('issues-close');
    if (close) close.onclick = closePicker;
  }
  issueUi.wasOpen = open;
  draw();
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
 * #rrggbb is accepted: it goes into a style property. `null` means the selected
 * tab hasn't reported one: the strip goes back to its own default accent.
 */
function paintAccent(doc, hex) {
  if (!doc || !doc.documentElement) return false;
  const style = doc.documentElement.style;
  if (hex === null) { style.removeProperty('--accent'); return true; }
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  style.setProperty('--accent', hex);
  return true;
}

/**
 * Lean mode (BACKLOG #62): the ☾ Lean button while normal, and while lean the chip `☾ lean` (+ `bedtime HH:MM` when a
 * night started it) with Back to normal. The state is main's (app/lean-state.js); this only draws it and sends the
 * button's word. The body class stops the working dots' pulse (CSS in tab-strip.html); a tab that NEEDS you keeps its
 * pulse, because a notification is not an animation to save. A missing state is normal: nothing says lean until main does.
 */
function paintLean(doc, state, bridge) {
  const lean = typeof module !== 'undefined' && module.exports ? require('./lean-display') : root.leanDisplay;
  const chip = lean.chip(state);
  const btn = doc.getElementById('lean-btn');
  const box = doc.getElementById('lean-chip');
  if (doc.body && doc.body.classList) doc.body.classList.toggle('lean', chip !== null);
  if (btn) { btn.hidden = chip !== null; btn.onclick = () => bridge.leanSet(true); }
  if (!box) return;
  box.hidden = chip === null;
  const label = doc.getElementById('lean-chip-label');
  const night = doc.getElementById('lean-chip-night');
  const back = doc.getElementById('lean-back');
  if (label) label.textContent = chip ? chip.label : '';
  if (night) { night.textContent = chip && chip.night ? chip.night : ''; night.hidden = !(chip && chip.night); }
  if (back) { back.textContent = chip ? chip.back : ''; back.onclick = () => bridge.leanSet(false); }
}

const LEAN_FACES_MAX = 6;

/**
 * The working agents' portraits next to the lean chip (BACKLOG #62, Ricardo's option C): 18 px round STILL images (app/lean-display.js
 * stillNode), at most six then "+N", the agent's name on hover, only while lean, nothing at all when none work. `faces` is main's set
 * for the whole window (app/lean-faces.js); the DOM is built with createElement and textContent, never innerHTML.
 */
function paintLeanFaces(doc, faces, on) {
  const box = doc.getElementById('lean-faces');
  if (!box) return;
  const list = on === true && Array.isArray(faces) ? faces : [];
  box.hidden = list.length === 0;
  const lean = typeof module !== 'undefined' && module.exports ? require('./lean-display') : root.leanDisplay;
  const pm = typeof module !== 'undefined' && module.exports ? require('./portrait-media-display') : root.portraitMedia;
  const nodes = list.slice(0, LEAN_FACES_MAX).map((f) => {
    const span = doc.createElement('span');
    span.className = 'lean-face';
    span.title = String(f.agent);
    span.appendChild(lean.stillNode(doc, f, pm));
    return span;
  });
  if (list.length > LEAN_FACES_MAX) {
    const more = doc.createElement('span');
    more.className = 'lean-more';
    more.textContent = '+' + (list.length - LEAN_FACES_MAX);
    more.title = `${list.length - LEAN_FACES_MAX} more working`;
    nodes.push(more);
  }
  box.replaceChildren(...nodes);
}

const api = { paneFor, alertFor, resourceWarnOf, issuesView, issueLine, issuePick, paint, paintAccent, paintLean, paintLeanFaces, windowChrome, GLYPHS, LEAN_FACES_MAX };

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
  if (root.strip && typeof root.strip.onLean === 'function') {
    // the state on load; a push that already arrived is not undone by a slower answer
    let pushed = false;
    let faces = [];
    let leanOn = false;
    const take = (state) => {
      paintLean(root.document, state, root.strip);
      leanOn = root.leanDisplay.normalize(state).on;
      paintLeanFaces(root.document, faces, leanOn);
    };
    root.strip.onLean((state) => { pushed = true; take(state); });
    if (typeof root.strip.onLeanFaces === 'function') {
      root.strip.onLeanFaces((list) => { faces = Array.isArray(list) ? list : []; paintLeanFaces(root.document, faces, leanOn); });
    }
    if (typeof root.strip.leanGet === 'function') {
      Promise.resolve(root.strip.leanGet()).then((state) => { if (!pushed) take(state); }, () => {});
    }
  }
  if (root.strip && typeof root.strip.onModel === 'function') {
    root.strip.onModel((payload) => paint(root.document, payload, root.strip));
  }
}

})(typeof window !== 'undefined' ? window : globalThis);
