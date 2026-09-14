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
  // Ctrl+B shows or hides the whole side panel. The TAB is the real control;
  // this is only the way back once the panel is collapsed and its tabs are
  // gone with it.
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyB') {
    setTab(activeTab === null ? lastTab : null);
    e.preventDefault();
  }
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
  const res = await window.harness.secrets.add({ label: label.value, secret: secret.value });
  if (!res.ok) {
    const list = document.getElementById('vault-list');
    list.innerHTML = `<div class="err">${escapeHtml(res.error)}</div>` + list.innerHTML;
    return;
  }
  label.value = '';
  secret.value = '';
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

function renderRoster() {
  if (roster.size === 0) {
    agentsEl.innerHTML = '<div class="empty">No agents yet — portraits light up when one runs.</div>';
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
      `<div class="state">${r.state}</div></div>` +
    `</div>`
  ).join('');
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
  const fresh = s => s.input + s.output;
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
      `<span class="val">${num(session.total)}</span>` +
      `<span class="sub">${sub(`(${compact(fresh(session))} fresh)`)}</span>` +
    `</span>` +
    `<span class="grp" title="${title(`Every session on this folder - ${detail(project)}`)}">` +
      `<span class="lbl">project</span>` +
      `<span class="val">${num(project.total)}</span>` +
      `<span class="sub">${sub(`${project.sessions} session${project.sessions === 1 ? '' : 's'}`)}</span>` +
    `</span>` +
    // Said out loud, not only in a tooltip. A status nobody can see is the
    // defect this whole change exists to fix.
    (how.note ? `<span class="grp note" title="${how.note}">${how.note}</span>` : '') +
    milestoneHtml(usage.milestone);
}

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
  const title = (reached ? `${reached.name} reached. ` : '')
    + (next ? `${compact(next.at)} for ${next.name}.` : 'Top of the ladder.')
    + share;

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
const ROSTER_MIN = 120;
const ROSTER_MAX = 420;
const rosterEl = document.getElementById('roster');

function applyRosterWidth(px) {
  const w = Math.max(ROSTER_MIN, Math.min(ROSTER_MAX, Math.round(px)));
  const root = document.documentElement.style;
  root.setProperty('--roster-w', w + 'px');
  // Faces grow with the panel, capped so they stay a portrait and not a poster.
  // Tuned so the default 180px panel gives a ~41px face with room for the name,
  // and widening actually buys a bigger portrait. The first formula produced
  // 73px faces at the default width and truncated every agent name.
  root.setProperty('--face', Math.round(Math.max(28, Math.min(150, 28 + (w - 120) * 0.22))) + 'px');
  try { localStorage.setItem('rosterWidth', String(w)); } catch {}
  // Cell geometry changed, so the pty must be told or Ink's layout corrupts.
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
  return w;
}

(function initRosterResize() {
  let stored = 180;
  try { stored = Number(localStorage.getItem('rosterWidth')) || 180; } catch {}
  applyRosterWidth(stored);

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
    applyRosterWidth(window.innerWidth - e.clientX);
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
    renderHealth(msg.health);
    renderCooldowns(msg.cooldowns);
    renderProcesses(msg.running);
    if (msg.modes) modeTable = msg.modes;
    renderMode(msg.mode);
    renderParty(msg.party);
    roster.clear();
    for (const r of msg.roster || []) roster.set(r.agent, r);
    renderRoster();
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
  if (msg.type === 'mode') {
    renderMode(msg.mode);
    return;
  }
  if (msg.type === 'usage') {
    // Same reason as above: no `mode` on this message, so leave the badge alone.
    renderUsage(msg.usage);
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

// --- key handling -----------------------------------------------------------
// Returning false stops xterm's default handling for that event.
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;

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
