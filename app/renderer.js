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

document.getElementById('cwd').textContent = CWD;

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
  if (tab === 'models' && !catalogueMeta) requestModels(false);
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
// The melt confirmation is held HERE and reset on every state change, so an
// armed confirmation cannot survive a lock, an unlock or a re-render and fire
// against a vault the user is no longer looking at.
let confirmingMelt = false;

async function renderVaultLock() {
  const el = document.getElementById('vault-lock');
  if (!el || !window.harness || !window.harness.secrets.lockState) return null;

  const state = await window.harness.secrets.lockState();
  const entries = state && state.locked === false ? await window.harness.secrets.list('') : [];
  const d = window.vaultLockDisplay(state, {
    confirmingMelt,
    entryCount: state && state.locked ? null : entries.length,
  });

  const note = `<div class="locked-note">${escapeHtml(d.note)}</div>`;

  if (d.state === 'locked' || d.state === 'confirm-melt') {
    el.innerHTML = note +
      '<div class="lock-row">' +
        '<input id="vault-key" type="password" placeholder="key" autocomplete="off" />' +
        '<button data-lock="unlock">Open</button>' +
      '</div>' +
      (d.state === 'confirm-melt'
        ? `<div class="melt-warn">${escapeHtml(d.meltWarning)}</div>` +
          '<div class="lock-row">' +
            '<button class="melt" data-lock="melt-confirm">Melt it, I lost the key</button>' +
            '<button data-lock="melt-cancel">Cancel</button>' +
          '</div>'
        : '<div class="lock-row"><button class="melt" data-lock="melt-ask">Forgot the key…</button></div>');
    return d;
  }

  if (d.state === 'open-no-key') {
    el.innerHTML = `<div class="keyless">${escapeHtml(d.note)}</div>` +
      '<div class="lock-row">' +
        '<input id="vault-key" type="password" placeholder="set a key" autocomplete="new-password" />' +
        '<button data-lock="set">Close with a key</button>' +
      '</div>';
    return d;
  }

  el.innerHTML = note +
    '<div class="lock-row">' +
      '<button data-lock="lock">Lock</button>' +
      '<input id="vault-key" type="password" placeholder="new key" autocomplete="new-password" />' +
      '<button data-lock="set">Replace</button>' +
      '<button data-lock="remove">Remove key</button>' +
    '</div>';
  return d;
}

// Delegated, so the controls survive every re-render without rebinding.
document.addEventListener('click', async (e) => {
  const button = e.target.closest('#vault-lock button');
  if (!button) return;
  const act = button.dataset.lock;
  const keyEl = document.getElementById('vault-key');
  const key = keyEl ? keyEl.value : '';

  // Armed only by the ask, and cleared by anything else. A confirmation that
  // outlives the click that raised it is a confirmation nobody gave.
  if (act === 'melt-ask') { confirmingMelt = true; await renderVaultLock(); return; }
  if (act === 'melt-cancel') { confirmingMelt = false; await renderVaultLock(); return; }
  confirmingMelt = false;

  let res = { ok: true };
  if (act === 'unlock') res = await window.harness.secrets.unlock(key);
  else if (act === 'set') res = await window.harness.secrets.setKey(key);
  else if (act === 'lock') res = await window.harness.secrets.lock();
  else if (act === 'remove') res = await window.harness.secrets.removeKey();
  else if (act === 'melt-confirm') res = await window.harness.secrets.melt();

  // The key is cleared whatever happened. A password left in a field is a
  // password on screen, and a failed unlock is the case most likely to leave
  // one there.
  if (keyEl) keyEl.value = '';

  const d = await renderVaultLock();
  if (!res || res.ok !== true) {
    const el = document.getElementById('vault-lock');
    const why = (res && res.error) ? res.error
      : (act === 'unlock' ? 'that key does not open this vault' : 'that did not work');
    if (el) el.innerHTML = `<div class="melt-warn">${escapeHtml(why)}</div>` + el.innerHTML;
  }
  if (d && d.showList) renderVault();
  else {
    const list = document.getElementById('vault-list');
    if (list) list.innerHTML = '';
  }
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
        ${e.shared ? '<span class="scope" title="visible from every project on this machine">shared</span>' : ''}
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
    await window.harness.secrets.remove(id);
    renderVault();
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

function applyTheme(theme) {
  if (!theme) return;
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
  for (const [key, cssVar] of Object.entries({
    bg: '--bg', panel: '--chrome', border: '--border', text: '--text',
    dim: '--dim', accent: '--accent', ok: '--ok', bad: '--bad',
  })) {
    if (c[key]) root.setProperty(cssVar, c[key]);
  }
  // A font change alters cell size, so the pty must be told the new geometry or
  // Ink's layout corrupts.
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}

// --- agent roster -----------------------------------------------------------
const agentsEl = document.getElementById('agents');
const roster = new Map();

function faceHtml(portrait) {
  if (portrait && portrait.kind === 'file') {
    return `<img src="file:///${portrait.path.replace(/\\/g, '/')}" alt="" />`;
  }
  const p = portrait || { initials: '??', hue: 210 };
  // Placeholder: stable per-agent hue so an agent stays recognisable until a
  // generated portrait exists for it.
  return `<span style="width:100%;height:100%;display:flex;align-items:center;` +
         `justify-content:center;background:hsl(${p.hue} 42% 62%)">${p.initials}</span>`;
}

// Career stats per agent, keyed by agent type. Arrives with the handshake and
// again whenever an agent finishes, so the figures move as work happens.
let agentStats = new Map();
// The WHOLE payload, kept beside the map because `ok` lives on the payload and
// not on any row -- and `ok: false` means the figures below are a lower bound,
// which the panel has to be able to say.
let lastAgentStatsPayload = null;

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

function renderRoster() {
  if (roster.size === 0) {
    // Three different situations, not one sentence. "No agents yet" is a
    // positive claim about history and must not be made on a read that failed.
    agentsEl.innerHTML =
      `<div class="empty">${escapeHtml(rosterEmptyState(roster.size, agentStats, lastAgentStatsPayload))}</div>`;
    return;
  }
  // Active agents first, then alphabetical, so the thing you care about is at
  // the top without the list reshuffling on every tick.
  const rank = { working: 0, stressed: 1, happy: 2, sleeping: 3 };
  const rows = [...roster.values()].sort((a, b) =>
    (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.agent.localeCompare(b.agent));

  agentsEl.innerHTML = rows.map(r =>
    `<div class="agent" data-state="${r.state}">` +
      `<div class="face">${faceHtml(r.portrait)}</div>` +
      `<div class="meta"><div class="name" title="${r.agent}">${r.agent}</div>` +
      `<div class="state">${r.state}</div>` +
      careerHtml(r.agent) +
      `</div>` +
    `</div>`
  ).join('');
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
  if (!el || !catalogueMeta) return;
  el.classList.toggle('stale', !!catalogueMeta.stale);

  if (catalogueMeta.source === 'none') {
    el.textContent = 'could not reach OpenRouter - ' + (catalogueMeta.error || 'no catalogue');
    return;
  }
  const mins = catalogueMeta.fetchedAt
    ? Math.max(0, Math.round((Date.now() - catalogueMeta.fetchedAt) / 60000))
    : null;
  const when = mins === null ? 'unknown age'
    : mins < 1 ? 'just now'
      : mins < 60 ? mins + ' min ago'
        : Math.round(mins / 60) + ' h ago';
  // Staleness is STATED, never implied. A month-old price shown as current is
  // the failure here that actually costs money.
  el.textContent = catalogueMeta.stale
    ? 'PRICES MAY BE OUT OF DATE - cached ' + when + ', could not refresh (' +
      (catalogueMeta.error || 'offline') + ')'
    : catalogue.length + ' models, ' + when;
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

  // GROUPED BY PROVIDER. 445 flat rows is a wall; the provider is also the unit
  // the council actually cares about, since two models from one vendor share
  // failure modes. Groups are ordered by their best member under the chosen
  // sort, so "cheapest" still puts the cheapest provider first rather than
  // alphabetising them and burying it.
  const groups = new Map();
  for (const m of rows) {
    const key = m.provider || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const list of groups.values()) list.sort(within);

  const ordered = [...groups.entries()].sort((a, b) => within(a[1][0], b[1][0]));

  const seated = {};
  for (const st of councilSeats) seated[st.id] = true;

  // Capped across the whole list, not per group: 445 rows of DOM per keystroke
  // stutters. The line underneath says what is hidden rather than letting the
  // list imply it is complete.
  const LIMIT = 200;
  let drawn = 0;
  const out = [];
  for (const [provider, list] of ordered) {
    if (drawn >= LIMIT) break;
    const take = list.slice(0, LIMIT - drawn);
    drawn += take.length;
    out.push('<div class="provider"><span class="p-name">' + escapeHtml(provider) +
      '</span><span class="p-count">' + list.length + '</span></div>');
    for (const m of take) {
      const price = m.priced ? money(m.promptPerM) + ' / ' + money(m.completionPerM) : 'price unknown';
      // The short name inside a provider group: the prefix is the heading.
      const short = m.id.indexOf('/') > 0 ? m.id.slice(m.id.indexOf('/') + 1) : m.id;
      const tip = m.name + ' -- ' + m.id + ' -- ' +
        (m.tools ? 'supports tools' : 'NO tool support, cannot drive the main session');
      out.push('<div class="model' + (seated[m.id] ? ' seated' : '') + '" data-model="' +
        escapeHtml(m.id) + '" title="' + escapeHtml(tip) + '">' +
        '<span class="m-id">' + escapeHtml(short) + '</span>' +
        (m.tools ? '' : '<span class="m-notools">no tools</span>') +
        '<span class="m-ctx">' + ctxLabel(m.context) + '</span>' +
        '<span class="m-price' + (m.priced ? '' : ' unknown') + '">' + escapeHtml(price) + '</span>' +
        '</div>');
    }
  }
  if (rows.length > drawn) {
    out.push('<div class="none">' + (rows.length - drawn) + ' more, narrow the search</div>');
  }
  el.innerHTML = out.join('');
}

function requestModels(force) {
  try { ws.send(JSON.stringify({ type: 'models', force: !!force })); } catch (e) {}
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

function applyBackground(filePath) {
  if (!filePath) return;
  backgroundUrl = 'file:///' + String(filePath).replace(/\\/g, '/');
  document.getElementById('bg').style.backgroundImage = `url("${backgroundUrl}")`;
  document.body.classList.add('has-bg');

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
  procListEl.innerHTML = running.map(p => {
    const slow = p.elapsedMs >= 60000 ? ' slow' : '';
    return '<div class="proc' + slow + '"><span class="dot"></span>' +
           '<span class="lbl" title="' + p.tool + ': ' + p.label + '">' + p.label + '</span>' +
           '<span class="el">' + humanElapsed(p.elapsedMs) + '</span></div>';
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

function handleControl(msg) {
  if (msg.type === 'hello') {
    // The host sends `hello` immediately before replaying the current screen.
    // Without this reset, reattaching after a detach appends the replay to what
    // is already on screen and the session appears twice.
    term.reset();
    document.getElementById('cwd').textContent = msg.cwd || '';
    // Background first: applyTheme needs to know whether to make the terminal
    // translucent, and getting that order wrong leaves the art fully hidden.
    applyBackground(msg.background);
    applyTheme(msg.theme);
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
    renderParty(msg.party);
    roster.clear();
    for (const r of msg.roster || []) roster.set(r.agent, r);
    // Before renderRoster, so the first paint already carries the careers
    // rather than flashing the roster without them.
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
  if (msg.type === 'processes') {
    // Deliberately does NOT touch the mode badge. A processes message carries no
    // `mode`, so calling renderMode(undefined) here hid the badge a second after
    // `hello` had correctly set it -- the host was right the whole time.
    renderProcesses(msg.running);
    renderParty(msg.party);
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
  if (msg.type === 'models') {
    catalogue = Array.isArray(msg.models) ? msg.models : [];
    catalogueMeta = { source: msg.source, fetchedAt: msg.fetchedAt, stale: msg.stale, error: msg.error };
    if (Array.isArray(msg.seats)) councilSeats = msg.seats;
    if (Array.isArray(msg.warnings)) councilWarnings = msg.warnings;
    if (msg.max) seatMax = msg.max;
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
  if (msg.type === 'usage') {
    // Same reason as above: no `mode` on this message, so leave the badge alone.
    renderUsage(msg.usage);
    return;
  }
  if (msg.type === 'dropped') {
    renderDropNote(msg.note);
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
  // -- the terminal consumed it and sent  to the pty, which readline reads
  // as backward-char. The binding looked dead while quietly editing the command
  // line. Returning false is what stops the terminal taking it.
  if (isPanelToggle(e)) {
    setTab(activeTab === null ? (lastTab || DEFAULT_TAB) : null);
    e.preventDefault();
    return false;
  }

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
  if (e.ctrlKey && e.key === 'v')    { hit.add('paste'); renderChecks(); }

  return true;
});

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
