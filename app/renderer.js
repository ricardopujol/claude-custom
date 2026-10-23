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
// What waits for a look (#31): an urgent need, a finished turn. tab-status.js decides the transitions.
let tabPending = { urgent: false, finished: false };
// The host's measure of the MAIN session from the CLI's hooks (host/turn-state.js): 'idle' | 'turn' |
// 'prompt', or null -- not said yet, an older host, or the socket is down. Unknown is not idle (PR #93 F1/F2).
let sessionTurn = null;
// The terminal bar (backlog #49 + #52): the host's latest main-session prompt and where the CLI echoed it in the
// terminal buffer, the bedtime night, and the epoch that invalidates the anchor. Every decision is in
// app/terminal-bar.js; this only holds the facts and paints what it says.
const bar = { prompt: null, anchor: null, locate: null, epoch: 0, lastLength: 0, bedtime: null, nightKey: '', fullOpen: false, queued: false, paintKey: '', chipsKey: '', summaryShown: false };
// The where-are-we summary (backlog #39 job 1): the host's local-model summary of this session, why there is none, when
// the panel was opened (a switch to a tab untouched for 10 minutes), whether it is pinned, whether a key was struck
// since it opened, and the last real keystroke. Every decision is in app/summary-display.js.
const sentInputs = [];
const sum = { summary: null, off: null, openedAt: null, pinned: false, typed: false, lastInputAt: null, timer: null, session: null };
// How long the CLI's echo of a submitted prompt is waited for in the terminal buffer, and how many of the newest lines
// are searched, before the prompt fails visible (PR #99 Dexter F6).
const LOCATE_MS = 3000;
const LOCATE_SCAN = 400;
// The bar's own height in CSS px (top offset + row): the terminal rows it hides while a chip keeps it open (F7).
const BAR_COVER_PX = 40;
let wasWorking = false;
let lastReportedTabStatus = null;
// OSC 7501 (BACKLOG #116): the CLI's own root state as the host last said it (cleaned), or null. The host parses the stream
// and answers the CLI; this only shows it and moves the cue (host/attention.js raises the toast and the urgent/finished frame).
let programRoot = null;
function pend(event) {
  if (window.tabStatus) tabPending = window.tabStatus.pendingAfter(tabPending, event);
}
function reportTabStatus() {
  if (!(window.harness && window.harness.tabStatus && window.tabStatus)) return;
  const anyWorking = typeof roster !== 'undefined' && [...roster.values()].some(r => r && r.state === 'working');
  // A turn STARTING ends a finished one; a session still working when it finishes keeps it.
  if (anyWorking && !wasWorking) pend('working');
  wasWorking = anyWorking;
  const status = window.tabStatus.tabStatus({
    mainMood: anyWorking ? 'working' : null,
    pendingUrgent: tabPending.urgent,
    pendingFinished: tabPending.finished,
    lock: tabLock,
    health: tabHealth,
    turn: sessionTurn,
    night: bar.bedtime !== null,
    program: programRoot,
    summary: sum.summary ? { ...sum.summary, note: summaryDisplay.offNote(sum.off) } : null,
    // with no summary yet, why (Ollama off) rides on the hover card alone: the bar does not pop up for it
    summaryNote: sum.summary ? null : summaryDisplay.offNote(sum.off),
  }, { healthMarker: worktreeStatus.healthMarker, cleanProgram: programStatusDisplay.clean });
  if (lastReportedTabStatus && window.tabStatus.sameStatus(lastReportedTabStatus, status)) return;
  lastReportedTabStatus = status;
  window.harness.tabStatus(status);
}
// A new root record from the host (the hello, or a `program-status` frame). The header dot and the tab's dots show it; a start
// of work clears a finished cue, and leaving blocked or error without finishing clears the need (the same flags attention uses).
function applyProgramStatus(rootRecord, how) {
  const next = programStatusDisplay.clean(rootRecord);
  for (const event of programStatusDisplay.cueEvents(programRoot, next, how)) pend(event);
  programRoot = next;
  const headerDot = document.getElementById('dot');
  if (headerDot) {
    headerDot.classList.remove('ps-working', 'ps-blocked', 'ps-done', 'ps-error');
    const view = programStatusDisplay.headerView(next);
    if (view) { headerDot.classList.add(view.cls); headerDot.title = view.title; } else headerDot.removeAttribute('title');
  }
  reportTabStatus();
}
if (window.harness && window.harness.onTabSelected) {
  // Looked at: whatever was waiting for you has been seen.
  window.harness.onTabSelected(() => { pend('looked'); reportTabStatus(); summaryOpenIfIdle(); });
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

// --- worktree occupancy and the terminal bar (backlog #44 + #47, #49, #52) --------------
// What main pushes (app/occupancy-display.js viewPayload): `here` is the live agent claims in THIS folder (the bar's
// occupancy chip, and the first-keystroke confirm), `launched` the ones THIS session launched (the roster cards'
// `-> worktree` lines). #47's banner is retired into the bar: ONE row over the terminal, the last prompt on the left
// once it has scrolled away (#49), the status chips on the right -- a moon for a /bedtime night (#52) and the agents'
// initials for occupancy. Every decision is in app/terminal-bar.js, app/occupancy-display.js and
// app/occupancy-confirm.js; this only paints what they return, and sends what the confirm releases. Nothing here
// makes anything read-only, and nothing animates.
// `session` is this tab's session id, from the host (`hello`, then `session` on every SessionStart): a card's line is
// only a claim of THIS session's run, never another session's agent of the same name in the same folder (backlog #57).
const occupancy = { here: [], launched: [], confirm: null, jumpNote: '', session: null };
const sessionIdOf = id => (typeof id === 'string' && id !== '' ? id : null);
const occupancyEls = { confirm: document.getElementById('occupancy-confirm'), confirmText: document.getElementById('occupancy-confirm-text') };
const barEls = {
  bar: document.getElementById('terminal-bar'),
  prompt: document.getElementById('bar-prompt'),
  text: document.getElementById('bar-prompt-text'),
  age: document.getElementById('bar-prompt-age'),
  full: document.getElementById('bar-prompt-full'),
  chips: document.getElementById('bar-chips'),
  summary: document.getElementById('bar-summary'),
  summaryLabel: document.getElementById('bar-summary-label'),
  summaryCard: document.getElementById('bar-summary-card'),
  summaryLines: document.getElementById('bar-summary-lines'),
  summaryNote: document.getElementById('bar-summary-note'),
};

// The bar's own place in time: coalesced, so a burst of scrolling paints once. A timer, not requestAnimationFrame:
// a tab that isn't showing gets no animation frames, and its bar still has to be right when it comes back.
function paintBar() {
  if (bar.queued) return;
  bar.queued = true;
  setTimeout(() => { bar.queued = false; paintBarNow(); }, 16);
}

function chipElement(c) {
  const jumps = c.kind === 'occupancy' && c.jump;
  const el = document.createElement(jumps ? 'button' : 'span');
  el.className = 'bar-chip ' + (c.kind === 'bedtime' ? 'bedtime' : 'occupancy') + (c.warn ? ' warn' : '');
  if (jumps) { el.type = 'button'; el.dataset.root = c.jump.root; } else { el.tabIndex = 0; el.setAttribute('role', 'note'); }
  el.setAttribute('aria-label', c.short + (c.long ? ': ' + c.long.split('\n').join(', ') : ''));
  const short = document.createElement('span');
  short.className = 'chip-short';
  short.textContent = c.short;
  el.appendChild(short);
  const lines = c.long ? c.long.split('\n') : [];
  if (jumps) lines.push(c.jump.label);
  if (lines.length) {
    const long = document.createElement('span');
    long.className = 'chip-long';
    long.textContent = lines.join('\n');
    el.appendChild(long);
  }
  if (jumps) el.addEventListener('click', () => jumpToFolder(c.jump.root));
  return el;
}

// What the probe reads back (verify/probe-terminal-bar.js): the bar as painted, and the buffer it was painted from.
function barState() {
  const buf = term.buffer.active;
  const cs = getComputedStyle(barEls.bar);
  return {
    inputs: sentInputs.slice(),
    bar: {
      hidden: barEls.bar.hidden, open: document.body.classList.contains('bar-open'), animation: cs.animationName, transition: cs.transitionProperty, transitionDuration: cs.transitionDuration, display: cs.display,
      top: Math.round(barEls.bar.getBoundingClientRect().top), height: Math.round(barEls.bar.getBoundingClientRect().height),
      summary: {
        hidden: barEls.summary.hidden, cardHidden: barEls.summaryCard.hidden, label: barEls.summaryLabel.textContent,
        lines: [...barEls.summaryLines.children].map(l => l.textContent), note: barEls.summaryNote.hidden ? null : barEls.summaryNote.textContent,
        dim: barEls.summary.classList.contains('dim'), expanded: barEls.summary.getAttribute('aria-expanded'),
        animation: getComputedStyle(barEls.summary).animationName, cardAnimation: getComputedStyle(barEls.summaryCard).animationName,
        cardTop: Math.round(barEls.summaryCard.getBoundingClientRect().top), cardHeight: Math.round(barEls.summaryCard.getBoundingClientRect().height),
        color: getComputedStyle(barEls.summaryCard).color, background: getComputedStyle(barEls.summaryCard).backgroundColor,
      },
      prompt: { hidden: barEls.prompt.hidden, text: barEls.text.textContent, age: barEls.age.textContent, full: barEls.full.textContent, fullHidden: barEls.full.hidden,
        expanded: barEls.prompt.getAttribute('aria-expanded') },
      chips: [...barEls.chips.children].map(c => ({
        kind: c.classList.contains('bedtime') ? 'bedtime' : 'occupancy', warn: c.classList.contains('warn'), tag: c.tagName.toLowerCase(),
        short: c.querySelector('.chip-short').textContent, long: c.querySelector('.chip-long') ? c.querySelector('.chip-long').textContent : '',
        leftRule: getComputedStyle(c).borderLeftWidth, animation: getComputedStyle(c).animationName,
        color: getComputedStyle(c).color, background: getComputedStyle(c).backgroundColor,
      })),
    },
    buffer: { viewportY: buf.viewportY, baseY: buf.baseY, cursorY: buf.cursorY, length: buf.length, rows: term.rows, type: buf.type },
    // the text of the buffer line the anchor points at: the probe checks it is where the echo is
    anchorText: bar.anchor && typeof bar.anchor.line === 'number' && buf.getLine(bar.anchor.line) ? buf.getLine(bar.anchor.line).translateToString(true) : null,
    locating: !!bar.locate,
    epoch: bar.epoch, anchor: bar.anchor, prompt: bar.prompt, bedtime: bar.bedtime,
  };
}

function paintBarNow() {
  const now = Date.now();
  const buf = term.buffer.active;
  // A buffer that shrank was cleared: every absolute line moved, so the anchor is no longer a place (fails visible).
  if (buf.length < bar.lastLength) bar.epoch += 1;
  bar.lastLength = buf.length;
  const chip = window.occupancyDisplay ? window.occupancyDisplay.chipModel(occupancy.here, { turn: sessionTurn, now }) : null;
  if (chip && occupancy.jumpNote) chip.lines.push(occupancy.jumpNote);
  // A chip keeps the bar open over the terminal's first rows, so a prompt line under it is as good as scrolled away.
  const rowPx = term.rows > 0 ? document.getElementById('term').clientHeight / term.rows : 0;
  const coveredRows = (bar.bedtime !== null || chip !== null) && rowPx > 0 ? Math.ceil(BAR_COVER_PX / rowPx) : 0;
  const panel = window.summaryDisplay
    ? summaryDisplay.panelModel({ summary: sum.summary, off: sum.off, now, openedAt: sum.openedAt, pinned: sum.pinned, typed: sum.typed })
    : null;
  const m = terminalBar.barModel({
    prompt: bar.prompt,
    anchor: bar.anchor,
    // An alternate screen (a full-screen TUI) keeps no scrollback to scroll away into, and a full scrollback is
    // trimming from the top: in both the lines are not where they were, so the prompt shows.
    view: { viewportY: buf.viewportY, bufferLength: buf.length, full: buf.type === 'alternate' || buf.length >= term.options.scrollback + term.rows, epoch: bar.epoch, coveredRows },
    now,
    bedtime: bar.bedtime,
    occupancy: chip,
    summary: panel,
    focusMode: document.body.classList.contains('focus-mode') || leanOn,
  });
  bar.summaryShown = !!m.summary;
  if (!m.prompt) bar.fullOpen = false;
  // Nothing changed since the last paint (a scroll event per streamed line asks for a paint each): no DOM writes at all,
  // so a selection inside the whole-prompt view survives (PR #99 Miguel Y1, G1).
  const key = JSON.stringify([m, bar.fullOpen]);
  if (key !== bar.paintKey) {
    bar.paintKey = key;
    barEls.bar.hidden = !m.visible;
    document.body.classList.toggle('bar-open', m.visible);
    // The local model's summary takes the prompt part's place (textContent only: it is a model's words).
    barEls.summary.hidden = !m.summary;
    barEls.summaryCard.hidden = !m.summary;
    if (m.summary) {
      setText(barEls.summaryLabel, m.summary.label);
      barEls.summaryLines.replaceChildren(...m.summary.lines.map((l) => { const d = document.createElement('div'); d.textContent = l; return d; }));
      barEls.summaryNote.hidden = !m.summary.note;
      setText(barEls.summaryNote, m.summary.note || '');
      barEls.summary.classList.toggle('dim', m.summary.dim);
      barEls.summaryCard.classList.toggle('dim', m.summary.dim);
    }
    // "expanded" is the card showing, whether the person pinned it or a switch opened it
    barEls.summary.setAttribute('aria-expanded', String(!!m.summary));
    barEls.prompt.hidden = m.prompt === null;
    if (m.prompt) {
      setText(barEls.text, m.prompt.head);
      setText(barEls.age, m.prompt.age ? '· ' + m.prompt.age : '');
      setText(barEls.full, m.prompt.full);
    }
    barEls.full.hidden = !(m.prompt && bar.fullOpen);
    barEls.prompt.setAttribute('aria-expanded', String(!!(m.prompt && bar.fullOpen)));
    // Rebuilt only when the chips themselves changed, so a hover isn't dropped by the 30 s minute refresh.
    const chipsKey = JSON.stringify(m.chips);
    if (chipsKey !== bar.chipsKey) {
      bar.chipsKey = chipsKey;
      barEls.chips.replaceChildren(...m.chips.map(chipElement));
    }
  }
  paintOccupancyConfirm(occupancy.confirm ? occupancy.confirm.state() : null);
}

// A write that changes nothing still replaces the text node, which collapses a selection inside it.
function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

// The confirm's words follow what is going on here: an overnight run, agents writing, or both.
function confirmQuestion() {
  const parts = [];
  if (bar.bedtime !== null) parts.push('An overnight run is going.');
  if (occupancy.here.length > 0 || parts.length === 0) parts.push('An agent is writing here.');
  return parts.join(' ') + ' Type anyway?';
}

// A bedtime night is a run of its own for the confirm (a new night asks again, one that ends releases what was held).
// `persist`: the night is ONE run for its whole life, so a socket drop or an overdue verdict that takes its claim away
// for a moment doesn't make it a new run (PR #99 Dexter F4); a different night is a different id.
function nightClaim() {
  return bar.bedtime !== null ? { agentId: 'bedtime:' + bar.bedtime.startedAt, persist: true } : null;
}
function confirmClaims() {
  const night = nightClaim();
  return night ? [...occupancy.here, night] : occupancy.here;
}

function paintOccupancyConfirm(state) {
  occupancyEls.confirm.hidden = !(state && state.asking);
  occupancyEls.confirm.classList.toggle('warn', occupancy.here.length > 0 && sessionTurn === 'turn');
  occupancyEls.confirmText.textContent = confirmQuestion();
}

function applyOccupancy(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  occupancy.here = Array.isArray(p.here) ? p.here : [];
  occupancy.launched = Array.isArray(p.launched) ? p.launched : [];
  occupancy.jumpNote = '';
  if (occupancy.confirm) occupancy.confirm.setClaims(confirmClaims());
  paintBar();
  if (typeof renderRoster === 'function') renderRoster();
}

// The newest buffer lines from `from`, as text (what findEcho searches).
function bufferTexts(from) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = from; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

// Find the line the CLI ECHOED the prompt on, by its text (PR #99 Dexter F6; measured by verify/probe-prompt-anchor.js:
// the real CLI pins its input box to the bottom row, so the cursor is 24-30 lines BELOW the echo and tells nothing).
// It runs once the terminal has parsed what came before the prompt event, then again as output is parsed, and keeps the
// newest match for LOCATE_MS: the echo may not be drawn yet, and an older echo of the same words is only a stand-in.
function locateEcho() {
  const loc = bar.locate;
  if (!loc) return;
  if (!bar.prompt || bar.prompt.seq !== loc.seq) { clearTimeout(loc.timer); bar.locate = null; return; }
  const buf = term.buffer.active;
  const from = Math.max(0, buf.length - LOCATE_SCAN);
  const at = terminalBar.findEcho(bufferTexts(from), loc.needle);
  if (at < 0) return;
  const line = from + at;
  const a = bar.anchor;
  if (a && a.locating !== true && a.seq === loc.seq && a.epoch === bar.epoch && a.line >= line) return;
  bar.anchor = terminalBar.makeAnchor(bar.prompt, { line, epoch: bar.epoch });
  paintBar();
}

// The host's latest main-session prompt. A LIVE one (a control message) is LOCATED in the terminal by its echo (above);
// until it is found its anchor is "locating" (the bar doesn't flash), and one that is never found within LOCATE_MS (a
// pasted block the CLI shows collapsed, a prompt it echoes differently) FAILS VISIBLE: no anchor, the prompt shows. One
// that arrives in `hello` (a window that attached later) has no place in this buffer, so it shows until the next one.
function applyBarPrompt(prompt, live) {
  const p = prompt && typeof prompt === 'object' && typeof prompt.text === 'string' && typeof prompt.seq === 'number' && Number.isFinite(prompt.seq) ? prompt : null;
  const changed = !bar.prompt || !p || bar.prompt.seq !== p.seq;
  if (bar.locate) { clearTimeout(bar.locate.timer); bar.locate = null; }
  bar.prompt = p;
  bar.anchor = null;
  if (changed) bar.fullOpen = false;
  const needle = p && live ? terminalBar.echoNeedle(p.text) : null;
  if (p && needle) {
    bar.anchor = terminalBar.locatingAnchor(p, bar.epoch);
    const loc = { seq: p.seq, needle, queued: false, timer: null };
    loc.timer = setTimeout(() => {
      if (bar.locate !== loc) return;
      bar.locate = null;
      if (bar.anchor && bar.anchor.locating === true) { bar.anchor = null; paintBar(); }
    }, LOCATE_MS);
    bar.locate = loc;
    term.write('', () => { if (bar.locate === loc) locateEcho(); });
  }
  paintBar();
}



// Lean mode follows the HOST's word about the night (main's app/lean-state.js decides what it means); a dropped socket
// says nothing, so it never ends a night here.
let lastLeanNight;
function reportLeanNight() {
  const at = bar.bedtime !== null ? bar.bedtime.startedAt : null;
  if (at === lastLeanNight) return;
  lastLeanNight = at;
  if (window.harness && window.harness.lean) window.harness.lean.night(at);
}

function applyBedtime(payload, { fromHost = true } = {}) {
  bar.bedtime = payload && typeof payload === 'object' && typeof payload.startedAt === 'number' && Number.isFinite(payload.startedAt) ? payload : null;
  // A new night forgets the last one's answer (its id is never seen again); the same night returning keeps it.
  if (bar.bedtime !== null) {
    const key = 'bedtime:' + bar.bedtime.startedAt;
    if (bar.nightKey && bar.nightKey !== key && occupancy.confirm) occupancy.confirm.forget(bar.nightKey);
    bar.nightKey = key;
  }
  if (occupancy.confirm) occupancy.confirm.setClaims(confirmClaims());
  if (fromHost) reportLeanNight();
  paintBar();
  reportTabStatus();
}

// The person's own typing: through the confirm when there is one. A raw `send` stays for everything the program
// types itself (the top bar, Type /merged, resize), which is never the person becoming a second writer.
function userInput(data) {
  if (occupancy.confirm) occupancy.confirm.input(data); else send(data);
}

if (window.occupancyConfirm) {
  occupancy.confirm = occupancyConfirm.createConfirm({ send: (data) => send(data), onChange: paintOccupancyConfirm });
}
document.getElementById('occupancy-type').addEventListener('click', () => occupancy.confirm.type());
document.getElementById('occupancy-wait').addEventListener('click', () => occupancy.confirm.wait());
// The prompt part opens the whole prompt (scrollable, selectable) and closes it again.
barEls.prompt.addEventListener('click', () => { bar.fullOpen = !bar.fullOpen; paintBarNow(); });
// Escape closes it again, from inside the bar only: the terminal's own Escape (interrupt) is never taken (PR #99 Miguel G3).
barEls.bar.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // The where-are-we panel (#39): with the focus on the bar or the panel itself, Escape closes it and goes no further. With the
  // focus in the terminal this handler never runs: Escape is Claude's interrupt and reaches the pty untouched, and the panel
  // closes by the first-keystroke rule (summaryTyped, which only observes the key).
  if (bar.summaryShown) {
    sum.openedAt = null;
    sum.pinned = false;
    paintBarNow();
    e.stopPropagation();
    term.focus();
    return;
  }
  if (!bar.fullOpen) return;
  bar.fullOpen = false;
  paintBarNow();
  e.stopPropagation();
  term.focus();
});

// Jump to the launching session's tab, or the worktree an agent is in: the Git drawer's own path.
async function jumpToFolder(folder) {
  if (!folder || !(window.harness && window.harness.selectFolder)) return;
  let r = null;
  try { r = await window.harness.selectFolder(folder); } catch { r = null; }
  if (r && r.kind === 'explain' && r.text) {
    occupancy.jumpNote = r.text;
    paintBar();
  }
}

// The minutes on the bar (the prompt's age, "wake due") go stale between pushes.
setInterval(() => { if (!leanOn && (bar.prompt || bar.bedtime !== null || occupancy.here.length > 0 || sum.pinned)) paintBar(); }, 30000);

// --- the where-are-we summary (backlog #39 job 1) ----------------------------------------------------------
// The host's local-model summary of this session (host/summary-service.js). Every decision is in
// app/summary-display.js; this holds the facts, opens the panel when you SWITCH to a tab you haven't touched for 10
// minutes, and paints what the model says in the terminal bar. READ-ONLY: nothing here types into the session.
function applySummary(p, opening) {
  const o = p && typeof p === 'object' ? p : {};
  sum.summary = o.summary && typeof o.summary === 'object' ? o.summary : null;
  sum.off = o.off && typeof o.off === 'object' ? o.off : null;
  // The pin and the open panel belong to the summary they were made for: /clear (it goes away) or another session's
  // summary releases them, so a later push never surfaces a pinned panel under your hands (Dexter F7).
  Object.assign(sum, summaryDisplay.afterPush(sum, sum.summary));
  // Only a window that has just attached opens it: a live push of a newer summary never pops it up under your hands.
  if (opening && !document.hidden) summaryOpenIfIdle();
  paintBar();
  reportTabStatus();
}
// "Untouched" is the newest of your last real keystroke here and the host's last prompt (it also sees one sent from
// elsewhere); a tab nobody has typed in this run counts as untouched.
function summaryOpenIfIdle() {
  if (!window.summaryDisplay) return;
  const now = Date.now();
  const last = summaryDisplay.lastTouchedAt(sum.lastInputAt, bar.prompt && bar.prompt.at);
  if (!summaryDisplay.openOnSelect({ summary: sum.summary, lastInputAt: last, now })) return;
  sum.openedAt = now;
  sum.typed = false;
  clearTimeout(sum.timer);
  sum.timer = setTimeout(() => paintBar(), summaryDisplay.SHOW_MS + 50);
  paintBar();
}
// A real keystroke: the first one hides an unpinned panel.
function summaryTyped() {
  sum.lastInputAt = Date.now();
  if (sum.openedAt !== null && !sum.pinned) { sum.typed = true; paintBar(); }
}
// A click pins it open (and a second click closes it); Escape inside the bar closes it (the keydown handler above).
barEls.summary.addEventListener('click', () => {
  if (sum.pinned) { sum.pinned = false; sum.openedAt = null; } else { sum.pinned = true; }
  paintBarNow();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) summaryOpenIfIdle(); });
// --- end of the where-are-we summary ---

if (window.harness && window.harness.occupancy) {
  window.harness.occupancy.onChange(applyOccupancy);
  window.harness.occupancy.get().then(applyOccupancy).catch(() => { /* the next push carries it */ });
}

// --- fonts and plain colour (BACKLOG #88, #92) ---------------------------------
// Declared before the terminal because applyTheme (called from many places) reads them. `null` = not yet known.
let fontSettings = null;            // main's app-wide record: { terminalFont, terminalSize, uiFont }
let projectTerminalFont = null;     // this project's look.terminalFont: the override over the app-wide one
let plainColourOn = false;          // this project's look.backgroundMode === 'colour': no media, the app colour is the background
let fontFamilies = null;            // every installed family main listed (null = not listed yet)
let fontListError = null;           // why the list is missing, in words, or null
let fontListAt = 0;                 // when it was last asked for: asked again after FONT_LIST_REFRESH_MS, so a new font appears
let fontListBusy = false;
const FONT_LIST_REFRESH_MS = 30000;
const FONT_ROWS_SHOWN = 80;         // a search narrows a long list; this keeps the panel light before the person types
const fontQueries = { term: '', ui: '', project: '' };
let fontFocusAfter = null;          // which picker's search box gets the keyboard back once a pick has redrawn the panel
const fixedFamilyCache = new Map(); // family -> true when it is fixed pitch; measured once, by the canvas the renderer itself draws with

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

// #37: a local path the terminal shows becomes a link when main says it
// exists. The rows a long path spans are joined first (app/terminal-rows.js:
// Ink breaks rows itself, so isWrapped can't be trusted -- measured in
// verify/probe-file-link-rows.js). Main decides open or reveal, and decides
// again on the click (app/file-link.js).
function bufferRow(y) {
  const line = term.buffer.active.getLine(y);
  if (!line) return null;
  const cells = [];
  for (let x = 0; x < term.cols; x++) {
    const c = line.getCell(x);
    cells.push(c ? { chars: c.getChars(), width: c.getWidth() } : { chars: '', width: 1 });
  }
  return { cells };
}
term.registerLinkProvider({
  provideLinks(lineNumber, callback) {
    try {
      if (!window.harness || typeof window.harness.checkPaths !== 'function') { callback(undefined); return; }
      const b = terminalRows.block(bufferRow, lineNumber - 1, term.cols);
      // Only what touches the hovered row is asked about (PR #92 Miguel I2).
      const cands = filePathParse.findCandidates(b.text, b.breaks, { within: terminalRows.rowSpan(b, lineNumber - 1) });
      if (cands.length === 0) { callback(undefined); return; }
      Promise.resolve(window.harness.checkPaths(cands.map(c => c.options.map(o => o.path)))).then((answers) => {
        const links = filePathParse.pickLinks(cands, answers || [])
          .map(l => toXtermLink(b, l))
          .filter(l => l && l.range.start.y <= lineNumber && l.range.end.y >= lineNumber);
        callback(links.length ? links : undefined);
      }, () => callback(undefined));
    } catch (err) {
      console.error('[file-links] provideLinks threw', err);
      callback(undefined);
    }
  },
});
// A picked link -> xterm's ILink (the range math is terminalRows.linkRange,
// tested on its own: 1-based, end inclusive, over real cells only).
function toXtermLink(b, { start, end, answer }) {
  const range = terminalRows.linkRange(b, start, end);
  if (!range || !answer || typeof answer.path !== 'string') return null;
  return {
    range,
    text: b.text.slice(start, end),
    activate: (event) => openFileLink(event, answer.path),
    hover: () => showLinkTarget(linkClick.fileTargetText(answer)),
    leave: () => showLinkTarget(null),
  };
}
// The same click rule as a web link (one plain left click, once); `p` is the
// absolute path main resolved, which main re-checks before doing anything.
function openFileLink(event, p) {
  const r = linkClick.shouldOpen(event, `file:${p}`, lastLinkOpened, Date.now());
  lastLinkOpened = r.last;
  if (!r.open || !window.harness || typeof window.harness.openPath !== 'function') return;
  usage('terminal:file-link');
  Promise.resolve(window.harness.openPath(p)).then((res) => {
    if (!res || res.ok !== true) flashLinkTarget(linkClick.fileRefusedText(p, res && res.why));
  }, () => flashLinkTarget(linkClick.fileRefusedText(p, null)));
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

// The terminal bar's view of the buffer (#49). The prompt part follows the viewport; a resize reflows every line
// and an erased scrollback (CSI 3 J: what /clear sends) moves them, so each starts a new epoch and the anchored
// prompt shows instead of vanishing. CSI 2 J is NOT one: it erases the screen only, and a TUI repaints with it.
term.onScroll(() => paintBar());
term.onResize(() => { bar.epoch += 1; paintBar(); });
term.parser.registerCsiHandler({ final: 'J' }, (params) => { if (params[0] === 3) { bar.epoch += 1; paintBar(); } return false; });

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

// --- the repo browser and code reader (#45 + #32) ---
// The Files tab took the Map's slot (module id `fog`, kept for saved layouts) and a file opens in a split
// beside the terminal. All of it is app/repo-*.js; this is only the wiring: the socket to send on, how to type
// into the CLI's box (typeCommand, below: never Enter), and where to put the keyboard back.
const repoBrowser = window.repoBrowser.create({
  doc: document,
  send: (obj) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  },
  harness: window.harness,
  storage: (() => { try { return localStorage; } catch { return null; } })(),
  // the reader's width is kept per tab: every tab's page shares one localStorage, so the key names this one
  storageKey: () => `repoReaderWidth:${document.getElementById('cwd').textContent || ''}`,
  typeMention: (text, done) => typeCommand(text, r => done(r.ok ? { ok: true } : { ok: false, reason: r.reason }), 'mention'),
  focusTerminal: () => term.focus(),
  isShown: () => shownModules.has('fog'),
  // edit mode (#50): the file with unsaved text goes to main, so ending this tab can warn; confirm() is the native question
  onDirty: (rel) => { try { if (window.harness && window.harness.readerDirty) window.harness.readerDirty(rel); } catch {} },
  confirmDiscard: async (message) => window.confirm(message),
  // What's this? on the reader (#33): the selected lines go to the Ask panel, which is brought on screen
  onAsk: (sel) => { askExplain(sel); },
  // an http(s) link in a rendered Markdown page (BACKLOG #119 A9): the reader already refused anything else; main's openInBrowser checks it again
  onOpenUrl: (url) => (window.harness && window.harness.openExternal ? window.harness.openExternal(url) : false),
  // the dock tree's full rectangle for the terminal (the reader takes a strip of it: app/repo-reader.js layout())
  termRect: () => { const b = lastPlan && lastPlan.boxes.find(x => x.kind === 'term'); return b ? b.rect : null; },
});
// the window-close question's Save: main asks every page to save its unsaved reader text
if (window.harness && window.harness.onReaderSave) window.harness.onReaderSave(() => { repoBrowser.reader.save(); });

// --- docs drift (backlog #39 job 2) --------------------------------------------------------------------------
// The host's list of docs the local model flagged after a merge into develop (host/drift-service.js), drawn above the git dial
// by app/docs-drift-display.js. Dismiss tells the host to hide the note; nothing here edits a document.
let docsDrift = null;
function paintDocsDrift() {
  const el = document.getElementById('drift-list');
  if (!el || !window.docsDriftDisplay) return;
  docsDriftDisplay.render(el, docsDrift, Date.now(), {
    onDismiss: (id) => { try { ws.send(JSON.stringify({ type: 'docs-drift', action: 'dismiss', id })); } catch {} },
  });
}
function applyDocsDrift(p) {
  docsDrift = p && typeof p === 'object' ? { notes: Array.isArray(p.notes) ? p.notes : [], off: p.off && typeof p.off === 'object' ? p.off : null, error: typeof p.error === 'string' ? p.error : null } : null;
  paintDocsDrift();
}
// The ages on the notes go stale between pushes.
setInterval(() => { if (docsDrift) paintDocsDrift(); }, 60 * 1000);
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
  if (shownModules.has('git') && document.visibilityState === 'visible') {
    requestGitTree();
    if (gitView === 'graph') requestGitGraph();
  }
}, GIT_TREE_EVERY_MS);
// Back from hidden: ask now, not up to 30s later with an old tree on screen (PR #85 Dexter F9).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && shownModules.has('git')) {
    requestGitTree();
    if (gitView === 'graph') requestGitGraph();
  }
});
// The Graph view next to Rings (BACKLOG #2 follow-up): the same panel, the other drawing. The choice is kept per
// project (the tree's answer names it), and only the shown view is re-asked; the commit log is a separate, cheap read.
let gitView = 'rings';
let gitViewProject = null;
let gitViewChosen = false;       // a button was pressed: the project's saved view must not overrule it when it arrives
let lastGitGraph = null;
// Nothing is sent to a host that doesn't list `git-graph` in its hello: it would TYPE the frame into the session
// (the asker keeps that rule, with tests); the panel says the session needs restarting instead.
const gitGraphAsker = window.gitGraphDisplay.createAsker(frame => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(frame); return true; } catch { return false; }
});
function requestGitGraph() {
  const r = gitGraphAsker.ask();
  if (r.note) document.getElementById('git-graph-status').textContent = r.note;
}
function renderGitGraph() {
  // only the shown view is drawn; nothing answered yet: the status line says "reading the commits…"
  if (gitView !== 'graph' || lastGitGraph === null) return;
  window.gitGraphDisplay.render(document.getElementById('git-body'), lastGitGraph, {
    tree: lastGitTree,
    tabs: lastGitTabs,
    onJump: folder => window.harness.selectFolder(folder),
    onOpenUrl: url => window.harness.openExternal(url),
    onCopy: async (text) => {
      const r = await window.harness.writeClipboard(text);
      if (!r || r.ok !== true) throw new Error((r && r.error) || 'the clipboard refused it');
    },
  });
}
function setGitView(view, { save = true, chosen = true } = {}) {
  gitView = window.gitGraphDisplay.normalizeView(view);
  if (chosen) gitViewChosen = true;
  const graph = gitView === 'graph';
  document.getElementById('git-dial').hidden = graph;
  document.getElementById('git-status').hidden = graph;
  document.getElementById('git-graph').hidden = !graph;
  const gs = document.getElementById('git-graph-status');
  gs.hidden = !graph;
  for (const b of document.querySelectorAll('#git-view button')) b.setAttribute('aria-pressed', b.dataset.view === gitView ? 'true' : 'false');
  if (save && gitViewProject !== null) window.gitGraphDisplay.writeView(storageOrNull(), gitViewProject, gitView);
  if (graph) {
    if (lastGitGraph === null) gs.textContent = 'reading the commits…';
    requestGitGraph();
    renderGitGraph();
  }
}
const storageOrNull = () => { try { return localStorage; } catch { return null; } };
document.getElementById('git-view').addEventListener('click', e => {
  const b = e.target.closest ? e.target.closest('button[data-view]') : null;
  if (b) setGitView(b.dataset.view);
});
// The first tree answer names the project: its saved view is applied once, and from then on the buttons save it.
function adoptGitViewProject(tree) {
  if (!tree || typeof tree.project !== 'string' || tree.project === gitViewProject) return;
  gitViewProject = tree.project;
  const a = window.gitGraphDisplay.adoptView({ chosen: gitViewChosen, current: gitView, saved: window.gitGraphDisplay.readView(storageOrNull(), gitViewProject) });
  setGitView(a.view, { save: a.persist, chosen: false });
}
let lastGitTree = null;
// What the shell knows of each listed worktree's tab (Enhancement #46): [{ folder, open, started, known,
// working, needsInput }], or null when it couldn't be asked -- unknown, never "idle".
let lastGitTabs = null;
function renderGitTree(tree) {
  lastGitTree = tree;
  window.gitRingsDisplay.render(document.getElementById('git-body'), tree, {
    tabs: lastGitTabs,
    onJump: folder => window.harness.selectFolder(folder),
    // a PR's page opens in the default browser through main's one gate for links (http/https only)
    onOpenPr: url => window.harness.openExternal(url),
    onCopy: async (name) => {
      const r = await window.harness.writeClipboard(name);
      if (!r || r.ok !== true) throw new Error((r && r.error) || 'the clipboard refused it');
    },
    onTypeMerged: async (folder, branch) => {
      const r = await window.harness.typeMerged(folder, branch);
      requestGitTabs();     // the session is busy now: the drawer should say so
      return r;
    },
  });
  adoptGitViewProject(tree);
  renderGitGraph();        // the graph's strip reads the tree's address and worktrees
}
// The tabs' states move faster than the tree does (a session starts and stops working), so they're asked
// for on their own, every couple of seconds while the panel is showing, and with every tree.
const GIT_TABS_EVERY_MS = 2000;
let gitTabsAsking = false;
async function requestGitTabs() {
  if (gitTabsAsking || !window.harness || !window.harness.tabStates) return;
  const tree = lastGitTree;
  if (!tree || !tree.ok) return;
  gitTabsAsking = true;
  try {
    lastGitTabs = await window.harness.tabStates(tree.branches.filter(b => typeof b.folder === 'string' && b.folder).map(b => b.folder));
  } catch {
    lastGitTabs = null;
  } finally {
    gitTabsAsking = false;
  }
  if (lastGitTree === tree) renderGitTree(tree);
}
setInterval(() => {
  if (shownModules.has('git') && document.visibilityState === 'visible') requestGitTabs();
}, GIT_TABS_EVERY_MS);

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
  usage('projects:switch');
  try { ws.send(JSON.stringify({ type: 'open', path: row.dataset.open })); } catch {}
  // Said out loud: the new window is a separate process that takes a moment to
  // appear, and a click with no feedback reads as a dead button.
  document.getElementById('projects-note').textContent = 'opening a window…';
  document.getElementById('projects-note').style.display = '';
});

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
/// --- the dock tree (BACKLOG #53, dockable panels D1; was L1's four zones, #22) ----
// Every side panel is a module in a tabbed group of a split tree around the
// terminal (app/dock-tree.js has every rule; app/dock-tree-display.js draws; and
// app/dock-effects.js decides a redraw's effects). L1's four zones are gone; app/dock-migrate.js
// reads the shapes they saved, for fromV1 and the pre-L1 migration.
// Two kinds of state, kept apart on purpose:
//   - PLACEMENT (the tree, hidden modules, sizes): the global layout in main
//     (install-wide, store key `layout-tree`), or this tab's own, kept by its host.
//   - SELECTION (which module each group shows, Ctrl+B's fold): this window's
//     own, saved in localStorage (`dockSelection2`). Clicking Vault here must not
//     switch every other project window to Vault (S3a; PR #82 Dexter F4).
const MODULE_IDS = TABS.map(t => t.id);
const DM = window.dockMigrate;
const DTm = window.dockTree;
let globalLayout = DTm.startLayout(MODULE_IDS);
let ownLayout = null;            // this tab's own placement (host), or null
let pendingOverride = null;      // { layout } sent to the host, not yet echoed back
let dragLayout = null;           // a divider being dragged: drawn, not yet saved
let flushKeyBurst = null;        // saves a divider's pending arrow-key burst (set where the keys are handled)
let selection = DTm.cleanSelection(null);
let lastPlan = null;             // the plan on screen: the tab drag and the dividers read its boxes and splits
let peek = null;                 // { module }: a rail's panel open over the terminal (D4). This window's, never saved. Set only by railEvent
let railSt = window.dockTreeView.RAIL_IDLE;   // the rail's hover state, BACKLOG #85: peek is what it says is open
const RAIL_OPEN_MS = 100;
const RAIL_CLOSE_MS = 100;
let railOpenTimer = null;
let railCloseTimer = null;
let helloSeen = false;           // the host has said whether this tab has its own layout, in the hello; a collapse is forgotten only after that
let layoutLoaded = false;        // the stored layout has been read: until then the default is only a placeholder, whose groups mean nothing to a saved collapse
let kbMove = null;               // { id, target }: a panel being moved with the keyboard (D4)
let kbRefresh = () => {};        // redraws the keyboard move's zones after the dock was redrawn (set by initKeyboardMove)
let shownModules = new Set();
// Usage counters: a panel counts as shown only after the layout loaded and within a moment of a user gesture (a tab, the rail, the
// Window menu), so a launch, a layout load or leaving lean mode doesn't rank the default panels as most used.
let usageGestureAt = -Infinity;
const usageGesture = () => { usageGestureAt = Date.now(); };
const usageGestureLive = () => layoutLoaded && helloSeen && Date.now() - usageGestureAt < 1500;
let hostControls = null;         // the control types the attached host's hello lists; null until it has said (an old host lists no 'lean')
let leanNight = false;           // a /bedtime night is going in any tab, main's word with the lean state: an animated background never plays then
let windowFocused = null;        // main's word on whether this window has the keyboard focus; null until it has said (unknown holds still)
let leanOn = false;              // lean mode, BACKLOG #62: the whole window is terminal-only; main's word, see the lean block below
let layoutPushes = 0;            // layouts pushed to this window by main: the probe counts the store writes with it

// This window's selection. A window that has none yet is seeded ONCE from L1's
// (`dockSelection`: group ids are the zone names, so it maps straight across).
function readSelection() {
  try {
    const raw = localStorage.getItem('dockSelection2');
    if (raw !== null) return DTm.cleanSelection(JSON.parse(raw));
    return DTm.selectionFromV1(JSON.parse(localStorage.getItem('dockSelection') || 'null'));
  } catch { return DTm.cleanSelection(null); }
}
function saveSelection() {
  try { localStorage.setItem('dockSelection2', JSON.stringify(selection)); } catch {}
}

// What is SAVED for this window, without a divider drag's drawn-only layout on top.
function committedLayout() { return ownLayout || globalLayout; }
function placementLayout() { return dragLayout || committedLayout(); }
// The layout an operation (dock, hide, show) is built on: a pending arrow-key burst is saved first, so the operation starts from the
// placement as it is now -- not from the burst's drawn copy, which would put back a change another window pushed meanwhile (PR #159 Dexter 6).
function settledLayout() { if (flushKeyBurst) flushKeyBurst(); return placementLayout(); }

// The area the tree fills: #dock, which already gives the diagnostics pane its own room.
function dockViewport() {
  const dock = document.getElementById('dock');
  return { width: dock.clientWidth, height: dock.clientHeight };
}

// --- the Games panel (BACKLOG #41) -----------------------------------------------------------------------------------------
// GAMES-BEGIN
// app/games-display.js builds the panel and runs the rounds; the rules are in app/games-rules.js and app/games-round.js, the bests are
// kept by main (host/game-scores.js). What is here is the three facts only this page knows: whether the panel is on screen, whether
// the terminal holds the keyboard, and when Claude needs Ricardo (the attention message below calls gamesHandBack).
const gamesRoot = document.getElementById('games-root');
const gamesPanel = gamesRoot ? window.gamesDisplay.mount({
  doc: document,
  root: gamesRoot,
  bridge: window.harness && window.harness.games ? window.harness.games : null,
  focusTerminal: () => term.focus(),
  terminalHasFocus: () => !!(term.element && term.element.contains(document.activeElement)),
  onStart: (game) => usage('game:' + game + ':start'),
  raf: (fn) => requestAnimationFrame(fn),
  caf: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  css: (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
}) : null;
// Lean mode unmounts every dock panel, so it reaches the games as "not shown": no separate lean flag is needed.
function gamesView() {
  if (gamesPanel) gamesPanel.setView({ shown: shownModules.has('games'), pageVisible: document.visibilityState === 'visible' });
}
// Claude needs Ricardo (a permission prompt, a question) or its turn finished: a running round freezes and the keyboard goes
// back to the terminal.
function gamesHandBack() { if (gamesPanel) gamesPanel.handBack(); }
let gamesHides = 0;                 // probe: how many times this page was told it is hidden
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') gamesHides += 1; gamesView(); });
// The page is going away mid-round: bank the score it has (best effort; the raise is the same safe write as at a round's end).
window.addEventListener('pagehide', () => { if (gamesPanel) gamesPanel.bankNow(); });
// GAMES-END

// --- the Schedules panel (BACKLOG #119 A7) ------------------------------------------------------------------------------------
// SCHEDULES-BEGIN
// app/schedules-display.js decides what is drawn; the list is the host's (host/schedules.js buildView): every session's wakeups, loops,
// bedtime nights and cron jobs, grouped. READ-ONLY in v1: a click on a row selects that session's tab (the Git panel's own jump).
// var, not let: the first layout can paint the rail badge before this block has run (the Resources panel's resViewingSent is the same).
var schedState = window.schedulesDisplay.emptyState();
var schedRoot = document.getElementById('schedules-root');
var schedLastHtml = null;

// The count of wakeups due in the next hour, on every rail button and tab of the panel (the rail rebuilds its buttons, so this runs after each layout).
function paintSchedulesBadge() {
  const n = window.schedulesDisplay.badge(schedState);
  const text = window.schedulesDisplay.badgeText(n);
  const base = TABS.find(t => t.id === 'schedules');
  for (const b of document.querySelectorAll('button[data-module="schedules"]')) {
    if (text) b.dataset.badge = text; else delete b.dataset.badge;
    if (base) b.title = text ? base.title + ' (' + n + ' due in the next hour)' : base.title;
  }
}

function renderSchedules() {
  paintSchedulesBadge();
  if (!schedRoot || !shownModules.has('schedules')) return;
  const html = window.schedulesDisplay.html(schedState);
  if (html === schedLastHtml && schedRoot.firstChild) return;      // nothing changed: no flicker, no lost hover or focus
  // The markup is replaced on a change: keep the keyboard on the same row.
  const focused = document.activeElement && schedRoot.contains(document.activeElement) ? document.activeElement : null;
  const keep = focused && focused.dataset ? focused.dataset.schedKey : null;
  schedRoot.innerHTML = html;
  schedLastHtml = html;
  if (!keep) return;
  const again = [...schedRoot.querySelectorAll('[data-sched-key]')].find(el => el.dataset.schedKey === keep);
  if (again && !again.disabled) again.focus();
}

// The panel opened: ask for the list as it is now (the hello and every change also carry it).
// ONLY to a host whose hello lists the type: an older host (they outlive app updates) would type the frame into the session as JSON
// (the PR #140 rule; PR #200 Dexter 1). The panel says "predates Schedules" for such a host instead.
function requestSchedules() {
  const msg = window.schedulesDisplay.requestMsg(hostControls);
  if (!msg || !ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* not attached */ }
}

if (schedRoot) {
  schedRoot.addEventListener('click', (e) => {
    const t = window.schedulesDisplay.clickTarget(e.target);
    if (!t) return;
    e.preventDefault();
    if (t.kind === 'select') { jumpToFolder(t.folder); return; }
    if (t.kind === 'link') {
      if (window.harness && typeof window.harness.openExternal === 'function') window.harness.openExternal(t.url);
    }
  });
}
// SCHEDULES-END

// --- the Ask panel (BACKLOG #33) ------------------------------------------------------------------------------------------
// ASK-BEGIN
// app/ask-display.js builds the panel; its questions go to THIS tab's host over the socket (app/ask-requester.js, the `ask` control), and
// the host owns the index and the models. What is here is what only this page knows: the socket, the reader (a card or a citation opens a
// file at a line; What's this? on the reader sends its selection here) and whether the panel is on screen.
const askRoot = document.getElementById('ask-root');
const askRequester = window.askRequester.createRequester({
  send: (obj) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  },
});
// The explainer's picture goes through the AGENTS' picker: the OS file dialog (avatar:pick), then the same `portrait set` the roster's pencil
// sends, under the agent name the host keeps for it (host/ask-service.js EXPLAINER_AGENT). True when a file was chosen and sent.
// the ONE id the explainer's medals, counts and picture are kept under (app/ask-explainer-display.js; host/ask-service.js reads it from there too)
const ASK_AGENT = window.askExplainerDisplay.AGENT;
// The host's last `explainer` frame, cleaned (app/ask-explainer-display.js frameOf); null until the host has said (or from an older host).
// Declared here, before the panel is mounted: mounting paints once, and the paint asks for it.
let explainerFrame = null;
// ONE way to choose a picture for an agent: the OS file dialog (avatar:pick), then the `portrait set` the host copies it in with. The roster's
// pencil and the Ask panel's picker both go through it. True when a file was chosen and sent.
function pickAndSetPortrait(agent, state) {
  if (!(window.harness && window.harness.avatar)) return Promise.resolve(false);
  return window.harness.avatar.pick().then((path) => {
    if (!path) return false;
    try { ws.send(JSON.stringify({ type: 'portrait', action: 'set', agent, state, path })); return true; } catch { return false; /* not attached */ }
  });
}
function askPickPortrait() { return pickAndSetPortrait(ASK_AGENT, 'sleeping'); }

const askPanel = askRoot ? window.askDisplay.mount({
  doc: document,
  root: askRoot,
  storage: (() => { try { return localStorage; } catch { return null; } })(),
  request: (op, body) => askRequester.request(op, body),
  // resolves to what the reader said (false: it did not open), so a place that wasn't opened isn't counted; the reader says why in its own note
  openAt: (file, line, endLine) => repoBrowser.openAt(file, line, endLine).catch(() => false).then((r) => { if (r !== false) usage('ask:place-opened'); return r; }),
  getSelection: () => window.getSelection(),
  pickPortrait: askPickPortrait,
  // the roster's own switch (declared further down this file: before it is set, or if it is off, the face is a placeholder)
  imagesEnabled: () => { try { return agentImagesEnabled === true; } catch { return false; } },
  // The explainer is a roster member (BACKLOG #33 gamification): its header wears the card's ring and badge, a 🏅 gives it a medal from
  // here, and opening a place it found is counted by the host.
  gamify: () => (explainerFrame ? { state: explainerFrame.state, detail: explainerFrame.detail } : null),
  onMedal: (btn) => { const r = btn.getBoundingClientRect(); openMedalMenu(ASK_AGENT, r.left, r.bottom + 2); },
  onOpenPlace: () => askRequester.notify('opened'),
  onChange: () => explainerProfileChanged(),
}) : null;
let askWasShown = false;
let askWasDocked = null;
// Which windows have an Ask panel DOCKED anywhere in their layout (even behind another tab or on the rail; not hidden) decides whether the
// explainer is on the roster's Active tab (host/ask-explainer.js; Ricardo's pick). Per socket on the host, so a reattach (hello) says it again.
// Through the requester's gate: a host whose hello doesn't list `ask` would have the frame typed into the session (PR #178 Miguel B1).
function sendAskPanel(open) { return askRequester.notify('panel', { open }); }
// null while the layout isn't known: unknown is not "hidden"
function askDockedNow() { try { return window.askExplainerDisplay.docked(placementLayout()); } catch { return null; } }
function askView() {
  if (!askPanel) return;
  // on screen: the index status is read and polled only then
  const now = shownModules.has('ask');
  if (now !== askWasShown) {
    askWasShown = now;
    if (now) askPanel.show(); else askPanel.hide();
  }
  // docked anywhere: only a CHANGE is told to the host
  const docked = askDockedNow();
  if (docked !== null && docked !== askWasDocked) { askWasDocked = docked; sendAskPanel(docked); }
}
// What's this? on the reader: bring the panel on screen (un-hide it if the person hid it), then ask.
function askExplain(sel) {
  if (!askPanel) return;
  revealModule('ask');              // #168: a hidden panel comes back on the rail, a railed one opens held, a pinned one is selected
  askPanel.explainSelection(sel);
}
// ASK-END

function onModuleShown(id) {
  if (id === 'fog') repoBrowser.show();
  if (id === 'git') { usage('git:opened'); requestGitTree(); if (gitView === 'graph') requestGitGraph(); }
  if (id === 'projects') requestProjects();
  if (id === 'wand') requestWandSkills();
  if (id === 'resources') renderResources();
  if (id === 'schedules') { requestSchedules(); renderSchedules(); }
  if (id === 'canvas') { canvasFetchIfNeeded(); renderCanvas(); }
  // Dexter/Miguel, PR #60, F2/I1: EVERY open asks, not just the first one --
  // the host answers cheaply from a fresh cache, and decides freshness itself.
  if (id === 'models') requestModels(false);
  if (id === 'vault') { usage('vault:opened'); renderVault(); }
}

// --- the Resources panel and the top-bar chip (BACKLOG #63) ----------------------------------------------------
// RESOURCES-BEGIN
// app/resources-display.js decides what is drawn. The figures come from main's sampler (app/resources-service.js),
// which also decides WHEN it samples: always, every 10 s, panel open or not (Ricardo, PR #113), except while the window is
// minimised. Nothing here reads the OS.
const resBridge = window.harness && window.harness.resources;
let resState = window.resourcesDisplay.emptyState();
let resPayload = null;              // the last payload main pushed: the chip draws from it, the panel from resState
// The chip's on/off is read from main's saved setting synchronously, BEFORE the first paint, so "off" never flashes the chip.
let resChipOn = !(resBridge && typeof resBridge.chipOn === 'function' && resBridge.chipOn() === false);
const resRoot = document.getElementById('resources-root');
const tbResourcesEl = document.getElementById('tb-resources');
const resPopoverEl = document.getElementById('res-popover');
// The chip's one-hour graph window: its open/hover state is app/resources-history-display.js's popoverStep (pure, unit-tested);
// everything below only turns DOM events into steps and draws the result.
let resPop = window.resourcesHistoryDisplay.popoverInit();

// Q2: one more check in the Window menu, beside the panels'. Install-wide, on by default; main saves it and tells every page.
function resourceChipRow() {
  const box = node('input', { type: 'checkbox', checked: resChipOn });
  box.addEventListener('change', () => { if (resBridge) resBridge.setChip(box.checked); });
  return node('label', { title: 'The machine CPU and memory chip in the top bar' }, [box, node('span', { text: 'Show CPU and memory in the top bar' })]);
}

function renderResourcesChip() {
  if (!tbResourcesEl) return;
  const c = window.resourcesDisplay.chipView(resPayload);
  // each figure (CPU, memory, and the GPU's when the payload has one) with its one-hour sparkline after it; the whole chip reads as the plain text to a screen reader
  tbResourcesEl.innerHTML = window.resourcesHistoryDisplay.chipHtml(c.cpuText, c.memText, resHistory(), resHistoryNow(), c.gpuText);
  tbResourcesEl.setAttribute('aria-label', c.text);
  tbResourcesEl.title = c.title;
  tbResourcesEl.classList.toggle('res-amber', c.level === 'amber');
  tbResourcesEl.classList.toggle('res-red', c.level === 'red');
  tbResourcesEl.classList.toggle('res-dim', c.dim === true);
  // Q2: the Window menu's "Show CPU and memory in the top bar"; on until a payload says it is off
  tbResourcesEl.hidden = !resChipOn;
  if (!resChipOn) resPopStep({ type: 'chip-off' });
  else renderHistory();
}

// ---- the chip's popover: the larger graphs of the last hour ----
const resHistory = () => (resPayload && Array.isArray(resPayload.history) ? resPayload.history : []);
// the points' own (monotonic) clock: main sends its "now" with them. Without one (no history yet) nothing is drawn anyway.
const resHistoryNow = () => (resPayload && Number.isFinite(resPayload.historyNow) ? resPayload.historyNow : 0);

function renderHistory() {
  if (!resPop.open || !resPopoverEl) return;
  resPopoverEl.innerHTML = window.resourcesHistoryDisplay.popover(resHistory(), resHistoryNow(), resPop.hover);
  placeHistory();   // the chip can have changed width since it opened
}
function placeHistory() {
  // under the chip, right edges aligned, and never off the left edge of the window
  const r = tbResourcesEl.getBoundingClientRect();
  const w = resPopoverEl.offsetWidth || 336;
  resPopoverEl.style.top = `${Math.round(r.bottom + 6)}px`;
  resPopoverEl.style.left = `${Math.max(8, Math.round(Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
}
// The cursor and the readout follow the pointer in place (a re-draw under the pointer would drop the hover).
function syncHover() {
  const view = window.resourcesHistoryDisplay.hoverView(resHistory(), resHistoryNow(), resPop.hover);
  for (const g of resPopoverEl.querySelectorAll('.hg[data-hist-graph]')) {
    const v = view[g.dataset.histGraph];
    const plot = g.querySelector('.hg-plot');
    const readout = g.querySelector('.hg-readout');
    if (!v || !plot || !readout) continue;
    let cursor = plot.querySelector('.hg-cursor');
    if (v.cursor === null) { if (cursor) cursor.remove(); } else {
      if (!cursor) { cursor = document.createElement('div'); cursor.className = 'hg-cursor'; plot.appendChild(cursor); }
      cursor.style.left = `${v.cursor}%`;
    }
    readout.textContent = v.readout;
  }
}
// One door for every event: step the state, then make the page match it. Returns whether the event was consumed.
function resPopStep(ev) {
  const was = resPop;
  const out = window.resourcesHistoryDisplay.popoverStep(was, ev);
  resPop = out.state;
  if (resPop.open !== was.open) {
    if (resPop.open) { renderHistory(); resPopoverEl.hidden = false; placeHistory(); } else resPopoverEl.hidden = true;
    tbResourcesEl.setAttribute('aria-expanded', resPop.open ? 'true' : 'false');
  } else if (resPop.hover !== was.hover) syncHover();
  return out.consumed;
}
function plotUnder(e) {
  const plot = e.target && e.target.closest ? e.target.closest('.hg-plot') : null;
  return plot && plot.parentElement && plot.parentElement.dataset ? plot : null;
}

function renderResources() {
  if (!resRoot || !shownModules.has('resources')) return;
  // The markup is replaced on every draw: keep the keyboard on the same row or button.
  const focused = document.activeElement && resRoot.contains(document.activeElement) ? document.activeElement : null;
  const keep = focused && focused.dataset ? { act: focused.dataset.resAct, key: focused.dataset.resKey, pid: focused.dataset.resPid } : null;
  // the GPU section's last-hour graphs come from the history display (it loads after resources-display.js, so it is handed in)
  resRoot.innerHTML = window.resourcesDisplay.html(window.resourcesDisplay.view(resState), { gpuGraphs: window.resourcesHistoryDisplay.gpuGraphs(resHistory(), resHistoryNow()) });
  if (!keep) return;
  const again = [...resRoot.querySelectorAll('[data-res-act]')].find(el => el.dataset.resAct === keep.act
    && el.dataset.resKey === keep.key && el.dataset.resPid === keep.pid);
  if (again) again.focus();
}

// Whether this page is SHOWING the Resources panel (on screen, docked, peeked or popped, and the page visible), told to main only
// when it changes: the shared poller samples every 10 s while any page does and every 30 s while only the chip is in view
// (BACKLOG #100 c). Reads window.harness itself, so a placement that runs before this block's constants exist is safe.
var resViewingSent = null;   // var: placement can report before this line has run
function reportResourcesViewing() {
  const on = shownModules.has('resources') && document.visibilityState === 'visible';
  if (on === resViewingSent) return;
  resViewingSent = on;
  const bridge = window.harness && window.harness.resources;
  if (bridge && typeof bridge.viewing === 'function') bridge.viewing(on);
}
document.addEventListener('visibilitychange', reportResourcesViewing);

function onResourcesState(payload) {
  resPayload = payload;
  resChipOn = window.resourcesDisplay.nextChipOn(resChipOn, payload);
  resState = window.resourcesDisplay.withPayload(resState, payload);
  renderResourcesChip();
  renderResources();
}
renderResourcesChip();
if (resBridge) {
  resBridge.onState(onResourcesState);
  // A page that opens between two pushes asks for the last one instead of waiting up to 10 s.
  resBridge.get().then((p) => { if (p && !resPayload) onResourcesState(p); }, () => {});
}

async function resourcesAct(a) {
  const D = window.resourcesDisplay;
  if (a.act === 'toggle') resState = D.toggle(resState, a.key);
  else if (a.act === 'ask-stop') resState = D.askStop(resState, a);
  else if (a.act === 'cancel-stop') resState = D.cancelStop(resState);
  else if (a.act === 'left-stop' || a.act === 'left-stop-group' || a.act === 'left-delete') {
    // The Leftovers Stop: main resolves the rows against its own latest sample, so the page only says which. One at a time.
    if (!resBridge || resState.leftBusy) return;
    resState = D.beginLeftStop(resState);
    renderResources();
    let result;
    try { result = await resBridge.stopLeftovers(a.act === 'left-stop' ? { rows: [{ pid: a.pid, start: a.start }] } : a.act === 'left-delete' ? { taskLog: a.key } : { group: a.group }); } catch { result = null; }
    resState = D.leftStopResult(resState, result);
  }
  else if (a.act === 'confirm-stop') {
    const req = resState.confirm;
    // one Stop, one answer: a second press while it is in flight does nothing
    if (!req || !resBridge || resState.pending) return;
    resState = D.beginStop(resState);
    renderResources();
    let result;
    try { result = await resBridge.stop({ pid: req.pid, startTime: req.start }); } catch { result = null; }
    resState = D.stopResult(resState, req, result || { ok: false, reason: 'unreadable', text: 'the request did not get through' });
  }
  renderResources();
}
if (resRoot) {
  resRoot.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-res-act]') : null;
    const a = el ? window.resourcesDisplay.actionOf(el.dataset) : null;
    if (a) resourcesAct(a);
  });
  // A row is a role=button div: Enter and Space work it like a button.
  resRoot.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target || e.target.tagName === 'BUTTON') return;
    const a = window.resourcesDisplay.actionOf(e.target.dataset);
    if (!a) return;
    e.preventDefault();
    resourcesAct(a);
  });
}
// The chip opens the one-hour popover (Ricardo picked option B: this replaces "the chip opens the Resources panel", which
// stays one click away in the Window menu / side tabs). A second click, Esc, an outside click, the window losing focus and the
// page hiding close it. The chip is a button, so Enter and Space toggle it natively.
if (tbResourcesEl && resPopoverEl) {
  tbResourcesEl.addEventListener('click', () => { resPopStep({ type: 'chip-click' }); });
  resPopoverEl.addEventListener('mousemove', (e) => {
    const plot = plotUnder(e);
    if (!plot) { resPopStep({ type: 'leave' }); return; }
    const box = plot.getBoundingClientRect();
    const minutes = window.resourcesHistoryDisplay.minutesAgo(box.width > 0 ? (e.clientX - box.left) / box.width : NaN);
    if (minutes !== null) resPopStep({ type: 'hover', kind: plot.parentElement.dataset.histGraph, minutes });
  });
  // "Open Resources panel": close the popover, then show the panel if hidden (as the Window menu does), select it and focus it.
  resPopoverEl.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-hist-act="open-panel"]') : null;
    if (!btn) return;
    resPopStep({ type: 'panel-link' });
    revealModule('resources');
    setTimeout(() => { if (resRoot) resRoot.focus(); }, 0);
  });
  resPopoverEl.addEventListener('mouseleave', () => { resPopStep({ type: 'leave' }); });
  document.addEventListener('keydown', (e) => {
    if (resPopStep({ type: 'key', key: e.key })) { e.preventDefault(); e.stopPropagation(); tbResourcesEl.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    resPopStep({ type: 'pointerdown', inside: resPopoverEl.contains(e.target) || tbResourcesEl.contains(e.target) });
  });
  window.addEventListener('blur', () => { resPopStep({ type: 'blur' }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) resPopStep({ type: 'hidden' }); });
  window.addEventListener('resize', () => { if (resPop.open) placeHistory(); });
}
// RESOURCES-END

// CANVAS-BEGIN
// Claude's panel (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md). app/canvas-display.js decides everything (what the frame
// draws, what a frame from the host means, what a click is); this is the DOM, the socket and the native view. The page
// Claude wrote is NOT part of this document: it is a sealed WebContentsView that main lays over `#canvas-slot` at the
// rectangle measured here (app/canvas-views.js), so this page is its trusted controller, never its host. Hidden means
// stopped: the view exists only while the module shows, this page is visible and there is a page to show.
const canvasBridge = window.harness && window.harness.canvas;
let canvasState = window.canvasDisplay.emptyState();
const canvasRoot = document.getElementById('canvas-root');
let canvasLive = false;           // main has a native view for this tab
let canvasShownSig = null;        // the page signature main was last given
let canvasShownHosts = '';        // the host lists main was last given, as JSON
let canvasShownShelf = '';        // the artifact shelf main was last given, as JSON
let canvasTyping = false;         // a button's message is being typed: one at a time, as the wand does
let canvasStatusTimer = null;
let canvasLastCover = null;
let canvasLastRect = null;
let canvasRectKey = '';
let canvasFetchSig = null;        // the signature a canvas-get is already out for

function canvasSlotRect() {
  const el = canvasRoot && canvasRoot.querySelector('#canvas-slot');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

// Is the slot itself topmost at this point? (null: outside the page, nothing of ours is over it). A native view ignores the DOM's stacking, so
// whatever else is drawn over the slot (a floating dock panel, a menu, a popover) must hide it (PR #122 Dexter F5).
function canvasIsSlotAt(x, y) {
  const slot = canvasRoot && canvasRoot.querySelector('#canvas-slot');
  const el = document.elementFromPoint(x, y);
  return !el || !slot || el === slot || slot.contains(el);
}

function syncCanvasView() {
  if (!canvasBridge) return;
  const want = shownModules.has('canvas') && document.visibilityState === 'visible' && window.canvasDisplay.canShow(canvasState);
  if (!want) {
    if (canvasLive) { canvasBridge.hide(); canvasLive = false; canvasShownSig = null; canvasRectKey = ''; const had = canvasState.asks.length > 0; canvasState = window.canvasDisplay.withoutAsks(canvasState); if (had) renderCanvas(); }
    return;
  }
  const req = window.canvasDisplay.showRequest(canvasState);
  const rect = canvasSlotRect();
  const covered = window.canvasDisplay.covered(canvasState) || (rect !== null && window.canvasDisplay.slotObstructed(rect, canvasIsSlotAt));
  if (rect) canvasLastRect = rect;
  const hostsKey = JSON.stringify(req.hosts);
  if (!canvasLive || canvasShownSig !== canvasState.htmlSig) {
    canvasLive = true; canvasShownSig = canvasState.htmlSig; canvasShownHosts = hostsKey; canvasLastCover = covered;
    canvasShownShelf = window.canvasDisplay.shelfKey(canvasState);
    canvasRectKey = JSON.stringify(canvasLastRect);
    const sig = canvasState.htmlSig;
    canvasBridge.show({ html: req.html, hosts: req.hosts, shelf: req.shelf, rect: canvasLastRect, covered }).then((res) => {
      // main said no (too big once decoded, no tab...): say so in the module instead of drawing an empty slot for a view that does not exist.
      // A `stale` answer means a hide or a newer show overtook this one; that is not an error.
      if (res && res.ok === false && res.stale !== true) {
        if (canvasShownSig === sig) { canvasLive = false; canvasShownSig = null; canvasRectKey = ''; }
        canvasState = window.canvasDisplay.withRefusal(canvasState, sig, res.error);
        renderCanvas();
      }
    }, () => {});
    return;
  }
  if (hostsKey !== canvasShownHosts) { canvasShownHosts = hostsKey; canvasBridge.hosts(req.hosts); }
  const shelfKey = window.canvasDisplay.shelfKey(canvasState);
  if (shelfKey !== canvasShownShelf) { canvasShownShelf = shelfKey; canvasBridge.shelf(req.shelf); }
  if (covered !== canvasLastCover) { canvasLastCover = covered; canvasBridge.cover(covered); }
  const key = JSON.stringify(canvasLastRect);
  if (canvasLastRect && key !== canvasRectKey) { canvasRectKey = key; canvasBridge.bounds(canvasLastRect); }
}

function renderCanvas() {
  if (!canvasRoot) return;
  if (shownModules.has('canvas')) canvasRoot.innerHTML = window.canvasDisplay.html(window.canvasDisplay.view(canvasState));
  syncCanvasView();
}

// The page comes from the host only when asked for, once per signature (the answer is a `canvas` frame with html).
function canvasFetchIfNeeded() {
  if (!window.canvasDisplay.needsFetch(canvasState) || !shownModules.has('canvas')) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const sig = canvasState.payload.signature;
  if (canvasFetchSig === sig) return;
  canvasFetchSig = sig;
  ws.send(JSON.stringify({ type: 'canvas-get' }));
  setTimeout(() => { if (canvasFetchSig === sig) canvasFetchSig = null; }, 3000);
}

// Claude was asked to build something: show the panel if it is hidden (as the Window menu does) and select it.
function canvasDock() {
  revealModule('canvas');
}

function canvasOnFrame(frame) {
  const next = window.canvasDisplay.withFrame(canvasState, frame);
  if (next === canvasState) return;
  canvasState = next;
  // Nothing to fetch (the page arrived, or there is none): the 'already asked' memo goes, so the SAME page written again later
  // (a clock, then a too-big page, then the clock) is asked for again.
  if (!window.canvasDisplay.needsFetch(canvasState)) canvasFetchSig = null;
  if (window.canvasDisplay.shouldDock(frame)) canvasDock();
  canvasFetchIfNeeded();
  renderCanvas();
}

function canvasHostsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function canvasAct(a) {
  if (a.act === 'allow' || a.act === 'deny') {
    const ask = canvasState.asks.find(x => x.id === a.id);
    if (!ask) return;
    canvasBridge.answerHost(a.id, a.act);
    canvasHostsSend({ type: 'canvas-hosts', action: a.act, origin: ask.origin });
    canvasState = window.canvasDisplay.answered(canvasState, a.id);
  } else if (a.act === 'remove') {
    canvasHostsSend({ type: 'canvas-hosts', action: 'remove', origin: a.origin });
  } else if (a.act === 'hosts') {
    canvasState = window.canvasDisplay.toggleHosts(canvasState);
  } else if (a.act === 'close-hosts') {
    canvasState = window.canvasDisplay.toggleHosts(canvasState, false);
  }
  renderCanvas();
}

// A button in Claude's panel (main already checked a real click came with it): its one line is typed into the prompt through the
// wand's path, so the submit gate decides Enter and the transcript shows where it came from. The status line says what came of it.
// The panel's status line: shown, and cleared again after a while.
function showCanvasStatus(next, ms = 8000) {
  canvasState = next;
  renderCanvas();
  clearTimeout(canvasStatusTimer);
  canvasStatusTimer = setTimeout(() => { canvasState = window.canvasDisplay.clearStatus(canvasState); renderCanvas(); }, ms);
}

function canvasSendToSession(text) {
  const line = window.canvasDisplay.sessionLine(text);
  if (!line) { showCanvasStatus(window.canvasDisplay.unsent(canvasState, window.canvasDisplay.whyNot(text) || 'the message could not be typed')); return; }
  if (canvasTyping) { showCanvasStatus(window.canvasDisplay.unsent(canvasState, 'the previous message is still being typed')); return; }
  canvasTyping = true;
  typeCommand(line, (r) => {
    canvasTyping = false;
    canvasState = window.canvasDisplay.typed(canvasState, r);
    renderCanvas();
    clearTimeout(canvasStatusTimer);
    if (r && r.ok) canvasStatusTimer = setTimeout(() => { canvasState = window.canvasDisplay.clearStatus(canvasState); renderCanvas(); }, r.box ? 8000 : 2500);
  }, 'panel', { submit: true });
}

if (canvasBridge && canvasRoot) {
  canvasBridge.onMessage((msg) => { if (msg && msg.kind === 'send') canvasSendToSession(msg.text); });
  // The page asked for a host it has not been given: the question covers the panel until it is answered.
  canvasBridge.onNeedHost((ask) => { canvasState = window.canvasDisplay.withAsk(canvasState, ask); renderCanvas(); });
  canvasRoot.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-canvas-act]') : null;
    const a = el ? window.canvasDisplay.actionOf(el.dataset) : null;
    if (a) canvasAct(a);
  });
  let canvasFrame = 0;
  const canvasSchedule = () => {
    if (canvasFrame) return;
    canvasFrame = requestAnimationFrame(() => { canvasFrame = 0; syncCanvasView(); });
  };
  new ResizeObserver(canvasSchedule).observe(canvasRoot);
  document.addEventListener('visibilitychange', syncCanvasView);
  // Something else may now be over the slot (a float dragged across it, a menu or popover opened): look again right after any interaction
  // (once its own handlers have run), while a button is held (a drag), and on a slow tick as the safety net for anything that moves by itself.
  for (const ev of ['pointerup', 'click', 'keyup', 'contextmenu', 'wheel', 'resize']) window.addEventListener(ev, () => setTimeout(canvasSchedule, 0), true);
  window.addEventListener('pointermove', (e) => { if (e.buttons) canvasSchedule(); }, true);
  setInterval(() => { if (canvasLive) canvasSchedule(); }, 250);
}
// CANVAS-END

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
// drawing is decided by dockEffects.renderEffects, which is tested: above all,
// a redraw never moves keyboard focus unless the vault opened or closed, or
// the user acted (PR #82 Dexter F2, Miguel B1).
// `refit: false` is for a redraw that cannot change the terminal's rectangle (a float's move or resize): the
// pty is not told again and no timer is queued for it (PR #102 Miguel Y2).
// `settle: true` is for a change the person made (a drop, a collapse): the boxes glide to their new places
// (app/dock-tree-display.js settleMs: about 120 ms, none under prefers-reduced-motion). A drag never settles.
function renderLayout({ userAction = false, refit = true, settle = false, quiet = false } = {}) {
  // A collapsed group that is gone is forgotten here, so a group later handed its name doesn't start collapsed -- but only
  // once the stored layout is in: the placeholder default drawn at launch has none of the groups a saved collapse names.
  if (window.dockEffects.pruneReady(layoutLoaded, helloSeen)) {
    const pruned = DTm.pruneCollapsed(selection, placementLayout());
    if (pruned !== selection) { selection = pruned; saveSelection(); }
  }
  const plan = window.dockTreeView.treePlan(placementLayout(), selection, TABS, dockViewport(), { faceSize: window.faceSize, peek });
  lastPlan = plan;
  if (peek && !plan.peek) railEvent({ type: 'gone' });     // its rail went (the window grew, the group was opened): so does the popover
  if (settle) settleDock();
  window.dockTreeView.applyBoxes(plan, document, leanDisplay.LEAN_KEEPS);
  repoBrowser.layout();             // the reader's strip of the terminal's rectangle, re-taken after every placement
  // Lean mode unmounts every dock panel except the ones leanDisplay.LEAN_KEEPS names (Schedules: its content is the night itself), so each panel's own hide effects run (the vault's secrets go,
  // the canvas view detaches, the pollers gated on shownModules stop) and coming back shows them as newly shown (refresh).
  const now = leanDisplay.leanShown(plan.shown, leanOn);
  const fx = window.dockEffects.renderEffects(shownModules, now, { userAction, quiet });
  shownModules = now;
  gamesView();                      // the games draw, and keep their clock, only while their panel is on screen
  askView();                        // the Ask panel reads the index status (and starts the first index) only once it is on screen
  ensureFontList();                 // the installed fonts are listed only once the Style panel is on screen
  reportResourcesViewing();         // main samples faster while any page shows the Resources panel
  for (const id of fx.newlyShown) { if (usageGestureLive()) usage('panel:' + id); onModuleShown(id); }
  syncCanvasView();                 // the dock moved or resized: the panel's native view follows (or goes, when it is hidden)
  paintSchedulesBadge();            // a rebuilt rail button has lost its count
  if (fx.vaultLeft) onVaultLeft();
  if (fx.focus === 'vault') setTimeout(() => document.getElementById('vault-search').focus(), 0);
  if (fx.focus === 'term') term.focus();
  const btn = document.getElementById('layout-btn');
  if (btn) btn.classList.toggle('own', ownLayout !== null);
  kbRefresh();                      // a keyboard move in flight lights the zones of the dock as it is now
  // Cell geometry changed, so the pty must be told or Ink's layout corrupts.
  if (refit) setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}

// The settle motion (dockable panels D4): the dock gets `.settling` for the length of the glide, and the CSS moves the
// groups, rails and dividers with a transition only while it is there. Never the terminal: xterm is refitted to the
// rectangle it ends in, and a rectangle still changing would be measured wrong.
let settleTimer = null;
function settleDock() {
  const dockEl = document.getElementById('dock');
  const reduced = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : undefined;
  const ms = window.dockTreeView.settleMs(reduced);
  clearTimeout(settleTimer);
  if (ms === 0) { dockEl.classList.remove('settling'); return; }
  dockEl.classList.add('settling');
  settleTimer = setTimeout(() => dockEl.classList.remove('settling'), ms + 40);
}

// A selection change (tab click, Ctrl+B, collapsing a group) stays in this window.
function commitSelection(next) {
  selection = DTm.cleanSelection(next);
  saveSelection();
  renderLayout({ userAction: true, settle: true });
}

// This tab's own layout to its host. Kept as pending until the host echoes it
// back, so a change made while the socket is down isn't undone by the next
// hello carrying the host's old value (PR #82 Dexter F8).
function sendOverride(layout) {
  pendingOverride = { layout };
  try { ws.send(JSON.stringify({ type: 'layout-override', layout })); } catch { /* not attached: hello resends */ }
}

const placementOf = l => JSON.stringify(l);

// Save the global layout. Main answers null when it refused the layout (not an object, over the size cap) or the
// write failed, and the call rejects when the bridge is gone: either way this window shows a layout that was not
// saved, which is said once per failed save instead of swallowed (PR #100 Miguel S3).
function saveGlobalLayout(l) {
  const bridge = window.harness && window.harness.layoutTree;
  if (!bridge) return;
  const notSaved = () => flashAttention({ urgent: false, title: 'Couldn\'t save the layout' });
  bridge.set(l).then((answer) => { if (!window.dockTreeView.layoutSaved(answer)) notSaved(); }, notSaved);
}

// A placement change (dock, hide, show, resize) goes to this tab's own layout
// when it has one or `justThisTab` asks for one, else to the global layout. A
// change that moves nothing writes nothing: no store write, no push to every
// window, no broadcast (PR #82 Miguel S3). `select` is the module the change
// is about (a dropped or ticked panel): it shows in its group in THIS window.
// `userAction: false` is for a change that is not a click or a key (a float's move or resize): it leaves keyboard
// focus where it is, so a field focused inside the float keeps it (PR #102 Miguel S3).
function commitPlacement(next, { justThisTab = false, select = null, userAction = true, refit = true } = {}) {
  if (flushKeyBurst) flushKeyBurst();       // a burst's drawn sizes would hide this change until its own flush
  usageGesture();
  const l = DTm.normalize(next, MODULE_IDS);
  const toOwn = justThisTab || ownLayout !== null;
  railEvent({ type: 'gone' });              // any change of the placement closes a rail's popover
  if (placementOf(l) === placementOf(toOwn && ownLayout ? ownLayout : globalLayout) && (!justThisTab || ownLayout)) {
    renderLayout({ userAction, refit });
    return;
  }
  if (select !== null) { selection = DTm.selectTab(selection, l, select); saveSelection(); }
  if (toOwn) {
    ownLayout = l;
    sendOverride(l);
  } else {
    globalLayout = l;
    saveGlobalLayout(l);
  }
  renderLayout({ userAction, refit, settle: userAction });
}

// Reset to global (the tab drops its own) and Make this global.
function dropOwnLayout({ makeGlobal = false } = {}) {
  if (!ownLayout) return;
  if (makeGlobal) {
    globalLayout = ownLayout;
    saveGlobalLayout(ownLayout);
  }
  ownLayout = null;
  sendOverride(null);
  renderLayout({ userAction: true });
}

function toggleAllZones() { commitSelection(DTm.toggleFoldAll(selection)); }

// A whole layout put in place (Reset layout, a preset) starts with every group open in this window: a collapse is a choice about
// the groups of the layout it was made in, and group names are handed out again by the next layout.
function openEveryGroup() {
  if (Object.keys(selection.collapsed).length === 0) return;
  selection = DTm.cleanSelection({ ...selection, collapsed: {} });
  saveSelection();
}

// Fold one group to its rail in this window, or open it again (D4). The window's choice: the shared layout is untouched.
function toggleGroupCollapse(groupId) {
  railEvent({ type: 'gone' });
  commitSelection(DTm.toggleCollapse(selection, placementLayout(), groupId));
}

// The dock rail's hover (BACKLOG #85). app/dock-tree-display.js railAfter decides; this owns the two timers it asks for: a hover
// waits RAIL_OPEN_MS before it opens a panel (a pass across the rail opens nothing), and leaving waits RAIL_CLOSE_MS before it
// closes one (a diagonal move into the panel isn't leaving). Answers whether the open panel changed, so the caller redraws.
function railEvent(ev) {
  const was = railSt;
  railSt = window.dockTreeView.railAfter(railSt, ev);
  peek = railSt.module === null ? null : { module: railSt.module };
  if (railSt.pending === null) { clearTimeout(railOpenTimer); railOpenTimer = null; }
  else if (railSt.pending !== was.pending) {
    clearTimeout(railOpenTimer);
    const m = railSt.pending;
    railOpenTimer = setTimeout(() => { railOpenTimer = null; usageGesture(); if (railEvent({ type: 'open-timer', module: m })) renderLayout({ refit: false }); }, RAIL_OPEN_MS);
  }
  if (!railSt.leaving) { clearTimeout(railCloseTimer); railCloseTimer = null; }
  else if (!was.leaving) {
    railCloseTimer = setTimeout(() => { railCloseTimer = null; if (railEvent({ type: 'close-timer' })) renderLayout({ refit: false }); }, RAIL_CLOSE_MS);
  }
  return railSt.module !== was.module;
}

// Pin or unpin a panel from its button (BACKLOG #85): a railed panel is docked beside the terminal, a docked one goes to the rail.
// `justThisTab` is the tab menu's check, like every other write of that menu (PR #168 Miguel B2); the buttons on a panel have
// none and follow the tab's own layout when it has one. The keyboard follows the panel (it was on the button just pressed, which
// is gone): to its new tab, and the change is said (Miguel Y1, Y5).
function togglePin(id, { justThisTab = false } = {}) {
  const l = settledLayout();
  const unpinning = !(l.rail || []).includes(id);
  commitPlacement(unpinning ? DTm.unpin(l, id) : DTm.pin(l, id), { select: id, justThisTab });
  const label = (TABS.find(t => t.id === id) || {}).label || id;
  const now = (placementLayout().rail || []).includes(id);
  const next = document.querySelector(now ? `.drail[data-rail="dock"] button[data-module="${CSS.escape(id)}"]` : `.dgroup .zone-tabs button[data-module="${CSS.escape(id)}"]`);   // not the sliding-out popover's own tab
  if (next) next.focus();
  document.getElementById('dock-announce').textContent = now ? `${label} unpinned: it is on the rail.` : `${label} pinned beside the terminal.`;
}

// "Show this panel" from somewhere other than its tab (the Resources link, Claude's panel asked to build something): a hidden
// panel is docked, an unpinned one opens from the rail and is held, a docked one is selected (PR #168 Miguel Y3).
function revealModule(id) {
  usageGesture();
  const l = placementLayout();
  if (l.hidden.includes(id)) commitPlacement(DTm.show(settledLayout(), id), { select: id });
  else if ((l.rail || []).includes(id)) {
    if (!(railSt.module === id && railSt.held)) { railEvent({ type: 'click', module: id }); renderLayout({ refit: false }); }
  } else selectModule(id);
}

// A rail's button: its panel opens over the terminal, a second press (or Esc, or a press elsewhere) closes it. It changes no
// placement and no selection, so nothing is saved and the pty isn't told. The focus follows peekFocus: an open popover has it (a
// mouse press left it on the button), a popover a press closed gives it back to the terminal, and Enter keeps it on the button.
function openPeek(id, byKeyboard) {
  usageGesture();
  railEvent({ type: 'click', module: id });
  renderLayout({ refit: false });
  const goes = window.dockTreeView.peekFocus(!!peek, byKeyboard);
  if (goes === 'terminal') {
    if (!shownModules.has('vault')) term.focus();        // never into the session while a secret may be half typed
    return;
  }
  const target = goes === 'popover' ? document.querySelector('.dpeek .zone-tabs button.on') : document.querySelector(`.drail button[data-module="${CSS.escape(id)}"]`);
  if (target) target.focus();
}

// A tab or a rail button: that module shows in its group, and Ctrl+B's fold is undone.
function selectModule(id) { usageGesture(); commitSelection(DTm.selectTab(selection, placementLayout(), id)); }

// --- moving modules: right-click, the layout menu, drag (layout pass L1) -----
// Ways in (the Window menu's checks, a tab's right-click, dragging a tab), one
// rule set (app/dock-tree.js dock / hide / show) and one save path (commitPlacement).
// *Just this tab* sends the change to this tab's own layout; once a tab has
// one, every change goes there until Reset to global.
const layoutMenu = document.getElementById('layout-menu');
let layoutMenuFor = null;               // 'menu' | a module id (right-click) | null
// The Presets section's inline field (dockable panels D3): { mode, name, text, error }. mode is 'idle', 'save'
// (the name field), 'replace' (asking to replace `name`), 'rename' (`name`'s field) or 'delete' (asking about `name`).
let presetUi = { mode: 'idle' };
let presetsState = { loaded: false, usable: false, list: [] };   // the stored list, as main last said
let presetPushes = 0;                    // lists pushed to this window by main: the probe counts the store writes with it

function closeLayoutMenu() {
  if (layoutMenu.hidden) return false;
  layoutMenu.hidden = true;
  layoutMenu.textContent = '';
  layoutMenuFor = null;
  presetUi = { mode: 'idle' };           // a half-typed name doesn't outlive the menu
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

// A module tab's (or rail button's) right-click, or Shift+F10 on it: Move, Float, Collapse / Expand group and Hide. A tab is
// also moved by dragging it; Move is the same thing from the keyboard (the zones light and the arrow keys step through them).
function openMoveMenu(id, x, y, byKeyboard = false) {
  closeLayoutMenu();
  layoutMenuFor = id;
  const label = (TABS.find(t => t.id === id) || {}).label || id;
  const check = justThisTabCheck();
  layoutMenu.appendChild(node('div', { className: 'lm-title', text: label }));
  // A panel on the dock's rail (#85) is pinned beside the terminal or hidden; moving and floating are for pinned panels.
  const railed = (placementLayout().rail || []).includes(id);
  if (railed) {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Pin', title: 'Dock this panel beside the terminal and keep it open',
      on: { click: () => { closeLayoutMenu(); togglePin(id, { justThisTab: check.box.checked }); } },
    }));
  } else {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Move', title: 'Choose where this panel goes with the arrow keys; Enter drops it, Esc cancels',
      on: { click: () => { closeLayoutMenu(); startKeyboardMove(id); } },
    }));
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Unpin', title: 'Send this panel to the rail on the right edge: it slides open over the terminal when you hover it',
      on: { click: () => { closeLayoutMenu(); togglePin(id, { justThisTab: check.box.checked }); } },
    }));
  }
  // A group of the tree folded to a rail in this window (Ctrl+B, an older fold) opens again; a float has no rail to fold to.
  const home = DTm.groupOf(placementLayout(), id);
  if (home && DTm.isCollapsed(selection, home)) {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Expand group', title: 'Open this group again',
      on: { click: () => { closeLayoutMenu(); toggleGroupCollapse(home.id); } },
    }));
  } else if (home) {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Unpin group', title: 'Send every panel of this group to the rail on the right edge',
      on: { click: () => { closeLayoutMenu(); commitPlacement(DTm.unpinGroup(settledLayout(), home.id), { justThisTab: check.box.checked }); } },
    }));
  }
  // A panel that is already alone in its float has nothing to float out of.
  const own = DTm.floatOf(placementLayout(), id);
  if (!railed && (!own || own.tabs.length > 1)) {
    layoutMenu.appendChild(node('button', {
      type: 'button', text: 'Float', title: 'Take this panel out of its group into a window of its own over the dock',
      on: { click: () => {
        commitPlacement(DTm.dock(settledLayout(), id, { float: true }), { justThisTab: check.box.checked, select: id });
        closeLayoutMenu();
      } },
    }));
  }
  layoutMenu.appendChild(node('button', {
    type: 'button', text: railed ? `Hide ${label}` : 'Hide', title: 'Take this panel off the screen; the Window menu brings it back',
    on: { click: () => {
      commitPlacement(DTm.hide(settledLayout(), id), { justThisTab: check.box.checked });
      closeLayoutMenu();
    } },
  }));
  layoutMenu.appendChild(node('div', { className: 'lm-sep' }));
  layoutMenu.appendChild(check.row);
  showLayoutMenu(x, y);
  // Opened with Shift+F10 or the menu key, the keyboard is in it: the first item has focus, the arrows walk the rest.
  // ...but not for a mouse right-click, which would put a focus ring on an item nobody pointed at (PR #159 Miguel S1).
  const first = layoutMenu.querySelector('button');
  if (first && byKeyboard) first.focus();
}

// The ▦ Window menu: a check per module, hidden ones included (unticking hides,
// ticking brings it back to its seat), so there is never a layout with nothing
// left to click.
function openLayoutMenu() {
  const anchor = document.getElementById('layout-btn').getBoundingClientRect();
  const keepField = presetUi;             // a redraw in place keeps the field being typed in
  const keepFocus = captureMenuFocus();   // ...and whatever had focus
  closeLayoutMenu();
  presetUi = keepField;
  layoutMenuFor = 'menu';
  const check = justThisTabCheck();
  layoutMenu.appendChild(node('div', { className: 'lm-title', text: ownLayout ? 'This tab\'s own layout' : 'Layout (every tab)' }));
  for (const row of window.dockTreeView.menuRows(placementLayout(), TABS)) {
    const box = node('input', { type: 'checkbox', checked: row.shown });
    box.dataset.module = row.id;
    box.addEventListener('change', () => {
      const l = settledLayout();
      if (box.checked) commitPlacement(DTm.showOnRail(l, row.id), { justThisTab: check.box.checked, select: row.id });   // back as a rail tab (#85)
      else commitPlacement(DTm.hide(l, row.id), { justThisTab: check.box.checked });
      openLayoutMenu();                           // redrawn in place, still open
    });
    layoutMenu.appendChild(node('label', {}, [box, node('span', { text: row.label })]));
  }
  layoutMenu.appendChild(resourceChipRow());
  appendPresetSection(check);
  layoutMenu.appendChild(node('div', { className: 'lm-sep' }));
  layoutMenu.appendChild(check.row);
  layoutMenu.appendChild(node('button', {
    type: 'button', text: 'Show / hide panels (Ctrl+B)', title: 'Fold every panel away, or bring them back',
    on: { click: () => { toggleAllZones(); closeLayoutMenu(); } },
  }));
  layoutMenu.appendChild(node('button', {
    type: 'button', text: 'Reset layout', title: 'Every panel back on the rail, default sizes',
    on: { click: () => { openEveryGroup(); commitPlacement(DTm.startLayout(MODULE_IDS), { justThisTab: check.box.checked }); closeLayoutMenu(); } },
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
  applyMenuFocus(keepFocus);
}

document.getElementById('layout-btn').addEventListener('click', () => {
  if (layoutMenuFor === 'menu') closeLayoutMenu();
  else { openLayoutMenu(); retryPresets(); }      // an unreadable preset list is asked for again each time
});
document.addEventListener('contextmenu', (e) => {
  const button = e.target.closest('.zone-tabs button[data-module], .drail button[data-module]');
  if (!button) return;
  e.preventDefault();
  openMoveMenu(button.dataset.module, e.clientX, e.clientY, e.button !== 2);     // Shift+F10 and the menu key come with button 0
});
// The arrows walk a menu opened from a tab (Move / Float / Collapse / Hide), as they do any menu.
layoutMenu.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || layoutMenuFor === 'menu') return;
  const items = [...layoutMenu.querySelectorAll('button, input')];
  const at = items.indexOf(document.activeElement);
  if (at === -1) return;
  e.preventDefault();
  items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
});
window.addEventListener('mousedown', (e) => {
  if (!layoutMenu.hidden && !layoutMenu.contains(e.target) && !e.target.closest('#layout-btn')) closeLayoutMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const hadFocus = layoutMenu.contains(document.activeElement);
  if (backOutOfPresetField() || closeLayoutMenu()) {
    e.preventDefault(); e.stopPropagation();
    if (layoutMenu.hidden && hadFocus) document.getElementById('layout-btn').focus();      // focus doesn't drop to the page behind
  }
}, true);

// --- layout presets (BACKLOG #53, dockable panels D3) -------------------------------------
// The Presets section of the Window menu: save the current placement under a name, apply it, rename, delete.
// app/dock-presets.js holds every rule; this draws the rows. The name field and both confirmations are rows
// inside the menu (no prompt() or confirm()), and the list is install-wide, in main's store (`layout-presets`).

/// The Presets section's own state moves by dockPresets.reduceMenu (pure, tested): what is open, what the user
// is told, and where focus goes next. This only draws it.
function dispatchPreset(event) { presetUi = window.dockPresets.reduceMenu(presetUi, event); }

// The one way the list changes: send main WHAT THE USER DID ({ op, name, ... }). Main applies it to a fresh locked
// read of the file and answers with the list it stored, so this window never computes the list (and a stale copy
// can't erase another window's preset), and an unreadable file is refused there, not here. While an op is in
// flight the section is disabled (`busy`), so a second op can't start from the same stale view.
function sendPresetOp(req, onAnswer) {
  const presetBridge = window.harness && window.harness.layoutPresets;
  if (!presetBridge || !presetsState.usable || presetsState.busy) return;
  presetsState = { ...presetsState, busy: true };
  refreshPresetMenu();
  const finish = (answer) => {
    const r = window.dockPresets.afterOp(answer);
    if (r.ok) presetsState = { loaded: true, usable: true, list: r.list, kept: r.kept, busy: false };
    else if (r.reason === 'unreadable') presetsState = { loaded: true, usable: false, list: [], kept: 0, busy: false };
    else presetsState = { ...presetsState, busy: false };
    if (!r.ok && r.reason === 'failed') flashAttention({ urgent: false, title: 'Couldn\'t save the presets' });
    onAnswer(r);
    if (!r.ok && window.dockPresets.needsResync(r.reason)) resyncPresets();
  };
  presetBridge.op(req).then(finish, () => finish(null));
}

// A refusal of `changed` or `missing` means this window's list is out of date (a lost poll, a push that never came):
// ask main for the list again, or the next question would be built from the same stale row and be refused the same way.
// The read also gives any preset an older build wrote its id, so a question about it can be answered.
async function resyncPresets() {
  const bridge = window.harness && window.harness.layoutPresets;
  if (!bridge) return;
  let answer = null;
  try { answer = await bridge.get(); } catch { return; }
  const next = window.dockPresets.afterGet(answer);
  if (!next.usable) return;
  presetsState = { loaded: true, ...next, busy: presetsState.busy === true };
  dispatchPreset({ type: 'list', list: presetsState.list });
  refreshPresetMenu();
}

// Redraw the open Window menu in place. A push never skips it: the field being typed in lives in presetUi.
function refreshPresetMenu() {
  if (layoutMenuFor === 'menu') openLayoutMenu();
}

// The answer decides the next state (a refusal stays on its field or question and says why; a success goes back to
// idle and puts focus on the row it made). The menu may have been closed meanwhile: it stays closed.
function runPresetOp(req) {
  const before = presetsState.list;
  sendPresetOp(req, (r) => {
    dispatchPreset({ type: 'answer', req, result: r.ok ? { ok: true } : { ok: false, reason: r.reason }, before, after: presetsState.list });
    refreshPresetMenu();
  });
}

function applyPreset(p, justThisTab) {
  // A layout this version can't read is refused and said: dockTree.readAny alone would answer the default layout for it.
  const r = window.dockPresets.presetLayout(p.layout, MODULE_IDS, DTm.readAny);
  if (!r.ok) {
    dispatchPreset({ type: 'notice', error: window.dockPresets.refusalText(r.reason), focus: { kind: 'row', name: p.name } });
    openLayoutMenu();
    return;
  }
  const hadFocus = layoutMenu.contains(document.activeElement);
  openEveryGroup();
  commitPlacement(r.layout, { justThisTab });
  closeLayoutMenu();
  if (hadFocus) document.getElementById('layout-btn').focus();      // focus doesn't drop to the page behind
}

function backOutOfPresetField() {
  if (layoutMenu.hidden || presetUi.mode === 'idle') return false;
  dispatchPreset({ type: 'cancel' });
  openLayoutMenu();
  return true;
}

// Focus survives a redraw: an explicit target (presetUi.focus, set by the reducer) wins; otherwise the control
// that had focus gets it back by what it is, because the redraw replaced every element.
function captureMenuFocus() {
  const a = document.activeElement;
  if (!a || a === document.body || !layoutMenu.contains(a)) return null;
  if (a.dataset.presetField) return { kind: 'field', action: a.dataset.presetField, from: a.selectionStart, to: a.selectionEnd };
  if (a.dataset.module) return { kind: 'module', id: a.dataset.module };
  if (a.dataset.presetAct) { const row = a.closest('.lm-preset'); return { kind: 'act', act: a.dataset.presetAct, name: row ? row.dataset.preset : null }; }
  return null;
}

function findMenuControl(t) {
  const presetRows = () => [...layoutMenu.querySelectorAll('.lm-preset')];
  switch (t.kind) {
    case 'field': return layoutMenu.querySelector(t.action ? `[data-preset-field="${t.action}"]` : '[data-preset-field]');
    case 'confirm': return layoutMenu.querySelector('[data-preset-act$="-confirm"]');
    case 'save-open': return layoutMenu.querySelector('[data-preset-act="save-open"]');
    case 'module': return [...layoutMenu.querySelectorAll('input[data-module]')].find(i => i.dataset.module === t.id) || null;
    case 'row': case 'act': {
      const act = t.kind === 'row' ? 'apply' : t.act;
      if (t.name === null || t.name === undefined) return layoutMenu.querySelector(`[data-preset-act="${act}"]`);
      const row = presetRows().find(r => r.dataset.preset === t.name);
      return row ? row.querySelector(`[data-preset-act="${act}"]`) : null;
    }
    default: return null;
  }
}

function applyMenuFocus(captured) {
  const explicit = presetUi.focus;
  const target = explicit || captured;
  if (target) {
    const el = findMenuControl(target) || (explicit ? findMenuControl({ kind: 'save-open' }) : null);
    if (el && !el.disabled) {
      el.focus();
      if (el.tagName === 'INPUT' && el.type === 'text') {
        if (explicit && presetUi.select) el.select();                    // selected only when the field opens, never on a redraw
        else if (!explicit && Number.isInteger(target.from)) el.setSelectionRange(target.from, target.to);
        else el.setSelectionRange(el.value.length, el.value.length);     // a refused name stays as typed, caret at its end
      }
    }
  }
  if (explicit) dispatchPreset({ type: 'focused' });
}

// The small picture of a layout beside its name: the boxes dockPresets.thumbBoxes fits into 44 x 28.
function presetThumb(layout) {
  const thumb = node('span', { className: 'lm-thumb', 'aria-hidden': 'true' });
  // A layout this version can't read is not drawn as the default: a neutral box says it is unknown.
  if (!window.dockPresets.presetLayout(layout, MODULE_IDS, DTm.readAny).ok) { thumb.classList.add('unknown'); thumb.textContent = '?'; return thumb; }
  const fitFn = (l, ids, viewport) => DTm.fit(DTm.readAny(l, ids), null, viewport);
  for (const b of window.dockPresets.thumbBoxes(layout, MODULE_IDS, fitFn)) {
    const box = node('i', { className: b.kind });
    Object.assign(box.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    thumb.appendChild(box);
  }
  return thumb;
}

// What the user is told about the last refusal or change, as a line under the row it belongs to.
function presetErrorLine() {
  return presetUi.error ? [node('div', { className: 'lm-note err', role: 'alert', text: presetUi.error })] : [];
}

// A text field row: Enter commits (not while an IME is composing), the buttons beside it commit or back out. Esc is
// handled by the menu's own key handler.
function presetFieldRow({ label, value, action, commitText, commitLabel, cancelLabel, onCommit }) {
  const field = node('input', { type: 'text', value, maxLength: window.dockPresets.NAME_MAX * 2, 'aria-label': label, placeholder: 'Preset name' });
  field.dataset.presetField = action;
  field.addEventListener('input', () => dispatchPreset({ type: 'typed', text: field.value }));
  const commit = () => { dispatchPreset({ type: 'typed', text: field.value }); onCommit(field.value); };      // a refusal redraws with what was typed
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(); }
  });
  return [node('div', { className: 'lm-row' }, [
    field,
    node('button', { type: 'button', text: commitText, 'aria-label': commitLabel || commitText, on: { click: commit } }),
    node('button', { type: 'button', text: 'Cancel', 'aria-label': cancelLabel || 'Cancel', on: { click: () => backOutOfPresetField() } }),
  ])];
}

// An "are you sure" row: the question (announced), then the confirming button and Cancel.
function presetAskRow({ question, confirmText, action, confirmLabel, cancelLabel, onConfirm }) {
  const yes = node('button', { type: 'button', text: confirmText, 'aria-label': confirmLabel, on: { click: onConfirm } });
  yes.dataset.presetAct = action;
  return [node('div', { className: 'lm-row' }, [
    node('span', { className: 'lm-name', role: 'alert', text: question }),
    yes,
    node('button', { type: 'button', text: 'Cancel', 'aria-label': cancelLabel, on: { click: () => backOutOfPresetField() } }),
  ])];
}

// The id a question remembers for the preset it is about (BACKLOG #59): its answer carries it (presetUi.id), so main
// refuses it as `changed` if another window has since put a different preset under that name. None stored is null.
const presetId = p => (typeof p.id === 'string' ? p.id : null);

function presetRow(p, check) {
  const label = kind => window.dockPresets.labelFor(kind, p.name);
  if (presetUi.mode === 'rename' && presetUi.name === p.name) {
    return [...presetFieldRow({
      label: label('rename-field'), value: presetUi.text !== undefined ? presetUi.text : p.name, action: 'rename', commitText: 'Rename',
      commitLabel: label('rename-commit'), cancelLabel: label('rename-cancel'),
      onCommit: (text) => runPresetOp({ op: 'rename', name: p.name, to: text, id: presetUi.id }),
    }), ...presetErrorLine()];
  }
  if (presetUi.mode === 'delete' && presetUi.name === p.name) {
    return [...presetAskRow({
      question: `Delete '${p.name}'?`, confirmText: 'Delete', action: 'delete-confirm',
      confirmLabel: label('delete-confirm'), cancelLabel: label('delete-cancel'),
      onConfirm: () => runPresetOp({ op: 'delete', name: p.name, id: presetUi.id }),
    }), ...presetErrorLine()];
  }
  const apply = node('button', { type: 'button', className: 'lm-apply', title: `Apply ${p.name}`, text: p.name, 'aria-label': label('apply'),
    on: { click: () => applyPreset(p, check.box.checked) } });
  apply.dataset.presetAct = 'apply';
  const rename = node('button', { type: 'button', className: 'lm-mini', text: '✎', title: 'Rename', 'aria-label': label('rename-open'),
    on: { click: () => { dispatchPreset({ type: 'open', mode: 'rename', name: p.name, id: presetId(p) }); openLayoutMenu(); } } });
  rename.dataset.presetAct = 'rename';
  const del = node('button', { type: 'button', className: 'lm-mini', text: '✕', title: 'Delete', 'aria-label': label('delete-open'),
    on: { click: () => { dispatchPreset({ type: 'open', mode: 'delete', name: p.name, id: presetId(p) }); openLayoutMenu(); } } });
  del.dataset.presetAct = 'delete';
  const row = node('div', { className: 'lm-row lm-preset' }, [presetThumb(p.layout), apply, rename, del]);
  row.dataset.preset = p.name;
  return [row];
}

function appendPresetSection(check) {
  if (!(window.harness && window.harness.layoutPresets)) return;       // a window with no bridge has no presets
  layoutMenu.appendChild(node('div', { className: 'lm-sep' }));
  const section = node('div', { className: 'lm-presets', 'aria-busy': presetsState.busy ? 'true' : 'false' });
  layoutMenu.appendChild(section);
  section.appendChild(node('div', { className: 'lm-title', text: 'Presets' }));
  if (!presetsState.loaded) {
    section.appendChild(node('div', { className: 'lm-note', text: 'Loading presets…' }));
    return;
  }
  if (!presetsState.usable) {
    section.appendChild(node('div', { className: 'lm-note err', role: 'alert', text: window.dockPresets.refusalText('unreadable') }));
    return;
  }
  // The list scrolls inside its own region (the menu never grows past the window); what is under it stays reachable.
  const list = node('div', { className: 'lm-presets-list' });
  for (const p of presetsState.list) for (const el of presetRow(p, check)) list.appendChild(el);
  section.appendChild(list);
  if (presetsState.kept > 0) section.appendChild(node('div', { className: 'lm-note', text: window.dockPresets.keptText(presetsState.kept) }));
  if (presetUi.mode === 'save') {
    for (const el of [...presetFieldRow({
      label: 'Name for this layout', value: presetUi.text || '', action: 'save', commitText: 'Save', commitLabel: 'Save this layout', cancelLabel: 'Cancel saving',
      onCommit: (text) => runPresetOp({ op: 'save', name: text, layout: committedLayout() }),
    }), ...presetErrorLine()]) section.appendChild(el);
  } else if (presetUi.mode === 'replace') {
    const label = kind => window.dockPresets.labelFor(kind, presetUi.name);
    for (const el of [...presetAskRow({
      question: `Replace '${presetUi.name}'?`, confirmText: 'Replace', action: 'replace-confirm',
      confirmLabel: label('replace-confirm'), cancelLabel: label('replace-cancel'),
      onConfirm: () => runPresetOp({ op: 'save', name: presetUi.name, layout: committedLayout(), replace: true, id: presetUi.id }),
    }), ...presetErrorLine()]) section.appendChild(el);
  } else {
    if (presetUi.mode === 'idle') for (const el of presetErrorLine()) section.appendChild(el);     // rename and delete draw theirs on their own row
    const save = node('button', { type: 'button', text: 'Save this layout…', title: 'Keep this arrangement under a name',
      on: { click: () => { dispatchPreset({ type: 'open', mode: 'save' }); openLayoutMenu(); } } });
    save.dataset.presetAct = 'save-open';
    section.appendChild(save);
  }
  if (presetsState.busy) for (const el of section.querySelectorAll('button, input')) el.disabled = true;
}

// The stored list, once the layout is loaded; another window's change replaces it. An unreadable file is
// "couldn't read" (saving stays off), never "no presets": see dockPresets.afterGet.
async function loadPresets() {
  const bridge = window.harness && window.harness.layoutPresets;
  if (!bridge) return;
  bridge.onChange((list) => {
    presetPushes += 1;
    presetsState = { loaded: true, usable: true, ...window.dockPresets.describe(list), busy: presetsState.busy === true };
    dispatchPreset({ type: 'list', list: presetsState.list });
    refreshPresetMenu();
  });
  let answer = null;
  try { answer = await bridge.get(); } catch { /* unreadable: afterGet says so */ }
  presetsState = { loaded: true, ...window.dockPresets.afterGet(answer) };
  refreshPresetMenu();
}

// An unreadable list isn't forever (an antivirus scan, another window's rename in flight): every time the Window
// menu opens it is asked for again, and presets come back without another window having to write the file.
async function retryPresets() {
  const bridge = window.harness && window.harness.layoutPresets;
  if (!bridge || !window.dockPresets.needsRetry(presetsState)) return;
  let answer = null;
  try { answer = await bridge.get(); } catch { /* still unreadable */ }
  const next = window.dockPresets.afterGet(answer);
  if (!next.usable || !window.dockPresets.needsRetry(presetsState)) return;      // still unreadable, or a push got there first
  presetsState = { loaded: true, ...next, busy: false };
  dispatchPreset({ type: 'list', list: presetsState.list });
  refreshPresetMenu();
}

// --- dragging a module's tab (dockable panels D1) ---------------------------------
// Pointer events, not HTML5 drag-and-drop: the zones are drawn and hit-tested by
// app/dock-drag.js, and HTML5 drag gives no control over either. A press that
// never moves 5 px stays a click (it selects the tab). While dragging, every zone
// of the cell under the pointer is lit in #dock-overlay and the one under it
// fills; a drop on a zone docks, anywhere else changes nothing.
let cancelTabDrag = () => {};      // the socket closing ends a drag too

// The zones of a drop, lit in #dock-overlay: the tab drag's and the keyboard move's. [] clears it.
function paintZones(zones) {
  const overlayEl = document.getElementById('dock-overlay');
  overlayEl.textContent = '';
  for (const z of zones) {
    const el = node('div', { className: z.hot ? 'dz hot' : 'dz' });
    Object.assign(el.style, { left: `${z.rect.x}px`, top: `${z.rect.y}px`, width: `${z.rect.width}px`, height: `${z.rect.height}px` });
    overlayEl.appendChild(el);
  }
}
// What a drop on `target` asks the model for: the terminal's middle floats the panel where it was dropped (D2).
const landingFor = (target, at, viewport) => (target.float === true ? { float: DTm.floatSpotAt(at, viewport) } : target);
let tabDragDraws = 0;             // how many times the drag rebuilt the overlay: the probe checks an idle pointer costs none
(function initTabDrag() {
  const dock = document.getElementById('dock');
  const overlay = document.getElementById('dock-overlay');
  let press = null;                // { id, label, x, y, el, pointerId }: the button is down, not yet dragged
  let drag = null;                 // { id, ghost, target, rect, viewport, sig }

  function drawZones(zones) {
    tabDragDraws += 1;
    paintZones(zones);
  }
  function end() {
    if (press) { try { press.el.releasePointerCapture(press.pointerId); } catch { /* not captured, or the button is gone */ } }
    press = null;
    if (drag) drag.ghost.remove();
    drag = null;
    overlay.textContent = '';
    document.body.classList.remove('dock-dragging');
  }
  cancelTabDrag = () => { if (press || drag) end(); };

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const b = e.target.closest && e.target.closest('.zone-tabs button[data-module]');
    if (!b) return;
    press = { id: b.dataset.module, label: b.textContent, x: e.clientX, y: e.clientY, el: b, pointerId: e.pointerId };
    // Capture keeps the moves and the release coming to this page when the pointer leaves the window; if the
    // release is lost anyway (Alt-Tab, an OS dialog), the three guards below end the drag (PR #100 Miguel I2).
    try { b.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
  });
  window.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (e.buttons === 0) { end(); return; }              // the release never came: the button is up
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
      // The dock's rectangle and size are read once, here: a move event must not force a layout every time.
      // A tab dragged out of a float: that float is no drop target, what is under it decides (D2).
      const own = DTm.floatOf(placementLayout(), press.id);
      drag = { id: press.id, ghost: node('div', { id: 'dock-ghost', text: press.label }), target: null, rect: dock.getBoundingClientRect(), viewport: dockViewport(), sig: null, exclude: own ? own.id : null, at: null };
      document.body.appendChild(drag.ghost);
      document.body.classList.add('dock-dragging');
    }
    drag.ghost.style.left = `${e.clientX + 12}px`;
    drag.ghost.style.top = `${e.clientY + 10}px`;
    drag.at = { x: e.clientX - drag.rect.left, y: e.clientY - drag.rect.top };
    const hit = window.dockDrag.zonesAt(lastPlan ? lastPlan.boxes : [], drag.viewport, drag.at, { exclude: drag.exclude });
    drag.target = hit.target;
    // The overlay is the cell under the pointer's zones and which one is hot: unchanged, nothing to rebuild.
    const sig = JSON.stringify(hit.zones);
    if (sig !== drag.sig) { drag.sig = sig; drawZones(hit.zones); }
  });
  window.addEventListener('pointerup', () => {
    if (!press) return;
    const d = drag;
    // Ended BEFORE the drop redraws: the redraw removes the dragged tab's button,
    // and a removed source never reports an end (L1 PR #82 Dexter F1, Miguel I2).
    end();
    if (!d) return;                                     // never moved: the click that follows selects the tab
    if (!d.target) return;
    // The terminal's middle floats the panel where it was dropped: the model says where (D2).
    const target = landingFor(d.target, d.at, d.viewport);
    commitPlacement(DTm.dock(settledLayout(), d.id, target), { select: d.id });
  });
  window.addEventListener('pointercancel', () => { cancelTabDrag(); });
  window.addEventListener('lostpointercapture', () => { cancelTabDrag(); });   // after a normal release `press` is already null
  window.addEventListener('blur', () => { cancelTabDrag(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); end(); }
  }, true);
})();

// --- moving a panel with the keyboard (dockable panels D4) ------------------------------------
// The tab's menu has Move (right-click, or Shift+F10 / the menu key on a focused tab). It lights the zones of one cell and
// the rim, as a drag does; the arrow keys step to the next zone and across to the next cell, Tab and Shift+Tab walk every
// zone in order, Enter drops, Esc cancels. The keys are taken whole while it lasts (none reaches the terminal), and a
// status line says in words where the panel would land. The zones, the steps and the words are app/dock-drag.js's; the
// drop is the tab drag's own (DTm.dock through commitPlacement). A press anywhere, a blur or the socket closing ends it.
let startKeyboardMove = () => {};
let cancelKeyboardMove = () => {};
(function initKeyboardMove() {
  const announce = document.getElementById('dock-announce');
  const labelOf = id => (TABS.find(t => t.id === id) || {}).label || id;
  const nameOf = (cell) => {
    if (cell === 'term') return 'the terminal';
    const gr = DTm.allGroups(placementLayout()).find(x => x.id === cell);
    return gr ? `the ${gr.tabs.map(labelOf).join(', ')} group` : 'that group';
  };
  const say = (text) => { announce.textContent = text; };
  const boxes = () => (lastPlan ? lastPlan.boxes : []);
  const exclude = () => { const own = kbMove ? DTm.floatOf(placementLayout(), kbMove.id) : null; return own ? own.id : null; };
  function show() {
    paintZones(window.dockDrag.zonesFor(boxes(), dockViewport(), kbMove.target).zones);
    say(`Moving ${labelOf(kbMove.id)}: ${window.dockDrag.describeTarget(kbMove.target, nameOf)}. Arrow keys or Tab choose, Enter drops, Escape cancels.`);
  }
  function end() {
    kbMove = null;
    paintZones([]);
    document.body.classList.remove('dock-moving');
  }
  // A module on a rail has no tab in a bar: its rail button takes the focus, so it never falls to the body (PR #159 Miguel S4).
  const refocus = id => { const b = document.querySelector(`.zone-tabs button[data-module="${CSS.escape(id)}"], .drail button[data-module="${CSS.escape(id)}"]`); if (b) b.focus(); };
  startKeyboardMove = (id) => {
    cancelTabDrag();
    if (peek) { railEvent({ type: 'drop' }); renderLayout({ refit: false }); }     // the popover goes off the screen too, not only out of the state (PR #159 Dexter 4)
    kbMove = { id, target: window.dockDrag.startTarget(boxes(), id) };
    document.body.classList.add('dock-moving');
    show();
  };
  cancelKeyboardMove = () => { if (kbMove) { end(); say('Move cancelled.'); } };
  kbRefresh = () => { if (kbMove) show(); };

  window.addEventListener('keydown', (e) => {
    if (!kbMove) return;
    e.preventDefault(); e.stopPropagation();
    const { id } = kbMove;
    if (e.key === 'Escape') { end(); say('Move cancelled.'); refocus(id); return; }
    if (e.key === 'Enter') {
      if (e.repeat) return;                 // holding Enter on the menu's Move item must not drop at once (PR #159 Miguel S5)
      const vp = dockViewport();
      const hot = window.dockDrag.zonesFor(boxes(), vp, kbMove.target);
      const target = kbMove.target;
      end();
      if (!hot.target) { say('Move cancelled: that place is gone.'); refocus(id); return; }
      const zone = hot.zones.find(z => z.hot);
      const at = { x: zone.rect.x + zone.rect.width / 2, y: zone.rect.y + zone.rect.height / 2 };
      const next = DTm.dock(settledLayout(), id, landingFor(target, at, vp));
      const moved = placementOf(DTm.normalize(next, MODULE_IDS)) !== placementOf(placementLayout());
      commitPlacement(next, { select: id });
      say(window.dockDrag.describeDrop(moved, labelOf(id), window.dockDrag.describeTarget(target, nameOf)));
      refocus(id);
      return;
    }
    const was = JSON.stringify(kbMove.target);
    kbMove.target = window.dockDrag.nextZone(boxes(), dockViewport(), kbMove.target, e.key === 'Tab' && e.shiftKey ? 'ShiftTab' : e.key, { exclude: exclude() });
    show();
    // The words repeat when the key found nothing, so the live region would stay silent: say so (PR #159 Miguel S3).
    if (was === JSON.stringify(kbMove.target) && e.key.startsWith('Arrow')) say(`${announce.textContent} No zone further that way.`);
  }, true);
  window.addEventListener('pointerdown', () => { cancelKeyboardMove(); });
  window.addEventListener('blur', () => { cancelKeyboardMove(); });
})();

// --- floating panels (dockable panels D2) -------------------------------------------
// A float is moved by the empty part of its tab bar, resized by its corner grip and raised by pressing it
// anywhere. Raising is this window's selection (floatOrder, localStorage): a click never writes the shared
// layout. A move or resize is DRAWN while it goes (dragLayout, as the dividers do) and saved ONCE on release,
// applied to the placement as it is then (PR #100 Dexter F6). Dragging a float's TAB is the tab drag above
// (it docks that panel). What a move or resize asks for, and every clamp, is app/dock-tree.js's.
// A press that moves nothing stores nothing (PR #102 Dexter 2): the drag starts after FLOAT_SLOP px, and a release that
// lands where the float is already drawn is no change (dockTreeView.floatDragResult). It follows only the pointer that
// pressed (Miguel S4), is drawn at most once per animation frame, and never asks the terminal to refit: a float
// doesn't change the terminal's rectangle (Miguel Y2). A float's position and size by keyboard, and a name for the
// grip for assistive tech, are not built: the bar and the grip are pointer-only, and the tab's Move (D4) docks a
// floating panel elsewhere from the keyboard.
let floatDragDraws = 0;   // how many times a float drag redrew: the probe checks N moves in one frame draw once
let floatDrag = null;     // { kind: 'move' | 'resize', id, tabs, start, rect, viewport, base, el, pointerId, last, started, frame }
(function initFloats() {
  const FLOAT_SLOP = 3;
  const dock = document.getElementById('dock');

  function finish(d) {
    try { d.el.releasePointerCapture(d.pointerId); } catch { /* not captured, or the element is gone */ }
    if (d.frame) cancelAnimationFrame(d.frame);
    d.frame = 0;
    document.body.classList.remove('dock-dragging');
    floatDrag = null;
  }
  // What the drag has so far, drawn (not saved) over the placement it started from.
  function drawDrag(d) {
    d.frame = 0;
    if (floatDrag !== d) return;
    const next = window.dockTreeView.floatDragResult(d.base, d);
    const shown = next === null || next === d.base ? null : next;
    if (shown !== dragLayout) { dragLayout = shown; floatDragDraws += 1; renderLayout({ refit: false }); }
  }
  // A drag the system took away, or whose release never came, is not a choice: draw what is saved.
  function cancelFloatDrag(e) {
    const d = floatDrag;
    if (!d || (e && typeof e.pointerId === 'number' && e.pointerId !== d.pointerId)) return;
    finish(d);
    dragLayout = null;
    renderLayout({ refit: false });
  }

  // What moves or resizes a float: its bar's own surface (the handle and the empty part) and the grip.
  const floatHandleOf = t => !!t && !!t.closest && !!t.closest('.dfloat') && (!!t.closest('.dfloat-grip') || (t.classList.contains('zone-tabs')));
  // A press on those is no click on a control, so it must not blur the field that holds the keyboard (a half-typed
  // secret in a floating Vault): the pointerdown's preventDefault doesn't stop focus moving, the mousedown's does.
  dock.addEventListener('mousedown', (e) => {
    if (e.button === 0 && floatHandleOf(e.target)) e.preventDefault();
  });
  dock.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest && e.target.closest('.dfloat');
    if (!el) return;
    const id = el.dataset.group;
    const raised = DTm.raiseFloat(selection, id);
    if (JSON.stringify(raised) !== JSON.stringify(selection)) { selection = raised; saveSelection(); renderLayout({ refit: false }); }
    const kind = e.target.closest('.dfloat-grip') ? 'resize' : (e.target === el.querySelector('.zone-tabs') ? 'move' : null);
    const box = lastPlan ? lastPlan.boxes.find(b => b.kind === 'float' && b.id === id) : null;
    if (!kind || !box) return;
    const base = placementLayout();
    const fl = base.floats.find(f => f.id === id);
    if (!fl) return;
    // The viewport is read once, here: a move event must not force a layout every time. `rect` is where the float
    // is DRAWN (the window may have clamped it), because that is what the pointer grabbed. `tabs` is what it held:
    // the release applies only to a float that still holds them (a name can be handed out again).
    floatDrag = { kind, id, tabs: [...fl.tabs], start: { x: e.clientX, y: e.clientY }, rect: box.rect, viewport: dockViewport(), base, el: e.target, pointerId: e.pointerId, last: null, started: false, frame: 0 };
    try { e.target.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    const d = floatDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.buttons === 0) { cancelFloatDrag(e); return; }
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (!d.started) {
      if (Math.hypot(dx, dy) < FLOAT_SLOP) return;
      d.started = true;
      document.body.classList.add('dock-dragging');          // no text selection while it goes
    }
    d.last = d.kind === 'move' ? { x: d.rect.x + dx, y: d.rect.y + dy } : { w: Math.max(1, d.rect.width + dx), h: Math.max(1, d.rect.height + dy) };
    if (!d.frame) d.frame = requestAnimationFrame(() => drawDrag(d));
  });
  window.addEventListener('pointerup', (e) => {
    const d = floatDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    finish(d);
    if (!d.started) return;                                  // a click: the press raised it, nothing else
    dragLayout = null;
    const committed = committedLayout();
    const result = window.dockTreeView.floatDragResult(committed, d);
    // null: the float is not the one that was grabbed any more. Same layout: nothing was chosen. Either way draw what is saved.
    if (result === null || result === committed) renderLayout({ refit: false });
    else commitPlacement(result, { userAction: false, refit: false });      // the one real choice, saved once
  });
  window.addEventListener('pointercancel', cancelFloatDrag);
  window.addEventListener('lostpointercapture', cancelFloatDrag);   // after a normal release the drag is already over
  window.addEventListener('blur', cancelFloatDrag);
})();

// --- focus mode (layout pass L1, #1) -----------------------------------------
// Only the terminal: main lifts this view over the tab strip and tells every
// view; this page hides its header, zones and diagnostics. Ways back: the same
// key (Ctrl+Shift+F, main's), the exit in the top-right corner, and Ctrl+B.
const focusBridge = window.harness && window.harness.focus;
let focusOn = false;
function applyFocusMode(on) {
  if (on === focusOn) return;
  focusOn = on;
  if (on) usage('focus:on');
  document.body.classList.toggle('focus-mode', on);
  closeLayoutMenu();
  // Focus mode hides the vault too, so it is "left": revealed secrets go.
  if (on && shownModules.has('vault')) onVaultLeft();
  // Only the terminal shows, so it takes the keyboard. Left in a panel field,
  // focus stayed in an INVISIBLE input: typing went into the hidden vault field
  // and Ctrl+B never reached the terminal's handler (probe check 7, found
  // after check 8 left focus in #vault-secret).
  if (on) term.focus();
  paintBar();       // the bar hides with the chrome: bar-open and the banner's offset are re-read (PR #99 Miguel G6)
  if (!on && shownModules.has('vault')) renderVault();
  renderLayout();   // the rails are display:none while focus is on: draw the dock again so any rail that lost its fit then is fitted now
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}
if (focusBridge) focusBridge.onChange(applyFocusMode);
for (const id of ['focus-btn', 'focus-exit']) {
  document.getElementById(id).addEventListener('click', () => { if (focusBridge) focusBridge.toggle(); });
}

// A tab in a group, a tab in a rail's popover, or a button on a rail. (The click a finished tab drag leaves
// behind lands on the drop's common ancestor, not on a tab: nothing to swallow.)
document.addEventListener('click', (e) => {
  const pinButton = e.target.closest('.dpin');
  if (pinButton) { togglePin(pinButton.dataset.pin); return; }
  const button = e.target.closest('.zone-tabs button[data-module], .drail button[data-module]');
  if (!button) return;
  const id = button.dataset.module;
  if (button.parentNode.classList.contains('drail')) { openPeek(id, e.detail === 0); return; }
  if (button.closest('.dpeek')) {
    // Another tab of the same rail: the popover shows that panel. Nothing is saved; the pty is not told.
    railEvent({ type: 'tab', module: id });
    renderLayout({ refit: false });
    const chosen = document.querySelector('.dpeek .zone-tabs button.on');       // the redraw replaced the button that was pressed
    if (chosen) chosen.focus();
    return;
  }
  selectModule(id);
});

// A rail's popover closes on Esc and on a press outside it and its rail (a press on the rail is the rail's own click).
// Esc is the popover's only when the person is IN it (or on its rail button): everywhere else it is the terminal's own
// interrupt, which is never taken (PR #99 Miguel G3; PR #159 Miguel B1).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !peek || kbMove) return;
  const held = document.activeElement;
  if (!held || !held.closest || !held.closest('.dpeek, .drail')) return;
  const was = peek.module;
  railEvent({ type: 'escape' });
  renderLayout({ refit: false });
  e.preventDefault(); e.stopPropagation();
  const rail = document.querySelector(`.drail button[data-module="${CSS.escape(was)}"]`);
  if (rail) rail.focus();
}, true);
// ...and when the keyboard leaves it for something else (Tab out of the popover): otherwise keys would type into the
// terminal behind an open panel. A focus that goes nowhere (the window blurring, a button replaced) keeps it open.
document.addEventListener('focusout', (e) => {
  const to = e.relatedTarget;
  if (!peek || !to || !to.closest || to.closest('.dpeek, .drail')) return;
  railEvent({ type: 'outside' });
  renderLayout({ refit: false });
});
document.addEventListener('pointerdown', (e) => {
  if (!peek) return;
  const inside = e.target.closest && e.target.closest('.dpeek');
  if (inside) { railEvent({ type: 'hold' }); return; }        // using the panel holds it open, like a click on its tab (PR #168 Miguel Y2)
  if (e.target.closest && e.target.closest('.drail')) return;
  railEvent({ type: 'outside' });
  renderLayout({ refit: false });
});
// ...and so does the keyboard being in it: typing in a field of a hover-opened panel must not lose it to the pointer leaving.
document.addEventListener('focusin', (e) => {
  if (peek && e.target.closest && e.target.closest('.dpeek')) railEvent({ type: 'hold' });
});

// Hovering a tab of the dock's rail slides its panel open over the terminal (BACKLOG #85); moving off the tab and the panel
// slides it back after a short grace. The pointer is judged by what it is over now: a rail tab, the panel, or anything else
// (the rail's empty strip is anything else: it is neither a tab nor the panel, PR #168 Dexter 3). Touch has no hover.
document.addEventListener('pointerover', (e) => {
  const t = e.target;
  if (e.pointerType === 'touch' || !t || !t.closest) return;
  const tab = t.closest('.drail[data-rail="dock"] button[data-module]');
  let ev = null;
  if (tab) ev = { type: 'enter', module: tab.dataset.module };
  else if (t.closest('.dpeek')) ev = { type: 'enter-panel' };
  else if (railSt.module !== null || railSt.pending !== null) ev = { type: 'leave' };
  if (ev && railEvent(ev)) renderLayout({ refit: false });
});
document.documentElement.addEventListener('pointerleave', () => { if (railEvent({ type: 'leave' })) renderLayout({ refit: false }); });

// Double-clicking the empty part of a group's tab bar unpins the group: every tab goes to the rail (a double-click on a tab is
// just a click on it, twice). A group a window folded to a rail before (Ctrl+B, or an older fold) opens again by double-clicking
// its rail (this window only).
document.addEventListener('dblclick', (e) => {
  const bar = e.target.closest && e.target.closest('.dgroup:not(.dfloat) > .zone-tabs');
  if (bar) {
    if (e.target === bar) commitPlacement(DTm.unpinGroup(settledLayout(), bar.parentNode.dataset.group));
    return;
  }
  const rail = e.target.closest && e.target.closest('.drail button[data-module]');
  const home = rail ? DTm.groupOf(placementLayout(), rail.dataset.module) : null;
  if (home && DTm.isCollapsed(selection, home)) toggleGroupCollapse(home.id);
});

// --- the shortcuts sheet (BACKLOG #43) ---------------------------------------------
// Opened by F1 (main: shortcutFor -> window.toggleShortcutsPage) and the header's "?"; Esc closes it. The rows are
// app/shortcut-table.js's, drawn by app/shortcuts-display.js. Focus goes to the search box on open and back to where
// it was on close (the terminal's textarea, usually).
const shortcutsSheetEl = document.getElementById('shortcuts-sheet');
const shortcutsBtnEl = document.getElementById('shortcuts-btn');
const shortcutsSearchEl = document.getElementById('shortcuts-search');
const shortcutsBodyEl = document.getElementById('shortcuts-body');
let shortcutsOpen = false;
let shortcutsReturnFocus = null;

function paintShortcuts() { shortcutsBodyEl.innerHTML = window.shortcutsDisplay.sheetBodyHtml(shortcutsSearchEl.value); }

// Below the header, so the "?" that opened it can close it; with the header hidden (focus mode) the sheet takes the window.
function placeShortcuts() {
  const bar = document.querySelector('header');
  shortcutsSheetEl.style.setProperty('--sc-top', `${bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0}px`);
}

function openShortcutsPage() {
  if (shortcutsOpen) return;
  shortcutsOpen = true;
  shortcutsReturnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  placeShortcuts();
  // The page under the header is inert while the sheet is up (aria-modal means it): no clicks, no focus. The header stays live so "?" closes it.
  document.getElementById('body').inert = true;
  shortcutsSearchEl.value = '';
  paintShortcuts();
  shortcutsSheetEl.hidden = false;
  shortcutsBtnEl.setAttribute('aria-expanded', 'true');
  shortcutsSearchEl.focus();
}

function closeShortcutsPage() {
  if (!shortcutsOpen) return;
  shortcutsOpen = false;
  shortcutsSheetEl.hidden = true;
  document.getElementById('body').inert = false;
  shortcutsBtnEl.setAttribute('aria-expanded', 'false');
  const back = shortcutsReturnFocus;
  shortcutsReturnFocus = null;
  // Where it was, if that's still on the page; otherwise the terminal, which is where typing goes.
  if (back && back.isConnected && typeof back.focus === 'function') back.focus(); else term.focus();
}

window.toggleShortcutsPage = () => { if (shortcutsOpen) closeShortcutsPage(); else openShortcutsPage(); };
shortcutsBtnEl.addEventListener('click', window.toggleShortcutsPage);
document.getElementById('shortcuts-close').addEventListener('click', closeShortcutsPage);
shortcutsSheetEl.querySelector('.sc-scrim').addEventListener('click', closeShortcutsPage);
shortcutsSearchEl.addEventListener('input', paintShortcuts);
// Capture phase and before any other Esc handler: while the sheet is up, Esc closes it and goes no further (it is never
// Claude's interrupt, which would otherwise reach the pty). F1 is main's; this page takes no other key.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && shortcutsOpen) { e.preventDefault(); e.stopPropagation(); closeShortcutsPage(); }
  // The focus trap: Tab cycles the sheet's own controls (search, close, the "?" in the header is reached by the mouse).
  if (e.key === 'Tab' && shortcutsOpen && !e.ctrlKey && !e.altKey) {
    const stops = [shortcutsSearchEl, document.getElementById('shortcuts-close')];
    const at = stops.indexOf(document.activeElement);
    const to = window.shortcutsDisplay.nextFocusIndex(stops.length, at, e.shiftKey);
    if (to !== null) { e.preventDefault(); stops[to].focus(); }
  }
}, true);
// The header changes height or disappears (a resize, focus mode): the sheet follows it while open.
new ResizeObserver(() => { if (shortcutsOpen) placeShortcuts(); }).observe(document.querySelector('header'));

// S2: the first launch after the upgrade has no stored layout at all; it starts
// from this window's old per-window settings so nothing moves under anyone.
function legacyLayout() {
  let legacy = {};
  try { legacy = { sideTab: localStorage.getItem('sideTab'), rosterWidth: localStorage.getItem('rosterWidth') }; } catch {}
  return DTm.unpinAll(DTm.fromV1(DM.fromLegacy(legacy, MODULE_IDS), MODULE_IDS));
}

async function loadLayout() {
  globalLayout = DTm.startLayout(MODULE_IDS);
  const seeded = localStorage.getItem('dockSelection2') !== null;
  selection = readSelection();
  if (!seeded) saveSelection();            // seeded ONCE from L1's, so a later push never brings another window's choices (Dexter F4)
  renderLayout();                          // draw at once; the stored layout may take a moment
  const bridge = window.harness && window.harness.layoutTree;
  if (bridge) {
    bridge.onChange((l) => {
      layoutPushes += 1;
      const incoming = DTm.readStored(l, MODULE_IDS);
      // This window's own save comes back as a push: it is already drawn, and redrawing it would queue a terminal
      // refit for a float's move that never touched the terminal (PR #102 Miguel Y2).
      const same = placementOf(incoming) === placementOf(globalLayout);
      globalLayout = incoming;
      if (!ownLayout && !same) renderLayout();
    });
    let answer = null;
    let v1Answer = null;
    try { answer = await bridge.get(); } catch { /* unreadable: keep */ }
    // The L1 key is read only when there is no tree yet, to migrate from it, and never written by this build.
    if (answer && answer.status === 'missing' && window.harness.layout) {
      try { v1Answer = await window.harness.layout.get(); } catch { /* unreadable: keep */ }
    }
    // Only a MISSING tree is a first launch to migrate and save. Unreadable or
    // corrupt (antivirus holding it) draws the default and saves nothing, so the
    // user's real layout is never overwritten (PR #82 Dexter F3, Miguel I1); their
    // next real change saves as usual.
    const what = window.dockTreeView.afterTreeGet(answer, v1Answer, { v1Bridge: !!window.harness.layout });
    if (what === 'use') { globalLayout = DTm.readStored(answer.layout, MODULE_IDS); layoutLoaded = true; renderLayout(); }
    else if (what === 'migrate-v1') {
      globalLayout = DTm.readStored(v1Answer.layout, MODULE_IDS);
      layoutLoaded = true;
      saveGlobalLayout(globalLayout);
      renderLayout();
    } else if (what === 'migrate-legacy') {
      globalLayout = legacyLayout();
      layoutLoaded = true;
      saveGlobalLayout(globalLayout);
      renderLayout();
    } else flashAttention({ urgent: false, title: 'Couldn\'t read the saved layout; showing the default' });
  }
}

// The host's word on this tab's own layout: in `hello` and on every change. A
// change this window made that the host hasn't echoed yet wins, and is sent
// again (PR #82 Dexter F8; dockEffects.overrideOnHello is the tested rule). A host
// started by an older window may hold an L1 layout: readAny migrates it.
function applyLayoutOverride(incoming) {
  const r = window.dockEffects.overrideOnHello(pendingOverride, incoming);
  if (r.settled) pendingOverride = null;
  ownLayout = r.apply && typeof r.apply === 'object' ? DTm.readStored(r.apply, MODULE_IDS) : null;
  if (r.resend && pendingOverride) {
    try { ws.send(JSON.stringify({ type: 'layout-override', layout: pendingOverride.layout })); } catch { /* next hello */ }
  }
  renderLayout();
}

// verify/probe-dock-tree.js drives and measures the dock through named
// actions, defined only on a page main opened with ?probe=1 (its probe driver
// is running). Answers JSON text.
if (new URLSearchParams(location.search).get('probe') === '1') {
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  // A pointer event as a mouse would make it, for the synthetic drags below: they run the same listeners a real one does.
  const ptr = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  const overlayState = () => ({
    zones: document.querySelectorAll('#dock-overlay .dz').length,
    hot: document.querySelectorAll('#dock-overlay .dz.hot').length,
    dragging: document.body.classList.contains('dock-dragging'),
    ghost: !!document.querySelector('#dock-ghost'),         // made on the fly by the drag, so not a getElementById
  });
  window.__dockProbe = (req) => {
    const a = (req && req.args) || {};
    switch (req && req.action) {
      case 'state': {
        // `focusTerm`: the keyboard goes to the terminal first, as a click on it would, so a real key reaches xterm's handler.
        if (a.focusTerm === true) term.focus();
        const groupInfo = el => ({
          id: el.dataset.group, shape: el.dataset.shape, rect: rectOf(el),
          tabs: [...el.querySelectorAll('.zone-tabs button[data-module]')].map(b => b.dataset.module),
          on: [...el.querySelectorAll('.zone-tabs button.on')].map(b => b.dataset.module),
          panels: [...el.querySelectorAll('.zone-panels > .panel.on')].map(p => p.dataset.panel),
          panelRects: [...el.querySelectorAll('.zone-panels > .panel.on')].map(p => rectOf(p)),
        });
        // Floats hang over the tree, so they are listed apart: the tree's boxes tile #dock, the floats don't.
        const groups = [...document.querySelectorAll('#dock > .dgroup:not(.dfloat)')].map(groupInfo);
        const floats = [...document.querySelectorAll('#dock-floats > .dfloat')].map(el => ({
          ...groupInfo(el), zIndex: Number(el.style.zIndex), display: getComputedStyle(el).display,
          bar: rectOf(el.querySelector('.zone-tabs')), grip: rectOf(el.querySelector('.dfloat-grip')),
        }));
        // The vault's field is tagged the first time it is asked for, so a later state shows whether it is the SAME node.
        const vaultField = document.getElementById('vault-search');
        if (vaultField && !vaultField.__probeTag) vaultField.__probeTag = Math.random().toString(36).slice(2);
        const rails = [...document.querySelectorAll('#dock > .drail')].map(el => ({
          dir: el.dataset.dir, rect: rectOf(el), modules: [...el.querySelectorAll('button')].map(b => b.dataset.module),
          // #85: where every tab is, and whether the rail can scroll to the ones it cannot fit (PR #168 Miguel Y4)
          tabRects: [...el.querySelectorAll('button')].map(b => rectOf(b)), id: el.dataset.rail || null,
          scroll: { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX },
          names: el.dataset.names || null,
          tabTitles: [...el.querySelectorAll('button')].map(b => [b.title, b.getAttribute('aria-label')]),
          // rail tabs as emoji + name: what each says, the name's computed size and whether it sits on one line inside its tab
          faces: [...el.querySelectorAll('button')].map((b) => {
            const icon = b.querySelector('.rail-icon'); const name = b.querySelector('.rail-name');
            const cs = name ? getComputedStyle(name) : null;
            const ics = icon ? getComputedStyle(icon) : null;
            return {
              module: b.dataset.module, label: b.getAttribute('aria-label'), name: name ? name.textContent : null,
              fontPx: cs ? parseFloat(cs.fontSize) : null, writingMode: cs ? cs.writingMode : null, nameRect: name ? rectOf(name) : null,
              nameScrollWidth: name ? name.scrollWidth : null, nameClientWidth: name ? name.clientWidth : null,
              iconRect: icon ? rectOf(icon) : null, iconStroke: ics ? ics.stroke : null, iconStrokeWidth: ics ? parseFloat(ics.strokeWidth) : null,
              iconHidden: icon ? icon.getAttribute('aria-hidden') : null, buttonColor: getComputedStyle(b).color,
            };
          }),
        }));
        const gutters = [...document.querySelectorAll('#dock > .dgutter')].map(el => ({
          path: el.dataset.path, i: Number(el.dataset.i), dir: el.dataset.dir, rect: rectOf(el),
        }));
        // How the floats stack against everything else (PR #102 Y3): the layer's and the drag overlay's z-index, the
        // terminal's isolation, and where the terminal's own overlays are: inside #termwrap, whose context contains them.
        const zOf = id => Number(getComputedStyle(document.getElementById(id)).zIndex);
        const lockEl = document.getElementById('lock-overlay');
        const stack = {
          layerZ: zOf('dock-floats'), overlayZ: zOf('dock-overlay'), termwrapIsolation: getComputedStyle(document.getElementById('termwrap')).isolation,
          lockInTermwrap: !!lockEl && document.getElementById('termwrap').contains(lockEl),
          order: [...document.getElementById('dock').children].map(e => e.id || e.className.split(' ')[0]),
        };
        let proposed = null;
        try { proposed = fit.proposeDimensions() || null; } catch {}
        return JSON.stringify({
          ok: true, layout: placementLayout(), selection, own: ownLayout !== null, shown: [...shownModules], groups, floats, rails, gutters, stack,
          term: { cols: term.cols, rows: term.rows }, fit: proposed, sent: lastSentResize,
          termwrap: rectOf(document.getElementById('termwrap')), dock: rectOf(document.getElementById('dock')),
          termParent: document.getElementById('termwrap').parentNode.id, pushes: layoutPushes,
          header: !!document.querySelector('header') && getComputedStyle(document.querySelector('header')).display !== 'none',
          innerHeight: window.innerHeight, focus: focusOn, overlay: overlayState(), title: document.title,
          vaultNode: vaultField ? vaultField.__probeTag : null,
          // D4: a rail's popover, the keyboard move, the settle class, what a screen reader is told, and what holds focus.
          peek: peek ? peek.module : null,
          railState: railSt,           // #85: the dock rail's hover state
          popover: (() => {
            const pe = document.querySelector('#dock-floats > .dpeek');
            if (!pe) return null;
            return {
              module: pe.dataset.module, rect: rectOf(pe), z: getComputedStyle(pe).zIndex, from: pe.dataset.from || null,
              pin: (() => { const b = pe.querySelector('.dpin'); return b ? { text: b.textContent, pressed: b.getAttribute('aria-pressed') } : null; })(),
              animation: getComputedStyle(pe).animationName, bg: getComputedStyle(pe).backgroundColor, closing: !!pe.dataset.closing,
              // Is the popover what is on top at its own middle (above the terminal, the floats and the rails)?
              hit: (() => { const r = pe.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && !!top.closest && !!top.closest('.dpeek'); })(),
              tabs: [...pe.querySelectorAll('.zone-tabs button[data-module]')].map(b => b.dataset.module),
              on: [...pe.querySelectorAll('.zone-tabs button.on')].map(b => b.dataset.module),
              panels: [...pe.querySelectorAll('.zone-panels > .panel.on')].map(p => p.dataset.panel),
              panelRects: [...pe.querySelectorAll('.zone-panels > .panel.on')].map(p => rectOf(p)),
            };
          })(),
          settling: document.getElementById('dock').classList.contains('settling'),
          groupTransition: (() => { const g = document.querySelector('#dock > .dgroup'); return g ? getComputedStyle(g).transitionDuration : null; })(),
          announce: document.getElementById('dock-announce').textContent,
          kbMove: kbMove ? { id: kbMove.id, target: kbMove.target } : null,
          held: (() => {
            const e = document.activeElement;
            return e && e !== document.body ? { tag: e.tagName, cls: e.className, parent: e.parentNode ? e.parentNode.className : null, module: e.dataset ? e.dataset.module || null : null, role: e.getAttribute('role'), path: e.dataset ? e.dataset.path || null : null, i: e.dataset ? e.dataset.i || null : null } : null;
          })(),
          // Plain <script> files that fail to export break only the real window, never a unit test.
          exports: { fit: typeof (window.dockTree || {}).fit, applyBoxes: typeof (window.dockTreeView || {}).applyBoxes, zonesAt: typeof (window.dockDrag || {}).zonesAt },
        });
      }
      case 'boxes': return JSON.stringify({ ok: true, boxes: lastPlan ? lastPlan.boxes : [], splits: lastPlan ? lastPlan.splits : [] });
      // A small window, without an OS window to resize: #dock is held at `width` x `height` (either may be left
      // out, and none puts it back to filling its row). The tree is fitted to it exactly as to a real window.
      case 'squeeze': {
        const dock = document.getElementById('dock');
        dock.style.flex = a.width ? 'none' : '';
        dock.style.width = a.width ? `${a.width}px` : '';
        dock.style.height = a.height ? `${a.height}px` : '';
        dock.style.alignSelf = a.height ? 'flex-start' : '';
        renderLayout();
        break;
      }
      // The placement, read or replaced as a whole (`layout`: anything; it is normalized).
      case 'layout':
        if (a.layout !== undefined) commitPlacement(a.layout, { justThisTab: a.justThisTab === true });
        return JSON.stringify({ ok: true, layout: placementLayout() });
      case 'dock': commitPlacement(DTm.dock(settledLayout(), a.id, a.target), { justThisTab: a.justThisTab === true, select: String(a.id) }); break;
      case 'hide': commitPlacement(DTm.hide(settledLayout(), a.id), { justThisTab: a.justThisTab === true }); break;
      case 'show': commitPlacement(DTm.show(settledLayout(), a.id), { justThisTab: a.justThisTab === true, select: String(a.id) }); break;
      // Kept for the other probes (git, vault reconnect), which move a module to an edge or hide it by name.
      case 'move': commitPlacement(a.target === 'hide' ? DTm.hide(settledLayout(), a.id) : DTm.dock(settledLayout(), a.id, { edge: a.target }), { justThisTab: a.justThisTab === true, select: String(a.id) }); break;
      case 'select': selectModule(a.id); break;
      case 'focusMode': applyFocusMode(a.on === true); break;      // probe: the real focus-mode path (the rails are display:none, then drawn again)
      case 'leanClass': document.body.classList.toggle('lean', a.on === true); renderLayout(); break;      // probe: lean's display:none on the rails, and its resume draw
      case 'uiFont': takeFontSettings({ ...(fontSettings || {}), uiFont: a.name }); break;      // probe: a different Interface font, not saved
      case 'foldAll': case 'toggleAll': toggleAllZones(); break;
      case 'dropOwn': dropOwnLayout({ makeGlobal: a.makeGlobal === true }); break;
      // A tab dragged to `to` ({ x, y } relative to #dock) by synthetic pointer events: down on the tab, two moves,
      // then what the overlay shows MID-drag, then the release (or Escape when `escape`).
      case 'drag': {
        const btn = document.querySelector(`.zone-tabs button[data-module="${CSS.escape(String(a.id))}"]`);
        if (!btn) return JSON.stringify({ ok: false, error: 'no such tab' });
        const from = btn.getBoundingClientRect();
        const d = document.getElementById('dock').getBoundingClientRect();
        const x0 = from.left + from.width / 2;
        const y0 = from.top + from.height / 2;
        const x1 = d.left + a.to.x;
        const y1 = d.top + a.to.y;
        btn.dispatchEvent(ptr('pointerdown', x0, y0));
        window.dispatchEvent(ptr('pointermove', x0 + 8, y0 + 8));
        window.dispatchEvent(ptr('pointermove', x1, y1));
        const during = overlayState();
        const draws0 = tabDragDraws;
        for (let k = 0; k < 3; k++) window.dispatchEvent(ptr('pointermove', x1, y1));   // the pointer has not moved to another zone
        during.idleRedraws = tabDragDraws - draws0;
        if (a.escape) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        else window.dispatchEvent(ptr('pointerup', x1, y1));
        window.dispatchEvent(ptr('pointerup', x1, y1));       // a no-op when the drag already ended: nothing stays pressed
        return JSON.stringify({ ok: true, during, after: overlayState() });
      }
      // A press and release on a tab without moving: it must select, not drag.
      case 'tabClick': {
        const btn = document.querySelector(`.zone-tabs button[data-module="${CSS.escape(String(a.id))}"]`);
        if (!btn) return JSON.stringify({ ok: false, error: 'no such tab' });
        const r = btn.getBoundingClientRect();
        btn.dispatchEvent(ptr('pointerdown', r.left + 3, r.top + 3));
        window.dispatchEvent(ptr('pointerup', r.left + 3, r.top + 3));
        btn.click();
        return JSON.stringify({ ok: true, after: overlayState() });
      }
      // A divider dragged by `delta` px (synthetic pointer events on the bar), in two steps; `hold` leaves the bar pressed.
      case 'gutter': {
        const g = [...document.querySelectorAll('#dock > .dgutter')].find(el => el.dataset.path === String(a.path) && Number(el.dataset.i) === a.i);
        if (!g) return JSON.stringify({ ok: false, error: 'no such divider' });
        const r = g.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const dx = g.dataset.dir === 'row' ? a.delta : 0;
        const dy = g.dataset.dir === 'col' ? a.delta : 0;
        g.dispatchEvent(ptr('pointerdown', x0, y0));
        window.dispatchEvent(ptr('pointermove', x0 + dx / 2, y0 + dy / 2));
        window.dispatchEvent(ptr('pointermove', x0 + dx, y0 + dy));
        window.dispatchEvent(ptr('pointerup', x0 + dx, y0 + dy));
        return JSON.stringify({ ok: true });
      }
      // PR #100 Miguel I2: a drag whose release never comes (no pointerup is sent). `kind` is 'tab' (`id`) or
      // 'gutter' (`path`, `i`, `delta`); `how` is 'nobutton' (a move arrives with no button down) or 'blur'.
      case 'abortedDrag': {
        const gut = a.kind === 'gutter';
        const el = gut
          ? [...document.querySelectorAll('#dock > .dgutter')].find(e2 => e2.dataset.path === String(a.path) && Number(e2.dataset.i) === a.i)
          : document.querySelector(`.zone-tabs button[data-module="${CSS.escape(String(a.id))}"]`);
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        const r = el.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const step = gut ? (el.dataset.dir === 'row' ? [a.delta, 0] : [0, a.delta]) : [30, 30];
        const snap = () => ({ ...overlayState(), divider: dividerDrag !== null, drawn: dragLayout !== null });
        el.dispatchEvent(ptr('pointerdown', x0, y0));
        window.dispatchEvent(ptr('pointermove', x0 + step[0] / 2, y0 + step[1] / 2));
        window.dispatchEvent(ptr('pointermove', x0 + step[0], y0 + step[1]));
        const during = snap();
        if (a.how === 'blur') window.dispatchEvent(new Event('blur'));
        else window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x0 + step[0], clientY: y0 + step[1], button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        return JSON.stringify({ ok: true, during, after: snap() });
      }
      // PR #100 Dexter F6: a divider is pressed and moved, ANOTHER window's layout arrives (`pushed`, the same
      // path as the main-process push), then the divider is released.
      case 'gutterRace': {
        const g = [...document.querySelectorAll('#dock > .dgutter')].find(el => el.dataset.path === String(a.path) && Number(el.dataset.i) === a.i);
        if (!g) return JSON.stringify({ ok: false, error: 'no such divider' });
        const r = g.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        const dx = g.dataset.dir === 'row' ? a.delta : 0;
        const dy = g.dataset.dir === 'col' ? a.delta : 0;
        g.dispatchEvent(ptr('pointerdown', x0, y0));
        window.dispatchEvent(ptr('pointermove', x0 + dx, y0 + dy));
        globalLayout = DTm.normalize(a.pushed, MODULE_IDS);
        window.dispatchEvent(ptr('pointerup', x0 + dx, y0 + dy));
        return JSON.stringify({ ok: true });
      }
      // D2: a float moved by its bar's empty part (`what: 'bar'`), by its left handle (`what: 'handle'`) or resized by
      // its grip (`what: 'grip'`) by `dx`, `dy` px, as synthetic pointer events: down, `moves` moves in ONE frame
      // (default 2), a frame to draw them, the release. `how` instead of a release: 'nobutton' (a move with no
      // button down), 'blur', 'jitter' (a 1 px move and back, then the release: nothing was chosen) or 'return'
      // (dragged by `dx`, `dy`, brought back to where it started, released there), as
      // `abortedDrag` does for the others. Reports how many times the drag drew and how many resizes reached the pty.
      case 'floatDrag': return (async () => {
        const el = document.querySelector(`#dock-floats > .dfloat[data-group="${CSS.escape(String(a.id))}"]`);
        if (!el) return JSON.stringify({ ok: false, error: 'no such float' });
        const target = a.what === 'grip' ? el.querySelector('.dfloat-grip') : el.querySelector('.zone-tabs');
        const r = target.getBoundingClientRect();
        // The bar's empty part is its right end; the handle is the 18 px at its left; the grip is small, so its middle.
        const x0 = a.what === 'grip' ? r.left + r.width / 2 : (a.what === 'handle' ? r.left + 8 : r.right - 6);
        const y0 = r.top + r.height / 2;
        const hit = document.elementFromPoint(x0, y0) === target;   // a real hit test: is what is under the pointer the bar (or the grip)?
        const frame = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        const snap = () => ({ drag: floatDrag !== null, drawn: dragLayout !== null, selecting: document.body.classList.contains('dock-dragging') });
        const draws0 = floatDragDraws;
        const sends0 = resizeSends;
        const dx = a.how === 'jitter' ? 1 : a.dx;
        const dy = a.how === 'jitter' ? 0 : a.dy;
        target.dispatchEvent(ptr('pointerdown', x0, y0));
        const moves = Number.isInteger(a.moves) && a.moves > 0 ? a.moves : 2;
        for (let k = 1; k <= moves; k++) window.dispatchEvent(ptr('pointermove', x0 + dx * k / moves, y0 + dy * k / moves));
        const back = a.how === 'jitter' || a.how === 'return';    // 'return': dragged away, then back to where it started
        if (back) window.dispatchEvent(ptr('pointermove', x0, y0));
        const sync = snap();                                      // before the frame: nothing is drawn yet
        await frame();
        const during = { ...snap(), draws: floatDragDraws - draws0 };
        if (a.how === 'blur') window.dispatchEvent(new Event('blur'));
        else if (a.how === 'nobutton') window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x0 + dx, clientY: y0 + dy, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        else window.dispatchEvent(ptr('pointerup', back ? x0 : x0 + dx, back ? y0 : y0 + dy));
        await new Promise(res => setTimeout(res, 60));            // a queued fit, if the release asked for one, has run
        return JSON.stringify({ ok: true, hit, sync, during, after: snap(), resizes: resizeSends - sends0 });
      })();
      // D2: a press and release on a float's body (or, with `bar`, on its bar's empty part): it is raised.
      case 'floatPress': {
        const el = document.querySelector(`#dock-floats > .dfloat[data-group="${CSS.escape(String(a.id))}"]`);
        if (!el) return JSON.stringify({ ok: false, error: 'no such float' });
        const target = a.bar ? el.querySelector('.zone-tabs') : el.querySelector('.zone-panels');
        const r = target.getBoundingClientRect();
        const x0 = a.bar ? r.right - 6 : r.left + r.width / 2;
        const y0 = r.top + r.height / 2;
        target.dispatchEvent(ptr('pointerdown', x0, y0));
        window.dispatchEvent(ptr('pointerup', x0, y0));
        return JSON.stringify({ ok: true });
      }
      // The menus, opened as a click would, so a screenshot can look at them.
      case 'openMenu':
        if (a.which === 'move') openMoveMenu(String(a.id), 300, 200); else openLayoutMenu();
        return JSON.stringify({ ok: true,
          items: [...layoutMenu.querySelectorAll('button')].map(b => ({ text: b.textContent, disabled: b.disabled, on: b.classList.contains('on') })),
          rows: [...layoutMenu.querySelectorAll('label')].map((l) => {
            const input = l.querySelector('input');
            return { text: l.textContent, id: (input && input.dataset.module) || null, checked: !!(input && input.checked) };
          }) });
      // A panel's check in the open Window menu, clicked as a pointer would.
      case 'menuTick': {
        const box = layoutMenu.querySelector(`input[data-module="${CSS.escape(String(a.id))}"]`);
        if (!box) return JSON.stringify({ ok: false, error: 'no such row' });
        box.click();
        return JSON.stringify({ ok: true });
      }
      case 'menuButton': {
        const b = [...layoutMenu.querySelectorAll('button')].find(x => x.textContent === a.text);
        if (!b) return JSON.stringify({ ok: false, error: 'no such button' });
        b.click();
        return JSON.stringify({ ok: true });
      }
      case 'closeMenu': closeLayoutMenu(); break;
      // D4 (verify/probe-dock-tree.js): a rail's button pressed as a pointer would (`byKey`: as Enter does, detail 0), a group
      // collapsed through the page's own function, a key sent to what holds focus (or to `selector`), a double-click, a
      // divider focused, and the tab's menu opened by the context-menu event a focused tab gets from Shift+F10.
      case 'railClick': {
        const b = document.querySelector(`.drail button[data-module="${CSS.escape(String(a.id))}"]`);
        if (!b) return JSON.stringify({ ok: false, error: 'no such rail button' });
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: a.byKey === true ? 0 : 1 }));
        return JSON.stringify({ ok: true });
      }
      // #85 (verify/probe-dock-autohide.js): the pointer moved onto a dock-rail tab (`module`), onto the open panel (`on: 'panel'`) or
      // onto the terminal (`on: 'terminal'`), as pointerover events a mouse makes; and the Pin / Pinned button pressed.
      case 'hover': {
        const el = a.module ? document.querySelector(`.drail[data-rail="dock"] button[data-module="${CSS.escape(String(a.module))}"]`)
          : a.on === 'panel' ? document.querySelector('.dpeek') : document.getElementById('termwrap');
        if (!el) return JSON.stringify({ ok: false, error: 'nothing to hover' });
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
        return JSON.stringify({ ok: true });
      }
      case 'pinClick': {
        const b = a.on === 'panel' ? document.querySelector('.dpeek .dpin') : document.querySelector(`.dgroup .dpin[data-pin="${CSS.escape(String(a.module))}"]`);
        if (!b) return JSON.stringify({ ok: false, error: 'no Pin button' });
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        return JSON.stringify({ ok: true });
      }
      // #85: the tab menu's "Just this tab" box ticked as a pointer would, and the dock rail scrolled to its end.
      case 'menuCheck': {
        const box = [...layoutMenu.querySelectorAll('label')].find(l => /Just this tab/.test(l.textContent));
        const input = box && box.querySelector('input');
        if (!input || input.disabled) return JSON.stringify({ ok: false, error: 'no usable Just this tab box' });
        if (!input.checked) input.click();
        return JSON.stringify({ ok: true });
      }
      case 'railScroll': {
        const el = document.querySelector('#dock > .drail[data-rail="dock"]');
        if (!el) return JSON.stringify({ ok: false, error: 'no dock rail' });
        el.scrollTop = a.to === 'end' ? el.scrollHeight : 0;
        return JSON.stringify({ ok: true });
      }
      case 'collapse': toggleGroupCollapse(String(a.id)); break;
      // A drop as the person makes it, with the motion read at that moment: whether the dock settles, over what, and that it ends.
      case 'settleProbe': return (async () => {
        const dockEl = document.getElementById('dock');
        window.matchMedia = q => ({ matches: a.reduced === true && /prefers-reduced-motion/.test(String(q)), media: String(q), addEventListener() {}, removeEventListener() {} });
        commitPlacement(DTm.dock(settledLayout(), a.id, a.target), { select: String(a.id) });
        const dur = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el).transitionDuration : null; };
        const during = { settling: dockEl.classList.contains('settling'), group: dur('#dock > .dgroup'), gutter: dur('#dock > .dgutter'), termwrap: dur('#termwrap') };
        await new Promise(r => setTimeout(r, 400));
        return JSON.stringify({ ok: true, during, after: { settling: dockEl.classList.contains('settling'), group: dur('#dock > .dgroup') } });
      })();
      // Reduced motion, pretended: the page asks matchMedia at the moment of a drop, so this is what it will read.
      case 'reducedMotion': {
        window.matchMedia = q => ({ matches: a.on === true && /prefers-reduced-motion/.test(String(q)), media: String(q), addEventListener() {}, removeEventListener() {} });
        return JSON.stringify({ ok: true });
      }
      case 'key': {
        const el = a.selector ? document.querySelector(a.selector) : (document.activeElement || document.body);
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        const ev = new KeyboardEvent('keydown', { key: a.key, shiftKey: a.shift === true, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return JSON.stringify({ ok: true, prevented: ev.defaultPrevented });
      }
      case 'focus': {
        const el = document.querySelector(String(a.selector));
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        el.focus();
        return JSON.stringify({ ok: true });
      }
      case 'dblclick': {
        const el = document.querySelector(String(a.selector));
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return JSON.stringify({ ok: true });
      }
      case 'outsidePress': {
        const el = document.querySelector(String(a.selector));
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        el.dispatchEvent(ptr('pointerdown', 5, 5));
        return JSON.stringify({ ok: true });
      }
      case 'tabMenu': {
        const b = document.querySelector(`.zone-tabs button[data-module="${CSS.escape(String(a.id))}"], .drail button[data-module="${CSS.escape(String(a.id))}"]`);
        if (!b) return JSON.stringify({ ok: false, error: 'no such tab' });
        const r = b.getBoundingClientRect();
        b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.bottom }));
        return JSON.stringify({ ok: true, items: [...layoutMenu.querySelectorAll('button')].map(x => x.textContent), held: document.activeElement ? document.activeElement.textContent : null });
      }
      // Layout presets (D3, verify/probe-dock-tree.js): what the list and the open menu's Presets section hold ...
      case 'presets':
        return JSON.stringify({
          ok: true, exported: typeof (window.dockPresets || {}).thumbBoxes, loaded: presetsState.loaded, usable: presetsState.usable,
          names: presetsState.list.map(p => p.name), mode: presetUi.mode, menuOpen: !layoutMenu.hidden, pushes: presetPushes,
          rows: [...layoutMenu.querySelectorAll('.lm-preset')].map(r => ({
            name: r.dataset.preset, boxes: r.querySelectorAll('.lm-thumb i').length, unknown: !!r.querySelector('.lm-thumb.unknown'),
            labels: [...r.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent),
            focusable: [...r.querySelectorAll('button')].every(b => b.tabIndex >= 0 && !b.disabled),
          })),
          notes: [...layoutMenu.querySelectorAll('.lm-note')].map(n => n.textContent),
          saveOpen: !!layoutMenu.querySelector('[data-preset-act="save-open"]'),
          fields: [...layoutMenu.querySelectorAll('input[data-preset-field]')].map(i => ({ action: i.dataset.presetField, value: i.value })),
          asking: [...layoutMenu.querySelectorAll('.lm-row .lm-name')].map(s => s.textContent),
          kept: presetsState.kept || 0, busy: presetsState.busy === true,
          // where the menu and the controls under the list sit, against the window (B1: it never grows past it)
          fit: (() => {
            const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
            const list = layoutMenu.querySelector('.lm-presets-list');
            const button = (text) => [...layoutMenu.querySelectorAll('button')].find(b => b.textContent.trim() === text);
            const just = [...layoutMenu.querySelectorAll('label')].find(l => l.textContent.includes('Just this tab'));
            return {
              windowHeight: window.innerHeight, menu: box(layoutMenu),
              list: list ? { ...box(list), scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
              save: box(layoutMenu.querySelector('[data-preset-act="save-open"]')), reset: box(button('Reset layout')), just: box(just),
              resetToGlobal: box(button('Reset to global')), makeGlobal: box(button('Make this global')), active: box(document.activeElement),
            };
          })(),
          // where keyboard focus is, as the probe can read it: a preset's control, a field, the Window button or the page
          active: (() => {
            const a = document.activeElement;
            if (!a || a === document.body) return { body: true };
            const row = a.closest ? a.closest('.lm-preset') : null;
            return {
              tag: a.tagName, id: a.id || null, act: (a.dataset && a.dataset.presetAct) || null, field: (a.dataset && a.dataset.presetField) || null,
              preset: row ? row.dataset.preset : null, label: a.getAttribute ? a.getAttribute('aria-label') : null,
              selection: a.tagName === 'INPUT' && a.type === 'text' ? [a.selectionStart, a.selectionEnd, a.value.length] : null,
            };
          })(),
        });
      // ... and a click on, or typing into, an element of the open menu (a CSS selector), as a pointer and keys would.
      case 'menuClick': {
        const el = layoutMenu.querySelector(String(a.selector));
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        el.click();
        return JSON.stringify({ ok: true });
      }
      case 'menuType': {
        const el = layoutMenu.querySelector(String(a.selector));
        if (!el) return JSON.stringify({ ok: false, error: 'no such element' });
        if (typeof a.text === 'string') { el.value = a.text; el.dispatchEvent(new Event('input', { bubbles: true })); }
        if (typeof a.key === 'string') el.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true, cancelable: true }));
        return JSON.stringify({ ok: true });
      }
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
            ? (document.activeElement.getAttribute('data-name')
              || (document.activeElement.classList && document.activeElement.classList.contains('git-act')
                ? (document.activeElement.dataset.act === 'jump' ? 'jump' : 'act:' + document.activeElement.dataset.act) : null)) : null,
          // Enhancement #46: the drawer, its layout, its actions (enabled or not, and why), its answer
          drawerShown: !!document.querySelector('.git-drawer') && !document.querySelector('.git-drawer').hidden,
          drawerText: (document.querySelector('.git-drawer') || {}).textContent || '',
          drawerRect: document.querySelector('.git-drawer') ? rectOf(document.querySelector('.git-drawer')) : null,
          beside: document.getElementById('git-dial').classList.contains('beside'),
          acts: [...document.querySelectorAll('.git-drawer .git-act')].map(b => ({ act: b.dataset.act, label: b.textContent,
            disabled: b.getAttribute('aria-disabled') === 'true', title: b.title, described: b.getAttribute('aria-describedby'),
            why: ((b.parentElement && b.parentElement.querySelector('.git-act-why')) || {}).textContent || null })),
          reviews: [...document.querySelectorAll('.git-drawer .git-drawer-reviews > *')].map(x => x.textContent),
          people: [...document.querySelectorAll('.git-drawer .git-drawer-who .p')].map(x => x.textContent),
          said: (document.querySelector('#git-body .git-said') || {}).textContent || '',
          saidNodes: document.querySelectorAll('#git-body [role="status"]').length,
          sparkEls: body.querySelectorAll('.git-spark').length,
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
      // The Graph view (verify/probe-git-graph.js): read it, switch to it, click a commit, press a key, redraw it.
      case 'ggState': {
        const body = document.getElementById('git-body');
        const g = document.getElementById('git-graph');
        const st = g.ggState || {};
        const scroll = g.querySelector('.gg-scroll');
        const detail = g.querySelector('.gg-detail');
        const shown = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
        return JSON.stringify({
          ok: true, view: gitView,
          graphShown: shown(g), dialShown: shown(document.getElementById('git-dial')),
          pressed: [...document.querySelectorAll('#git-view button')].map(b => b.dataset.view + ':' + b.getAttribute('aria-pressed')),
          status: document.getElementById('git-graph-status').textContent,
          rows: [...g.querySelectorAll('.gg-row')].map(r => ({ hash: r.dataset.hash, msg: r.querySelector('.gg-msg').textContent,
            refs: [...r.querySelectorAll('.gg-ref')].map(x => x.textContent), sel: r.classList.contains('sel'), rect: rectOf(r) })),
          dots: [...g.querySelectorAll('.gg-dot')].map(d => ({ cx: Number(d.getAttribute('cx')), cy: Number(d.getAttribute('cy')),
            cls: d.getAttribute('class') })),
          edges: g.querySelectorAll('.gg-edge').length,
          curves: [...g.querySelectorAll('.gg-edge')].filter(p => p.getAttribute('d').includes('C')).length,
          svg: g.querySelector('.gg-svg') ? rectOf(g.querySelector('.gg-svg')) : null, panel: rectOf(body),
          scroll: scroll ? { top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight, rect: rectOf(scroll) } : null,
          detail: shown(detail) ? { title: detail.querySelector('.gg-detail-title').textContent, meta: detail.querySelector('.gg-detail-meta').textContent,
            rect: rectOf(detail),
            acts: [...detail.querySelectorAll('.git-act')].map(b => ({ act: b.dataset.act, label: b.textContent, disabled: b.getAttribute('aria-disabled') === 'true',
              why: ((b.parentElement && b.parentElement.querySelector('.git-act-why')) || {}).textContent || null })) } : null,
          said: (g.querySelector('.gg-said') || {}).textContent || '',
          renders: st.renders || 0, wired: st.wired || 0,
          saved: window.gitGraphDisplay.readView(storageOrNull(), gitViewProject),
          focused: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.hash || null : null,
          lineHeightOk: [...g.querySelectorAll('.gg-row')].every(r => Math.round(r.getBoundingClientRect().height) === window.gitGraphDisplay.ROW_H),
        });
      }
      case 'ggView': setGitView(String(a.view), { save: a.save !== false }); break;
      case 'ggClick': {
        const r = [...document.querySelectorAll('#git-graph .gg-row')].find(x => x.dataset.hash === a.hash || x.dataset.hash.startsWith(String(a.hash)));
        if (!r) return JSON.stringify({ ok: false, error: 'no such commit' });
        r.focus();       // a real click on a row focuses it
        r.click();
        break;
      }
      case 'ggAct': {
        const btn = document.querySelector('#git-graph .gg-detail .git-act[data-act="' + String(a.act) + '"]');
        if (!btn) return JSON.stringify({ ok: false, error: 'no action ' + a.act });
        btn.click();
        return JSON.stringify({ ok: true });
      }
      case 'ggKey': {
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true, cancelable: true }));
        break;
      }
      case 'ggRerender': renderGitGraph(); break;
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
        const drawer = document.querySelector('.git-drawer');
        const jumpBtn = drawer && drawer.querySelector('.git-act[data-act="jump"]');
        return JSON.stringify({ ok: true, hidden: card.hidden, text: card.textContent, card: rectOf(card),
          panel: rectOf(document.getElementById('git-body')),
          drawerShown: !!drawer && !drawer.hidden, drawerText: drawer ? drawer.textContent : '',
          jump: !!jumpBtn && jumpBtn.getAttribute('aria-disabled') === 'false' });
      }
      case 'gitJump': {
        const btn = document.querySelector('.git-drawer .git-act[data-act="jump"]');
        if (!btn) return JSON.stringify({ ok: false, error: 'no jump button' });
        btn.click();
        return JSON.stringify({ ok: true });
      }
      // a drawer action, clicked as a pointer would (a disabled one does nothing, and says why beside it)
      case 'gitAct': {
        const btn = document.querySelector('.git-drawer .git-act[data-act="' + String(a.act) + '"]');
        if (!btn) return JSON.stringify({ ok: false, error: 'no action ' + a.act });
        // `times`: a double click (or a held Enter's repeats), back to back in one task (PR #93 F4)
        const times = Number.isInteger(a.times) && a.times > 1 && a.times <= 3 ? a.times : 1;
        for (let i = 0; i < times; i++) btn.click();
        return JSON.stringify({ ok: true });
      }
      // the swing's state; `pointer` puts the pointer over the dial ('in') or takes it away ('out')
      case 'gitMotion': {
        const dial = document.getElementById('git-dial');
        if (a.pointer === 'in') dial.dispatchEvent(new Event('pointerenter'));
        if (a.pointer === 'out') dial.dispatchEvent(new Event('pointerleave'));
        return JSON.stringify({ ok: true, ...window.gitRingsDisplay.motionState(dial) });
      }
      // what the shell says of each worktree's tab (asked now, not at the next poll)
      case 'gitTabs': return requestGitTabs().then(() => JSON.stringify({ ok: true, tabs: lastGitTabs }));
      // this tab's own terminal screen: what its session's pty has shown
      case 'gitScreen': return JSON.stringify({ ok: true, text: screenLines().join('\n') });
      // docs drift (verify/probe-docs-drift.js): the list as painted, and a click on a note's Dismiss button
      case 'driftState': {
        const el = document.getElementById('drift-list');
        const box = el.getBoundingClientRect();
        return JSON.stringify({
          ok: true, hidden: el.hidden, text: el.textContent, html: el.innerHTML, shown: box.width > 0 && box.height > 0,
          rows: [...el.querySelectorAll('.drift-row')].map(r => ({ doc: r.querySelector('.drift-doc b').textContent, sentence: r.querySelector('.drift-sentence').textContent, why: r.querySelector('.drift-why').textContent, meta: r.querySelector('.drift-meta').textContent })),
          note: (el.querySelector('.drift-note') || {}).textContent || null,
          label: (el.querySelector('.drift-label') || {}).textContent || null,
          color: getComputedStyle(el).color, background: getComputedStyle(document.getElementById('git-body')).backgroundColor,
        });
      }
      case 'driftDismiss': {
        const btn = document.querySelector('#drift-list [data-drift-dismiss]');
        if (!btn) return JSON.stringify({ ok: false, error: 'no note to dismiss' });
        btn.click();
        return JSON.stringify({ ok: true });
      }
      // backlog #44 + #47 (verify/probe-worktree-occupancy.js): the banner, the confirm and the card lines as
      // painted; a keystroke through xterm's own input path (term.input fires onData as typing does); a click on
      // one of the page's occupancy controls; and the session's turn, as the host's `turn` message would set it.
      case 'occState': return JSON.stringify({
        ok: true,
        bar: barState(),
        confirm: {
          hidden: occupancyEls.confirm.hidden, warn: occupancyEls.confirm.classList.contains('warn'),
          text: document.getElementById('occupancy-confirm-text').textContent,
        },
        here: occupancy.here.length, launched: occupancy.launched.length,
        where: [...document.querySelectorAll('.agent-where')].map(b => ({ agent: b.closest('.agent').dataset.agent, text: b.textContent, title: b.title })),
      });
      case 'occKey':
        if (typeof a.data !== 'string' || !a.data || a.data.length > 200) return JSON.stringify({ ok: false, error: 'occKey needs text' });
        term.input(a.data, true);
        return JSON.stringify({ ok: true });
      case 'occClick': {
        const el = { type: occupancyEls.confirm.querySelector('#occupancy-type'), wait: occupancyEls.confirm.querySelector('#occupancy-wait'),
          jump: barEls.chips.querySelector('button.bar-chip'), where: document.querySelector('.agent-where') }[a.target];
        const hiddenAnswer = (a.target === 'type' || a.target === 'wait') && occupancyEls.confirm.hidden;
        if (!el || el.hidden || hiddenAnswer) return JSON.stringify({ ok: false, error: `nothing to click for ${a.target}` });
        el.click();
        return JSON.stringify({ ok: true });
      }
      case 'occTurn':
        sessionTurn = ['idle', 'turn', 'prompt'].includes(a.turn) ? a.turn : null;
        paintBar();
        reportTabStatus();
        return JSON.stringify({ ok: true, turn: sessionTurn });
      // backlog #49 + #52 (verify/probe-terminal-bar.js): the bar as painted and the buffer it reads; a scroll of the
      // terminal (which goes through xterm's own onScroll, as a wheel does); a click on the prompt part or a chip.
      case 'barState': return JSON.stringify({ ok: true, ...barState() });
      case 'barScroll': {
        if (a.to === 'top') term.scrollToTop();
        else if (a.to === 'bottom') term.scrollToBottom();
        else if (Number.isInteger(a.to) && a.to >= 0 && a.to < 1e6) term.scrollToLine(a.to);
        else return JSON.stringify({ ok: false, error: 'barScroll needs top, bottom or a line number' });
        return JSON.stringify({ ok: true, viewportY: term.buffer.active.viewportY });
      }
      // What /clear sends: the real escape through xterm's own parser, answered once it has been parsed
      case 'barClear': return new Promise((resolve) => {
        term.write('\x1b[3J', () => resolve(JSON.stringify({ ok: true, epoch: bar.epoch })));
      });
      // a light or dark look, as applyTheme would set the chrome variables (the chips must read under both)
      case 'barLook': {
        const looks = { light: { '--bg': '#f4f1ea', '--chrome': '#ece8de', '--border': '#cfc8b8', '--text': '#1d1b16', '--dim': '#6b665a' },
          dark: { '--bg': '#11131a', '--chrome': '#171a23', '--border': '#262b38', '--text': '#c7cede', '--dim': '#6d7689' } };
        const look = looks[a.mode];
        if (!look) return JSON.stringify({ ok: false, error: 'barLook needs light or dark' });
        for (const [k, v] of Object.entries(look)) document.documentElement.style.setProperty(k, v);
        paintBar();
        return JSON.stringify({ ok: true });
      }
      // a selection in the whole-prompt view (Y1: it must survive a repaint that changes nothing)
      case 'barSelection': {
        if (a.select) {
          const range = document.createRange();
          range.selectNodeContents(barEls.full);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return JSON.stringify({ ok: true, text: String(window.getSelection()) });
      }
      case 'barClick': {
        const el = { prompt: barEls.prompt, summary: barEls.summary, bedtime: barEls.chips.querySelector('.bar-chip.bedtime'), occupancy: barEls.chips.querySelector('.bar-chip.occupancy') }[a.target];
        if (!el || el.hidden) return JSON.stringify({ ok: false, error: `nothing to click for ${a.target}` });
        el.focus();
        el.click();
        return JSON.stringify({ ok: true });
      }
      // text typed into THIS tab's own session, as a keyboard would (PR #93: the probe starts its stand-in
      // CLI box with it). Bounded, and only ever this tab's own socket.
      // the repo browser (verify/probe-repo-browser.js): named sub-actions of the Files tab and the reader
      case 'repoProbe': {
        const r = repoBrowser.probe(a.what, a);
        return r && typeof r.then === 'function' ? r.then(x => JSON.stringify(x)) : JSON.stringify(r);
      }
      case 'gitTermInput': {
        if (typeof a.data !== 'string' || !a.data || a.data.length > 2000) return JSON.stringify({ ok: false, error: 'gitTermInput needs text' });
        send(JSON.stringify({ type: 'input', data: a.data }));
        return JSON.stringify({ ok: true });
      }
      // BACKLOG #119 A7 (verify/probe-schedules.js): the Schedules panel as drawn, and a click on a row as a pointer makes it.
      case 'schedulesState': {
        const root = document.getElementById('schedules-root');
        const q = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent : null; };
        return JSON.stringify({
          ok: true,
          scope: typeof window.schedulesDisplay === 'object' && typeof window.schedulesDisplay.html === 'function',
          shown: document.querySelector('.panel[data-panel="schedules"]').classList.contains('on'),
          heads: [...root.querySelectorAll('.sched-head')].map(h => h.textContent),
          groups: [...root.querySelectorAll('.sched-group')].map(g => ({
            id: g.dataset.schedGroup,
            rows: [...g.querySelectorAll('.sched-btn')].map(b => ({
              id: b.dataset.schedId, key: b.dataset.schedKey, cwd: b.dataset.schedCwd || null, when: q(b, '.sched-when'), next: q(b, '.sched-next'), kind: q(b, '.sched-chip'),
              what: q(b, '.sched-what'), session: q(b, '.sched-session'), reason: q(b, '.sched-reason'), detail: q(b, '.sched-detail'),
              gone: q(b, '.sched-gone'), dimmed: b.parentElement.classList.contains('sched-ended'), title: b.title, disabled: b.disabled,
            })),
          })),
          empty: !!root.querySelector('.sched-empty'),
          foot: q(root, '.sched-foot'),
          link: (root.querySelector('[data-sched-link]') || { dataset: {} }).dataset.schedLink || null,
          badge: [...document.querySelectorAll('button[data-module="schedules"]')].map(b => b.dataset.badge || null),
          nextHour: window.schedulesDisplay.badge(schedState),
        });
      }
      case 'schedulesClick': {
        const b = [...document.querySelectorAll('#schedules-root .sched-btn')].find(x => x.dataset.schedId === a.id && (a.key === undefined || x.dataset.schedKey === a.key));
        if (!b || b.disabled) return JSON.stringify({ ok: false, error: 'no clickable schedule row ' + JSON.stringify(a) });
        b.click();
        return JSON.stringify({ ok: true });
      }
      // backlog #51 (verify/probe-wand.js): read the wand and operate its controls as a pointer would.
      case 'wandState': {
        const root = document.getElementById('wand-root');
        const q = (s) => root.querySelector(s);
        const ed = q('.wand-editor');
        return JSON.stringify({
          ok: true,
          scope: typeof window.wandDisplay === 'object' && typeof window.wandDisplay.view === 'function',
          shown: document.querySelector('.panel[data-panel="wand"]').classList.contains('on'),
          text: root.textContent,
          // #61: `emoji` is the emoji span alone (the name now sits under it); `name` is the skill name span, and
          // nameBelow says it is drawn under the emoji (its top at or past the emoji's bottom) and ellipsised.
          turn: sessionTurn,
          buttons: [...root.querySelectorAll('.wand-btn[data-wand-id]')].map(b => {
            const em = b.querySelector('.wand-emoji');
            const nm = b.querySelector('.wand-name');
            const er = em ? em.getBoundingClientRect() : null;
            const nr = nm ? nm.getBoundingClientRect() : null;
            return { id: b.dataset.wandId, emoji: em ? em.textContent : b.textContent, name: nm ? nm.textContent : null,
              nameBelow: !!(er && nr && nr.top >= er.bottom - 1 && nr.width > 0),
              nameEllipsis: nm ? getComputedStyle(nm).textOverflow === 'ellipsis' : false,
              label: b.getAttribute('aria-label'), dim: b.classList.contains('dim'), flash: b.classList.contains('flash'),
              title: b.title, draggable: b.draggable };
          }),
          deletes: root.querySelectorAll('.wand-x').length,
          add: !!q('[data-wand-act="add"]'),
          edit: !!q('.wand-edit.on'),
          notes: [...root.querySelectorAll('.wand-note')].map(n => n.textContent),
          status: (q('.wand-status') || {}).textContent || '',
          error: (q('.wand-error') || {}).textContent || '',
          editor: ed ? { emoji: q('[data-wand-field="emoji"]').value, picked: (q('.wand-picked') || {}).textContent || '',
            query: q('[data-wand-field="query"]').value, args: q('[data-wand-field="args"]').value,
            typeOnly: !!(q('[data-wand-field="typeOnly"]') || {}).checked,
            listed: [...root.querySelectorAll('.wand-skill')].map(b => b.dataset.wandSkill),
            saveDisabled: !!(q('[data-wand-act="save"]') || {}).disabled } : null,
          rect: rectOf(root),
          liveText: (document.getElementById('wand-live') || {}).textContent || '',
          focus: (() => { const d = document.activeElement && document.activeElement.dataset; return d && root.contains(document.activeElement)
            ? { act: d.wandAct || null, id: d.wandId || null, field: d.wandField || null } : null; })(),
        });
      }
      // backlog #63: verify/probe-resource-panel.js reads the Resources panel and the chip, and clicks as a pointer would
      case 'resourcesState': {
        const q = s => [...document.querySelectorAll('#resources-root ' + s)];
        const chip = document.getElementById('tb-resources');
        // Is a name cell clipped, and does at least its first word (with the open/closed arrow in front) fit?
        const cellFit = (cell, arrow) => {
          if (!cell) return { clipped: false, firstWordFits: true, width: 0 };
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(cell).font;
          probe.textContent = (arrow ? '▸ ' : '') + (cell.textContent.split(/\s+/)[0] || '');
          document.body.appendChild(probe);
          const need = probe.offsetWidth;
          probe.remove();
          return { clipped: cell.scrollWidth > cell.clientWidth, firstWordFits: cell.clientWidth >= need, width: cell.clientWidth };
        };
        return JSON.stringify({
          scope: typeof window.resourcesDisplay === 'object' && typeof window.resourcesDisplay.view === 'function',
          shown: document.querySelector('.panel[data-panel="resources"]').classList.contains('on'),
          chip: chip ? { hidden: chip.hidden, text: chip.getAttribute('aria-label') || chip.textContent, title: chip.title, amber: chip.classList.contains('res-amber'), red: chip.classList.contains('res-red') } : null,
          text: (document.getElementById('resources-root') || {}).textContent || '',
          // the GPU section's rows are read separately (gpuSec): this list is the session, self and window rows
          rows: q('.res-row').filter(r => !r.closest('.res-gpu')).map(r => ({ key: r.dataset.resKey || null, name: (r.querySelector('.res-name') || {}).textContent || '', open: r.classList.contains('open'),
            fit: cellFit(r.querySelector('.res-name'), !r.classList.contains('res-plain')),
            figs: [...r.querySelectorAll('.res-fig')].map(f => f.textContent) })),
          children: q('.res-child').map(c => ({ name: (c.querySelector('.res-cname') || {}).textContent || '', cmd: c.title || '', fit: cellFit(c.querySelector('.res-cname'), false),
            figs: [...c.querySelectorAll('.res-fig')].map(f => f.textContent),
            stop: (c.querySelector('[data-res-act="ask-stop"]') || { dataset: {} }).dataset.resPid || null, text: c.textContent })),
          // the Stop button's hit area (its ::after) and where its figures sit, for the layout checks
          stopHit: (() => { const b = q('.res-stop')[0]; if (!b) return null; const a = getComputedStyle(b, '::after'); return { w: parseFloat(a.width), h: parseFloat(a.height), box: b.getBoundingClientRect().width }; })(),
          figX: q('.res-child').map(c => [...c.querySelectorAll('.res-fig')].map(f => Math.round(f.getBoundingClientRect().right))),
          inBox: (() => { const root = document.getElementById('resources-root'); if (!root) return { rootW: 0, rows: [] }; const r = root.getBoundingClientRect(); const lo = r.left + root.clientLeft, hi = lo + root.clientWidth; return { rootW: Math.round(root.clientWidth), rows: q('.res-child').map(c => [...c.children].every(k => { const b = k.getBoundingClientRect(); return b.width > 0 && b.left >= lo - 0.5 && b.right <= hi + 0.5; })) }; })(),
          confirm: (q('.res-confirm')[0] || {}).textContent || null,
          notes: q('.res-note').map(n => n.textContent),
          hist: (() => {
            const pop = document.getElementById('res-popover');
            const rect = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
            const bar = document.getElementById('top-bar');
            return {
              points: resPayload && Array.isArray(resPayload.history) ? resPayload.history.length : 0,
              spark: chip ? [...chip.querySelectorAll('svg.hs')].map(s => ({ polylines: s.querySelectorAll('polyline').length, dots: s.querySelectorAll('circle').length, w: s.width.baseVal.value, h: s.height.baseVal.value })) : [],
              chipRect: chip && !chip.hidden ? rect(chip) : null,
              chipClipped: chip ? chip.scrollWidth > chip.clientWidth : null,
              barClipped: bar ? bar.scrollWidth > bar.clientWidth : null,
              winW: window.innerWidth, winH: window.innerHeight,
              link: !!(pop && pop.querySelector('button.hg-link[data-hist-act="open-panel"]')),
              open: !!pop && !pop.hidden, expanded: chip ? chip.getAttribute('aria-expanded') : null,
              popRect: pop && !pop.hidden ? rect(pop) : null,
              graphs: pop ? [...pop.querySelectorAll('.hg')].map(g => ({ kind: g.dataset.histGraph, rest: g.querySelectorAll('.hg-rest').length, ours: g.querySelectorAll('.hg-ours').length,
                latest: g.querySelectorAll('.hg-latest').length, dots: g.querySelectorAll('.hg-dot-rest').length, axis: (g.querySelector('.hg-axis') || {}).textContent || '', readout: (g.querySelector('.hg-readout') || {}).textContent || '',
                empty: !!g.querySelector('.hg-empty'), cursor: !!g.querySelector('.hg-cursor') })) : [],
            };
          })(),
          // backlog #82: verify/probe-gpu-usage.js reads the GPU section of the Resources tab
          gpuSec: (() => {
            const sec = document.querySelector('#resources-root .res-gpu');
            if (!sec) return null;
            const box = document.getElementById('resources-root').getBoundingClientRect();
            return {
              graphs: [...sec.querySelectorAll('.hg')].map(g => ({ kind: g.dataset.histGraph, rest: g.querySelectorAll('.hg-rest').length, dots: g.querySelectorAll('.hg-dot-rest').length, ours: g.querySelectorAll('.hg-ours').length })),
              rows: [...sec.querySelectorAll('.res-row.res-plain')].map((r) => {
                const b = r.getBoundingClientRect();
                return { name: (r.querySelector('.res-name') || {}).textContent || '', figs: [...r.querySelectorAll('.res-fig')].map(f => f.textContent), inside: b.left >= box.left - 1 && b.right <= box.right + 1 };
              }),
            };
          })(),
          panelFocused: document.activeElement === document.getElementById('resources-root'),
          hasPayload: resPayload !== null,
          payloadHasModel: !!(resPayload && resPayload.model),
          machine: resPayload && resPayload.machine ? resPayload.machine : null,
        });
      }
      // Q2: open the Window menu and press the chip's check, as a pointer would
      case 'resourcesChipMenu': {
        if (document.getElementById('layout-menu').hidden) document.getElementById('layout-btn').click();
        const box = [...document.querySelectorAll('#layout-menu label')].find(l => /Show CPU and memory in the top bar/.test(l.textContent));
        if (!box) return JSON.stringify({ ok: false, error: 'no chip row in the Window menu' });
        const input = box.querySelector('input');
        const before = input.checked;
        input.click();
        return JSON.stringify({ ok: true, before, after: input.checked });
      }
      // #63 follow-up: the popover's other ways to close, and the hover readout, as the page would see them
      case 'resourcesHistoryDo': {
        // backlog #82: bring the Resources tab's GPU section to the top of the panel, so a screenshot shows its process list
        if (a.op === 'scroll-gpu') {
          const sec = document.querySelector('#resources-root .res-gpu');
          if (!sec) return JSON.stringify({ ok: false, error: 'no GPU section' });
          sec.scrollIntoView({ block: 'start' });
          return JSON.stringify({ ok: true });
        }
        if (a.op === 'esc') { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return JSON.stringify({ ok: true }); }
        if (a.op === 'outside') { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return JSON.stringify({ ok: true }); }
        if (a.op === 'link') {
          const btn = document.querySelector('#res-popover [data-hist-act="open-panel"]');
          if (!btn) return JSON.stringify({ ok: false, error: 'no panel link' });
          btn.click();
          return JSON.stringify({ ok: true });
        }
        if (a.op === 'hover') {
          const plot = document.querySelector('#res-popover .hg[data-hist-graph="' + String(a.kind) + '"] .hg-plot');
          if (!plot) return JSON.stringify({ ok: false, error: 'no graph to hover' });
          const b = plot.getBoundingClientRect();
          plot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.left + b.width * Number(a.frac), clientY: b.top + b.height / 2 }));
          return JSON.stringify({ ok: true });
        }
        return JSON.stringify({ ok: false, error: 'unknown op' });
      }
      // backlog #71: verify/probe-canvas-panel.js reads Claude's panel (its frame; the page itself is a native view main reports
      // on) and clicks its controls as a pointer would
      case 'canvasState': {
        const root = document.getElementById('canvas-root');
        const slot = root.querySelector('#canvas-slot');
        const sr = slot ? slot.getBoundingClientRect() : null;
        const panel = document.querySelector('.panel[data-panel="canvas"]');
        return JSON.stringify({
          ok: true,
          scope: typeof window.canvasDisplay === 'object' && typeof window.canvasDisplay.view === 'function',
          shown: panel.classList.contains('on'),
          inShownModules: shownModules.has('canvas'),
          hiddenInLayout: placementLayout().hidden.includes('canvas'),
          text: root.textContent,
          slot: sr ? { x: sr.left, y: sr.top, width: sr.width, height: sr.height } : null,
          badge: (root.querySelector('.cv-badge') || {}).textContent || null,
          asking: (root.querySelector('.cv-ask p') || {}).textContent || null,
          hostsListed: [...root.querySelectorAll('.cv-host')].map(h => h.textContent),
          note: (root.querySelector('.cv-error') || {}).textContent || null,
          empty: !!root.querySelector('.cv-empty'),
          live: canvasLive,
          visibility: document.visibilityState,
        });
      }
      case 'canvasClick': {
        const el = [...document.querySelectorAll('#canvas-root [data-canvas-act]')].find(e => e.dataset.canvasAct === String(a.act)
          && (a.id === undefined || e.dataset.canvasId === String(a.id)) && (a.origin === undefined || e.dataset.canvasOrigin === String(a.origin)));
        if (!el) return JSON.stringify({ ok: false, error: 'no canvas control ' + JSON.stringify(a) });
        el.click();
        return JSON.stringify({ ok: true });
      }
      case 'canvasMcpBox': {
        // #71 question 8: the Style tab's switch for Claude's panel (read it, or press it)
        const box = document.getElementById('style-canvas-mcp');
        if (!box) return JSON.stringify({ ok: true, exists: false });
        if (a.click === true) box.click();
        return JSON.stringify({ ok: true, exists: true, checked: box.checked, disabled: box.disabled });
      }
      case 'canvasOverlay': {
        // a stand-in for a float / menu / popover crossing the slot (PR #122 Dexter F5): a fixed box over the slot's right half (at least SAMPLE_GAP wide: a thinner overlay can fall between the sample points), above the page
        let box = document.querySelector('.probe-canvas-overlay');
        if (box) box.remove();
        if (a.on === true) {
          const slot = document.querySelector('#canvas-root #canvas-slot');
          if (!slot) return JSON.stringify({ ok: false, error: 'no slot' });
          const r = slot.getBoundingClientRect();
          box = document.createElement('div');
          box.className = 'probe-canvas-overlay';
          box.style.cssText = 'position:fixed;z-index:45;background:#c33;left:' + (r.left + r.width * 0.4) + 'px;top:' + (r.top + r.height * 0.25) + 'px;width:' + (r.width * 0.5) + 'px;height:' + (r.height * 0.5) + 'px';
          document.body.appendChild(box);
        }
        return JSON.stringify({ ok: true });
      }
      // backlog #41 (verify/probe-games.js): read the Games panel, and operate it as a pointer, a keyboard or Claude would
      case 'gamesState': {
        if (!gamesPanel) return JSON.stringify({ ok: false, error: 'no games panel' });
        const cv = document.querySelector('#games-root .games-canvas');
        const cover = document.querySelector('#games-root .games-cover');
        const act = document.activeElement;
        // how many pixels of the board are not the plain background: a blank canvas (a game that never drew) reads 0
        let inked = null;
        try {
          const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          const seen = new Set();
          for (let i = 0; i < px.length; i += 4 * 97) seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
          inked = seen.size;
        } catch { /* unreadable */ }
        return JSON.stringify({
          ok: true,
          scope: typeof window.gamesDisplay === 'object' && typeof window.gamesRules === 'object' && typeof window.gamesRound === 'object',
          shown: document.querySelector('.panel[data-panel="games"]').classList.contains('on'),
          state: gamesPanel.state(),
          visibility: document.visibilityState, hides: gamesHides,
          cover: { hidden: cover.hidden, text: cover.querySelector('.games-cover-text').textContent, button: cover.querySelector('.games-cover-btn').textContent },
          best: document.querySelector('#games-root .games-best').textContent,
          score: document.querySelector('#games-root .games-score').textContent,
          time: document.querySelector('#games-root .games-time').textContent,
          picks: [...document.querySelectorAll('#games-root .games-pick')].map(b => [b.dataset.game, b.classList.contains('on')]),
          canvas: rectOf(cv), colours: inked,
          focus: { terminal: !!(term.element && term.element.contains(act)), panel: !!(act && gamesRoot.contains(act)), tag: act ? act.tagName : null },
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        });
      }
      // backlog #33 (verify/probe-ask-panel.js): read the Ask panel, and operate it as a pointer or a keyboard would
      case 'askState': {
        if (!askPanel) return JSON.stringify({ ok: false, error: 'no ask panel' });
        const root = document.getElementById('ask-root');
        const st = askPanel.state();
        return JSON.stringify({
          ok: true,
          scope: typeof window.askDisplay === 'object' && typeof window.askPanelState === 'object' && typeof window.askProfile === 'object' && typeof window.askRequester === 'object',
          shown: document.querySelector('.panel[data-panel="ask"]').classList.contains('on'),
          view: st.view, trail: st.trail.map(t => t.label), hostError: st.hostError,
          profile: { named: st.profile.named, name: st.profile.name, level: st.profile.level, model: st.profile.model },
          host: st.host ? { index: st.host.index, ollama: st.host.ollama, models: st.host.models, examples: st.host.examples } : null,
          entry: st.entry ? { id: st.entry.id, kind: st.entry.kind, phase: st.entry.phase, stage: st.entry.stage, places: st.entry.places ? st.entry.places.length : null, reason: st.entry.reply && st.entry.reply.reason, ok: st.entry.reply && st.entry.reply.ok } : null,
          text: root.querySelector('.ask-body').textContent.slice(0, 4000),
          html: root.querySelector('.ask-body').innerHTML.slice(0, 12000),
          label: (root.querySelector('.ask-label') || {}).textContent || null,
          top: root.querySelector('.ask-top').textContent,
          topHtml: root.querySelector('.ask-top').innerHTML.slice(0, 3000),
          active: (() => { const a = document.activeElement; return a && root.contains(a) ? { id: a.id || null, tag: a.tagName, value: a.value === undefined ? null : a.value, start: a.selectionStart === undefined ? null : a.selectionStart } : null; })(),
          live: (root.querySelector('.ask-live') || {}).textContent || '',
          portraits: st.host && st.host.portraits ? { own: st.host.portraits.own && { tier: st.host.portraits.own.tier, agent: st.host.portraits.own.agent }, suggestions: st.host.portraits.suggestions.map(s => s.agent) } : null,
          status: (root.querySelector('.ask-status') || {}).textContent || null,
          cards: [...root.querySelectorAll('.ask-card')].map(c => ({ where: c.querySelector('.ask-card-where').textContent, file: c.dataset.file, line: c.dataset.line, why: (c.querySelector('.ask-card-why') || {}).textContent || '', code: (c.querySelector('.ask-card-code') || {}).textContent || '' })),
          stages: [...root.querySelectorAll('.ask-stage')].map(s => [s.className, s.textContent]),
          buttons: [...root.querySelectorAll('button')].map(b => ({ act: b.dataset.act || null, text: b.textContent, disabled: b.disabled })),
          form: { hidden: root.querySelector('.ask-form').hidden },
          rect: rectOf(root),
          readerAsk: { hidden: document.getElementById('reader-ask').hidden },
          highlight: (() => { const b = root.querySelector('.ask-highlight'); return b ? { hidden: b.hidden, text: b.querySelector('.ask-hl-text').textContent } : null; })(),
        });
      }
      case 'askDo': {
        if (!askPanel) return JSON.stringify({ ok: false, error: 'no ask panel' });
        const root = document.getElementById('ask-root');
        const byAct = (act, pick) => [...root.querySelectorAll('[data-act="' + act + '"]')].find(pick || (() => true));
        if (a.op === 'type') { const q = root.querySelector('.ask-q'); q.value = String(a.text); }
        else if (a.op === 'submit') root.querySelector('.ask-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        else if (a.op === 'ask') { askPanel.probe('ask', { question: String(a.question), model: a.model }); }
        else if (a.op === 'click') { const b = byAct(String(a.act), a.text ? (x => x.textContent.includes(String(a.text))) : null); if (!b) return JSON.stringify({ ok: false, error: 'no button ' + a.act }); b.click(); }
        else if (a.op === 'name') { const n = root.querySelector('#ask-name'); if (n) { n.value = String(a.name); n.dispatchEvent(new Event('input', { bubbles: true })); } }
        else if (a.op === 'explain') askExplain({ file: String(a.file), start: Number(a.start), end: Number(a.end) });
        else if (a.op === 'readerAsk') document.getElementById('reader-ask').click();
        else if (a.op === 'select') {
          // select the text of the answer (a drill-down), as the pointer would
          const el = root.querySelector('.ask-answer');
          if (!el) return JSON.stringify({ ok: false, error: 'no answer on screen' });
          const range = document.createRange();
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const first = w.nextNode();
          range.setStart(first, 0); range.setEnd(first, Math.min(first.length, Number(a.chars) || 12));
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }
        else if (a.op === 'refresh') { askPanel.probe('refresh', {}); }
        else if (a.op === 'typeIn') { const n = root.querySelector(String(a.sel)); if (!n) return JSON.stringify({ ok: false, error: 'no ' + a.sel }); n.focus(); n.value = String(a.text); n.setSelectionRange(Number(a.caret), Number(a.caret)); n.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (a.op === 'drillWords') { const n = root.querySelector('#ask-drill-term'); if (!n) return JSON.stringify({ ok: false, error: 'no drill box' }); n.value = String(a.text); n.closest('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
        else if (a.op === 'portraitSet') { ws.send(JSON.stringify({ type: 'portrait', action: 'set', agent: ASK_AGENT, state: 'sleeping', path: String(a.path) })); }
        else if (a.op === 'settings') {
          // open the settings, set what was named, press Save (as a person would)
          if (!root.querySelector('#ask-set-level')) { const g = byAct('settings'); if (g) g.click(); }
          const put = (sel, v) => { const n = root.querySelector(sel); if (n && v !== undefined) n.value = String(v); };
          put('#ask-set-name', a.name); put('#ask-set-level', a.level); put('#ask-set-about', a.aboutMe); put('#ask-set-model', a.model);
          const save = byAct('settings-save');
          if (save) save.click();
        }
        else return JSON.stringify({ ok: false, error: 'unknown op ' + a.op });
        return JSON.stringify({ ok: true });
      }
      // backlog #33 gamification (verify/probe-ask-gamify.js): read the explainer's roster card, its panel header, its log page and the give menu,
      // and operate them as a pointer would
      case 'explainerState': {
        const card = agentsEl.querySelector('.agent[data-agent="' + ASK_AGENT + '"]');
        const root = document.getElementById('ask-root');
        const avatar = root ? root.querySelector('.ask-avatar') : null;
        const badgeOf = (el) => { const b = el && el.querySelector('.state-badge'); return b ? { detail: b.dataset.badge || null, icon: b.textContent } : null; };
        return JSON.stringify({
          ok: true,
          scope: typeof window.askExplainerDisplay === 'object',
          frame: explainerFrame, tab: activeRosterTab, namesMode: rosterNamesMode,
          order: [...agentsEl.querySelectorAll('.agent')].map(x => x.dataset.agent),
          card: card ? {
            state: card.dataset.state, detail: card.dataset.detail, text: card.textContent,
            name: (card.querySelector('.name-big') || {}).textContent || null, alt: (card.querySelector('.name-alt') || {}).textContent || null,
            tag: (card.querySelector('.agent-tag') || {}).textContent || null,
            words: (card.querySelector('.state') || {}).textContent || null,
            counts: (card.querySelector('.explainer-counts') || {}).textContent || null,
            unknownCounts: !!card.querySelector('.career-unknown'),
            chip: (card.querySelector('.medal-chip') || {}).textContent || null,
            medalBtn: !!card.querySelector('[data-medal-open]'), badge: badgeOf(card), hasFace: !!card.querySelector('.face .face-media'), faceSrc: (card.querySelector('.face .face-media') || {}).src || null,
            ringShadow: getComputedStyle(card.querySelector('.face')).boxShadow,
          } : null,
          header: avatar ? { state: avatar.dataset.state, detail: avatar.dataset.detail, label: avatar.getAttribute('aria-label'), badge: badgeOf(avatar), medalBtn: !!root.querySelector('[data-act="medal"]'),
            ringShadow: getComputedStyle(avatar).boxShadow } : null,
          medalCount: (medalList || []).filter(e => e.agent === ASK_AGENT).reduce((n, e) => n + e.medals.length, 0),
          log: { open: agentLog.open, agent: agentLog.agent, text: agentLogEl ? agentLogEl.textContent : null, shelf: medalShelfEl ? medalShelfEl.textContent : null },
          menu: medalMenuEl ? { hidden: medalMenuEl.hidden, text: medalMenuEl.textContent } : null,
        });
      }
      case 'explainerDo': {
        const card = () => agentsEl.querySelector('.agent[data-agent="' + ASK_AGENT + '"]');
        const root = document.getElementById('ask-root');
        if (a.op === 'tab') setRosterTab(String(a.tab));
        else if (a.op === 'names') applyRosterNames(String(a.mode));
        else if (a.op === 'search') { rosterQuery = String(a.q); renderRoster(); }
        else if (a.op === 'fakeAgent') { roster.set(String(a.agent), { agent: String(a.agent), state: String(a.state), detail: String(a.state), portrait: { kind: 'text', tier: 'text', initials: 'X', hue: 10 } }); renderRoster(); }
        else if (a.op === 'clickCard') { const c = card(); if (!c) return JSON.stringify({ ok: false, error: 'no card' }); c.querySelector('.meta').click(); }
        else if (a.op === 'cardMedal') { const c = card(); const b = c && c.querySelector('[data-medal-open]'); if (!b) return JSON.stringify({ ok: false, error: 'no medal button' }); b.click(); }
        else if (a.op === 'headerMedal') { const b = root.querySelector('[data-act="medal"]'); if (!b) return JSON.stringify({ ok: false, error: 'no header medal' }); b.click(); }
        else if (a.op === 'rightClick') { const c = card(); if (!c) return JSON.stringify({ ok: false, error: 'no card' }); c.querySelector('.meta').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); }
        else if (a.op === 'giveMedal') {
          const k = medalMenuEl.querySelector('[data-medal-kind="' + String(a.kind) + '"]'); if (!k) return JSON.stringify({ ok: false, error: 'no menu' });
          k.click();
        }
        else if (a.op === 'removeMedal') { const b = medalShelfEl.querySelector('[data-medal-remove]'); if (!b) return JSON.stringify({ ok: false, error: 'no medal on the shelf' }); b.click(); }
        else if (a.op === 'closeLog') { const b = agentLogEl.querySelector('[data-agent-log-close]'); if (b) b.click(); }
        else return JSON.stringify({ ok: false, error: 'unknown op ' + a.op });
        return JSON.stringify({ ok: true });
      }
      case 'gamesDo': {
        if (!gamesPanel) return JSON.stringify({ ok: false, error: 'no games panel' });
        const root = document.getElementById('games-root');
        const cv = root.querySelector('.games-canvas');
        const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + x * r.width / 400, clientY: r.top + y * r.height / 300, bubbles: true }; };
        if (a.op === 'pick') { const b = [...root.querySelectorAll('.games-pick')].find(x => x.dataset.game === a.game); if (!b) return JSON.stringify({ ok: false, error: 'no game ' + a.game }); b.click(); }
        else if (a.op === 'go') root.querySelector('.games-cover-btn').click();
        else if (a.op === 'focusBoard') cv.focus();
        // a key at whatever holds focus: the terminal's own input when it has it, so this is the "typing for Claude" case
        else if (a.op === 'keyAtFocus') (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: String(a.key), code: a.code || '', bubbles: true, cancelable: true }));
        else if (a.op === 'click') { cv.dispatchEvent(new PointerEvent('pointerdown', at(a.x, a.y))); cv.dispatchEvent(new PointerEvent('pointerup', at(a.x, a.y))); cv.dispatchEvent(new MouseEvent('click', at(a.x, a.y))); }
        else if (a.op === 'resume') { cv.dispatchEvent(new PointerEvent('pointerdown', at(200, 150))); }
        // the real control-message path: the same function the host's attention message goes through
        else if (a.op === 'attention') handleControl({ type: 'attention', urgent: a.urgent === true, title: 'games probe', body: 'games probe' });
        else if (a.op === 'termFocus') term.focus();
        else return JSON.stringify({ ok: false, error: 'unknown op ' + a.op });
        return JSON.stringify({ ok: true });
      }
      case 'resourcesClick': {
        // matched on the dataset, not a selector: a tab's key is a Windows path, and a backslash in a CSS string is an escape
        const el = a.chip === true ? document.getElementById('tb-resources')
          : [...document.querySelectorAll('#resources-root [data-res-act]')].find(e => e.dataset.resAct === String(a.act)
            && (a.key === undefined || e.dataset.resKey === String(a.key)) && (a.pid === undefined || e.dataset.resPid === String(a.pid)));
        if (!el) return JSON.stringify({ ok: false, error: 'no resources control ' + JSON.stringify(a) });
        el.click();
        return JSON.stringify({ ok: true });
      }
      case 'wandClick': {
        const btn = [...document.querySelectorAll('#wand-root button[data-wand-act]')].find(b => b.dataset.wandAct === a.act
          && (a.id === undefined || b.dataset.wandId === a.id) && (a.skill === undefined || b.dataset.wandSkill === a.skill)
          && (a.emoji === undefined || b.dataset.wandEmoji === a.emoji));
        if (!btn) return JSON.stringify({ ok: false, error: 'no wand control ' + JSON.stringify(a) });
        const times = Number.isInteger(a.times) && a.times > 1 && a.times <= 3 ? a.times : 1;
        for (let i = 0; i < times; i++) btn.click();
        return JSON.stringify({ ok: true });
      }
      case 'wandSetField': {
        const el = document.querySelector('#wand-root [data-wand-field="' + String(a.field) + '"]');
        if (!el) return JSON.stringify({ ok: false, error: 'no editor field ' + a.field });
        el.focus();
        if (el.type === 'checkbox') el.checked = a.value === true;
        else el.value = String(a.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return JSON.stringify({ ok: true });
      }
      // keyboard access (Miguel I3 / I4): focus a control, press a key on it
      case 'wandFocus': case 'wandKey': {
        const root = document.getElementById('wand-root');
        const el = a.field ? root.querySelector('[data-wand-field="' + String(a.field) + '"]')
          : [...root.querySelectorAll('button[data-wand-act]')].find(b => b.dataset.wandAct === a.act && (a.id === undefined || b.dataset.wandId === a.id));
        if (!el) return JSON.stringify({ ok: false, error: 'no wand control ' + JSON.stringify(a) });
        el.focus();
        if (req.action === 'wandFocus') return JSON.stringify({ ok: true });
        const ev = new KeyboardEvent('keydown', { key: String(a.key), altKey: a.alt === true, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return JSON.stringify({ ok: true, defaultPrevented: ev.defaultPrevented });
      }
      // a real drag inside the panel: from one favourite onto another's slot
      case 'wandDrag': {
        const root = document.getElementById('wand-root');
        const src = [...root.querySelectorAll('.wand-btn[data-wand-id]')].find(b => b.dataset.wandId === a.from);
        const cell = [...root.querySelectorAll('[data-wand-cell]')].find(c => c.dataset.wandCell === a.to);
        if (!src || !cell) return JSON.stringify({ ok: false, error: 'no such favourite to drag' });
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(src, 'dragstart');
        fire(cell, 'dragover');
        const overlay = (document.getElementById('app') || document.body).classList.contains('dropping');
        fire(cell, 'drop');
        return JSON.stringify({ ok: true, fileDropOverlayShown: overlay });
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
      // PR #102 Miguel Y4: the vault's NEW-secret field as it is now. `reveal` clicks its show/hide button as a
      // pointer would; `type` focuses it and puts dummy text in it (never a real secret). Reports what is on screen.
      case 'secretField': {
        const f = document.getElementById('vault-secret');
        if (a.reveal === true) document.getElementById('vault-mask').click();
        if (typeof a.type === 'string') { f.focus(); f.value = a.type; }
        return JSON.stringify({ ok: true, inputType: f.type, value: f.value, active: document.activeElement && document.activeElement.id, visible: f.offsetParent !== null });
      }
      // PR #102 Miguel Y4: half a secret in a FLOATING vault's field, then a raise, a move and a resize of that float,
      // as pointer events do them. After each the field must still hold the keyboard and its text. `id`: the float.
      case 'floatSecret': return (async () => {
        const f = document.getElementById('vault-secret');
        f.focus();
        f.value = 'dummy-half';
        const steps = [['raise', 'floatPress', { id: a.id, bar: true }], ['move', 'floatDrag', { id: a.id, what: 'bar', dx: -30, dy: -20 }],
          ['resize', 'floatDrag', { id: a.id, what: 'grip', dx: 20, dy: 10 }], ['raise body', 'floatPress', { id: a.id }]];
        const out = [{ step: 'start', active: document.activeElement && document.activeElement.id, value: f.value }];
        for (const [step, action, args] of steps) {
          const r = JSON.parse(await window.__dockProbe({ action, args }));
          await new Promise(res => setTimeout(res, 200));
          out.push({ step, ok: r.ok, active: document.activeElement && document.activeElement.id, value: f.value });
        }
        f.value = '';                                           // nothing left over for the next step
        return JSON.stringify({ ok: true, out });
      })();
      // Backlog #36: the socket drops and reattaches. With a dummy half-secret in
      // the field (`a.blur` false) focus must still be in it, and what is typed
      // next lands there, not in the session; with nothing focused (`a.blur`)
      // the reattach gives the terminal the keyboard. insertText goes to
      // whatever holds focus, as a keystroke does.
      case 'reconnect': return new Promise((resolve) => {
        const field = document.getElementById('vault-secret');
        const before = ws;
        const sent = [];
        const sub = term.onData((d) => { sent.push(d); });
        if (a.blur) { if (document.activeElement) document.activeElement.blur(); }
        else {
          field.focus();
          field.value = 'dummy-';
          // Tab onto a control beside the field (the Show button): `a.focus` is its selector.
          if (a.focus) document.querySelector(a.focus).focus();
        }
        const startedIn = document.activeElement && document.activeElement.id;
        ws.close();
        const t0 = Date.now();
        const poll = setInterval(() => {
          const up = ws !== before && ws.readyState === WebSocket.OPEN;
          if (!up && Date.now() - t0 < 10000) return;
          clearInterval(poll);
          setTimeout(() => {
            const id = document.activeElement && document.activeElement.id;
            const inTerm = !!(term.element && term.element.contains(document.activeElement));
            document.execCommand('insertText', false, 'tail');
            setTimeout(() => {
              sub.dispose();
              const value = field.value;
              field.value = '';   // nothing left over for the next step
              resolve(JSON.stringify({ ok: true, reattached: up, startedIn, id, inTerm, value, sent }));
            }, 150);
          }, 150);
        }, 50);
      });
      // BACKLOG #100 (verify/probe-idle-redraw.js): the attention cue's class and every animation this page is running right now.
      case 'animState': {
        const running = document.getAnimations().filter((a) => a.playState === 'running');
        return JSON.stringify({ ok: true, cue: document.body.classList.contains('attention-cue'), visibility: document.visibilityState,
          running: running.length, names: [...new Set(running.map((a) => a.animationName || a.constructor.name))] });
      }
      // Backlog #62 (verify/probe-lean.js): lean mode as this page has it -- the class, what the dock still shows,
      // the terminal's renderer and scrollback, the background layer and the working-agents strip.
      case 'leanState': {
        const buf = term.buffer.active;
        const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
        const bgEl = document.getElementById('bg');
        const cs = getComputedStyle(document.documentElement);
        return JSON.stringify({
          ok: true, leanOn, bodyLean: document.body.classList.contains('lean'), shown: [...shownModules],
          zonesVisible: [...document.querySelectorAll('.zone')].filter(visible).length,
          zones: [...document.querySelectorAll('.zone')].filter(visible).map((z) => ({ group: z.dataset.group || null, keep: 'leanKeep' in z.dataset, panels: [...z.querySelectorAll('.zone-panels > .panel.on')].map((p) => p.dataset.panel), rect: rectOf(z) })),
          headerVisible: visible(document.querySelector('header')),
          barVisible: visible(document.getElementById('terminal-bar')),
          webgl: !!webglAddon, termRect: rectOf(document.getElementById('termwrap')), page: { width: window.innerWidth, height: window.innerHeight },
          buffer: { length: buf.length, baseY: buf.baseY, cols: term.cols, rows: term.rows },
          bg: { cssImage: bgEl.style.backgroundImage, still: bgStillEl ? { width: bgStillEl.width, height: bgStillEl.height } : null,
            video: bgVideoEl ? { paused: bgVideoEl.paused, currentTime: bgVideoEl.currentTime } : null, hasBg: document.body.classList.contains('has-bg') },
          look: { accent: cs.getPropertyValue('--accent').trim(), bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() },
          termTheme: term.options.theme ? { background: term.options.theme.background || null, foreground: term.options.theme.foreground || null } : null,
          typedFocus: !!(term.element && term.element.contains(document.activeElement)), focusId: (document.activeElement && document.activeElement.id) || '',
        });
      }
      // Backlog #34 (verify/probe-video-background.js): the background layer as it is on screen --
      // the video's own state, the classes and variables the look paints, and the Style tab's note.
      case 'bgState': {
        const v = bgVideoEl;
        const sec = document.querySelector('[data-section="background"]');
        const note = sec && sec.querySelector('.style-note');
        const err = sec && sec.querySelector('.style-error');
        const match = document.getElementById('style-match');
        const css = getComputedStyle(document.documentElement);
        return JSON.stringify({
          ok: true,
          video: v ? { paused: v.paused, currentTime: v.currentTime, readyState: v.readyState, width: v.videoWidth,
            muted: v.muted, loop: v.loop, src: v.getAttribute('src'), rect: rectOf(v) } : null,
          hasBg: document.body.classList.contains('has-bg'), hasCustomBg: document.body.classList.contains('has-custom-bg'),
          bgImage: document.getElementById('bg').style.backgroundImage,
          veil: parseFloat(getComputedStyle(document.getElementById('bg'), '::after').opacity),
          note: note ? note.textContent : null, error: err ? err.textContent : null,
          paused: (() => { const p = document.getElementById('style-bg-paused'); return p && !p.hidden ? p.textContent : null; })(),
          matchDisabled: match ? match.disabled : null,
          vars: { bg: css.getPropertyValue('--bg').trim(), chrome: css.getPropertyValue('--chrome').trim(), border: css.getPropertyValue('--border').trim(),
            text: css.getPropertyValue('--text').trim(), dim: css.getPropertyValue('--dim').trim(), accent: css.getPropertyValue('--accent').trim(),
            onAccent: css.getPropertyValue('--on-accent').trim() },
          reducedMotion: reducedMotionQuery.matches, playback: backgroundPlaybackState(),
          renderer: rectOf(document.getElementById('bg')),
        });
      }
      // Backlog #88 + #92 (verify/probe-fonts-colour.js): the fonts as painted -- the terminal's options, the interface and
      // monospace variables and what real elements compute from them -- and the plain-colour background's classes and veil.
      case 'fontsState': {
        const css = getComputedStyle(document.documentElement);
        const comp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily : null; };
        const bgEl = document.getElementById('bg');
        const fixedCount = fontFamilies ? fontFamilies.filter(isFixedFamily).length : null;
        return JSON.stringify({
          ok: true,
          settings: fontSettings, projectFont: projectTerminalFont,
          term: { fontFamily: term.options.fontFamily, fontSize: term.options.fontSize },
          vars: { ui: css.getPropertyValue('--font-ui').trim(), mono: css.getPropertyValue('--font-mono').trim() },
          computed: { body: getComputedStyle(document.body).fontFamily, filesTree: comp('#files-tree'), readerPath: comp('#reader-path') },
          list: { loaded: !!fontFamilies, count: fontFamilies ? fontFamilies.length : null, fixed: fixedCount, error: fontListError },
          picker: { term: !!document.getElementById('style-font-term-list'), rows: document.querySelectorAll('#style-font-term-list .font-row').length },
          bg: {
            plainColour: plainColourOn, hasPlainClass: document.body.classList.contains('has-plain-colour'),
            hasBg: document.body.classList.contains('has-bg'), hasCustomBg: document.body.classList.contains('has-custom-bg'),
            video: !!bgVideoEl, still: !!bgStillEl, image: bgEl.style.backgroundImage,
            color: getComputedStyle(bgEl).backgroundColor, veil: parseFloat(getComputedStyle(bgEl, '::after').opacity),
            appColor: css.getPropertyValue('--bg').trim(), darkness: css.getPropertyValue('--bg-darkness').trim(),
            veilColor: getComputedStyle(bgEl, '::after').backgroundColor,
            modeButtons: { image: !!document.getElementById('style-bg-mode-image'), colour: !!document.getElementById('style-bg-mode-colour') },
            slider: !!document.getElementById('style-dark'),
          },
        });
      }
      // The Fonts pickers as a click would use them: the app-wide settings through main, a search typed into a box.
      case 'fontsSet': {
        if (!(window.harness && window.harness.fonts)) return JSON.stringify({ ok: false, error: 'no fonts bridge' });
        return window.harness.fonts.set(a.settings).then((saved) => JSON.stringify({ ok: !!saved, saved }));
      }
      case 'fontsSearch': {
        // Ids written out in full (test/renderer-scope.test.js): one pair per picker.
        const pair = a.kind === 'ui' ? [document.getElementById('style-font-ui-search'), document.getElementById('style-font-ui-list')]
          : a.kind === 'project' ? [document.getElementById('style-font-project-search'), document.getElementById('style-font-project-list')]
            : [document.getElementById('style-font-term-search'), document.getElementById('style-font-term-list')];
        if (!pair[0] || !pair[1]) return JSON.stringify({ ok: false, error: 'no search box' });
        pair[0].value = String(a.query || '');
        pair[0].dispatchEvent(new Event('input'));
        return JSON.stringify({ ok: true, rows: [...pair[1].querySelectorAll('.font-row')].map((r) => r.dataset.font) });
      }
      case 'fontsPick': {
        const list = a.kind === 'ui' ? document.getElementById('style-font-ui-list')
          : a.kind === 'project' ? document.getElementById('style-font-project-list') : document.getElementById('style-font-term-list');
        const row = list && [...list.querySelectorAll('.font-row')].find((r) => r.dataset.font === a.font);
        if (!row) return JSON.stringify({ ok: false, error: 'no such row' });
        row.click();
        return JSON.stringify({ ok: true });
      }
      // The Style tab's own sends, as the drop zone would make them: a path the host copies in.
      case 'bgStyle': sendStyle('background', { action: a.action, ...(a.path ? { path: a.path } : {}), ...(a.look ? { look: a.look } : {}) }); break;
      // The Match colours button, as a click would press it.
      case 'bgMatch': {
        const b = document.getElementById('style-match');
        if (!b) return JSON.stringify({ ok: false, error: 'no Match colours button' });
        if (b.disabled) return JSON.stringify({ ok: false, error: 'the button is disabled' });
        b.click();
        break;
      }
      // Backlog #36: who holds the keyboard now (the first open at load must leave it on the terminal).
      case 'focusState': return JSON.stringify({ ok: true, id: (document.activeElement && document.activeElement.id) || '',
        inTerm: !!(term.element && term.element.contains(document.activeElement)), shown: [...shownModules] });
      // #43 (verify/probe-shortcuts-page.js): the shortcuts sheet as painted, and the few things a probe does to it that a real
      // key can't (focus the terminal first, type into the search box, click "?").
      case 'shortcutsState': {
        const card = shortcutsSheetEl.querySelector('.sc-card').getBoundingClientRect();
        const bar = document.querySelector('header').getBoundingClientRect();
        const ae = document.activeElement;
        return JSON.stringify({ ok: true, open: shortcutsOpen, hidden: shortcutsSheetEl.hidden, expanded: shortcutsBtnEl.getAttribute('aria-expanded'),
          activeId: (ae && ae.id) || '', inTerm: !!(term.element && term.element.contains(ae)),
          rows: shortcutsBodyEl.querySelectorAll('.sc-row').length, groups: [...shortcutsBodyEl.querySelectorAll('h3')].map(h => h.textContent),
          cli: shortcutsBodyEl.querySelectorAll('.sc-cli').length, bodyInert: document.getElementById('body').inert, none: !!shortcutsBodyEl.querySelector('.sc-none'), query: shortcutsSearchEl.value,
          card: { left: Math.round(card.left), right: Math.round(card.right), top: Math.round(card.top), bottom: Math.round(card.bottom), width: Math.round(card.width) },
          headerBottom: Math.round(bar.bottom), viewport: { w: window.innerWidth, h: window.innerHeight },
          btn: { text: shortcutsBtnEl.textContent, title: shortcutsBtnEl.title } });
      }
      case 'shortcutsDo': {
        if (a.op === 'focusTerm') { term.focus(); return JSON.stringify({ ok: true }); }
        if (a.op === 'clickButton') { shortcutsBtnEl.click(); return JSON.stringify({ ok: true }); }
        if (a.op === 'focusButton') { shortcutsBtnEl.focus(); return JSON.stringify({ ok: true }); }
        if (a.op === 'type') {
          shortcutsSearchEl.value = String(a.text);
          shortcutsSearchEl.dispatchEvent(new Event('input', { bubbles: true }));
          return JSON.stringify({ ok: true });
        }
        return JSON.stringify({ ok: false, error: 'unknown shortcutsDo op' });
      }
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
    const l = placementLayout();
    if (!DTm.groupOf(l, forced)) return;      // a hidden module has no group to show in
    selection = DTm.selectTab(selection, l, forced);
    renderLayout();
  });
  loadPresets();

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
let backgroundSetAt = null;   // look.json's setAt for the person's own background, or null (Dexter D5)

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
  if (backgroundUrl || plainColourOn) {
    terminal.background = hexToRgba(terminal.background, TERM_ALPHA);
    term.options.allowTransparency = true;
  }
  term.options.theme = terminal;
  if (theme.font && theme.font.lineHeight) term.options.lineHeight = theme.font.lineHeight;
  // The font family and size are decided in one place (applyFonts: the person's picks over the registry theme's font), so a theme
  // application never writes the theme's font and then the pick's -- each write makes xterm rebuild its glyph atlas.
  applyFonts();
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
  paintPlainColour(theme);
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

// #44: where an agent launched from THIS session is working, when it has touched another worktree. Nothing at
// all for an agent that hasn't. A button, so a click on it is never "open the log" (cardClickAgent skips them).
function occupancyWhereHtml(agent) {
  const line = window.occupancyDisplay ? window.occupancyDisplay.cardLine(occupancy.launched, agent, occupancy.session) : null;
  if (!line) return '';
  return `<button type="button" class="agent-where" data-where-root="${escapeHtml(line.root)}" title="${escapeHtml(line.title)}">` +
    `${escapeHtml(line.text)}${line.plus > 0 ? `<span class="agent-where-plus">+${line.plus}</span>` : ''}</button>`;
}
// Delegated on the document, not added to the roster's one card-click handler (which is pinned as the ONLY
// handler that opens a log); a button inside a card is never a card click anyway.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.agent-where');
  if (b && b.dataset.whereRoot) jumpToFolder(b.dataset.whereRoot).then(() => {}, () => {});
});

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

// --- two names, the Role/Name toggle and the search (BACKLOG #76) -------------
// Decisions are in app/roster-search-display.js; this is state and drawing.
// `rosterNamesMode` is install-wide, kept by main beside the agent-images switch
// (app/avatar-bridge.js); until main answers, or with no bridge, it's 'name'.
let rosterNamesMode = 'name';
let rosterQuery = '';
const rosterSearchEl = document.getElementById('roster-search');
const rosterSearchRowEl = document.getElementById('roster-search-row');
const rosterSearchBtnEl = document.getElementById('roster-search-btn');

// The name line: the toggle's pick big, the other small beside it. `title` carries both.
function agentNameHtml(agent, entry, extraHtml) {
  const n = window.rosterSearchDisplay.cardNames(agent, entry, rosterNamesMode);
  const title = n.small ? `${n.big} (${n.small})` : n.big;
  return `<div class="name" title="${escapeHtml(title)}"><span class="name-big">${escapeHtml(n.big)}</span>` +
    (n.small ? `<span class="name-alt">${escapeHtml(n.small)}</span>` : '') + extraHtml + `</div>`;
}

// Up to two lines under the name (CSS line-clamp); the full text is the hover.
function agentFnHtml(entry) {
  return entry && typeof entry.fn === 'string' && entry.fn
    ? `<div class="agent-fn" title="${escapeHtml(entry.fn)}">${escapeHtml(entry.fn)}</div>` : '';
}

function rosterMatches(agent) {
  return window.rosterSearchDisplay.matches(agent, rosterIndexEntry(agent), rosterQuery);
}

function applyRosterNames(mode) {
  const next = window.rosterSearchDisplay.normalizeMode(mode);
  const changed = next !== rosterNamesMode;
  rosterNamesMode = next;
  for (const b of document.querySelectorAll('#roster-names-toggle button[data-roster-names]')) {
    const on = b.dataset.rosterNames === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  if (changed) renderRoster();
}

function setRosterNames(mode) {
  if (!(window.harness && window.harness.avatar && window.harness.avatar.setRosterNames)) { applyRosterNames(mode); return; }
  window.harness.avatar.setRosterNames(mode).then((saved) => {
    if (saved === 'role' || saved === 'name') { applyRosterNames(saved); return; }
    // Refused (the record was locked): snap back to what is saved.
    window.harness.avatar.getRosterNames().then(applyRosterNames).catch(() => { /* keep what's shown */ });
  }).catch(() => { /* keep what's shown; main's push corrects it */ });
}

function setRosterSearch(open) {
  if (rosterSearchRowEl) rosterSearchRowEl.hidden = !open;
  if (rosterSearchBtnEl) rosterSearchBtnEl.setAttribute('aria-pressed', String(open));
  if (open) { if (rosterSearchEl) rosterSearchEl.focus(); return; }
  const had = rosterQuery !== '';
  rosterQuery = '';
  if (rosterSearchEl) rosterSearchEl.value = '';
  if (had) renderRoster();
}

for (const b of document.querySelectorAll('#roster-names-toggle button[data-roster-names]')) {
  b.addEventListener('click', () => setRosterNames(b.dataset.rosterNames));
}
if (rosterSearchBtnEl) {
  rosterSearchBtnEl.addEventListener('click', () => setRosterSearch(!!(rosterSearchRowEl && rosterSearchRowEl.hidden)));
}
if (rosterSearchEl) {
  rosterSearchEl.addEventListener('input', () => { rosterQuery = rosterSearchEl.value; renderRoster(); });
  rosterSearchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setRosterSearch(false); if (rosterSearchBtnEl) rosterSearchBtnEl.focus(); }
  });
}
applyRosterNames('name');
if (window.harness && window.harness.avatar && window.harness.avatar.getRosterNames) {
  window.harness.avatar.onRosterNames(applyRosterNames);
  window.harness.avatar.getRosterNames().then(applyRosterNames).catch(() => { /* stays 'name' */ });
}

for (const b of document.querySelectorAll('#roster-subtabs button[data-roster-tab]')) {
  b.addEventListener('click', () => setRosterTab(b.dataset.rosterTab));
}

// --- the Ask explainer on the roster (BACKLOG #33 gamification) -------------------------------------------------------------
// Decisions are in app/ask-explainer-display.js; this is state and drawing. The host's last `explainer` frame (null: it hasn't said, or
// it is an older host) and the person's profile (the naming card) decide whether it is on the roster, on which tab, and what its card says.
const explainerProfile = () => (askPanel ? askPanel.profile() : null);
function explainerPlacement() { return window.askExplainerDisplay.tabFor(explainerFrame, explainerProfile()); }
// its name is a label only: medals and counts are keyed by ASK_AGENT
function explainerLabel() { const p = explainerProfile(); return p && p.name ? p.name : ASK_AGENT; }
function explainerCardHtml(inactive) {
  const X = window.askExplainerDisplay;
  const profile = explainerProfile();
  const f = explainerFrame;
  const look = inactive ? { state: 'inactive', detail: 'inactive', words: 'inactive' } : X.look(f.state, f.detail);
  // the agent's picture the person picked on the naming card: the panel's own list of them first (the host sent exactly these), else the roster's
  const offered = (((askPanel && askPanel.state().host) || {}).portraits || {}).suggestions;
  const portrait = X.portraitFor(profile, f, (agent) => {
    const given = Array.isArray(offered) ? offered.find(s => s && s.agent === agent) : null;
    if (given && given.portrait) return given.portrait;
    const live = roster.get(agent);
    if (live && live.portrait) return live.portrait;
    const known = rosterIndexEntry(agent);
    return known && known.portrait ? known.portrait : null;
  });
  return `<div class="agent" data-state="${escapeHtml(look.state)}" data-detail="${escapeHtml(look.detail)}" data-agent="${ASK_AGENT}" data-explainer="true">` +
    window.medalsDisplay.cardButtonHtml(ASK_AGENT, explainerLabel()) +
    `<div class="face" data-tier="${escapeHtml((portrait && portrait.tier) || 'text')}">${faceHtml(portrait)}</div>` +
    (inactive ? '' : window.agentStateDisplay.badgeHtml(f.state, f.detail)) +
    `<div class="meta">` + agentNameHtml(X.ROLE, X.entry(profile), X.tagHtml()) +
    `<div class="state">${escapeHtml(look.words)}${window.medalsDisplay.chipHtml(window.medalsDisplay.countOf(medalList, ASK_AGENT))}</div>` +
    X.countsHtml(f.counts) +
    `</div></div>`;
}
function explainerLogPage() {
  return window.askExplainerDisplay.logPageHtml({ name: explainerLabel(), counts: explainerFrame ? explainerFrame.counts : null });
}
function applyExplainer(raw) {
  explainerFrame = window.askExplainerDisplay.frameOf(raw);
  renderRoster();
  if (askPanel) askPanel.repaint();
  if (agentLog.open && agentLog.agent === ASK_AGENT) { agentLog = { ...agentLog, page: explainerLogPage() }; renderAgentLogPanel(); }
}
// The naming card / settings changed its name or picture: the card follows (the panel itself repaints on its own).
let explainerProfileSig = null;
function explainerProfileChanged() {
  const p = explainerProfile();
  const sig = p ? JSON.stringify([p.named, p.name, p.portrait]) : null;
  if (sig === explainerProfileSig) return;
  explainerProfileSig = sig;
  if (explainerFrame) renderRoster();
  if (agentLog.open && agentLog.agent === ASK_AGENT) { agentLog = { ...agentLog, page: explainerLogPage() }; renderAgentLogPanel(); }
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
      `<div class="meta">` + agentNameHtml(row.agent, entry, unresolvedHtml + unreadableHtml) +
      agentFnHtml(entry) +
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

// BACKLOG #80 (+ #55's bubbles). The medals Ricardo gave, as the host last said ([{ agent, medals }]; app/medals-display.js), and
// the speech bubbles: the host's on/off switch (null until `hello`), the live bubbles, and whether the window is in lean mode
// (#62's lean lane sets it; until it lands nothing is lean). Decisions are in app/bubble-display.js.
let medalList = null;      // null: not read yet, or the host couldn't read the file (unknown, never "no medals")
const cleanMedalList = (list) => (Array.isArray(list) ? list.filter((e) => e && typeof e.agent === 'string' && Array.isArray(e.medals)) : null);
let bubblesEnabled = null;
let leanMode = false;
const bubbleBoard = window.bubbleDisplay.createBoard();
let bubbleTimer = null;
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
  paintBubbles();       // a repaint replaced the cards, so the bubbles go back on (BACKLOG #80)
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

// The search's "show hidden" (#76): reveal the hidden agents the query matched. Its own listener, so the card click
// handler above stays the one that opens a log.
agentsEl.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('[data-roster-reveal]')) { showHiddenAgents = true; renderRoster(); }
});

document.getElementById('roster-show-hidden').addEventListener('click', () => {
  showHiddenAgents = !showHiddenAgents;
  renderRoster();
});

function renderRoster() {
  // Lean mode keeps only a strip of the working agents' still portraits; the panel is not drawn (nor its videos churned).
  if (leanOn) { paintLeanFaces(); return; }
  const showBtnEl = document.getElementById('roster-show-hidden');
  showBtnEl.hidden = true;   // Active tab only; the Active branch below un-hides it when n > 0
  const { inactive: inactiveAll } = splitActiveInactive(wholeRosterEntries().map(a => a.agent), [...roster.keys()]);
  const inactive = inactiveAll.filter(a => a !== ASK_AGENT);      // the explainer is placed by its own rules below, never twice
  const exPlace = explainerPlacement();
  const exProfile = explainerProfile();
  const exRow = exPlace === 'active' ? window.askExplainerDisplay.row(explainerFrame, exProfile) : null;
  const exMatches = () => window.askExplainerDisplay.matches(exProfile, rosterQuery);

  const searching = rosterQuery.trim() !== '';
  const noMatch = () => paintAgents(
    `<div class="empty">${escapeHtml(window.rosterSearchDisplay.emptyMessage(activeRosterTab, rosterQuery))}</div>`);

  if (activeRosterTab === 'inactive') {
    if (inactive.length === 0 && exPlace !== 'inactive') {
      paintAgents('<div class="empty">No other agents known yet.</div>');
      return;
    }
    const found = inactive.filter(rosterMatches);
    const exHere = exPlace === 'inactive' && exMatches();
    if (found.length === 0 && !exHere) { noMatch(); return; }
    // the explainer has no lifetime tokens, so it sorts with the agents that have none
    const rows = sortRosterRows([...found, ...(exHere ? [ASK_AGENT] : [])].map((agent) => {
      if (agent === ASK_AGENT) return { agent, tokens: null, unreadable: false };
      const entry = rosterIndexEntry(agent);
      return {
        agent,
        tokens: entry && typeof entry.tokens === 'number' ? entry.tokens : null,
        // Dexter N2 (PR #59 R2): "ran, but unreadable this pass" must sort
        // above a genuine never-used row, not tie with it.
        unreadable: !!(entry && entry.unreadable),
      };
    }));
    paintAgents(rows.map(r => (r.agent === ASK_AGENT ? explainerCardHtml(true) : inactiveRowHtml(r))).join(''));
    return;
  }

  if (roster.size === 0 && !exRow) {
    // Three different situations, not one sentence. "No agents yet" is a
    // positive claim about history and must not be made on a read that failed.
    paintAgents(`<div class="empty">${escapeHtml(rosterEmptyState(roster.size, agentStats, lastAgentStatsPayload, { isDefault: currentProfileIsDefault() }))}</div>`);
    return;
  }
  // Active agents first, then alphabetical, so the thing you care about is at
  // the top without the list reshuffling on every tick.
  // A card waiting on you floats to the top, then base state, then name (app/agent-state-display.js sortRows).
  const rows = window.agentStateDisplay.sortRows([...roster.values(), ...(exRow ? [exRow] : [])]);
  const counts = instanceCounts(latestParty);

  // BACKLOG #14. Reconciled here as well as on the host, so no frame ordering
  // ever draws a hide flag on an awake agent. The host stays authoritative:
  // its `hidden` frame replaces this list wholesale.
  hiddenAgentNames = reconcileHidden(hiddenAgentNames, rows).hidden;
  const nHidden = hiddenCount(rows, hiddenAgentNames);
  if (nHidden === 0) showHiddenAgents = false;   // nothing left to reveal
  const visible = visibleRows(rows, hiddenAgentNames, showHiddenAgents);
  const shown = searching ? visible.filter((r) => (r.explainer ? exMatches() : rosterMatches(r.agent))) : visible;
  // A hidden agent is still on this tab: say so when it matches rather than claim there is no match (PR #141 F2).
  const hiddenMatches = searching && !showHiddenAgents
    ? rows.filter((r) => hiddenAgentNames.includes(r.agent) && rosterMatches(r.agent)) : [];
  const hiddenNote = hiddenMatches.length > 0
    ? `<div class="empty roster-hidden-note">${escapeHtml(window.rosterSearchDisplay.hiddenMatchMessage(hiddenMatches.length, rosterQuery))} ` +
      `<button type="button" class="agent-reveal" data-roster-reveal>show hidden</button></div>` : '';
  showBtnEl.hidden = nHidden === 0;
  showBtnEl.textContent = showHiddenAgents ? `hide hidden (${nHidden})`
    : `show hidden (${nHidden}${hiddenMatches.length ? `, ${hiddenMatches.length} match` : ''})`;
  if (searching && shown.length === 0) {
    if (hiddenMatches.length > 0) paintAgents(hiddenNote); else noMatch();
    return;
  }
  if (shown.length === 0) {
    // True only because awake rows are always in `shown`: what is left is
    // sleeping AND hidden.
    paintAgents('<div class="empty">Every agent here is asleep and hidden.</div>');
    return;
  }

  paintAgents(shown.map(r => {
    if (r.explainer) return explainerCardHtml(false);
    const entry = rosterIndexEntry(r.agent);
    // BACKLOG #55: `data-state` stays the card's base state (ring, sort, portrait upload); the finer state is
    // `data-detail`, drawn as a corner badge and as words under the name.
    const look = window.agentStateDisplay.describeState(r.state, r.detail);
    return `<div class="agent" data-state="${escapeHtml(r.state)}" data-detail="${escapeHtml(look.detail)}" data-agent="${escapeHtml(r.agent)}"` +
      (hiddenAgentNames.includes(r.agent) ? ' data-hidden="true"' : '') + `>` +
      hideButtonHtml(r) +
      window.medalsDisplay.cardButtonHtml(r.agent) +
      `<div class="face" data-tier="${escapeHtml((r.portrait && r.portrait.tier) || 'text')}">${faceHtml(r.portrait)}${faceEditHtml()}</div>` +
      window.agentStateDisplay.badgeHtml(r.state, r.detail) +
      `<div class="meta">` + agentNameHtml(r.agent, entry, countBadgeHtml(r.agent, counts)) +
      agentFnHtml(entry) +
      `<div class="state">${escapeHtml(look.words)}${window.medalsDisplay.chipHtml(window.medalsDisplay.countOf(medalList, r.agent))}</div>` +
      agentModelHtml(r.agent) +
      occupancyWhereHtml(r.agent) +
      careerHtml(r.agent) +
      beltHtml(r.agent) +
      `</div>` +
    `</div>`;
  }).join(''));
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
  paintMedalShelf();       // BACKLOG #80: the medals under the log
}

function sendAgentLog(action, agent) {
  try { ws.send(JSON.stringify({ type: 'agent-log', action, agent })); }
  catch { /* not attached: the reattach in ws.onopen asks again */ }
}

function openAgentLog(agent) {
  // The explainer has no transcript: its page is its counts, and the medal shelf under it (BACKLOG #33 gamification).
  if (agent === ASK_AGENT) {
    agentLog = { ...window.agentLogDisplay.emptyLog(), open: true, agent, page: explainerLogPage() };
    renderAgentLogPanel();
    return;
  }
  agentLog = window.agentLogDisplay.openLog(agent, agentLogShowUnknown);
  renderAgentLogPanel();
  sendAgentLog('open', agent);
}

function closeAgentLog() {
  if (agentLog.open && agentLog.agent !== ASK_AGENT) sendAgentLog('close', agentLog.agent);
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

// --- medals and the speech bubbles (BACKLOG #80) ---------------------------------------------------
// Pure rules: app/medals-display.js and app/bubble-display.js. This is the wiring. The card shows only a count chip; the
// medals with their reasons and dates are on the shelf under an agent's log. A bubble is a joke over a card: never information.
// Usage counters (audit move 2): the host counts a feature use by key and ignores a key it doesn't know. Invisible, never an answer.
function usage(key) { sendJson({ type: 'usage', key }); }
function sendJson(obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* not attached: the next hello brings the truth */ }
}

function bubblesAllowed() {
  return window.bubbleDisplay.canShow({ enabled: bubblesEnabled, imagesEnabled: agentImagesEnabled, lean: leanMode });
}

// Put each live bubble on its card and take expired ones off; look again when the next one expires.
function paintBubbles() {
  window.bubbleDisplay.attach(agentsEl, bubbleBoard, bubblesAllowed());
  clearTimeout(bubbleTimer);
  const next = bubbleBoard.nextExpiryIn();
  bubbleTimer = next === null ? null : setTimeout(paintBubbles, next + 25);
  paintBubblesToggle();
}

// The host asks the model only while this window could show the answer (agent images off or lean: no GPU spent).
function tellHostBubblesVisible() {
  sendJson({ type: 'bubbles', action: 'visible', visible: bubblesAllowed() });
}

function paintBubblesToggle() {
  const bubblesToggleBtn = document.getElementById('bubbles-toggle');
  if (!bubblesToggleBtn) return;
  bubblesToggleBtn.classList.toggle('off', bubblesEnabled !== true);
  if (typeof bubblesEnabled === 'boolean') bubblesToggleBtn.setAttribute('aria-pressed', String(bubblesEnabled));
  else bubblesToggleBtn.removeAttribute('aria-pressed');
  bubblesToggleBtn.title = bubblesEnabled === true
    ? 'Speech bubbles are on (jokes from a local model). Click to turn them off.'
    : bubblesEnabled === false ? 'Speech bubbles are off. Click to turn them on.' : 'Speech bubbles: reading the setting';
}
const bubblesToggleEl = document.getElementById('bubbles-toggle');
if (bubblesToggleEl) {
  bubblesToggleEl.addEventListener('click', () => {
    if (typeof bubblesEnabled === 'boolean') sendJson({ type: 'bubbles', action: 'set-enabled', enabled: !bubblesEnabled });
  });
}

function applyBubblesSwitch(enabled) {
  bubblesEnabled = typeof enabled === 'boolean' ? enabled : null;
  if (bubblesEnabled !== true) bubbleBoard.clear();
  paintBubbles();
  tellHostBubblesVisible();
}

// The shelf: every medal of the agent whose log is open, with reason and date, each removable.
const medalShelfEl = document.getElementById('agent-medals');
let medalRemovePending = null;      // the medal whose x was clicked once: its button reads "Remove?" until confirmed or 4 s pass
let medalRemoveTimer = null;
function paintMedalShelf() {
  if (!medalShelfEl) return;
  const html = agentLog.open
    ? window.medalsDisplay.shelfHtml(agentLog.agent, medalList === null ? null : (medalList.find((e) => e.agent === agentLog.agent) || {}).medals, medalRemovePending, agentLog.agent === ASK_AGENT ? explainerLabel() : agentLog.agent)
    : '';
  if (medalShelfEl.dataset.sig === html) return;
  medalShelfEl.dataset.sig = html;
  medalShelfEl.innerHTML = html;
}
if (medalShelfEl) {
  medalShelfEl.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-medal-remove]');
    if (!btn || !agentLog.open) return;
    const step = window.medalsDisplay.reduceRemove(medalRemovePending, btn.dataset.medalRemove);
    medalRemovePending = step.pending;
    clearTimeout(medalRemoveTimer);
    if (step.send) sendJson({ type: 'medal', action: 'remove', agent: agentLog.agent, id: btn.dataset.medalRemove });
    else medalRemoveTimer = setTimeout(() => { medalRemovePending = window.medalsDisplay.disarm(); paintMedalShelf(); }, 4000);
    paintMedalShelf();
  });
}

function applyMedals(list) {
  medalList = cleanMedalList(list);
  renderRoster();
  paintMedalShelf();
}

// The give-a-medal menu: opened by a right-click on a card or its 🏅 button.
const medalMenuEl = document.getElementById('medal-menu');
let medalMenu = null;     // { agent, opener } while open: opener is the element that had focus, given it back on close
function paintMedalMenu() {
  if (!medalMenuEl) return;
  if (!medalMenu) { medalMenuEl.hidden = true; medalMenuEl.innerHTML = ''; return; }
  medalMenuEl.innerHTML = window.medalsDisplay.menuHtml(medalMenu.agent, medalMenu.agent === ASK_AGENT ? explainerLabel() : medalMenu.agent);
  medalMenuEl.hidden = false;
  const first = medalMenuEl.querySelector('[data-medal-kind]');
  if (first) first.focus();      // keyboard users land on the kinds, not at the end of the page
}
function openMedalMenu(agent, x, y) {
  if (!medalMenuEl) return;
  medalMenu = { agent, opener: document.activeElement };
  paintMedalMenu();
  const w = medalMenuEl.offsetWidth || 260;
  const h = medalMenuEl.offsetHeight || 200;
  medalMenuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
  medalMenuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
}
function closeMedalMenu() {
  if (!medalMenu) return false;
  const opener = medalMenu.opener;
  medalMenu = null;
  paintMedalMenu();
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();   // the menu's button is gone: focus must not fall to <body>
  return true;
}
// One click on a kind gives the medal and closes the menu (BACKLOG #102): no reason, no Give button.
function giveMedal(kind) {
  if (!medalMenu || !window.medalsDisplay.kindOf(kind)) return;
  sendJson({ type: 'medal', action: 'give', agent: medalMenu.agent, kind });
  closeMedalMenu();
}
if (medalMenuEl) {
  medalMenuEl.addEventListener('click', (e) => {
    const kind = e.target.closest && e.target.closest('[data-medal-kind]');
    if (kind) giveMedal(kind.dataset.medalKind);
  });
}
window.addEventListener('mousedown', (e) => {
  if (medalMenu && medalMenuEl && !medalMenuEl.contains(e.target)) closeMedalMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && closeMedalMenu()) { e.preventDefault(); e.stopPropagation(); }
}, true);
agentsEl.addEventListener('contextmenu', (e) => {
  const card = e.target.closest && e.target.closest('.agent:not([data-state="inactive"]), .agent[data-explainer]');
  if (!card || !card.dataset.agent) return;
  e.preventDefault();
  openMedalMenu(card.dataset.agent, e.clientX, e.clientY);
});
agentsEl.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-medal-open]');
  const card = btn && btn.closest('.agent');
  if (!card || !card.dataset.agent) return;
  const r = btn.getBoundingClientRect();
  openMedalMenu(card.dataset.agent, r.left, r.bottom + 2);
});

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
// The countdown step is lean-display's (tested with a fake clock); a resume after a long lean runs it too (PR #140 Dexter F7).
function stepCooldowns() {
  if (!cooldownState.length) return;
  cooldownState = leanDisplay.advanceCooldowns(cooldownState, Date.now());
  renderCooldowns();
}
setInterval(() => { if (!leanOn) stepCooldowns(); }, 15000);

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
  // #42: "62M tok" in the header (tokText, app/usage-display.js). What used to follow it ("+4.1M cache", "14 sessions") is in
  // the tooltips now, with the full breakdown.
  const num = n => (how.placeholder !== null ? how.placeholder : how.prefix + window.tokText(n));
  const title = base => (how.note ? `${base} - ${how.note}` : base);
  const sessions = `${project.sessions} session${project.sessions === 1 ? '' : 's'}`;

  usageEl.className = 'usage-' + how.state;
  usageEl.innerHTML =
    `<span class="grp" title="${title(`This session - ${detail(session)}`)}">` +
      `<span class="lbl">session</span>` +
      `<span class="val">${num(spend(session))}</span>` +
    `</span>` +
    `<span class="grp" title="${title(`Every session on this folder (${sessions}) - ${detail(project)}`)}">` +
      `<span class="lbl">project</span>` +
      `<span class="val">${num(spend(project))}</span>` +
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

// #90: when a window is used up its meter reads "Claude back in 2h 14m" (a model-scoped one, "Fable back Thu 09:00"), and when
// Claude is back "Claude is back" shows once in place of the meters for a few seconds. The strip is the only page this window
// owns (the tab views cover everything under it), so the toast lives in the strip. Every decision is in app/quota-countdown.js.
const quotaResetWatcher = createQuotaResetWatcher();
const quotaToastGate = createQuotaToastGate();
const quotaAnnounceEl = document.getElementById('quota-announce');
const BACK_TOAST_MS = 8000;
let backToastUntil = 0;
let backToastTimer = null;
let quotaTickTimer = null;
let quotaSkeleton = null;       // the meters' markup without the countdown text: unchanged means only the text needs patching

// "Visible" is what a person could see: the header is drawn (not lean, not focus mode) in a window that is showing.
function quotaHeaderVisible() {
  const header = document.querySelector('header');
  return document.visibilityState === 'visible' && !leanOn && !!header && header.getBoundingClientRect().height > 0;
}

// The next look at the header: every second in the last 90 s of a used-up window, else every 30 s. Re-armed by every render, so a
// payload that brings a reset nearer is not waited out, and armed FIRST in the tick so a throw can't end the chain.
function armQuotaTick() {
  clearTimeout(quotaTickTimer);
  quotaTickTimer = setTimeout(quotaTick, quotaTickDelayMs(lastQuotaPayload, Date.now()));
}

let quotaCountdownCounted = false;
function renderQuota(quota) {
  if (quota !== undefined) lastQuotaPayload = quota;
  armQuotaTick();            // from the payload just taken, so a reset that came nearer is not waited out at the old pace
  const nowMs = Date.now();
  const cs = quotaResetWatcher.see(lastQuotaPayload, nowMs);
  const showToast = quotaToastGate.step({ toast: cs.toast, usedUp: cs.state === 'usedUp', visible: quotaHeaderVisible() });
  if (cs.state === 'usedUp' && !quotaCountdownCounted) usage('quota:countdown-shown');       // the "Claude back in ..." countdown, once per used-up window
  quotaCountdownCounted = cs.state === 'usedUp';
  if (showToast) {
    backToastUntil = nowMs + BACK_TOAST_MS;
    clearTimeout(backToastTimer);
    backToastTimer = setTimeout(() => { quotaAnnounceEl.textContent = ''; renderQuota(); }, BACK_TOAST_MS + 50);
    quotaAnnounceEl.textContent = 'Claude is back';     // a live region that was already on the page, so it is announced
  }
  if (nowMs < backToastUntil) {
    quotaSkeleton = null;
    quotaEl.classList.remove('has-back');
    quotaEl.innerHTML = `<span class="back-toast" aria-hidden="true">Claude is back</span>`;
    return;
  }
  // A window still reported used up after its reset passed is drawn unknown, not as the old red 100% (the next poll says).
  const d = quotaDisplay(quotaSettlePastResets(lastQuotaPayload, nowMs));

  if (d.state !== 'ready') {
    // No bars. Three tracks sitting at zero would claim the plan is untouched,
    // which is precisely what we do not know here.
    quotaSkeleton = null;
    quotaEl.classList.remove('has-back');
    quotaEl.innerHTML = `<span class="none" title="${escapeHtml(d.note || '')}">${escapeHtml(d.note || '')}</span>`;
    return;
  }

  const meterHtml = (m, text) =>
    `<span class="meter tone-${m.tone}${m.isActive ? ' active' : ''}${cs.texts[m.key] ? ' back' : ''}${cs.texts[m.key] && m.key === cs.bindKey ? ' bind' : ''}" title="${escapeHtml(m.title)}">` +
      `<span class="lbl">${escapeHtml(m.label)}</span>` +
      `<span class="track"><span class="fill" style="width:${m.fill}%"></span></span>` +
      // #42: "41% · 18:00" in the header; the countdown and the rest are in the tooltip. #90: used up -> "Claude back in 2h 14m".
      `<span class="pct">${escapeHtml(text)}</span>` +
    `</span>`;
  const skeleton = d.meters.map(m => meterHtml(m, cs.texts[m.key] ? '' : m.short)).join('');
  quotaEl.classList.toggle('has-back', d.meters.some(m => cs.texts[m.key]));
  if (skeleton === quotaSkeleton) {
    // Only the countdown text moved: patch it, so the native tooltip under the pointer isn't torn down every second.
    const pcts = quotaEl.querySelectorAll('.meter.back .pct');
    d.meters.filter(m => cs.texts[m.key]).forEach((m, i) => { if (pcts[i] && pcts[i].textContent !== cs.texts[m.key]) pcts[i].textContent = cs.texts[m.key]; });
    return;
  }
  quotaSkeleton = skeleton;
  quotaEl.innerHTML = d.meters.map(m => meterHtml(m, cs.texts[m.key] || m.short)).join('');
}

// The countdown in every tooltip goes stale on its own, with no message from the host -- so it is recomputed locally. Cheap: it
// re-renders from the last payload and makes no request. Armed before anything that could throw (#90).
function quotaTick() {
  armQuotaTick();
  if (!leanOn && lastQuotaPayload) renderQuota();
}
armQuotaTick();
// A window that was hidden or minimised when Claude came back shows the held toast as soon as it is showing again.
document.addEventListener('visibilitychange', () => { if (lastQuotaPayload) renderQuota(); });

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

// `custom`: the project's own picture rather than the generated art. Only a
// custom one gets the darkness veil -- the generated SVG bakes its own dim.
// `version` busts the cache: a replaced background.png keeps its name.
// `kind` (backlog #34): 'video' draws a muted looping <video> inside #bg, under the
// same veil; anything else is the CSS background image it always was.
let bgVideoEl = null;       // the <video> in #bg, or null
let bgImageUrl = null;      // the image shown as #bg's CSS background (or stilled in lean mode), or null
let bgStillEl = null;       // lean mode: the <canvas> holding a GIF background's first frame, or null
let bgImageHeld = false;    // the image layer is currently showing its captured still (lean and not allowed to move)
let bgStillToken = 0;       // a newer background paint cancels an older still's late load
let failedBgUrl = null;     // a video the engine refused: not retried until the file changes

// What the video's play rule is fed (app/bg-media-display.js shouldPlay). `visible` joins the
// page's own visibility with main's hidden flag; the battery and the minimised flag come from main
// only and stay null (unknown) until it has said.
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const bgPlayback = { pageVisible: document.visibilityState === 'visible', hidden: null, minimised: null, onBattery: null };

function backgroundPlaybackState() {
  return {
    visible: bgPlayback.pageVisible && bgPlayback.hidden !== true,
    minimised: bgPlayback.minimised,
    onBattery: bgPlayback.onBattery,
    reducedMotion: reducedMotionQuery.matches,
    lean: leanHeld(),   // BACKLOG #62: lean mode holds a video on its first frame, except while focused and no night (Ricardo's rule)
  };
}

function syncBackgroundPlayback() {
  bgPlayback.pageVisible = document.visibilityState === 'visible';
  if (bgVideoEl) bgMedia.applyPlayback(bgVideoEl, backgroundPlaybackState());
  showPausedNote();
}

// Why a video background is standing still, in the Style tab (Miguel M2): only while there IS a
// video, and only for the reasons a person looking at the tab could be wondering about.
function pausedNoteText() {
  return bgVideoEl ? bgMedia.pausedNote(backgroundPlaybackState()) : null;
}
function showPausedNote() {
  const el = document.getElementById('style-bg-paused');
  if (!el) return;
  const note = pausedNoteText();
  el.textContent = note || '';
  el.hidden = !note;
}
document.addEventListener('visibilitychange', syncBackgroundPlayback);
reducedMotionQuery.addEventListener('change', syncBackgroundPlayback);
if (window.harness && window.harness.playback) {
  const takePlayback = (s) => {
    if (!s || typeof s !== 'object') return;
    bgPlayback.hidden = s.hidden === true ? true : s.hidden === false ? false : null;
    bgPlayback.minimised = s.minimised === true ? true : s.minimised === false ? false : null;
    bgPlayback.onBattery = s.onBattery === true ? true : s.onBattery === false ? false : null;
    syncBackgroundPlayback();
  };
  window.harness.playback.onChange(takePlayback);
  window.harness.playback.get().then(takePlayback).catch(() => { /* main has no answer: stays unknown */ });
}

// Release the decoder, not just the element: removing a <video> leaves its pipeline until GC.
function removeBackgroundVideo() {
  if (!bgVideoEl) return;
  portraitMedia.unloadVideo(bgVideoEl);
  bgVideoEl.remove();
  bgVideoEl = null;
  showPausedNote();
}

function showBackgroundVideo(url) {
  if (bgVideoEl && bgVideoEl.getAttribute('src') === url) return;      // same file: keep its place in the loop
  removeBackgroundVideo();
  const bgEl = document.getElementById('bg');
  const el = document.createElement('video');
  el.className = 'bg-video';
  el.muted = true;                     // never audio
  el.loop = true;
  el.setAttribute('playsinline', '');
  el.preload = 'auto';
  el.disablePictureInPicture = true;
  el.addEventListener('loadeddata', syncBackgroundPlayback);
  el.addEventListener('error', () => {
    // Codec or corruption: say so quietly in the Style tab and show NO background -- never a
    // black or frozen frame. The file stays; a different one is tried afresh.
    if (el !== bgVideoEl) return;
    const note = bgMedia.unplayableNote(el.error);
    failedBgUrl = url;
    clearBackgroundLayer();
    styleState = reduceVideoError(styleState, note);
    renderStylePanel();
  });
  bgVideoEl = el;
  bgEl.prepend(el);
  el.src = url;
  syncBackgroundPlayback();
}

// No background at all: the theme's own colours show through, as before one was set.
function clearBackgroundLayer() {
  removeBackgroundVideo();
  paintBackgroundImage(null);
  backgroundUrl = null;
  backgroundSetAt = null;
  document.body.classList.remove('has-bg', 'has-custom-bg');
  if (lastTheme) applyTheme(lastTheme);
}

// #92: no picture, no video: #bg is the app colour (renderer.html), darkened by the same veil as a picture. Like a picture it
// makes the terminal and panels translucent, so the colour shows through them the same way.
function setPlainColour(on) {
  plainColourOn = on;
  document.body.classList.toggle('has-plain-colour', on);
  paintPlainColour(lastTheme);
}
// The colour behind the translucent terminal in Plain colour: kept readable against the CLI's text (app/bg-media-display.js).
function paintPlainColour(theme) {
  const root = document.documentElement.style;
  const hex = plainColourOn ? bgMedia.plainColourOf(theme) : null;
  if (hex) root.setProperty('--plain-colour', hex);
  else root.removeProperty('--plain-colour');
}
function applyPlainColour() {
  removeBackgroundVideo();
  paintBackgroundImage(null);
  backgroundUrl = null;
  backgroundSetAt = null;
  failedBgUrl = null;
  setPlainColour(true);
  document.body.classList.add('has-bg', 'has-custom-bg');
  if (webglAddon) {          // as applyBackground: the WebGL renderer cannot draw over a transparent background
    try { webglAddon.dispose(); } catch {}
    webglAddon = null;
  }
}

function applyBackground(filePath, { custom = false, version = '', kind = 'image' } = {}) {
  if (!filePath) return;
  const url = bgMedia.fileUrl(filePath, version);
  const media = bgMedia.mediaFor({ kind, url });
  // mediaFor answers null for a background it can't describe; keep what is showing rather than
  // throw halfway through the swap (Miguel M5, PR #91).
  if (!media) return;
  if (media.tag === 'video' && url === failedBgUrl) return;     // already known not to play
  failedBgUrl = null;
  if (media.tag === 'video') {
    paintBackgroundImage(null);
    showBackgroundVideo(media.attrs.src);
  } else {
    removeBackgroundVideo();
    paintBackgroundImage(media.url);
  }
  backgroundUrl = url;
  backgroundSetAt = custom && version ? version : null;
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

// The background IMAGE layer. Normally the CSS background; while lean, a GIF/APNG is replaced by a canvas holding its
// first frame (a CSS background GIF keeps decoding and compositing frame after frame). A canvas, not a blob: URL: the
// page's CSP admits no blob:/data: image, and a canvas that is only displayed is never read back, so file: taint is moot.
function clearBackgroundStill() {
  bgStillToken += 1;
  if (bgStillEl) { bgStillEl.remove(); bgStillEl = null; }
}
function paintBackgroundImage(url) {
  const bgEl = document.getElementById('bg');
  clearBackgroundStill();
  bgImageUrl = url;
  if (!url) { bgEl.style.backgroundImage = ''; return; }
  bgImageHeld = leanHeld() && leanDisplay.mayAnimate(url);
  if (!bgImageHeld) { bgEl.style.backgroundImage = `url("${url}")`; return; }
  bgEl.style.backgroundImage = '';
  const token = bgStillToken;
  const img = new Image();
  img.onload = () => {
    if (token !== bgStillToken || !leanHeld()) return;
    const c = document.createElement('canvas');
    c.className = 'bg-still';
    // a viewBox-only SVG (the generated art) reports 0: size from the window and draw into that box, so cover fills it (Dexter N2)
    const size = leanDisplay.stillSize(img.naturalWidth, img.naturalHeight, window.innerWidth, window.innerHeight, /\.svg$/i.test(url.split('#')[0].split('?')[0]));
    c.width = size.width;
    c.height = size.height;
    try { c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); } catch { return; }       // cannot be drawn: no background, never a moving one
    bgEl.prepend(c);
    bgStillEl = c;
  };
  img.src = url;
}

// --- lean mode (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md) --------------------------------------------------
// Main owns ONE window-level state (app/lean-state.js) and tells every tab page; this page does what that means here:
// only the terminal shows, every panel / poller / animation is suspended, the terminal swaps WebGL for the default
// renderer, and a GIF or video background holds a still frame. What stays is what makes the project itself: its colours,
// its terminal theme, a still background, the strip's tab marks and names. app/lean-display.js holds the decisions;
// every suspendable thing registers a suspend/resume pair on the one registry below, so a new poller has one place to
// say how it stops. The page keeps the terminal and the pty untouched: typing, scrollback and `claude` carry on.
const leanBridge = window.harness && window.harness.lean;
const leanSuspender = leanDisplay.createSuspender();
let leanFacesKey = '';

// The dock: no panel is "shown" while lean (renderLayout), so each panel's hide effect runs and coming back refreshes them.
// QUIET: panels coming back are not the person opening them, so the vault (open before lean) takes no keyboard focus (PR #140 Dexter F1).
leanSuspender.register('dock', { suspend: () => renderLayout({ quiet: true }), resume: () => renderLayout({ quiet: true }) });

// The minute-ticks (the bar's ages, quota countdowns, cooldowns) skip while lean; on return they are redrawn at once.
leanSuspender.register('ticks', {
  suspend: () => { paintBar(); },
  resume: () => { paintBar(); if (lastQuotaPayload) renderQuota(); stepCooldowns(); renderCooldowns(); },
});

// The roster panel is not drawn while lean (no face videos churn); the working agents get a strip of still portraits.
leanSuspender.register('roster', {
  // the face videos are UNLOADED, not just hidden: a hidden <video> keeps its decoded buffers (PR #140 Miguel S5)
  suspend: () => { paintAgents(''); paintLeanFaces(); },
  resume: () => { paintLeanFaces(); renderRoster(); },
});

// xterm: the WebGL addon goes while lean and comes back after, only if no background forbids it (applyBackground). The
// buffer lives in xterm, not in the renderer, so scrollback survives the swap.
function setTerminalRenderer() {
  const want = leanDisplay.wantWebgl({
    lean: leanOn, hasBackground: document.body.classList.contains('has-bg'), supported: typeof WebglAddon !== 'undefined',
  });
  if (!want && webglAddon) {
    try { webglAddon.dispose(); } catch {}
    webglAddon = null;
  } else if (want && !webglAddon) {
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webglAddon = addon;
    } catch (e) { console.warn('[renderer] WebGL addon unavailable, using fallback:', e.message); }
  }
  try { term.refresh(0, term.rows - 1); } catch {}
}
// The host's local-model summary job: its only reader (the terminal bar) is hidden, so the host starts none while every window is lean
// (host/lean-gate.js). Main's process-tree sampler is NOT stopped: it drives Leftovers' 15-minute auto-reap, which matters most overnight.
function tellHostLean() {
  // ONLY to a host that lists it: an older host (they outlive app updates) would type the frame into the session as JSON (PR #140 Dexter N1)
  if (!leanDisplay.hostListsLean(hostControls)) return;
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'lean', on: leanOn })); } catch { /* not attached: the hello says it again */ } }
}
leanSuspender.register('summary-job', { suspend: tellHostLean, resume: tellHostLean });
leanSuspender.register('terminal-renderer', { suspend: setTerminalRenderer, resume: setTerminalRenderer });

// The background: a video holds its first frame (backgroundPlaybackState carries `lean`); a GIF becomes its first frame.
// Ricardo's rule (2026-10-09): while lean, an animated background (video, GIF, anything that mayAnimate) PLAYS only while the window is focused
// AND no /bedtime night is on; otherwise its captured still frame. Not lean: nothing changes. leanHeld() is that decision (lean-display).
function leanHeld() {
  return leanDisplay.holdStill({ lean: leanOn, focused: windowFocused, night: leanNight });
}
function syncLeanMotion() {
  syncBackgroundPlayback();
  if (bgImageUrl && (leanHeld() && leanDisplay.mayAnimate(bgImageUrl)) !== bgImageHeld) paintBackgroundImage(bgImageUrl);
}
leanSuspender.register('background', { suspend: syncLeanMotion, resume: syncLeanMotion });

// The working agents go to MAIN, which hands the tab strip the window's whole set to draw as still portraits next to the lean chip
// (BACKLOG #62, Ricardo's option C; app/lean-faces.js, app/tab-strip.js). They come from the roster events already arriving: no polling.
// Not lean: an empty list, so the strip shows none.
function paintLeanFaces() {
  const list = leanOn
    ? leanDisplay.workingFaces([...roster.values()], { limit: 24 }).faces.map(f => ({ agent: f.agent, images: agentImagesEnabled, portrait: f.portrait }))
    : [];
  const key = JSON.stringify(list);
  if (key === leanFacesKey) return;
  leanFacesKey = key;
  if (leanBridge) leanBridge.faces(list);
}

function applyLean(payload) {
  const s = leanDisplay.normalize(payload);
  const on = s.on;
  const nightChanged = s.night !== leanNight;
  leanNight = s.night;
  if (on === leanOn) { if (nightChanged) syncLeanMotion(); return; }
  leanOn = on;
  if (on) usage('lean:on');
  document.body.classList.toggle('lean', on);
  closeLayoutMenu();
  const { failed } = leanSuspender.set(on);
  if (failed.length) console.warn('[renderer] lean mode: these did not ' + (on ? 'suspend' : 'resume') + ': ' + failed.join(', '));
  // the keyboard is the terminal's in both directions: lean's own unmount and remount move it nowhere else
  term.focus();
}
if (leanBridge) {
  // A push that arrives before the first answer wins over it.
  let leanPushed = false;
  leanBridge.onChange((state) => { leanPushed = true; applyLean(state); });
  Promise.resolve(leanBridge.get()).then((state) => { if (!leanPushed) applyLean(state); }, () => { /* main has no answer: normal */ });
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

// --- dividers (dockable panels D1) -------------------------------------------
// Every bar between two cells resizes them. The SIZE POLICY lives in
// app/dock-tree.js (minimums, the terminal's room, shrinking with the window) and
// what a drag asks for in app/dock-tree-display.js (dragSizes / sizesAfterDrag);
// nothing here decides either.
//
// While a divider is dragged the layout is DRAWN (dragLayout) but not saved; the
// one write happens on release. A store write per move frame is what let the old
// width ratchet run frame by frame (L1, Miguel A18).
let dividerDrag = null;     // { path, i, dir, start, base, split, node, gutter, sizes }
(function initDividers() {
  const nodeAt = (layout, path) => path.reduce((n, k) => (n && n.kids ? n.kids[k] : null), layout.root);
  const splitAt = (path) => (lastPlan ? lastPlan.splits.find(s => s.path.join('.') === path.join('.')) : null);

  document.getElementById('dock').addEventListener('pointerdown', (e) => {
    const g = e.target.closest && e.target.closest('.dgutter');
    if (!g || e.button !== 0) return;
    flushKeys();                                    // a key burst still waiting to be saved is saved first
    const path = g.dataset.path === '' ? [] : g.dataset.path.split('.').map(Number);
    const base = placementLayout();
    const split = splitAt(path);
    const n = nodeAt(base, path);
    if (!split || !n) return;
    dividerDrag = { path, i: Number(g.dataset.i), dir: g.dataset.dir, start: g.dataset.dir === 'row' ? e.clientX : e.clientY, base, split, node: n, gutter: g, pointerId: e.pointerId };
    g.classList.add('dragging');
    // As the tab drag does (PR #100 Miguel I2): capture, and a drag that lost its release ends itself.
    try { g.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
    e.preventDefault();
  });
  // A drag the system took away, or whose release never came, is not a choice: drop it and draw what is saved.
  function cancelDividerDrag() {
    if (!dividerDrag) return;
    const d = dividerDrag;
    d.gutter.classList.remove('dragging');
    try { d.gutter.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
    dividerDrag = null;
    dragLayout = null;
    renderLayout();
  }
  window.addEventListener('pointermove', (e) => {
    if (!dividerDrag) return;
    if (e.buttons === 0) { cancelDividerDrag(); return; }
    const d = dividerDrag;
    const delta = (d.dir === 'row' ? e.clientX : e.clientY) - d.start;
    const sizes = window.dockTreeView.sizesAfterDrag(d.node, d.split, d.i, delta);
    d.sizes = sizes;
    if (!sizes) {
      // Nothing to ask for (back at the start, or against a minimum): draw what is saved, store nothing.
      if (dragLayout) { dragLayout = null; renderLayout(); }
      return;
    }
    dragLayout = DTm.setSplitSizes(d.base, d.path, sizes);
    renderLayout();
  });
  window.addEventListener('pointerup', () => {
    if (!dividerDrag) return;
    const d = dividerDrag;
    d.gutter.classList.remove('dragging');
    try { d.gutter.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
    dividerDrag = null;
    const moved = dragLayout !== null;
    dragLayout = null;
    // Applied to the placement as it is NOW, not as it was at pointerdown: another window may have changed it
    // meanwhile, and saving the old snapshot back would undo that (PR #100 Dexter F6). If the split isn't the
    // one that was dragged any more, the drag is dropped.
    const rebased = moved ? window.dockTreeView.rebaseDrag(committedLayout(), { path: d.path, i: d.i, node: d.node, sizes: d.sizes }) : null;
    if (rebased) commitPlacement(DTm.setSplitSizes(committedLayout(), d.path, rebased));     // the one real choice, saved once
    else renderLayout();
  });
  // A divider is a focusable separator (D4): the arrow that points along it moves it 16 px, by the rules of a drag. It is
  // DRAWN at once and SAVED once when the burst of presses ends (a held key repeats ~30 times a second, and every save is a
  // write relayed to every window); focus stays on it, and it does not glide (16 px steps would lag a key repeat).
  let keyFlush = null;
  let keyBurst = null;       // { path, i, node, sizes }: the divider pressed, as it was, and where the last press asked it to go
  // The save is a pointer release's: the burst's sizes are applied (rebaseDrag) to the placement as it is NOW, never the
  // whole layout that was drawn at the first press -- a panel docked or hidden meanwhile (Claude's own, another window's push)
  // must survive (PR #159 Dexter r2 N1). A float or divider drag in progress owns dragLayout: the burst is dropped.
  const flushKeys = () => {
    clearTimeout(keyFlush);
    keyFlush = null;
    const b = keyBurst;
    keyBurst = null;
    if (!b) return;
    if (dividerDrag || floatDrag) return;
    dragLayout = null;
    const rebased = window.dockTreeView.rebaseDrag(committedLayout(), b);
    if (rebased) commitPlacement(DTm.setSplitSizes(committedLayout(), b.path, rebased), { userAction: false });
    else renderLayout();
  };
  flushKeyBurst = flushKeys;
  window.addEventListener('pagehide', flushKeys);
  document.getElementById('dock').addEventListener('focusout', (e) => { if (e.target.closest && e.target.closest('.dgutter')) flushKeys(); });
  document.getElementById('dock').addEventListener('keydown', (e) => {
    const g = e.target.closest && e.target.closest('.dgutter');
    if (!g || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !lastPlan) return;
    if (window.dockTreeView.dividerStep(e.key, g.dataset.dir) === null) return;
    e.preventDefault();                                              // an arrow on a separator scrolls nothing
    const path = g.dataset.path === '' ? [] : g.dataset.path.split('.').map(Number);
    if (dividerDrag || floatDrag) return;
    const moved = window.dockTreeView.dividerKeySizes(placementLayout(), lastPlan.splits, path, Number(g.dataset.i), e.key);
    if (!moved) return;
    // Remembered from the FIRST press (the split as it was); each press only moves where it asks the divider to go.
    keyBurst = { path, i: Number(g.dataset.i), node: keyBurst ? keyBurst.node : moved.node, sizes: moved.sizes };
    dragLayout = DTm.setSplitSizes(placementLayout(), path, moved.sizes);
    renderLayout();
    clearTimeout(keyFlush);
    keyFlush = setTimeout(flushKeys, 400);
  });
  window.addEventListener('pointercancel', cancelDividerDrag);
  window.addEventListener('lostpointercapture', cancelDividerDrag);   // after a normal release the drag is already over
  window.addEventListener('blur', cancelDividerDrag);
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
// The area can change without the window resizing: the header wrapping onto a second line as its fields
// fill in, the diagnostics pane opening. The boxes are absolute, so nothing else would re-fit them (the
// probe found the bottom group 5 px past the area at launch). It goes through the same coalesced path.
new ResizeObserver(() => window.dispatchEvent(new Event('resize'))).observe(document.getElementById('dock'));

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
// The terminal bar's echo search (#49) hooks the same event AFTER the vim latch above: the latch's own test
// (renderer-top-bar.test.js) reads the first onWriteParsed, which must stay the latch's.
// Output arriving while a prompt is being located may be its echo (app/renderer.js locateEcho).
term.onWriteParsed(() => {
  const loc = bar.locate;
  if (!loc || loc.queued) return;
  loc.queued = true;
  setTimeout(() => { loc.queued = false; if (bar.locate === loc) locateEcho(); }, 50);
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

// --- account profiles (BACKLOG #119 A1) -------------------------------------------------------------------------------------
// The chip names the Claude account THIS tab's host runs under: the hello's `profile`, the host's own word (a host that outlived a window
// may predate the last pick). A click lists the profiles; a pick goes to main, which asks "Restart this session as ...?" itself when a
// session is live and does nothing on Cancel. The decisions are app/profile-display.js's; this is only the wiring.
const tbProfileEl = document.getElementById('tb-profile');
const tbProfileMenu = document.getElementById('tb-profile-menu');
let hostProfileId = null;        // the hello's profile; null before the first hello
let profileList = [];            // [{ id, name, colour, configDir }] as main last said
let profileNotice = null;        // why the last pick didn't take, until the next one
let profileNoticeTimer = null;

function currentProfileIsDefault() { return hostProfileId === null || hostProfileId === 'default'; }

function renderProfileChip() {
  if (!tbProfileEl) return;
  const v = profileDisplay.chipView({ profiles: profileList, currentId: hostProfileId });
  tbProfileEl.innerHTML = profileDisplay.userIconSvg() + `<span class="tb-profile-name">${escapeHtml(v.name)}</span>`;
  tbProfileEl.title = profileNotice || v.title;
  tbProfileEl.classList.toggle('unknown', !v.known);
  tbProfileEl.classList.toggle('notice', !!profileNotice);
  if (v.colour) tbProfileEl.style.setProperty('--profile-colour', v.colour);
  else tbProfileEl.style.removeProperty('--profile-colour');
}

function renderProfileMenu() {
  if (!tbProfileMenu) return;
  const m = profileDisplay.menuView({ profiles: profileList, currentId: hostProfileId });
  tbProfileMenu.textContent = '';
  const add = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text) el.textContent = text; return el; };
  for (const r of m.rows) {
    const b = add('button');
    b.type = 'button';
    b.dataset.profile = r.id;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(r.current));
    const dot = add('span', 'pm-dot');
    if (r.colour) dot.style.background = r.colour;
    b.append(dot, add('span', 'pm-name', r.name), add('span', 'pm-check', r.current ? '✓' : ''));
    tbProfileMenu.appendChild(b);
  }
  tbProfileMenu.appendChild(add('div', 'pm-sep'));
  const manage = add('button', '', m.manageLabel);
  manage.type = 'button';
  manage.dataset.manage = '1';
  tbProfileMenu.appendChild(manage);
}

function setProfileNotice(text) {
  profileNotice = text;
  clearTimeout(profileNoticeTimer);
  if (text) profileNoticeTimer = setTimeout(() => { profileNotice = null; renderProfileChip(); }, 12000);
  renderProfileChip();
}

async function refreshProfiles() {
  if (!window.harness || typeof window.harness.profilesState !== 'function') return;
  let s = null;
  try { s = await window.harness.profilesState(); } catch { s = null; }
  if (!s || !Array.isArray(s.profiles)) return;
  profileList = s.profiles;
  styleState = reduceAccounts(styleState, { profiles: s.profiles, inUse: s.inUse });
  renderProfileChip();
  renderRoster();
  // Not under a half-typed name or a rename in progress: a redraw replaces every element of the Style panel (Miguel G2).
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#style-sections [data-section=accounts]');
  if (!typing) renderStylePanel();
}

async function pickProfile(id) {
  closeTopBarMenus();
  let r = null;
  try { r = await window.harness.profilesSwitch(id); } catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
  if (r && r.ok === false && r.cancelled !== true) setProfileNotice(`didn't switch: ${r.error || 'unknown error'}`);
}

function manageProfiles() {
  closeTopBarMenus();
  revealModule('style');
  requestAnimationFrame(() => {
    const sec = document.querySelector('#style-sections [data-section="accounts"]');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
  });
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
  // A chosen accent (#64) tints the cursor whatever the model; otherwise only a known family does.
  const cursor = (family || chosenAccent(theme)) ? accent : (themeCursor || accent);
  term.options.theme = { ...term.options.theme, cursor };
  reportAccentToStrip(theme);
}

// The tab strip is the window's own page, so the accent reaches it through main
// (#64). What it gets is the look's accent -- not the model cue -- and only when
// it changed, so a model switch doesn't send anything.
let lastReportedAccent = null;
function reportAccentToStrip(theme) {
  const hex = theme && theme.chrome && theme.chrome.accent;
  if (typeof hex !== 'string' || hex === lastReportedAccent) return;
  lastReportedAccent = hex;
  if (window.harness && window.harness.reportAccent) window.harness.reportAccent(hex);
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
  typePlanned(plan.enterInsert, plan.command, (r) => {
    if (r.ok) return;
    // Only THIS request: a newer one for the same value may already have run
    // (Dexter #51 F5).
    const pending = kind === 'model' ? pendingModel : pendingEffort;
    if (request && pending === request) setPending(kind, null);
    setTopBarNotice(kind, switchNotice({ kind, result: 'refused', notice: `didn't send ${plan.command}: ${r.reason}` }));
    renderTopBar();
  });
}

/**
 * Types `command` into this tab's live box, then reads the box back: `done({ ok: true })` only if it holds
 * exactly `❯ <command>`, else it clears what was typed and `done({ ok: false, reason })`. It NEVER presses
 * Enter. ONE copy, for the top bar's switches and the Git drawer's Type /merged (PR #93 Dexter F3 / Miguel
 * I2). The keys are app/top-bar-display.js's typingKeys: Ctrl-E first (Ctrl-U deletes only back to the
 * CURSOR, Dexter r2 N1), Ctrl-U (a draft is cleared, never submitted with the command; the CLI's Ctrl+Y gets
 * it back), `i` first in vim NORMAL (Dexter r2 N2). Spaced PTY_STEP_MS apart, or a line is taken for a paste.
 */
// ONE typing sequence at a time in this tab, whoever asks (top bar, Git drawer, wand): two interleaved sequences
// share one input box, and the top bar's Enter could submit what the other typed (Dexter D8).
let typingBusy = false;
function typeAndCheck(enterInsert, command, done) {
  if (typingBusy) { done({ ok: false, reason: 'another command is still being typed' }); return; }
  typingBusy = true;
  const settle = done;
  done = (r) => { typingBusy = false; settle(r); };
  const input = data => send(JSON.stringify({ type: 'input', data }));
  const keys = typingKeys(command, enterInsert);
  keys.forEach((k, i) => setTimeout(() => input(k), PTY_STEP_MS * i));
  // Read the box back (Miguel r2): the screen was judged before the spaced writes, and a dialog opening
  // meanwhile, or anything glued to the command, would otherwise stand. Not exactly the command: clear it.
  setTimeout(() => {
    if (commandTyped(screenLines(), command, { vim: vimSeen, termRows: term.rows })) { done({ ok: true }); return; }
    input('\x05');
    setTimeout(() => input('\x15'), PTY_STEP_MS);
    // Back to NORMAL if the `i` took vim out of it (Miguel #51 3).
    if (enterInsert) setTimeout(() => input('\x1b'), PTY_STEP_MS * 2);
    done({ ok: false, reason: 'the input line changed before it could be confirmed' });
  }, PTY_STEP_MS * (keys.length + 2));
}

/**
 * The top bar's switch: typeAndCheck, then Enter -- right after the read-back, in the same task, and only
 * when it read back exactly the command. The top bar's own Enter; the wand and the Git drawer's Run /merged
 * press theirs through submitTyped (the submit gate decides), via typeCommand.
 */
function typePlanned(enterInsert, command, done) {
  const input = data => send(JSON.stringify({ type: 'input', data }));
  typeAndCheck(enterInsert, command, (r) => {
    if (r.ok) input('\r');
    done(r.ok ? r : { ok: false, reason: 'the input line changed before Enter' });
  });
}

/**
 * Types a command into this tab's own box: the Git drawer's Run /merged (main asks, PR #93 Dexter F3), the
 * wand's click, the reader's @mention. The screen is judged here, where it is, the top bar's way, and the
 * terminal takes the focus. It types and reads back. With `opts.submit` (the wand, Run /merged; BACKLOG #61) it
 * then asks submitTyped whether to press Enter, in the same task as the read-back; without it (the @mention)
 * it NEVER presses Enter. `done({ ok, box })`, `box` being what the box held before it was cleared, '' when
 * empty, plus `submitted` and `flash` (the gate's words) when `submit` was on; or `done({ ok: false, reason })`.
 * A dialog (`sessionTurn === 'prompt'`) is refused before a key is typed.
 */
// The submit path's waits (BACKLOG #61, DESIGN_WAND_SUBMIT.md "Review round picks"): F1, how long a running turn
// gets between the read-back and the Enter for a dialog to show; F7, how often and how many times the screen is
// looked at for the CLI's queued-messages line after the Enter (150 ms x 6 = 900 ms).
const SUBMIT_RECHECK_MS = 400;
const QUEUED_POLL_MS = 150;
const QUEUED_POLLS = 6;

function typeCommand(command, done, kind, opts) {
  term.focus();
  const lines = screenLines();
  if (vimInsertShown(lines)) vimSeen = true;
  const submit = !!(opts && opts.submit);
  // No refusal from the hook state here (F3): when the host says 'prompt' but the SCREEN is a normal ready box,
  // the command is typed with no Enter. planTyping's screen check is what refuses a dialog it can see.
  const plan = planTyping({
    command,
    screen: inputState(lines, { vim: vimSeen }),
    connected: !!ws && ws.readyState === WebSocket.OPEN,
    kind,                       // 'mention' types the reader's `@path#Lx-y` (never Enter, like /merged)
  });
  if (!plan.ok) { done({ ok: false, reason: plan.reason }); return; }
  const box = boxText(lines);
  typeAndCheck(plan.enterInsert, command, (r) => {
    if (!r.ok) { done(r); return; }
    if (!submit) { done({ ok: true, box: box || '' }); return; }
    // The read-back above is the last check; the gate is asked in this same task (submitTyped).
    submitTyped(command, { typeOnly: opts.typeOnly, enterInsert: plan.enterInsert }, (s) => {
      done(s.ok ? { ok: true, box: box || '', submitted: s.submitted, flash: s.flash } : s);
    });
  });
}

/**
 * Decides, from app/submit-gate.js, whether the typed command gets an Enter, and sees it through. `done` gets
 * { ok: true, submitted, flash } or { ok: false, reason }. A gate that says no ends it with the gate's own words
 * and no Enter (a type-only favourite, an unseen session, a host that says 'prompt'). A gate that says yes for an
 * idle session presses Enter at once, in the same task as the read-back. For a RUNNING turn (`recheck`, F1) it
 * waits SUBMIT_RECHECK_MS first, holding the typing lock so nobody types over the line, and sends the Enter only
 * if the box still reads back as exactly the command and the host still doesn't say 'prompt': a permission
 * dialog can open between the read-back and the Enter, and the read-back only proves what xterm had parsed.
 * Otherwise the line is cleared and the answer is a refusal. The accepted leftover risk: a dialog that lands in
 * those last milliseconds.
 */
function submitTyped(command, opts, done) {
  const typeOnly = opts.typeOnly;
  const gate = submitGate.planSubmit({ turn: sessionTurn, typeOnly });
  if (!gate.enter) { done({ ok: true, submitted: false, flash: gate.flash }); return; }
  if (!gate.recheck) { pressEnter(done, command, opts.enterInsert); return; }
  typingBusy = true;
  setTimeout(() => {
    typingBusy = false;
    const again = submitGate.planSubmit({ turn: sessionTurn, typeOnly });
    if (again.enter && commandTyped(screenLines(), command, { vim: vimSeen, termRows: term.rows })) { pressEnter(done, command, opts.enterInsert); return; }
    clearTypedLine(opts.enterInsert);
    done({ ok: false, reason: 'the screen changed while waiting to press Enter (a dialog may have opened), so nothing was sent' });
  }, SUBMIT_RECHECK_MS);
}

/**
 * The ONLY Enter that a wand click or the Git drawer's Run /merged can cause. A socket that is not OPEN drops the
 * frame silently (send()), so that is reported as not sent, never as "sent" (Dexter F6 / Miguel M1). Then the
 * flash is read off the SCREEN, not guessed from the hook state (F7): watchQueued.
 */
function pressEnter(done, command, enterInsert) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { done({ ok: false, reason: 'not connected to the session: the Enter was not sent' }); return; }
  send(JSON.stringify({ type: 'input', data: '\r' }));
  watchQueued(done, command, enterInsert);
}

/**
 * After an Enter: "queued" only if the CLI's own queued-messages line shows within the window, else "sent" (F7) -- but never "sent" while the box
 * still holds the very line that was typed: an Enter the CLI swallowed (its `\` + Enter newline, a suggestion list taking the key) submitted
 * nothing, and the status must say so (PR #125 Dexter #1, #4). The line is cleared, as a failed read-back clears it.
 */
function watchQueued(done, command, enterInsert) {
  let looks = 0;
  const look = () => {
    if (submitGate.queuedShown(screenLines())) { done({ ok: true, submitted: true, flash: submitGate.FLASH.queued }); return; }
    if (++looks >= QUEUED_POLLS) {
      if (command && boxHoldsLine(screenLines(), command)) {
        clearTypedLine(enterInsert);
        done({ ok: false, reason: 'the terminal did not take the Enter, so nothing was sent' });
        return;
      }
      done({ ok: true, submitted: true, flash: submitGate.FLASH.sent });
      return;
    }
    setTimeout(look, QUEUED_POLL_MS);
  };
  setTimeout(look, QUEUED_POLL_MS);
}

/** Empties the box of what typeCommand put there, as a failed read-back does: Ctrl-E, Ctrl-U, back to vim NORMAL. */
function clearTypedLine(enterInsert) {
  const input = data => send(JSON.stringify({ type: 'input', data }));
  input('\x05');
  setTimeout(() => input('\x15'), PTY_STEP_MS);
  if (enterInsert) setTimeout(() => input('\x1b'), PTY_STEP_MS * 2);
}

// Main asks this page to type a command into its own box (the Git drawer's Run /merged): with `submit: true`
// the page's gate presses Enter too. /merged is never a type-only favourite.
if (window.harness && window.harness.onTypeCommand) {
  window.harness.onTypeCommand((ask) => {
    const id = ask && ask.id;
    typeCommand(ask && ask.command, (r) => window.harness.typed({ id, ...r }), undefined,
      ask && ask.submit === true ? { submit: true, typeOnly: false } : undefined);
  });
}

// WAND-BEGIN
// The wand (BACKLOG #51): favourite skills as emoji buttons. app/wand-display.js decides everything (what
// shows, what a click means, what each edit sends); this is only the DOM and the socket. A click TYPES
// `/skill [args]` through typeCommand -- the one shared typeAndCheck -- and, unless the favourite is type-only,
// typeCommand's submitTyped presses Enter if the submit gate allows (BACKLOG #61). Nothing in this section writes
// a CR or an input frame itself, and test/renderer-wand-wiring.test.js pins that.
let wandState = wandDisplay.emptyState();
let wandBusy = false;          // a type in flight: two overlapping key sequences would garble the box
let wandFlashTimer = null;
let wandDragId = null;
let wandFocusEditor = false;   // an editor was just opened: it takes focus on the next draw
const wandRoot = document.getElementById('wand-root');

// Where focus was inside the panel, as something that can be found again after a rebuild: an editor field with
// its caret, or a control by what it does and which favourite / skill / emoji it is for.
function wandFocusKey(el) {
  if (!el || !el.dataset || !wandRoot || !wandRoot.contains(el)) return null;
  const d = el.dataset;
  if (d.wandField) return { field: d.wandField, start: el.selectionStart, end: el.selectionEnd };
  if (d.wandAct) return { act: d.wandAct, id: d.wandId, skill: d.wandSkill, emoji: d.wandEmoji };
  return null;
}
function wandFindFocus(k) {
  if (k.field) return wandRoot.querySelector('[data-wand-field="' + k.field + '"]');
  return [...wandRoot.querySelectorAll('button[data-wand-act]')].find(b => b.dataset.wandAct === k.act
    && b.dataset.wandId === k.id && b.dataset.wandSkill === k.skill && b.dataset.wandEmoji === k.emoji) || null;
}

function renderWand() {
  if (!wandRoot) return;
  // A redraw (a click, a quiet refresh from another host, a skill rescan) must not lose the user's place: the focused
  // control, and an editor field's text, caret and focus, are put back. A control that is gone (a favourite just
  // deleted) hands focus to the first one left, so the keyboard user is never dropped onto the page body.
  const key = wandFocusKey(document.activeElement);
  const v = wandDisplay.view(wandState);
  wandRoot.innerHTML = wandDisplay.html(v);
  // Announced from a node OUTSIDE the rebuilt subtree: a live region replaced wholesale is not read out.
  const live = document.getElementById('wand-live');
  if (live && live.textContent !== v.live) live.textContent = v.live;
  let target = null;
  if (wandFocusEditor) {
    target = wandRoot.querySelector('[data-wand-field="emoji"]');
    if (target) wandFocusEditor = false;
  }
  if (!target && key) {
    target = wandFindFocus(key) || wandRoot.querySelector('button[data-wand-act="press"]') || wandRoot.querySelector('button[data-wand-act]');
  }
  if (!target) return;
  target.focus({ preventScroll: true });
  if (key && key.field && target.dataset && target.dataset.wandField === key.field) {
    try { target.setSelectionRange(key.start, key.end); } catch { /* a field with no selection */ }
  }
}

function requestWandSkills() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;   // the hello carries them; ws.onopen follows
  try { ws.send(JSON.stringify(wandDisplay.skillsRequest())); } catch { /* not attached */ }
}

// Every edit goes through here: a send with no socket is SHOWN, never silently dropped (no answer is coming).
function wandSend(message) {
  if (!message) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    wandState = wandDisplay.failed(wandState, 'not connected to the host');
    renderWand();
    return;
  }
  ws.send(JSON.stringify(message));
}

function wandType(plan) {
  if (wandBusy) return;
  wandBusy = true;
  typeCommand(plan.command, (r) => {
    wandBusy = false;
    wandState = wandDisplay.typed(wandState, plan.id, r);
    renderWand();
    clearTimeout(wandFlashTimer);
    if (r.ok) {
      // a note about a cleared draft needs time to be read (Dexter F5)
      wandFlashTimer = setTimeout(() => { wandState = wandDisplay.clearFlash(wandState); renderWand(); }, wandState.flash && wandState.flash.long ? 8000 : 2500);
    }
  }, undefined, { submit: true, typeOnly: plan.typeOnly });
}

function wandAct(action) {
  if (action.kind === 'press') {
    const plan = wandDisplay.clickPlan(wandState, action.id, { cols: term.cols });
    if (!plan) return;
    if (plan.kind === 'type') { usage('wand:click'); wandType(plan); return; }
    if (plan.kind === 'edit') wandFocusEditor = true;
    wandState = plan.kind === 'missing' || plan.kind === 'toolong' ? wandDisplay.setNotice(wandState, plan.note) : wandDisplay.openEditor(wandState, plan.id);
  } else if (action.kind === 'toggle-edit') {
    wandState = wandDisplay.toggleEdit(wandState);
  } else if (action.kind === 'add') {
    wandFocusEditor = true;
    wandState = wandDisplay.openEditor(wandState, null);
  } else if (action.kind === 'cancel') {
    wandState = wandDisplay.closeEditor(wandState);
  } else if (action.kind === 'pick-skill') {
    wandState = wandDisplay.editorSet(wandState, 'skill', action.skill);
  } else if (action.kind === 'pick-emoji') {
    wandState = wandDisplay.editorSet(wandState, 'emoji', action.emoji);
  } else if (action.kind === 'move-step') {
    const r = wandDisplay.moveStepMsg(wandState, action.id, action.dir);
    wandState = r.state;
    wandSend(r.message);
  } else if (action.kind === 'delete' || action.kind === 'save' || action.kind === 'reset') {
    const r = action.kind === 'delete' ? wandDisplay.deleteMsg(wandState, action.id)
      : action.kind === 'reset' ? wandDisplay.resetMsg(wandState) : wandDisplay.editorSubmit(wandState);
    wandState = r.state;
    wandSend(r.message);
  }
  renderWand();
}

if (wandRoot) {
  // Delegated, so a redraw never needs rebinding.
  wandRoot.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-wand-act]');
    const action = btn && wandDisplay.clickAction(btn.dataset);
    if (action) wandAct(action);
  });
  wandRoot.addEventListener('input', (e) => {
    const field = e.target && e.target.dataset && e.target.dataset.wandField;
    if (!field) return;
    // the type-only checkbox is a boolean (editorSet takes it as nothing else); the text fields are strings
    wandState = wandDisplay.editorSet(wandState, field, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    if (field === 'query') {       // only the list: the box the user is typing in is left alone
      const list = wandRoot.querySelector('.wand-skill-list');
      if (list) list.innerHTML = wandDisplay.skillListHtml(wandDisplay.view(wandState));
    }
  });
  wandRoot.addEventListener('keydown', (e) => {
    // Alt+Left / Alt+Right on a favourite in edit mode: the keyboard's reorder (drag is mouse-only).
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest) {
      const b = e.target.closest('button[data-wand-act="press"][draggable="true"]');
      if (b) { e.preventDefault(); wandAct({ kind: 'move-step', id: b.dataset.wandId, dir: e.key === 'ArrowLeft' ? -1 : 1 }); return; }
    }
    if (!(e.target && e.target.dataset && e.target.dataset.wandField)) return;
    // Enter in the skill SEARCH box is not Save: it would save with whatever skill was picked before (or fail with
    // "Pick a skill"), when the person is only searching.
    if (e.target.dataset.wandField === 'query') { if (e.key === 'Enter') e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); wandAct({ kind: 'save' }); }
    else if (e.key === 'Escape') { e.preventDefault(); wandAct({ kind: 'cancel' }); }
  });
  // Reorder by dragging (edit mode). Stopped here, so the page-wide file-drop handler never sees it.
  wandRoot.addEventListener('dragstart', (e) => {
    const b = e.target.closest && e.target.closest('button[data-wand-act="press"][draggable="true"]');
    if (!b) return;
    wandDragId = b.dataset.wandId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-wand-favourite', wandDragId);
  });
  wandRoot.addEventListener('dragover', (e) => {
    if (!wandDragId) return;
    e.stopPropagation();
    if (e.target.closest && e.target.closest('[data-wand-cell]')) e.preventDefault();
  });
  wandRoot.addEventListener('drop', (e) => {
    const cell = e.target.closest && e.target.closest('[data-wand-cell]');
    if (!wandDragId) return;
    e.stopPropagation();
    e.preventDefault();
    const from = wandDragId;
    wandDragId = null;
    if (!cell) return;
    const r = wandDisplay.moveMsg(wandState, from, cell.dataset.wandCell);
    wandState = r.state;
    wandSend(r.message);
    renderWand();
  });
  wandRoot.addEventListener('dragend', () => { wandDragId = null; });
  renderWand();
}
// WAND-END

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
  const open = (tbModelMenu && !tbModelMenu.hidden) || (tbEffortMenu && !tbEffortMenu.hidden) || (tbProfileMenu && !tbProfileMenu.hidden);
  if (tbModelMenu) tbModelMenu.hidden = true;
  if (tbEffortMenu) tbEffortMenu.hidden = true;
  if (tbProfileMenu) tbProfileMenu.hidden = true;
  return open;
}

function submitCustomModel() {
  if (!tbModelCustom) return;
  requestSwitch('model', tbModelCustom.value);
  tbModelCustom.value = '';
  closeTopBarMenus();
}

if (tbProfileEl) {
  tbProfileEl.addEventListener('click', () => {
    const opening = tbProfileMenu && tbProfileMenu.hidden;
    if (opening) { if (tbModelMenu) tbModelMenu.hidden = true; if (tbEffortMenu) tbEffortMenu.hidden = true; renderProfileMenu(); }
    toggleMenu(tbProfileMenu, null, tbProfileEl);
  });
}
if (tbProfileMenu) {
  tbProfileMenu.addEventListener('click', (e) => {
    const row = e.target.closest('[data-profile]');
    if (row) { pickProfile(row.dataset.profile); return; }
    if (e.target.closest('[data-manage]')) manageProfiles();
  });
}
// Opening the model or effort menu puts the profile menu away (their own handlers only know each other).
for (const chip of [tbModelEl, tbEffortEl]) if (chip) chip.addEventListener('click', () => { if (tbProfileMenu) tbProfileMenu.hidden = true; }, true);
if (window.harness && typeof window.harness.onProfilesChanged === 'function') window.harness.onProfilesChanged(refreshProfiles);   // another tab or window edited the store
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
  const kind = (msg.style ? msg.style.kind : msg.kind) === 'video' ? 'video' : 'image';
  // Backlog #25: a light look puts a white veil over the art (renderer.html), whichever picture it is.
  document.documentElement.setAttribute('data-look-mode', look.mode === 'light' ? 'light' : 'dark');
  // #92: Plain colour shows the app colour and no media; the picture's file stays, so leaving it paints the picture again.
  if (look.backgroundMode === 'colour') {
    applyPlainColour();
  } else {
    setPlainColour(false);
    applyBackground(msg.background, { custom: source === 'override', version: setAt, kind });
  }
  if (typeof look.darkness === 'number') {
    document.documentElement.style.setProperty('--bg-darkness', String(look.darkness));
  }
  // #88: the project's own terminal font (a message with no look at all says nothing about it).
  if (msg.style ? msg.style.look : msg.look) projectTerminalFont = fontsDisplay.sanitizeFamily(look.terminalFont);
  if (msg.theme) applyTheme(msg.theme);
  else applyFonts();
}

// The picture's pixels, small: the image, or the video's CURRENT frame, drawn onto a 64x64
// canvas. They are read here and reduced to a few hex colours by colourSeeds; only those colours
// are ever sent anywhere (test/style-actions.test.js pins it).
const SAMPLE_SIDE = 64;
async function sampleBackgroundFrame() {
  let source;
  if (bgVideoEl) {
    if (!(bgVideoEl.readyState >= 2 && bgVideoEl.videoWidth > 0)) throw new Error('the video has no frame yet');
    source = bgVideoEl;
  } else if (backgroundUrl) {
    source = new Image();
    source.src = backgroundUrl;
    await source.decode();
  } else {
    throw new Error('there is no background to read');
  }
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIDE;
  canvas.height = SAMPLE_SIDE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, SAMPLE_SIDE, SAMPLE_SIDE);
  return ctx.getImageData(0, 0, SAMPLE_SIDE, SAMPLE_SIDE).data;
}

// `ask` names the section asking; the host echoes it on the reply, so a
// refusal is shown where it belongs even with another request in flight.
function sendStyle(section, payload) {
  try { ws.send(JSON.stringify({ type: 'style', ask: section, ...payload })); } catch { /* not attached */ }
  usage('style:changed');
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
      `<span class="style-label">Mode</span><div class="style-row">` +
      `<button type="button" id="style-mode-dark" aria-pressed="${v.mode === 'dark'}"${v.mode === 'dark' ? ' class="seated"' : ''}>Dark</button>` +
      `<button type="button" id="style-mode-light" aria-pressed="${v.mode === 'light'}"${v.mode === 'light' ? ' class="seated"' : ''}>Light</button></div>` +
      (v.cliNote ? `<div class="style-note" id="style-mode-note">${escapeHtml(v.cliNote)}</div>` : '') +
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
  if (section.id === 'fonts') {
    const f = fontsDisplay.sectionView(fontSettings, projectTerminalFont, lastTheme && lastTheme.font ? lastTheme.font.size : null);
    if (!f.known) {
      return `<section class="style-section" data-section="fonts">${header}<div class="style-current">reading…</div></section>`;
    }
    // Ids written out in full: test/renderer-scope.test.js finds them by text.
    return (
      `<section class="style-section" data-section="fonts">${header}` +
      `<div class="style-current">Every window uses these. The terminal list shows fixed-width fonts only.</div>` +
      fontPickerHtml('Terminal font', 'term', f.terminalFont, 'Default (the theme)',
        'id="style-font-term-search"', 'id="style-font-term-list"', 'id="style-font-term-reset"') +
      `<span class="style-label">Terminal size</span><div class="style-row">` +
      `<input type="range" id="style-font-size" min="${fontsDisplay.MIN_TERMINAL_SIZE}" max="${fontsDisplay.MAX_TERMINAL_SIZE}" step="1" value="${f.size}">` +
      `<span class="style-val" id="style-font-size-val">${f.size} px</span></div>` +
      fontPickerHtml('Interface font', 'ui', f.uiFont, 'Default (Segoe UI)',
        'id="style-font-ui-search"', 'id="style-font-ui-list"', 'id="style-font-ui-reset"') +
      fontPickerHtml("This project's terminal font", 'project', f.projectFont, 'Same as every window',
        'id="style-font-project-search"', 'id="style-font-project-list"', 'id="style-font-project-reset"') +
      `</section>`
    );
  }
  if (section.id === 'background' && v) {
    const dark = v.darknessPercent;
    return (
      `<section class="style-section" data-section="background">${header}` +
      `<div class="style-current">${escapeHtml(v.description)}</div>` +
      `<span class="style-label">Background</span><div class="style-row">` +
      `<button type="button" id="style-bg-mode-image" aria-pressed="${!v.plainColour}"${v.plainColour ? '' : ' class="seated"'}>Image / video</button>` +
      `<button type="button" id="style-bg-mode-colour" aria-pressed="${v.plainColour}"${v.plainColour ? ' class="seated"' : ''}>Plain colour</button></div>` +
      `<div class="style-dropzone" id="style-bg-drop" tabindex="0">drop an image or a short video here, or ` +
      `<label class="style-browse">choose a file<input type="file" id="style-bg-file" ` +
      `accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/webm,video/mp4" hidden></label></div>` +
      (v.note ? `<div class="style-note">${escapeHtml(v.note)}</div>` : '') +
      ((pn) => `<div class="style-paused" id="style-bg-paused"${pn ? '' : ' hidden'}>${escapeHtml(pn || '')}</div>`)(pausedNoteText()) +
      (v.showVeil
        ? `<span class="style-label">${escapeHtml(v.veilLabel)}</span><div class="style-row">` +
          `<input type="range" id="style-dark" min="0" max="95" step="1" value="${dark === null ? 50 : dark}">` +
          `<span class="style-val" id="style-dark-val">${dark === null ? '—' : dark + '%'}</span></div>`
        : '') +
      `<button type="button" id="style-match"${v.canMatch ? '' : ' disabled'} ` +
      `title="A palette taken from this background's own colours, checked for contrast">Match colours to this background</button>` +
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
  if (section.id === 'tray' && v) {
    // Ids written out in full: test/renderer-scope.test.js finds them by text.
    const state = (on) => `${on === true ? ' checked' : ''}${on === null ? ' disabled' : ''}`;
    return (
      `<section class="style-section" data-section="tray">${header}` +
      `<label class="style-row"><input type="checkbox" id="style-tray-icon"${state(v.trayIcon)}>` +
      ` Tray icon</label>` +
      `<div class="style-note">${escapeHtml(v.trayDescription)}</div>` +
      `<label class="style-row"><input type="checkbox" id="style-tray-close"${state(v.minimiseOnClose)}>` +
      ` Minimise to tray on close</label>` +
      `<div class="style-note">${escapeHtml(v.closeDescription)}</div>` +
      `</section>`
    );
  }
  if (section.id === 'panel' && v) {
    // Id written out in full: test/renderer-scope.test.js finds it by text.
    return (
      `<section class="style-section" data-section="panel">${header}` +
      `<label class="style-row"><input type="checkbox" id="style-canvas-mcp"${v.mcp === true ? ' checked' : ''}${v.mcp === null ? ' disabled' : ''}>` +
      ` Let Claude build in its panel (next session)</label>` +
      `<div class="style-note">${escapeHtml(v.mcpDescription)}</div>` +
      `<label class="style-row"><input type="checkbox" id="style-cc-mod"${v.mod === true ? ' checked' : ''}${v.mod === null ? ' disabled' : ''}>` +
      ` Feed quota, context and agent states from the CLI (next session)</label>` +
      `<div class="style-note">${escapeHtml(v.modDescription)}</div>` +
      `</section>`
    );
  }
  if (section.id === 'accounts' && v) {
    // Ids and data attributes written out in full: test/renderer-scope.test.js finds them by text.
    if (!v.known) return `<section class="style-section" data-section="accounts">${header}<div class="style-current">reading…</div></section>`;
    const rows = v.rows.map((r) => (
      `<div class="acct-row" data-acct="${escapeHtml(r.id)}">` +
      `<span class="acct-dot"${r.colour ? ` style="background:${escapeHtml(r.colour)}"` : ''}></span>` +
      `<input type="text" class="acct-name" value="${escapeHtml(r.name)}" maxlength="40" aria-label="Profile name"${r.canRename ? '' : ' disabled'}>` +
      (r.canRename ? `<button type="button" data-acct-rename="${escapeHtml(r.id)}">Rename</button>` : '') +
      (r.canOpenFolder ? `<button type="button" data-acct-open="${escapeHtml(r.id)}">Open folder</button>` : '') +
      (r.isDefault ? '' : `<button type="button" data-acct-remove="${escapeHtml(r.id)}"${r.canRemove ? '' : ` disabled title="${escapeHtml(r.removeWhy || '')}"`}>Remove</button>`) +
      `</div><div class="acct-folder">${escapeHtml(r.folder || '')}</div>`
    )).join('');
    return (
      `<section class="style-section" data-section="accounts">${header}` + rows +
      (v.error ? `<div class="style-error">${escapeHtml(v.error)}</div>` : '') +
      `<div class="acct-add"><input type="text" id="acct-new-name" placeholder="New profile name" maxlength="40" aria-label="New profile name">` +
      `<input type="color" id="acct-new-colour" value="${escapeHtml(v.addColourDefault)}" aria-label="Profile colour">` +
      `<input type="text" id="acct-new-folder" placeholder="Folder (optional)" aria-label="Profile folder"><button type="button" id="acct-add">Add</button></div>` +
      `<div class="style-note">${escapeHtml(v.addFolderHint)}</div><div class="style-note">${escapeHtml(v.note)}</div></section>`
    );
  }
  // A future section with no view function yet still gets its title drawn,
  // rather than vanishing -- "say something rather than nothing", the same
  // rule the fog and projects panels follow for a failed read.
  return `<section class="style-section" data-section="${escapeHtml(section.id)}">${header}</section>`;
}

// The accent colour picker's live preview (#64). It takes the path a saved look takes: the same
// readable-on-the-panel colour and label colour (app/accent-preview.js, pinned against host/look.js),
// so nothing jumps on commit; and at most once per animation frame, since each repaint also costs an
// IPC to main and a send to the strip while the picker fires `input` dozens of times a second.
let previewAccentFrame = null;
function previewAccent(hex) {
  if (!previewAccentFrame) {
    previewAccentFrame = accentPreview.frameThrottle((cb) => requestAnimationFrame(cb), paintAccentPreview);
  }
  previewAccentFrame(hex);
}
function paintAccentPreview(hex) {
  const p = accentPreview.previewChrome(hex, currentTheme && currentTheme.chrome);
  if (!p) return;
  const root = document.documentElement.style;
  root.setProperty('--accent', p.accent);
  root.setProperty('--on-accent', p.onAccent);
  currentTheme = withChosenAccent(currentTheme, p.accent, p.onAccent);
  renderTopBar();
}

// BACKLOG #119 A1: the Accounts section's controls. Every edit goes to main (it owns the store); the list that comes back replaces ours.
function takeAccountsReply(r) {
  if (r && r.ok === true) { styleState = reduceAccounts(styleState, { profiles: r.profiles, inUse: r.inUse }); profileList = r.profiles; renderProfileChip(); }
  else styleState = reduceAccounts(styleState, { error: (r && r.error) || 'that didn\'t work' });
  renderStylePanel();
}
function bindAccountsSection() {
  const h = window.harness;
  if (!h || typeof h.profilesAdd !== 'function') return;
  const addBtn = document.getElementById('acct-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
      h.profilesAdd({ name: val('acct-new-name'), colour: val('acct-new-colour'), configDir: val('acct-new-folder').trim() }).then(takeAccountsReply, () => takeAccountsReply(null));
    });
  }
  for (const b of document.querySelectorAll('[data-acct-rename]')) {
    b.addEventListener('click', () => {
      const input = b.closest('.acct-row').querySelector('.acct-name');
      h.profilesRename(b.dataset.acctRename, input ? input.value : '').then(takeAccountsReply, () => takeAccountsReply(null));
    });
  }
  for (const b of document.querySelectorAll('[data-acct-remove]')) {
    b.addEventListener('click', () => h.profilesRemove(b.dataset.acctRemove).then(takeAccountsReply, () => takeAccountsReply(null)));
  }
  for (const b of document.querySelectorAll('[data-acct-open]')) {
    b.addEventListener('click', () => h.profilesOpenFolder(b.dataset.acctOpen).then((r) => { if (r && r.ok === false) takeAccountsReply(r); }, () => takeAccountsReply(null)));
  }
}

function renderStylePanel() {
  const container = document.getElementById('style-sections');
  if (!container) return;
  // A redraw replaces every element: a font search box the person is typing in must keep its focus and caret.
  const active = document.activeElement;
  const id = active && container.contains(active) && active.classList.contains('font-search') ? active.id : null;
  const caret = id ? active.selectionStart : null;
  container.innerHTML = styleDisplay(styleState).map(renderStyleSection).join('');
  bindStyleSections();
  if (id) {
    const again = document.getElementById(id);
    if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
  }
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
  bindFontSection();
  bindAccountsSection();

  const reroll = document.getElementById('style-reroll');
  if (reroll) reroll.addEventListener('click', () => sendStyle('colours', { action: 'reroll-look' }));

  const modeDark = document.getElementById('style-mode-dark');
  if (modeDark) modeDark.addEventListener('click', () => sendStyle('colours', { action: 'set-mode', mode: 'dark' }));
  const modeLight = document.getElementById('style-mode-light');
  if (modeLight) modeLight.addEventListener('click', () => sendStyle('colours', { action: 'set-mode', mode: 'light' }));

  const match = document.getElementById('style-match');
  if (match) {
    match.addEventListener('click', async () => {
      match.disabled = true;
      try {
        // Which background is being read, taken BEFORE the await: the host refuses the match if it
        // is no longer the one showing by the time the seeds arrive (Dexter D5).
        const setAt = backgroundSetAt;
        const seeds = colourSeeds.seedsOf(await sampleBackgroundFrame());
        sendStyle('background', { action: 'match-colours', seeds, setAt });
      } catch (err) {
        styleState = reduceStyle(styleState, { type: 'style', ask: 'background',
          error: `couldn't read this background's colours: ${err && err.message ? err.message : 'unknown reason'}` });
        renderStylePanel();
      } finally {
        // sendStyle swallows a closed socket, so no reply may ever come to redraw the button: never
        // leave it disabled for good (Miguel M3, PR #91). A reply that does come redraws it anyway.
        match.disabled = false;
      }
    });
  }

  // #92: Image / video and Plain colour. The picture's file is never touched by either.
  const modeImage = document.getElementById('style-bg-mode-image');
  if (modeImage) modeImage.addEventListener('click', () => sendStyle('background', { action: 'set-look', look: { backgroundMode: null } }));
  const modeColour = document.getElementById('style-bg-mode-colour');
  if (modeColour) modeColour.addEventListener('click', () => sendStyle('background', { action: 'set-look', look: { backgroundMode: 'colour' } }));

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
    if (plainColourOn) root.setProperty('--plain-colour', hex);
    if (!backgroundUrl && !plainColourOn) term.options.theme = { ...term.options.theme, background: hex };
  });
  bindColour(document.getElementById('style-text'), document.getElementById('style-text-hex'),
    document.getElementById('style-text-reset'), 'textColor',
    (hex) => document.documentElement.style.setProperty('--text', hex));
  bindColour(document.getElementById('style-accent'), document.getElementById('style-accent-hex'),
    document.getElementById('style-accent-reset'), 'accentColor',
    previewAccent);
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
  // #71 question 8: Claude's panel on or off for the next session. Send the DESIRED state; main answers what the file now says, and null
  // (a failed save) re-reads the truth instead of trusting the click.
  const canvasMcpBox = document.getElementById('style-canvas-mcp');
  if (canvasMcpBox && window.harness && window.harness.canvas) {
    canvasMcpBox.addEventListener('change', () => {
      window.harness.canvas.settingsSet(canvasMcpBox.checked).then(settledCanvasMcp).catch(() => refreshCanvasMcp());
    });
  }
  // BACKLOG #119 A2: the claude-custom mod's switch, the same shape: send the desired state, settle on main's answer, re-read on null.
  const ccModBox = document.getElementById('style-cc-mod');
  if (ccModBox && window.harness && window.harness.ccMod) {
    ccModBox.addEventListener('change', () => {
      window.harness.ccMod.settingsSet(ccModBox.checked).then(settledCcMod).catch(() => refreshCcMod());
    });
  }
  // BACKLOG #119 A8: the tray icon and minimise-on-close. Send the DESIRED state; main answers what it saved, and null (a failed
  // save) re-reads the truth instead of trusting the click.
  const tray = window.harness && window.harness.tray;
  const trayIconBox = document.getElementById('style-tray-icon');
  if (trayIconBox && tray) {
    trayIconBox.addEventListener('change', () => { tray.set('trayIcon', trayIconBox.checked).then(settledTray).catch(refreshTraySettings); });
  }
  const trayCloseBox = document.getElementById('style-tray-close');
  if (trayCloseBox && tray) {
    trayCloseBox.addEventListener('change', () => { tray.set('minimiseOnClose', trayCloseBox.checked).then(settledTray).catch(refreshTraySettings); });
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
// fields stay hidden, and the page asks again every second. The CLI's own row
// is only quiet when the file says an explicit true, which main writes as the
// default, so a gap with the fields nowhere is a moment, never a state.
let chromeSettings = { statusInHeader: null, framelessWindow: null };
function applyChromeSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  styleState = reduceChromeSettings(styleState, settings);
  chromeSettings = styleState.window;
  renderStatusFields(lastStatusFields);
  renderStylePanel();
}
// #71 question 8: the panel's MCP switch. Null (main couldn't read the file) stays unknown and asks again; never a guessed answer.
function settledCanvasMcp(value) {
  if (typeof value === 'boolean') { styleState = reduceCanvasMcp(styleState, value); renderStylePanel(); } else refreshCanvasMcp();
}
// ONE loop at a time, backing off and then stopping (PR #125 Miguel M3): a file main cannot read used to be asked about every second for the life
// of the window, and a failed save could stack a second loop on top of a running one.
let canvasMcpLoop = false;
function refreshCanvasMcp(attempt = 0) {
  if (!(window.harness && window.harness.canvas && window.harness.canvas.settingsGet)) return;
  if (attempt === 0) { if (canvasMcpLoop) return; canvasMcpLoop = true; }
  const again = () => {
    const wait = canvasMcpRetryDelay(attempt);
    if (wait === null) { canvasMcpLoop = false; return; }
    setTimeout(() => refreshCanvasMcp(attempt + 1), wait);
  };
  window.harness.canvas.settingsGet().then((v) => {
    if (typeof v === 'boolean') { canvasMcpLoop = false; settledCanvasMcp(v); } else again();
  }).catch(again);
}
// BACKLOG #119 A2: the mod's switch, read the same way as the panel's (one loop, backing off with the same delays, then stopping).
function settledCcMod(value) {
  if (typeof value === 'boolean') { styleState = reduceCcMod(styleState, value); renderStylePanel(); } else refreshCcMod();
}
let ccModLoop = false;
function refreshCcMod(attempt = 0) {
  if (!(window.harness && window.harness.ccMod && window.harness.ccMod.settingsGet)) return;
  if (attempt === 0) { if (ccModLoop) return; ccModLoop = true; }
  const again = () => {
    const wait = canvasMcpRetryDelay(attempt);
    if (wait === null) { ccModLoop = false; return; }
    setTimeout(() => refreshCcMod(attempt + 1), wait);
  };
  window.harness.ccMod.settingsGet().then((v) => {
    if (typeof v === 'boolean') { ccModLoop = false; settledCcMod(v); } else again();
  }).catch(again);
}
// BACKLOG #119 A8: main's tray switches. Null (main couldn't read the file) stays unknown and asks again, never a guessed answer.
function applyTraySettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  styleState = reduceTraySettings(styleState, settings);
  renderStylePanel();
}
function settledTray(saved) {
  if (saved && typeof saved === 'object') applyTraySettings(saved);
  else refreshTraySettings();
}
function refreshTraySettings() {
  if (!(window.harness && window.harness.tray)) return;
  window.harness.tray.get().then((s) => {
    if (s && typeof s === 'object') applyTraySettings(s);
    else setTimeout(refreshTraySettings, 1000);
  }).catch(() => setTimeout(refreshTraySettings, 1000));
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
  if (changed && askPanel) askPanel.repaint();      // the Ask panel's face follows the same switch
  styleState = reduceImagesEnabled(styleState, enabled);
  const btn = document.getElementById('images-toggle');
  if (btn) {
    btn.classList.toggle('off', !enabled);
    btn.setAttribute('aria-pressed', String(enabled));
    btn.title = enabled ? 'Agent images are shown. Click to turn them off.'
      : 'Agent images are off (initials only). Click to turn them on.';
  }
  if (changed) { renderRoster(); renderStylePanel(); }
  paintBubbles();          // agent images off means none of these (BACKLOG #80)
  tellHostBubblesVisible();
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
refreshTraySettings();             // BACKLOG #119 A8: the tray switches in the Style tab
refreshCanvasMcp();                // #71 question 8: the panel's switch in the Style tab
refreshCcMod();                    // #119 A2: the claude-custom mod's switch, next to it

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
  pickAndSetPortrait(agent, state);
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
    windowFocused = focused === true;
    syncLeanMotion();
  });
}
refreshDim();

// --- fonts (BACKLOG #88) -------------------------------------------------------
// What decides the fonts is app/fonts-display.js; main stores the app-wide pick (app/fonts-bridge.js) and a project's look can
// override the terminal font. This is the wiring: paint the terminal and the two CSS variables, and draw the pickers.
let fontFitTimer = null;
function applyFonts() {
  const themeFont = lastTheme && lastTheme.font ? lastTheme.font : null;
  const eff = fontsDisplay.effectiveTerminal({ settings: fontSettings, projectFont: projectTerminalFont, themeFont });
  const root = document.documentElement.style;
  const picked = fontsDisplay.sanitizeFamily(projectTerminalFont) || (fontSettings && fontsDisplay.sanitizeFamily(fontSettings.terminalFont));
  // The monospace UI (code reader, Files tree, ...) follows the terminal's PICK; with none it keeps its own stack.
  if (picked) root.setProperty('--font-mono', fontsDisplay.stackFor(picked, 'mono'));
  else root.removeProperty('--font-mono');
  const ui = fontSettings && fontsDisplay.sanitizeFamily(fontSettings.uiFont);
  if (ui) root.setProperty('--font-ui', fontsDisplay.stackFor(ui, 'ui'));
  else root.removeProperty('--font-ui');
  window.dockTreeView.refitRails(document);        // the rail names are measured in the UI font, which may just have changed
  if (term.options.fontFamily === eff.fontFamily && term.options.fontSize === eff.fontSize) return;
  term.options.fontFamily = eff.fontFamily;
  term.options.fontSize = eff.fontSize;
  // A font change alters the cell size, so the pty must be told the new geometry or Ink's layout corrupts.
  clearTimeout(fontFitTimer);
  fontFitTimer = setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 0);
}

// A tab that was in the background misses a focus-mode or lean push, and its rails measured zero while hidden: fit them when it shows.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') window.dockTreeView.refitRails(document); });

// A web font that finishes loading changes the names' widths too: fit the rails once the page's fonts are ready.
// (The saved font arrives asynchronously through takeFontSettings -> applyFonts, which refits too; a web font that loads later fires loadingdone.)
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => window.dockTreeView.refitRails(document, true), () => {});
if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => window.dockTreeView.refitRails(document, true));

function takeFontSettings(raw) {
  fontSettings = fontsDisplay.sanitizeSettings(raw);
  applyFonts();
  renderStylePanel();
}

function refreshFontSettings() {
  if (!(window.harness && window.harness.fonts)) return;
  window.harness.fonts.get().then((r) => {
    // ok / missing / corrupt are all answers (a corrupt record reads as the defaults, and the next pick repairs it).
    // Unreadable (a transient lock) says nothing about the person's choice: stay unknown and ask again.
    if (r && (r.status === 'ok' || r.status === 'missing' || r.status === 'corrupt')) takeFontSettings(r.settings);
    else setTimeout(refreshFontSettings, 1000);
  }).catch(() => setTimeout(refreshFontSettings, 1000));
}

// Send ONLY the changed field(s) -- main merges them into the record as it is now; it answers what it stored, and null (a failed save) re-reads the truth instead of trusting the click.
function setFontSettings(patch) {
  if (!(window.harness && window.harness.fonts) || !fontSettings) return;
  window.harness.fonts.set(patch)
    .then((saved) => { if (saved) takeFontSettings(saved); else refreshFontSettings(); })
    .catch(refreshFontSettings);
}

if (window.harness && window.harness.fonts) {
  window.harness.fonts.onChange(takeFontSettings);     // another window's pick
  refreshFontSettings();
}

let fontMeasureCtx = null;
function isFixedFamily(name) {
  if (fixedFamilyCache.has(name)) return fixedFamilyCache.get(name);
  if (!fontMeasureCtx) fontMeasureCtx = document.createElement('canvas').getContext('2d');
  const ctx = fontMeasureCtx;
  // The generic fallback is a PROPORTIONAL face on purpose: a family that is not really there measures proportional, never fixed.
  const fixed = fontsDisplay.isFixedWidth((text) => { ctx.font = `16px "${name}", serif`; return ctx.measureText(text).width; });
  fixedFamilyCache.set(name, fixed);
  return fixed;
}

// Whether the Fonts section is in front of the person: the Style panel is on screen (and the window is not in lean mode).
function fontsSectionShown() { return shownModules.has('style') && !leanOn; }

// Asked only once the Fonts section is shown (enumerating spawns a process, measuring touches every family), and again after
// FONT_LIST_REFRESH_MS so a font installed later appears. A FAILED answer counts as an answer for the timing (`fontListAt`), so a
// broken enumeration is retried after the window, not on every redraw.
function ensureFontList() {
  if (!(window.harness && window.harness.fonts)) return;
  if (!fontsDisplay.shouldAskForList({ visible: fontsSectionShown(), haveList: fontListAt > 0, lastAt: fontListAt, now: Date.now(),
    ttlMs: FONT_LIST_REFRESH_MS, busy: fontListBusy })) return;
  fontListBusy = true;
  window.harness.fonts.list().then((r) => {
    fontListAt = Date.now();
    if (r && r.ok === true && Array.isArray(r.families)) {
      const changed = !fontFamilies || fontFamilies.join('\n') !== r.families.join('\n');
      const hadError = fontListError !== null;
      fontFamilies = r.families;
      fontListError = null;
      // An error that clears must be redrawn away even when the list itself is the same one.
      if (changed || hadError) { if (changed) fixedFamilyCache.clear(); renderStylePanel(); }
    } else {
      fontListError = (r && r.error) || "couldn't list the installed fonts";
      renderStylePanel();
    }
  }).catch((err) => {
    fontListAt = Date.now();
    fontListError = `couldn't list the installed fonts: ${(err && err.message) || 'unknown reason'}`;
    renderStylePanel();
  }).finally(() => { fontListBusy = false; });
}

function fontRowsHtml(kind, current) {
  if (fontListError) return `<div class="font-empty">${escapeHtml(fontListError)}</div>`;
  if (!fontFamilies) return `<div class="font-empty">listing the installed fonts…</div>`;
  const all = fontsDisplay.filterFonts(fontFamilies, fontQueries[kind], { fixedOnly: kind !== 'ui', isFixed: isFixedFamily });
  if (!all.length) return `<div class="font-empty">${kind !== 'ui' ? 'no fixed-width font matches' : 'no font matches'}</div>`;
  // A listbox with one tab stop (the picked row, else the first); the arrow keys move between rows (bindFontPicker).
  const shown = all.slice(0, FONT_ROWS_SHOWN);
  const stop = shown.includes(current) ? current : shown[0];
  const rows = shown.map((name) =>
    `<button type="button" role="option" class="font-row${name === current ? ' seated' : ''}" aria-selected="${name === current}" ` +
    `tabindex="${name === stop ? 0 : -1}" data-font="${escapeHtml(name)}">${escapeHtml(name)}</button>`);
  if (all.length > FONT_ROWS_SHOWN) rows.push(`<div class="font-empty">${all.length - FONT_ROWS_SHOWN} more: keep typing to narrow the list</div>`);
  return rows.join('');
}

// The id attributes come in WHOLE, as literals (see colourRow): test/renderer-scope.test.js guards every id this file looks up.
function fontPickerHtml(label, kind, current, unsetText, searchAttr, listAttr, resetAttr) {
  return (
    `<span class="style-label">${escapeHtml(label)}</span>` +
    `<div class="style-note" data-font-now="${kind}">${current ? `Now: ${escapeHtml(current)}` : escapeHtml(unsetText)}</div>` +
    `<div class="style-row"><input type="text" class="style-hex font-search" ${searchAttr} placeholder="Search fonts" aria-label="Search fonts: ${escapeHtml(label)}" ` +
    `spellcheck="false" autocomplete="off" value="${escapeHtml(fontQueries[kind])}">` +
    `<button type="button" ${resetAttr}${current ? '' : ' disabled'}>Reset</button></div>` +
    `<div class="font-list" ${listAttr} role="listbox" aria-label="${escapeHtml(label)}">${fontRowsHtml(kind, current)}</div>`
  );
}

// Each row is drawn in its own font. Set from here, not as inline markup, so no family name is ever part of a CSS string in HTML.
function paintFontRows(listEl) {
  for (const row of listEl.querySelectorAll('.font-row')) row.style.fontFamily = fontsDisplay.stackFor(row.dataset.font, 'ui');
}

function bindFontPicker(searchEl, listEl, resetEl, kind, onPick) {
  if (!searchEl || !listEl) return;
  paintFontRows(listEl);
  searchEl.addEventListener('input', () => {
    fontQueries[kind] = searchEl.value;
    // Only the list is redrawn, never the whole panel, so the box keeps focus while the person types.
    const current = kind === 'term' ? (fontSettings && fontSettings.terminalFont)
      : kind === 'ui' ? (fontSettings && fontSettings.uiFont) : projectTerminalFont;
    listEl.innerHTML = fontRowsHtml(kind, current);
    paintFontRows(listEl);
  });
  listEl.addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.font-row') : null;
    if (row && row.dataset.font) { fontQueries[kind] = ''; fontFocusAfter = kind; onPick(row.dataset.font); }
  });
  // Arrow keys, Home and End move between the rows (one tab stop for the whole list; Enter or Space picks, as a button does).
  listEl.addEventListener('keydown', (e) => {
    const rows = [...listEl.querySelectorAll('.font-row')];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
    for (const r of rows) r.tabIndex = r === next ? 0 : -1;
    next.focus();
  });
  if (resetEl) resetEl.addEventListener('click', () => { fontQueries[kind] = ''; fontFocusAfter = kind; onPick(null); });
}

function bindFontSection() {
  const termSearch = document.getElementById('style-font-term-search');
  if (!termSearch) return;       // the section is still "reading…"
  ensureFontList();
  bindFontPicker(termSearch, document.getElementById('style-font-term-list'), document.getElementById('style-font-term-reset'),
    'term', (name) => setFontSettings({ terminalFont: name }));
  bindFontPicker(document.getElementById('style-font-ui-search'), document.getElementById('style-font-ui-list'),
    document.getElementById('style-font-ui-reset'), 'ui', (name) => setFontSettings({ uiFont: name }));
  bindFontPicker(document.getElementById('style-font-project-search'), document.getElementById('style-font-project-list'),
    document.getElementById('style-font-project-reset'), 'project',
    (name) => sendStyle('colours', { action: 'set-look', look: { terminalFont: name } }));
  // After a pick the panel was redrawn and the focused row is gone: keyboard focus goes back to that picker's search box.
  if (fontFocusAfter) {
    const box = fontFocusAfter === 'ui' ? document.getElementById('style-font-ui-search')
      : fontFocusAfter === 'project' ? document.getElementById('style-font-project-search') : termSearch;
    fontFocusAfter = null;
    if (box) box.focus();
  }
  const size = document.getElementById('style-font-size');
  if (size) {
    const label = document.getElementById('style-font-size-val');
    size.addEventListener('input', () => { if (label) label.textContent = size.value + ' px'; });
    size.addEventListener('change', () => setFontSettings({ terminalSize: Number(size.value) }));
  }
}

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

// PR #197 Miguel Y9: why the claude-custom mod is not loaded, in the diagnostics pane's log (Ctrl+Shift+D). Said only for a mod that is
// off or could not load, and once per reason, so a hello after every reattach does not stack the same line.
let lastModStatusLogged = null;
function noteModStatus(status) {
  if (!status || typeof status !== 'object' || status.state === 'on' || typeof status.reason !== 'string' || status.reason === lastModStatusLogged) return;
  lastModStatusLogged = status.reason;
  logLine('claude-custom mod', status.reason);
}

// PR #201 Miguel S1: which ConPTY the session runs on, in the diagnostics pane's log (Ctrl+Shift+D), once per reason. Said only when it is
// not the bundled one, since that is what turns the CLI's status protocol off.
let lastPtyBackendLogged = null;
function notePtyBackend(info) {
  if (!info || typeof info !== 'object' || info.backend === 'bundled' || typeof info.reason !== 'string' || info.reason === lastPtyBackendLogged) return;
  lastPtyBackendLogged = info.reason;
  logLine('pty backend', 'OS ConPTY: ' + info.reason);
}

function handleControl(msg) {
  if (msg.type === 'modStatus') { noteModStatus(msg.modStatus); return; }
  if (msg.type === 'hello') {
    noteModStatus(msg.modStatus);
    notePtyBackend(msg.ptyBackend);
    // The host sends `hello` immediately before replaying the current screen.
    // Without this reset, reattaching after a detach appends the replay to what
    // is already on screen and the session appears twice.
    term.reset();
    document.getElementById('cwd').textContent = msg.cwd || '';
    // what this host accepts as control: the Files tab sends nothing to one that doesn't list `repo`
    repoBrowser.setControls(msg.controls);
    // the Ask panel asks nothing of a host that doesn't list `ask` (an older host would type the frame into the session)
    askRequester.setControls(Array.isArray(msg.controls) ? msg.controls : []);
    if (askPanel && shownModules.has('ask')) askPanel.show();
    askWasDocked = null;       // a (re)attached host knows nothing of this window: say it again
    if (askPanel) askView();
    hostControls = Array.isArray(msg.controls) ? msg.controls : [];
    // OSC 7501: the CLI's state as the host holds it; an older host has none, which is no program state (never a guessed idle).
    applyProgramStatus(programStatusDisplay.hostListsProgramStatus(hostControls) && msg.programStatus ? msg.programStatus.root : null, 'hello');
    // a hello with no `controls` is an old host's: an empty list, so the panel says it needs a newer session
    gitGraphAsker.setControls(Array.isArray(msg.controls) ? msg.controls : []);
    if (shownModules.has('git') && gitView === 'graph') requestGitGraph();
    if (typeof msg.project === 'string' && msg.project) currentProjectName = msg.project;
    currentBranchName = typeof msg.branch === 'string' ? msg.branch : null;
    // BACKLOG #119 A1: which account this session runs under. An older host sends none: the default, and main hears nothing.
    hostProfileId = typeof msg.profile === 'string' && msg.profile !== '' ? msg.profile : null;
    if (hostProfileId !== null && window.harness && typeof window.harness.reportProfile === 'function') window.harness.reportProfile(msg.profile);
    refreshProfiles();
    renderProfileChip();
    renderTitle();
    // Layout pass L1: this tab's own layout survives a reattach because the host
    // kept it. Absent on an older host -> the global layout, as before.
    helloSeen = true;
    if ('layoutOverride' in msg) applyLayoutOverride(msg.layoutOverride);
    else renderLayout();               // an older host has no own layout to wait for: the pruning the hello unblocks happens now
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
    sessionTurn = msg.turn === undefined ? null : msg.turn;
    // The terminal bar: the latest prompt (no place in this buffer: it shows) and the bedtime night; both absent
    // from an older host, which is "none", never a stale one.
    applyBarPrompt(msg.prompt, false);
    applyBedtime(msg.bedtime);
    if (leanOn) tellHostLean();      // a (re)attached host does not know this window is lean
    applySummary({ summary: msg.summary, off: msg.summaryOff }, true);
    applyDocsDrift(msg.docsDrift);
    paintBar();
    reportTabStatus();
    // The persisted hidden set (BACKLOG #14), before the first paint.
    hiddenAgentNames = Array.isArray(msg.hidden) ? msg.hidden : [];
    // BACKLOG #80: the medals, and the bubbles' switch (these two don't repaint: renderRoster below does).
    medalList = cleanMedalList(msg.medals);
    explainerFrame = window.askExplainerDisplay.frameOf(msg.explainer);      // before the first paint; null from an older host
    bubblesEnabled = msg.bubbles && typeof msg.bubbles.enabled === 'boolean' ? msg.bubbles.enabled : null;
    paintBubblesToggle();
    tellHostBubblesVisible();
    // Before renderRoster, so the first paint already carries the careers and
    // the models rather than flashing the roster without them.
    if (msg.sessionModel) sessionModel = msg.sessionModel;
    rosterIndexPayload = msg.rosterIndex || null;
    wandState = wandDisplay.reduce(wandState, msg);
    renderWand();
    schedState = window.schedulesDisplay.reduce(schedState, msg);
    renderSchedules();
    canvasOnFrame(msg.canvas);
    loadoutState = loadoutDisplay.reduce(loadoutState, msg);
    hooksOn = msg.hooks;
    renderAgentStats(msg.agentStats);
    occupancy.session = sessionIdOf(msg.sessionId);
    renderRoster();
    if (Array.isArray(msg.seats)) councilSeats = msg.seats;
    if (msg.maxSeats) seatMax = msg.maxSeats;
    councilWarnings = [];
    renderSeats();
    if (!msg.hooks) console.warn('[renderer] host reports no hook helper — moods will not update');
    return;
  }
  if (msg.type === 'session') {
    occupancy.session = sessionIdOf(msg.sessionId);
    renderRoster();
    return;
  }
  if (msg.type === 'loadout') {
    loadoutState = loadoutDisplay.reduce(loadoutState, msg);
    renderRoster();
    return;
  }
  if (msg.type === 'wand') {
    wandState = wandDisplay.reduce(wandState, msg);
    renderWand();
    return;
  }
  if (msg.type === 'schedules') {
    schedState = window.schedulesDisplay.reduce(schedState, msg);
    renderSchedules();
    return;
  }
  if (msg.type === 'canvas') {
    canvasOnFrame(msg);
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
  if (msg.type === 'explainer') {
    applyExplainer(msg);
    return;
  }
  if (msg.type === 'medals') {
    applyMedals(msg.medals);
    if (msg.ok === false) flashAttention({ urgent: false, title: 'Couldn\'t save the medal (' + String(msg.reason) + ')' });
    return;
  }
  if (msg.type === 'bubbles') {
    applyBubblesSwitch(msg.enabled);
    return;
  }
  if (msg.type === 'bubble') {
    if (bubblesAllowed() && bubbleBoard.show(msg)) paintBubbles();
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
  if (msg.type === 'program-status') {
    // Sent by a host that lists it in its hello; one that doesn't never sends it, and a frame from anywhere else is ignored.
    if (programStatusDisplay.hostListsProgramStatus(hostControls)) applyProgramStatus(msg.root);
    return;
  }
  if (msg.type === 'attention') {
    gamesHandBack();                // #41: Claude needs Ricardo, or finished: a wait game pauses and the keyboard goes to the terminal
    // Delivery is unconditional; only INSISTENCE depends on focus. The old rule
    // skipped the toast whenever the window had focus, which silenced the one
    // case the feature was built for: watching the terminal while a long task
    // runs and wanting to be told when it ends.
    const surfaces = window.surfacesFor(msg, { focused: document.hasFocus() });
    // An urgent message waits for you until this tab is looked at; so does a finished one, which
    // also answers an urgent one still pending (#31). Anything else marks nothing.
    if (msg.urgent === true) { pend('urgent'); reportTabStatus(); }
    else if (msg.urgent === false) { pend('finished'); reportTabStatus(); }

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
  if (msg.type === 'turn') {
    sessionTurn = msg.turn === undefined ? null : msg.turn;
    paintBar();
    reportTabStatus();
    return;
  }
  if (msg.type === 'prompt') {
    applyBarPrompt(msg.prompt, true);
    return;
  }
  if (msg.type === 'summary') {
    applySummary(msg, false);
    return;
  }
  if (msg.type === 'docs-drift') {
    applyDocsDrift(msg);
    return;
  }
  if (msg.type === 'bedtime') {
    applyBedtime(msg.bedtime);
    return;
  }
  if (msg.type === 'cooldowns') {
    renderCooldowns(msg.cooldowns);
    return;
  }
  if (msg.type === 'repo') {
    repoBrowser.onMessage(msg);
    return;
  }
  if (msg.type === 'ask') {
    askRequester.onMessage(msg);
    return;
  }
  if (msg.type === 'git-tree') {
    renderGitTree(msg);
    requestGitTabs();
    return;
  }
  if (msg.type === 'git-graph') {
    lastGitGraph = msg;
    renderGitGraph();
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
    // The explainer's own picture (Ask panel): read the new picture from the host.
    if (msg.agent === ASK_AGENT && askPanel) askPanel.refresh();
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
    // The session is over: nothing it said last (working, blocked) is still true (PR #201 Dexter 1).
    applyProgramStatus(null);
    return;
  }
}

// --- transport --------------------------------------------------------------
const dot = document.getElementById('dot');
let ws = null;
let pendingKeyDesc = null;

// Has this page's socket ever opened? ws.onopen's focus rule needs the first open
// told apart from a reattach (backlog #36).
let socketOpened = false;

function connect() {
  // The token goes in the URL, which is the only channel a WebSocket
  // handshake offers. It never touches the pty.
  const auth = params.get('token') ? `?token=${encodeURIComponent(params.get('token'))}` : '';
  ws = new WebSocket(`ws://127.0.0.1:${PORT}${auth}`);

  ws.onopen = () => {
    dot.classList.add('on');
    // Every reattach lands here, not only the first open: after the first, a
    // visible element the user is on (the vault's secret) keeps focus (backlog #36).
    const first = !socketOpened;
    socketOpened = true;
    if (window.dockEffects.focusOnOpen(first, window.dockEffects.describeFocus(document.activeElement, term.element))) term.focus();
    sendResize();
    tellHostBubblesVisible();      // a host that restarted forgot (BACKLOG #80)
    // A log open across a reattach is asked for again: the host's log session
    // belongs to the old socket and died with it.
    if (agentLog.open) openAgentLog(agentLog.agent);
    // The tab is restored before the socket is open, so a fog request made at
    // load is thrown away. Ask again once there is somewhere to ask.
    if (shownModules.has('fog')) repoBrowser.show();
    if (shownModules.has('git')) { requestGitTree(); if (gitView === 'graph') requestGitGraph(); }
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
    // a Files ask in flight will never be answered by this socket: fail it now, not after its timeout
    repoBrowser.failAll('the connection to the session dropped');
    askRequester.failAll('the connection to the session dropped');
    // the next socket may reach another host, an older one: nothing is asked of it until ITS hello (PR #95 D7)
    gitGraphAsker.forget();
    cancelTabDrag();                // a tab drag in flight is dropped, the layout left as it was
    cancelKeyboardMove();           // ...and so is a keyboard move
    // Nobody vouches for the account figure either: unknown, so a countdown can't run on from a dead host (#90).
    if (lastQuotaPayload && Object.keys(quotaCountdownState(lastQuotaPayload, Date.now()).texts).length) {
      renderQuota({ ok: false, state: 'absent', windows: [], error: 'the connection to the session dropped' });
    }
    // Nobody is telling us what the session is doing now: unknown, not the last thing it said.
    if (sessionTurn !== null) { sessionTurn = null; paintBar(); reportTabStatus(); }
    // ...and the same for what the CLI reported about itself (OSC 7501): no program state, no header dot class (PR #201 Dexter 1).
    applyProgramStatus(null, 'lost');
    // The night is the host's word and nobody is telling us now: unknown (no night tab, no moon), not the last word.
    if (bar.bedtime !== null) applyBedtime(null, { fromHost: false });
    // Detach is normal, not fatal — the host keeps the session alive, so just
    // keep trying to reattach.
    setTimeout(connect, 1000);
  };

  ws.onerror = () => { /* surfaced via onclose */ };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

// The last size the host was sent: verify/probe-dock-tree.js compares it with
// xterm's own and with what fits the container after every layout change.
let lastSentResize = null;
let resizeSends = 0;      // how many resizes reached the host: the probe checks a float's move sends none
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    lastSentResize = { cols: term.cols, rows: term.rows };
    resizeSends += 1;
  }
}

// Everything xterm translates from a keypress flows through here.
// Typing drops the selection, as in Windows Terminal: a selection left
// behind is the one a later Ctrl+C would copy instead of interrupting
// (Miguel, PR #58, I1). onKey, not onData: onData also carries focus and
// mouse reports, which must not clear a selection the user is still using.
term.onKey(() => { if (term.hasSelection()) term.clearSelection(); });
// A real keystroke (onKey, not onData: focus and mouse reports arrive through onData and are not typing) hides the
// where-are-we summary and counts as touching the tab.
term.onKey(() => { summaryTyped(); });

term.onData((data) => {
  sentInputs.push(data);                      // what the probe reads back: did this reach the pty path?
  if (sentInputs.length > 20) sentInputs.shift();
  logLine(pendingKeyDesc || 'input', data);
  pendingKeyDesc = null;
  userInput(data);
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
  usage('terminal:drop');
  // Through the confirm, like typing and pasting: a dropped file types its path into the prompt, and that is
  // the person's own act in a worktree an agent may be writing in (PR #96 Miguel S5).
  userInput(JSON.stringify({ type: 'drop', entries }));
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
    // Lean mode shows no panel, so folding the dock would only hide the panels Back to normal should return (PR #140 Dexter F6).
    if (focusOn && focusBridge) focusBridge.set(false); else if (!leanOn) toggleAllZones();
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
    userInput('\x1b\r');
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
    userInput(frame);
  } else if (action.kind === 'image') {
    logLine('Ctrl+V (image)', action.data);
    userInput(action.data);
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
