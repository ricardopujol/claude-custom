'use strict';
/**
 * The tool belt's pure core (BACKLOG #17): items an agent carries that change
 * how its NEXT run is spawned.
 *
 * THE MECHANISM, and why it is the only one. A `PreToolUse` hook on the Agent
 * tool may return `hookSpecificOutput.updatedInput`, and the CLI launches the
 * subagent with THAT input. Measured, zero spend, on claude-cli 2.1.284
 * (verify/probe-loadout-hook.js): the subagent's request went out with the
 * rewritten `model`, and its first user message began with the rewritten
 * prompt. The rewrite happens at spawn; nothing is patched afterwards. That is
 * the founding bet in miniature -- drive the CLI's own mechanism.
 *
 * SCOPE DECISIONS (Ricardo's; recorded here so nobody reopens them by accident):
 *
 *  - INSTALL-WIDE, keyed by agent type (`subagent_type`). Not per project.
 *    host/store.js says it plainly: nothing in the store is project-scoped, and
 *    this inherits that. Project scoping is DEFERRED -- it is a design decision
 *    about what a belt MEANS across projects, not a detail of this change.
 *  - v1 item kinds: PACE writes `model` (the CLI aliases haiku / sonnet / opus,
 *    never a full model id, which would rot the day a model is retired) and
 *    METHOD writes `prompt` by PREPENDING one fixed instruction to the prompt the
 *    caller wrote. The original prompt is never edited, only preceded.
 *  - CONFLICTS ARE DERIVED from the fields an item writes, never from a
 *    hand-kept matrix: two items that both write `model` conflict automatically,
 *    so a new item cannot drift out of sync with a table. Consequence worth
 *    knowing: at most ONE Pace item and ONE Method item per agent.
 *  - HONESTY RULE: an item may only claim an effect the harness enforces. Every
 *    description below states exactly what is rewritten and nothing more.
 *  - THE ONE HONEST LIMIT: equipping an agent that is already running does not
 *    affect that run; its input was sent when it started. It applies to the
 *    next spawn, and the UI says so.
 *
 * Everything here is pure: no fs, no clock, no globals. host/loadout-hook.js is
 * the only place that touches the disk.
 */

const METHOD_SEPARATOR = '\n\n';

const freeze = (item) => Object.freeze({ ...item, writes: Object.freeze([...item.writes]) });

const ITEMS = Object.freeze([
  freeze({
    id: 'pace-haiku', kind: 'pace', name: 'Pace: haiku', glyph: '»', writes: ['model'], model: 'haiku',
    description: 'Runs this agent on the haiku model: fastest and cheapest.',
  }),
  freeze({
    id: 'pace-sonnet', kind: 'pace', name: 'Pace: sonnet', glyph: '»»', writes: ['model'], model: 'sonnet',
    description: 'Runs this agent on the sonnet model: the balanced middle.',
  }),
  freeze({
    id: 'pace-opus', kind: 'pace', name: 'Pace: opus', glyph: '»»»', writes: ['model'], model: 'opus',
    description: 'Runs this agent on the opus model: slowest, most capable.',
  }),
  freeze({
    id: 'verify-with-test', kind: 'method', name: 'Method: verify with a test', glyph: '✓', writes: ['prompt'],
    instruction: 'Before you finish, add or run the test that fails without your change.',
    description: 'Puts one instruction in front of the prompt: add or run the test that fails without the change.',
  }),
  freeze({
    id: 'review-twice', kind: 'method', name: 'Method: review twice', glyph: '↻', writes: ['prompt'],
    instruction: 'Before you report, re-read your own diff once more as a reviewer and fix what you find.',
    description: 'Puts one instruction in front of the prompt: re-read your own diff as a reviewer before reporting.',
  }),
  freeze({
    id: 'state-assumptions', kind: 'method', name: 'Method: state assumptions', glyph: '?', writes: ['prompt'],
    instruction: 'State every assumption you made, at the end of your report.',
    description: 'Puts one instruction in front of the prompt: list every assumption at the end of the report.',
  }),
]);

const BY_ID = new Map(ITEMS.map(i => [i.id, i]));

/** The catalogue entry for an id, or null. A Map, so 'constructor' is not an item. */
function itemById(id) {
  return typeof id === 'string' && BY_ID.has(id) ? BY_ID.get(id) : null;
}

/** The JSON-safe subset of the catalogue the renderer draws from. */
function catalogue() {
  return ITEMS.map(({ id, kind, name, glyph, description, writes }) => ({ id, kind, name, glyph, description, writes: [...writes] }));
}

/**
 * Agent types come from the hook payload and from the wire, and become keys of
 * a plain object. A key that exists on Object.prototype ('__proto__',
 * 'constructor', 'toString') would corrupt or shadow it, so it is not a valid
 * agent type here whatever it looks like. Plugin agents are `plugin:name`.
 */
const AGENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
function isAgentType(x) {
  return typeof x === 'string' && AGENT_TYPE_RE.test(x) && !(x in Object.prototype);
}

/** Do two items (objects with `writes`) write any field in common? */
function writesOverlap(a, b) {
  return a.writes.some(w => b.writes.includes(w));
}

/** Do two catalogue ids conflict? Derived from `writes`; an unknown id conflicts with nothing. */
function conflicts(idA, idB) {
  const a = itemById(idA);
  const b = itemById(idB);
  return !!(a && b && writesOverlap(a, b));
}

function emptyLoadout() {
  return { agents: {} };
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The equipped ids for one agent type, from any input at all. */
function idsOf(loadout, agentType) {
  if (!loadout || typeof loadout !== 'object' || !isAgentType(agentType)) return [];
  const agents = loadout.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents) || !hasOwn(agents, agentType)) return [];
  const ids = agents[agentType];
  return Array.isArray(ids) ? ids.filter(id => itemById(id)) : [];
}

function itemsFor(loadout, agentType) {
  return idsOf(loadout, agentType).map(itemById);
}

/** A structural copy of a loadout, tolerant of junk. Only ever used on input we then re-validate. */
function cloneAgents(loadout) {
  const out = {};
  const agents = loadout && typeof loadout === 'object' && loadout.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return out;
  for (const k of Object.keys(agents)) {
    if (isAgentType(k) && Array.isArray(agents[k])) out[k] = agents[k].filter(id => itemById(id));
  }
  return out;
}

function refuse(loadout, reason) {
  return { loadout: { agents: cloneAgents(loadout) }, ok: false, reason };
}

/**
 * Put `itemId` on `agentType`'s belt. Pure: returns a new loadout. A refusal
 * carries the reason the UI shows, and leaves the loadout as it was.
 */
function equip(loadout, agentType, itemId) {
  if (!isAgentType(agentType)) return refuse(loadout, 'That is not a valid agent name.');
  const item = itemById(itemId);
  if (!item) return refuse(loadout, 'That item does not exist.');

  const agents = cloneAgents(loadout);
  const belt = hasOwn(agents, agentType) ? agents[agentType] : [];
  if (belt.includes(item.id)) return { loadout: { agents }, ok: true, reason: null };   // already on: nothing to do

  for (const otherId of belt) {
    if (conflicts(item.id, otherId)) {
      const other = itemById(otherId);
      const field = item.writes.find(w => other.writes.includes(w));
      return refuse(loadout, `"${item.name}" and "${other.name}" both set the agent's ${field}. Unequip one first.`);
    }
  }
  agents[agentType] = [...belt, item.id];
  return { loadout: { agents }, ok: true, reason: null };
}

function unequip(loadout, agentType, itemId) {
  if (!isAgentType(agentType)) return refuse(loadout, 'That is not a valid agent name.');
  const agents = cloneAgents(loadout);
  const belt = hasOwn(agents, agentType) ? agents[agentType] : [];
  if (!belt.includes(itemId)) return refuse(loadout, 'That item is not equipped.');
  const rest = belt.filter(id => id !== itemId);
  if (rest.length) agents[agentType] = rest; else delete agents[agentType];
  return { loadout: { agents }, ok: true, reason: null };
}

/**
 * Whatever came off the disk -> a loadout that is safe to use. TOTAL: junk of
 * any shape yields an empty loadout, never a throw (a corrupt file is `{}`).
 * Conflicts are RE-DERIVED by replaying the belt through equip(), so a
 * hand-edited file cannot carry two Pace items past the rule.
 */
function validateLoadout(raw) {
  let out = emptyLoadout();
  const agents = raw && typeof raw === 'object' && raw.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return out;
  for (const agentType of Object.keys(agents)) {
    if (!isAgentType(agentType) || !Array.isArray(agents[agentType])) continue;
    for (const id of agents[agentType]) {
      const r = equip(out, agentType, id);
      if (r.ok) out = r.loadout;
    }
  }
  return out;
}

/**
 * The Agent tool's input, rewritten for this agent's belt -- or null when
 * there is nothing to change (nothing equipped, or the input already says it).
 * Null is what lets the hook print NOTHING for an unequipped spawn.
 *
 * Never mutates its input, never drops a field it did not write, and is
 * idempotent on its own output: a Method prefix already at the front of the
 * prompt is not added again.
 */
function applyLoadout(toolInput, loadout) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const items = itemsFor(loadout, toolInput.subagent_type);
  if (!items.length) return null;

  const out = { ...toolInput };
  let changed = false;
  for (const item of items) {
    if (item.kind === 'pace') {
      if (out.model !== item.model) { out.model = item.model; changed = true; }
    } else if (item.kind === 'method') {
      // No prompt to prepend to -> nothing to do. Inventing a prompt would
      // turn a bare spawn into one that says only the instruction.
      if (typeof out.prompt !== 'string') continue;
      if (out.prompt.startsWith(item.instruction)) continue;
      out.prompt = item.instruction + METHOD_SEPARATOR + out.prompt;
      changed = true;
    }
  }
  return changed ? out : null;
}

module.exports = {
  ITEMS, itemById, catalogue, isAgentType, writesOverlap, conflicts,
  emptyLoadout, equip, unequip, itemsFor, validateLoadout, applyLoadout,
};
