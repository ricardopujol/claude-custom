'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { buildProviderEnv, describeProvider, PROVIDERS } = require('../host/providers');

test('the default provider changes nothing', () => {
  // Claude Max uses the existing OAuth session. Setting ANTHROPIC_API_KEY here
  // would switch billing to a paid API key without saying so.
  assert.deepStrictEqual(buildProviderEnv({ provider: 'claude-max' }), {});
});

test('an unknown provider falls back to the default rather than half-configuring', () => {
  assert.deepStrictEqual(buildProviderEnv({ provider: 'nonsense' }), {});
});

test('openrouter points the base url at the translating proxy', () => {
  // Claude Code speaks the Anthropic Messages API; OpenRouter is
  // OpenAI-compatible. They are not wire compatible, so a proxy sits between.
  const env = buildProviderEnv({
    provider: 'openrouter',
    baseUrl: 'http://127.0.0.1:8787',
    apiKey: 'sk-or-test',
    model: 'anthropic/claude-3.5-sonnet',
  });
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test');
  assert.strictEqual(env.ANTHROPIC_MODEL, 'anthropic/claude-3.5-sonnet');
});

test('openrouter without a base url refuses rather than silently using Anthropic', () => {
  // Half-applied config is the dangerous case: it would run against Anthropic
  // while the UI claimed OpenRouter, so spend would land somewhere unexpected.
  assert.throws(
    () => buildProviderEnv({ provider: 'openrouter', apiKey: 'sk-or-test' }),
    /baseUrl/
  );
});

test('openrouter without a key refuses', () => {
  assert.throws(
    () => buildProviderEnv({ provider: 'openrouter', baseUrl: 'http://x' }),
    /apiKey/
  );
});

test('the small fast model is set alongside the main one when given', () => {
  // Claude Code uses a cheaper model for background work. Left unset it would
  // ask the proxy for an Anthropic model name that OpenRouter does not know.
  const env = buildProviderEnv({
    provider: 'openrouter', baseUrl: 'http://x', apiKey: 'k',
    model: 'a/b', smallModel: 'c/d',
  });
  assert.strictEqual(env.ANTHROPIC_SMALL_FAST_MODEL, 'c/d');
});

test('never returns a key in the description', () => {
  // The description is logged and shown in the UI.
  const d = describeProvider({ provider: 'openrouter', baseUrl: 'http://x', apiKey: 'sk-or-secret', model: 'a/b' });
  assert.ok(!JSON.stringify(d).includes('sk-or-secret'), JSON.stringify(d));
  assert.strictEqual(d.provider, 'openrouter');
  assert.strictEqual(d.model, 'a/b');
});

test('describes billing honestly per provider', () => {
  // On Max the marginal cost inside quota is zero; on OpenRouter every token is
  // real money. The token counter reads differently as a result.
  assert.strictEqual(describeProvider({ provider: 'claude-max' }).metered, false);
  assert.strictEqual(
    describeProvider({ provider: 'openrouter', baseUrl: 'http://x', apiKey: 'k' }).metered,
    true
  );
});

test('every provider declares a label', () => {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label, name);
  }
});
