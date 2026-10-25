'use strict';
/**
 * What the host does with each record the claude-custom mod posts (BACKLOG #119 A2). Each kind feeds a source that already exists and
 * only ever overrules an OLDER figure; nothing here decides anything for the session. Collaborators are injected so this is testable
 * (it was inline in host.js, reachable only by source-text assertions: PR #197 Miguel Y10).
 *
 *   usage   the quota file (read back with NO poll: a record arrives every couple of seconds) and the context circle. A record with no
 *           context figure says nothing about the circle: the mod's absence is routine (session.start before a turn), unlike the relay's,
 *           whose document means "no model". So the mod only ever SETS the circle.
 *   agents  the mood machine's `waiting` second source, with the time the mod took the snapshot.
 *   ask     the same "needs you" cue a permission Notification raises.
 *   end     the session is over: nothing is waiting any more.
 *
 * A record for another session is dropped (PR #197 Dexter 7): the port and token are inherited by every `claude` under the pty, and a
 * second one that loaded the mod would otherwise drive this session's circle. Until the host has heard its own session id (the
 * SessionStart hook) there is nothing to compare with and a record is taken.
 *
 * KNOWN RESIDUAL (PR #197 Dexter r2 N3): a dropped record is still answered 204, so the mod's roster dedupe counts it as delivered. After a
 * /clear race (the mod posts under the new session id before the host's SessionStart hook arrives) the new session's roster is not re-sent
 * until it changes. The next usage or ask record is unaffected.
 */
const { windowsFromRateLimits, contextFromUsage } = require('./mod-feed');

function createModRecordHandler({
  getSessionId, writeWindows, readQuota, lastWindowsKey, broadcastQuota, contextSource, setContext, mood, attention, log = () => {},
} = {}) {
  function usage(rec) {
    const before = lastWindowsKey();
    if (writeWindows(windowsFromRateLimits(rec.usage.rateLimits))) {
      const quota = readQuota();
      if (quota && quota.ok === true && JSON.stringify(quota.windows) !== before) broadcastQuota(quota);
    }
    const ctx = contextFromUsage(rec.usage);
    if (ctx !== null) setContext(contextSource.fromMod(ctx));
  }

  return function handle(rec) {
    try {
      const mine = getSessionId();
      if (typeof mine === 'string' && mine !== '' && rec.sessionId !== mine) return;
      if (rec.kind === 'usage') usage(rec);
      else if (rec.kind === 'agents') mood.observeAgents(rec.agents, rec.at);
      else if (rec.kind === 'ask') attention.ask(rec.ask);
      else if (rec.kind === 'end') mood.observeAgents([], rec.at);
    } catch (err) { log(`mod record: ${err && err.message}`); }
  };
}

module.exports = { createModRecordHandler };
