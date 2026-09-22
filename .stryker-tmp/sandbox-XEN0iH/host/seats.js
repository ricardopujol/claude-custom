// @ts-nocheck
'use strict';
/**
 * Council seats — who sits, and the rule that makes the council worth running.
 *
 * From the locked design (`council-mcp/HANDOFF.md`, and feature #12): an
 * ensemble only helps if the models FAIL DIFFERENTLY. Every agent in this
 * system runs on the same Claude model, so three of them agreeing is a shared
 * blind spot rather than confirmation. The council exists to seat models that
 * are genuinely uncorrelated with the layer orchestrating them.
 *
 * WHICH IS WHY "NO CLAUDE IN THE SEATS" IS A CORRECTNESS RULE, NOT A TASTE ONE.
 * Seating Claude-via-OpenRouter re-correlates the ensemble with the thing
 * already running it, and the council goes on producing agreement that means
 * nothing. It is the one rule here that fails SILENTLY: everything still works,
 * the answers just quietly stop being independent. So it is enforced rather
 * than documented.
 *
 * Same-provider seats are warned about instead of refused. Two OpenAI models
 * share far more failure modes with each other than either does with a Gemini,
 * but there are legitimate reasons to want that, and refusing it would be this
 * module deciding something that is the user's call. A council that LOOKS
 * diverse and is not is the failure worth naming out loud.
 */

const MAX_SEATS = 3;

// The provider segment of an OpenRouter id, which is where the vendor actually
// lives -- not the display name. A model merely named "claudia" from another
// vendor is not Claude, and an Anthropic model under a bland name still is.
const CLAUDE_PROVIDERS = new Set(['anthropic']);

const listOf = seats => (Array.isArray(seats) ? seats : []);

const providerOf = (model) => {
  if (model && typeof model.provider === 'string' && model.provider) return model.provider;
  const id = model && typeof model.id === 'string' ? model.id : '';
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : '';
};

/**
 * Seat a model. Returns `{ seats, error }` -- the list is returned unchanged
 * when the seating is refused, so a caller cannot half-apply one.
 */
function addSeat(seats, model) {
  const current = listOf(seats);

  if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id) {
    return { seats: current.slice(), error: 'that is not a model' };
  }

  const provider = providerOf(model);
  if (CLAUDE_PROVIDERS.has(provider.toLowerCase())) {
    return {
      seats: current.slice(),
      error: 'Claude cannot take a council seat — the layer running the council is ' +
             'already Claude, so seating it again re-correlates the ensemble and the ' +
             'diversity the council exists for disappears.',
    };
  }

  if (current.some(s => s && s.id === model.id)) {
    return { seats: current.slice(), error: `${model.id} is already seated` };
  }

  if (current.length >= MAX_SEATS) {
    // Refused rather than rotating someone out: silently dropping a seat would
    // change the council's composition without saying so.
    return {
      seats: current.slice(),
      error: `the council seats three — remove one before adding ${model.id}`,
    };
  }

  // Only what the council needs. Persisting a whole catalogue row would freeze
  // stale pricing into a file that someone later reads as current.
  return {
    seats: [...current, { id: model.id, name: model.name || model.id, provider }],
    error: null,
  };
}

function removeSeat(seats, id) {
  return listOf(seats).filter(s => !s || s.id !== id);
}

/**
 * What is true about this council that the seat list does not show. Warnings,
 * never refusals: each describes a council that works and whose answers are
 * worth less than they look.
 */
function seatWarnings(seats) {
  const current = listOf(seats).filter(s => s && s.id);
  if (current.length === 0) return [];      // nothing claimed yet

  const out = [];

  if (current.length === 1) {
    out.push('One model is a second opinion, not a council — it cannot disagree with anyone.');
  }

  const byProvider = new Map();
  for (const s of current) {
    const p = (s.provider || '').toLowerCase();
    if (!p) continue;
    byProvider.set(p, (byProvider.get(p) || 0) + 1);
  }
  for (const [provider, n] of byProvider) {
    if (n > 1) {
      out.push(`${n} seats are from the same provider (${provider}) — models from one ` +
               'vendor share failure modes, so their agreement is weaker evidence than ' +
               'it looks. This council is less diverse than its size suggests.');
    }
  }

  return out;
}

module.exports = { addSeat, removeSeat, seatWarnings, MAX_SEATS };
