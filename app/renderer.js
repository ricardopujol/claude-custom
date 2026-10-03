'use strict';
/**
 * claude-custom :: renderer  (SPIKE — step 0 walking skeleton)
 *
 * A pure view over the host's pty. Holds no session state.
 *
 * The diagnostics panel exists because the spike's job is to VERIFY, not to
 * look finished: it shows the exact bytes each keypress puts on the wire, which
 * is the difference between "Shift+Tab seems to work" and knowing it sends
 * CSI Z.
 */

const params = new URLSearchParams(location.search);
const PORT = params.get('port') || '7681';
const CWD = params.get('cwd') || '';
const PROJECT = params.get('project') || '';
// Where this page lives (PR 2, worktree tabs), added by app/main.js: 'tab' (a
// worktree tab), 'dev' (the main checkout: no close), 'single' (a one-tab
// window). Absent for a page opened any other way.
const TABMODE = params.get('tabmode') || '';

document.getElementById('cwd').textContent = CWD;

// FF21: "project/branch" in the top-left, replacing the static "claude-custom"
// label. `currentProjectName` paints immediately from the window's own query
// params (same source as the OS window title) so there is never a blank
// header before the host answers, then follows `hello.project` -- NOT held
// fixed at the query param, since a project switch (see the `projects`
// message / `cwd` update just above) changes the host this window is
// attached to and must relabel the header too, not just the cwd line under
// it. `branch` arrives the same way and also updates live off host.js's
// `branch` broadcasts. No project name at all (should not happen once a
// window has a cwd) falls back to the original static label.
let currentProjectName = PROJECT;
let currentBranchName = null;
function renderTitle() {
  const el = document.getElementById('title');
  if (!el) return;
  const project = currentProjectName || 'claude-custom';
  el.textContent = currentBranchName ? `${project}/${currentBranchName}` : project;
}
renderTitle();

// --- worktree status (Extension X1/X4, PR 1b) --------------------------------
// The session lock's overlay and header badge, other live claude sessions in
// this worktree, and branch health. Every decision is in
// app/worktree-status-display.js; this only paints what it returns.
let dismissedTerminalKey = null;   // the banner stays dismissed for this set of sessions only
let tabLock = null;      // the last lock message, for the tab status and Go to that session
function renderLock(lock) {
  tabLock = lock || null;
  const overlay = worktreeStatus.lockOverlay(lock, Date.now(), { tabmode: TABMODE });
  const el = document.getElementById('lock-overlay');
  el.hidden = !overlay;
  if (overlay) {
    document.getElementById('lock-overlay-title').textContent = overlay.title;
    document.getElementById('lock-overlay-detail').textContent = overlay.detail;
    document.getElementById('lock-open-anyway').hidden = !overlay.canOverride;
    // Only where there is a shell to ask (a plain page has no harness bridge).
    document.getElementById('lock-go-to').hidden = !(overlay.canGoTo && window.harness && window.harness.goToSession);
    document.getElementById('lock-stop').hidden = !overlay.canStop;
    disarmStop();
    const close = document.getElementById('lock-close');
    close.hidden = overlay.closeLabel === null;
    if (overlay.closeLabel !== null) close.textContent = overlay.closeLabel;
  }
  document.getElementById('lock-goto-note').textContent = '';
  const badge = worktreeStatus.lockBadge(lock);
  const b = document.getElementById('wt-lock');
  b.hidden = !badge;
  b.textContent = badge ? badge.text : '';
  b.title = badge ? badge.title : '';
  reportTabStatus();
}
function renderTerminalSessions(result) {
  const banner = worktreeStatus.terminalBanner(result);
  const el = document.getElementById('terminal-banner');
  const show = Boolean(banner) && banner.key !== dismissedTerminalKey;
  el.hidden = !show;
  el.dataset.key = banner ? banner.key : '';
  document.getElementById('terminal-banner-text').textContent = show ? banner.text : '';
}
let tabHealth = null;    // the last health message, for the tab status
function renderBranchHealth(health) {
  tabHealth = health || null;
  const m = worktreeStatus.healthMarker(health);
  const el = document.getElementById('wt-health');
  el.hidden = !m;
  el.textContent = m ? m.text : '';
  el.title = m ? m.title : '';
  el.className = m ? `wt-health ${m.cls}` : 'wt-health';
  reportTabStatus();
}
document.getElementById('lock-open-anyway').addEventListener('click', () => {
  send(JSON.stringify({ type: 'lock-override' }));
});
// *Stop that session* takes two clicks (Dexter, PR #76 F3; Miguel I4): the
// first says what stopping ends -- an agent mid-task, Remote Control -- and the
// second asks the host, sending the holder this pane SHOWED (Dexter F6). The
// host proves it, refuses one with a window open, and answers with a
// `lock-note`. A repaint of the pane disarms it.
const STOP_CONFIRM_MS = 8000;
const stopButton = document.getElementById('lock-stop');
let stopArmedUntil = 0;
function disarmStop() {
  stopArmedUntil = 0;
  stopButton.textContent = 'Stop that session';
  stopButton.disabled = false;
}
stopButton.addEventListener('click', () => {
  const note = document.getElementById('lock-goto-note');
  if (!tabLock || !tabLock.holder) return;
  if (Date.now() > stopArmedUntil) {
    stopArmedUntil = Date.now() + STOP_CONFIRM_MS;
    stopButton.textContent = 'Click again to stop it';
    note.textContent = worktreeStatus.stopWarning(tabLock.holder);
    return;
  }
  stopArmedUntil = 0;
  stopButton.disabled = true;
  stopButton.textContent = 'Stopping...';
  note.textContent = 'Stopping that session...';
  send(JSON.stringify({
    type: 'lock-stop-holder',
    holder: { pid: tabLock.holder.pid, startedAt: tabLock.holder.startedAt },
  }));
});
// In a shell (a tab, or a single-tab window) window.close() would only tear down
// THIS page, not end anything: main decides what closing means. A plain page
// has no bridge and keeps today's window.close().
document.getElementById('lock-close').addEventListener('click', () => {
  if (window.harness && window.harness.closeTab) window.harness.closeTab();
  else window.close();
});
// *Go to that session*: main plans it (select the tab, raise another window,
// or explain), and an explanation is shown under the buttons.
document.getElementById('lock-go-to').addEventListener('click', async () => {
  const note = document.getElementById('lock-goto-note');
  note.textContent = '';
  if (!(window.harness && window.harness.goToSession) || !tabLock || !tabLock.holder) return;
  try {
    const r = await window.harness.goToSession(tabLock.holder);
    if (r && r.kind === 'explain' && typeof r.text === 'string') note.textContent = r.text;
  } catch (err) {
    note.textContent = 'Could not reach that session.';
  }
});

// What this tab tells the shell about itself (PR 2): working, needs input, lock,
// health. tab-status.js decides; this only sends it when it changed.
let tabPendingUrgent = false;
let tabPendingFinished = false;   // #31: the session finished and nobody has looked yet
let lastReportedTabStatus = null;
function reportTabStatus() {
  if (!(window.harness && window.harness.tabStatus && window.tabStatus)) return;
  const anyWorking = typeof roster !== 'undefined' && [...roster.values()].some(r => r && r.state === 'working');
  const status = window.tabStatus.tabStatus({
    mainMood: anyWorking ? 'working' : null,
    pendingUrgent: tabPendingUrgent,
    pendingFinished: tabPendingFinished,
    lock: tabLock,
    health: tabHealth,
  }, { healthMarker: worktreeStatus.healthMarker });
  if (lastReportedTabStatus && window.tabStatus.sameStatus(lastReportedTabStatus, status)) return;
  lastReportedTabStatus = status;
  window.harness.tabStatus(status);
}
if (window.harness && window.harness.onTabSelected) {
  // Looked at: whatever was waiting for you has been seen.
  window.harness.onTabSelected(() => { tabPendingUrgent = false; tabPendingFinished = false; reportTabStatus(); });
}
if (window.harness && window.harness.onLockOverride) {
  // The shell's menu item is the same switch as the button, not a second one.
  window.harness.onLockOverride(() => document.getElementById('lock-open-anyway').click());
}
document.getElementById('terminal-banner-dismiss').addEventListener('click', () => {
  const el = document.getElementById('terminal-banner');
  dismissedTerminalKey = el.dataset.key || null;
  el.hidden = true;
});

// --- terminal ---------------------------------------------------------------
const term = new Terminal({
  allowProposedApi: true,          // required by the unicode11 addon
  cursorBlink: true,
  fontFamily: '"Cascadia Mono", "CaskaydiaCove Nerd Font", Consolas, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  scrollback: 10000,
  // Theme is hardcoded for the spike; step 3 drives this from the theme registry.
  theme: {
    background: '#11131a',
    foreground: '#c7cede',
    cursor: '#d08c4a',
    selectionBackground: '#2d3446',
  },
  // Claude Code prints its links as OSC 8 hyperlinks. xterm's default handler
  // confirm()s, then window.open()s a BLANK page and fills the address in
  // afterwards -- main only ever saw `about:blank`, and Windows said no app
  // opens it (fix/terminal-links, 2026-10-01). Main opens it instead, http(s)
  // only, in the default browser, on a plain click; hovering shows the REAL
  // address first, since a link's text can name another site (Ricardo's
  // choice, PR #81 Dexter F1).
  linkHandler: {
    activate: (event, uri) => openTerminalLink(event, uri),
    hover: (_event, uri) => showLinkTarget(linkClick.targetText(uri)),
    leave: () => showLinkTarget(null),
  },
});

// xterm calls `activate` on EVERY mouseup over a link: linkClick decides which
// one is a click that opens it (PR #81 Dexter F2).
let lastLinkOpened = null;
function openTerminalLink(event, uri) {
  const r = linkClick.shouldOpen(event, uri, lastLinkOpened, Date.now());
  lastLinkOpened = r.last;
  if (!r.open || !window.harness || typeof window.harness.openExternal !== 'function') return;
  Promise.resolve(window.harness.openExternal(uri)).then((opened) => {
    if (opened === false) flashLinkTarget(linkClick.refusedText(uri));
  }, () => {});
}

// The line under the terminal that says where a link goes (or that it wasn't opened).
let linkTargetTimer = null;
function showLinkTarget(text) {
  const el = document.getElementById('link-target');
  clearTimeout(linkTargetTimer);
  el.textContent = text || '';
  el.hidden = !text;
}
function flashLinkTarget(text) {
  showLinkTarget(text);
  linkTargetTimer = setTimeout(() => showLinkTarget(null), 4000);
}

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

// CRITICAL: Ink positions its box-drawing by computed character width. xterm's
// default Unicode 6 width table measures emoji differently from Unicode 11,
// which shreds the TUI in ways that look like "this wrapper is janky".
// Loading the addon is not enough — activeVersion must actually be set.
const unicode11 = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode11);
term.unicode.activeVersion = '11';

term.open(document.getElementById('term'));

// WebGL is a big perf win on heavy output but can fail on some drivers; the
// canvas fallback is fine, so never let it take the app down.
let webglAddon = null;
try {
  webglAddon = new WebglAddon.WebglAddon();
  webglAddon.onContextLoss(() => webglAddon.dispose());
  term.loadAddon(webglAddon);
} catch (e) {
  console.warn('[renderer] WebGL addon unavailable, using fallback:', e.message);
}

fit.fit();

// --- diagnostics ------------------------------------------------------------
const CHECKS = [
  { id: 'shiftTab',   label: 'Shift+Tab  (permission modes)' },
  { id: 'shiftEnter', label: 'Shift+Enter (newline)' },
  { id: 'esc',        label: 'Esc (interrupt)' },
  { id: 'ctrlC',      label: 'Ctrl+C' },
  { id: 'ctrlR',      label: 'Ctrl+R' },
  { id: 'paste',      label: 'Bracketed paste' },
];
const hit = new Set();

const checksEl = document.getElementById('checks');
function renderChecks() {
  checksEl.innerHTML = CHECKS.map(
    (c) =>
      `<div class="${hit.has(c.id) ? 'hit' : ''}">` +
      `<span class="mark">${hit.has(c.id) ? '✓' : '·'}</span>${c.label}</div>`
  ).join('');
}
renderChecks();

const logEl = document.getElementById('log');
function logLine(keyDesc, bytes) {
  const pretty = bytes
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0x1b) return '\\x1b';
      if (code === 0x0d) return '\\r';
      if (code === 0x0a) return '\\n';
      if (code === 0x09) return '\\t';
      if (code < 0x20) return '\\x' + code.toString(16).padStart(2, '0');
      return ch;
    })
    .join('');
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    `<span class="k">${keyDesc}</span> <span class="n">&rarr;</span> ` +
    `<span class="b">${pretty || '<nothing>'}</span>`;
  logEl.prepend(row);
  while (logEl.children.length > 120) logEl.removeChild(logEl.lastChild);
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    document.getElementById('diag').classList.toggle('show');
    // The pane takes width from the zones' room: re-fit them too, or two side
    // zones squeeze the terminal under its minimum (PR #82 Dexter F6).
    // renderLayout refits the terminal and resizes the pty itself.
    renderLayout();
    e.preventDefault();
  }
  // NOTE: Ctrl+B is handled inside term.attachCustomKeyEventHandler, not here.
  // A document listener never receives it -- xterm's textarea has focus and
  // consumes the key first. This comment is left as the signpost.
});

// --- fog of war ---
// A closed whitelist: the tier decides a CSS class, so it must never be
// interpolated straight from host data even though it is an enum today.
const TIER_CLASS = { edited: 'edited', read: 'read', dark: 'dark' };
const FOG_ROW_CAP = 600;
// ----------------------------------------------------------
// Asked for on demand, never pushed: a cold read is ~175ms of synchronous work
// in the host, and the host's event loop is what delivers hook events.
function requestFog() {
  const list = document.getElementById('fog-list');
  if (!list.dataset.loaded) document.getElementById('fog-summary').textContent = 'reading the map…';
  // Silently dropped if the socket is not open yet; ws.onopen asks again. A
  // swallowed throw here is what left the panel reading "reading the map…"
  // forever, which looks like a slow host rather than a lost message.
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type: 'fog' })); } catch {}
}

// --- the git tree (layout pass L3, documentation/PLAN_GIT_TREE.md) -------------
// Asked for when the panel opens, on reconnect, and every 30s while it's showing:
// branches and spend move while you work. The host shares one read between
// overlapping asks, so a re-ask during a slow first read costs nothing.
const GIT_TREE_EVERY_MS = 30 * 1000;
function requestGitTree() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type: 'git-tree' })); } catch {}
}
setInterval(() => {
  if (shownModules.has('git') && document.visibilityState === 'visible') requestGitTree();
}, GIT_TREE_EVERY_MS);
// Back from hidden: ask now, not up to 30s later with an old tree on screen (PR #85 Dexter F9).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && shownModules.has('git')) requestGitTree();
});
let lastGitTree = null;
function renderGitTree(tree) {
  lastGitTree = tree;
  window.gitRingsDisplay.render(document.getElementById('git-body'), tree, {
    onJump: folder => window.harness.selectFolder(folder),
  });
}

// --- the project picker ------------------------------------------------------
// Asked for on demand for the same reason the fog is: the host reads every
// transcript under ~/.claude/projects to answer, and the host's event loop is
// what delivers hook events.
function requestProjects() {
  // Logged either way, for the reason the attention path logs a suppressed
  // toast: "we never asked" and "the answer never came" are the same silence in
  // the panel, and telling them apart is what this line buys.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('[renderer] projects: socket not open, deferring to ws.onopen');
    return;
  }
  try {
    ws.send(JSON.stringify({ type: 'projects' }));
    console.log('[renderer] projects: asked');
  } catch (e) {
    console.warn('[renderer] projects: send failed:', e.message);
  }
}

function renderProjects(msg) {
  console.log('[renderer] projects: received', (msg.projects || []).length, 'ok=' + msg.ok);
  const list = document.getElementById('projects-list');
  const note = document.getElementById('projects-note');
  // An error from the host is about THIS action failing, not about the history.
  // `display` is reset explicitly: a successful render with no note leaves the
  // element at display:none, so writing into it would show the user NOTHING --
  // the panel's one error surface, silent. It happened to work only because
  // the click handler set display='' two lines before sending, i.e. correct by
  // a side effect in a different function (Miguel). That is the failure class
  // this whole PR is about, so it should not be load-bearing here.
  if (msg.error) {
    note.textContent = msg.error;
    note.style.display = '';
    return;
  }

  const { rows, note: text } = projectsDisplay(msg);
  note.textContent = text;
  note.style.display = text ? '' : 'none';

  list.innerHTML = rows.map(r =>
    `<div class="proj${r.current ? ' current' : ''}` +
    `${r.openable ? ' proj-open' : ''}${r.approximate ? ' proj-approx' : ''}"` +
    `${r.openable ? ` data-open="${escapeHtml(r.path)}"` : ''}` +
    ` title="${escapeHtml(r.title)}">` +
    `<div class="proj-name">${escapeHtml(r.name)}</div>` +
    (r.detail ? `<div class="proj-detail">${escapeHtml(r.detail)}</div>` : '') +
    '</div>').join('');
}

// Delegated, so rows re-rendered later stay clickable without rebinding.
document.getElementById('projects-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-open]');
  if (!row || !ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type: 'open', path: row.dataset.open })); } catch {}
  // Said out loud: the new window is a separate process that takes a moment to
  // appear, and a click with no feedback reads as a dead button.
  document.getElementById('projects-note').textContent = 'opening a window…';
  document.getElementById('projects-note').style.display = '';
});

function renderFog(fog) {
  const list = document.getElementById('fog-list');
  const summary = document.getElementById('fog-summary');
  const files = fog.files || [];
  const status = fog.status || {};
  list.dataset.loaded = '1';

  // STATUS FIRST. Every failure in this feature otherwise renders as a
  // confident map, and one of them ("git unavailable") renders as PERFECT
  // coverage with zero blind spots -- the feature lying in the exact direction
  // that makes you stop looking. A partial map that says what it is missing is
  // usable; a complete-looking wrong one is worse than no map.
  const warnings = [];
  if (status.failed) warnings.push(`the map could not be read: ${escapeHtml(status.error || 'unknown error')}`);
  if (status.transcriptsMissing) warnings.push('no transcripts for this project — nothing has been recorded here yet');
  if (status.transcriptErrors) warnings.push(`${status.transcriptErrors} transcript(s) unreadable — those files may show as unexplored`);
  if (!status.trackedOk && !status.failed) {
    warnings.push('file list unavailable (not a git repo?) — <b>never-opened files are NOT counted</b>');
  }

  if (!files.length) {
    summary.innerHTML = warnings.length
      ? warnings.map(w => `<span class="fog-warn">${w}</span>`).join('<br>')
      : 'nothing read yet — the whole project is dark.';
    list.innerHTML = '';
    return;
  }

  const dark = files.filter(f => f.tier === 'dark').length;
  const edited = files.filter(f => f.tier === 'edited').length;
  // The host already computed these against the project; recomputing them here
  // would be a second definition of one number, free to drift from the first.
  const explored = Number.isFinite(fog.explored) ? fog.explored : files.length - dark;
  const total = Number.isFinite(fog.total) ? fog.total : files.length;

  summary.innerHTML =
    `<b>${explored}</b> of <b>${total}</b> files explored · <b>${edited}</b> edited · ` +
    `<span class="dark-count">${dark} never opened</span>` +
    warnings.map(w => `<br><span class="fog-warn">${w}</span>`).join('');

  // Capped. One innerHTML string with a div per file is a multi-second layout
  // freeze on a large repo, and nobody reads the 3000th row.
  const shown = files.slice(0, FOG_ROW_CAP);
  list.innerHTML = shown.map(f => {
    // Brightness is applied per row rather than bucketed into classes: the
    // decay is continuous, and three shades would discard the signal.
    const dim = f.tier === 'dark' ? '' : `style="opacity:${(0.35 + f.brightness * 0.65).toFixed(2)}"`;
    const count = f.touches ? `<span class="n">${f.touches}</span>` : '';
    const tier = TIER_CLASS[f.tier] || 'dark';
    return `<div class="fog-row ${tier}" ${dim} title="${escapeHtml(f.path)}">` +
           `<span class="name"><bdi>${escapeHtml(f.path)}</bdi></span>${count}</div>`;
  }).join('');

  if (files.length > shown.length) {
    list.innerHTML += `<div class="fog-more">+${files.length - shown.length} more</div>`;
  }
}

// --- bug vault ----------------------------------------------------------------
// Pushed by the host in `hello` and again after every add/setFixed, never
// pulled: the vault is a small JSON file, unlike fog's ~175ms git walk, so
// there is no cost to defer by waiting for the tab to be opened.
//
// Every drawing decision lives in app/bugvault-display.js, not here -- same
// reason usage and career figures were pulled out: a decision inline in this
// file is a decision nothing can unit-test, and this project's CLAUDE.md
// records two PRs rejected for exactly that.
function renderBugVault(payload) {
  const d = window.bugVaultDisplay(payload);
  const summaryEl = document.getElementById('bugvault-summary');
  const groupsEl = document.getElementById('bugvault-groups');
  const detectEl = document.getElementById('bugvault-detection');
  const listEl = document.getElementById('bugvault-list');
  if (!summaryEl || !groupsEl || !detectEl || !listEl) return;

  if (d.state === 'reading') {
    summaryEl.textContent = 'reading the vault…';
    groupsEl.innerHTML = '';
    detectEl.innerHTML = '';
    listEl.innerHTML = '';
    return;
  }

  // The vault is on disk and could not be read. Drawn as a WARNING, never as
  // an empty list: the records are still there, the host is refusing to write
  // over them, and the only thing that helps is a person opening the file.
  if (d.state === 'unreadable') {
    summaryEl.innerHTML = '<b class="vault-warn">the bug vault could not be read</b>';
    groupsEl.innerHTML = '';
    detectEl.innerHTML = `<div class="vault-warn-detail">${escapeHtml(d.error || '')}` +
      '<br>Nothing has been written over it. Open the file to see what is there.</div>';
    listEl.innerHTML = '';
    return;
  }

  if (d.state === 'empty') {
    summaryEl.innerHTML = 'no bugs recorded yet — add one below.';
  } else if (d.state === 'ready') {
    summaryEl.innerHTML = `<b>${d.total}</b> bug class${d.total === 1 ? '' : 'es'} recorded — ` +
      `<b>${d.unfixed}</b> open, <b>${d.fixed}</b> fixed`;
  } else {
    // Named states only. This was a ternary whose else-branch caught
    // EVERYTHING that was not `empty`, so a state added to the display module
    // would have been drawn as a healthy count -- which is how `unreadable`
    // would have rendered as "0 bug classes recorded" if it had slipped in
    // without this branch. Same fail-open shape as the vault dispatcher in F4.
    summaryEl.textContent = 'the vault is in a state this panel does not know how to draw.';
    groupsEl.innerHTML = '';
    detectEl.innerHTML = '';
    listEl.innerHTML = '';
    return;
  }

  // RECURRING CLASSES, biggest first. The host ranked them (groupByCategory)
  // and this draws that order verbatim -- re-sorting here would be the second,
  // divergent copy of an algorithm the display module's header explicitly
  // refuses to grow. The bar is proportional to the largest group, so one
  // class pulling away from the rest is visible without reading the numbers,
  // which is what "recurring" means in the PR title.
  groupsEl.innerHTML = d.groups.length
    ? '<h3>Recurring classes</h3>' + d.groups.map(g =>
        `<div class="grp" title="${escapeHtml(g.category)}">` +
        `<span class="grp-name">${escapeHtml(g.category)}</span>` +
        `<span class="grp-bar" style="width:${g.bar}%"></span>` +
        `<span class="grp-count">${g.total}</span>` +
        (g.openLabel ? `<span class="grp-open">(${escapeHtml(g.openLabel)})</span>` : '') +
        '</div>').join('')
    : '';

  // The breakdown that makes "found by measurement, none by reading" a fact
  // rather than a feeling -- the whole reason the design doc asks for this.
  detectEl.innerHTML = d.detection.length
    ? '<h3>Found by</h3>' + d.detection.map(r =>
        `<div class="det"><span class="det-label">${escapeHtml(r.label)}</span>` +
        `<span class="det-count">${r.count}</span></div>`).join('')
    : '';

  listEl.innerHTML = d.rows.length ? d.rows.map(r => `
    <div class="bug-row ${r.statusLabel}" data-id="${escapeHtml(r.id || '')}">
      <div class="bug-head">
        <span class="bug-icon">${r.icon}</span>
        <span class="bug-cat" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</span>
        <button class="bug-toggle" data-fixed="${r.statusLabel === 'fixed' ? '1' : '0'}">
          ${r.statusLabel === 'fixed' ? 'reopen' : 'mark fixed'}</button>
      </div>
      <div class="bug-summary">${escapeHtml(r.summary)}</div>
      <div class="bug-detail">
        <span>where: ${escapeHtml(r.whereFound)}</span>
        <span>found by: ${escapeHtml(r.detectedBy)}</span>
        <span>survived: ${escapeHtml(r.survived)}</span>
        <span>would have caught it sooner: ${escapeHtml(r.wouldHaveCaught)}</span>
      </div>
    </div>`).join('') : '<div class="none">no bugs recorded yet.</div>';
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('.bug-toggle');
  if (!button) return;
  const row = button.closest('.bug-row');
  const id = row && row.dataset.id;
  if (!id || !ws || ws.readyState !== WebSocket.OPEN) return;
  const fixed = button.dataset.fixed !== '1';   // toggling TO the opposite state
  try { ws.send(JSON.stringify({ type: 'bugvault', action: 'setFixed', id, fixed })); } catch {}
});

document.getElementById('bugvault-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (id) => document.getElementById(id).value.trim();
  const record = {
    category: val('bugvault-category'),
    summary: val('bugvault-summary-input'),
    whereFound: val('bugvault-where'),
    detectedBy: val('bugvault-detected'),
    survived: val('bugvault-survived'),
    wouldHaveCaught: val('bugvault-caught'),
  };
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'bugvault', action: 'add', record })); } catch {}
  }
  e.target.reset();
});

// --- vault ------------------------------------------------------------------
// An isolated panel. Nothing in it is ever written to the pty: the secret only
// ever travels renderer -> main -> OS clipboard, and the host that owns the
// terminal never sees it. Pasting is then the user's own deliberate act.
/// --- dock zones (layout pass L1, BACKLOG #22) -------------------------------
// Every side panel is a module in one of four zones (app/dock-layout.js has
// every rule; app/dock-zones-display.js draws and decides a redraw's effects).
// Two kinds of state, kept apart on purpose:
//   - PLACEMENT (which zone holds which module, hidden ones, sizes): the global
//     layout in main (install-wide), or this tab's own, kept by its host.
//   - SELECTION (which module each zone shows, zones collapsed on purpose,
//     Ctrl+B's memory): this window's own, saved in localStorage and read at
//     load, the way `sideTab` always was. Clicking Vault here must not switch
//     every other project window to Vault (S3a; PR #82 Dexter F4).
const MODULE_IDS = TABS.map(t => t.id);
const DL = window.dockLayout;
let globalLayout = DL.defaultLayout(MODULE_IDS);
let ownLayout = null;            // this tab's own placement (host), or null
let pendingOverride = null;      // { layout } sent to the host, not yet echoed back
let dragLayout = null;           // a grip being dragged: drawn, not yet saved
let selection = null;            // DL.selectionOf(...) or null = not seeded yet
let shownModules = new Set();

function readSelection() {
  try {
    const raw = JSON.parse(localStorage.getItem('dockSelection') || 'null');
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}
function saveSelection() {
  try { localStorage.setItem('dockSelection', JSON.stringify(selection)); } catch {}
}

function placementLayout() { return dragLayout || ownLayout || globalLayout; }

// The layout this window draws: the placement, with THIS window's selection.
function effectiveLayout() {
  return DL.mergeSelection(placementLayout(), selection, MODULE_IDS);
}

// The room the zones share with the terminal: #body minus the diagnostics pane.
function zonesViewport() {
  const body = document.getElementById('body');
  const diag = document.getElementById('diag');
  const diagW = diag && diag.classList.contains('show') ? diag.offsetWidth : 0;
  return { width: body.clientWidth - diagW, height: body.clientHeight };
}

function onModuleShown(id) {
  if (id === 'fog') requestFog();
  if (id === 'git') requestGitTree();
  if (id === 'projects') requestProjects();
  // Dexter/Miguel, PR #60, F2/I1: EVERY open asks, not just the first one --
  // the host answers cheaply from a fresh cache, and decides freshness itself.
  if (id === 'models') requestModels(false);
  if (id === 'vault') renderVault();
}

// Leaving the vault puts every revealed secret back out of sight -- both the
// listed ones and whatever is half-typed in the field. A value left on screen
// outlives the moment someone needed it. "Leaving" is anything that stops it
// showing: its zone collapsing, a move, Hide, or focus mode.
function onVaultLeft() {
  hideRevealed();
  secretMask.left();
  applyMask();
}

// The one place every path into a panel goes through -- a click, Ctrl+B, a
// move, a layout pushed from another window, the restore at launch -- so the
// side effects of showing a module can't be skipped by one of them (the old
// setTab had the same job, for the same reason). What a redraw may do besides
// drawing is decided by dockZones.renderEffects, which is tested: above all,
// a redraw never moves keyboard focus unless the vault opened or closed, or
// the user acted (PR #82 Dexter F2, Miguel B1).
function renderLayout({ userAction = false } = {}) {
  const plan = window.dockZones.zonePlan(effectiveLayout(), TABS, zonesViewport(), { faceSize: window.faceSize });
  window.dockZones.applyPlan(plan, document);
  const now = new Set(plan.shown);
  const fx = window.dockZones.renderEffects(shownModules, now, { userAction });
  shownModules = now;
  for (const id of fx.newlyShown) onModuleShown(id);
  if (fx.vaultLeft) onVaultLeft();
  if (fx.focus === 'vault') setTimeout(() => document.getElementById('vault-search').focus(), 0);
  if (fx.focus === 'term') term.focus();
  const btn = document.getElementById('layout-btn');
  if (btn) btn.classList.toggle('own', ownLayout !== null);
  // Cell geometry changed, so the pty must be told or Ink's layout corrupts.
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}

// A selection change (tab click, Ctrl+B) stays in this window.
function commitSelection(next) {
  selection = DL.selectionOf(next);
  saveSelection();
  renderLayout({ userAction: true });
}

// This tab's own layout to its host. Kept as pending until the host echoes it
// back, so a change made while the socket is down isn't undone by the next
// hello carrying the host's old value (PR #82 Dexter F8).
function sendOverride(layout) {
  pendingOverride = { layout };
  try { ws.send(JSON.stringify({ type: 'layout-override', layout })); } catch { /* not attached: hello resends */ }
}

const placementOf = l => JSON.stringify({ zones: l.zones, hidden: l.hidden, size: l.size });

// A placement change (move, hide, resize) goes to this tab's own layout when it
// has one or `justThisTab` asks for one, else to the global layout. A change
// that moves nothing is a selection change only: no store write, no push to
// every window, no broadcast (PR #82 Miguel S3).
function commitPlacement(next, { justThisTab = false } = {}) {
  const l = DL.normalizeLayout(next, MODULE_IDS);
  const toOwn = justThisTab || ownLayout !== null;
  if (placementOf(l) === placementOf(toOwn && ownLayout ? ownLayout : globalLayout) && (!justThisTab || ownLayout)) {
    commitSelection(l);
    return;
  }
  selection = DL.selectionOf(l);
  saveSelection();
  if (toOwn) {
    ownLayout = l;
    sendOverride(l);
  } else {
    globalLayout = l;
    if (window.harness && window.harness.layout) window.harness.layout.set(l).catch(() => {});
  }
  renderLayout({ userAction: true });
}

// Reset to global (the tab drops its own) and Make this global.
function dropOwnLayout({ makeGlobal = false } = {}) {
  if (!ownLayout) return;
  if (makeGlobal) {
    globalLayout = ownLayout;
    if (window.harness && window.harness.layout) window.harness.layout.set(ownLayout).catch(() => {});
  }
  ownLayout = null;
  sendOverride(null);
  renderLayout({ userAction: true });
}

function toggleAllZones() { commitSelection(DL.toggleAll(effectiveLayout())); }

// --- moving modules: right-click, the layout menu, drag (layout pass L1) -----
// Three ways in, one rule (DL.moveModule) and one save path (commitPlacement).
// *Just this tab* sends the change to this tab's own layout; once a tab has
// one, every change goes there until Reset to global.
const layoutMenu = document.getElementById('layout-menu');
let layoutMenuFor = null;               // 'menu' | a module id (right-click) | null

function closeLayoutMenu() {
  if (layoutMenu.hidden) return false;
  layoutMenu.hidden = true;
  layoutMenu.textContent = '';
  layoutMenuFor = null;
  return true;
}

function node(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids) n.appendChild(c);
  return n;
}

// The *Just this tab* check: checked and locked once the tab has its own
// layout, because every change then goes there anyway.
function justThisTabCheck() {
  const box = node('input', { type: 'checkbox', checked: ownLayout !== null, disabled: ownLayout !== null });
  const row = node('label', { title: 'Change only this tab\'s layout; every other tab keeps the global one' },
    [box, node('span', { text: 'Just this tab' })]);
  return { row, box };
}

function showLayoutMenu(x, y) {
  layoutMenu.hidden = false;
  const r = layoutMenu.getBoundingClientRect();
  layoutMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  layoutMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

// A module tab's right-click: Move to Left / Right / Top / Bottom / Hide.
function openMoveMenu(id, x, y) {
  closeLayoutMenu();
  layoutMenuFor = id;
  const label = (TABS.find(t => t.id === id) || {}).label || id;
  const check = justThisTabCheck();
  layoutMenu.appendChild(node('div', { className: 'lm-title', text: `Move ${label} to` }));
  for (const t of window.dockZones.moveTargets(effectiveLayout(), id)) {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: t.label, disabled: !t.enabled,
      on: { click: () => {
        commitPlacement(DL.moveModule(effectiveLayout(), id, t.target), { justThisTab: check.box.checked });
        closeLayoutMenu();
      } },
    }));
  }
  layoutMenu.appendChild(node('div', { className: 'lm-sep' }));
  layoutMenu.appendChild(check.row);
  showLayoutMenu(x, y);
}

// The ▦ layout menu: every module and where it sits, hidden ones included, so
// there is never a layout with nothing left to click.
const ROW_TARGETS = [['left', 'L', 'Left'], ['right', 'R', 'Right'], ['top', 'T', 'Top'], ['bottom', 'B', 'Bottom'], ['hide', '–', 'Hidden']];
function openLayoutMenu() {
  const anchor = document.getElementById('layout-btn').getBoundingClientRect();
  closeLayoutMenu();
  layoutMenuFor = 'menu';
  const check = justThisTabCheck();
  layoutMenu.appendChild(node('div', { className: 'lm-title', text: ownLayout ? 'This tab\'s own layout' : 'Layout (every tab)' }));
  for (const row of window.dockZones.layoutRows(effectiveLayout(), TABS)) {
    const at = row.at === 'hidden' ? 'hide' : row.at;
    layoutMenu.appendChild(node('div', { className: 'lm-row' }, [
      node('span', { className: 'lm-name', text: row.label }),
      ...ROW_TARGETS.map(([target, short, long]) => node('button', {
        type: 'button', text: short, title: long, className: target === at ? 'on' : '',
        on: { click: () => {
          if (target === at) return;
          commitPlacement(DL.moveModule(effectiveLayout(), row.id, target), { justThisTab: check.box.checked });
          openLayoutMenu();                       // redrawn in place, still open
        } },
      })),
    ]));
  }
  layoutMenu.appendChild(node('div', { className: 'lm-sep' }));
  layoutMenu.appendChild(check.row);
  layoutMenu.appendChild(node('button', {
    type: 'button', text: 'Reset to default', title: 'Every panel back on the right, default sizes',
    on: { click: () => { commitPlacement(DL.defaultLayout(MODULE_IDS), { justThisTab: check.box.checked }); closeLayoutMenu(); } },
  }));
  if (ownLayout) {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Reset to global', title: 'Drop this tab\'s own layout and follow the global one',
      on: { click: () => { dropOwnLayout(); closeLayoutMenu(); } },
    }));
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Make this global', title: 'Every tab without its own layout takes this one',
      on: { click: () => { dropOwnLayout({ makeGlobal: true }); closeLayoutMenu(); } },
    }));
  }
  showLayoutMenu(anchor.left, anchor.bottom + 4);
}

document.getElementById('layout-btn').addEventListener('click', () => {
  if (layoutMenuFor === 'menu') closeLayoutMenu(); else openLayoutMenu();
});
document.addEventListener('contextmenu', (e) => {
  const button = e.target.closest('.zone-tabs button[data-module]');
  if (!button) return;
  e.preventDefault();
  openMoveMenu(button.dataset.module, e.clientX, e.clientY);
});
window.addEventListener('mousedown', (e) => {
  if (!layoutMenu.hidden && !layoutMenu.contains(e.target) && !e.target.closest('#layout-btn')) closeLayoutMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && closeLayoutMenu()) { e.preventDefault(); e.stopPropagation(); }
}, true);

// Drag a module's tab onto one of four edge strips that appear while dragging.
const dropStrips = ['left', 'right', 'top', 'bottom'].map((target) => {
  const s = node('div', { className: 'dock-drop', title: `Move here (${target})` });
  s.dataset.target = target;
  document.body.appendChild(s);
  return s;
});
function placeDropStrips() {
  const b = document.getElementById('body').getBoundingClientRect();
  const T = 56;   // strip thickness
  const at = { left: [b.left, b.top, T, b.height], right: [b.right - T, b.top, T, b.height],
    top: [b.left, b.top, b.width, T], bottom: [b.left, b.bottom - T, b.width, T] };
  for (const s of dropStrips) {
    const [l, t, w, h] = at[s.dataset.target];
    Object.assign(s.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
  }
}
let draggingModule = null;
document.addEventListener('dragstart', (e) => {
  const button = e.target.closest && e.target.closest('.zone-tabs button[data-module]');
  if (!button) return;
  draggingModule = button.dataset.module;
  e.dataTransfer.setData('text/x-dock-module', draggingModule);
  e.dataTransfer.effectAllowed = 'move';
  placeDropStrips();
  document.body.classList.add('dock-dragging');
});
for (const s of dropStrips) {
  s.addEventListener('dragover', (e) => { if (draggingModule) { e.preventDefault(); s.classList.add('over'); } });
  s.addEventListener('dragleave', () => s.classList.remove('over'));
  s.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = draggingModule;
    // Ended HERE, before the move redraws: the redraw removes the dragged tab
    // button, and a removed source never fires the dragend that was meant to
    // clean up -- the strips stayed up and the file drop zone stayed disarmed
    // (PR #82 Dexter F1, Miguel I2).
    endModuleDrag();
    if (id) commitPlacement(DL.moveModule(effectiveLayout(), id, s.dataset.target));
  });
}
function endModuleDrag() {
  draggingModule = null;
  document.body.classList.remove('dock-dragging');
  for (const s of dropStrips) s.classList.remove('over');
}
// A drag cancelled or dropped anywhere else: its source still exists, so
// dragend arrives. Captured on window so nothing on the way can swallow it.
window.addEventListener('dragend', endModuleDrag, true);

// --- focus mode (layout pass L1, #1) -----------------------------------------
// Only the terminal: main lifts this view over the tab strip and tells every
// view; this page hides its header, zones and diagnostics. Ways back: the same
// key (Ctrl+Shift+F, main's), the exit in the top-right corner, and Ctrl+B.
const focusBridge = window.harness && window.harness.focus;
let focusOn = false;
function applyFocusMode(on) {
  if (on === focusOn) return;
  focusOn = on;
  document.body.classList.toggle('focus-mode', on);
  closeLayoutMenu();
  // Focus mode hides the vault too, so it is "left": revealed secrets go.
  if (on && shownModules.has('vault')) onVaultLeft();
  // Only the terminal shows, so it takes the keyboard. Left in a panel field,
  // focus stayed in an INVISIBLE input: typing went into the hidden vault field
  // and Ctrl+B never reached the terminal's handler (probe check 7, found
  // after check 8 left focus in #vault-secret).
  if (on) term.focus();
  if (!on && shownModules.has('vault')) renderVault();
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}
if (focusBridge) focusBridge.onChange(applyFocusMode);
for (const id of ['focus-btn', 'focus-exit']) {
  document.getElementById(id).addEventListener('click', () => { if (focusBridge) focusBridge.toggle(); });
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('.zone-tabs button[data-module]');
  if (!button) return;
  commitSelection(DL.selectModule(effectiveLayout(), button.dataset.module));
});

document.getElementById('side-hint').addEventListener('click', toggleAllZones);

// S2: the first launch after the upgrade has no global layout yet; it starts
// from this window's old per-window settings so nothing moves under anyone.
function legacyLayout() {
  let legacy = {};
  try { legacy = { sideTab: localStorage.getItem('sideTab'), rosterWidth: localStorage.getItem('rosterWidth') }; } catch {}
  return DL.fromLegacy(legacy, MODULE_IDS);
}

async function loadLayout() {
  globalLayout = legacyLayout();
  selection = readSelection();
  renderLayout();                          // draw at once; the stored layout may take a moment
  const bridge = window.harness && window.harness.layout;
  if (bridge) {
    bridge.onChange((l) => {
      globalLayout = DL.normalizeLayout(l, MODULE_IDS);
      if (!ownLayout) renderLayout();
    });
    let answer = null;
    try { answer = await bridge.get(); } catch { /* unreadable: keep */ }
    // Only a MISSING file is a first launch to migrate and save. Unreadable or
    // corrupt (antivirus holding it) keeps the old settings drawn and saves
    // nothing, so the user's real layout is never overwritten (PR #82 Dexter F3,
    // Miguel I1); their next real change saves as usual.
    const what = window.dockZones.afterLayoutGet(answer);
    if (what === 'migrate') bridge.set(globalLayout).catch(() => {});
    else if (what === 'use') { globalLayout = DL.normalizeLayout(answer.layout, MODULE_IDS); renderLayout(); }
  }
  // This window's selection is seeded ONCE, from what it shows at load (S2), so
  // a layout another window pushes later never brings that window's choices
  // with it (PR #82 Dexter F4).
  if (!selection) {
    selection = DL.selectionOf(effectiveLayout());
    saveSelection();
  }
}

// The host's word on this tab's own layout: in `hello` and on every change. A
// change this window made that the host hasn't echoed yet wins, and is sent
// again (PR #82 Dexter F8; dockZones.overrideOnHello is the tested rule).
function applyLayoutOverride(incoming) {
  const r = window.dockZones.overrideOnHello(pendingOverride, incoming);
  if (r.settled) pendingOverride = null;
  ownLayout = r.apply && typeof r.apply === 'object' ? DL.normalizeLayout(r.apply, MODULE_IDS) : null;
  if (r.resend && pendingOverride) {
    try { ws.send(JSON.stringify({ type: 'layout-override', layout: pendingOverride.layout })); } catch { /* next hello */ }
  }
  renderLayout();
}

// verify/probe-dock-zones.js drives and measures the zones through named
// actions, defined only on a page main opened with ?probe=1 (its probe driver
// is running). Answers JSON text.
if (new URLSearchParams(location.search).get('probe') === '1') {
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  window.__dockProbe = (req) => {
    const a = (req && req.args) || {};
    switch (req && req.action) {
      case 'state': {
        const zones = {};
        for (const el of document.querySelectorAll('.zone')) {
          zones[el.dataset.zone] = {
            empty: el.hasAttribute('data-empty'), collapsed: el.hasAttribute('data-collapsed'), rect: rectOf(el),
            tabs: [...el.querySelectorAll('.zone-tabs button')].map(b => b.dataset.module),
            panels: [...el.querySelectorAll('.zone-panels > .panel.on')].map(p => p.dataset.panel),
          };
        }
        let proposed = null;
        try { proposed = fit.proposeDimensions() || null; } catch {}
        return JSON.stringify({
          ok: true, layout: effectiveLayout(), own: ownLayout !== null, shown: [...shownModules], zones,
          term: { cols: term.cols, rows: term.rows }, fit: proposed, sent: lastSentResize,
          termwrap: rectOf(document.getElementById('termwrap')),
          header: !!document.querySelector('header') && getComputedStyle(document.querySelector('header')).display !== 'none',
          innerHeight: window.innerHeight, focus: focusOn,
        });
      }
      case 'move': commitPlacement(DL.moveModule(effectiveLayout(), a.id, a.target), { justThisTab: a.justThisTab === true }); break;
      case 'select': commitSelection(DL.selectModule(effectiveLayout(), a.id)); break;
      case 'toggleAll': toggleAllZones(); break;
      case 'dropOwn': dropOwnLayout({ makeGlobal: a.makeGlobal === true }); break;
      // The menus, opened as a click would, so a screenshot can look at them.
      case 'openMenu':
        if (a.which === 'move') openMoveMenu(String(a.id), 300, 200); else openLayoutMenu();
        return JSON.stringify({ ok: true, items: [...layoutMenu.querySelectorAll('button')].map(b => ({ text: b.textContent, disabled: b.disabled, on: b.classList.contains('on') })) });
      case 'closeMenu': closeLayoutMenu(); break;
      // Layout pass L3 (verify/probe-git-tree.js): read the Git panel, hover a spoke, pin and jump.
      case 'gitState': {
        const body = document.getElementById('git-body');
        const svg = body.querySelector('.git-svg');
        return JSON.stringify({
          ok: true, status: document.getElementById('git-status').textContent,
          spokes: [...body.querySelectorAll('.git-spoke')].map(g => ({ name: g.dataset.name, cls: g.getAttribute('class'),
            ring: !!g.querySelector('.git-ring'), square: !!g.querySelector('rect.git-tip'), dashed: !!g.querySelector('.git-stem.dashed') })),
          hub: (body.querySelector('.git-hub-name') || {}).textContent || null,
          foot: (body.querySelector('.git-foot') || {}).textContent || null,
          labels: [...body.querySelectorAll('.git-label')].map(t => t.textContent),
          svg: svg ? rectOf(svg) : null, panel: rectOf(body),
          narrow: document.getElementById('git-dial').classList.contains('narrow'),
          // PR #85 review: listeners wired once however many redraws; pin and focus survive a redraw
          wired: (document.getElementById('git-dial').gitState || {}).wired || 0,
          renders: (document.getElementById('git-dial').gitState || {}).renders || 0,
          pinned: ((document.getElementById('git-dial').gitState || {}).pinned) || null,
          cardShown: !!document.querySelector('.git-card') && !document.querySelector('.git-card').hidden,
          cardText: (document.querySelector('.git-card') || {}).textContent || '',
          focused: document.activeElement && document.activeElement.getAttribute
            ? (document.activeElement.getAttribute('data-name') || (document.activeElement.classList && document.activeElement.classList.contains('git-card-jump') ? 'jump' : null)) : null,
          boldInPanel: body.querySelectorAll('b:not(.git-foot b)').length,
          hubTextShown: !!body.querySelector('.git-hub-name') && getComputedStyle(body.querySelector('.git-hub-name')).display !== 'none',
        });
      }
      case 'gitRefresh': requestGitTree(); break;
      // the same answer again (must draw nothing), or one that changed (must keep the pin and focus)
      case 'gitRerender': {
        if (!lastGitTree) return JSON.stringify({ ok: false, error: 'no tree yet' });
        const t = a.changed ? { ...lastGitTree, totalSpend: (lastGitTree.totalSpend || 0) + 1 } : lastGitTree;
        renderGitTree(t);
        break;
      }
      case 'gitKey': {
        // a key on the focused element, as a keyboard would send it
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true, cancelable: true }));
        break;
      }
      case 'gitFocus': {
        const g = [...document.querySelectorAll('.git-spoke')].find(x => x.dataset.name === a.name);
        if (!g) return JSON.stringify({ ok: false, error: `no spoke ${a.name}` });
        g.focus();
        break;
      }
      case 'gitHover': case 'gitPin': {
        const g = [...document.querySelectorAll('.git-spoke')].find(x => x.dataset.name === a.name);
        if (!g) return JSON.stringify({ ok: false, error: `no spoke ${a.name}` });
        const r = g.getBoundingClientRect();
        const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true };
        // mouseover, not mouseenter: the dial finds its spoke by delegation, and mouseenter doesn't bubble
        g.dispatchEvent(new MouseEvent(req.action === 'gitHover' ? 'mouseover' : 'click', at));
        const card = document.querySelector('.git-card');
        return JSON.stringify({ ok: true, hidden: card.hidden, text: card.textContent, card: rectOf(card),
          panel: rectOf(document.getElementById('git-body')), jump: !!card.querySelector('.git-card-jump') });
      }
      case 'gitJump': {
        const btn = document.querySelector('.git-card-jump');
        if (!btn) return JSON.stringify({ ok: false, error: 'no jump button' });
        btn.click();
        return JSON.stringify({ ok: true });
      }
      // PR #82 Dexter F1: a real drop. The move redraws the tab bar, so the
      // dragged button is gone and no dragend will ever come; the drag must
      // already be over when the drop returns.
      case 'dragDrop': {
        const btn = document.querySelector(`.zone-tabs button[data-module="${CSS.escape(String(a.id))}"]`);
        const strip = dropStrips.find(s => s.dataset.target === a.target);
        if (!btn || !strip) return JSON.stringify({ ok: false, error: 'no such tab or strip' });
        const dt = new DataTransfer();
        btn.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const during = document.body.classList.contains('dock-dragging');
        strip.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        strip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return JSON.stringify({ ok: true, during, sourceGone: !btn.isConnected, dragging: draggingModule,
          stripsUp: document.body.classList.contains('dock-dragging') });
      }
      // PR #82 Dexter F2 / Miguel B1: half a secret typed, then every kind of
      // passive redraw. Focus must still be in the secret field after each.
      case 'secretRedraw': return new Promise((resolve) => {
        const field = document.getElementById('vault-secret');
        field.focus();
        const after = [document.activeElement && document.activeElement.id];   // [0]: did it take focus at all
        renderLayout();
        after.push(document.activeElement && document.activeElement.id);
        applyLayoutOverride(ownLayout);
        after.push(document.activeElement && document.activeElement.id);
        window.dispatchEvent(new Event('resize'));
        setTimeout(() => {
          after.push(document.activeElement && document.activeElement.id);
          resolve(JSON.stringify({ ok: true, focusable: field.offsetParent !== null, shown: [...shownModules], after }));
        }, 150);
      });
      case 'measure': {
        // #9: does each showing panel's content reach the bottom of its zone?
        const out = {};
        for (const p of document.querySelectorAll('.zone-panels > .panel.on')) {
          const kids = [...p.children].filter(c => getComputedStyle(c).display !== 'none');
          // The panel's own bottom padding is spacing, not blank space.
          const pad = parseFloat(getComputedStyle(p).paddingBottom) || 0;
          out[p.dataset.panel] = {
            holderBottom: p.parentElement.getBoundingClientRect().bottom - pad,
            contentBottom: Math.max(...kids.map(c => c.getBoundingClientRect().bottom)),
            // Diagnostics for a FAIL: who ends lowest, and the panel itself.
            last: (kids.reduce((a, c) => (!a || c.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? c : a), null) || {}).id || null,
            panelBottom: p.getBoundingClientRect().bottom,
            scrollTop: p.scrollTop,
          };
        }
        return JSON.stringify({ ok: true, panels: out });
      }
      default: return JSON.stringify({ ok: false, error: 'unknown action' });
    }
    return JSON.stringify({ ok: true });
  };
}

window.addEventListener('DOMContentLoaded', () => {
  wireModelPanel();
  renderClaudeChoices();
  renderRefreshButton();
  // BACKLOG E #5, #3: the saved favourites, read once through the bridge --
  // see app/favourites-bridge.js. Absent on a build with no bridge (a
  // headless probe's window, an older preload) leaves modelFavourites at its
  // empty default rather than throwing.
  if (window.harness && window.harness.favourites) {
    window.harness.favourites.get().then((f) => {
      modelFavourites = normalizeFavourites(f);
      renderClaudeChoices();
      renderModels();
    }).catch(() => {});
  }
  // The layout: drawn at once from this window's old settings, then from the
  // stored global layout once main answers (see loadLayout).
  //
  // A screenshot probe can pin the tab: the side panel is the one surface the
  // headless checks cannot look at. Validated (an unknown ?tab= once blanked the
  // sidebar) and NEVER saved -- the old pin wrote itself into the user's choice.
  const forced = new URLSearchParams(location.search).get('tab');
  loadLayout().then(() => {
    if (!forced || !isKnownTab(forced)) return;
    const l = effectiveLayout();
    if (DL.ZONES.some(z => l.active[z] === forced)) return;
    const pinned = DL.selectModule(l, forced);
    selection = { active: pinned.active, restore: pinned.restore };
    renderLayout();
  });

  // Screenshot support only: type a value into the new-secret field and reveal
  // it, so the toggle can actually be LOOKED at. Never a real secret -- the
  // probe passes a throwaway string.
  // Screenshot support only: the flourish lives ~4s and is the one surface a
  // headless check cannot look at.
  if (new URLSearchParams(location.search).get('flourish')) {
    setTimeout(() => flourish({ name: 'Billionaire', icon: '🌕' }), 22000);
  }

  const demo = new URLSearchParams(location.search).get('demosecret');
  if (demo) {
    setTimeout(() => {
      document.getElementById('vault-label').value = 'openrouter key';
      document.getElementById('vault-secret').value = demo;
      secretMask.toggle();
      applyMask();
    }, 1200);
  }
});

// The reveal state of the NEW-secret field. Deliberately temporary: it
// survives neither storing the entry nor leaving the panel.
const secretMask = createMask();

function applyMask() {
  const input = document.getElementById('vault-secret');
  const button = document.getElementById('vault-mask');
  if (!input || !button) return;
  input.type = secretMask.inputType();
  button.textContent = secretMask.label();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#vault-mask')) return;
  secretMask.toggle();
  applyMask();
  document.getElementById('vault-secret').focus();
});

function hideRevealed() {
  for (const el of document.querySelectorAll('#vault-list .shown')) el.remove();
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- the vault lock ----------------------------------------------------------
// Every decision lives in app/vault-lock-display.js; this draws what it says.
//
// The melt confirmation is held HERE, and it is reset in renderVaultLock
// whenever the state it was armed against is no longer the state on screen --
// so an armed confirmation cannot survive a lock, an unlock or a background
// re-render and fire against a vault the user is no longer looking at.
//
// Dexter F8: that sentence used to be a comment describing a reset that did not
// exist. The flag was cleared only inside the click handler, so the input path
// (`renderVault()` on typing) re-rendered with the confirmation still armed. He
// could not turn it into an unintended melt, and was careful to say the three
// reasons were incidental rather than designed -- chief among them that the flag
// is read AFTER the awaits below, so a late `melt-cancel` still wins. A comment
// asserting a safety property the code does not have is worse than no comment,
// because it stops the next reader checking.
let confirmingMelt = false;
let lastLockState = null;

async function renderVaultLock() {
  const el = document.getElementById('vault-lock');
  // `secrets` itself, before reaching into it: renderVault guards this and this
  // path did not, so an old preload turned a missing feature into a TypeError.
  if (!el || !window.harness || !window.harness.secrets) return null;
  if (!window.harness.secrets.lockState) return null;

  const state = await window.harness.secrets.lockState();

  // THE COUNT COMES FROM lockState, NOT FROM list(). Dexter F5 / Miguel B3,
  // found independently, and it was dead code twice over: the renderer passed
  // `null` exactly when the display reads it, and it fetched the list only when
  // the vault was already unlocked. So the "All 6 secrets" branch was
  // unreachable and every user read the slogan the module exists to avoid.
  //
  // `list()` cannot supply it -- a locked vault returns [] by design and must
  // keep doing so. A count is not a secret: no label, no note, no value, and the
  // person about to destroy them owns them.
  const d = window.vaultLockDisplay(state, {
    confirmingMelt,
    entryCount: state && typeof state.count === 'number' ? state.count : null,
  });

  // Reset an armed confirmation when the state it was armed against is gone.
  // Compared on the drawn state rather than the raw object so that a re-render
  // of the SAME state -- which is what typing in the filter causes -- does not
  // cancel a confirmation the user is in the middle of reading.
  // FROM THE DISPLAY, not recomputed here. Dexter I1: this line used to collapse
  // 'confirm-melt' -> 'locked' itself, which meant the renderer had to know the
  // display's state vocabulary -- and when a fifth state arrived with its own
  // confirmation, this did not know about it, so arming melt on a damaged vault
  // disarmed itself in the same tick and the vault had no working action at all.
  const stamp = d.stamp || d.state;
  if (lastLockState !== null && stamp !== lastLockState && confirmingMelt) {
    confirmingMelt = false;
    lastLockState = stamp;
    return renderVaultLock();          // redraw without the armed confirmation
  }
  lastLockState = stamp;

  const note = `<div class="lock-note">${escapeHtml(d.note)}</div>`;

  // A LABELLED password field, every time. Miguel A7: all three inputs had only
  // a placeholder, which is a WCAG 3.3.2 failure on the field holding a vault
  // key. The label is visually hidden rather than dropped -- the control is
  // obvious to a sighted user from the button beside it, and unlabelled to
  // everyone else.
  const keyField = (labelText, ph, ac) =>
    `<label class="sr-only" for="vault-key">${escapeHtml(labelText)}</label>` +
    `<input id="vault-key" type="password" placeholder="${escapeHtml(ph)}" autocomplete="${ac}" />`;

  // THE DAMAGED PANEL, which offers no password field at all. Dexter H1: the
  // ordinary locked panel invited the user to guess at a file where no password
  // can work, and then offered melt as the only alternative.
  if (d.state === 'damaged' || d.state === 'confirm-melt-damaged') {
    el.innerHTML =
      `<div class="melt-warn" role="alert" aria-live="polite">${escapeHtml(d.note)}</div>` +
      (d.state === 'confirm-melt-damaged'
        ? `<div class="melt-warn" id="melt-warning">${escapeHtml(d.meltWarning)}</div>` +
          '<div class="lock-row">' +
            '<button data-lock="melt-cancel" data-autofocus="1">Cancel</button>' +
            '<button class="melt" data-lock="melt-confirm" aria-describedby="melt-warning">' +
              'Start a new empty vault</button>' +
          '</div>'
        : '<div class="lock-row">'
          + '<button class="melt" data-lock="melt-ask">Start over with an empty vault…</button>'
          + '</div>');
    return d;
  }

  if (d.state === 'locked' || d.state === 'confirm-melt') {
    el.innerHTML = note +
      '<div class="lock-row">' +
        keyField('Vault key', 'key', 'current-password') +
        '<button data-lock="unlock">Open</button>' +
      '</div>' +
      (d.state === 'confirm-melt'
        // `aria-describedby` ties the warning to the destructive button, and
        // CANCEL COMES FIRST. Miguel A7: the melt button used to sit before
        // Cancel in tab order, two tabs and a space from the password field.
        ? `<div class="melt-warn" id="melt-warning">${escapeHtml(d.meltWarning)}</div>` +
          '<div class="lock-row">' +
            '<button data-lock="melt-cancel" data-autofocus="1">Cancel</button>' +
            '<button class="melt" data-lock="melt-confirm" aria-describedby="melt-warning">' +
              'Melt it, I lost the key</button>' +
          '</div>'
        : '<div class="lock-row"><button class="melt" data-lock="melt-ask">Forgot the key…</button></div>');
    return d;
  }

  if (d.state === 'open-no-key') {
    el.innerHTML = `<div class="keyless">${escapeHtml(d.note)}</div>` +
      '<div class="lock-row">' +
        keyField('Choose a vault key', 'set a key', 'new-password') +
        '<button data-lock="set">Close with a key</button>' +
      '</div>';
    return d;
  }

  el.innerHTML = note +
    '<div class="lock-row">' +
      '<button data-lock="lock">Lock</button>' +
      keyField('Replacement vault key', 'new key', 'new-password') +
      '<button data-lock="set">Replace</button>' +
      '<button data-lock="remove">Remove key</button>' +
    '</div>';
  return d;
}

// Put focus somewhere useful after a redraw. `innerHTML` destroys the input, so
// after a failed unlock -- the exact moment the user wants to type again -- focus
// fell to <body> and they had to tab back blind (Miguel A7).
//
// In `confirm-melt` the focus goes to CANCEL, never to the destructive button.
function focusLockPanel(el, hadFocus) {
  const cancel = el.querySelector('[data-autofocus]');
  if (cancel) { cancel.focus(); return; }
  if (!hadFocus) return;              // don't steal focus the user put elsewhere
  const key = el.querySelector('#vault-key');
  if (key) key.focus();
}

// Delegated, so the controls survive every re-render without rebinding.
async function runLockAction(act) {
  const keyEl = document.getElementById('vault-key');

  // READ AND CLEAR BEFORE THE FIRST await. Miguel A3: the comment said "the key
  // is cleared whatever happened", but the clear sat after the IPC awaits -- so
  // if an invoke rejected, the async listener died on an unhandled rejection and
  // the password stayed on screen. In the very case the comment names as most
  // likely to leave one there.
  const key = keyEl ? keyEl.value : '';
  if (keyEl) keyEl.value = '';

  // Armed only by the ask, and cleared by anything else. A confirmation that
  // outlives the click that raised it is a confirmation nobody gave.
  if (act === 'melt-ask') { confirmingMelt = true; await renderVaultLock(); return; }
  if (act === 'melt-cancel') { confirmingMelt = false; await renderVaultLock(); return; }
  confirmingMelt = false;

  // Wrapped, so a failing bridge shows the user something instead of dying
  // silently in a listener. An unhandled rejection here reads as "the button
  // does nothing", which in a lock panel is indistinguishable from being locked.
  let res;
  try {
    if (act === 'unlock') res = await window.harness.secrets.unlock(key);
    else if (act === 'set') res = await window.harness.secrets.setKey(key);
    else if (act === 'lock') res = await window.harness.secrets.lock();
    else if (act === 'remove') res = await window.harness.secrets.removeKey();
    else if (act === 'melt-confirm') res = await window.harness.secrets.melt();
    else res = { ok: true };
  } catch (err) {
    res = { ok: false, error: `the vault did not answer: ${err && err.message ? err.message : err}` };
  }

  const el = document.getElementById('vault-lock');
  const d = await renderVaultLock();
  const notes = [];

  if (!res || res.ok !== true) {
    // A DAMAGED HEADER IS NOT A WRONG KEY, and the difference decides whether
    // the user should melt. Dexter F1: both used to print "that key does not
    // open this vault", and the only other button on the panel is the
    // irreversible one -- so the app pushed people toward destroying a vault it
    // could have opened.
    if (res && res.damaged) notes.push(res.error);
    else if (res && res.wrongKey) notes.push('that key does not open this vault');
    else notes.push((res && res.error) || 'that did not work');
  }

  // Things that succeeded but cost something the user must know about.
  if (res && res.ok === true) {
    if (Array.isArray(res.failed) && res.failed.length) {
      // Dexter F3: entries a rekey could not carry. They still exist and are
      // still wrapped under the OLD key, so they are unreadable now -- naming
      // them is the only way the user can delete the broken one.
      notes.push('these secrets could not be re-keyed and are unreadable, '
        + 'delete and re-add them: '
        + res.failed.map(f => f.label || f.id).join(', '));
    }
    if (res.preserved) {
      // Dexter H2: the damaged vault was moved aside rather than destroyed,
      // because the app had just told this user their secrets might be
      // recoverable. Naming the path is the whole point -- a copy they cannot
      // find is the same as no copy.
      notes.push('your old vault could not be read, so it was MOVED ASIDE rather '
        + `than deleted: ${res.preserved} — if those secrets matter, copy that `
        + 'file somewhere safe. This harness will not read it again.');
    }
    if (Array.isArray(res.leftovers) && res.leftovers.length) {
      // Dexter F2: copies melt could not remove. The promise shown to the user
      // was "no backup and no recovery"; until these are gone it is not true.
      notes.push('the vault is gone, but these copies could not be deleted and '
        + 'still contain your labels and encrypted secrets — remove them by hand: '
        + res.leftovers.map(l => l.path).join(', '));
    }
  }

  if (notes.length && el) {
    // `aria-live` so a screen reader announces the failure and the state change
    // at all (Miguel A7) -- in confirm-melt that warning is the whole consent.
    el.innerHTML = notes
      .map(n => `<div class="melt-warn" role="alert" aria-live="assertive">${escapeHtml(n)}</div>`)
      .join('') + el.innerHTML;
  }
  if (el) focusLockPanel(el, true);

  if (d && d.showList) renderVault();
  else {
    const list = document.getElementById('vault-list');
    if (list) list.innerHTML = '';
  }
}

// Delegated, so the controls survive every re-render without rebinding.
document.addEventListener('click', async (e) => {
  const button = e.target.closest('#vault-lock button');
  if (!button) return;
  await runLockAction(button.dataset.lock);
});

// ENTER SUBMITS. Miguel A7: `#vault-lock` is not a form, so typing a key and
// pressing Enter did nothing at all, with no hint why -- while `#vault-add`
// directly below it IS a form, so the user has already learned the opposite
// expectation from the panel one row down.
//
// Which action Enter means depends on the state, so it is taken from the first
// non-destructive button in the row. Never melt: the destructive action requires
// a deliberate click, and a keystroke is not one.
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('#vault-lock #vault-key');
  if (!input) return;
  e.preventDefault();
  const panel = document.getElementById('vault-lock');
  const submit = panel && panel.querySelector('button[data-lock="unlock"], button[data-lock="set"]');
  if (submit) await runLockAction(submit.dataset.lock);
});

async function renderVault() {
  const list = document.getElementById('vault-list');
  if (!window.harness || !window.harness.secrets) {
    list.innerHTML = '<div class="err">the secret store is unavailable in this window</div>';
    return;
  }
  if (!(await window.harness.secrets.available())) {
    list.innerHTML = '<div class="err">This machine cannot encrypt secrets, so nothing ' +
      'will be stored. Storing them in plaintext would be worse than not storing them.</div>';
    return;
  }
  const query = document.getElementById('vault-search').value;
  // The lock is drawn first and decides whether there is a list at all. Asking
  // main rather than trusting a local flag: the window is not the authority on
  // whether the vault is open.
  const lockInfo = await renderVaultLock();
  if (lockInfo && lockInfo.showList === false) { list.innerHTML = ''; return; }
  const entries = await window.harness.secrets.list(query);
  if (!entries.length) {
    list.innerHTML = `<div class="none">${query ? 'nothing matches that label.'
      : 'empty — store a password or key below.'}</div>`;
    return;
  }
  // Labels only. The value is fetched one at a time, on demand.
  list.innerHTML = entries.map(e => `
    <div class="sec" data-id="${escapeHtml(e.id)}">
      <div class="row">
        <span class="label" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</span>
        ${/* Miguel, PR #40, part 4. Narrowing legacy entries retroactively was the
              right call -- a secret vanishing from a project that relies on it is a
              disappearance the user cannot debug. But shipping a ONE-WAY DOOR WITH NO
              SIGN is not: today someone sees `shared` on an old secret, wants it
              scoped, and has no path, with nothing telling them one exists. It does:
              delete it and add it again here.
              Closed with a string rather than a feature. No new IPC, no new surface,
              no new security question -- and a scope toggle does NOT belong in that
              branch, because re-scoping is a renderer-driven privilege change and
              would undo the one thing the branch got right: that the window does not
              choose the scope. */ ''}
        ${e.shared ? '<span class="scope" title="visible from every project on this machine'
          + ' — to scope it to this project, delete it and add it again here">shared</span>' : ''}
        <button data-act="copy">Copy</button>
        <button data-act="reveal">Show</button>
        <button data-act="remove" title="delete permanently">×</button>
      </div>
    </div>`).join('');
}

document.addEventListener('click', async (e) => {
  const button = e.target.closest('#vault-list button');
  if (!button) return;
  const card = button.closest('.sec');
  const id = card.dataset.id;
  const act = button.dataset.act;

  if (act === 'copy') {
    const res = await window.harness.secrets.copy(id);
    const said = document.createElement('div');
    said.className = 'said';
    said.textContent = res.ok
      ? `copied — clipboard clears in ${Math.round(res.clearsInMs / 1000)}s`
      : `could not copy: ${res.error}`;
    card.querySelectorAll('.said').forEach(n => n.remove());
    card.appendChild(said);
    setTimeout(() => said.remove(), 4000);
    return;
  }

  if (act === 'reveal') {
    const existing = card.querySelector('.shown');
    if (existing) { existing.remove(); button.textContent = 'Show'; return; }
    const res = await window.harness.secrets.reveal(id);
    const shown = document.createElement('div');
    shown.className = 'shown';
    shown.textContent = res.ok ? res.secret : `could not read it: ${res.error}`;
    card.appendChild(shown);
    button.textContent = 'Hide';
    return;
  }

  if (act === 'remove') {
    // No confirm dialog: an Electron modal blocks the whole window, and this
    // is a two-click action on a labelled card rather than a destructive sweep.
    //
    // THE RESULT IS READ. Dexter, PR #40, F6. This used to be
    // `await remove(id); renderVault();` with the result dropped, so when
    // `commit` threw -- the Windows EPERM/EBUSY rename path that
    // host/atomic-write.js exists for, measured against this file on
    // 2026-09-18 -- the window silently re-rendered with the entry still there.
    // The x appears to do nothing, so the user clicks it again.
    //
    // Miguel's addition raises it: scoping gave `{ok:false}` a SECOND meaning.
    // It used to mean only "already gone", which is benign and defensible to
    // discard. It now also means "not yours to delete", and the renderer
    // answered both by redrawing a row that is still there. Unreachable from
    // today's UI because every card came from a scoped `list` -- and
    // "unreachable from today's UI" is exactly the guarantee a second window or
    // a future keyboard shortcut erases.
    const res = await window.harness.secrets.remove(id);
    await renderVault();
    if (!res || res.ok !== true) {
      const list = document.getElementById('vault-list');
      const why = (res && res.error) ? res.error
        : 'that secret was not deleted — it may already be gone, or not belong to this project';
      if (list) {
        list.innerHTML =
          `<div class="err" role="alert" aria-live="assertive">${escapeHtml(why)}</div>`
          + list.innerHTML;
      }
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'vault-search') renderVault();
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'vault-add') return;
  e.preventDefault();
  const label = document.getElementById('vault-label');
  const secret = document.getElementById('vault-secret');
  const sharedBox = document.getElementById('vault-shared');
  const res = await window.harness.secrets.add({
    label: label.value,
    secret: secret.value,
    // Default is this project. Shared is an explicit act, and it is reset
    // after every store so the next secret does not inherit it silently.
    shared: !!(sharedBox && sharedBox.checked),
  });
  if (!res.ok) {
    const list = document.getElementById('vault-list');
    list.innerHTML = `<div class="err">${escapeHtml(res.error)}</div>` + list.innerHTML;
    return;
  }
  label.value = '';
  secret.value = '';
  if (sharedBox) sharedBox.checked = false;
  secretMask.stored();      // the next secret typed is not the one just revealed
  applyMask();
  renderVault();
});

// --- theme ------------------------------------------------------------------
// The host owns theme resolution; the view just applies what it is handed, so
// the registry stays the single source of truth.
// When project art is showing, the terminal must let it through. xterm paints
// an opaque background by default, which would reduce the art to a border.
let backgroundUrl = null;

// Fully transparent, NOT merely translucent. The SVG already bakes in the 90%
// black dim that makes light text readable; having the terminal darken it a
// second time stacks to ~4% visibility and the art disappears. One dimming
// pass, applied where it is specified, in the image itself.
const TERM_ALPHA = 0;

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// The last theme the host sent, so a refused or abandoned colour preview can
// be put back exactly.
let lastTheme = null;

function applyTheme(theme) {
  if (!theme) return;
  lastTheme = theme;
  const terminal = { ...theme.terminal };
  if (backgroundUrl) {
    terminal.background = hexToRgba(terminal.background, TERM_ALPHA);
    term.options.allowTransparency = true;
  }
  term.options.theme = terminal;
  if (theme.font) {
    if (theme.font.family) term.options.fontFamily = theme.font.family;
    if (theme.font.size) term.options.fontSize = theme.font.size;
    if (theme.font.lineHeight) term.options.lineHeight = theme.font.lineHeight;
  }
  const c = theme.chrome || {};
  const root = document.documentElement.style;
  // NAMING TRAP (Miguel, feat/project-look #5): the theme's `panel` colour is
  // the CSS `--chrome` variable (header, sidebar). The CSS `--panel` variable
  // is a different thing -- a hover/raised surface DERIVED from --chrome in
  // renderer.html -- and no theme key feeds it directly.
  for (const [key, cssVar] of Object.entries({
    bg: '--bg', panel: '--chrome', border: '--border', text: '--text',
    dim: '--dim', accent: '--accent', ok: '--ok', bad: '--bad',
  })) {
    if (c[key]) root.setProperty(cssVar, c[key]);
  }
  // Only a look with a chosen accent carries onAccent; without one the CSS
  // default (the theme's dark label) must come back, not a stale override.
  if (c.onAccent) root.setProperty('--on-accent', c.onAccent);
  else root.removeProperty('--on-accent');
  // FF12 tints the cursor and --model-accent from the theme. The line above
  // term.options.theme = ... REPLACED the tinted cursor, and a look changed
  // during a session, per #47, never reached FF12's cached theme -- re-tint.
  currentTheme = theme;
  renderTopBar();
  // A font change alters cell size, so the pty must be told the new geometry or
  // Ink's layout corrupts.
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}

// --- agent roster -----------------------------------------------------------
const agentsEl = document.getElementById('agents');
const roster = new Map();

// FF7: a portrait can come from several tiers, and a display that can't say
// WHICH one answered is this project's signature defect (absence read as a
// confident answer). Every result from host/portraits.js carries `tier`; the
// wording, the choice of <img> / <video> / placeholder and the "agent images
// off" override all live in app/portrait-media-display.js (`portraitMedia`),
// where they are tested. This is only the wiring.
//
// The install-wide "show agent images" toggle (BACKLOG C #18) is Electron
// main's. `null` = main has not answered yet, and nothing is loaded until
// then (an unknown toggle is not "on"); without the bridge there is no
// toggle and images are simply on.
let agentImagesEnabled = (window.harness && window.harness.avatar) ? null : true;

function faceHtml(portrait) {
  return portraitMedia.faceMediaHtml(portrait, { imagesEnabled: agentImagesEnabled });
}

// The hover pencil on a face (BACKLOG C #13): the file-picker route to the same
// `portrait set` message a drop sends. NOT the plain card click -- that opens
// the agent's activity log.
function faceEditHtml() {
  // Hidden while images are off or unknown: a picture saved then changes nothing
  // visible, which reads as a broken button (Miguel S7, PR #64).
  return (window.harness && window.harness.avatar && agentImagesEnabled === true)
    ? '<button type="button" class="face-pencil" data-no-card-click title="Choose a picture, GIF or video for this agent">✎</button>'
    : '';
}

// Every roster paint goes through here so a video that is about to be replaced
// is STOPPED AND UNLOADED first (removing the element alone leaves the decoder
// running until GC), and the new ones are watched for visibility.
const faceVideoOnScreen = new WeakMap();
const faceVideoObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      faceVideoOnScreen.set(en.target, en.isIntersecting);
      applyFaceVideo(en.target);
    }
  }, { root: agentsEl })
  : null;

function applyFaceVideo(v) {
  const onScreen = faceVideoObserver ? faceVideoOnScreen.get(v) === true : true;
  const action = portraitMedia.visibilityAction(onScreen, document.visibilityState === 'visible');
  if (action === 'play') { const p = v.play(); if (p && p.catch) p.catch(() => { /* unloaded meanwhile */ }); }
  else v.pause();
}

function setRosterHtml(html) {
  // A repaint runs about once a second while anything is running. A video that
  // is unloaded and recreated each time restarts from frame 0 and never loops
  // (Dexter F1 / Miguel I2, PR #64), so a face whose key (agent + exact URL) is
  // unchanged KEEPS its node: the fresh copy in the staged markup is swapped for
  // the live one before the roster is replaced, and only nodes that go away or
  // change are unloaded. The move is synchronous, so the browser's "removed from
  // the document" pause never runs.
  const oldByKey = new Map();
  for (const v of agentsEl.querySelectorAll('video[data-face-key]')) {
    if (!oldByKey.has(v.dataset.faceKey)) oldByKey.set(v.dataset.faceKey, v);
  }
  const stage = document.createElement('div');
  stage.innerHTML = html;
  const plan = portraitMedia.planVideoReuse([...oldByKey.keys()],
    [...stage.querySelectorAll('video[data-face-key]')].map(v => v.dataset.faceKey));
  for (const fresh of [...stage.querySelectorAll('video[data-face-key]')]) {
    const old = plan.reuse.has(fresh.dataset.faceKey) ? oldByKey.get(fresh.dataset.faceKey) : null;
    if (old) { oldByKey.delete(fresh.dataset.faceKey); fresh.replaceWith(old); }
  }
  for (const v of agentsEl.querySelectorAll('video')) {
    if (faceVideoObserver) faceVideoObserver.unobserve(v);
    portraitMedia.unloadVideo(v);
  }
  agentsEl.replaceChildren(...stage.childNodes);
  for (const v of agentsEl.querySelectorAll('video')) {
    if (faceVideoObserver) faceVideoObserver.observe(v);
    // Applied at once, not left to the observer's first callback: a hidden
    // window never delivers one, and the `autoplay` attribute would start the
    // video anyway. pause() clears the element's autoplay flag; the observer
    // calls play() when the face is really on screen. (Measured by
    // verify/probe-avatar-roster.js: without this, a roster repaint while the
    // window was hidden left every fresh video playing.)
    applyFaceVideo(v);
  }
}

document.addEventListener('visibilitychange', () => {
  for (const v of agentsEl.querySelectorAll('video')) applyFaceVideo(v);
});

// Career stats per agent, keyed by agent type. Arrives with the handshake and
// again whenever an agent finishes, so the figures move as work happens.
let agentStats = new Map();
// The WHOLE payload, kept beside the map because `ok` lives on the payload and
// not on any row -- and `ok: false` means the figures below are a lower bound,
// which the panel has to be able to say.
let lastAgentStatsPayload = null;

// The live delegation stack, exactly as `hello`/`processes` carry it, kept so
// renderRoster can turn it into a per-agent running count (app/agent-card-display.js
// `instanceCounts`) without a third module re-deriving it from mood.js.
let latestParty = [];
// The model each agent actually used, read from its own transcript -- see
// host/session-model.js. `{model:null,...}` on a fresh session before
// SessionStart's read has landed, which app/agent-card-display.js's
// `modelLine` draws as "not read yet", never a guess.
let sessionModel = { session: { model: null, at: null }, agents: {}, errors: 0 };

// Ricardo: tokens spent and time worked IN THE PROJECT, not in this window.
// Compact because it sits beside a 40px portrait -- "47.1M / 30m" reads at a
// glance, the tooltip carries the exact figures.
function compactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

function careerHtml(agent) {
  // Every judgement about HOW to draw these figures lives in
  // app/career-display.js so it can be tested. Vera, 2026-09-14: the host
  // computes `ok` -- absence, not zero -- and this consumer used to read
  // neither it nor `unresolved`, so a failed read drew pixel-identically to
  // "this agent never ran here".
  const d = careerDisplay(agentStats.get(agent), lastAgentStatsPayload);
  if (!d.draw) {
    // UNKNOWN and NONE both draw no figures -- but they are different claims,
    // and the module computes a sentence saying which. Discarding it made them
    // pixel-identical, which is the exact conflation this panel exists to end.
    return d.note
      ? `<div class="career career-unknown" title="${escapeHtml(d.note)}">—</div>`
      : '';
  }
  const st = agentStats.get(agent);
  return `<div class="career" title="${escapeHtml(d.detail)}">` +
    `<span class="career-tok">${d.prefix}${compactTokens(st.tokens)}</span>` +
    `<span class="career-sep">/</span>` +
    `<span class="career-min">${d.minutesPrefix}${formatCareerMinutes(st.ms)}</span>` +
    (d.unresolved ? '<span class="career-warn" title="identity unresolved">?</span>' : '') +
    `</div>`;
}

// The model line under the state (FF10) and the ×N badge beside the name for
// concurrent instances of one agent (FF8). Both judgements live in
// app/agent-card-display.js so they can be tested; this is only the drawing.
function agentModelHtml(agent) {
  const entry = modelEntry(sessionModel && sessionModel.agents, agent);
  const m = modelLine(entry, sessionModel && sessionModel.errors);
  return `<div class="agent-model" title="${escapeHtml(m.title)}">${escapeHtml(m.text)}</div>`;
}

// The tool belt (BACKLOG #17): every decision, and the HTML, lives in
// app/loadout-display.js. `running` is what lets the picker say the CURRENT run
// isn't affected -- an equip changes the next spawn only.
let loadoutState = loadoutDisplay.emptyState();
// `hooksOn` is hello.hooks (false when the native helper is missing, so the belt's
// hook is never registered); `facts.resolved === false` marks a roster row known
// only by its hook label. Either makes the belt unavailable rather than a
// control that reports success and never applies (Dexter F2, F3).
let hooksOn;
function beltHtml(agent, facts) {
  const running = (instanceCounts(latestParty).get(agent) || 0) > 0;
  const unavailable = loadoutDisplay.unavailableReason({ hooks: hooksOn, ...facts });
  return loadoutDisplay.html(loadoutDisplay.view(loadoutState, agent, { running, unavailable }));
}
// Called from the roster's ONE card-click handler (below, by paintAgents).
// True when the click was a belt control and has been handled.
function beltClick(target) {
  const btn = target.closest && target.closest('button[data-loadout-toggle], button[data-loadout-act]');
  const action = btn && loadoutDisplay.clickAction(btn.dataset);
  if (!action) return false;
  if (action.kind === 'toggle') {
    loadoutState = loadoutDisplay.toggle(loadoutState, action.agent);
    renderRoster();
    return true;
  }
  // Remember what THIS window asked, so only its own refusal is shown (Dexter F6).
  loadoutState = loadoutDisplay.ask(loadoutState, action);
  try { ws.send(JSON.stringify(loadoutDisplay.controlMessage(action))); } catch { /* not attached */ }
  return true;
}

function countBadgeHtml(agent, counts) {
  // A "×1" is noise -- everyone already assumes one instance. Only a SECOND
  // concurrent run is news.
  const n = counts.get(agent) || 0;
  return n >= 2 ? `<span class="agent-count" title="${n} running now">×${n}</span>` : '';
}

// --- Active/Inactive roster tabs (BACKLOG D #16) -----------------------------
// The split and sort are pure decisions in app/roster-tabs-display.js; this is
// only wiring and HTML assembly, the same division as careerHtml/agentModelHtml
// above.
let activeRosterTab = 'active';
// The WHOLE roster, from the host's background scan across every project --
// `{ ok, agents: [{agent, tokens, portrait}], complete, unreadable }`. `null`
// until the first `hello` or `rosterIndex` message lands.
let rosterIndexPayload = null;

function wholeRosterEntries() {
  return rosterIndexPayload && Array.isArray(rosterIndexPayload.agents) ? rosterIndexPayload.agents : [];
}

function rosterIndexEntry(agent) {
  return wholeRosterEntries().find(a => a.agent === agent);
}

function setRosterTab(tab) {
  activeRosterTab = tab === 'inactive' ? 'inactive' : 'active';
  for (const b of document.querySelectorAll('#roster-subtabs button[data-roster-tab]')) {
    b.classList.toggle('on', b.dataset.rosterTab === activeRosterTab);
  }
  renderRoster();
}

for (const b of document.querySelectorAll('#roster-subtabs button[data-roster-tab]')) {
  b.addEventListener('click', () => setRosterTab(b.dataset.rosterTab));
}

function inactiveRowHtml(row) {
  const entry = rosterIndexEntry(row.agent);
  // The scan is complete AND clean before a total stops being a lower bound --
  // the same "ok, not just done" distinction host/agent-stats.js already draws
  // for the per-project career panel.
  const complete = !!(rosterIndexPayload && rosterIndexPayload.complete && rosterIndexPayload.ok);
  const state = rosterTokenState(row.tokens, complete);
  const tokenHtml = state.show
    ? `<div class="career" title="lifetime tokens across every project"><span class="career-tok">${state.prefix}${compactTokens(row.tokens)}</span></div>`
    : '';
  // Dexter F3 / Miguel L1 (PR #59 review): an agent resolved only through an
  // unresolved hook LABEL is still real history but is not a confirmed
  // `subagent_type` -- the same "?" badge app/career-display.js already draws
  // for the identical situation on the Active-tab career line, not a peer of
  // a real type drawn identically.
  const unresolvedHtml = entry && entry.resolved === false
    ? '<span class="career-warn" title="identity unresolved, this is a label not an agent type">?</span>'
    : '';
  // Dexter N2 (PR #59 R2): "ran, but this pass could not read its transcript"
  // must be VISIBLE, not pixel-identical to a definition that has never run
  // at all -- same hedge-badge language as `unresolvedHtml` above, distinct
  // title so hovering says which uncertainty this is.
  const unreadableHtml = row.unreadable
    ? '<span class="career-warn" title="ran, but a transcript could not be read this pass -- the total is unknown, not zero">?</span>'
    : '';
  // data-agent: a portrait dropped on this face reaches the host, which sets
  // the agent's default portrait for state "inactive" (Miguel I1, PR #35).
  return `<div class="agent" data-state="inactive" data-agent="${escapeHtml(row.agent)}">` +
      `<div class="face">${faceHtml(entry && entry.portrait)}${faceEditHtml()}</div>` +
      `<div class="meta"><div class="name" title="${escapeHtml(row.agent)}">${escapeHtml(row.agent)}` +
        unresolvedHtml + unreadableHtml + `</div>` +
      `<div class="state">inactive</div>` +
      tokenHtml +
      beltHtml(row.agent, { resolved: entry ? entry.resolved : undefined }) +
      `</div>` +
    `</div>`;
}

// --- hide sleeping agents (BACKLOG #14) ---------------------------------------
// Decisions live in app/hidden-agents-display.js. The host owns the persisted
// set and sends it in `hello` and in `hidden` frames; this list is only its
// mirror, and a click sends a request rather than editing it.
let hiddenAgentNames = [];
let showHiddenAgents = false;

function sendRosterAction(action, agent) {
  try { ws.send(JSON.stringify({ type: 'roster', action, agent })); }
  catch { /* not attached */ }
}

// Its own element with a data attribute, never on `.face` (a portrait drop
// target) and never a bare card click. Only a sleeping row is offered "hide";
// a revealed hidden row is offered "unhide" instead.
function hideButtonHtml(r) {
  if (hiddenAgentNames.includes(r.agent)) {
    return `<button type="button" class="agent-hide" data-roster-action="unhide" title="Show this agent in the list again">unhide</button>`;
  }
  return hideButtonFor(r)
    ? `<button type="button" class="agent-hide" data-roster-action="hide" title="Hide this sleeping agent (it comes back when it wakes)">hide</button>`
    : '';
}

// The ONE place #agents' markup is written (Dexter F1). A `processes` frame
// re-renders the roster every second while anything runs; replacing identical
// markup detached a button between its mousedown and mouseup and lost the click.
// `repaintNeeded` (app/hidden-agents-display.js) leaves unchanged markup alone.
let lastAgentsHtml = null;
function paintAgents(html) {
  if (!repaintNeeded(lastAgentsHtml, html)) return;
  lastAgentsHtml = html;
  // Through setRosterHtml, not innerHTML: a live avatar video keeps its node
  // across a repaint, per PR #64. The unchanged-markup skip from PR #66 runs first.
  setRosterHtml(html);
}

// Delegated on #agents, the ONE click handler for the roster's cards. No
// stopPropagation: test/renderer-mouse-passthrough.test.js forbids it on any
// mouse listener. A hide/unhide control is asked about first, via
// `rosterActionFromClick`; only a click that is not one can open a log.
agentsEl.addEventListener('click', (e) => {
  const act = rosterActionFromClick(e.target);
  if (act) { sendRosterAction(act.action, act.agent); return; }
  if (beltClick(e.target)) return;
  // A click anywhere on a card EXCEPT its face or a control inside it opens
  // the log: the face is the portrait drop/upload target. Which agent the
  // click is for is decided in the display module, where it is tested.
  const agent = window.agentLogDisplay.cardClickAgent(e.target);
  if (agent) openAgentLog(agent);
});

document.getElementById('roster-show-hidden').addEventListener('click', () => {
  showHiddenAgents = !showHiddenAgents;
  renderRoster();
});

function renderRoster() {
  const showBtnEl = document.getElementById('roster-show-hidden');
  showBtnEl.hidden = true;   // Active tab only; the Active branch below un-hides it when n > 0
  const { inactive } = splitActiveInactive(wholeRosterEntries().map(a => a.agent), [...roster.keys()]);

  if (activeRosterTab === 'inactive') {
    if (inactive.length === 0) {
      paintAgents('<div class="empty">No other agents known yet.</div>');
      return;
    }
    const rows = sortRosterRows(inactive.map((agent) => {
      const entry = rosterIndexEntry(agent);
      return {
        agent,
        tokens: entry && typeof entry.tokens === 'number' ? entry.tokens : null,
        // Dexter N2 (PR #59 R2): "ran, but unreadable this pass" must sort
        // above a genuine never-used row, not tie with it.
        unreadable: !!(entry && entry.unreadable),
      };
    }));
    paintAgents(rows.map(inactiveRowHtml).join(''));
    return;
  }

  if (roster.size === 0) {
    // Three different situations, not one sentence. "No agents yet" is a
    // positive claim about history and must not be made on a read that failed.
    paintAgents(`<div class="empty">${escapeHtml(rosterEmptyState(roster.size, agentStats, lastAgentStatsPayload))}</div>`);
    return;
  }
  // Active agents first, then alphabetical, so the thing you care about is at
  // the top without the list reshuffling on every tick.
  const rank = { working: 0, stressed: 1, happy: 2, sleeping: 3 };
  const rows = [...roster.values()].sort((a, b) =>
    (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.agent.localeCompare(b.agent));
  const counts = instanceCounts(latestParty);

  // BACKLOG #14. Reconciled here as well as on the host, so no frame ordering
  // ever draws a hide flag on an awake agent. The host stays authoritative:
  // its `hidden` frame replaces this list wholesale.
  hiddenAgentNames = reconcileHidden(hiddenAgentNames, rows).hidden;
  const nHidden = hiddenCount(rows, hiddenAgentNames);
  if (nHidden === 0) showHiddenAgents = false;   // nothing left to reveal
  const shown = visibleRows(rows, hiddenAgentNames, showHiddenAgents);
  showBtnEl.hidden = nHidden === 0;
  showBtnEl.textContent = showHiddenAgents ? `hide hidden (${nHidden})` : `show hidden (${nHidden})`;
  if (shown.length === 0) {
    // True only because awake rows are always in `shown`: what is left is
    // sleeping AND hidden.
    paintAgents('<div class="empty">Every agent here is asleep and hidden.</div>');
    return;
  }

  paintAgents(shown.map(r =>
    `<div class="agent" data-state="${r.state}" data-agent="${escapeHtml(r.agent)}"` +
      (hiddenAgentNames.includes(r.agent) ? ' data-hidden="true"' : '') + `>` +
      hideButtonHtml(r) +
      `<div class="face" data-tier="${escapeHtml((r.portrait && r.portrait.tier) || 'text')}">${faceHtml(r.portrait)}${faceEditHtml()}</div>` +
      `<div class="meta"><div class="name" title="${escapeHtml(r.agent)}">${escapeHtml(r.agent)}` +
        countBadgeHtml(r.agent, counts) + `</div>` +
      `<div class="state">${r.state}</div>` +
      agentModelHtml(r.agent) +
      careerHtml(r.agent) +
      beltHtml(r.agent) +
      `</div>` +
    `</div>`
  ).join(''));
}

function renderRosterIndex(rosterIndex) {
  if (!rosterIndex) return;
  rosterIndexPayload = rosterIndex;
  renderRoster();
}

function renderAgentStats(stats) {
  if (!stats || !Array.isArray(stats.agents)) return;
  // MERGED, not replaced. The decision lives in app/career-display.js so it can
  // be tested; the first version guarded only the rare total-failure branch and
  // let a PARTIAL failed read replace the map, silently deleting every agent
  // whose transcripts lived in the directory that could not be read.
  lastAgentStatsPayload = stats;
  agentStats = mergeAgentStats(agentStats, stats);
  renderRoster();
}

// --- agent activity log (BACKLOG #10) ----------------------------------------
// The decisions (what a frame does to the model, what the model draws, whether
// to keep following the bottom) are pure and live in app/agent-log-display.js;
// this is wiring only. The host reads the transcript the CLI already wrote and
// streams it -- nothing shown here is made up by the window.
const agentLogEl = document.getElementById('agent-log');
let agentLog = window.agentLogDisplay.emptyLog();
// The reader's "show hidden rows" choice, kept across closing and reopening a log.
let agentLogShowUnknown = false;

function renderAgentLogPanel() {
  if (!agentLogEl) return;
  const panel = agentLogEl.closest('.panel');
  if (panel) panel.classList.toggle('logging', agentLog.open);
  // Appends rows to what is on screen when it can (so a text selection
  // survives a live log), rebuilds otherwise, and keeps the reader's scroll
  // place -- all in the display module's paint function.
  window.agentLogDisplay.paint(agentLogEl, agentLog);
}

function sendAgentLog(action, agent) {
  try { ws.send(JSON.stringify({ type: 'agent-log', action, agent })); }
  catch { /* not attached: the reattach in ws.onopen asks again */ }
}

function openAgentLog(agent) {
  agentLog = window.agentLogDisplay.openLog(agent, agentLogShowUnknown);
  renderAgentLogPanel();
  sendAgentLog('open', agent);
}

function closeAgentLog() {
  if (agentLog.open) sendAgentLog('close', agentLog.agent);
  agentLog = window.agentLogDisplay.closeLog();
  renderAgentLogPanel();
}


if (agentLogEl) {
  agentLogEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-agent-log-close]')) closeAgentLog();
    if (e.target.closest('[data-agent-log-unknown]')) {
      agentLog = window.agentLogDisplay.toggleUnknown(agentLog);
      agentLogShowUnknown = agentLog.showUnknown;
      renderAgentLogPanel();
    }
  });
}

function handleAgentLogFrame(msg) {
  const next = window.agentLogDisplay.applyFrame(agentLog, msg);
  if (next === agentLog) return;       // not for the open log: nothing to redraw
  agentLog = next;
  renderAgentLogPanel();
}

// --- model browser -----------------------------------------------------------
// Every OpenRouter model, and up to three council seats.
//
// This panel's job is to be honest about three things the catalogue makes easy
// to get wrong: prices are quoted PER TOKEN and read as $0.00 if shown raw; an
// UNPRICED model is not a free one; and a model without tool support cannot
// drive the main session at all -- picking one breaks Agent, the hooks and
// structured output together, in a way that looks like the harness being broken
// rather than the model being unsuitable.

let catalogue = [];
let catalogueMeta = null;
let councilSeats = [];
let seatMax = 3;
let councilWarnings = [];
// BACKLOG E #5. Favourites: app/models-favourites.js decides shape and
// ordering; this is only the last answer main handed back (or the empty
// shape until it does). Refresh: true from the click that sent `force`
// until the REPLY THAT ANSWERS IT clears it (app/models-catalogue.js's
// shouldClearPending) -- app/models-refresh.js decides what the button says
// from this one flag.
//
// `modelsRequestSeq` / `refreshRequestSeq`: Dexter, PR #60 round 2, N1/N2.
// Every `requestModels()` call carries a fresh, strictly-increasing `seq`,
// echoed back verbatim by the host in its reply (host.js's 'models' branch).
// That is the ONLY thing `shouldClearPending`/`mergeCatalogueReply` trust to
// tell "the reply to MY click" apart from "some other request's reply" --
// fetchedAt cannot do this, because a FAILED reply's fetchedAt is the age of
// a fallback cache, not the age of the request that just ran (N1), and an
// unrelated OLDER request (the boot warm-up, a stale tab-open) can still
// resolve or fail AFTER a newer click was made (N2).
let modelFavourites = emptyFavourites();
let modelsRefreshPending = false;
let modelsRequestSeq = 0;
let refreshRequestSeq = null;

const money = (perM) => {
  if (perM === null || perM === undefined) return null;
  if (perM === 0) return 'free';
  // Never fewer than two significant figures. $0.60/M and $0.00025/M must not
  // both render as $0.00, which is what would make the catalogue price-blind.
  if (perM >= 1) return '$' + perM.toFixed(2);
  if (perM >= 0.01) return '$' + perM.toFixed(3);
  return '$' + perM.toPrecision(2);
};

const ctxLabel = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));

function renderSeats() {
  const list = document.getElementById('seat-list');
  const count = document.getElementById('seat-count');
  const warn = document.getElementById('seat-warnings');
  if (!list || !count || !warn) return;

  count.textContent = councilSeats.length + '/' + seatMax;
  list.innerHTML = councilSeats.length
    ? councilSeats.map(st =>
        '<div class="seat"><span class="seat-name" title="' + escapeHtml(st.id) + '">' +
        escapeHtml(st.name || st.id) + '</span>' +
        '<span class="seat-provider">' + escapeHtml(st.provider || '') + '</span>' +
        '<button data-unseat="' + escapeHtml(st.id) + '" title="Remove this seat">x</button></div>').join('')
    : '<div class="none">no seats yet</div>';

  warn.innerHTML = councilWarnings
    .map(w => '<div class="seat-warn">' + escapeHtml(w) + '</div>').join('');
}

function renderProvenance() {
  const el = document.getElementById('model-provenance');
  const textEl = el && el.querySelector('.prov-text');
  if (el && catalogueMeta) {
    el.classList.toggle('stale', !!catalogueMeta.stale);
    if (textEl) {
      if (catalogueMeta.source === 'none') {
        textEl.textContent = 'could not reach OpenRouter - ' + (catalogueMeta.error || 'no catalogue');
      } else {
        const mins = catalogueMeta.fetchedAt
          ? Math.max(0, Math.round((Date.now() - catalogueMeta.fetchedAt) / 60000))
          : null;
        const when = mins === null ? 'unknown age'
          : mins < 1 ? 'just now'
            : mins < 60 ? mins + ' min ago'
              : Math.round(mins / 60) + ' h ago';
        // Staleness is STATED, never implied. A month-old price shown as
        // current is the failure here that actually costs money.
        textEl.textContent = catalogueMeta.stale
          ? 'PRICES MAY BE OUT OF DATE - cached ' + when + ', could not refresh (' +
            (catalogueMeta.error || 'offline') + ')'
          : catalogue.length + ' models, ' + when;
      }
    }
  }
  renderRefreshButton();
}

// BACKLOG E #5, step 2. Pure decision lives in app/models-refresh.js; this is
// the DOM write, same split as renderTopBar/topBarDisplay.
function renderRefreshButton() {
  const btn = document.getElementById('model-refresh');
  if (!btn) return;
  const state = refreshButtonState({ pending: modelsRefreshPending, catalogueMeta });
  btn.disabled = state.disabled;
  btn.textContent = state.label;
  btn.title = state.title;
}

function renderModels() {
  const el = document.getElementById('model-list');
  if (!el) return;
  const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
  const target = val('model-target') || 'council';
  const search = val('model-search') || '';
  const sort = val('model-sort') || 'price';
  const freeEl = document.getElementById('model-free');
  const freeOnly = !!(freeEl && freeEl.checked);

  // An empty list is ambiguous on its own -- "still loading", "nothing
  // matched" and "the fetch failed" all render as nothing. Each is said.
  if (!catalogue.length) {
    el.innerHTML = catalogueMeta
      ? '<div class="none">' + escapeHtml(catalogueMeta.error || 'no models returned') + '</div>'
      : '<div class="none">loading the catalogue\u2026</div>';
    return;
  }

  let rows = catalogue;
  // Only the SESSION target restricts by tools: a model that cannot call one
  // can still hold an opinion, and excluding it would shrink the very
  // diversity the council exists for.
  if (target === 'session') rows = rows.filter(m => m.tools);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(m => m.id.toLowerCase().indexOf(q) !== -1 ||
                            m.name.toLowerCase().indexOf(q) !== -1);
  }
  if (freeOnly) rows = rows.filter(m => m.free);

  if (!rows.length) {
    el.innerHTML = '<div class="none">nothing matches that filter</div>';
    return;
  }

  const byId = (a, b) => a.id.localeCompare(b.id);
  const within = (a, b) => {
    if (sort === 'context') return b.context - a.context || byId(a, b);
    if (sort === 'price') {
      // Unpriced sorts LAST. Treating it as zero would put the models whose
      // cost is unknown at the top of the cheap list, which is the one place
      // they must never be.
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      if (!a.priced) return byId(a, b);
      return (a.promptPerM - b.promptPerM) || (a.completionPerM - b.completionPerM) || byId(a, b);
    }
    return byId(a, b);
  };

  const seated = {};
  for (const st of councilSeats) seated[st.id] = true;

  const renderRow = (m) => {
    const price = m.priced ? money(m.promptPerM) + ' / ' + money(m.completionPerM) : 'price unknown';
    // The short name inside a provider group: the prefix is the heading.
    const short = m.id.indexOf('/') > 0 ? m.id.slice(m.id.indexOf('/') + 1) : m.id;
    const tip = m.name + ' -- ' + m.id + ' -- ' +
      (m.tools ? 'supports tools' : 'NO tool support, cannot drive the main session');
    const starred = isFavourite(modelFavourites, 'openrouter', m.id);
    return '<div class="model' + (seated[m.id] ? ' seated' : '') + '" data-model="' +
      escapeHtml(m.id) + '" title="' + escapeHtml(tip) + '">' +
      '<button type="button" class="m-star' + (starred ? ' starred' : '') + '" data-star="' +
        escapeHtml(m.id) + '" title="' + (starred ? 'unfavourite' : 'favourite') + ' ' + escapeHtml(m.id) + '">' +
        (starred ? '★' : '☆') + '</button>' +
      '<span class="m-id">' + escapeHtml(short) + '</span>' +
      (m.tools ? '' : '<span class="m-notools">no tools</span>') +
      '<span class="m-ctx">' + ctxLabel(m.context) + '</span>' +
      '<span class="m-price' + (m.priced ? '' : ' unknown') + '">' + escapeHtml(price) + '</span>' +
      '</div>';
  };

  // Capped across the whole list, not per group: 445 rows of DOM per keystroke
  // stutters. The line underneath says what is hidden rather than letting the
  // list imply it is complete.
  const LIMIT = 200;
  let drawn = 0;
  const out = [];

  // Favourites (BACKLOG E #5, #3): their OWN section at the very top of the
  // whole list, ahead of the provider grouping -- a star must never end up
  // buried inside its provider's own price/context position. Sorted by the
  // same comparator as everything else, so "cheapest" orders this section too.
  //
  // Miguel, PR #60 review, S2: capped by the SAME `LIMIT` as the grouped
  // section below, not exempt from it -- 200+ favourited rows would stutter a
  // keystroke exactly as 200+ ungrouped ones would, and the cap exists for
  // the DOM cost, which does not care which section a row is in.
  const { favourites: favRows, rest: restRows } = partitionFavourites(rows, modelFavourites.openrouter, (m) => m.id);
  if (favRows.length) {
    favRows.sort(within);
    out.push('<div class="provider"><span class="p-name">★ favourites</span>' +
      '<span class="p-count">' + favRows.length + '</span></div>');
    for (const m of favRows) {
      if (drawn >= LIMIT) break;
      out.push(renderRow(m));
      drawn++;
    }
  }

  // GROUPED BY PROVIDER. 445 flat rows is a wall; the provider is also the unit
  // the council actually cares about, since two models from one vendor share
  // failure modes. Groups are ordered by their best member under the chosen
  // sort, so "cheapest" still puts the cheapest provider first rather than
  // alphabetising them and burying it. Built from `restRows`, not `rows` --
  // a favourited model lives ONLY in the favourites section above, never
  // duplicated into its provider's group too.
  const groups = new Map();
  for (const m of restRows) {
    const key = m.provider || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const list of groups.values()) list.sort(within);
  const ordered = [...groups.entries()].sort((a, b) => within(a[1][0], b[1][0]));

  for (const [provider, list] of ordered) {
    if (drawn >= LIMIT) break;
    const take = list.slice(0, LIMIT - drawn);
    drawn += take.length;
    out.push('<div class="provider"><span class="p-name">' + escapeHtml(provider) +
      '</span><span class="p-count">' + list.length + '</span></div>');
    for (const m of take) out.push(renderRow(m));
  }
  if (rows.length > drawn) {
    out.push('<div class="none">' + (rows.length - drawn) + ' more, narrow the search</div>');
  }
  el.innerHTML = out.join('');
}

// Returns the `seq` this request was tagged with -- the caller (the Refresh
// click, ws.onopen's resume) uses it to know which reply, if any, is really
// its answer. Assigned and sent even if the socket turns out to be closed:
// the seq is spent either way, and a caller tracking it as "the request I'm
// waiting on" is correct even for a send that never left the client (F3's
// resume path re-requests with a fresh seq of its own, superseding this one).
function requestModels(force) {
  const seq = ++modelsRequestSeq;
  try { ws.send(JSON.stringify({ type: 'models', force: !!force, seq })); } catch (e) {}
  return seq;
}

// BACKLOG E #5, #3. Flips `kind`/`id` locally (so the star responds at once)
// and sends the DESIRED end state through the bridge -- see
// app/favourites-bridge.js. Dexter, PR #60 review, F6: sending "toggle"
// instead of the state this click actually wants would let a second window's
// staler view invert the click the moment the two windows disagree, since a
// toggle is computed against whatever the STORE currently holds rather than
// what this window is reacting to.
function toggleModelFavourite(kind, id) {
  const before = modelFavourites;
  const on = !isFavourite(before, kind, id);
  modelFavourites = setFavourite(before, kind, id, on);
  if (kind === 'claude') renderClaudeChoices(); else renderModels();
  if (!(window.harness && window.harness.favourites)) return;
  window.harness.favourites.set(kind, id, on).then((f) => {
    // Dexter F7: a save that could not be written (disk full, EPERM) answers
    // `null`. Rolling the optimistic star back to what it was before this
    // click keeps the screen honest -- a star nobody could save must not
    // outlive the click that drew it, only to silently vanish on restart.
    modelFavourites = f ? normalizeFavourites(f) : before;
    if (kind === 'claude') renderClaudeChoices(); else renderModels();
  }).catch(() => {
    modelFavourites = before;
    if (kind === 'claude') renderClaudeChoices(); else renderModels();
  });
}

function wireModelPanel() {
  const ids = ['model-search', 'model-target', 'model-sort', 'model-free'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderModels);
  }
  const list = document.getElementById('model-list');
  if (list) {
    list.addEventListener('click', (e) => {
      // Checked FIRST: the star sits INSIDE the `.model` row, so
      // `closest('[data-model]')` would also match a click on the star.
      const star = e.target.closest('[data-star]');
      if (star) { toggleModelFavourite('openrouter', star.dataset.star); return; }
      const row = e.target.closest('[data-model]');
      if (!row) return;
      const m = catalogue.find(x => x.id === row.dataset.model);
      if (!m) return;
      // Clicking a seated model unseats it, so one control does both and the
      // list needs no second affordance.
      const isSeated = councilSeats.some(st => st.id === m.id);
      try {
        ws.send(JSON.stringify(isSeated
          ? { type: 'seat', action: 'remove', id: m.id }
          : { type: 'seat', action: 'add', model: m }));
      } catch (err) {}
    });
  }
  const seats = document.getElementById('seat-list');
  if (seats) {
    seats.addEventListener('click', (e) => {
      const b = e.target.closest('[data-unseat]');
      if (!b) return;
      try { ws.send(JSON.stringify({ type: 'seat', action: 'remove', id: b.dataset.unseat })); } catch (err) {}
    });
  }
  // BACKLOG E #5, step 2: the Refresh button. Guarded against a second click
  // while the first request is still in flight -- app/models-refresh.js's
  // refreshButtonState already disables the DOM button for the same reason,
  // this is the belt to that braces in case a click lands before the render.
  const refreshBtn = document.getElementById('model-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (modelsRefreshPending) return;
      modelsRefreshPending = true;
      renderRefreshButton();
      refreshRequestSeq = requestModels(true);
    });
  }
}

// --- project HP -------------------------------------------------------------
// One bar, one meaning: pass rate. The label says so, because a composite
// number gets quoted as though it included coverage and lint.
const HP_STATES = ['healthy', 'hurt', 'critical', 'unknown'];

function renderHealth(h) {
  const el = document.getElementById('hp');
  if (!el || !h) return;
  el.classList.add('show');
  el.classList.remove(...HP_STATES, 'running');
  el.classList.add(HP_STATES.includes(h.state) ? h.state : 'unknown');
  if (h.running) el.classList.add('running');

  const pct = h.fraction === null || h.fraction === undefined
    ? 0 : Math.round(h.fraction * 100);

  const label = h.running ? 'running…'
    : h.state === 'unknown'
      ? (h.runner ? 'no result yet' : 'no test suite')
      : `${h.passed}/${h.total}`;

  el.innerHTML = `<span>HP</span><span class="track"><span class="fill"></span></span>` +
                 `<span class="num">${escapeHtml(label)}</span>`;
  el.querySelector('.fill').style.width = pct + '%';

  el.title = h.state === 'unknown' && !h.runner
    ? 'No recognisable test suite in this project'
    : `Pass rate only — ${h.passed || 0} passed, ${h.failed || 0} failed` +
      (h.tookMs ? ` in ${(h.tookMs / 1000).toFixed(1)}s` : '') +
      '. Click to run the suite.';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#hp')) return;
  try { ws.send(JSON.stringify({ type: 'health' })); } catch {}
});

// --- cooldowns ---------------------------------------------------------------
// Advisory, never blocking. The point is to make a cost visible, not to
// overrule a deliberate decision, so this is a note rather than a barrier.
let cooldownState = [];

function renderCooldowns(list) {
  // Stamp the arrival time. Without it the first interval subtracts
  // `now - (c._tick || now)` === 0, so an agent whose cooldown has already
  // expired keeps displaying "1m" for another 15-30 seconds -- in a widget
  // whose whole purpose is to be honest between broadcasts.
  if (Array.isArray(list)) {
    const at = Date.now();
    cooldownState = list.map(c => ({ ...c, _tick: at }));
  }
  const el = document.getElementById('cooldowns');
  if (!el) return;
  if (!cooldownState.length) { el.innerHTML = ''; return; }

  const html = '<h3>Cooling down</h3>' + cooldownState.map(c => {
    const left = Math.max(0, c.remainingMs);
    const frac = c.durationMs ? Math.max(0, Math.min(1, left / c.durationMs)) : 0;
    const mins = Math.ceil(left / 60000);
    return `<div class="cool"><span class="who" title="${escapeHtml(c.agent)}">${escapeHtml(c.agent)}</span>` +
           `<span class="bar"><i style="width:${(frac * 100).toFixed(0)}%"></i></span>` +
           `<span class="left">${mins}m</span></div>`;
  }).join('');
  // Rewriting identical HTML every 15s kills any tooltip open mid-hover.
  if (el.innerHTML !== html) el.innerHTML = html;
}

// Counted down locally so the remaining time is honest between broadcasts;
// the host stays the source of truth for what is ON cooldown.
setInterval(() => {
  if (!cooldownState.length) return;
  const now = Date.now();
  cooldownState = cooldownState
    .map(c => ({ ...c, remainingMs: c.remainingMs - (now - (c._tick || now)), _tick: now }))
    .filter(c => c.remainingMs > 0);
  renderCooldowns();
}, 15000);

// --- token spend ------------------------------------------------------------
const usageEl = document.getElementById('usage');

// Compact, because this sits in a header: 1.2M / 984k / 512.
// NOTE: duplicated from host/milestones.js because the renderer has no module
// system. Both copies round INSIDE the unit -- the naive version emitted
// "1000k" for 999_950, longer than the number it abbreviates.
function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (v < size) continue;
    const scaled = Number((v / size).toFixed(1));
    if (scaled >= 1000 && i > 0) {
      const [bigger, biggerSuffix] = units[i - 1];
      return String(Number((v / bigger).toFixed(1))) + biggerSuffix;
    }
    return String(scaled) + suffix;
  }
  return String(Math.round(v));
}

function renderUsage(usage) {
  if (!usage) return;
  const { session, project } = usage;

  // HOW WELL the figure is known, not just what it is. host/usage.js
  // distinguishes "not read yet" and "could not read one of them" from zero at
  // some length, and this function used to discard all of it and print a
  // confident number -- so an attach before the first read drew
  // "session 0 - project 0 - 0 sessions" for a project with a billion tokens
  // in it. See app/usage-display.js.
  const how = usageDisplay(usage);

  // Cache reads dominate the raw total -- they were ~99% of it when this was
  // built -- so "fresh" (input + output) is shown alongside it. A single
  // headline number here would read as runaway spend when almost all of it is
  // cheap cache traffic.
  // FF1: the headline is what was SPENT. `total` also carries cacheWrite and
  // cacheRead, and cacheRead alone was 98% of it -- the same context counted
  // again every turn, which made the number track turns rather than work. Both
  // helpers live in app/usage-display.js, where they can be tested.
  const spend = s => window.spendOf(s);
  const written = s => window.cacheWriteOf(s);
  const cached = s => window.cacheReadOf(s);
  // The full four-way breakdown lives HERE, which is what lets the visible row
  // stay short. Naomi measured FF1's first version adding 285px to a header
  // that already overflowed by 60 at the app's own default 1200x800 window --
  // clipped, not ellipsized, so the tail simply vanished along with both
  // keyboard hints. Cache READ is the figure Ricardo explicitly does not want
  // ("the inflated number should disappear"), so it is the one that moves to
  // the tooltip; cache WRITE stays visible because it is genuinely billed.
  const detail = s =>
    `in ${s.input.toLocaleString()} - out ${s.output.toLocaleString()} - ` +
    `cache write ${s.cacheWrite.toLocaleString()} - cache read ${s.cacheRead.toLocaleString()}`;

  // A placeholder replaces the number entirely; a prefix qualifies it.
  const num = n => (how.placeholder !== null ? how.placeholder : how.prefix + compact(n));
  const title = base => (how.note ? `${base} - ${how.note}` : base);
  const sub = inner => (how.placeholder !== null ? '' : inner);

  usageEl.className = 'usage-' + how.state;
  usageEl.innerHTML =
    `<span class="grp" title="${title(`This session - ${detail(session)}`)}">` +
      `<span class="lbl">session</span>` +
      `<span class="val">${num(spend(session))}</span>` +
      `<span class="sub">${sub(`+${compact(written(session))} cache`)}</span>` +
    `</span>` +
    `<span class="grp" title="${title(`Every session on this folder - ${detail(project)}`)}">` +
      `<span class="lbl">project</span>` +
      `<span class="val">${num(spend(project))}</span>` +
      `<span class="sub">${sub(`${project.sessions} session${project.sessions === 1 ? '' : 's'} · +${compact(written(project))} cache`)}</span>` +
    `</span>` +
    // Said out loud, not only in a tooltip. A status nobody can see is the
    // defect this whole change exists to fix.
    (how.note ? `<span class="grp note" title="${how.note}">${how.note}</span>` : '') +
    milestoneHtml(usage.milestone);
}

// --- plan quota ---------------------------------------------------------------
// The fuel gauge, as opposed to the odometer beside it. Every judgement about
// HOW to draw it lives in app/quota-display.js so it can be tested; this only
// turns that decision into markup.
const quotaEl = document.getElementById('quota');
let lastQuotaPayload = null;

function renderQuota(quota) {
  if (quota !== undefined) lastQuotaPayload = quota;
  const d = quotaDisplay(lastQuotaPayload);

  if (d.state !== 'ready') {
    // No bars. Three tracks sitting at zero would claim the plan is untouched,
    // which is precisely what we do not know here.
    quotaEl.innerHTML = `<span class="none" title="${escapeHtml(d.note || '')}">${escapeHtml(d.note || '')}</span>`;
    return;
  }

  quotaEl.innerHTML = d.meters.map(m =>
    `<span class="meter tone-${m.tone}${m.isActive ? ' active' : ''}" title="${escapeHtml(m.title)}">` +
      `<span class="lbl">${escapeHtml(m.label)}</span>` +
      `<span class="track"><span class="fill" style="width:${m.fill}%"></span></span>` +
      `<span class="pct">${escapeHtml(m.text)}</span>` +
    `</span>`
  ).join('');
}

// The countdown in every tooltip goes stale on its own, with no message from
// the host -- so it is recomputed locally. Cheap: it re-renders from the last
// payload and makes no request.
setInterval(() => { if (lastQuotaPayload) renderQuota(); }, 30000);

// A COUNTER, NEVER A LIMIT. The bar fills toward the next milestone; it never
// depletes an allowance, never goes red, and never warns. The same geometry
// labelled "remaining" would read as a leash, and the harness has no business
// rationing someone's own subscription.
function milestoneHtml(m) {
  if (!m) return '';
  const reached = m.reached;
  const next = m.next;
  // Clamped AND finite-checked. `width:NaN%` is an invalid declaration the
  // browser drops, and .fill has no other width, so it took auto width and
  // filled the whole track -- a broken value reading as "complete".
  const raw = Number(m.progress);
  const safe = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const pct = Math.round(safe * 100);

  // The cache share travels with it, because it is most of the total: ~97M of
  // 119M on this project. A milestone celebrating a number that is 80% cache
  // reads should say so rather than imply that much fresh spend.
  const share = m.spend && m.spend.cacheShare
    ? ` · ${Math.round(m.spend.cacheShare * 100)}% cache`
    : '';
  // NAMES ITS OWN SUBJECT. Dexter, PR #33, Finding 2: this badge is computed
  // from `usage.project.total` -- ALL token traffic, cache reads included --
  // while the headline beside it, in this same element, now shows spend only.
  // On real figures those are 1.76B and 35.3M: one line appearing to
  // contradict itself by 50x. Two numbers measuring different things is fine;
  // two numbers measuring different things while looking like one number is
  // the displayed-value-that-does-not-describe-its-subject defect this
  // codebase is built around avoiding.
  //
  // Saying what it counts is the honest fix available tonight. Re-keying the
  // ladder to spend is the REAL fix and is a product decision -- its top rung
  // is 10 billion, which only makes sense against the inflated figure, so
  // recalibrating would move this project down two full rungs. That belongs to
  // Ricardo, not to a review round, and is recorded in the build log.
  const title = (reached ? `${reached.name} reached. ` : '')
    + (next ? `${compact(next.at)} for ${next.name}.` : 'Top of the ladder.')
    + share
    + ' · counts ALL tokens including cache reads, unlike the spend figure beside it.';

  return `<span class="grp milestone" title="${escapeHtml(title)}">` +
           `<span class="icon">${escapeHtml(reached ? reached.icon : '·')}</span>` +
           `<span class="track"><span class="fill" style="width:${pct}%"></span></span>` +
         `</span>`;
}

// The flourish. An EVENT, not a value -- folding it into the usage payload
// (which is re-sent every few seconds) would replay the celebration forever.
let activeFlourish = null;

function flourish(milestone) {
  if (!milestone) return;
  // One at a time. Two are position:fixed at the same coordinates and
  // composite into unreadable overlap; nothing caps how many can queue.
  if (activeFlourish) {
    clearTimeout(activeFlourish.show);
    clearTimeout(activeFlourish.hide);
    activeFlourish.el.remove();
    activeFlourish = null;
  }
  const el = document.createElement('div');
  el.className = 'flourish';
  el.innerHTML = `<span class="icon">${escapeHtml(milestone.icon)}</span>` +
                 `<span class="name">${escapeHtml(milestone.name)}</span>`;
  document.body.appendChild(el);
  // Long enough to notice, short enough not to sit over the terminal.
  const show = setTimeout(() => el.classList.add('go'), 50);
  const hide = setTimeout(() => {
    el.remove();
    if (activeFlourish && activeFlourish.el === el) activeFlourish = null;
  }, 4200);
  activeFlourish = { el, show, hide };
}

// `custom`: the project's own image rather than the generated art. Only a
// custom image gets the darkness veil -- the generated SVG bakes its own dim.
// `version` busts the image cache: a replaced background.png keeps its name.
function applyBackground(filePath, { custom = false, version = '' } = {}) {
  if (!filePath) return;
  // encodeURI, then the two characters it leaves alone that a path can hold
  // and a URL cannot: a project under "C:\a#b" must not lose half its path.
  const encoded = encodeURI(String(filePath).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
  backgroundUrl = 'file:///' + encoded + (version ? '?v=' + encodeURIComponent(version) : '');
  document.getElementById('bg').style.backgroundImage = `url("${backgroundUrl}")`;
  document.body.classList.add('has-bg');
  document.body.classList.toggle('has-custom-bg', !!custom);

  // The WebGL renderer does not composite a transparent background correctly:
  // cells carrying an explicit ANSI background render as opaque boxes, which
  // turned the status line into a row of grey slabs. The canvas fallback
  // handles transparency properly, and this terminal's output volume never
  // needed WebGL anyway.
  if (webglAddon) {
    try { webglAddon.dispose(); } catch {}
    webglAddon = null;
    console.info('[renderer] WebGL disabled: incompatible with a transparent background');
  }
}

// --- running processes ------------------------------------------------------
const procListEl = document.getElementById('proclist');

function humanElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  return min + 'm ' + String(sec % 60).padStart(2, '0') + 's';
}

function renderProcesses(running) {
  if (!running || running.length === 0) {
    procListEl.innerHTML = '<div class="none">nothing running</div>';
    return;
  }
  // A label is a Bash command: untrusted text, never markup (Dexter F5). Nested,
  // not top-level, because renderer.js shares one global scope with the other
  // plain scripts -- see CLAUDE.md.
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  procListEl.innerHTML = running.map(p => {
    // "stale": ended because its agent or turn finished, while its own close
    // event never arrived. Shown briefly rather than dropped, so a lost event
    // is visible instead of silently recurring.
    const stale = p.state === 'stale';
    const cls = stale ? ' stale' : (p.elapsedMs >= 60000 ? ' slow' : '');
    return '<div class="proc' + cls + '"><span class="dot"></span>' +
           '<span class="lbl" title="' + esc(p.tool + ': ' + p.label) +
             (stale ? ' (ended; its own finish event never arrived)' : '') + '">' + esc(p.label) + '</span>' +
           '<span class="el">' + (stale ? 'ended (stale)' : humanElapsed(p.elapsedMs)) + '</span></div>';
  }).join('');
}

// --- zone sizes (layout pass L1) ---------------------------------------------
// Every zone resizes from its inner edge (the old roster grip, for all four).
// The SIZE POLICY lives in app/dock-layout.js (minimums, the terminal's room,
// shrinking with the window) and the portrait size follows the Agents zone in
// app/dock-zones-display.js; nothing here decides either.
//
// While a grip is dragged the layout is DRAWN (dragLayout) but not saved; the
// one write happens on release. A store write per mousemove frame is what let
// the old width ratchet run frame by frame (Miguel, A18).
(function initZoneGrips() {
  let dragging = null;     // { zone, grip, el }
  document.getElementById('body').addEventListener('mousedown', (e) => {
    const grip = e.target.closest('.zone-grip');
    if (!grip) return;
    const el = grip.closest('.zone');
    dragging = { zone: el.dataset.zone, grip, el };
    grip.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Measured from the zone's own anchored edge, not the window's: the
    // diagnostics pane can sit between the right zone and the window edge.
    const px = window.dockZones.dragSize(dragging.zone, { x: e.clientX, y: e.clientY },
      dragging.el.getBoundingClientRect());
    if (px === null) return;
    dragLayout = DL.setSize(dragLayout || effectiveLayout(), dragging.zone, px);
    renderLayout();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging.grip.classList.remove('dragging');
    dragging = null;
    const l = dragLayout;
    dragLayout = null;
    if (l) commitPlacement(l);     // the one real choice, saved once
  });
})();

// The window changing size re-fits the zones, never saving: the stored sizes
// are what the user dragged, so widening the window gives them back. Coalesced
// to one frame -- a window drag fires `resize` continuously.
let resizePending = false;
window.addEventListener('resize', () => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    renderLayout();
  });
});

// --- attention --------------------------------------------------------------
// A visible cue in the window as well as the OS toast, so the reason is still
// there when you come back and the toast has gone.
function flashAttention(msg) {
  const dot = document.getElementById('dot');
  if (!dot) return;
  dot.classList.add(msg.urgent ? 'wants-input' : 'just-finished');
  setTimeout(() => dot.classList.remove('wants-input', 'just-finished'), 12000);
  document.title = (msg.urgent ? '● ' : '') + msg.title;
}

window.addEventListener('focus', () => {
  const dot = document.getElementById('dot');
  if (dot) dot.classList.remove('wants-input', 'just-finished');
  document.title = 'claude-custom';
});

// --- top bar: model / effort -------------------------------------------------
// FF12. Model and effort are CONTROLS, not labels: clicking either opens a
// small picker, and choosing an option types the matching slash command into
// the pty via the `{type:'input'}` control message -- exactly as a human
// would (see host/control.js's `input` branch). The panel then shows a
// PENDING state until the truth arrives and NEVER flips optimistically --
// app/top-bar-display.js's pendingResolver only reaches "applied" from a
// matching truth message, never from the timeout alone.
const tbModelEl = document.getElementById('tb-model');
const tbEffortEl = document.getElementById('tb-effort');
const tbModelMenu = document.getElementById('tb-model-menu');
const tbEffortMenu = document.getElementById('tb-effort-menu');
const tbModelCustom = document.getElementById('tb-model-custom');

// The model chip reads `liveModel` -- the statusLine's exact id
// (host/status-relay.js), fresh ~1s after a /model -- and falls back to #34's
// transcript-derived session model only until the first status document
// arrives. That fallback is the LAST ASSISTANT LINE, blind to a switch until
// the next reply (Dexter #2), so it is displayed but never confirms a switch.
// Both null is absence, rendered "—", never a guess. `currentTheme` is cached
// only so a model change can recompute the accent without the next `hello`.
let liveModel = null;
let sessionModelFallback = null;
let currentEffort = null;
let currentTheme = null;
let pendingModel = null;    // { kind:'model', value, startedAt } | null
let pendingEffort = null;
// What a chip says about a switch that timed out or was never sent (Dexter
// #9), until the next request or NOTICE_MS.
const tbNotices = { model: null, effort: null };
const tbNoticeTimers = { model: null, effort: null };
// Whether each notice is a TIMEOUT, whose "the session reports X" a later
// truth makes stale (Dexter r2 N5). A refusal says why nothing was sent, which
// no truth changes.
const tbNoticeIsTimeout = { model: false, effort: false };
// Vim mode seen on this session: its INSERT marker has been on screen. Only
// then can a box without the marker be read as NORMAL (verify/probe-vim-mode.js).
let vimSeen = false;
// Fed from the terminal's OUTPUT (Dexter #51 F1): learned only on a click,
// "vim on, Esc, first click" still read 'ready'. Once latched it costs nothing.
term.onWriteParsed(() => {
  if (!vimSeen && vimInsertShown(screenLines())) vimSeen = true;
});
const NOTICE_MS = 12000;

const currentModel = () => liveModel || sessionModelFallback;

// BACKLOG #6: the context-fill circle. `ctx` is the host's { used, size } off
// the statusLine document, or null -- and null (or anything contextFill cannot
// trust) draws as UNKNOWN, a class of its own, never as a colour. Colours and
// step edges live in app/context-fill-display.js and the .ctx-* CSS.
const tbContextEl = document.getElementById('tb-context');
// (the class/title/aria painting is app/context-fill-display.js's
// applyContextFill, so a fake element can test it)
function renderContextFill(ctx) {
  applyContextFill(tbContextEl, ctx);
}

function renderTopBar() {
  const state = topBarState({
    model: currentModel(), effort: currentEffort,
    pendingModel, pendingEffort, theme: currentTheme, notices: tbNotices,
  });
  topBarDisplay({ modelEl: tbModelEl, effortEl: tbEffortEl }, state);
  applyModelAccent(state.model.family, currentTheme);
}

// The colour cue lives on a CSS var so the header chips and the active
// side-tab underline pick it up for free; xterm's cursor is separate JS state
// (`term.options.theme`) and needs telling directly. Untinted (no family
// known), the cursor is left exactly as the theme itself configured it --
// "untinted" means unmodified, not "coincidentally equal to the accent".
function applyModelAccent(family, theme) {
  const accent = cueColour(family, theme);
  document.documentElement.style.setProperty('--model-accent', accent);
  const themeCursor = theme && theme.terminal && theme.terminal.cursor;
  const cursor = family ? accent : (themeCursor || accent);
  term.options.theme = { ...term.options.theme, cursor };
}

function setTopBarNotice(kind, text, isTimeout) {
  tbNotices[kind] = text || null;
  tbNoticeIsTimeout[kind] = !!(text && isTimeout);
  clearTimeout(tbNoticeTimers[kind]);
  if (text) {
    tbNoticeTimers[kind] = setTimeout(() => { tbNotices[kind] = null; renderTopBar(); }, NOTICE_MS);
  }
}

// A new truth makes a timeout's "the session reports X" out of date.
function clearStaleNotice(kind) {
  if (tbNoticeIsTimeout[kind]) setTopBarNotice(kind, null);
}

function setPending(kind, pending) {
  if (kind === 'model') pendingModel = pending; else pendingEffort = pending;
}

// A switch that never hears back (refused, unrecognised, or a
// model-switch-blocked confirmation nobody answers) must still resolve to
// something rather than pulse forever. RE-ARMED until the request it was set
// for resolves (Dexter #8): with the wall clock stepped back the resolver
// says "not yet", and a one-shot timer then left the chip pulsing forever.
function schedulePendingTimeout(kind, request) {
  const remaining = request.startedAt + PENDING_TIMEOUT_MS - Date.now();
  const delay = Math.min(PENDING_TIMEOUT_MS, Math.max(250, remaining + 50));
  setTimeout(() => {
    const pending = kind === 'model' ? pendingModel : pendingEffort;
    if (pending !== request) return;   // resolved, or superseded by a newer request
    const res = pendingResolver(pending,
      { type: 'timeout', kind, now: Date.now(), timeoutMs: PENDING_TIMEOUT_MS });
    if (res.pending) { schedulePendingTimeout(kind, request); return; }
    setPending(kind, null);
    setTopBarNotice(kind, switchNotice({ kind, result: res.result, value: request.value,
      current: kind === 'model' ? currentModel() : currentEffort }), res.result === 'timeout');
    renderTopBar();
  }, delay);
}

// The bottom page of the terminal, where the input box lives, whatever the
// user has scrolled back to -- inputState() reads the box off this.
function screenLines() {
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.baseY + y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

// Ctrl-E, Ctrl-U, the command, then CR -- as separate writes, spaced: typed as ONE
// chunk, a line is taken for a paste and its CR swallowed (verify/probe-
// payloads.js). Ctrl-U clears a single-line draft without submitting it, and
// the CLI offers Ctrl+Y to get it back (verify/probe-top-bar-truth.js).
const PTY_STEP_MS = 120;

function requestSwitch(kind, raw) {
  const lines = screenLines();
  if (vimInsertShown(lines)) vimSeen = true;
  const plan = planSwitch({
    kind, raw,
    current: kind === 'model' ? currentModel() : currentEffort,
    screen: inputState(lines, { vim: vimSeen }),
    connected: !!ws && ws.readyState === WebSocket.OPEN,
  });
  if (!plan.ok) {
    setTopBarNotice(kind, switchNotice({ kind, result: 'refused', notice: plan.notice }));
    renderTopBar();
    return;
  }
  setTopBarNotice(kind, null);
  // Already running: the truth is broadcast only on a change, so waiting for
  // one would always time out (Dexter #6). The command is still sent -- an
  // alias can move within its family, e.g. opus 4.8 -> opus 5.5, and the live
  // model then reports that like any other change.
  let request = null;
  if (plan.alreadyRunning) {
    setPending(kind, null);
  } else {
    request = { kind, value: plan.value, startedAt: Date.now() };
    setPending(kind, request);
    schedulePendingTimeout(kind, request);
  }
  renderTopBar();
  const input = data => send(JSON.stringify({ type: 'input', data }));
  // Ctrl-E first: Ctrl-U deletes only back to the CURSOR (measured, Dexter r2
  // N1). With the cursor at Home it deleted nothing, and the command was
  // typed in front of the draft -- `/model sonnetrefactor the parser`.
  // vim NORMAL: `i` first, or every key after it is a motion (Dexter r2 N2).
  const lead = plan.enterInsert ? 1 : 0;
  if (lead) input('i');
  setTimeout(() => input('\x05'), PTY_STEP_MS * lead);
  setTimeout(() => input('\x15'), PTY_STEP_MS * (lead + 1));
  setTimeout(() => input(plan.command), PTY_STEP_MS * (lead + 2));
  // Read the box back before Enter (Miguel r2): the screen was judged before
  // four spaced writes, and a dialog opening meanwhile, or anything glued to
  // the command, would take the CR. Not exactly the command: clear it instead.
  setTimeout(() => {
    if (commandTyped(screenLines(), plan.command, { vim: vimSeen })) { input('\r'); return; }
    input('\x05');
    setTimeout(() => input('\x15'), PTY_STEP_MS);
    // Back to NORMAL if the `i` took vim out of it (Miguel #51 3).
    if (plan.enterInsert) setTimeout(() => input('\x1b'), PTY_STEP_MS * 2);
    // Only THIS request: a newer one for the same value may already have run
    // (Dexter #51 F5).
    const pending = kind === 'model' ? pendingModel : pendingEffort;
    if (request && pending === request) setPending(kind, null);
    setTopBarNotice(kind, switchNotice({ kind, result: 'refused',
      notice: `didn't send ${plan.command}: the input line changed before Enter` }));
    renderTopBar();
  }, PTY_STEP_MS * (lead + 5));
}

// BACKLOG E #5, #3. The Claude choices, redrawn with a star per choice and
// favourited ones first -- app/models-favourites.js's pinFavouritesFirst
// decides the order, this only rewrites the container's markup to match.
// Rebuilt (not diffed) because there are only ever a handful of choices.
function renderClaudeChoices() {
  const el = document.getElementById('tb-model-choices');
  if (!el) return;
  const order = pinFavouritesFirst(MODEL_CHOICES, modelFavourites.claude, (id) => id);
  el.innerHTML = order.map((id) => {
    const starred = isFavourite(modelFavourites, 'claude', id);
    return '<span class="tb-model-choice">' +
      '<button type="button" data-model="' + escapeHtml(id) + '">' + escapeHtml(id) + '</button>' +
      '<button type="button" class="star' + (starred ? ' starred' : '') + '" data-star-claude="' +
        escapeHtml(id) + '" title="' + (starred ? 'unfavourite' : 'favourite') + ' ' + escapeHtml(id) + '">' +
        (starred ? '★' : '☆') + '</button></span>';
  }).join('');
}

// The menus sit at body level, position:fixed (renderer.html says why), so
// each one is placed against its chip when it opens: shown first, so it has a
// size to measure.
function toggleMenu(menu, otherMenu, chip) {
  if (!menu) return;
  const opening = menu.hidden;
  if (otherMenu) otherMenu.hidden = true;
  menu.hidden = !opening;
  if (!opening) return;
  if (chip) {
    const at = menuPlacement(chip.getBoundingClientRect(),
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${at.left}px`;
    menu.style.top = `${at.top}px`;
  }
  // preventScroll: focus() scrolls every overflow:hidden ancestor to reveal
  // its target, and that slid the whole header sideways.
  if (menu === tbModelMenu && tbModelCustom) tbModelCustom.focus({ preventScroll: true });
}

function closeTopBarMenus() {
  const open = (tbModelMenu && !tbModelMenu.hidden) || (tbEffortMenu && !tbEffortMenu.hidden);
  if (tbModelMenu) tbModelMenu.hidden = true;
  if (tbEffortMenu) tbEffortMenu.hidden = true;
  return open;
}

function submitCustomModel() {
  if (!tbModelCustom) return;
  requestSwitch('model', tbModelCustom.value);
  tbModelCustom.value = '';
  closeTopBarMenus();
}

if (tbModelEl) tbModelEl.addEventListener('click', () => toggleMenu(tbModelMenu, tbEffortMenu, tbModelEl));
if (tbEffortEl) tbEffortEl.addEventListener('click', () => toggleMenu(tbEffortMenu, tbModelMenu, tbEffortEl));
if (tbModelMenu) {
  tbModelMenu.addEventListener('click', (e) => {
    // Checked first, same reason as the Models panel's star: it is a sibling
    // of the `[data-model]` button inside the same choice, and a favourite
    // click must never also submit a model switch.
    const star = e.target.closest('[data-star-claude]');
    if (star) { toggleModelFavourite('claude', star.dataset.starClaude); return; }
    const row = e.target.closest('[data-model]');
    if (row) { closeTopBarMenus(); requestSwitch('model', row.dataset.model); return; }
    if (e.target.id === 'tb-model-custom-go') submitCustomModel();
  });
}
if (tbModelCustom) {
  tbModelCustom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCustomModel(); }
  });
}
if (tbEffortMenu) {
  tbEffortMenu.addEventListener('click', (e) => {
    const row = e.target.closest('[data-effort]');
    if (row) { closeTopBarMenus(); requestSwitch('effort', row.dataset.effort); }
  });
}
// Esc and a click anywhere outside the top bar close an open menu. Esc is
// only taken when a menu WAS open, so it never reaches the TUI by accident as
// the first of an Esc Esc (which opens the rewind menu) -- and never swallowed
// from it otherwise.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && closeTopBarMenus()) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest || !e.target.closest('#top-bar, .tb-menu')) closeTopBarMenus();
});

// --- permission mode --------------------------------------------------------
const modeEl = document.getElementById('mode');
let modeTable = {};

function renderMode(mode) {
  if (!mode) { modeEl.innerHTML = ''; modeEl.style.display = 'none'; return; }
  modeEl.style.display = 'flex';
  const info = modeTable[mode] || { label: mode, skulls: 1, risky: false, hint: '' };
  const max = Math.max(5, ...Object.values(modeTable).map(m => m.skulls || 0));
  const lit = info.skulls || 1;
  // Skulls = autonomy. One is plan (read-only), five is bypass (everything runs
  // unprompted). Dead skulls stay visible so the scale is readable at a glance
  // rather than only in comparison with another session.
  const skulls = Array.from({ length: max },
    (_, i) => `<i class="${i < lit ? 'on' : ''}">☠</i>`).join('');
  modeEl.className = info.risky ? 'risky' : '';
  modeEl.title = `${info.label} — ${info.hint} (${lit}/${max} autonomy)`;
  modeEl.innerHTML = `<span class="skulls">${skulls}</span><span class="nm">${info.label}</span>`;
}


// --- party ------------------------------------------------------------------
const partyEl = document.querySelector('#party .chain');

function renderParty(party) {
  if (!party || party.length === 0) {
    partyEl.innerHTML = '<span class="none">no delegation</span>';
    return;
  }
  partyEl.innerHTML = party.map((a, i) =>
    (i ? '<span class="arrow">›</span>' : '') +
    '<span class="who' + (i === party.length - 1 ? ' inner' : '') + '">' + a + '</span>'
  ).join('');
}

// --- style: background image override (FF6) ---------------------------------
// A container that GROWS. app/style-display.js keeps the section registry and
// the pure view logic; this file only draws it and wires its interactions to
// the websocket -- the same division of labour as every other display module.
//
// The look itself is PROJECT-scoped and lives with the host (host/style.js);
// the unfocused-window dim is install-wide and lives with main. Both are
// painted here from what they report, never from what was last typed -- a
// preview is local and temporary, the host's broadcast is what sticks.
// State transitions live in app/style-display.js (reduceStyle), where they
// are tested: which section a refusal belongs to, which errors a success
// clears, and that a refusal leaves the stored values alone.
let styleState = emptyStyleState();

// Background, darkness and theme from one style-bearing message, in the order
// that matters: the background first, because applyTheme decides from it
// whether the terminal must be transparent.
function applyStyleMessage(msg) {
  const look = (msg.style && msg.style.look) || msg.look || {};
  const source = (msg.style && msg.style.source) || msg.source;
  const setAt = (msg.style ? msg.style.setAt : msg.setAt) || '';
  applyBackground(msg.background, { custom: source === 'override', version: setAt });
  if (typeof look.darkness === 'number') {
    document.documentElement.style.setProperty('--bg-darkness', String(look.darkness));
  }
  if (msg.theme) applyTheme(msg.theme);
}

// `ask` names the section asking; the host echoes it on the reply, so a
// refusal is shown where it belongs even with another request in flight.
function sendStyle(section, payload) {
  try { ws.send(JSON.stringify({ type: 'style', ask: section, ...payload })); } catch { /* not attached */ }
}

// A refusal means every preview on screen is uncommitted: repaint what the
// host last stored -- the theme and the darkness -- over all of them.
function revertStylePreviews() {
  if (lastTheme) applyTheme(lastTheme);
  const stored = styleState.background.darkness;
  if (typeof stored === 'number') document.documentElement.style.setProperty('--bg-darkness', String(stored));
}

// The id attributes are passed in WHOLE, as literals, rather than built from a
// prefix: test/renderer-scope.test.js guards that every id this file looks up is
// one it can see written out, and a computed id is one it cannot check.
function colourRow(label, c, pickerId, hexId, resetId) {
  return (
    `<span class="style-label">${escapeHtml(label)}</span><div class="style-row">` +
    `<input type="color" ${pickerId} value="${escapeHtml(c.value)}">` +
    `<input type="text" class="style-hex" ${hexId} value="${escapeHtml(c.value)}" ` +
    `maxlength="7" spellcheck="false">` +
    `<button type="button" ${resetId}${c.isSet ? '' : ' disabled'} ` +
    `title="${escapeHtml(c.resetTitle || '')}">Reset</button></div>` +
    (c.painted
      ? `<div class="style-note">shown as ${escapeHtml(c.painted)} so it stays readable</div>`
      : '')
  );
}

function renderStyleSection(section) {
  const header = `<h3>${escapeHtml(section.title)}</h3>`;
  const v = section.view;
  if (section.id === 'colours' && v && !v.known) {
    // Before hello there is no colour to show; a picker would show a
    // fallback as if it were this project's colour (Miguel #3).
    return `<section class="style-section" data-section="colours">${header}` +
      `<div class="style-current">reading…</div></section>`;
  }
  if (section.id === 'colours' && v) {
    return (
      `<section class="style-section" data-section="colours">${header}` +
      `<div class="style-current">This project only. Every window opened in this folder uses it.</div>` +
      colourRow('App', v.app, 'id="style-app"', 'id="style-app-hex"', 'id="style-app-reset"') +
      colourRow('Text', v.text, 'id="style-text"', 'id="style-text-hex"', 'id="style-text-reset"') +
      colourRow('Accent', v.accent, 'id="style-accent"', 'id="style-accent-hex"', 'id="style-accent-reset"') +
      colourRow('Secondary text', v.secondary, 'id="style-secondary"', 'id="style-secondary-hex"',
        'id="style-secondary-reset"') +
      `<button type="button" id="style-reroll" title="A new random look for this project, checked for contrast">Random colours</button>` +
      (v.error ? `<div class="style-error">${escapeHtml(v.error)}</div>` : '') +
      `</section>`
    );
  }
  if (section.id === 'background' && v) {
    const dark = v.darknessPercent;
    return (
      `<section class="style-section" data-section="background">${header}` +
      `<div class="style-current">${escapeHtml(v.description)}</div>` +
      `<div class="style-dropzone" id="style-bg-drop" tabindex="0">drop an image here, or ` +
      `<label class="style-browse">choose a file<input type="file" id="style-bg-file" ` +
      `accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden></label></div>` +
      (v.isOverride
        ? `<span class="style-label">Darkness</span><div class="style-row">` +
          `<input type="range" id="style-dark" min="0" max="95" step="1" value="${dark === null ? 50 : dark}">` +
          `<span class="style-val" id="style-dark-val">${dark === null ? '—' : dark + '%'}</span></div>`
        : '') +
      `<button type="button" id="style-bg-reset"${v.isOverride ? '' : ' disabled'}>Reset to generated</button>` +
      (v.error ? `<div class="style-error">${escapeHtml(v.error)}</div>` : '') +
      `</section>`
    );
  }
  if (section.id === 'inactive' && v) {
    const dim = v.dimPercent;
    return (
      `<section class="style-section" data-section="inactive">${header}` +
      `<div class="style-current">${escapeHtml(v.description)}</div>` +
      `<span class="style-label">Dim</span><div class="style-row">` +
      `<input type="range" id="style-dim" min="0" max="80" step="1" value="${dim === null ? 45 : dim}"` +
      `${dim === null ? ' disabled' : ''}>` +
      `<span class="style-val" id="style-dim-val">${dim === null ? '—' : dim + '%'}</span></div>` +
      `</section>`
    );
  }
  if (section.id === 'avatars' && v) {
    const on = v.imagesEnabled;
    return (
      `<section class="style-section" data-section="avatars">${header}` +
      `<span class="style-label">Default agent picture</span>` +
      `<div class="style-current">${escapeHtml(v.globalDescription)}</div>` +
      `<div class="style-dropzone" id="style-avatar-drop" tabindex="0">drop a picture, GIF or video here</div>` +
      `<div class="style-row"><button type="button" id="style-avatar-pick">Choose file…</button>` +
      `<button type="button" id="style-avatar-reset"${v.globalSet ? '' : ' disabled'} ` +
      `title="Go back to the built-in placeholder">Reset</button></div>` +
      `<label class="style-row"><input type="checkbox" id="style-images-on"${on === true ? ' checked' : ''}` +
      `${on === null ? ' disabled' : ''}> Show agent images</label>` +
      `<div class="style-note">${escapeHtml(v.imagesDescription)}</div>` +
      (v.error ? `<div class="style-error">${escapeHtml(v.error)}</div>` : '') +
      `</section>`
    );
  }
  if (section.id === 'window' && v) {
    // Ids written out in full: test/renderer-scope.test.js finds them by text.
    const state = (on) => `${on === true ? ' checked' : ''}${on === null ? ' disabled' : ''}`;
    return (
      `<section class="style-section" data-section="window">${header}` +
      `<label class="style-row"><input type="checkbox" id="style-status-in-header"${state(v.statusInHeader)}>` +
      ` Status line in the header</label>` +
      `<div class="style-note">${escapeHtml(v.statusDescription)}</div>` +
      `<label class="style-row"><input type="checkbox" id="style-frameless"${state(v.framelessWindow)}>` +
      ` Hide the title bar (next window)</label>` +
      `<div class="style-note">${escapeHtml(v.framelessDescription)}</div>` +
      `</section>`
    );
  }
  // A future section with no view function yet still gets its title drawn,
  // rather than vanishing -- "say something rather than nothing", the same
  // rule the fog and projects panels follow for a failed read.
  return `<section class="style-section" data-section="${escapeHtml(section.id)}">${header}</section>`;
}

function renderStylePanel() {
  const container = document.getElementById('style-sections');
  if (!container) return;
  container.innerHTML = styleDisplay(styleState).map(renderStyleSection).join('');
  bindStyleSections();
}

// Bound fresh on every render, since the elements themselves are replaced by
// the innerHTML assignment above.
//
// Listeners are attached DIRECTLY on the drop zone, never delegated to
// `document`: the whole-window drag-and-drop handler further down is bound to
// `#app`, an ANCESTOR of this panel, and the bubble phase runs target-first --
// only a `stopPropagation()` called on a DESCENDANT's own listener fires early
// enough to stop it. Without this, dropping a background image here would
// ALSO be typed at the terminal prompt and, outside the project folder,
// requested as an `/add-dir` grant -- exactly the drop-zone behaviour this
// panel must not trigger for its own, unrelated kind of drop.
function bindStyleSections() {
  const zone = document.getElementById('style-bg-drop');
  if (zone) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dropping');
    });
    for (const leave of ['dragleave', 'dragend']) {
      zone.addEventListener(leave, (e) => { e.stopPropagation(); zone.classList.remove('dropping'); });
    }
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dropping');
      requestStyleBackground([...(e.dataTransfer.files || [])]);
    });
  }

  const fileInput = document.getElementById('style-bg-file');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      requestStyleBackground([...(fileInput.files || [])]);
      fileInput.value = '';      // so picking the SAME file twice still fires 'change'
    });
  }

  bindAvatarSection();

  const reroll = document.getElementById('style-reroll');
  if (reroll) reroll.addEventListener('click', () => sendStyle('colours', { action: 'reroll-look' }));

  const resetBtn = document.getElementById('style-bg-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => sendStyle('background', { action: 'reset-background' }));
  }

  bindColour(document.getElementById('style-app'), document.getElementById('style-app-hex'),
    document.getElementById('style-app-reset'), 'appColor', (hex) => {
    // A preview, not the palette: the host derives panel and border on commit.
    const root = document.documentElement.style;
    root.setProperty('--bg', hex);
    root.setProperty('--chrome', hex);
    if (!backgroundUrl) term.options.theme = { ...term.options.theme, background: hex };
  });
  bindColour(document.getElementById('style-text'), document.getElementById('style-text-hex'),
    document.getElementById('style-text-reset'), 'textColor',
    (hex) => document.documentElement.style.setProperty('--text', hex));
  bindColour(document.getElementById('style-accent'), document.getElementById('style-accent-hex'),
    document.getElementById('style-accent-reset'), 'accentColor',
    (hex) => document.documentElement.style.setProperty('--accent', hex));
  bindColour(document.getElementById('style-secondary'), document.getElementById('style-secondary-hex'),
    document.getElementById('style-secondary-reset'), 'secondaryColor',
    (hex) => document.documentElement.style.setProperty('--dim', hex));

  const dark = document.getElementById('style-dark');
  if (dark) {
    const label = document.getElementById('style-dark-val');
    dark.addEventListener('input', () => {
      document.documentElement.style.setProperty('--bg-darkness', String(dark.value / 100));
      if (label) label.textContent = dark.value + '%';
    });
    dark.addEventListener('change', () => sendStyle('background', { action: 'set-look', look: { darkness: dark.value / 100 } }));
  }

  const dim = document.getElementById('style-dim');
  if (dim && window.harness && window.harness.look) {
    const label = document.getElementById('style-dim-val');
    dim.addEventListener('input', () => { if (label) label.textContent = dim.value + '%'; });
    dim.addEventListener('change', () => {
      window.harness.look.setDim(dim.value / 100).then((saved) => {
        // null means main could not save it: say so by showing what IS stored.
        if (typeof saved === 'number') applyDim(saved);
        else refreshDim();
      });
    });
  }
}

// The "Agent pictures" section (BACKLOG C #3, #18). Listeners sit directly on
// the drop zone with stopPropagation for the same reason as the background
// zone above: the window-wide drop handler would otherwise type the path into
// the terminal as well.
function sendGlobalPortrait(action, path) {
  try { ws.send(JSON.stringify({ type: 'portrait', action, ...(path ? { path } : {}) })); }
  catch { /* not attached */ }
}

function bindAvatarSection() {
  const zone = document.getElementById('style-avatar-drop');
  if (zone) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dropping');
    });
    for (const leave of ['dragleave', 'dragend']) {
      zone.addEventListener(leave, (e) => { e.stopPropagation(); zone.classList.remove('dropping'); });
    }
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dropping');
      const f = (e.dataTransfer.files || [])[0];
      const path = f && window.harness && window.harness.pathForFile ? window.harness.pathForFile(f) : '';
      if (path) sendGlobalPortrait('set-global', path);
    });
  }

  const pick = document.getElementById('style-avatar-pick');
  if (pick) {
    pick.disabled = !(window.harness && window.harness.avatar);
    pick.addEventListener('click', () => {
      window.harness.avatar.pick().then((path) => { if (path) sendGlobalPortrait('set-global', path); });
    });
  }

  const reset = document.getElementById('style-avatar-reset');
  if (reset) reset.addEventListener('click', () => sendGlobalPortrait('reset-global'));

  const images = document.getElementById('style-images-on');
  if (images && window.harness && window.harness.avatar) {
    images.addEventListener('change', () => setAgentImages(images.checked));
  }

  // Layout pass L2: send the DESIRED state; main answers what it stored, and a
  // failed save (null) re-reads main's truth instead of trusting the click.
  const chrome = window.harness && window.harness.chrome;
  const statusBox = document.getElementById('style-status-in-header');
  if (statusBox && chrome) {
    statusBox.addEventListener('change', () => {
      chrome.setStatusInHeader(statusBox.checked).then(settledChrome).catch(refreshChromeSettings);
    });
  }
  const framelessBox = document.getElementById('style-frameless');
  if (framelessBox && chrome) {
    framelessBox.addEventListener('change', () => {
      chrome.setFrameless(framelessBox.checked).then(settledChrome).catch(refreshChromeSettings);
    });
  }
}

// Layout pass L2 (#27, #28): main's install-wide window settings, followed
// across windows. Until main answers, statusInHeader is unknown and the header
// fields stay hidden: the CLI's own row is still showing them.
let chromeSettings = { statusInHeader: null, framelessWindow: null };
function applyChromeSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  styleState = reduceChromeSettings(styleState, settings);
  chromeSettings = styleState.window;
  renderStatusFields(lastStatusFields);
  renderStylePanel();
}
function settledChrome(saved) {
  if (saved && typeof saved === 'object') applyChromeSettings(saved);
  else refreshChromeSettings();
}
// Null means main couldn't read the file just then (Dexter L2 #1): stay
// unknown and ask again, never assume OFF -- the relay reads that file on its
// own and may already be keeping the CLI row quiet.
function refreshChromeSettings() {
  if (!(window.harness && window.harness.chrome)) return;
  window.harness.chrome.get().then((s) => {
    if (s && typeof s === 'object') applyChromeSettings(s);
    else setTimeout(refreshChromeSettings, 1000);
  }).catch(() => setTimeout(refreshChromeSettings, 1000));
}

// BACKLOG #27: cost / lines / time / ctx>200k off the host's `statusFields`
// (or null: unknown). Shown only while "status line in the header" is on, so
// the header and the CLI row never both say it; formats are
// app/status-fields-display.js's (warpaint's).
const statusFieldsEl = document.getElementById('status-fields');
let lastStatusFields = null;
function renderStatusFields(fields) {
  lastStatusFields = fields && typeof fields === 'object' ? fields : null;
  if (!statusFieldsEl) return;
  const view = statusFieldsView(lastStatusFields, chromeSettings.statusInHeader);
  statusFieldsEl.textContent = view.text;
  statusFieldsEl.hidden = !view.shown;
}

// The install-wide "show agent images" toggle (BACKLOG C #18). Sends the
// DESIRED state; main persists it and answers what it stored. `null` (could
// not save) re-reads main's truth instead of trusting the click.
function setAgentImages(enabled) {
  if (!(window.harness && window.harness.avatar)) return;
  window.harness.avatar.setImagesEnabled(enabled).then((saved) => {
    if (typeof saved === 'boolean') applyAgentImages(saved);
    else refreshAgentImages();
  }).catch(() => refreshAgentImages());
}

function applyAgentImages(enabled) {
  if (typeof enabled !== 'boolean') return;
  const changed = agentImagesEnabled !== enabled;
  agentImagesEnabled = enabled;
  styleState = reduceImagesEnabled(styleState, enabled);
  const btn = document.getElementById('images-toggle');
  if (btn) {
    btn.classList.toggle('off', !enabled);
    btn.setAttribute('aria-pressed', String(enabled));
    btn.title = enabled ? 'Agent images are shown. Click to turn them off.'
      : 'Agent images are off (initials only). Click to turn them on.';
  }
  if (changed) { renderRoster(); renderStylePanel(); }
}

function refreshAgentImages() {
  if (!(window.harness && window.harness.avatar)) return;
  window.harness.avatar.getImagesEnabled().then(applyAgentImages).catch(() => {
    // A failed read is UNKNOWN, not "on" (Dexter F5, PR #64): keep the state
    // null, say so on the button, and let a click try again.
    const btn = document.getElementById('images-toggle');
    if (btn) {
      btn.removeAttribute('aria-pressed');
      btn.title = 'Could not read the agent images setting. Click to try again.';
    }
  });
}

const imagesToggleBtn = document.getElementById('images-toggle');
if (imagesToggleBtn) {
  if (!(window.harness && window.harness.avatar)) imagesToggleBtn.hidden = true;
  imagesToggleBtn.addEventListener('click', () => {
    if (typeof agentImagesEnabled === 'boolean') setAgentImages(!agentImagesEnabled);
    else refreshAgentImages();
  });
}
if (window.harness && window.harness.avatar) {
  window.harness.avatar.onImagesEnabled(applyAgentImages);
  refreshAgentImages();
}
if (window.harness && window.harness.chrome) {
  window.harness.chrome.onChange(applyChromeSettings);
  refreshChromeSettings();
}

// The hover pencil on a roster face: pick a file, send it as the same
// `portrait set` a drop sends, for the state the card is showing.
agentsEl.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.face-pencil');
  if (!btn) return;
  // Not a card click: the card-click handler ignores anything inside a
  // button / [data-no-card-click], so nothing here stops propagation (the CLI's
  // clickable menus need xterm to see every mouse event; see
  // test/renderer-mouse-passthrough.test.js).
  e.preventDefault();
  const row = btn.closest('.agent');
  const agent = row && row.dataset.agent;
  const state = row && row.dataset.state;
  if (!agent || !state || !(window.harness && window.harness.avatar)) return;
  window.harness.avatar.pick().then((path) => {
    if (!path) return;
    try { ws.send(JSON.stringify({ type: 'portrait', action: 'set', agent, state, path })); }
    catch { /* not attached */ }
  });
});

const HEX_INPUT = /^#[0-9a-f]{6}$/i;

// One colour control: the picker previews while it moves and commits when it
// settles; the hex field commits on Enter/blur, and only a real #rrggbb.
function bindColour(picker, hex, reset, key, preview) {
  const commit = (value) => sendStyle('colours', { action: 'set-look', look: { [key]: value } });
  if (picker) {
    picker.addEventListener('input', () => { preview(picker.value); if (hex) hex.value = picker.value; });
    picker.addEventListener('change', () => commit(picker.value));
  }
  if (hex) {
    hex.addEventListener('change', () => {
      const v = hex.value.trim();
      if (!HEX_INPUT.test(v)) { hex.classList.add('bad'); return; }
      hex.classList.remove('bad');
      preview(v);
      commit(v.toLowerCase());
    });
  }
  if (reset) reset.addEventListener('click', () => commit(null));
}

// --- unfocused-window dim -----------------------------------------------------
// Main tells the page when the window gains or loses focus, with the current
// install-wide dim level. The veil is CSS (#focus-veil); this only flips it.
function applyDim(dim) {
  if (typeof dim !== 'number' || !Number.isFinite(dim)) return;
  document.documentElement.style.setProperty('--unfocused-dim', String(dim));
  const changed = styleState.inactive.dim !== dim;
  styleState = { ...styleState, inactive: { dim } };
  // Not re-rendered on every focus flip -- only when the value moved, so an
  // open control in the panel is not rebuilt under the pointer.
  if (changed) renderStylePanel();
}

function refreshDim() {
  if (!window.harness || !window.harness.look) return;
  window.harness.look.getDim().then(applyDim).catch(() => { /* main has no answer; leave it unknown */ });
}

if (window.harness && window.harness.onWindowFocus) {
  window.harness.onWindowFocus(({ focused, dim }) => {
    applyDim(dim);
    document.body.classList.toggle('unfocused', !focused);
  });
}
refreshDim();

// One image at a time. `webUtils.getPathForFile` across the preload bridge is
// the only way to get a dropped/chosen file's real path -- `File.path` was
// removed in Electron 32 -- and it returns '' for anything that is not a real
// file, which is filtered here rather than sent to the host at all.
function requestStyleBackground(files) {
  if (!files.length) return;
  const path = (window.harness && window.harness.pathForFile) ? window.harness.pathForFile(files[0]) : '';
  if (!path) return;
  sendStyle('background', { action: 'set-background', path });
}

function handleControl(msg) {
  if (msg.type === 'hello') {
    // The host sends `hello` immediately before replaying the current screen.
    // Without this reset, reattaching after a detach appends the replay to what
    // is already on screen and the session appears twice.
    term.reset();
    document.getElementById('cwd').textContent = msg.cwd || '';
    if (typeof msg.project === 'string' && msg.project) currentProjectName = msg.project;
    currentBranchName = typeof msg.branch === 'string' ? msg.branch : null;
    renderTitle();
    // Layout pass L1: this tab's own layout survives a reattach because the host
    // kept it. Absent on an older host -> the global layout, as before.
    if ('layoutOverride' in msg) applyLayoutOverride(msg.layoutOverride);
    // PR 1b: absent on an older host -> no overlay, no banner, no marker.
    renderLock(msg.lock);
    renderTerminalSessions(msg.terminalSessions);
    renderBranchHealth(msg.branchHealth);
    // `msg.background` is already resolved through host/style.js (the
    // project's own copy wins over generated art) and `msg.theme` already has
    // the project's look merged in; `msg.style` carries WHY, for the panel.
    applyStyleMessage(msg);
    styleState = reduceStyle(styleState, msg);
    styleState = reduceAvatars(styleState, msg);
    renderStylePanel();
    renderUsage(msg.usage);
    // May be null on a fast attach -- quotaDisplay draws "reading…" for that,
    // and the host sends a `quota` message as soon as the read lands.
    renderQuota(msg.quota || null);
    renderHealth(msg.health);
    renderCooldowns(msg.cooldowns);
    renderBugVault(msg.vault);
    renderProcesses(msg.running);
    if (msg.modes) modeTable = msg.modes;
    renderMode(msg.mode);
    latestParty = msg.party || [];
    // FF12. `effort` is null until the first hook payload has carried it --
    // rendered as "—", never a guessed default. The model comes from #34's
    // `sessionModel` ({ session: { model, at }, agents, errors }) through
    // mainModelOf -- NOT `sessionModel.model`, which FF12 assumed before #34
    // merged and which never exists. A reattach clears any pending
    // switch a PREVIOUS window started -- this handshake IS the current
    // truth, and holding onto a stale "switching…" across it would be the
    // "flips back to pending on its own" bug the timeout logic exists to avoid.
    currentTheme = msg.theme || currentTheme;
    currentEffort = typeof msg.effort === 'string' ? msg.effort : null;
    liveModel = typeof msg.liveModel === 'string' && msg.liveModel ? msg.liveModel : null;
    sessionModelFallback = mainModelOf(msg.sessionModel);
    pendingModel = null;
    pendingEffort = null;
    renderTopBar();
    renderContextFill(msg.context);   // absent on an older host -> unknown
    renderStatusFields(msg.statusFields);
    renderParty(msg.party);
    roster.clear();
    for (const r of msg.roster || []) roster.set(r.agent, r);
    reportTabStatus();
    // The persisted hidden set (BACKLOG #14), before the first paint.
    hiddenAgentNames = Array.isArray(msg.hidden) ? msg.hidden : [];
    // Before renderRoster, so the first paint already carries the careers and
    // the models rather than flashing the roster without them.
    if (msg.sessionModel) sessionModel = msg.sessionModel;
    rosterIndexPayload = msg.rosterIndex || null;
    loadoutState = loadoutDisplay.reduce(loadoutState, msg);
    hooksOn = msg.hooks;
    renderAgentStats(msg.agentStats);
    renderRoster();
    if (Array.isArray(msg.seats)) councilSeats = msg.seats;
    if (msg.maxSeats) seatMax = msg.maxSeats;
    councilWarnings = [];
    renderSeats();
    if (!msg.hooks) console.warn('[renderer] host reports no hook helper — moods will not update');
    return;
  }
  if (msg.type === 'loadout') {
    loadoutState = loadoutDisplay.reduce(loadoutState, msg);
    renderRoster();
    return;
  }
  if (msg.type === 'mood') {
    roster.set(msg.agent, msg);
    renderRoster();
    reportTabStatus();
    return;
  }
  if (msg.type === 'raise') {
    // Another claude-custom asked to be taken to this session (Go to that
    // session): the shell selects this tab and brings its window forward.
    if (window.harness && window.harness.raise) window.harness.raise();
    return;
  }
  if (msg.type === 'hidden') {
    // The host's set replaces ours wholesale (BACKLOG #14).
    hiddenAgentNames = Array.isArray(msg.hidden) ? msg.hidden : [];
    renderRoster();
    return;
  }
  if (msg.type === 'branch') {
    currentBranchName = typeof msg.branch === 'string' ? msg.branch : null;
    renderTitle();
    return;
  }
  if (msg.type === 'lock') {
    renderLock(msg.lock);
    return;
  }
  // Layout pass L1: this tab's own layout, changed here or in another window
  // attached to the same host.
  if (msg.type === 'layout-override') {
    applyLayoutOverride(msg.layout);
    return;
  }
  if (msg.type === 'lock-note') {
    // What came of *Stop that session*, or "busy" for it or *Open anyway*.
    // The host sends it after its re-check, whose `lock` repaint would
    // otherwise clear this note.
    disarmStop();
    document.getElementById('lock-goto-note').textContent = typeof msg.text === 'string' ? msg.text : '';
    return;
  }
  if (msg.type === 'terminal-sessions') {
    renderTerminalSessions(msg);
    return;
  }
  if (msg.type === 'branch-health') {
    renderBranchHealth(msg.health);
    return;
  }
  if (msg.type === 'processes') {
    // Deliberately does NOT touch the mode badge. A processes message carries no
    // `mode`, so calling renderMode(undefined) here hid the badge a second after
    // `hello` had correctly set it -- the host was right the whole time.
    renderProcesses(msg.running);
    latestParty = msg.party || [];
    renderParty(msg.party);
    // The ×N badge is derived from `party`, which just changed; the roster map
    // itself may not have, so nothing else here would repaint it.
    renderRoster();
    return;
  }
  if (msg.type === 'sessionModel') {
    // ONE handler for both consumers. FF12's used to be a second
    // `msg.type === 'sessionModel'` branch further down, which never ran
    // because this one returns -- the chip never updated and a pending model
    // switch never resolved. test/renderer-dispatch.test.js now fails on that.
    //
    // 1. FF10: every agent card's model line.
    sessionModel = { session: msg.session, agents: msg.agents || {}, errors: msg.errors };
    renderRoster();
    // 2. FF12: the model chip's FALLBACK, until the statusLine reports. It
    //    never resolves a pending /model: it is the last assistant line of
    //    the transcript, written before any switch (Dexter #1, #2).
    sessionModelFallback = mainModelOf(msg);
    renderTopBar();
    return;
  }
  if (msg.type === 'liveModel') {
    // FF12's model truth: the statusLine's exact id, re-fired ~1s after a
    // /model -- see host/status-relay.js. Resolves a pending switch only if it is
    // no older than the request -- see pendingResolver.
    liveModel = typeof msg.model === 'string' && msg.model ? msg.model : null;
    clearStaleNotice('model');
    if (pendingModel) {
      const res = pendingResolver(pendingModel, {
        type: 'truth', kind: 'model', at: msg.at, matches: modelMatches(liveModel, pendingModel.value),
      });
      pendingModel = res.pending;
    }
    renderTopBar();
    return;
  }
  if (msg.type === 'context') {
    // The statusLine's context window, or null when the CLI has not counted
    // yet (a fresh session) -- drawn as unknown, never as a confident 0%.
    renderContextFill(msg.context);
    return;
  }
  if (msg.type === 'statusFields') {
    // BACKLOG #27: the CLI status row's cost / lines / time, or null.
    renderStatusFields(msg.fields);
    return;
  }
  if (msg.type === 'attention') {
    // Delivery is unconditional; only INSISTENCE depends on focus. The old rule
    // skipped the toast whenever the window had focus, which silenced the one
    // case the feature was built for: watching the terminal while a long task
    // runs and wanting to be told when it ends.
    const surfaces = window.surfacesFor(msg, { focused: document.hasFocus() });
    // An urgent message is waiting for you until this tab is looked at; so is a finished one (#31).
    if (msg.urgent === true) { tabPendingUrgent = true; reportTabStatus(); }
    else { tabPendingFinished = true; reportTabStatus(); }

    if (window.harness && window.harness.attention) {
      // Preferred path: main raises it, so it needs no page permission and can
      // flash the taskbar and focus the window on click.
      window.harness.attention(surfaces);
    } else if (surfaces.toast) {
      try {
        const n = new Notification(surfaces.toast.title, {
          body: surfaces.toast.body,
          requireInteraction: surfaces.toast.requireInteraction,
          silent: surfaces.toast.silent,
        });
        n.onclick = () => window.focus();
      } catch (e) {
        console.warn('[renderer] notification failed:', e.message);
      }
    }

    if (surfaces.cue) flashAttention(msg);
    return;
  }
  if (msg.type === 'milestone') {
    flourish(msg.milestone);
    return;
  }
  if (msg.type === 'health') {
    renderHealth(msg.health);
    return;
  }
  if (msg.type === 'cooldowns') {
    renderCooldowns(msg.cooldowns);
    return;
  }
  if (msg.type === 'fog') {
    renderFog(msg);
    return;
  }
  if (msg.type === 'git-tree') {
    renderGitTree(msg);
    return;
  }
  if (msg.type === 'bugvault') {
    renderBugVault(msg);
    // A refused add (missing category/summary) is SHOWN, never swallowed --
    // same reasoning as the council seat refusal a few lines below.
    const errEl = document.getElementById('bugvault-error');
    if (errEl) errEl.textContent = msg.error || '';
    return;
  }
  if (msg.type === 'projects') {
    renderProjects(msg);
    return;
  }
  if (msg.type === 'agentStats') {
    renderAgentStats(msg.stats);
    return;
  }
  if (msg.type === 'rosterIndex') {
    renderRosterIndex(msg.rosterIndex);
    return;
  }
  if (msg.type === 'models') {
    // Dexter, PR #60, F1 + F4: NOT authoritative on its own. Reconciled
    // against what is already shown -- a failed refresh must never blank the
    // rows on screen, and a reply older than what is displayed must never
    // clobber it, whichever request (boot warm-up, tab open, Refresh) it
    // answers. See app/models-catalogue.js for the whole reasoning.
    const merged = mergeCatalogueReply({ rows: catalogue, meta: catalogueMeta }, msg);
    catalogue = merged.rows;
    catalogueMeta = merged.meta;
    if (Array.isArray(msg.seats)) councilSeats = msg.seats;
    if (Array.isArray(msg.warnings)) councilWarnings = msg.warnings;
    if (msg.max) seatMax = msg.max;
    // F4/N1/N2 (Dexter, PR #60 rounds 1+2): only the reply that actually
    // answers the outstanding Refresh click clears its `pending` flag --
    // matched by `seq`, not by the reply's data shape or fetchedAt.
    if (modelsRefreshPending && shouldClearPending(refreshRequestSeq, msg)) {
      modelsRefreshPending = false;
      refreshRequestSeq = null;
    }
    renderSeats();
    renderProvenance();
    renderModels();
    return;
  }
  if (msg.type === 'seats') {
    councilSeats = Array.isArray(msg.seats) ? msg.seats : [];
    councilWarnings = Array.isArray(msg.warnings) ? msg.warnings : [];
    if (msg.max) seatMax = msg.max;
    // A refusal is SHOWN, never swallowed. "Claude cannot take a seat" is the
    // rule that makes the council mean anything, and a click that silently does
    // nothing teaches the opposite.
    if (msg.error) councilWarnings = [msg.error].concat(councilWarnings);
    renderSeats();
    renderModels();
    return;
  }
  if (msg.type === 'mode') {
    renderMode(msg.mode);
    return;
  }
  if (msg.type === 'effort') {
    // The truth source a pending /effort switch resolves against, from the
    // statusLine or a main-session hook payload. null is ABSENT (a model with
    // no effort levels), never a level.
    currentEffort = typeof msg.level === 'string' ? msg.level : null;
    clearStaleNotice('effort');
    if (pendingEffort) {
      const res = pendingResolver(pendingEffort, {
        type: 'truth', kind: 'effort', at: msg.at, matches: effortMatches(currentEffort, pendingEffort.value),
      });
      pendingEffort = res.pending;
    }
    renderTopBar();
    return;
  }
  if (msg.type === 'usage') {
    // Same reason as above: no `mode` on this message, so leave the badge alone.
    renderUsage(msg.usage);
    return;
  }
  if (msg.type === 'dropped') {
    renderDropNote(msg.note);
    return;
  }
  if (msg.type === 'portrait' && msg.global) {
    // The user's default picture for every agent (BACKLOG C #3). The mood and
    // rosterIndex messages that follow a change redraw the faces; this is the
    // Style row and the "was it accepted, and if not, why" note.
    styleState = reduceAvatars(styleState, msg);
    renderStylePanel();
    if (msg.quiet) return;     // another window's change: the row is current, no announcement
    flourish({ icon: msg.ok ? '🖼️' : '⛔',
      name: msg.ok ? 'default agent picture updated'
        : `default agent picture refused: ${msg.reason || 'unknown reason'}` });
    return;
  }
  if (msg.type === 'portrait') {
    // The mood message that follows a successful upload redraws the face
    // itself; this is only the "was it accepted, and if not, why" the drop
    // note pattern above already established for granting a directory.
    flourish({ icon: msg.ok ? '🖼️' : '⛔',
      name: msg.ok
        ? `portrait set for ${msg.agent} (${msg.state})`
        : `portrait refused for ${msg.agent}: ${msg.reason || 'unknown reason'}` });
    return;
  }
  if (msg.type === 'style') {
    // A refusal (unsupported type, too large, no file) answers ONLY this
    // action; the CURRENT background/source is left exactly as it was, the
    // same "say what failed, do not repaint the world" rule renderProjects
    // follows for its own error branch.
    styleState = reduceStyle(styleState, msg);
    if (msg.error) revertStylePreviews();
    else applyStyleMessage(msg);
    renderStylePanel();
    return;
  }
  if (msg.type === 'quota') {
    renderQuota(msg.quota);
    return;
  }
  if (msg.type === 'quotaWarning') {
    // An EVENT, not a value -- the meters already carry the number. This is the
    // part that reaches you when you are not looking at the header, which is
    // the whole point of routing it through the same surface a milestone uses.
    const left = msg.warning.resetsAt ? formatQuotaCountdown(msg.warning.resetsAt) : null;
    flourish({
      icon: msg.warning.threshold >= 95 ? '🪫' : '🔋',
      name: left && left !== '—' ? `${msg.warning.text} · ${left} left` : msg.warning.text,
    });
    return;
  }
  if (msg.type === 'agent-log') {
    handleAgentLogFrame(msg);
    return;
  }
  if (msg.type === 'exit') {
    term.write('\r\n\x1b[33m[claude exited]\x1b[0m\r\n');
    return;
  }
}

// --- transport --------------------------------------------------------------
const dot = document.getElementById('dot');
let ws = null;
let pendingKeyDesc = null;

function connect() {
  // The token goes in the URL, which is the only channel a WebSocket
  // handshake offers. It never touches the pty.
  const auth = params.get('token') ? `?token=${encodeURIComponent(params.get('token'))}` : '';
  ws = new WebSocket(`ws://127.0.0.1:${PORT}${auth}`);

  ws.onopen = () => {
    dot.classList.add('on');
    term.focus();
    sendResize();
    // A log open across a reattach is asked for again: the host's log session
    // belongs to the old socket and died with it.
    if (agentLog.open) openAgentLog(agentLog.agent);
    // The tab is restored before the socket is open, so a fog request made at
    // load is thrown away. Ask again once there is somewhere to ask.
    if (shownModules.has('fog')) requestFog();
    if (shownModules.has('git')) requestGitTree();
    if (shownModules.has('projects')) requestProjects();
    // Dexter, PR #60, F3: the same silent drop, for models. requestModels()'s
    // `ws.send` throws (InvalidStateError) while the socket is still
    // CONNECTING -- e.g. a Refresh click, or a tab reopen, during the 1s
    // reattach loop below -- and that throw is swallowed, same as
    // requestFog's comment above says fog's used to be. Left uncaught, the
    // Refresh button would stay disabled "Refreshing..." forever, since
    // nothing else ever re-asks. Reusing whatever `force` a stuck click had
    // set carries the user's actual request forward rather than silently
    // downgrading it to a plain re-check.
    //
    // N3 (round 2): resumed whenever a Refresh is PENDING, not only when the
    // Models tab happens to still be active. `modelsRefreshPending` is
    // WINDOW state, not tab state -- a click made just before the user
    // switched to Fog, then the socket reconnecting, must not depend on them
    // switching back before this fires, or the button stays stuck exactly
    // as if this fix did not exist. The resend gets its OWN fresh `seq`,
    // which supersedes the original click's seq -- that request never
    // reached the host at all, so nothing will ever answer it.
    if (shownModules.has('models') || modelsRefreshPending) {
      const seq = requestModels(modelsRefreshPending);
      if (modelsRefreshPending) refreshRequestSeq = seq;
    }
  };

  // Protocol: BINARY frames are raw pty bytes, TEXT frames are control JSON.
  // Sniffing content would be wrong -- terminal output can contain anything,
  // including a leading '{'.
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      term.write(new Uint8Array(ev.data));
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleControl(msg);
  };

  ws.onclose = () => {
    dot.classList.remove('on');
    // Detach is normal, not fatal — the host keeps the session alive, so just
    // keep trying to reattach.
    setTimeout(connect, 1000);
  };

  ws.onerror = () => { /* surfaced via onclose */ };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

// The last size the host was sent: verify/probe-dock-zones.js compares it with
// xterm's own and with what fits the container after every layout change.
let lastSentResize = null;
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    lastSentResize = { cols: term.cols, rows: term.rows };
  }
}

// Everything xterm translates from a keypress flows through here.
// Typing drops the selection, as in Windows Terminal: a selection left
// behind is the one a later Ctrl+C would copy instead of interrupting
// (Miguel, PR #58, I1). onKey, not onData: onData also carries focus and
// mouse reports, which must not clear a selection the user is still using.
term.onKey(() => { if (term.hasSelection()) term.clearSelection(); });

term.onData((data) => {
  logLine(pendingKeyDesc || 'input', data);
  pendingKeyDesc = null;
  send(data);
});

// Bracketed-paste and other multi-byte writes.
term.onBinary((data) => send(data));

// --- drag and drop ------------------------------------------------------------
// Dropping a file types its path into the prompt and, when the file lives
// outside the project, asks the host to grant the session read access to its
// folder. The DECISION about what may be granted is host-side and tested
// (host/drop.js); this end only collects paths and reports what happened.
//
// Both listeners are required. Without preventDefault on dragover, Chromium
// treats the window as a browser and NAVIGATES to the dropped file -- the whole
// UI is replaced by a plain view of it and the only way back is restarting.
const dropZone = document.getElementById('app') || document.body;

dropZone.addEventListener('dragover', (e) => {
  // A module tab being dragged to another zone is not a file (layout pass L1).
  if (draggingModule) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropZone.classList.add('dropping');
});
for (const leave of ['dragleave', 'dragend']) {
  dropZone.addEventListener(leave, () => dropZone.classList.remove('dropping'));
}

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dropping');
  if (draggingModule) return;

  // Dropping ONTO an agent's face is a portrait upload, not a path-into-the-
  // prompt drop -- checked first and returned early, because `.face` sits
  // inside `#agents` sits inside this same dropZone, and letting both fire
  // would both upload the file AND type its path into the session.
  const face = e.target.closest && e.target.closest('.face');
  const row = face && face.closest('.agent');
  if (face && row) {
    const file = (e.dataTransfer.files || [])[0];
    const agent = row.dataset.agent;
    const state = row.dataset.state;
    const p = file && window.harness && window.harness.pathForFile
      ? window.harness.pathForFile(file) : '';
    if (p && agent && state) {
      try { ws.send(JSON.stringify({ type: 'portrait', action: 'set', agent, state, path: p })); }
      catch { /* not attached */ }
    }
    return;
  }

  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;

  // `File.path` WAS REMOVED IN ELECTRON 32 and this app is on 33: it is
  // undefined here, with no error and no warning, which is how every
  // drag-and-drop snippet still on the internet fails silently. The path comes
  // across the preload bridge via webUtils.getPathForFile instead.
  const entries = files
    .map(f => ({
      path: (window.harness && window.harness.pathForFile) ? window.harness.pathForFile(f) : '',
      // A dropped folder arrives as a File with no type and a size the OS makes
      // up. Sent as a HINT only -- the host stats the path rather than trusting
      // either field.
      isDirectory: !f.type && !(f.size > 0),
    }))
    .filter(x => x.path);

  if (!entries.length) return;
  try { ws.send(JSON.stringify({ type: 'drop', entries })); } catch { /* not attached */ }
});

// What the drop did, said out loud. A gesture that silently widens what the
// session may read is exactly the thing that should not be silent.
function renderDropNote(note) {
  if (!note) return;
  const bits = [];
  if (note.requested && note.requested.length) {
    bits.push('requested read access to ' + note.requested.join(', '));
  }
  if (note.refused && note.refused.length) {
    bits.push(note.refused.map(r => 'refused ' + r.dir + ': ' + r.why).join(' · '));
  }
  if (note.truncated) bits.push(note.truncated + ' more file(s) not added');
  if (!bits.length) return;
  if (note.unusable) bits.push(note.unusable + ' file(s) skipped: unsafe name');
  const denied = !!(note.refused && note.refused.length);
  flourish({ icon: denied ? '⛔' : '📁', name: bits.join(' · ') });
}

// --- key handling -----------------------------------------------------------
// Returning false stops xterm's default handling for that event.
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;

  // THE PANEL TOGGLE MUST BE DECIDED HERE, not in a document listener. xterm's
  // textarea always holds focus, so a document-level handler never saw Ctrl+B
  // -- the terminal consumed it and sent \x02 to the pty, which readline reads
  // as backward-char. The binding looked dead while quietly editing the command
  // line. Returning false is what stops the terminal taking it.
  if (isPanelToggle(e)) {
    // In focus mode the panels are hidden behind it: Ctrl+B brings them back.
    if (focusOn && focusBridge) focusBridge.set(false); else toggleAllZones();
    e.preventDefault();
    return false;
  }

  // Ctrl+V (BACKLOG #12, #8). Taken here for the same reason as Ctrl+B:
  // left to xterm, it sent \x16 to the pty and pasted nothing -- xterm cancels
  // the keydown, so the default Edit menu's accelerator never ran either
  // (verify/probe-paste.js). Returning false with preventDefault keeps it that
  // way, which is what makes this the ONLY paste a press produces.
  if (isPasteKey(e)) {
    hit.add('paste'); renderChecks();
    e.preventDefault();
    pasteFromClipboard();
    return false;
  }

  // Ctrl+C with a selection copies it (app/paste-action.js); with none, it
  // falls through and xterm sends ^C to the CLI as before. Left to xterm, a
  // selection was never copied: the keydown became ^C and interrupted claude.
  // A selection scrolled out of sight is dropped, and ^C goes through
  // (Miguel, PR #58, I1).
  const copy = copyKeyAction(e, term.getSelection(),
    selectionVisible(term.getSelectionPosition(), term.buffer.active.viewportY, term.rows));
  if (copy.kind === 'copy') {
    e.preventDefault();
    copySelection(copy.text);
    return false;
  }
  if (copy.kind === 'stale') term.clearSelection();

  const mods =
    (e.ctrlKey ? 'Ctrl+' : '') +
    (e.shiftKey ? 'Shift+' : '') +
    (e.altKey ? 'Alt+' : '');
  pendingKeyDesc = mods + (e.key === ' ' ? 'Space' : e.key);

  // Shift+Enter must insert a newline rather than submit. xterm sends the same
  // byte as plain Enter by default. This is what `/terminal-setup` normally
  // configures per-terminal; ours isn't a terminal it recognises, so it's
  // hardcoded here. ESC+CR is the sequence iTerm2/VS Code are configured to send.
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
    hit.add('shiftEnter'); renderChecks();
    logLine('Shift+Enter', '\x1b\r');
    send('\x1b\r');
    return false;
  }

  // Observed-only below — these should already be correct, and the panel proves it.
  if (e.key === 'Tab' && e.shiftKey) { hit.add('shiftTab'); renderChecks(); }
  if (e.key === 'Escape')            { hit.add('esc'); renderChecks(); }
  if (e.ctrlKey && e.key === 'c')    { hit.add('ctrlC'); renderChecks(); }
  if (e.ctrlKey && e.key === 'r')    { hit.add('ctrlR'); renderChecks(); }

  return true;
});

// What the clipboard holds decides what Ctrl+V does (app/paste-action.js).
// Text goes in pasteFrame's `{type:'input'}` wrapper, NEVER term.paste: raw,
// a clipboard holding allow-listed JSON would run as a host control message
// (Miguel, PR #55, B1). Bracketed when the CLI has asked for it, so several
// lines arrive as ONE paste. An image is ESC+v: `claude` reads the clipboard
// itself.
// Never silent, like Ctrl+V: a copy that failed says so. The selection is
// cleared only once the text is really on the clipboard, so a failed copy
// can be retried.
async function copySelection(text) {
  let res;
  try {
    res = window.harness && window.harness.writeClipboard
      ? await window.harness.writeClipboard(text)
      : { ok: false, error: 'no clipboard bridge' };
  } catch (err) {
    res = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  // Seen, not silent: a copy that swallowed a Ctrl+C says what it did
  // (Miguel, PR #58, I1).
  if (res && res.ok) {
    term.clearSelection();
    flourish({ icon: '📋', name: `Copied ${text.length} character${text.length === 1 ? '' : 's'}` });
    return;
  }
  flourish({ icon: '⛔', name: 'Ctrl+C could not copy: ' + ((res && res.error) || 'unknown error') });
}

async function pasteFromClipboard() {
  // Never silent (Miguel, PR #55, S2): a Ctrl+V that does nothing reads as
  // "paste is broken". Same on-screen note the drop gesture uses.
  if (!(window.harness && window.harness.readClipboard)) {
    console.warn('[paste] no clipboard bridge (window.harness.readClipboard)');
    flourish(pasteFailureNote(null));
    return;
  }
  let clip;
  try {
    clip = await window.harness.readClipboard();
  } catch (err) {
    console.warn('[paste] clipboard read failed:', err);
    flourish(pasteFailureNote(err));
    return;
  }
  const action = pasteAction(clip);
  if (action.kind === 'text') {
    const frame = pasteFrame(action.text, term.modes.bracketedPasteMode);
    logLine('Ctrl+V', JSON.parse(frame).data);
    send(frame);
  } else if (action.kind === 'image') {
    logLine('Ctrl+V (image)', action.data);
    send(action.data);
  }
}

// --- sizing -----------------------------------------------------------------
// Resize must propagate on window resize AND on font change, or the Ink layout
// corrupts.
const ro = new ResizeObserver(() => {
  try { fit.fit(); sendResize(); } catch {}
});
ro.observe(document.getElementById('termwrap'));

connect();

// FF4: the finished-task cue. Main decides WHEN (it is the only side that
// knows about focus); the page decides what it looks like. A class on <body>
// rather than a widget, so it is impossible to scroll past and it shows up in
// the alt-tab thumbnail, which is where the decision to come back is made.
if (window.harness && window.harness.onAttentionCue) {
  window.harness.onAttentionCue((on) => {
    document.body.classList.toggle('attention-cue', on);
  });
}
