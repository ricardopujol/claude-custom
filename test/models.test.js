'use strict';
/**
 * The model catalogue — normalising, filtering and ranking 445 live models.
 *
 * All the judgement here is about what a row MEANS, and every one of those
 * decisions can be silently wrong in a way that still renders:
 *
 *   - OpenRouter prices in dollars PER TOKEN, as strings. Showing that number
 *     as "per million" understates by a factor of a million, and $0.0000006
 *     rounds to $0.00 in any sane formatter -- so every model looks free.
 *   - A model that cannot call tools CANNOT drive the main session: Agent,
 *     hooks and structured output all depend on it. Picking one would break the
 *     harness in a way that looks like the harness being broken.
 *   - "free" and "unpriced" are different, and an unpriced model billed later
 *     is the expensive kind of wrong.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeModel, normalizeCatalogue, sortModels, perMillion,
} = require('../host/models');

// BACKLOG #93 (Ricardo 2026-11-06): filterModels was used only by its own tests; the Models panel filters the rows itself
// (app/models-favourites.js filterCatalogue, tested in models-favourites.test.js). TARGETS went with it (PR #246 Miguel Y4).
test('#93: filterModels and its TARGETS are no longer exported (only their own tests used them)', () => {
  assert.strictEqual(require('../host/models').filterModels, undefined);
  assert.strictEqual(require('../host/models').TARGETS, undefined);
});

// A row shaped like the real endpoint returns. Prices are STRINGS, per token.
const raw = (over = {}) => ({
  id: 'openai/gpt-5.1',
  name: 'OpenAI: GPT-5.1',
  context_length: 400000,
  pricing: { prompt: '0.00000125', completion: '0.00001' },
  supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
  ...over,
});

// --- price, which is the easiest thing to be quietly wrong about -------------

test('prices are converted from per-token to per-million', () => {
  // The endpoint gives dollars per token as a string. Rendered raw, every
  // model on the sheet reads as $0.00 and the picker becomes price-blind.
  const m = normalizeModel(raw());
  assert.strictEqual(m.promptPerM, 1.25);
  assert.strictEqual(m.completionPerM, 10);
});

test('a genuinely free model is free, not unknown', () => {
  const m = normalizeModel(raw({ pricing: { prompt: '0', completion: '0' } }));
  assert.strictEqual(m.promptPerM, 0);
  assert.strictEqual(m.free, true);
  assert.strictEqual(m.priced, true);
});

test('a model with NO pricing is unknown, not free', () => {
  // The expensive kind of wrong: an unpriced row shown as $0.00 invites picking
  // it, and the bill arrives later.
  const m = normalizeModel(raw({ pricing: undefined }));
  assert.strictEqual(m.priced, false);
  assert.strictEqual(m.free, false);
  assert.strictEqual(m.promptPerM, null);
});

test('a malformed price is unknown rather than zero', () => {
  for (const bad of [{ prompt: 'n/a', completion: 'n/a' }, { prompt: null, completion: null }, {}]) {
    const m = normalizeModel(raw({ pricing: bad }));
    assert.strictEqual(m.priced, false, JSON.stringify(bad));
    assert.strictEqual(m.promptPerM, null, JSON.stringify(bad));
  }
});

test('perMillion never renders a real price as zero', () => {
  // $0.0000006/token is $0.60/M. A formatter that rounds to two decimals on the
  // per-token figure prints $0.00 and the row reads as free.
  assert.strictEqual(perMillion('0.0000006'), 0.6);
  assert.strictEqual(perMillion('0.00000000025'), 0.00025);
  assert.strictEqual(perMillion('0'), 0);
  assert.strictEqual(perMillion(undefined), null);
});

// --- tool support, which decides whether a model can drive the session -------

test('tool support is read from supported_parameters', () => {
  assert.strictEqual(normalizeModel(raw()).tools, true);
  assert.strictEqual(normalizeModel(raw({ supported_parameters: ['max_tokens'] })).tools, false);
});

test('a missing supported_parameters is NOT taken as tool support', () => {
  // Fails closed. Claiming tools on a model that has none puts it in the
  // main-session list, where choosing it breaks Agent, hooks and structured
  // output at once -- and it looks like the harness is broken, not the model.
  assert.strictEqual(normalizeModel(raw({ supported_parameters: undefined })).tools, false);
  assert.strictEqual(normalizeModel(raw({ supported_parameters: null })).tools, false);
});

// --- ordering -----------------------------------------------------------------

test('sorting by price puts the cheapest first and the UNPRICED last', () => {
  // An unpriced row sorting as 0 would sit at the top of a "cheapest" list,
  // which is the one place it must not be.
  const list = normalizeCatalogue([
    raw({ id: 'mid', pricing: { prompt: '0.000002', completion: '0' } }),
    raw({ id: 'unpriced', pricing: undefined }),
    raw({ id: 'cheap', pricing: { prompt: '0.0000001', completion: '0' } }),
  ]);
  assert.deepStrictEqual(sortModels(list, 'price').map(m => m.id), ['cheap', 'mid', 'unpriced']);
});

test('sorting by context puts the largest first', () => {
  const list = normalizeCatalogue([
    raw({ id: 'small', context_length: 8000 }),
    raw({ id: 'huge', context_length: 1000000 }),
  ]);
  assert.deepStrictEqual(sortModels(list, 'context').map(m => m.id), ['huge', 'small']);
});

test('sorting is stable and total, so the list never reshuffles on a redraw', () => {
  const list = normalizeCatalogue([
    raw({ id: 'b/x', pricing: { prompt: '0.000001', completion: '0' } }),
    raw({ id: 'a/x', pricing: { prompt: '0.000001', completion: '0' } }),
  ]);
  const once = sortModels(list, 'price').map(m => m.id);
  const twice = sortModels(sortModels(list, 'price'), 'price').map(m => m.id);
  assert.deepStrictEqual(once, twice);
});

// --- the catalogue as a whole -------------------------------------------------

test('a junk row is dropped rather than rendered as a blank', () => {
  const list = normalizeCatalogue([raw(), null, {}, { id: '' }, 'nonsense']);
  assert.deepStrictEqual(list.map(m => m.id), ['openai/gpt-5.1']);
});

test('a catalogue that is not an array yields an empty list, not a throw', () => {
  for (const bad of [null, undefined, {}, 'x', 42]) {
    assert.deepStrictEqual(normalizeCatalogue(bad), [], String(bad));
  }
});

test('the provider is derived from the id, which is where it actually lives', () => {
  assert.strictEqual(normalizeModel(raw({ id: 'google/gemini-2.5-pro' })).provider, 'google');
  assert.strictEqual(normalizeModel(raw({ id: 'noprovider' })).provider, '');
});

test('normalising never mutates the row it was given', () => {
  // The cached catalogue is re-normalised on every filter change.
  const row = raw();
  const before = JSON.stringify(row);
  normalizeModel(row);
  assert.strictEqual(JSON.stringify(row), before);
});
