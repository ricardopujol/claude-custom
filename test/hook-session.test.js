'use strict';
/**
 * host/hook-session.js: what a hook payload says about the MAIN session's
 * permission mode and effort level.
 *
 * Three answers, and the difference between them is the whole point:
 *   undefined -- this payload says nothing about the main session (a
 *                subagent's call, or SessionEnd, which carries neither field)
 *   null      -- it does, and the value is ABSENT or unrecognised
 *   a value   -- it does, and here it is
 *
 * The fixture is the real stream verify/probe-failure-payloads.js captured on
 * `--model haiku`: effort is missing from EVERY event there, because Haiku has
 * no effort levels. FF12 had assumed it was always present (it is, on Opus).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readSessionHook, cliModeToKey, readStatus } = require('../host/hook-session');
const { MODES } = require('../host/mode');

const REAL = fs.readFileSync(path.join(__dirname, 'hooks-real-subagent-failure.fixture.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

test('every permission_mode the CLI accepts maps to a MODES key with the same meaning', () => {
  // Dexter #3: the raw 'bypassPermissions' used to reach the badge, miss the
  // MODES table and render as ONE harmless skull -- for the mode this harness
  // always runs in.
  const expected = {
    default: 'manual',
    acceptEdits: 'accept edits',
    plan: 'plan',
    auto: 'auto',
    dontAsk: 'dont ask',
    bypassPermissions: 'bypass',
  };
  for (const [cli, key] of Object.entries(expected)) {
    assert.strictEqual(cliModeToKey(cli), key, cli);
    assert.ok(MODES[key], `${key} is a real MODES key`);
  }
  assert.strictEqual(MODES[cliModeToKey('bypassPermissions')].skulls, 6);
});

test('an unknown permission_mode is null, never a guess', () => {
  // host/mode.js's own rule: a blank is a question, a stale answer is a lie.
  for (const v of ['', 'bypass', 'BypassPermissions', 'yolo', 'toString', '__proto__']) {
    assert.strictEqual(cliModeToKey(v), null, JSON.stringify(v));
  }
  for (const v of [undefined, null, 5, {}, []]) {
    assert.strictEqual(cliModeToKey(v), null, String(v));
  }
});

test('a main-session payload with no effort field reports effort as ABSENT (null)', () => {
  // The Haiku case. Before this, lastEffort kept whatever an earlier Opus
  // turn had said -- a stale level shown as live.
  const r = readSessionHook({ hook_event_name: 'Stop', permission_mode: 'bypassPermissions' });
  assert.strictEqual(r.effort, null);
  assert.strictEqual(r.permissionMode, 'bypass');
});

test('a main-session payload carrying effort.level reports it', () => {
  const r = readSessionHook({ permission_mode: 'default', effort: { level: 'high' } });
  assert.strictEqual(r.effort, 'high');
  assert.strictEqual(r.permissionMode, 'manual');
});

test('a malformed effort is absent, not a value', () => {
  for (const effort of [null, 'high', {}, { level: 3 }, { level: null }, { level: '' }]) {
    const r = readSessionHook({ permission_mode: 'plan', effort });
    assert.strictEqual(r.effort, null, JSON.stringify(effort));
  }
});

test("a subagent's payload says nothing about the main session", () => {
  // Dexter #7: a subagent may run its own mode or effort (or a Haiku model
  // with none); letting it through would flip the main chip, or resolve a
  // pending /effort against the wrong agent.
  const r = readSessionHook({
    agent_id: 'a1b2', permission_mode: 'plan', effort: { level: 'low' },
  });
  assert.strictEqual(r.effort, undefined);
  assert.strictEqual(r.permissionMode, undefined);
});

test('a payload with no permission_mode (SessionEnd) says nothing', () => {
  const r = readSessionHook({ hook_event_name: 'SessionEnd' });
  assert.strictEqual(r.effort, undefined);
  assert.strictEqual(r.permissionMode, undefined);
});

test('garbage in says nothing', () => {
  for (const p of [undefined, null, 'x', 7, []]) {
    const r = readSessionHook(p);
    assert.strictEqual(r.effort, undefined, String(p));
    assert.strictEqual(r.permissionMode, undefined, String(p));
  }
});

test('PROPERTY: on the real Haiku stream, main-session events read effort ABSENT and mode bypass; subagent and SessionEnd events read nothing', () => {
  let main = 0;
  let silent = 0;
  for (const { event, payload } of REAL) {
    const r = readSessionHook(payload);
    if (payload.agent_id || event === 'SessionEnd') {
      assert.strictEqual(r.effort, undefined, event);
      assert.strictEqual(r.permissionMode, undefined, event);
      silent++;
    } else {
      assert.strictEqual(r.effort, null, event);
      assert.strictEqual(r.permissionMode, 'bypass', event);
      main++;
    }
  }
  // Or the sweep proved nothing.
  assert.ok(main > 0 && silent > 0, `main=${main} silent=${silent}`);
});

test('PROPERTY: an agent_id always silences the payload, whatever else it carries', () => {
  const modes = [undefined, 'default', 'bypassPermissions', 'nonsense'];
  const efforts = [undefined, null, { level: 'high' }, { level: 7 }];
  for (const permission_mode of modes) {
    for (const effort of efforts) {
      const r = readSessionHook({ agent_id: 'x', permission_mode, effort });
      assert.deepStrictEqual(r, {}, JSON.stringify({ permission_mode, effort }));
    }
  }
});

// --- readStatus: the statusLine document (host/status-relay.js) -------------
//
// Always the MAIN session, and MEASURED (verify/probe-top-bar-truth.js) to
// carry model.id and effort.level, re-fired ~1s after /model and /effort.

test('readStatus reads the model id and effort level off a real-shaped document', () => {
  const r = readStatus({ model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' }, effort: { level: 'high' } });
  assert.deepStrictEqual(r, { model: 'claude-sonnet-5', effort: 'high' });
});

test('readStatus: a model with no effort levels reads effort ABSENT, not the last one', () => {
  const r = readStatus({ model: { id: 'claude-haiku-4-5-20251001' } });
  assert.deepStrictEqual(r, { model: 'claude-haiku-4-5-20251001', effort: null });
});

test('readStatus: the display name is never used as the id', () => {
  const r = readStatus({ model: { display_name: 'Sonnet 5' }, effort: { level: 'high' } });
  assert.deepStrictEqual(r, {});
});

test('readStatus: a document with no model says nothing at all', () => {
  // Without a model it is not the document we measured; half-trusting it
  // could clear a real effort level.
  for (const doc of [undefined, null, 'x', {}, { model: null }, { model: { id: '' } }, { model: { id: 5 } }]) {
    assert.deepStrictEqual(readStatus(doc), {}, JSON.stringify(doc));
  }
});

test('readStatus: an empty effort level is absent, not a level named ""', () => {
  assert.strictEqual(readStatus({ model: { id: 'claude-opus-5-5' }, effort: { level: '' } }).effort, null);
});
