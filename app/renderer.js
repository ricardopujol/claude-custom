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
});

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
    setTimeout(() => { fit.fit(); sendResize(); }, 0);
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
// --- side tabs --------------------------------------------------------------
let activeTab = DEFAULT_TAB;
let lastTab = DEFAULT_TAB;      // what Ctrl+B reopens after a collapse

function setTab(tab) {
  activeTab = tab;
  if (tab) lastTab = tab;

  document.getElementById('roster').classList.toggle('hidden', tab === null);
  for (const b of document.querySelectorAll('#side-tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  for (const p of document.querySelectorAll('#roster .panel')) {
    p.classList.toggle('on', p.dataset.panel === tab);
  }

  if (tab === 'fog') requestFog();
  if (tab === 'projects') requestProjects();
  // Inside setTab, not in the click handler, because setTab is the ONE place
  // every path into a panel goes through -- a click, a keyboard toggle, and the
  // restore of a saved tab on launch. Hanging it off the click alone meant a
  // window that reopened with the panel already showing never asked for
  // anything and sat on "loading" forever.
  //
  // Dexter/Miguel, PR #60, F2/I1: EVERY open asks, not just the first one ever
  // (`!catalogueMeta` used to gate this, so a window kept open past one
  // FRESH_MS window silently stopped re-checking and its "just now" label
  // froze there for good). `host/openrouter.js`'s `loadCatalogue` already
  // knows how to answer this cheaply -- a fresh cache is returned with no
  // network call at all -- so asking every time costs nothing when there is
  // nothing to refresh, and it is the host, not a client-side copy of
  // FRESH_MS, that decides.
  if (tab === 'models') requestModels(false);
  if (tab === 'vault') {
    renderVault();
    setTimeout(() => document.getElementById('vault-search').focus(), 0);
  } else {
    // Leaving the vault puts every revealed secret back out of sight -- both
    // the listed ones and whatever is half-typed in the field. A value left on
    // screen outlives the moment someone needed it.
    hideRevealed();
    secretMask.left();
    applyMask();
    term.focus();
  }
  try { localStorage.setItem('sideTab', tab === null ? '' : tab); } catch {}
  setTimeout(() => { fit.fit(); sendResize(); }, 0);
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('#side-tabs button');
  if (!button) return;
  setTab(nextTab(activeTab, button.dataset.tab));
});

document.getElementById('side-hint').addEventListener('click', () => {
  setTab(activeTab === null ? lastTab : null);
});

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
  // Restored per window, so a collapsed sidebar stays collapsed across a
  // restart rather than springing back every launch.
  let saved = DEFAULT_TAB;
  try {
    const stored = localStorage.getItem('sideTab');
    // A stored tab this build does not have leaves the sidebar BLANK: no tab
    // is active, no panel matches, and the whole thing renders empty. Seen for
    // real -- a 'fog' tab saved by another branch emptied the sidebar here.
    if (stored === '') saved = null;
    else if (stored !== null) saved = isKnownTab(stored) ? stored : DEFAULT_TAB;
  } catch {}
  // A screenshot probe can pin the tab: the sidebar is the one surface the
  // headless checks cannot look at.
  // Validated too. The guard above was applied to the STORED value and not
  // to this one, so ?tab=fog reproduced the blank sidebar exactly -- and
  // then persisted it, because setTab writes whatever it is given.
  const forced = new URLSearchParams(location.search).get('tab');
  setTab(forced && isKnownTab(forced) ? forced : saved);

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
    ? '<button type="button" class="face-edit" title="Choose a picture, GIF or video for this agent">✎</button>'
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
      `</div>` +
    `</div>`;
}

function renderRoster() {
  const { inactive } = splitActiveInactive(wholeRosterEntries().map(a => a.agent), [...roster.keys()]);

  if (activeRosterTab === 'inactive') {
    if (inactive.length === 0) {
      setRosterHtml('<div class="empty">No other agents known yet.</div>');
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
    setRosterHtml(rows.map(inactiveRowHtml).join(''));
    return;
  }

  if (roster.size === 0) {
    // Three different situations, not one sentence. "No agents yet" is a
    // positive claim about history and must not be made on a read that failed.
    setRosterHtml(
      `<div class="empty">${escapeHtml(rosterEmptyState(roster.size, agentStats, lastAgentStatsPayload))}</div>`);
    return;
  }
  // Active agents first, then alphabetical, so the thing you care about is at
  // the top without the list reshuffling on every tick.
  const rank = { working: 0, stressed: 1, happy: 2, sleeping: 3 };
  const rows = [...roster.values()].sort((a, b) =>
    (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.agent.localeCompare(b.agent));
  const counts = instanceCounts(latestParty);

  setRosterHtml(rows.map(r =>
    `<div class="agent" data-state="${r.state}" data-agent="${escapeHtml(r.agent)}">` +
      `<div class="face" data-tier="${escapeHtml((r.portrait && r.portrait.tier) || 'text')}">${faceHtml(r.portrait)}${faceEditHtml()}</div>` +
      `<div class="meta"><div class="name" title="${escapeHtml(r.agent)}">${escapeHtml(r.agent)}` +
        countBadgeHtml(r.agent, counts) + `</div>` +
      `<div class="state">${r.state}</div>` +
      agentModelHtml(r.agent) +
      careerHtml(r.agent) +
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

// --- roster width -----------------------------------------------------------
// Narrow trades portrait size for terminal room; wide does the opposite. The
// portrait scales with the panel, so "wider" actually buys bigger faces rather
// than just more whitespace -- which matters because at 34px an expression is a
// few pixels of mouth and unreadable.
// --- roster width -----------------------------------------------------------
// The POLICY lives in app/roster-width.js, where it can be tested: the three
// tuned numbers (min, floor, share) and the clamp were inline here, which is
// what FF1 and FF3 were moved out for and what FF5 failed to do. Miguel, A1.
const rosterEl = document.getElementById('roster');

// `persist` defaults to FALSE, so a width is only stored when the user
// actually chose one. Miguel's R5 was that persisting the CLAMPED result let
// the first shrink overwrite the choice forever; my fix for it defaulted this
// to true and closed only the resize path.
//
// Naomi then measured the load path in a real window -- the one that runs on
// EVERY launch:
//
//   stored 762 (chosen at 1400px), window opens at 800px
//     -> applied 432, stored 432    the choice is destroyed
//   window grows back to 1400px
//     -> still 432                  it never comes back
//
// And it needs no second monitor: the app's own default window is 1200x800,
// cap 660, so any stored width above 660 died on the next ordinary launch.
//
// Defaulting to false is what makes that class of mistake harmless. Forgetting
// the flag now loses persistence, which is invisible and recoverable;
// remembering it wrongly destroyed the only copy of the user's choice. One
// call site opts in, and it is the one where a human dragged something.
function applyRosterWidth(px, { persist = false } = {}) {
  const w = window.rosterWidth(px, window.innerWidth);
  const root = document.documentElement.style;
  root.setProperty('--roster-w', w + 'px');
  root.setProperty('--face', window.faceSize(w) + 'px');
  if (persist) { try { localStorage.setItem('rosterWidth', String(w)); } catch {} }
  // Cell geometry changed, so the pty must be told or Ink's layout corrupts.
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
  return w;
}

// RE-CLAMP WHEN THE WINDOW CHANGES SIZE. Miguel, A1: there was no resize
// listener in this file at all, so a width stored on a large monitor stayed
// applied on a small one and the panel ended up wider than the window,
// covering the terminal the harness exists to show. The flat 420 cap was at
// least bounded; making the cap proportional without this made it unbounded
// on a shrinking window.
//
// Reading the stored value rather than the applied one, so that widening the
// window restores the width the user actually chose instead of leaving it
// pinned at whatever the smallest screen allowed.
// Re-clamp on resize, WITHOUT persisting -- see applyRosterWidth. Coalesced
// to one frame: a window drag fires `resize` continuously, and each one wrote
// storage and scheduled a pty resize, which is what let R5's ratchet run
// frame by frame rather than once (Miguel, A18).
//
// The stored value is read with a strict typeof rather than `Number(...)`:
// `Number(null)` is 0 and `Number.isFinite(0)` is true, so a coercing read of
// an absent key survives only on the `> 0` check -- the trap that heads this
// project's own list, and one this branch fixed elsewhere (A17).
let resizePending = false;
window.addEventListener('resize', () => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    let stored = null;
    try { stored = localStorage.getItem('rosterWidth'); } catch {}
    const want = typeof stored === 'string' && stored.trim() !== '' ? Number(stored) : NaN;
    applyRosterWidth(Number.isFinite(want) && want > 0 ? want : rosterEl.offsetWidth);
  });
});

(function initRosterResize() {
  let stored = 180;
  try { stored = Number(localStorage.getItem('rosterWidth')) || 180; } catch {}
  applyRosterWidth(stored);          // a load is not a choice: never persists

  const grip = document.getElementById('roster-grip');
  if (!grip) return;
  let dragging = false;

  grip.addEventListener('mousedown', (e) => {
    dragging = true;
    grip.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Measured from the right edge, because the panel is right-anchored.
    applyRosterWidth(window.innerWidth - e.clientX, { persist: true });   // the one real choice
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
  });
})();

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

// The hover pencil on a roster face: pick a file, send it as the same
// `portrait set` a drop sends, for the state the card is showing.
agentsEl.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.face-edit');
  if (!btn) return;
  // Not a card click: a plain click on a card does something else (the
  // activity log), and this button must never trigger it.
  e.stopImmediatePropagation();
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
}, true);

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
    renderParty(msg.party);
    roster.clear();
    for (const r of msg.roster || []) roster.set(r.agent, r);
    // Before renderRoster, so the first paint already carries the careers and
    // the models rather than flashing the roster without them.
    if (msg.sessionModel) sessionModel = msg.sessionModel;
    rosterIndexPayload = msg.rosterIndex || null;
    renderAgentStats(msg.agentStats);
    renderRoster();
    if (Array.isArray(msg.seats)) councilSeats = msg.seats;
    if (msg.maxSeats) seatMax = msg.maxSeats;
    councilWarnings = [];
    renderSeats();
    if (!msg.hooks) console.warn('[renderer] host reports no hook helper — moods will not update');
    return;
  }
  if (msg.type === 'mood') {
    roster.set(msg.agent, msg);
    renderRoster();
    return;
  }
  if (msg.type === 'branch') {
    currentBranchName = typeof msg.branch === 'string' ? msg.branch : null;
    renderTitle();
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
  if (msg.type === 'attention') {
    // Delivery is unconditional; only INSISTENCE depends on focus. The old rule
    // skipped the toast whenever the window had focus, which silenced the one
    // case the feature was built for: watching the terminal while a long task
    // runs and wanting to be told when it ends.
    const surfaces = window.surfacesFor(msg, { focused: document.hasFocus() });

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
    // The tab is restored before the socket is open, so a fog request made at
    // load is thrown away. Ask again once there is somewhere to ask.
    if (activeTab === 'fog') requestFog();
    if (activeTab === 'projects') requestProjects();
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
    if (activeTab === 'models' || modelsRefreshPending) {
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

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
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
    setTab(activeTab === null ? (lastTab || DEFAULT_TAB) : null);
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
