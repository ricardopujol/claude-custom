'use strict';
/**
 * Council seats — up to three, and the rule that makes the council worth having.
 *
 * From the locked design: an ensemble only helps if the models FAIL
 * DIFFERENTLY. Every agent in this system runs on the same Claude model, so
 * three of them agreeing is a shared blind spot rather than confirmation. The
 * council exists to seat models that are genuinely uncorrelated.
 *
 * That makes "no Claude in the seats" a CORRECTNESS rule, not a preference:
 * seating Claude-via-OpenRouter re-correlates the ensemble with the layer
 * already running it, and the council keeps producing agreement that means
 * nothing. It is the one rule here that fails silently -- everything still
 * works, the answers just stop being independent.
 */
const test = require('node:test');
const assert = require('node:assert');

const { addSeat, removeSeat, MAX_SEATS, seatWarnings } = require('../host/seats');

const m = (id, over = {}) => ({ id, name: id, provider: id.split('/')[0], tools: true, ...over });

// --- the cap ------------------------------------------------------------------

test('three seats is the cap, and a fourth is refused rather than rotating one out', () => {
  // Silently dropping a seat to make room would change the council's
  // composition without saying so.
  let seats = [];
  for (const id of ['a/one', 'b/two', 'c/three']) seats = addSeat(seats, m(id)).seats;
  assert.strictEqual(seats.length, MAX_SEATS);

  const r = addSeat(seats, m('d/four'));
  assert.strictEqual(r.seats.length, 3);
  assert.deepStrictEqual(r.seats.map(s => s.id), ['a/one', 'b/two', 'c/three']);
  assert.match(r.error, /three/i);
});

test('a seat can be removed to make room', () => {
  let seats = [];
  for (const id of ['a/one', 'b/two', 'c/three']) seats = addSeat(seats, m(id)).seats;
  seats = removeSeat(seats, 'b/two');
  assert.deepStrictEqual(seats.map(s => s.id), ['a/one', 'c/three']);
  assert.strictEqual(addSeat(seats, m('d/four')).error, null);
});

test('removing a seat that is not there changes nothing', () => {
  const seats = addSeat([], m('a/one')).seats;
  assert.deepStrictEqual(removeSeat(seats, 'nope').map(s => s.id), ['a/one']);
});

test('the same model cannot take two seats', () => {
  // Two seats holding one model is an ensemble of one wearing a disguise, and
  // it looks like a full council on screen.
  const seats = addSeat([], m('a/one')).seats;
  const r = addSeat(seats, m('a/one'));
  assert.strictEqual(r.seats.length, 1);
  assert.match(r.error, /already/i);
});

// --- the rule that makes the council mean anything ---------------------------

test('a Claude model is refused a seat', () => {
  // The whole premise: the orchestrating layer is already Claude. Seating
  // Claude again re-correlates the ensemble and the council keeps agreeing
  // with itself.
  for (const id of ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5']) {
    const r = addSeat([], m(id));
    assert.deepStrictEqual(r.seats, [], id);
    assert.match(r.error, /claude|diversity/i, id);
  }
});

test('the Claude check is on the PROVIDER, not the display name', () => {
  // A model merely named "claude-ish" from another provider is not Claude, and
  // a non-Anthropic provider shipping a model with Claude in the title must not
  // be blocked -- nor must an Anthropic model sneak in under a bland name.
  assert.strictEqual(addSeat([], m('someone/claudia-7b')).error, null);
  assert.match(addSeat([], m('anthropic/whatever')).error, /claude|diversity/i);
});

test('two seats from the SAME provider are allowed but warned about', () => {
  // Not refused -- there are legitimate reasons -- but two OpenAI models share
  // far more failure modes with each other than with a Gemini, and a council
  // that looks diverse and is not is the exact failure this feature exists to
  // avoid.
  let seats = addSeat([], m('openai/gpt-5.1')).seats;
  const r = addSeat(seats, m('openai/gpt-5-mini'));
  assert.strictEqual(r.error, null, 'it is allowed');
  assert.strictEqual(r.seats.length, 2);

  const warnings = seatWarnings(r.seats);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /openai/i);
  assert.match(warnings[0], /same provider|diversity|correlat/i);
});

test('three distinct providers warn about nothing', () => {
  let seats = [];
  for (const id of ['openai/gpt-5.1', 'google/gemini-2.5-pro', 'x-ai/grok-4']) {
    seats = addSeat(seats, m(id)).seats;
  }
  assert.deepStrictEqual(seatWarnings(seats), []);
});

test('a single seat is warned as not being a council at all', () => {
  // One seat is a second opinion, which is useful and is not what this is. Said
  // plainly rather than left to be inferred from a short list.
  const seats = addSeat([], m('openai/gpt-5.1')).seats;
  const warnings = seatWarnings(seats);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /one model|single|not a council/i);
});

test('no seats warns about nothing, because nothing has been claimed yet', () => {
  assert.deepStrictEqual(seatWarnings([]), []);
});

// --- shape --------------------------------------------------------------------

test('a seat keeps only what the council needs, not the whole catalogue row', () => {
  // The seats are persisted. Storing a whole catalogue row would freeze stale
  // pricing into a file and invite someone reading it as current.
  const r = addSeat([], m('openai/gpt-5.1', { promptPerM: 1.25, context: 400000 }));
  assert.deepStrictEqual(Object.keys(r.seats[0]).sort(), ['id', 'name', 'provider']);
});

test('seating never mutates the list it was given', () => {
  const seats = addSeat([], m('a/one')).seats;
  const before = JSON.stringify(seats);
  addSeat(seats, m('b/two'));
  removeSeat(seats, 'a/one');
  assert.strictEqual(JSON.stringify(seats), before);
});

test('a junk model cannot take a seat', () => {
  for (const bad of [null, undefined, {}, { id: '' }, 'nope']) {
    const r = addSeat([], bad);
    assert.deepStrictEqual(r.seats, [], JSON.stringify(bad));
    assert.ok(r.error, JSON.stringify(bad));
  }
});

test('a corrupt persisted seat list does not take the picker down', () => {
  // These come off disk, where anything can happen.
  for (const bad of [null, 'x', 42, {}]) {
    assert.deepStrictEqual(seatWarnings(bad), [], JSON.stringify(bad));
    assert.strictEqual(addSeat(bad, m('a/one')).seats.length, 1, JSON.stringify(bad));
  }
});
