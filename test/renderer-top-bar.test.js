'use strict';
/**
 * FF12's wiring in app/renderer.js and app/renderer.html. The decisions are
 * pure and tested in test/top-bar-display.test.js; these pin that the browser
 * script actually USES them. Source assertions, in the style of
 * test/renderer-dispatch.test.js: renderer.js cannot be required.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MODEL_CHOICES, EFFORT_LEVELS } = require('../app/top-bar-display');

const JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');

// The body of `if (msg.type === 'X') { ... return; }`, up to the next branch.
function branch(type) {
  const start = JS.indexOf(`if (msg.type === '${type}')`);
  assert.ok(start !== -1, `renderer.js must handle ${type}`);
  const next = JS.indexOf('if (msg.type ===', start + 10);
  return JS.slice(start, next === -1 ? undefined : next);
}

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('the menu offers exactly MODEL_CHOICES and EFFORT_LEVELS, in order (Miguel #3)', () => {
  const models = [...HTML.matchAll(/data-model="([^"]+)"/g)].map(m => m[1]);
  const efforts = [...HTML.matchAll(/data-effort="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(models, MODEL_CHOICES);
  assert.deepStrictEqual(efforts, EFFORT_LEVELS);
});

test('both menus say the pick also becomes the default for new sessions', () => {
  // Measured: /model and /effort save to ~/.claude/settings.json. Approved
  // 2026-09-26: say so rather than hide it.
  for (const id of ['tb-model-menu', 'tb-effort-menu']) {
    const start = HTML.indexOf(`id="${id}"`);
    const menu = HTML.slice(start, HTML.indexOf('\n        </div>', start));
    assert.match(menu, /default for new sessions/, id);
  }
});

test('the liveModel broadcast has a branch, and it confirms only with the truth\'s own timestamp', () => {
  const b = branch('liveModel');
  assert.match(b, /pendingResolver\(/);
  assert.match(b, /at:\s*msg\.at/);
  assert.match(b, /modelMatches\(/);
});

test('the effort branch confirms with modelMatches\' sibling and the truth\'s timestamp', () => {
  const b = branch('effort');
  assert.match(b, /at:\s*msg\.at/);
  assert.match(b, /effortMatches\(/);
});

test('sessionModel NEVER resolves a switch: it is the transcript, written before any /model', () => {
  assert.doesNotMatch(branch('sessionModel'), /pendingResolver|pendingModel\s*=/);
});

test('hello reads the live model', () => {
  assert.match(branch('hello'), /liveModel\s*=\s*typeof msg\.liveModel/);
});

test('a switch is planned before anything is typed, and typed only through send() (Miguel #2)', () => {
  const body = fnBody('requestSwitch');
  assert.match(body, /planSwitch\(/);
  assert.match(body, /inputState\(screenLines\(\)\)/, 'the input box must be checked (Dexter #4)');
  assert.ok(body.indexOf('if (!plan.ok)') < body.indexOf('send('), 'refusal must come before any send');
  assert.doesNotMatch(body, /ws\.send/, 'bypassing send() swallowed a closed socket silently');
  assert.match(body, /\\x15/, 'Ctrl-U must clear the draft first');
});

test('the cursor goes to end-of-line BEFORE Ctrl-U (Dexter r2 N1)', () => {
  // MEASURED live: Ctrl-U deletes only back to the cursor. With the cursor at
  // Home it deleted nothing, and a `sonnet` click submitted
  // `/model sonnetrefactor the parser`. Ctrl-E first clears the whole line.
  const body = fnBody('requestSwitch');
  const end = body.indexOf("input('\\x05')");
  const kill = body.indexOf("input('\\x15')");
  assert.ok(end !== -1, 'Ctrl-E (end of line) must be sent');
  assert.ok(kill !== -1 && end < kill, 'Ctrl-E must come before Ctrl-U');
});

test('the only place renderer.js types a slash command is requestSwitch', () => {
  // The old requestModel/requestEffort typed `/model ${value}\r` in one chunk.
  assert.doesNotMatch(JS, /`\/(model|effort) \$\{/);
  assert.doesNotMatch(JS, /function request(Model|Effort)\(/);
});

test('the pending timeout re-arms until its own request resolves (Dexter #8)', () => {
  const body = fnBody('schedulePendingTimeout');
  // The signature itself names schedulePendingTimeout(kind, request); the
  // reschedule is the call made while the resolver still says "pending".
  assert.match(body, /if \(res\.pending\) \{ schedulePendingTimeout\(kind, request\); return; \}/,
    'must reschedule itself while still pending');
  assert.match(body, /pending !== request/, 'a superseded request must not be timed out');
  assert.match(body, /setTopBarNotice\(kind, switchNotice\(\{ kind, result: res\.result/,
    'a timeout must be surfaced on the chip (Dexter #9)');
});

test('Esc closes an open menu without reaching the terminal, and only then', () => {
  const i = JS.indexOf("e.key === 'Escape'");
  assert.ok(i !== -1);
  const line = JS.slice(i - 80, JS.indexOf('\n', i + 60));
  assert.match(line, /closeTopBarMenus\(\)/);
});
