'use strict';
/**
 * BACKLOG #80 / #55: the bubble service. On an agent's state change it asks (through the rate gate, the shared GPU slot and the
 * local model) for one joke line and broadcasts it. Ollama missing, slow, or the GPU busy: nothing, and never an error.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createBubbleGate, MIN_GAP_MS } = require('../host/bubble-gate');
const { createBubbles, createBubbleSettings, TTL_MS, FAILURE_COOLDOWN_MS } = require('../host/bubbles');

function rig(over = {}) {
  let t = 10_000_000;
  const sent = [];
  const calls = [];
  const slotLog = [];
  const o = {
    reply: { ok: true, text: 'Back to the grind!' },
    slotFree: true,
    voice: null,
    enabled: true,
    visible: true,
    ...over,
  };
  const ollama = { generate: async (req) => { calls.push(req); if (o.throwOnGenerate) throw new Error('boom'); return o.reply; } };
  const slot = { tryAcquire: () => { slotLog.push('acquire'); return o.slotFree; }, release: () => slotLog.push('release') };
  const svc = createBubbles({
    gate: createBubbleGate({ now: () => t }),
    ollama, slot,
    voiceOf: async () => o.voice,
    contextOf: () => ({ tool: 'Edit', files: ['C:\\p\\app.js'], task: 'review the diff' }),
    settings: { enabled: () => o.enabled },
    broadcast: (m) => sent.push(m),
    log: () => {},
    now: () => t,
  });
  return { svc, sent, calls, slotLog, o, time: () => t, advance: (d) => { t += d; } };
}

test('a state change yields one bubble frame with the line, the agent, the state and 8 seconds to live', async () => {
  const r = rig();
  const out = await r.svc.onMood({ agent: 'miguel', state: 'working' });
  assert.strictEqual(out.shown, true);
  assert.deepStrictEqual(r.sent, [{ type: 'bubble', agent: 'miguel', state: 'working', text: 'Back to the grind!', ttlMs: TTL_MS }]);
  assert.strictEqual(TTL_MS, 8000);
});

test('the model is asked with the trimmed prompt, a small budget and a lively temperature', async () => {
  const r = rig();
  await r.svc.onMood({ agent: 'miguel', state: 'working' });
  const req = r.calls[0];
  assert.match(req.prompt, /Files: app\.js/);
  assert.match(req.prompt, /Task: review the diff/);
  assert.ok(req.numPredict <= 80);
  assert.ok(req.temperature >= 0.7);
});

test("the agent's own voice reaches the system prompt", async () => {
  const r = rig({ voice: { description: 'Reviewer who writes in Spanish', signOff: 'Sign off with Hasta luego.' } });
  await r.svc.onMood({ agent: 'miguel', state: 'happy' });
  assert.match(r.calls[0].system, /Spanish/);
  assert.match(r.calls[0].system, /Hasta luego/);
});

test('a voice lookup that throws is a neutral voice, not a lost bubble', async () => {
  const r = rig();
  const svc = createBubbles({
    gate: createBubbleGate(), ollama: { generate: async () => ({ ok: true, text: 'Hi.' }) }, slot: { tryAcquire: () => true, release() {} },
    voiceOf: async () => { throw new Error('no file'); }, contextOf: () => ({}), settings: { enabled: () => true },
    broadcast: (m) => r.sent.push(m), log: () => {},
  });
  assert.strictEqual((await svc.onMood({ agent: 'a', state: 'working' })).shown, true);
});

test('off: no model request at all', async () => {
  const r = rig({ enabled: false });
  const out = await r.svc.onMood({ agent: 'a', state: 'working' });
  assert.deepStrictEqual(out, { shown: false, reason: 'off' });
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.slotLog.length, 0);
});

test('hidden by the window (agent images off, or lean): no model request', async () => {
  const r = rig();
  r.svc.setVisible(false);
  assert.deepStrictEqual(await r.svc.onMood({ agent: 'a', state: 'working' }), { shown: false, reason: 'hidden' });
  assert.strictEqual(r.calls.length, 0);
  r.svc.setVisible(true);
  assert.strictEqual((await r.svc.onMood({ agent: 'a', state: 'working' })).shown, true);
});

test('only the four moods make a bubble', async () => {
  const r = rig();
  assert.strictEqual((await r.svc.onMood({ agent: 'a', state: 'plotting' })).shown, false);
  assert.strictEqual((await r.svc.onMood({ agent: '', state: 'working' })).shown, false);
  assert.strictEqual((await r.svc.onMood(null)).shown, false);
  assert.strictEqual(r.calls.length, 0);
});

test('the same agent twice inside three minutes: the second is dropped without a model request', async () => {
  const r = rig();
  await r.svc.onMood({ agent: 'a', state: 'working' });
  const second = await r.svc.onMood({ agent: 'a', state: 'happy' });
  assert.deepStrictEqual(second, { shown: false, reason: 'rate' });
  assert.strictEqual(r.calls.length, 1);
  r.advance(MIN_GAP_MS);
  assert.strictEqual((await r.svc.onMood({ agent: 'a', state: 'sleeping' })).shown, true);
});

test('a second agent while a request is running is dropped (one request at a time)', async () => {
  let release;
  const held = new Promise((res) => { release = res; });
  const sent = [];
  const svc = createBubbles({
    gate: createBubbleGate(), slot: { tryAcquire: () => true, release() {} },
    ollama: { generate: async () => { await held; return { ok: true, text: 'Slow joke.' }; } },
    voiceOf: async () => null, contextOf: () => ({}), settings: { enabled: () => true },
    broadcast: (m) => sent.push(m), log: () => {},
  });
  const first = svc.onMood({ agent: 'a', state: 'working' });
  const second = await svc.onMood({ agent: 'b', state: 'working' });
  assert.deepStrictEqual(second, { shown: false, reason: 'busy' });
  release();
  assert.strictEqual((await first).shown, true);
  assert.strictEqual(sent.length, 1);
});

test('the GPU slot busy (a summary is running): dropped, and the gate is freed', async () => {
  const r = rig({ slotFree: false });
  assert.deepStrictEqual(await r.svc.onMood({ agent: 'a', state: 'working' }), { shown: false, reason: 'gpu-busy' });
  assert.strictEqual(r.calls.length, 0);
  assert.deepStrictEqual(r.slotLog, ['acquire']);        // nothing to release: it never held it
  r.o.slotFree = true;
  assert.strictEqual((await r.svc.onMood({ agent: 'b', state: 'working' })).shown, true);
});

test('the slot is released after a bubble, and after a failure', async () => {
  const r = rig();
  await r.svc.onMood({ agent: 'a', state: 'working' });
  assert.deepStrictEqual(r.slotLog, ['acquire', 'release']);
  const bad = rig({ throwOnGenerate: true });
  await bad.svc.onMood({ agent: 'a', state: 'working' });
  assert.deepStrictEqual(bad.slotLog, ['acquire', 'release']);
});

test('Ollama down, slow or missing the model: no bubble, no throw, nothing broadcast', async () => {
  for (const reason of ['ollama-down', 'timeout', 'model-missing', 'bad-reply', 'http']) {
    const r = rig({ reply: { ok: false, reason } });
    const out = await r.svc.onMood({ agent: 'a', state: 'working' });
    assert.strictEqual(out.shown, false, reason);
    assert.deepStrictEqual(r.sent, [], reason);
  }
});

test('a generate that throws is caught: no bubble, no error', async () => {
  const r = rig({ throwOnGenerate: true });
  const out = await r.svc.onMood({ agent: 'a', state: 'working' });
  assert.strictEqual(out.shown, false);
  assert.deepStrictEqual(r.sent, []);
});

test('after a failure the service leaves Ollama alone for a while, then tries again', async () => {
  const r = rig({ reply: { ok: false, reason: 'ollama-down' } });
  await r.svc.onMood({ agent: 'a', state: 'working' });
  assert.strictEqual(r.calls.length, 1);
  const again = await r.svc.onMood({ agent: 'b', state: 'working' });
  assert.deepStrictEqual(again, { shown: false, reason: 'cooling-off' });
  assert.strictEqual(r.calls.length, 1);
  r.advance(FAILURE_COOLDOWN_MS);
  r.o.reply = { ok: true, text: 'Back!' };
  assert.strictEqual((await r.svc.onMood({ agent: 'b', state: 'working' })).shown, true);
});

test('an unusable reply (code, a link) shows nothing', async () => {
  const r = rig({ reply: { ok: true, text: 'see https://x.test' } });
  assert.deepStrictEqual(await r.svc.onMood({ agent: 'a', state: 'working' }), { shown: false, reason: 'unusable' });
  assert.deepStrictEqual(r.sent, []);
});

test('a broadcast that throws does not leak out of onMood', async () => {
  const svc = createBubbles({
    gate: createBubbleGate(), slot: { tryAcquire: () => true, release() {} }, ollama: { generate: async () => ({ ok: true, text: 'Hi.' }) },
    voiceOf: async () => null, contextOf: () => ({}), settings: { enabled: () => true },
    broadcast: () => { throw new Error('socket'); }, log: () => {},
  });
  assert.strictEqual((await svc.onMood({ agent: 'a', state: 'working' })).shown, false);
});

test('PROPERTY: over random mood events, broadcasts per agent are three minutes apart and never overlap', async () => {
  const ev = fc.record({ a: fc.constantFrom('a', 'b', 'c'), s: fc.constantFrom('working', 'happy', 'stressed', 'sleeping'), dt: fc.integer({ min: 0, max: 200_000 }) });
  await fc.assert(fc.asyncProperty(fc.array(ev, { maxLength: 40 }), async (events) => {
    const r = rig();
    const at = new Map();
    for (const e of events) {
      r.advance(e.dt);
      const out = await r.svc.onMood({ agent: e.a, state: e.s });
      if (out.shown) {
        const last = at.get(e.a);
        if (last !== undefined) assert.ok(r.time() - last >= MIN_GAP_MS);
        at.set(e.a, r.time());
      }
    }
  }), { numRuns: 50 });
});

// --- the setting ---------------------------------------------------------------------------------

test('bubbles are on by default; the choice persists across a fresh store object', () => {
  const dir = tmpDir('bubbles');
  const a = createBubbleSettings({ store: createStore({ dir }) });
  assert.strictEqual(a.enabled(), true);
  assert.strictEqual(a.set(false).ok, true);
  assert.strictEqual(a.enabled(), false);
  const b = createBubbleSettings({ store: createStore({ dir }) });
  assert.strictEqual(b.enabled(), false);
});

test('a non-boolean setting is refused', () => {
  const s = createBubbleSettings({ store: createStore({ dir: tmpDir('bubbles') }) });
  assert.strictEqual(s.set('yes').ok, false);
  assert.strictEqual(s.set(undefined).ok, false);
  assert.strictEqual(s.enabled(), true);
});

test('a corrupt settings file reads as the default, and a failed write is reported', () => {
  const fs = require('node:fs');
  const dir = tmpDir('bubbles');
  const store = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(store.pathOf('bubbles'), 'not json');
  const s = createBubbleSettings({ store });
  assert.strictEqual(s.enabled(), true);
  const broken = createBubbleSettings({ store: { read: () => null, write: () => { throw new Error('disk'); } } });
  assert.strictEqual(broken.set(false).ok, false);
});
