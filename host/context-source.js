'use strict';
/**
 * The context circle's figure has two sources (BACKLOG #119 A2): the statusLine relay's document (host/status-relay.js, a redraw
 * of the CLI's own status row) and the claude-custom mod's usage record (`$.session.usage()`, host/mod-feed.js). Both say
 * `{ used, size }` or null ("can't say"). The FRESHER one wins, by the time the host received it; at the same instant the mod wins,
 * being the CLI's own answer. A fresher "can't say" clears the older figure: unknown is not the last good value left standing
 * (host/hook-session.js readContext, host/host.js setContext).
 */
function createContextSource({ now = Date.now } = {}) {
  let relay = { at: -Infinity, ctx: null };
  let mod = { at: -Infinity, ctx: null };

  const copy = (c) => (c ? { used: c.used, size: c.size } : null);
  const current = () => copy(mod.at >= relay.at ? mod.ctx : relay.ctx);

  return {
    fromRelay(ctx) { relay = { at: now(), ctx: copy(ctx) }; return current(); },
    fromMod(ctx) { mod = { at: now(), ctx: copy(ctx) }; return current(); },
    // A /clear or a compaction: neither source's figure is true any more (host.js SessionStart).
    reset() { relay = { at: -Infinity, ctx: null }; mod = { at: -Infinity, ctx: null }; return null; },
    current,
  };
}

module.exports = { createContextSource };
