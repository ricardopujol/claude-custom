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
 * NO ANSWER FRAME (handle()) IS EVER `quiet`; the one frame that IS, changed()'s
 * watcher echo, is quiet on purpose. PR #64 N1: a `quiet` frame is the
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

const { validateLoadout, emptyLoadout, equip, unequip, catalogue } = require('./loadout');

const STORE_KEY = 'loadout';

function createLoadoutControl({ store } = {}) {
  if (!store) throw new Error('createLoadoutControl: store is required');

  /**
   * The loadout on disk and whether it could be READ. `store.read` folds
   * missing, corrupt and unreadable into one fallback; only `missing` (and a
   * corrupt file the hook already ignores) may be written over. An unreadable
   * file (EPERM, a handle held mid-rename by the other host) is not "empty":
   * writing over it would wipe every agent's belt (PR #68, Dexter F5).
   */
  function snapshot() {
    if (typeof store.readState === 'function') {
      const st = store.readState(STORE_KEY);
      if (st.status === 'unreadable') return { unreadable: true, loadout: emptyLoadout() };
      return { unreadable: false, loadout: validateLoadout(st.status === 'ok' ? st.value : null) };
    }
    return { unreadable: false, loadout: validateLoadout(store.read(STORE_KEY, null)) };
  }
  const read = () => snapshot().loadout;

  // The belts the windows of THIS host were last told about (by hello, an
  // answer, or a watcher frame). What lets changed() tell "another host wrote"
  // from "nothing happened" and from "I wrote it myself" (PR #68, Dexter F1).
  let told = '';
  try { told = JSON.stringify(read().agents); } catch { told = JSON.stringify({}); }

  // Deliberately does NOT update `told`: a fresh window attaching learns the
  // belt, but the windows already open have not, and changed() must still
  // announce it to them.
  function payload() {
    return { agents: read().agents, items: catalogue() };
  }

  function frame(fields) {
    return { type: 'loadout', reason: null, ...fields, items: catalogue() };
  }

  /**
   * Another host (or a hand edit) changed loadout.json: the QUIET frame that
   * brings this host's windows up to date, or null when nothing they show is
   * wrong. Quiet, always -- it says nothing about the user's last action, so it
   * must neither set nor clear a refusal on screen (PR #64 N1). An unreadable
   * file gives no frame: that is not "everybody unequipped".
   */
  function changed() {
    let snap;
    try { snap = snapshot(); } catch { return null; }
    if (snap.unreadable) return null;
    const json = JSON.stringify(snap.loadout.agents);
    if (json === told) return null;
    told = json;
    return frame({ quiet: true, ok: true, agents: snap.loadout.agents });
  }

  /** The answer to one control message. Never throws. */
  function handle(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    const isEquip = m.type === 'loadout-equip';
    const agentType = typeof m.agentType === 'string' ? m.agentType : null;
    const itemId = typeof m.itemId === 'string' ? m.itemId : null;

    let snap;
    try { snap = snapshot(); } catch { snap = { unreadable: false, loadout: validateLoadout(null) }; }
    const current = snap.loadout;
    const refusal = (reason) => {
      told = JSON.stringify(current.agents);          // the answer below carries this
      return frame({ ok: false, reason, agentType, itemId, agents: current.agents });
    };

    if (snap.unreadable) {
      // No `agents`: an empty map here would blank every window's belts, and we
      // do not know what is on disk.
      return frame({ ok: false, agentType, itemId,
        reason: 'Could not read the belt file (locked or unreadable), so nothing was changed. Try again.' });
    }
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
    told = JSON.stringify(r.loadout.agents);
    return frame({ ok: true, agentType, itemId, agents: r.loadout.agents });
  }

  return { payload, handle, read, changed };
}

module.exports = { createLoadoutControl, STORE_KEY };
