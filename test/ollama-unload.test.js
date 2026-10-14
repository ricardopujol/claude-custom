'use strict';
/** Unload claude-custom's own Ollama models when the LAST host exits (BACKLOG #91): only the last, only ours, bounded, never throws. */
const test = require('node:test');
const assert = require('node:assert');
const { unloadOnLastExit } = require('../host/ollama-unload');

const MODELS = ['llama3.2:3b', 'qwen3.5:4b', 'snowflake-arctic-embed2:latest'];

function rig(handler = async () => ({ status: 200 })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

test('the last host unloads every model it was given, keep_alive 0, on /api/generate', async () => {
  const { calls, fetchImpl } = rig();
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: async () => false, fetchImpl });
  assert.deepStrictEqual(r, { unloaded: true, models: MODELS });
  assert.deepStrictEqual(calls.map(c => [c.url, c.body]), MODELS.map(model => ['http://127.0.0.1:11434/api/generate', { model, keep_alive: 0 }]));
});

test('not the last host: nothing is sent', async () => {
  const { calls, fetchImpl } = rig();
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: async () => true, fetchImpl });
  assert.deepStrictEqual(r, { unloaded: false, reason: 'other-host' });
  assert.strictEqual(calls.length, 0);
});

test('could not tell (null, a throw, a non-boolean): nothing is sent', async () => {
  for (const anotherHostRunning of [async () => null, async () => { throw new Error('powershell'); }, () => { throw new Error('sync'); }, async () => undefined, async () => 0]) {
    const { calls, fetchImpl } = rig();
    const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning, fetchImpl });
    assert.deepStrictEqual(r, { unloaded: false, reason: 'unknown' });
    assert.strictEqual(calls.length, 0);
  }
});

test('only the names given are unloaded: blanks, non-strings and repeats are dropped', async () => {
  const { calls, fetchImpl } = rig();
  await unloadOnLastExit({ models: ['a:1', 'a:1', '', '  ', null, 7, 'b:2'], anotherHostRunning: async () => false, fetchImpl });
  assert.deepStrictEqual(calls.map(c => c.body.model), ['a:1', 'b:2']);
});

test('no models: nothing is asked, not even whether another host runs', async () => {
  let asked = false;
  const { calls, fetchImpl } = rig();
  const r = await unloadOnLastExit({ models: [], anotherHostRunning: async () => { asked = true; return false; }, fetchImpl });
  assert.deepStrictEqual(r, { unloaded: false, reason: 'no-models' });
  assert.strictEqual(asked, false);
  assert.strictEqual(calls.length, 0);
});

test('Ollama down: resolves with a reason, never throws', async () => {
  const { fetchImpl } = rig(async () => { throw new Error('ECONNREFUSED'); });
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: async () => false, fetchImpl });
  assert.deepStrictEqual(r, { unloaded: false, reason: 'ollama-down' });
});

test('a model Ollama does not know (404) is not counted as unloaded; the others are', async () => {
  const { fetchImpl } = rig(async (url, init) => ({ status: JSON.parse(init.body).model === 'qwen3.5:4b' ? 404 : 200 }));
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: async () => false, fetchImpl });
  assert.deepStrictEqual(r, { unloaded: true, models: ['llama3.2:3b', 'snowflake-arctic-embed2:latest'] });
});

test('an Ollama that never answers is cut off at the deadline', async () => {
  const { fetchImpl } = rig((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const t0 = Date.now();
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: async () => false, fetchImpl, timeoutMs: 60 });
  assert.deepStrictEqual(r, { unloaded: false, reason: 'ollama-down' });
  assert.ok(Date.now() - t0 < 1000, 'bounded');
});

test('a fetch that ignores the abort signal still cannot outlast the deadline', async () => {
  const { fetchImpl } = rig(() => new Promise(() => {}));
  const t0 = Date.now();
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: async () => false, fetchImpl, timeoutMs: 60 });
  assert.strictEqual(r.unloaded, false);
  assert.ok(Date.now() - t0 < 1000, 'bounded');
});

test('a host listing that never settles is cut off at the same deadline, and nothing is sent', async () => {
  const { calls, fetchImpl } = rig();
  const t0 = Date.now();
  const r = await unloadOnLastExit({ models: MODELS, anotherHostRunning: () => new Promise(() => {}), fetchImpl, timeoutMs: 60 });
  assert.deepStrictEqual(r, { unloaded: false, reason: 'unknown' });
  assert.strictEqual(calls.length, 0);
  assert.ok(Date.now() - t0 < 1000, 'bounded');
});

test('baseUrl is honoured (trailing slashes trimmed)', async () => {
  const { calls, fetchImpl } = rig();
  await unloadOnLastExit({ models: ['m:1'], anotherHostRunning: async () => false, fetchImpl, baseUrl: 'http://127.0.0.1:9//' });
  assert.strictEqual(calls[0].url, 'http://127.0.0.1:9/api/generate');
});

// Wiring pin (host.js is a process, not a module): every quit path that ends in process.exit goes through exitAfterUnload, and the
// models it names are claude-custom's own three.
test('host.js: SIGINT, SIGTERM, stop and stop-if-idle all exit through exitAfterUnload, with only claude-custom\'s own models', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'host', 'host.js'), 'utf8');
  assert.match(src, /process\.on\('SIGINT', \(\) => \{ exitAfterUnload\(\); \}\)/);
  assert.match(src, /process\.on\('SIGTERM', \(\) => \{ exitAfterUnload\(\); \}\)/);
  assert.match(src, /console\.log\('\[host\] stop requested'\);\s*exitAfterUnload\(\);/);
  assert.strictEqual((src.match(/exitAfterUnload\(\); \}/g) || []).length, 4);
  assert.match(src, /models: \[SUMMARY_MODEL, askOllama\.answerModel, askOllama\.embedModel\]/);
  assert.match(src, /rows\.some\(r => r\.pid !== process\.pid\)\) return true;\s*return verified \? false : null;/);
});
