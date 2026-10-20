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

// The URL to post to, or null. Strict on both parts: the token goes into a URL, so it is hex or nothing.
async function target($) {
  const port = await $.env.get('CLAUDE_CUSTOM_MOD_PORT')
  const token = await $.env.get('CLAUDE_CUSTOM_MOD_TOKEN')
  if (typeof port !== 'string' || !/^[0-9]{1,5}$/.test(port)) return null
  if (typeof token !== 'string' || !/^[0-9a-f]{16,128}$/i.test(token)) return null
  return `http://127.0.0.1:${port}/mod?token=${token}`
}

// Fire and forget: the hook never waits on the harness, and a refused connection is not an error here.
async function post($, record) {
  const url = await target($)
  if (url === null) return
  $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) }).catch(() => {})
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
  await post($, record)
}

async function sendAsk($, event) {
  const sessionId = await sessionIdOf($)
  if (sessionId === null) return
  await post($, askRecord({ sessionId, at: await $.clock.now(), event }))
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
  on('tool.check', async ($, e, next) => {
    const decision = await next(e)
    try {
      if (decision !== null && typeof decision === 'object' && decision.decision === 'ask') {
        await sendAsk($, e)
        // The roster as it stands while the prompt is open: an agent that is waiting is said now, not at the turn's end.
        await sendAgents($)
      }
    } catch { /* silent */ }
    return decision
  })

  on('session.end', async ($, e, next) => {
    const out = await next(e)
    try { await sendEnd($, e) } catch { /* silent */ }
    return out
  })
}
