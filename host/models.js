'use strict';
/**
 * The OpenRouter model catalogue, normalised into rows a picker can draw.
 *
 * Pure: no network, no disk. `host/openrouter.js` fetches, this decides what a
 * row MEANS -- which is where every silent wrongness in a picker lives.
 *
 * THREE THINGS THIS EXISTS TO GET RIGHT.
 *
 * 1. PRICE. OpenRouter quotes dollars PER TOKEN, as strings: "0.00000125".
 *    Rendered as-is by any ordinary formatter that means $0.00, so every model
 *    on the sheet reads as free and the picker becomes price-blind. Converted
 *    to per-million once, here, so no caller can forget.
 *
 * 2. UNPRICED IS NOT FREE. A row with no pricing block shown as $0.00 invites
 *    picking it, and the bill arrives later. `priced` and `free` are separate
 *    fields for that reason, and an unpriced model sorts LAST in a cheapest-
 *    first list rather than first.
 *
 * 3. TOOL SUPPORT DECIDES WHAT A MODEL CAN BE USED FOR. The main session needs
 *    it -- Agent, the hooks and structured output all depend on tool calls --
 *    and a model without it does not degrade, it breaks the harness in a way
 *    that looks like the harness being broken. So it FAILS CLOSED: a row that
 *    does not declare `tools` is treated as unable to, never as unknown-so-
 *    probably-fine.
 *
 * The council has the opposite requirement and that is the whole point: a
 * model that cannot call a tool can still hold an opinion, and excluding it
 * would shrink the diversity the council exists for.
 */

const TARGETS = Object.freeze({
  SESSION: 'session',   // must be able to call tools
  COUNCIL: 'council',   // chat is enough
});

/** Dollars per million tokens, or null when the figure is not a usable number. */
function perMillion(price) {
  if (price === null || price === undefined || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  // Multiply rather than format: rounding belongs to the view, and a rounded
  // value here would make $0.60/M and $0.00025/M both read as $0.00.
  return n * 1e6;
}

function normalizeModel(row) {
  if (!row || typeof row !== 'object' || !row.id || typeof row.id !== 'string') return null;

  const pricing = row.pricing && typeof row.pricing === 'object' ? row.pricing : {};
  const promptPerM = perMillion(pricing.prompt);
  const completionPerM = perMillion(pricing.completion);
  const priced = promptPerM !== null && completionPerM !== null;

  const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];

  const slash = row.id.indexOf('/');
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name ? row.name : row.id,
    // The provider lives in the id (`google/gemini-2.5-pro`), not in a field.
    provider: slash > 0 ? row.id.slice(0, slash) : '',
    context: Number.isFinite(Number(row.context_length)) ? Number(row.context_length) : 0,
    promptPerM,
    completionPerM,
    priced,
    // Known to cost nothing, which is a different claim from "no price given".
    free: priced && promptPerM === 0 && completionPerM === 0,
    // Fails closed: absent means cannot, never means unknown.
    tools: params.includes('tools'),
  };
}

function normalizeCatalogue(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const m = normalizeModel(row);
    if (m) out.push(m);
  }
  return out;
}

function filterModels(models, { target, search, minContext, freeOnly } = {}) {
  let out = Array.isArray(models) ? models.slice() : [];

  // Only the SESSION target restricts by tools. An unknown target restricts
  // nothing, so a typo shows too much rather than too little -- visible, not
  // silent.
  if (target === TARGETS.SESSION) out = out.filter(m => m.tools);

  if (search) {
    const q = String(search).toLowerCase();
    out = out.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }

  if (Number.isFinite(Number(minContext)) && Number(minContext) > 0) {
    out = out.filter(m => m.context >= Number(minContext));
  }

  // `free`, not "price is zero or missing": an unpriced model is not free.
  if (freeOnly) out = out.filter(m => m.free);

  return out;
}

function sortModels(models, by) {
  const out = Array.isArray(models) ? models.slice() : [];
  // Tie-broken on id so the order is TOTAL -- otherwise two equally priced
  // models can swap places between redraws and the list appears to shuffle
  // while nothing changed.
  const byId = (a, b) => a.id.localeCompare(b.id);

  if (by === 'context') {
    return out.sort((a, b) => b.context - a.context || byId(a, b));
  }
  if (by === 'price') {
    return out.sort((a, b) => {
      // Unpriced sorts LAST in a cheapest-first list. Treating it as 0 would put
      // the models whose cost is unknown at the top of the cheap list, which is
      // the one place they must not be.
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      if (!a.priced) return byId(a, b);
      return (a.promptPerM - b.promptPerM) || (a.completionPerM - b.completionPerM) || byId(a, b);
    });
  }
  return out.sort(byId);
}

module.exports = {
  normalizeModel, normalizeCatalogue, filterModels, sortModels, perMillion, TARGETS,
};
