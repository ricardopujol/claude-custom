// The records the mod posts to the harness (host/mod-feed.js validates them again, strictly: this side only
// shapes what it read, so a stray field or a wrong type never leaves the CLI). Pure functions, no `$`, so the
// host's own tests can import this file too.
//
// A figure the CLI does not have is LEFT OUT, never zeroed (the same rule as host/hook-session.js): `Number(null)`
// is 0, and an absent percent must not read as "you have used nothing".

export const RECORD_VERSION = 1
export const MIN_USAGE_GAP_MS = 2000
const MAX_AGENTS = 64
const MAX_TEXT = 200

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isText = (v) => typeof v === 'string' && v !== ''
const clip = (v) => (v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v)

function contextOf(c) {
  if (c === null || typeof c !== 'object') return undefined
  const out = {}
  if (isNum(c.tokens)) out.tokens = c.tokens
  if (isNum(c.window)) out.window = c.window
  if (isNum(c.percent)) out.percent = c.percent
  return Object.keys(out).length ? out : undefined
}

function rateLimitsOf(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const r of list) {
    if (r === null || typeof r !== 'object' || !isText(r.kind) || !isNum(r.percentUsed)) continue
    const row = { kind: clip(r.kind), percentUsed: r.percentUsed }
    if (isText(r.resetsAt)) row.resetsAt = clip(r.resetsAt)
    out.push(row)
  }
  return out
}

/** `usage` is what `$.session.usage()` answers, or the fields of a `session.measure` event. */
export function usageRecord({ sessionId, at, usage }) {
  const u = usage !== null && typeof usage === 'object' ? usage : {}
  const body = { rateLimits: rateLimitsOf(u.rateLimits) }
  const context = contextOf(u.context)
  if (context) body.context = context
  if (u.cost !== null && typeof u.cost === 'object' && isNum(u.cost.usd)) body.cost = { usd: u.cost.usd }
  if (isNum(u.startedAt)) body.startedAt = u.startedAt
  return { v: RECORD_VERSION, kind: 'usage', sessionId, at, usage: body }
}

/** `list` is what `$.agent.list()` answers. Identity fields only: no prompts, no tool input. */
export function agentsRecord({ sessionId, at, list }) {
  const agents = []
  for (const a of Array.isArray(list) ? list : []) {
    if (a === null || typeof a !== 'object' || !isText(a.id) || !isText(a.status)) continue
    const row = { id: clip(a.id), status: clip(a.status) }
    if (isText(a.type)) row.type = clip(a.type)
    if (isText(a.name)) row.name = clip(a.name)
    if (isText(a.parentId)) row.parentId = clip(a.parentId)
    agents.push(row)
    if (agents.length >= MAX_AGENTS) break
  }
  return { v: RECORD_VERSION, kind: 'agents', sessionId, at, agents }
}

/** A permission ask, by tool NAME only: the tool's input can hold a secret and the harness does not need it. */
export function askRecord({ sessionId, at, event }) {
  const e = event !== null && typeof event === 'object' ? event : {}
  const ask = { tool: isText(e.tool) ? clip(e.tool) : 'unknown' }
  if (isText(e.agentId)) ask.agentId = clip(e.agentId)
  return { v: RECORD_VERSION, kind: 'ask', sessionId, at, ask }
}

export function endRecord({ sessionId, at, reason }) {
  const rec = { v: RECORD_VERSION, kind: 'end', sessionId, at }
  if (isText(reason)) rec.reason = clip(reason)
  return rec
}

/** The same agent roster twice is not news. */
export function agentsKey(record) {
  return JSON.stringify(record.agents)
}

/** At most one pass per `gapMs`; `force` always passes (and restarts the gap). `now` is a number, in ms. */
export function createGate(gapMs) {
  let last = null
  return (now, force) => {
    if (!isNum(now)) return false
    if (force !== true && last !== null && now - last >= 0 && now - last < gapMs) return false
    last = now
    return true
  }
}
