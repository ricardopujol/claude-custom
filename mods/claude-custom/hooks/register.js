// claude-custom's feed (BACKLOG #119 A2). Runs inside the real `claude`, loaded with --plugin-dir by the harness.
//
// It does ONE thing: read the session's usage, its subagents' states and its permission asks, and post each as a
// small JSON record to the harness on 127.0.0.1. It never changes a decision (tool.check calls next(e) FIRST and
// returns exactly what came back), never rewrites a prompt, never draws. A harness that is not there, or a post that
// fails, changes nothing: every post is fire-and-forget and every hook swallows its own errors.
//
// The harness hands over where to post through the child's environment: CLAUDE_CUSTOM_MOD_PORT and
// CLAUDE_CUSTOM_MOD_TOKEN. Without both, the mod is inert (a plain `claude --plugin-dir` run by hand posts nothing).
import { MIN_USAGE_GAP_MS, agentsKey, agentsRecord, askRecord, createGate, endRecord, usageRecord } from './records.js'

const usageGate = createGate(MIN_USAGE_GAP_MS)
let lastAgents = ''

// Where to post and the token to present, or null. Strict on both parts: the port is digits and the token is hex, or nothing.
// The token goes in an Authorization header, never in the URL (a URL ends up in logs).
async function target($) {
  const port = await $.env.get('CLAUDE_CUSTOM_MOD_PORT')
  const token = await $.env.get('CLAUDE_CUSTOM_MOD_TOKEN')
  if (typeof port !== 'string' || !/^[0-9]{1,5}$/.test(port)) return null
  if (typeof token !== 'string' || !/^[0-9a-f]{16,128}$/i.test(token)) return null
  return { url: `http://127.0.0.1:${port}/mod`, token }
}

// Fire and forget: the hook never waits on the harness, and a refused connection is not an error here. `onFail` runs when the post did not
// land (refused, or not a 2xx), so a caller that remembers what it sent can forget it. Returns whether a post was attempted at all.
async function post($, record, onFail) {
  const to = await target($)
  if (to === null) return false
  const failed = () => { if (onFail) onFail() }
  $.http.fetch(to.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${to.token}` },
    body: JSON.stringify(record),
  }).then((res) => { if (!res || res.ok !== true) failed() }).catch(failed)
  return true
}

async function sessionIdOf($) {
  const id = await $.session.id()
  return typeof id === 'string' && id !== '' ? id : null
}

// `usage` is given by session.measure (its event carries the figures); every other caller lets the CLI answer.
async function sendUsage($, force, usage) {
  const at = await $.clock.now()
  if (!usageGate(at, force)) return
  const sessionId = await sessionIdOf($)
  if (sessionId === null) return
  const figures = usage === undefined ? await $.session.usage() : usage
  await post($, usageRecord({ sessionId, at, usage: figures }))
}

async function sendAgents($) {
  const sessionId = await sessionIdOf($)
  if (sessionId === null) return
  const record = agentsRecord({ sessionId, at: await $.clock.now(), list: await $.agent.list() })
  const key = agentsKey(record)
  if (key === lastAgents) return
  lastAgents = key
  // Remembered only while the post stands: a refused or unattempted one (the harness is not up yet) is sent again next time.
  const attempted = await post($, record, () => { if (lastAgents === key) lastAgents = '' })
  if (!attempted && lastAgents === key) lastAgents = ''
}

async function sendAsk($, event) {
  const sessionId = await sessionIdOf($)
  if (sessionId === null) return
  await post($, askRecord({ sessionId, at: await $.clock.now(), event }))
}

// An ask, and the roster as it stands while the prompt is open: an agent that is waiting is said now, not at the turn's end.
async function feedAsk($, event) {
  await sendAsk($, event)
  await sendAgents($)
}

async function sendEnd($, event) {
  const sessionId = await sessionIdOf($)
  if (sessionId === null) return
  await post($, endRecord({ sessionId, at: await $.clock.now(), reason: event.reason }))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    try { await sendUsage($, true); await sendAgents($) } catch { /* a feed that fails is silent */ }
    return out
  })

  // After each turn, and when a plan limit's percent changes: the event carries the figures.
  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    try { await sendUsage($, false, { context: e.context, rateLimits: e.rateLimits, cost: e.cost }) } catch { /* silent */ }
    return out
  })

  on('turn.start', async ($, e, next) => {
    const out = await next(e)
    try { await sendAgents($) } catch { /* silent */ }
    return out
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    try { await sendUsage($, true); await sendAgents($) } catch { /* silent */ }
    return out
  })

  // OBSERVE ONLY: the decision is whatever next(e) resolved to, handed back untouched, whatever happens in between.
  // The decision goes back FIRST: the feed is detached and never awaited here, so a slow `$.agent.list()` cannot hold the permission dialog.
  on('tool.check', async ($, e, next) => {
    const decision = await next(e)
    if (decision !== null && typeof decision === 'object' && decision.decision === 'ask') feedAsk($, e).catch(() => {})
    return decision
  })

  on('session.end', async ($, e, next) => {
    const out = await next(e)
    try { await sendEnd($, e) } catch { /* silent */ }
    return out
  })
}
