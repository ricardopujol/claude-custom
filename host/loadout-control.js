'use strict';
/**
 * The host's side of the tool belt's protocol (BACKLOG #17).
 *
 *   hello              carries `loadout: { agents, items }` (payload())
 *   loadout-equip      { agentType, itemId }   client -> host
 *   loadout-unequip    { agentType, itemId }   client -> host
 *   loadout            the answer, BROADCAST to every window
 *
 * The frame is `{ type:'loadout', ok, reason, agentType, itemId, agents, items }`.
 * A refusal is `ok:false` with a `reason` and carries the TRUE current `agents`,
 * so a window that asked for something impossible redraws from the truth.
 *
 * Routing lives here rather than in host.js for the same reason the bug vault's
 * does (host/bugvault.js applyVaultAction): host.js is not unit-testable, and
 * a dispatcher that is only exercised through a live pty is how a refusal got
 * broadcast as a success once already.
 *
 * NO FRAME FROM THIS MODULE IS EVER `quiet`. PR #64 N1: a `quiet` frame is the
 * convention for "refresh your picture, say nothing about the user's last
 * action" -- the renderer must not set OR clear an error line on it. The frame
 * that carries a refusal, and the success that clears it, are both real
 * answers to a real action, so neither may be quiet. (`hello` is the quiet
 * path: it carries state and nothing else.)
 *
 * THE FILE IS RE-READ ON EVERY MESSAGE, never cached. `.harness/state` is
 * install-wide and two hosts can be open at once (host/store.js says so at
 * length); a read-modify-write from a cached copy would erase the other
 * window's equip. It is still not a cross-process lock -- two clicks in the
 * same few milliseconds can lose one -- which is the documented, accepted risk
 * for regenerable convenience state (a belt is five clicks to rebuild).
 *
 * A corrupt file reads as an empty belt, exactly as the hook reads it, and the
 * next successful equip writes a clean one over it.
 */

const { validateLoadout, equip, unequip, catalogue } = require('./loadout');

const STORE_KEY = 'loadout';

function createLoadoutControl({ store } = {}) {
  if (!store) throw new Error('createLoadoutControl: store is required');

  const read = () => validateLoadout(store.read(STORE_KEY, null));

  function payload() {
    return { agents: read().agents, items: catalogue() };
  }

  function frame(fields) {
    return { type: 'loadout', reason: null, ...fields, items: catalogue() };
  }

  /** The answer to one control message. Never throws. */
  function handle(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    const isEquip = m.type === 'loadout-equip';
    const agentType = typeof m.agentType === 'string' ? m.agentType : null;
    const itemId = typeof m.itemId === 'string' ? m.itemId : null;

    let current;
    try { current = read(); } catch { current = validateLoadout(null); }
    const refusal = (reason) => frame({ ok: false, reason, agentType, itemId, agents: current.agents });

    if (!isEquip && m.type !== 'loadout-unequip') return refusal('That is not a belt action.');
    if (agentType === null || itemId === null) return refusal('An agent and an item are both required.');

    const r = (isEquip ? equip : unequip)(current, agentType, itemId);
    if (!r.ok) return refusal(r.reason);

    if (JSON.stringify(r.loadout) !== JSON.stringify(current)) {
      try {
        store.write(STORE_KEY, r.loadout);
      } catch (err) {
        return refusal(`Could not save the belt: ${err && err.message ? err.message : 'unknown error'}`);
      }
    }
    return frame({ ok: true, agentType, itemId, agents: r.loadout.agents });
  }

  return { payload, handle, read };
}

module.exports = { createLoadoutControl, STORE_KEY };
