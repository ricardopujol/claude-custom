'use strict';
/**
 * FF12 -- the top-bar control panel: current model, effort, and the
 * persistent colour cue for the model family.
 *
 * Pure decisions only, for the reason app/quota-display.js and
 * app/career-display.js exist: a decision living inside a browser script is a
 * decision nothing can test. renderer.js owns the actual wiring (the ws.send
 * that types `/model sonnet\r` into the pty, the click handlers that open a
 * picker) -- everything here is inputs in, a render-ready shape out, no DOM
 * reads, no clock reads, no network.
 *
 * WRAPPED IN AN IIFE, and that is not style. renderer.html loads these as
 * plain <script> tags sharing ONE global scope -- see
 * test/renderer-scope.test.js, which enforces the exact `(function (root) {`
 * prefix below so its skip-regex can find this file.
 */
(function (root) {

// Approved 2026-09-23 (Ricardo): a PERSISTENT recognition cue, independent of
// theme. Unlike --accent, which is chosen per project, these colours are
// meant to mean the same model everywhere -- so they are fixed, not derived
// from the active theme.
const FAMILY_COLOURS = {
  fable: '#2bb5a8',    // teal (added 2026-09-28 with the fable alias)
  opus: '#e0a030',     // amber
  sonnet: '#4c8bf5',   // blue
  haiku: '#4caf6a',    // green
  other: '#c060e0',    // magenta -- anything non-Anthropic
};

// MEASURED 2026-09-23 against `claude` 2.1.280 (see the PR-B brief). `/model`
// accepts these aliases plus a full model id typed as free text; `ultracode`
// is gated out of `/effort` on purpose. `fable` added 2026-09-28: claude
// 2.1.283 accepts it as an alias (verify/probe-model-list.js). Newest first.
const MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

// How long a picker waits for the truth before it gives up and says the
// switch did not take. The truth is the statusLine document (host/status-
// relay.js), MEASURED to re-fire ~1s after /model and /effort with no turn
// (verify/probe-top-bar-truth.js), so 15s is generous. `/model` has a
// documented refusal path (`model-switch-blocked`) that changes nothing, so a
// session that goes silent must still resolve rather than spin forever.
const PENDING_TIMEOUT_MS = 15000;

/**
 * Which family a model id belongs to. TOTAL: never throws, whatever arrives,
 * because this reads a field (`sessionModel.session.model`, or a hook
 * payload's `effort`/`permission_mode`) this PR does not control the shape
 * of -- PR-A ships the model field, and `model: null` for "not known yet" is
 * documented as correct, not a bug to guard against once.
 *
 * `null`   -- no model known yet; there is nothing to name, so nothing is
 *             guessed.
 * 'other'  -- a real, non-empty id that matched none of the known families.
 *             This is deliberately a real answer, not an absence: an
 *             OpenRouter model seated in the council is not Anthropic and
 *             that is worth a colour of its own (magenta), not silence.
 */
function modelFamily(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.indexOf('fable') !== -1) return 'fable';
  if (lower.indexOf('opus') !== -1) return 'opus';
  if (lower.indexOf('sonnet') !== -1) return 'sonnet';
  if (lower.indexOf('haiku') !== -1) return 'haiku';
  return 'other';
}

/**
 * The colour cue for a family. Unknown (`family` is null, i.e. no model has
 * been reported yet) draws the theme's own accent, UNTINTED -- there is
 * nothing yet to tint, and this is the byte-equal fallback so an unresolved
 * model changes nothing about how the header already looks.
 */
function cueColour(family, theme) {
  // Backlog #64: an accent the person CHOSE is the only accent on screen, so it
  // beats the model-family cue (opus amber read as "the accent never changed").
  const chosen = chosenAccent(theme);
  if (chosen) return chosen;
  if (family && Object.prototype.hasOwnProperty.call(FAMILY_COLOURS, family)) {
    return FAMILY_COLOURS[family];
  }
  const chromeAccent = theme && theme.chrome && theme.chrome.accent;
  return typeof chromeAccent === 'string' && chromeAccent ? chromeAccent : '#d08c4a';
}

/**
 * The accent the person chose for this look, or null. host/look.js derivePalette
 * gives a look with a chosen accent `chrome.onAccent` (its label colour) and a
 * look without one does not, so that is the marker: the theme's own default
 * accent is not a choice and must not suppress the family cue.
 */
function chosenAccent(theme) {
  const c = theme && theme.chrome;
  if (!c || typeof c.accent !== 'string' || !c.accent || !c.onAccent) return null;
  return c.accent;
}

/**
 * The theme with `hex` as its chosen accent -- what a live colour-picker preview
 * feeds the same path a saved look takes, so there is ONE source for the accent.
 * `onAccent` is the label colour for that accent (app/accent-preview.js gives
 * the one a saved look would). Returns a copy; an invalid colour returns the
 * theme as it was.
 */
function withChosenAccent(theme, hex, onAccent) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return theme;
  const base = theme && typeof theme === 'object' ? theme : {};
  const chrome = base.chrome || {};
  const label = typeof onAccent === 'string' && onAccent ? onAccent : (chrome.onAccent || '#12141c');
  return { ...base, chrome: { ...chrome, accent: hex, onAccent: label } };
}

/**
 * The pending-switch state machine. `pending` is `{ kind, value, startedAt }`
 * or `null`. `event` is one of:
 *
 *   { type: 'truth',   kind, matches, at }           -- a new truth arrived
 *   { type: 'timeout', kind, now, timeoutMs }         -- a clock check
 *
 * Matching is the CALLER's job (modelMatches / effortMatches below) so this
 * function stays domain-agnostic and total.
 *
 * Returns `{ pending, result }` where `result` is `null` (nothing changed),
 * `'applied'` (a truth confirmed the request) or `'timeout'` (none did in
 * time).
 *
 * A truth that does NOT match keeps waiting rather than rejecting: it may be
 * a status the CLI wrote before it processed the command (Dexter #2), and a
 * switch that then succeeds must not read as refused. A truth OLDER than the
 * request (`at < startedAt`), or with no usable `at`, is ignored outright
 * (Dexter #1): it cannot know about the request, so it cannot confirm it.
 *
 * The property this function exists to guarantee, matching the brief's
 * "never flips optimistically": the ONLY event that can produce `'applied'`
 * is a matching `'truth'` event no older than the request. A `'timeout'` can
 * never produce it, however the clock is fed.
 */
function pendingResolver(pending, event) {
  if (!pending || !event || event.kind !== pending.kind) {
    return { pending: pending || null, result: null };
  }
  if (event.type === 'truth') {
    const fresh = typeof event.at === 'number' && Number.isFinite(event.at)
      && event.at >= pending.startedAt;
    return fresh && event.matches
      ? { pending: null, result: 'applied' }
      : { pending, result: null };
  }
  if (event.type === 'timeout') {
    const elapsed = event.now - pending.startedAt;
    if (elapsed >= event.timeoutMs) return { pending: null, result: 'timeout' };
  }
  return { pending, result: null };
}

const UNKNOWN = '—';   // em dash, same non-claim as the sibling display modules

function chipState(value, pending, notice) {
  const family = modelFamily(typeof value === 'string' ? value : null);
  return {
    value: typeof value === 'string' && value ? value : null,
    label: typeof value === 'string' && value ? value : UNKNOWN,
    family,
    pending: !!pending,
    pendingLabel: pending ? pending.value : null,
    notice: typeof notice === 'string' && notice ? notice : null,
  };
}

/**
 * Render-ready state for the panel: `{ model, effort, accent }`. Pure --
 * no DOM, no clock. The accent is computed from the CURRENT (known) model,
 * never from a pending request, so the colour only ever reports the truth.
 */
function topBarState(input) {
  const { model, effort, pendingModel, pendingEffort, theme, notices } = input || {};
  const family = modelFamily(typeof model === 'string' ? model : null);
  const n = notices && typeof notices === 'object' ? notices : {};
  return {
    model: chipState(model, pendingModel, n.model),
    effort: chipState(effort, pendingEffort, n.effort),
    accent: cueColour(family, theme),
  };
}

/**
 * The DOM write. `els` is `{ modelEl, effortEl }`; either may be absent (a
 * fast attach, before the header has rendered) and this must tolerate that
 * rather than throw and take the rest of the handshake down with it -- the
 * exact failure mode test/renderer-scope.test.js's id-existence check exists
 * to catch one layer up.
 */
function writeChip(el, chip, verb) {
  if (!el) return;
  el.textContent = chip.pending ? `${chip.pendingLabel}…` : chip.label;
  if (chip.pending) el.classList.add('pending'); else el.classList.remove('pending');
  // A switch that did not take is MARKED, while the label keeps reporting the
  // truth: the notice says what happened, never what we hoped.
  if (chip.notice && !chip.pending) el.classList.add('notice'); else el.classList.remove('notice');
  el.title = chip.pending
    ? `switching ${verb} to ${chip.pendingLabel}…`
    : (chip.notice || `${verb}: ${chip.label}`);
}

function topBarDisplay(els, state) {
  if (!els || !state) return;
  writeChip(els.modelEl, state.model, 'model');
  writeChip(els.effortEl, state.effort, 'effort');
}

/**
 * The main session's model from the host's session-model payload, or null.
 *
 * The contract is #34's (host/session-model.js): `{ session: { model, at },
 * agents, errors }`, the same on hello's `sessionModel` and on the
 * `sessionModel` broadcast (which carries those fields at top level). FF12
 * was written before #34 merged and read `sessionModel.model`, which never
 * exists -- the chip stayed "—" for good. One reader, used for both paths.
 * Absence and anything that is not a non-empty string is null, never a guess.
 */
function mainModelOf(payload) {
  const session = payload && typeof payload === 'object' ? payload.session : null;
  const model = session && typeof session === 'object' ? session.model : null;
  return typeof model === 'string' && model ? model : null;
}

/**
 * Does the running model (`truth`, a full id like "claude-sonnet-5") satisfy
 * the request? A menu alias resolves to "the current model of that family",
 * so family is the whole test. A free-typed id is not an alias: it matches
 * only itself (Dexter #1, #5) -- family would call opus-4-5 a success for
 * opus-4-7, and 'other' would call any two provider models equal.
 */
//
// An alias may carry the 1M-context suffix (Dexter r2 N4). MEASURED
// 2026-09-26 (v2.1.283): `/model sonnet[1m]` reports `claude-sonnet-5[1m]`.
// So the suffix must agree on both sides: `sonnet[1m]` is not confirmed by a
// 200k sonnet, and plain `opus` is not "already running" on opus[1m].
const CONTEXT_1M = '[1m]';

function modelMatches(truth, requested) {
  if (typeof truth !== 'string' || !truth || typeof requested !== 'string' || !requested) return false;
  const req = requested.trim().toLowerCase();
  const running = truth.trim().toLowerCase();
  const wants1m = req.endsWith(CONTEXT_1M);
  const alias = wants1m ? req.slice(0, -CONTEXT_1M.length) : req;
  if (MODEL_CHOICES.indexOf(alias) !== -1) {
    return modelFamily(running) === alias && running.endsWith(CONTEXT_1M) === wants1m;
  }
  return running === req;
}

function effortMatches(truth, requested) {
  if (typeof truth !== 'string' || !truth || typeof requested !== 'string' || !requested) return false;
  return truth.trim().toLowerCase() === requested.trim().toLowerCase();
}

// A model id's whole alphabet. It is typed into a live pty after `/model `,
// so anything else -- above all an embedded CR or LF, which would submit a
// SECOND command (Miguel #1) -- refuses the value outright rather than being
// stripped: a mangled id is not what the user asked for either.
const MODEL_ID = /^[A-Za-z0-9._/:\-[\]]+$/;
const MODEL_ID_MAX = 100;
// Aliases whose running model can never be matched against them: `default`
// names no family, and `opusplan` runs sonnet outside plan mode (Dexter #5).
const UNCONFIRMABLE = ['default', 'opusplan'];

function validModelInput(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not a model id' };
  const v = value.trim();
  if (!v) return { ok: false, reason: 'type a model id' };
  if (v.length > MODEL_ID_MAX) return { ok: false, reason: 'too long for a model id' };
  if (!MODEL_ID.test(v)) {
    return { ok: false, reason: 'only letters, digits and . _ / : - [ ] belong in a model id' };
  }
  if (UNCONFIRMABLE.indexOf(v.toLowerCase()) !== -1) {
    return { ok: false, reason: `"${v}" can't be confirmed against the running model; type a full id` };
  }
  return { ok: true, value: v };
}

/**
 * Is the TUI's input box safe to type a slash command into? `lines` is the
 * visible screen, top to bottom. MEASURED (verify/probe-top-bar-truth.js):
 * the live box is a `❯` line between the LAST two full-width `─` rules, and an
 * open dialog (bare /model's picker, a permission prompt) draws no such box.
 *
 *   'ready'     -- one input line; Ctrl-U clears it without submitting
 *   'multiline' -- a draft over several lines; Ctrl-U clears only the last,
 *                  and the rest would be submitted WITH the command
 *   'dialog'    -- no input box: the keys would land in the dialog, and the
 *                  CR would confirm whatever it has highlighted (Dexter #4)
 *   'unknown'   -- nothing on screen to judge by
 */
const RULE_LINE = /^─{10,}$/;

// The live box: the lines between the LAST two rules, and what is under it.
// `box` is null when there is no box on screen.
function liveBox(lines) {
  if (!Array.isArray(lines)) return null;
  const text = lines.map(l => (typeof l === 'string' ? l.trim() : ''));
  const rules = [];
  text.forEach((l, i) => { if (RULE_LINE.test(l)) rules.push(i); });
  if (rules.length < 2) return { text, box: null, below: [] };
  const top = rules[rules.length - 2];
  const bottom = rules[rules.length - 1];
  return { text, box: text.slice(top + 1, bottom), below: text.slice(bottom + 1) };
}

// MEASURED (verify/probe-vim-mode.js): in vim INSERT the footer line under
// the box starts `-- INSERT --`; in NORMAL it is absent -- as it is with vim
// off, which is why the caller latches "vim is on" once this has been seen.
const VIM_INSERT = /^-- INSERT --(\s|$)/;

function vimInsertShown(lines) {
  const live = liveBox(lines);
  return !!(live && live.box && live.below.some(l => VIM_INSERT.test(l)));
}

/**
 * `opts.vim` is the caller's latch: vim mode has been seen in this session.
 * With it, a box with no INSERT marker is 'vim-normal' -- keys typed there are
 * motions, not text (Dexter r2 N2).
 */
function inputState(lines, opts) {
  const live = liveBox(lines);
  if (!live || !live.text.some(Boolean)) return 'unknown';
  const box = live.box;
  if (!box || !box.length || box[0].charAt(0) !== '❯') return 'dialog';
  if (box.length > 1) return 'multiline';
  if (opts && opts.vim && !vimInsertShown(lines)) return 'vim-normal';
  return 'ready';
}

/**
 * The read-back just before the CR (Miguel r2): is the live box EXACTLY `❯ <command>`? The screen was judged once, before the spaced
 * writes; a dialog opening meanwhile, or a draft the clear did not reach, would otherwise take the CR.
 *
 * Whitespace is judged the same on both sides (PR #125 Dexter #3): a run of it, or a non-breaking space, is one space in the box and in the
 * command. A line longer than the box is wide WRAPS over several rows (Dexter #2; measured, verify/probe-panel-line-input.js); a wrap swallows
 * the ONE space it breaks at and nothing else, so rows are joined back through that rule alone: `Total:42` is not `Total: 42` however it wraps
 * (Dexter r2 #1).
 *
 * The CLI's box has a height cap and keeps the END of a longer text, the `❯` staying on the first row. MEASURED (the probe, at 20, 24, 30, 36
 * and 40 terminal rows): the cap is floor(terminal rows / 2) - 5 rows. Only a box AT that cap can be hiding a head, so only then is a box that
 * holds the TAIL of the command accepted (`opts.termRows` names the terminal's height; without it no tail is accepted). Below the cap the whole
 * command is on screen and must match: a head that is gone, because a key cleared it mid-typing, is refused. What a read-back can never see
 * is a stray key typed into the hidden head.
 */
const SCROLL_CAP_BASE = 5;
const COMMAND_CHUNK = 200;       // characters per write: one big write is taken for a paste and collapsed to "[Pasted text #1]" (measured)
function scrollCapRows(termRows) {
  if (!Number.isInteger(termRows) || termRows < 1) return 0;
  return Math.floor(termRows / 2) - SCROLL_CAP_BASE;
}
const collapseWs = (t) => t.replace(/\s+/g, ' ').trim();

// Do `rows` (already one-line each) read, from `pos` in `want`, as the rest of it? A wrap between two rows swallowed at most one space.
function rowsFollow(rows, want, pos) {
  let at = pos;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && want.charAt(at) === ' ') at += 1;
    if (!want.startsWith(rows[i], at)) return -1;
    at += rows[i].length;
  }
  return at;
}

function commandTyped(lines, command, opts) {
  if (typeof command !== 'string' || !command) return false;
  const live = liveBox(lines);
  const rows = live && live.box;
  if (!rows || !rows.length || rows[0].charAt(0) !== '❯') return false;          // a dialog, or no box
  if (opts && opts.vim && !vimInsertShown(lines)) return false;                // vim NORMAL: keys are motions
  const want = collapseWs('❯ ' + command);
  const texts = rows.map(collapseWs);
  if (rowsFollow(texts, want, 0) === want.length) return true;                 // the whole command, on one row or wrapped
  if (texts.length < 2 || texts.length !== scrollCapRows(opts && opts.termRows)) return false;
  // At the cap: the first row is the prompt mark and the END of the text. Find where that text sits in the command.
  const first = texts[0].slice(1).trim();
  if (!first) return false;
  for (let p = want.indexOf(first, 2); p >= 0; p = want.indexOf(first, p + 1)) {
    if (rowsFollow([first, ...texts.slice(1)], want, p) === want.length) return true;
  }
  return false;
}

/**
 * After the Enter: does the box still hold the line that was typed? True when the box's text still contains the command's first or last
 * stretch (the CLI swallowed the Enter: its backslash newline, a suggestion list taking the key), even if that swallow changed the box a little
 * (PR #125 Dexter r2 #2). False for an emptied box, a reset one, a placeholder, a dialog, or no box: the line left it, which is what a
 * submission looks like.
 */
function boxHoldsLine(lines, command) {
  if (typeof command !== 'string' || !command) return false;
  const live = liveBox(lines);
  const rows = live && live.box;
  if (!rows || !rows.length) return false;
  const text = collapseWs(rows.join(' '));
  const want = collapseWs(command);
  const n = Math.min(20, want.length);
  return text.includes(want.slice(0, n)) || text.includes(want.slice(-n));
}

// Said by every typing path when the tab is a plain shell tab: nothing of Claude's is typed into it.
const SHELL_TAB_REFUSAL = 'this is a plain shell tab, not a Claude session: nothing is typed into it';

/**
 * The line the terminal ends with when the session's process has gone. A shell tab names the shell and, for a failed start, why.
 * Plain text only (the page writes it with term.write, never as markup); control characters in the reason are blanked.
 */
function shellExitText(kind, error) {
  if (kind !== 'shell') return '[claude exited]';
  const why = typeof error === 'string' ? error.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 300) : '';
  return why === '' ? '[shell exited]' : `[shell exited: ${why}]`;
}

const SCREEN_REFUSALS = {
  dialog: 'a dialog is open in the terminal; answer it or press Esc first',
  multiline: 'your draft spans several lines; send or clear it first',
  unknown: "the terminal's input box isn't on screen yet",
};

/**
 * Everything decided before a key reaches the pty. `raw` is the chosen or
 * typed value, `current` the running value, `screen` inputState()'s answer,
 * `connected` whether the socket is open. Returns
 *   { ok: true, value, command, alreadyRunning }   -- send `command`
 *   { ok: false, notice }                           -- send nothing, say why
 * `alreadyRunning`: the choice is what runs now. The truth is broadcast only
 * on a change, so a pending switch would always time out (Dexter #6); the
 * caller resolves it at once instead.
 */
function planSwitch({ kind, raw, current, screen, connected, hostKind } = {}) {
  let value;
  if (kind === 'model') {
    const v = validModelInput(raw);
    if (!v.ok) return { ok: false, notice: `didn't switch model: ${v.reason}` };
    value = v.value;
  } else if (kind === 'effort') {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (EFFORT_LEVELS.indexOf(v) === -1) return { ok: false, notice: "didn't switch effort: not a level /effort accepts" };
    value = v;
  } else {
    return { ok: false, notice: 'nothing to switch' };
  }
  const command = `/${kind} ${value}`;
  const typing = planTyping({ command, screen, connected, hostKind });
  if (!typing.ok) return { ok: false, notice: `didn't send ${command}: ${typing.reason}` };
  const alreadyRunning = kind === 'model' ? modelMatches(current, value) : effortMatches(current, value);
  return { ok: true, value, command, alreadyRunning, enterInsert: typing.enterInsert };
}

/**
 * Does the live box hold EXACTLY `command`, whatever the editor's mode? (PR #199 Dexter r2 N2.) commandTyped answers "can Enter be pressed now",
 * so in vim NORMAL it says no for text that is plainly there; this answers "is that text in the box", which is what owning a line means.
 */
function boxIsCommand(lines, command, opts) {
  if (typeof command !== 'string' || !command) return false;
  const live = liveBox(lines);
  const rows = live && live.box;
  if (!rows || !rows.length || rows[0].charAt(0) !== '\u276f') return false;
  const want = collapseWs('\u276f ' + command);
  const texts = rows.map(collapseWs);
  if (rowsFollow(texts, want, 0) === want.length) return true;
  if (texts.length < 2 || texts.length !== scrollCapRows(opts && opts.termRows)) return false;
  const first = texts[0].slice(1).trim();
  if (!first) return false;
  for (let p = want.indexOf(first, 2); p >= 0; p = want.indexOf(first, p + 1)) {
    if (rowsFollow([first, ...texts.slice(1)], want, p) === want.length) return true;
  }
  return false;
}

/**
 * The keys that ADD text to the end of what is in the box and clear NOTHING (PR #199 Dexter r2 N1, N3). MEASURED on the real CLI
 * (verify/probe-ctrl-u-wrapped.js): Ctrl-U on a line wrapped over rows kills only the LAST row, so a clear-and-retype of a wrapped line is not a
 * clear; and Ctrl-E then more text appends correctly at 80 and 120 columns. In vim NORMAL, `A` appends at the end of the line.
 */
function appendKeys(suffix, vimNormal) {
  const chars = Array.from(suffix);
  const chunks = [];
  for (let i = 0; i < chars.length; i += COMMAND_CHUNK) chunks.push(chars.slice(i, i + COMMAND_CHUNK).join(''));
  return [...(vimNormal ? ['A'] : []), '\x05', ...chunks];
}

const COMMENT_MAX = 1990;       // app/changes-compare.js MAX_STACK_CHARS: the most a comment line is typed with
const APPEND_SEP = '; ';

/**
 * What to do to type `text` (one or more review comments, one line) into the prompt, NEVER destroying a comment of ours (Dexter r2). `last` is the
 * line this feature typed before. `lines` is the screen.
 *   { ok: true, mode: 'append', keys, expected }   the box holds `last` exactly (any editor mode): ADD `; text` at its end, clear nothing, then the
 *                                                  box must read exactly `expected`; if it does not, STOP and leave it as it is
 *   { ok: true, mode: 'fresh', command }           the box holds nothing of ours: type `text` the ordinary way (a draft is replaced, as for any typed command)
 *   { ok: false, reason }                          nothing is typed
 * A box that LOOKS like one of our comments (it starts "In ") but is not exactly `last` is refused, never cleared: it may be ours with the screen
 * mid-redraw, or the person's edit of it.
 */
function planCommentTyping({ lines, last, text, vim, termRows, connected, hostKind } = {}) {
  // A plain shell tab (PR #208): the append path sends its keys without typeAndCheck, so the refusal is here too.
  if (hostKind === 'shell') return { ok: false, reason: SHELL_TAB_REFUSAL };
  if (typeof text !== 'string' || text === '') return { ok: false, reason: 'no comment to type' };
  if (!connected) return { ok: false, reason: 'not connected to the session' };
  const state = inputState(lines, { vim });
  if (typeof last === 'string' && last !== '' && boxIsCommand(lines, last, { termRows })) {
    const expected = `${last}${APPEND_SEP}${text}`;
    if (expected.length > COMMENT_MAX) return { ok: false, reason: 'the prompt line is full: send what is typed (Enter in the terminal), then type the rest' };
    if (!COMMENT_LINE.test(expected)) return { ok: false, reason: 'not a single-line review comment' };
    // NORMAL is judged on its own, not through inputState: a wrapped box reads 'multiline' there before vim is looked at
    return { ok: true, mode: 'append', keys: appendKeys(`${APPEND_SEP}${text}`, !!vim && !vimInsertShown(lines)), expected };
  }
  const there = boxText(lines);
  if (there && there.startsWith('In ')) {
    return { ok: false, reason: "the prompt holds a comment line that isn't exactly what was typed (edited, or still redrawing): send or clear it first. Nothing was changed" };
  }
  const plan = planTyping({ command: text, screen: state, connected, kind: 'comment' });
  if (!plan.ok) return plan;
  return { ok: true, mode: 'fresh', command: text, enterInsert: plan.enterInsert, keys: plan.keys };
}

/**
 * The keys typed before a command, in order: Ctrl-E (to the end: Ctrl-U deletes only back to the cursor,
 * Dexter r2 N1), Ctrl-U (clears a single-line draft without submitting it; the CLI's Ctrl+Y gets it back),
 * then the command. vim NORMAL gets `i` first, or every key after it is a motion (Dexter r2 N2). The
 * caller spaces them PTY_STEP_MS apart: typed as one chunk, a line is taken for a paste.
 */
function typingKeys(command, enterInsert) {
  const chunks = [];
  const chars = Array.from(command);
  for (let i = 0; i < chars.length; i += COMMAND_CHUNK) chunks.push(chars.slice(i, i + COMMAND_CHUNK).join(''));
  return [...(enterInsert ? ['i'] : []), '\x05', '\x15', ...(chunks.length ? chunks : [command])];
}

// One `@path`, optionally `#L40` or `#L40-60` (the reader's "@ in prompt", #32): no space, so the CLI reads
// it as ONE mention; no `#` in the path, so the suffix is unambiguous.
const AT_MENTION = /^@[^\x00-\x20\x7f#]+(?:#L[1-9]\d{0,8}(?:-[1-9]\d{0,8})?)?$/;

// One line of a slash command: a CR or any control key in it would submit or edit something else.
const SLASH_COMMAND = /^\/[A-Za-z0-9:_-]+(?: [^\x00-\x1f\x7f-\x9f]*)?$/;

// A button's message in Claude's panel (BACKLOG #71): free text, so it is allowed ONLY behind this fixed prefix (the CLI can't read it as
// a slash command or a `!` shell line), on one line, with no control or C1 character, no leading or trailing space and at most
// 2000 characters (what app/canvas-display.js sessionLine builds, held to it by test/plan-panel.test.js), and NEVER ending in a backslash:
// MEASURED on the real CLI (verify/probe-panel-line-input.js, PR #125 Dexter #1) `\` + Enter is the CLI's newline, so the gate's Enter would
// leave a two-row draft and submit nothing.
const PANEL_LINE = /^\(from Claude's panel\) [^\s\x00-\x1f\x7f-\x9f\u2028\u2029](?:[^\x00-\x1f\x7f-\x9f\u2028\u2029]{0,1998}[^\s\x00-\x1f\x7f-\x9f\u2028\u2029])?(?<!\\)$/;

// A review comment from the Changes panel (BACKLOG #119 A3): `In <path>:<line> — <comment>`, free text behind the fixed prefix "In " (the CLI
// can't read it as a slash command or a `!` shell line), on ONE line (several comments are joined with "; " by app/changes-compare.js), no control or
// C1 character, no leading or trailing space, at most 1990 characters (app/changes-compare.js MAX_STACK_CHARS), and NEVER ending in a backslash:
// `\` + Enter is the CLI's newline, so the person's Enter would leave a two-row draft and submit nothing.
const COMMENT_LINE = /^In [^\s\p{Cc}\p{Zl}\p{Zp}](?:[^\p{Cc}\p{Zl}\p{Zp}]{0,1985}[^\s\p{Cc}\p{Zl}\p{Zp}])?(?<!\\)$/u;

// An agent card's Pause / Resume line (BACKLOG #19, app/agent-pause-display.js commandFor): prose, so it is allowed ONLY as exactly these two sentences
// (PR #158 Dexter R2-8), on one line, with a plain agent name between double quotes and an optional plain task id: no free text, no control or
// line-separator character, nothing after the final full stop. Left to the slash-command shape these lines were refused every time (Dexter 1).
const AGENT_PAUSE_LINE = /^(?:Stop the background agent "[A-Za-z0-9 _.:-]{1,200}"(?: \(task id [A-Za-z0-9_-]{1,64}\))? with TaskStop so it can be resumed later with its conversation kept\. Do nothing else\.|Resume the stopped agent "[A-Za-z0-9 _.:-]{1,200}"(?: \(task id [A-Za-z0-9_-]{1,64}\))?: send it a message with SendMessage to continue where it stopped, with its earlier context\. Do nothing else\.)$/;

/**
 * Typing `command` into this tab's live box (the top bar's switches; the Git drawer's Type /merged, PR #93
 * Dexter F3 / Miguel I2). `screen` is inputState()'s answer. ->
 *   { ok: true, enterInsert, keys }   type `keys`, then read the box back (commandTyped) before the CR
 *   { ok: false, reason }             type nothing
 * A dialog, a draft over several lines or no box on screen gets nothing: the keys would land in the dialog,
 * or the rest of the draft would be submitted with the command.
 */
function planTyping({ command, screen, connected, kind, hostKind } = {}) {
  // A plain shell tab (BACKLOG #119 A5) is no Claude session: a slash command typed there is a command line for the shell (PR #208 Miguel Y3).
  if (hostKind === 'shell') return { ok: false, reason: SHELL_TAB_REFUSAL };
  const mention = kind === 'mention';
  const panel = kind === 'panel';
  const comment = kind === 'comment';
  const agentPause = kind === 'agent-pause';
  const shape = mention ? AT_MENTION : panel ? PANEL_LINE : comment ? COMMENT_LINE : agentPause ? AGENT_PAUSE_LINE : SLASH_COMMAND;
  if (typeof command !== 'string' || !shape.test(command)) {
    return { ok: false, reason: mention ? 'not a single-line @ mention' : panel ? "not a single-line message from Claude's panel" : comment ? 'not a single-line review comment' : agentPause ? 'not an agent Pause / Resume line' : 'not a single-line slash command' };
  }
  if (!connected) return { ok: false, reason: 'not connected to the session' };
  // vim NORMAL: an `i` first puts the editor in INSERT, so the rest lands as
  // text. MEASURED (verify/probe-vim-mode.js): `i` there is a mode switch.
  const enterInsert = screen === 'vim-normal';
  if (screen !== 'ready' && !enterInsert) return { ok: false, reason: SCREEN_REFUSALS[screen] || SCREEN_REFUSALS.unknown };
  return { ok: true, enterInsert, keys: typingKeys(command, enterInsert) };
}

/**
 * What the live single-line box holds after the `❯`: '' when empty, else a draft OR the CLI's dim
 * placeholder (plain text can't tell them apart), null when there is no box. Only used to say a box
 * that wasn't empty was cleared.
 */
function boxText(lines) {
  const live = liveBox(lines);
  if (!live || !live.box || !live.box.length || live.box[0].charAt(0) !== '❯') return null;
  return live.box[0].slice(1).trim();
}

/**
 * What a chip says about a switch that did not take (Dexter #9: a result
 * computed and thrown away looked exactly like never having clicked).
 * `result` is pendingResolver's, or 'refused' with planSwitch's `notice`.
 */
function switchNotice(r) {
  if (!r || !r.result || r.result === 'applied') return null;
  if (r.result === 'refused') return r.notice || null;
  if (r.result === 'timeout') {
    const now = typeof r.current === 'string' && r.current ? r.current : UNKNOWN;
    return `couldn't confirm the switch to ${r.value}; the session reports ${now}`;
  }
  return null;
}

/**
 * Where an open menu goes, in viewport pixels for `position: fixed`. The
 * menus used to hang off the header, whose `overflow: hidden` clipped them
 * and whose stacking context let the panels below paint over them. `anchor`
 * is the chip's bounding rect, `menu` the menu's size, `viewport` the
 * window's. Under the chip, left-aligned; above it when there is no room
 * below; always pulled back inside MENU_MARGIN of the edges. Total: missing
 * measurements place the menu at the margin, never at NaN.
 */
const MENU_MARGIN = 4;
const MENU_GAP = 2;

function menuPlacement(anchor, menu, viewport) {
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const a = anchor || {};
  const m = menu || {};
  const vp = viewport || {};
  const w = num(m.width);
  const h = num(m.height);
  const clamp = (v, hi) => Math.max(MENU_MARGIN, Math.min(v, hi));
  const left = clamp(num(a.left), num(vp.width) - MENU_MARGIN - w);
  const below = num(a.bottom) + MENU_GAP;
  const above = num(a.top) - MENU_GAP - h;
  const fitsBelow = below + h <= num(vp.height) - MENU_MARGIN;
  const top = clamp(!fitsBelow && above >= MENU_MARGIN ? above : below, num(vp.height) - MENU_MARGIN - h);
  return { left, top };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/quota-display.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    modelFamily, cueColour, chosenAccent, withChosenAccent, pendingResolver, topBarState, topBarDisplay,
    MODEL_CHOICES, EFFORT_LEVELS, PENDING_TIMEOUT_MS, UNKNOWN, mainModelOf,
    modelMatches, effortMatches, validModelInput, inputState, planSwitch, switchNotice,
    vimInsertShown, commandTyped, boxHoldsLine, scrollCapRows, menuPlacement, planTyping, SHELL_TAB_REFUSAL, shellExitText, typingKeys, boxText,
    boxIsCommand, appendKeys, planCommentTyping,
  };
} else {
  root.modelFamily = modelFamily;
  root.cueColour = cueColour;
  root.chosenAccent = chosenAccent;
  root.withChosenAccent = withChosenAccent;
  root.pendingResolver = pendingResolver;
  root.topBarState = topBarState;
  root.topBarDisplay = topBarDisplay;
  root.MODEL_CHOICES = MODEL_CHOICES;
  root.EFFORT_LEVELS = EFFORT_LEVELS;
  root.PENDING_TIMEOUT_MS = PENDING_TIMEOUT_MS;
  root.mainModelOf = mainModelOf;
  root.modelMatches = modelMatches;
  root.effortMatches = effortMatches;
  root.validModelInput = validModelInput;
  root.inputState = inputState;
  root.planSwitch = planSwitch;
  root.switchNotice = switchNotice;
  root.vimInsertShown = vimInsertShown;
  root.commandTyped = commandTyped;
  root.boxHoldsLine = boxHoldsLine;
  root.scrollCapRows = scrollCapRows;
  root.menuPlacement = menuPlacement;
  root.planTyping = planTyping;
  root.SHELL_TAB_REFUSAL = SHELL_TAB_REFUSAL;
  root.shellExitText = shellExitText;
  root.typingKeys = typingKeys;
  root.boxText = boxText;
  root.boxIsCommand = boxIsCommand;
  root.appendKeys = appendKeys;
  root.planCommentTyping = planCommentTyping;
}

})(typeof window !== 'undefined' ? window : globalThis);
