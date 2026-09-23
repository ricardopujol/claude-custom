'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { parsePermissionMode, MODES } = require('../host/mode');

test('reads each of the five modes from the status line', () => {
  // Measured from the real TUI in verify/probe-detach.js: shift+tab cycles
  // bypass -> auto -> manual -> accept edits -> plan. Five, not three.
  const lines = {
    bypass: '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    auto: '  ⏵⏵ auto mode on (shift+tab to cycle)',
    manual: '  ⏸ manual mode on',
    'accept edits': '  ⏵⏵ accept edits on (shift+tab to cycle)',
    plan: '  ⏸ plan mode on (shift+tab to cycle)',
  };
  for (const [expected, line] of Object.entries(lines)) {
    assert.strictEqual(parsePermissionMode([line]), expected, line);
  }
});

test('returns null when no mode line is present', () => {
  assert.strictEqual(parsePermissionMode(['just some output', '❯ ']), null);
});

test('scans a whole screen, not just one line', () => {
  const screen = ['banner', '', '❯ ', '  ⏸ plan mode on (shift+tab to cycle)', ''];
  assert.strictEqual(parsePermissionMode(screen), 'plan');
});

test('the riskiest mode is flagged as such', () => {
  // "running with permissions bypassed" should be impossible to forget.
  assert.strictEqual(MODES.bypass.risky, true);
  assert.strictEqual(MODES.plan.risky, false);
  assert.strictEqual(MODES.manual.risky, false);
});

test('every mode has a label and a rank', () => {
  for (const [name, m] of Object.entries(MODES)) {
    assert.ok(m.label, name);
    assert.ok(Number.isInteger(m.rank), name);
  }
});

test('ranks order from most permissive to least', () => {
  assert.ok(MODES.bypass.rank < MODES.plan.rank);
  assert.ok(MODES['accept edits'].rank < MODES.manual.rank);
});

test('a later line wins, since the status line is redrawn at the bottom', () => {
  const screen = ['  ⏸ plan mode on', 'output', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
  assert.strictEqual(parsePermissionMode(screen), 'bypass');
});

test('autonomy is ranked plan-safest to bypass-most', () => {
  // Skulls = autonomy, and this is OUR ordering of it, not the CLI's cycle
  // order. The title used to say "as shift+tab cycles"; that was never a claim
  // this module could make -- the harness does not intercept shift+tab, so the
  // cycle belongs to the CLI and this ladder only describes how we RANK the
  // modes for display.
  const order = Object.entries(MODES)
    .sort((a, b) => a[1].skulls - b[1].skulls)
    .map(([name]) => name);
  assert.deepStrictEqual(order,
    ['plan', 'manual', 'accept edits', 'auto', 'dont ask', 'bypass']);
});

test('skull counts run 1 to 6 with no gaps or duplicates', () => {
  // Six, not five: `dontAsk` is a real mode in `claude --help` and was missing
  // from this module entirely.
  const skulls = Object.values(MODES).map(m => m.skulls).sort((a, b) => a - b);
  assert.deepStrictEqual(skulls, [1, 2, 3, 4, 5, 6]);
});

test('both modes that run tools without asking are flagged risky', () => {
  // This asserted exactly one risky mode, which was true only because the
  // sixth was missing. "Don't Ask" does what its name says, so it is flagged
  // too -- when a mode's exact behaviour is uncertain the display must err
  // toward MORE autonomy, never less.
  const risky = Object.entries(MODES).filter(([, m]) => m.risky).map(([n]) => n).sort();
  assert.deepStrictEqual(risky, ['bypass', 'dont ask']);
  assert.strictEqual(MODES.bypass.skulls, 6, 'bypass stays the top of the scale');
});

// --- the CLI's ACTUAL indicators --------------------------------------------
//
// Ricardo asked for the shift+tab cycle to be reordered. It cannot be: the
// harness never intercepts shift+tab (app/renderer.js treats it as
// observed-only and passes CSI Z straight to the pty), so the order is the
// CLI's. Chasing the question turned up something far worse.
//
// Extracted from the shipped `claude.exe` (v2.1.280) -- its own mode table:
//
//   "Accept edits", shortTitle:"Accept",  indicator:"accept edits"
//   "Auto",         shortTitle:"Auto",    indicator:"auto mode"
//   "Bypass Permissions", shortTitle:"Bypass", indicator:"bypass permissions"
//   "Don't Ask",    shortTitle:"DontAsk", indicator:"don't ask"
//   "Manual",       shortTitle:"Manual",  indicator:"manual mode"
//   "Plan",         shortTitle:"Plan",    indicator:"plan mode"
//
// NOT ONE OF THEM ENDS IN " on", and every pattern here required it. Measured
// against the binary: "manual mode on" and "bypass permissions on" appear
// ZERO times. And `dontAsk` -- a sixth mode, in `--permission-mode`'s own
// choices -- was missing from this module entirely.
//
// WHY THAT IS THE DANGEROUS KIND OF WRONG: parsePermissionMode returns the
// LAST match, so a mode it cannot recognise leaves the previous answer
// standing. Go from Plan to Bypass and the harness keeps reporting Plan --
// one skull, for a session running with no guardrails at all. The display
// understates autonomy, which is the one direction it must never fail in.

test('every indicator the CLI actually prints is recognised', () => {
  // Taken verbatim from the binary's own table, without the " on" this module
  // used to demand.
  assert.strictEqual(parsePermissionMode(['⏵⏵ accept edits']), 'accept edits');
  assert.strictEqual(parsePermissionMode(['⏵⏵ auto mode']), 'auto');
  assert.strictEqual(parsePermissionMode(['⏵⏵ bypass permissions']), 'bypass');
  assert.strictEqual(parsePermissionMode(["⏵⏵ don't ask"]), 'dont ask');
  assert.strictEqual(parsePermissionMode(['⏸ manual mode']), 'manual');
  assert.strictEqual(parsePermissionMode(['⏸ plan mode']), 'plan');
});

test('the older " on" spelling still parses, so a version change cannot blind it', () => {
  // The binary also carries `{label:"accept edits on"}`, `{label:"plan mode on"}`
  // and `{label:"auto mode on"}` for a different surface. Accepting both costs
  // nothing and means a UI revision does not silently return us to reporting a
  // stale mode.
  assert.strictEqual(parsePermissionMode(['accept edits on']), 'accept edits');
  assert.strictEqual(parsePermissionMode(['plan mode on']), 'plan');
  assert.strictEqual(parsePermissionMode(['auto mode on']), 'auto');
  assert.strictEqual(parsePermissionMode(['bypass permissions on']), 'bypass');
});

test('an unrecognised mode is NULL, never the previous answer', () => {
  // The rule that makes the whole thing safe. "I do not know" must not be
  // served as "still Plan" -- that is how one skull gets drawn over a bypass
  // session. A stale answer is worse than no answer here.
  assert.strictEqual(parsePermissionMode(['⏵⏵ some future mode']), null);
  assert.strictEqual(parsePermissionMode([]), null);
  assert.strictEqual(parsePermissionMode(null), null);
});

test('a later line wins, because the status line is redrawn low on the screen', () => {
  assert.strictEqual(parsePermissionMode(['plan mode', 'bypass permissions']), 'bypass');
});

test("don't ask is known, and is treated as risky", () => {
  // It was absent entirely. A mode the harness does not know about is a mode
  // it reports as something else.
  assert.ok(MODES['dont ask'], "'dont ask' must be a known mode");
  assert.strictEqual(MODES['dont ask'].risky, true);
});

test('every mode the CLI offers has an entry here', () => {
  // `claude --help` lists six choices for --permission-mode: acceptEdits,
  // auto, bypassPermissions, manual, dontAsk, plan. Six modes, six entries --
  // asserted so the next one added to the CLI shows up as a failure rather
  // than as a silently stale skull count.
  assert.strictEqual(Object.keys(MODES).length, 6,
    `expected six modes, got ${Object.keys(MODES).join(', ')}`);
});

test('the riskiest modes carry the most skulls, and nothing ties', () => {
  // Skulls are AUTONOMY. Two modes sharing a count would make the scale
  // meaningless at exactly the end where it matters.
  const skulls = Object.values(MODES).map(m => m.skulls);
  assert.strictEqual(new Set(skulls).size, skulls.length, 'no two modes may share a skull count');
  const byRisk = Object.entries(MODES).sort((a, b) => b[1].skulls - a[1].skulls);
  assert.strictEqual(byRisk[0][0], 'bypass', 'bypass must be the most autonomous');
  assert.ok(MODES.plan.skulls < MODES.manual.skulls, 'plan is the safest');
});
