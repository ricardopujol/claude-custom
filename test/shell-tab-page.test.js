'use strict';
/**
 * BACKLOG #119 A5, PR #208 review: what the PAGE does when its host is a plain shell host.
 *   - Dexter 4: the header never says "reading account limits..." for ever (a shell host reads no quota);
 *   - Miguel Y3: nothing of Claude's is typed into a shell: not the top bar's /model, not the wand, not the Git drawer's
 *     Run /merged, not the reader's @mention, not Claude's panel; and no Enter is ever pressed for one.
 * The decisions are pure (app/top-bar-display.js, app/submit-gate.js, app/quota-display.js); the renderer is a plain <script> that
 * can't be required, so its wiring is pinned as source, in the style of test/quota-countdown-wiring.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { quotaDisplay } = require('../app/quota-display');
const { planTyping, planSwitch, SHELL_TAB_REFUSAL } = require('../app/top-bar-display');
const submitGate = require('../app/submit-gate');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

test('quotaDisplay: a shell tab shows nothing, whatever the payload; every other tab keeps "reading" for a null payload', () => {
  for (const q of [null, undefined, { ok: false, windows: [] }, { ok: true, windows: [] }]) {
    const d = quotaDisplay(q, Date.now(), 'shell');
    assert.deepStrictEqual(d, { state: 'hidden', note: '', meters: [] });
  }
  assert.strictEqual(quotaDisplay(null, Date.now(), null).state, 'reading');
  assert.strictEqual(quotaDisplay(null).state, 'reading');
  assert.strictEqual(quotaDisplay(null, Date.now(), 'side').state, 'reading');
});

test('planTyping: a shell tab refuses every kind of command before anything else is asked', () => {
  const ready = { screen: 'ready', connected: true, hostKind: 'shell' };
  for (const [command, kind] of [['/model opus', undefined], ['/merged', undefined], ['@src/a.js#L1-2', 'mention'], ['(from Claude\'s panel) hi', 'panel']]) {
    const r = planTyping({ command, kind, ...ready });
    assert.deepStrictEqual(r, { ok: false, reason: SHELL_TAB_REFUSAL }, command);
  }
  assert.strictEqual(planTyping({ command: '/model opus', screen: 'ready', connected: true }).ok, true, 'any other tab still types');
  assert.strictEqual(planTyping({ command: '/model opus', screen: 'ready', connected: true, hostKind: null }).ok, true);
});

test('planSwitch (the top bar\'s model and effort switches): refused on a shell tab, with the reason in the notice', () => {
  for (const kind of ['model', 'effort']) {
    const r = planSwitch({ kind, raw: kind === 'model' ? 'opus' : 'high', current: null, screen: 'ready', connected: true, hostKind: 'shell' });
    assert.strictEqual(r.ok, false);
    assert.match(r.notice, /plain shell tab/);
  }
  assert.strictEqual(planSwitch({ kind: 'model', raw: 'opus', current: null, screen: 'ready', connected: true }).ok, true);
});

test('planSubmit: no Enter for a shell tab, in any turn state, type-only or not, and it says why', () => {
  for (const turn of ['idle', 'turn', 'prompt', null, 'x']) {
    for (const typeOnly of [false, true, undefined]) {
      const g = submitGate.planSubmit({ turn, typeOnly, kind: 'shell' });
      assert.strictEqual(g.enter, false, `${turn}/${typeOnly}`);
      assert.strictEqual(g.recheck, false);
      assert.match(g.reason, /plain shell tab/);
    }
  }
  assert.strictEqual(submitGate.planSubmit({ turn: 'idle', typeOnly: false }).enter, true, 'other tabs are unchanged');
  assert.strictEqual(submitGate.planSubmit({ turn: 'idle', typeOnly: false }).reason, null);
});

// --- the renderer's wiring ---

const renderer = read('app/renderer.js');

test('renderer: the hello sets the host kind, and only "shell" counts', () => {
  assert.match(renderer, /notePtyBackend\(msg\.ptyBackend\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*hostKind = msg\.kind === 'shell' \? 'shell' : null;/);
});

test('renderer: the quota display is asked with the host kind', () => {
  assert.match(renderer, /quotaDisplay\(quotaSettlePastResets\(lastQuotaPayload, nowMs\), nowMs, hostKind\)/);
});

test('renderer: every typing path is gated on the host kind: the choke point, the planners and the submit gate', () => {
  const tc = renderer.slice(renderer.indexOf('function typeAndCheck('), renderer.indexOf('function typeAndCheck(') + 600);
  assert.match(tc, /if \(hostKind === 'shell'\) \{ done\(\{ ok: false, reason: SHELL_TAB_REFUSAL \}\); return; \}\s*\n\s*if \(typingBusy\)/, 'refuses before anything is typed');
  assert.match(renderer, /planSwitch\(\{[\s\S]{0,300}?hostKind,\s*\n\s*\}\);/);
  assert.match(renderer, /planTyping\(\{[\s\S]{0,400}?hostKind,/);
  assert.match(renderer, /planSubmit\(\{ turn: sessionTurn, typeOnly, kind: hostKind \}\);\s*\n\s*if \(gate\.reason\) \{ done\(\{ ok: false, reason: gate\.reason \}\); return; \}/);
});

test('renderer: every function that sends programmatic keystrokes to the pty is reached only through typeAndCheck or pressEnter', () => {
  // The inventory of `type: 'input'` senders: the user's own typing (xterm onData) is not among them. A new one fails here until it is gated.
  const senders = renderer.split('\n').filter(l => /type: 'input'/.test(l)).map(l => l.trim().slice(0, 60));
  assert.ok(senders.length >= 4, senders.join(' | '));
  const lines = renderer.split('\n');
  // handleProbeAction's gitTermInput is a probe-only door (CLAUDE_CUSTOM_TABS_PROBE), not a user path.
  const where = lines.map((l, i) => (/type: 'input'/.test(l) && !lines.slice(Math.max(0, i - 3), i).some(p => /gitTermInput/.test(p)) ? i : -1)).filter(i => i >= 0).map(i => {
    for (let j = i; j >= 0; j--) { const m = /^(?:async )?function (\w+)\(/.exec(lines[j]); if (m) return m[1]; }
    return null;
  });
  const allowed = new Set(['typeAndCheck', 'typePlanned', 'pressEnter', 'clearTypedLine']);
  const outsiders = where.filter(n => !allowed.has(n));
  assert.deepStrictEqual(outsiders, [], where.join(','));
});

test('host: the hello carries the kind from the one identity helper', () => {
  const host = read('host/host.js');
  assert.match(host, /type: 'hello',\s*\n(?:\s*\/\/[^\n]*\n)*\s*kind: identityFor\(\)\.kind,/);
});

// --- Dexter r2 N2 (a failed start lingers) and N3 (the terminal's end line) ---

test('N2: the failed-start linger is at least two of the window\'s 150 ms probes and bounded', () => {
  const { FAILED_START_LINGER_MS } = require('../app/../host/shell-tab');
  assert.ok(FAILED_START_LINGER_MS >= 300, String(FAILED_START_LINGER_MS));
  assert.ok(FAILED_START_LINGER_MS <= 5000, String(FAILED_START_LINGER_MS));
});

test('N2: the host passes the linger to endHost for a failed start only, delays process.exit by it, and sends the frame to a late client', () => {
  const host = read('host/host.js');
  assert.match(host, /error: started\.frame\.error \}, FAILED_START_LINGER_MS\);/);
  const end = host.slice(host.indexOf('function endHost('), host.indexOf('function endHost(') + 600);
  assert.match(end, /if \(lingerMs > 0\) \{ setTimeout\(\(\) => process\.exit\(exitCode \?\? 0\), lingerMs\); return; \}\s*\n\s*process\.exit\(exitCode \?\? 0\);/);
  assert.match(host, /endHost\(exitCode, signal\);/, 'an exited shell or claude still ends at once');
  assert.match(host, /if \(endedFrame\) ws\.send\(endedFrame\);/);
});

test('N3: the terminal\'s end line names the shell and the reason for a shell tab, and stays "[claude exited]" otherwise', () => {
  const { shellExitText } = require('../app/top-bar-display');
  assert.strictEqual(shellExitText(null, undefined), '[claude exited]');
  assert.strictEqual(shellExitText(null, 'File not found: nu'), '[claude exited]', 'a claude tab ignores any reason');
  assert.strictEqual(shellExitText('shell', undefined), '[shell exited]');
  assert.strictEqual(shellExitText('shell', ''), '[shell exited]');
  assert.strictEqual(shellExitText('shell', 'File not found: nu'), '[shell exited: File not found: nu]');
});

test('N3: the reason is plain text: control characters are blanked, it is trimmed and bounded, non-strings are no reason', () => {
  const { shellExitText } = require('../app/top-bar-display');
  assert.strictEqual(shellExitText('shell', '\x1b]0;x\x07boom\r\n'), '[shell exited: ]0;x boom]');
  assert.ok(!/[\x00-\x1f]/.test(shellExitText('shell', 'a\x1b[31mb\x00c')));
  assert.ok(shellExitText('shell', 'x'.repeat(5000)).length <= 300 + '[shell exited: ]'.length);
  for (const v of [42, {}, [], null]) assert.strictEqual(shellExitText('shell', v), '[shell exited]');
});

test('N3: the renderer writes the exit line through shellExitText with the host kind and the frame\'s error', () => {
  assert.match(renderer, /term\.write\('\\r\\n\\x1b\[33m' \+ shellExitText\(hostKind, msg\.error\) \+ '\\x1b\[0m\\r\\n'\);/);
});
