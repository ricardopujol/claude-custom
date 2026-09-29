'use strict';
/**
 * Which permission mode the hosted session is in.
 *
 * Read from the TUI's own status line rather than tracked independently: the
 * user can change it at any time with shift+tab, and the terminal is the only
 * authority on what it currently says. The harness never intercepts shift+tab
 * -- the keypress goes to the pty as CSI Z and the CLI does the cycling -- so
 * the ORDER of that cycle is not ours to set, only to read.
 *
 * SIX MODES. The patterns below are taken from the shipped `claude.exe`
 * (v2.1.280), which carries its own table:
 *
 *   "Accept edits",       indicator: "accept edits"
 *   "Auto",               indicator: "auto mode"
 *   "Bypass Permissions", indicator: "bypass permissions"
 *   "Don't Ask",          indicator: "don't ask"
 *   "Manual",             indicator: "manual mode"
 *   "Plan",               indicator: "plan mode"
 *
 * EVERY PATTERN HERE USED TO REQUIRE A TRAILING " on" AND NONE OF THOSE
 * INDICATORS HAS ONE. Measured against the binary: "manual mode on" and
 * "bypass permissions on" appear zero times. `dontAsk` was missing from this
 * module altogether. So three of six modes could never be recognised, and
 * because `parsePermissionMode` returns the LAST match, an unrecognised mode
 * left the PREVIOUS one standing: switch from Plan to Bypass and the harness
 * went on reporting Plan -- one skull, for a session running with no
 * guardrails.
 *
 * That is the failure this whole codebase is organised against, in its single
 * most safety-relevant display, and it is why an unknown mode now returns null
 * rather than the last thing that happened to match. A blank is a question;
 * a stale answer is a lie.
 *
 * The older " on" spellings are still accepted -- the binary carries them for
 * another surface -- because tolerating both costs nothing and means a UI
 * revision cannot quietly return us to reporting a stale mode.
 */

// `skulls` is AUTONOMY, counted the way shift+tab walks it: plan is the safest
// at one, bypass the most autonomous at five. More skulls means more happens
// without asking you.
//
// `rank` is kept as the inverse (restrictiveness) because the ordering logic
// elsewhere reads more naturally that way; skulls is what the UI draws.
const MODES = {
  plan: { label: 'Plan', skulls: 1, rank: 5, risky: false, hint: 'read-only, nothing changes' },
  manual: { label: 'Manual', skulls: 2, rank: 4, risky: false, hint: 'every tool asks first' },
  'accept edits': { label: 'Accept edits', skulls: 3, rank: 3, risky: false, hint: 'edits auto-approved' },
  auto: { label: 'Auto', skulls: 4, rank: 2, risky: false, hint: 'the classifier decides' },
  // SIXTH MODE, and it was missing entirely. `claude --help` lists it among
  // --permission-mode's choices and the CLI's own table calls it "Don't Ask".
  // Ranked just under bypass and marked risky: a mode that does not ask is one
  // the user must see coming, and when its exact behaviour is uncertain the
  // display must err toward MORE autonomy, never less.
  'dont ask': { label: "Don't ask", skulls: 5, rank: 1, risky: true, hint: 'tools run without prompting' },
  bypass: { label: 'Bypass', skulls: 6, rank: 0, risky: true, hint: 'everything runs unprompted' },
};

// Order matters: "bypass permissions on" also contains no other mode name, but
// matching longest-first avoids any future overlap surprising us.
// The CLI's status bar prefixes the mode with one of its own glyphs -- U+23F5
// (a play triangle, doubled for the auto-ish modes) or U+23F8 (pause). Nothing
// in ordinary prose carries them, which is what makes them a safe anchor.
const STATUS_GLYPH = /[⏵⏸]/;

// PRECISE FORMS FIRST. These carry a trailing " on" and appear only in the
// status bar, so they may be matched anywhere on the line.
// The trailing \b is load-bearing and PREDATES this change being needed:
// without it `/plan mode on/i` matches "plan mode ONLY", which the CLI itself
// prints ("start coding (plan mode only)"). A word boundary after "on" does
// not match "only", because n and l are both word characters.
const LABELS = [
  ['bypass', /bypass permissions on\b/i],
  ['accept edits', /accept edits on\b/i],
  ['auto', /auto mode on\b/i],
  ['manual', /manual mode on\b/i],
  ['plan', /plan mode on\b/i],
];

// The binary's own `indicator` strings, which have NO " on" -- and which
// `manual`, `bypass` and `don't ask` are the only rendering of. These are
// ordinary English and appear in prose, in Claude's own output, and in the
// CLI's help text ("cycle between manual mode, auto-accept edit mode, and plan
// mode"), so they are matched ONLY on a line carrying a status glyph.
//
// Longest-first, so "bypass permissions" cannot be shadowed by a shorter one.
const INDICATORS = [
  ['bypass', /bypass permissions/i],
  ['dont ask', /don.t ask/i],
  ['accept edits', /accept edits/i],
  ['auto', /auto mode/i],
  ['manual', /manual mode/i],
  ['plan', /plan mode/i],
];

function parsePermissionMode(lines) {
  // Last match wins: the status line is redrawn near the bottom of the screen,
  // so a later occurrence is the current one.
  let found = null;
  for (const line of lines || []) {
    for (const [name, re] of LABELS) {
      if (re.test(line)) found = name;
    }
    // The loose forms are only trusted on a line the CLI marked as its status.
    if (STATUS_GLYPH.test(line)) {
      for (const [name, re] of INDICATORS) {
        if (re.test(line)) { found = name; break; }
      }
    }
  }
  return found;
}

module.exports = { parsePermissionMode, MODES };
