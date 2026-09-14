'use strict';
/**
 * Which permission mode the hosted session is in.
 *
 * Read from the TUI's own status line rather than tracked independently: the
 * user can change it at any time with shift+tab, and the terminal is the only
 * authority on what it currently says.
 *
 * Five modes, measured by cycling shift+tab against a live session in
 * verify/probe-detach.js. The design assumed three.
 */

// `skulls` is AUTONOMY, counted the way shift+tab walks it: plan is the safest
// at one, bypass the most autonomous at five. More skulls means more happens
// without asking you.
//
// `rank` is kept as the inverse (restrictiveness) because the ordering logic
// elsewhere reads more naturally that way; skulls is what the UI draws.
const MODES = {
  plan: { label: 'Plan', skulls: 1, rank: 4, risky: false, hint: 'read-only, nothing changes' },
  manual: { label: 'Manual', skulls: 2, rank: 3, risky: false, hint: 'every tool asks first' },
  'accept edits': { label: 'Accept edits', skulls: 3, rank: 2, risky: false, hint: 'edits auto-approved' },
  auto: { label: 'Auto', skulls: 4, rank: 1, risky: false, hint: 'the classifier decides' },
  bypass: { label: 'Bypass', skulls: 5, rank: 0, risky: true, hint: 'everything runs unprompted' },
};

// Order matters: "bypass permissions on" also contains no other mode name, but
// matching longest-first avoids any future overlap surprising us.
const PATTERNS = [
  ['bypass', /bypass permissions on/i],
  ['accept edits', /accept edits on/i],
  ['auto', /auto mode on/i],
  ['manual', /manual mode on/i],
  ['plan', /plan mode on/i],
];

function parsePermissionMode(lines) {
  // Last match wins: the status line is redrawn near the bottom of the screen,
  // so a later occurrence is the current one.
  let found = null;
  for (const line of lines || []) {
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) found = name;
    }
  }
  return found;
}

module.exports = { parsePermissionMode, MODES };
