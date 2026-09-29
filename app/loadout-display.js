'use strict';
/**
 * The tool belt on a roster card (BACKLOG #17): the strip of equipped items,
 * the button that opens the inline picker, and the honest copy about WHEN an
 * equip takes effect. Pure decisions and HTML strings only; renderer.js wires
 * the clicks and the websocket, the same split as app/agent-card-display.js.
 *
 * THE ONE HONEST LIMIT, and the UI must SAY it (Ricardo's decision,
 * documentation/GAMIFICATION_DESIGN.md): an equip changes the Agent tool's
 * input at SPAWN. An agent that is already running was spawned with the old
 * input, so it is not affected; the change applies to its next run. The picker
 * always says "applies to the next run", and for an agent running right now it
 * says the current run isn't affected -- rather than appear to have done
 * something it cannot do.
 *
 * REFUSALS STAY VISIBLE. The host answers an impossible equip (two items that
 * both write `model`) with a `loadout` frame `{ok:false, reason}`, and that
 * reason is drawn under the picker of the agent it was for. A frame carrying
 * `quiet:true` is a state refresh that says nothing about the user's last
 * action, so it neither sets NOR clears the error -- the PR #64 N1 trap, where
 * a host echo wiped a refusal 150 ms after it appeared. `hello` is quiet.
 *
 * WHY THE CONFLICT HINT IS DRAWN BUT THE ROW IS NOT DISABLED: the hint is
 * derived from the same `writes` fields the host derives conflicts from, so it
 * cannot drift from a hand-kept table. The row stays clickable because the host
 * is the authority: a refusal it sends back is the truth, and a UI that
 * pre-empted it would be one more place a rule could disagree with the host.
 *
 * Every control is a <button> (a control inside a card must never open the
 * card -- PR #63/#66), and the belts are held in a Map so an agent named
 * `__proto__` from the wire is a key, not a prototype write.
 *
 * WRAPPED IN AN IIFE, and that is not style -- see app/career-display.js. The
 * renderer loads every script as a plain <script> tag sharing ONE global scope;
 * a top-level name declared twice silently kills the second file, and no unit
 * test can see it. Rendered proof: verify/probe-loadout.js.
 */

(function (root) {

const isStr = (x) => typeof x === 'string';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const NEXT_RUN = 'Applies to the next run.';
const RUNNING_NOTE = "This agent is running now, so the current run isn't affected. " + NEXT_RUN;
const UNKNOWN_REFUSAL = 'the belt was not changed';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function emptyState() {
  return { agents: new Map(), items: [], open: null, error: null, asked: null };
}

/** Wire `agents` -> Map<string, string[]>, or null when it is not an object. */
function readAgents(raw) {
  if (!isObj(raw)) return null;
  const out = new Map();
  for (const k of Object.keys(raw)) {
    if (!Array.isArray(raw[k])) continue;
    const ids = raw[k].filter(isStr);
    if (ids.length) out.set(k, ids);
  }
  return out;
}

function readItems(raw) {
  if (!Array.isArray(raw)) return null;
  const items = raw.filter(i => isObj(i) && isStr(i.id) && isStr(i.name) && isStr(i.glyph));
  return items.length ? items.map(i => ({
    id: i.id, kind: isStr(i.kind) ? i.kind : '', name: i.name, glyph: i.glyph,
    description: isStr(i.description) ? i.description : '',
    writes: Array.isArray(i.writes) ? i.writes.filter(isStr) : [],
  })) : null;
}

function withBelts(state, raw) {
  const agents = readAgents(raw && raw.agents);
  const items = readItems(raw && raw.items);
  return { ...state, agents: agents || state.agents, items: items || state.items };
}

/**
 * Fold one host message into the belt state. `hello` carries `loadout`; a
 * `loadout` frame is the answer to an equip/unequip (or a state refresh when
 * `quiet`). Anything else returns the state untouched.
 */
function reduce(state, msg) {
  const cur = state || emptyState();
  if (!isObj(msg)) return cur;
  if (msg.type === 'hello') {
    return isObj(msg.loadout) ? withBelts(cur, msg.loadout) : cur;
  }
  if (msg.type !== 'loadout') return cur;

  const next = withBelts(cur, msg);
  if (msg.quiet === true) return next;
  // The frame is BROADCAST to every window, but a refusal answers ONE click.
  // Only a window that asked for exactly this (agent, item) shows it; another
  // window's refusal neither replaces the alert on screen nor appears as an
  // error in a window whose user never clicked (Dexter F6). The belts it
  // carries are applied either way.
  const answers = !!(cur.asked && cur.asked.agentType === msg.agentType && cur.asked.itemId === msg.itemId);
  if (msg.ok === false) {
    if (!answers) return next;
    return { ...next, asked: null, error: {
      agentType: isStr(msg.agentType) ? msg.agentType : '',
      itemId: isStr(msg.itemId) ? msg.itemId : '',
      reason: isStr(msg.reason) && msg.reason ? msg.reason : UNKNOWN_REFUSAL,
    } };
  }
  if (msg.ok === true) {
    const cleared = next.error && next.error.agentType === msg.agentType ? { error: null } : {};
    return { ...next, ...cleared, ...(answers ? { asked: null } : {}) };
  }
  return next;
}

/** Note that THIS window just asked for an equip/unequip, so its answer is shown. */
function ask(state, action) {
  const cur = state || emptyState();
  if (!action || (action.kind !== 'equip' && action.kind !== 'unequip')
      || !isStr(action.agent) || !action.agent || !isStr(action.itemId) || !action.itemId) return cur;
  return { ...cur, asked: { agentType: action.agent, itemId: action.itemId } };
}

/**
 * Why a card cannot take a belt at all, or null. `resolved:false` is a roster
 * row known only by its hook LABEL: the hook keys on subagent_type, so an item
 * equipped on a label can never apply (Dexter F2). `hooks:false` means the
 * native helper is missing, so the settings file that registers the belt's hook
 * is never passed to the CLI (Dexter F3). Only an explicit false counts.
 */
function unavailableReason(facts) {
  if (!facts || typeof facts !== 'object') return null;
  if (facts.resolved === false) {
    return "This is a label, not an agent type: a spawn's subagent_type can never match it, so an item here would never apply.";
  }
  if (facts.hooks === false) {
    return 'Hooks are off (the hook helper is missing), so items cannot apply to any spawn.';
  }
  return null;
}

/** Open (or close) one agent's picker. One at a time; a new picker starts with no stale refusal. */
function toggle(state, agent) {
  const cur = state || emptyState();
  if (!isStr(agent) || !agent) return cur;
  return { ...cur, open: cur.open === agent ? null : agent, error: null };
}

/** Everything one card needs to draw its belt. Total over any input. */
function view(state, agent, opts) {
  const cur = state || emptyState();
  const name = isStr(agent) ? agent : '';
  const running = !!(opts && opts.running);
  const byId = new Map(cur.items.map(i => [i.id, i]));
  const ids = cur.agents.get(name) || [];
  const equipped = ids.map(id => byId.get(id)).filter(Boolean);
  const unavailable = opts && isStr(opts.unavailable) && opts.unavailable ? opts.unavailable : null;
  const open = !!name && !unavailable && cur.open === name;

  const rows = open ? cur.items.map((item) => {
    const on = equipped.some(e => e.id === item.id);
    const clash = on ? null : equipped.find(e => e.writes.some(w => item.writes.includes(w)));
    return {
      id: item.id, name: item.name, glyph: item.glyph, kind: item.kind, description: item.description,
      equipped: on, action: on ? 'unequip' : 'equip',
      hint: clash ? `conflicts with ${clash.name}` : null,
    };
  }) : [];

  return {
    agent: name,
    equipped,
    open,
    unavailable,
    rows,
    note: open ? (running ? RUNNING_NOTE : NEXT_RUN) : null,
    error: cur.error && cur.error.agentType === name ? cur.error.reason : null,
  };
}

function html(v) {
  const a = esc(v.agent);
  const strip = v.equipped.length
    ? `<div class="belt-strip">${v.equipped.map(e =>
      `<span class="belt-item" data-kind="${esc(e.kind)}" title="${esc(e.description)}">` +
      `<span class="belt-glyph" aria-hidden="true">${esc(e.glyph)}</span>${esc(e.name)}</span>`).join('')}</div>`
    : '';
  if (v.unavailable) {
    return `<div class="belt" data-belt="${a}">${strip}` +
      `<span class="belt-off" title="${esc(v.unavailable)}">belt unavailable</span></div>`;
  }
  const button = `<button type="button" class="belt-btn${v.open ? ' on' : ''}" data-loadout-toggle="${a}" ` +
    `aria-label="Tool belt for ${a}" aria-expanded="${v.open ? 'true' : 'false'}" ` +
    `title="Equip items that change how this agent is spawned">belt</button>`;
  let picker = '';
  if (v.open) {
    picker = `<div class="belt-picker"><div class="belt-note">${esc(v.note)}</div>` +
      v.rows.map(r =>
        `<button type="button" class="belt-row${r.equipped ? ' on' : ''}" data-loadout-act="${r.action}" ` +
        `data-loadout-agent="${a}" data-loadout-item="${esc(r.id)}" aria-pressed="${r.equipped ? 'true' : 'false'}" ` +
        `title="${esc(r.description)}">` +
        `<span class="belt-glyph" aria-hidden="true">${esc(r.glyph)}</span>` +
        `<span class="belt-name">${esc(r.name)}${r.hint ? `<span class="belt-hint">${esc(r.hint)}</span>` : ''}</span>` +
        `<span class="belt-do">${r.equipped ? 'remove' : 'equip'}</span>` +
        `</button>`).join('') +
      (v.error ? `<div class="belt-error" role="alert">${esc(v.error)}</div>` : '') +
      `</div>`;
  }
  return `<div class="belt" data-belt="${a}">${strip}${button}${picker}</div>`;
}

/** A click's dataset -> what it means, or null. */
function clickAction(ds) {
  if (!ds || typeof ds !== 'object') return null;
  if (isStr(ds.loadoutToggle) && ds.loadoutToggle) return { kind: 'toggle', agent: ds.loadoutToggle };
  if ((ds.loadoutAct === 'equip' || ds.loadoutAct === 'unequip')
      && isStr(ds.loadoutAgent) && ds.loadoutAgent && isStr(ds.loadoutItem) && ds.loadoutItem) {
    return { kind: ds.loadoutAct, agent: ds.loadoutAgent, itemId: ds.loadoutItem };
  }
  return null;
}

/** The control message for an equip/unequip action (null for a toggle, which is UI-only). */
function controlMessage(action) {
  if (!action || (action.kind !== 'equip' && action.kind !== 'unequip')) return null;
  return { type: `loadout-${action.kind}`, agentType: action.agent, itemId: action.itemId };
}

const api = { emptyState, reduce, ask, toggle, view, html, unavailableReason, clickAction, controlMessage,
  NEXT_RUN, RUNNING_NOTE };

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system. Only ONE name leaves the IIFE.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.loadoutDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
