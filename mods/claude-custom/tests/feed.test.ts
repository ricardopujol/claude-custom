import { expect, mock, test } from 'claude-code/testing'

const URL_RE = /^http:\/\/127\.0\.0\.1:4711\/mod\?token=abcdef0123456789abcdef$/

const USAGE = {
  context: { tokens: 51000, window: 200000, percent: 26 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-10-19T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-10-24T09:00:00Z' },
  ],
  cost: { usd: 0.42 },
}

// Every stub a hook of this mod can reach, and a list the test reads the posts from.
function rig($: any, on: any, env: Record<string, string> = { CLAUDE_CUSTOM_MOD_PORT: '4711', CLAUDE_CUSTOM_MOD_TOKEN: 'abcdef0123456789abcdef' }, refuse = false) {
  const posts: { url: string; body: any; method: string }[] = []
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, env)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'secret task text', type: 'Explore', status: 'waiting' }] }))
  on('http.fetch', ($: any, e: any) => {
    if (refuse) return { deny: 'connection refused' }
    posts.push({ url: e.url, body: JSON.parse(e.init.body), method: e.init.method })
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  return { posts, clock }
}

test('a turn completing posts the usage and the agents, to the harness on loopback', async ($, on) => {
  const { posts } = rig($, on)
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 5, isAborted: false, usage: null })
  const kinds = posts.map((p) => p.body.kind)
  expect(kinds).toEqual(['usage', 'agents'])
  expect(posts[0].url).toMatch(URL_RE)
  expect(posts[0].method).toBe('POST')
  expect(posts[0].body).toMatchObject({ v: 1, kind: 'usage', sessionId: 'sess-1', at: 10000 })
  expect(posts[0].body.usage.context).toEqual({ tokens: 51000, window: 200000, percent: 26 })
  expect(posts[0].body.usage.rateLimits[0]).toEqual({ kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-10-19T20:00:00Z' })
  expect(posts[1].body.agents).toEqual([{ id: 'a1', status: 'waiting', type: 'Explore' }])
})

test('the agents record carries no description and no prompt', async ($, on) => {
  const { posts } = rig($, on)
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 5, isAborted: false, usage: null })
  expect(JSON.stringify(posts)).not.toContain('secret task text')
})

test('with no port and token in the environment the mod posts nothing and does not fail', async ($, on) => {
  const { posts } = rig($, on, {})
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 5, isAborted: false, usage: null })
  expect(posts).toEqual([])
})

test('a token that is not hex, or a port that is not digits, posts nothing', async ($, on) => {
  const { posts } = rig($, on, { CLAUDE_CUSTOM_MOD_PORT: '4711/../x', CLAUDE_CUSTOM_MOD_TOKEN: 'abcdef0123456789abcdef' })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 5, isAborted: false, usage: null })
  expect(posts).toEqual([])
})

test('session.measure posts the event figures, at most once every two seconds', async ($, on) => {
  const { posts, clock } = rig($, on)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  const measure = { context: { window: 200000, tokens: 1000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 50 }], changed: ['rateLimits'] }
  await $.session.measure(measure)
  await $.session.measure(measure)
  expect(posts.length).toBe(1)
  expect(posts[0].body.usage.rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 50 }])
  await clock.advance(2000)
  await $.session.measure(measure)
  expect(posts.length).toBe(2)
})

test('a figure the CLI left out stays out: no cost, no percent, nothing zeroed', async ($, on) => {
  const { posts } = rig($, on)
  on('session.measure', () => ({ changed: ['context'] }))
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  expect(posts[0].body.usage).toEqual({ rateLimits: [], context: { window: 200000 } })
})

test('a rate limit without a numeric percent is dropped, never read as zero', async ($, on) => {
  const { posts } = rig($, on)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  await $.session.measure({ context: { window: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: null }, { kind: 'seven_day', percentUsed: 3 }], changed: ['rateLimits'] })
  expect(posts[0].body.usage.rateLimits).toEqual([{ kind: 'seven_day', percentUsed: 3 }])
})

test('the same agent roster is not posted twice', async ($, on) => {
  const { posts } = rig($, on)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  await $.turn.start({ turnId: 't1' })
  await $.turn.start({ turnId: 't2' })
  expect(posts.filter((p) => p.body.kind === 'agents').length).toBe(1)
})

test('tool.check passes the decision through unchanged and posts an ask by tool name only', async ($, on) => {
  const { posts } = rig($, on)
  on('tool.check', () => ({ decision: 'ask', reason: 'rule says ask' }))
  const out = await $.tool.check({ tool: 'Bash', input: { command: 'echo SECRET-COMMAND' } })
  expect(out).toEqual({ decision: 'ask', reason: 'rule says ask' })
  expect(posts.map((p) => p.body.kind)).toEqual(['ask', 'agents'])
  expect(posts[0].body).toMatchObject({ v: 1, kind: 'ask', sessionId: 'sess-1', ask: { tool: 'Bash' } })
  expect(posts[1].body.agents).toEqual([{ id: 'a1', status: 'waiting', type: 'Explore' }])
  expect(JSON.stringify(posts)).not.toContain('SECRET-COMMAND')
})

test('tool.check posts nothing for an allow or a deny, and returns them unchanged', async ($, on) => {
  const { posts } = rig($, on)
  let next = 'allow'
  on('tool.check', () => ({ decision: next, reason: 'r' }))
  expect(await $.tool.check({ tool: 'Read', input: {} })).toEqual({ decision: 'allow', reason: 'r' })
  next = 'deny'
  expect(await $.tool.check({ tool: 'Read', input: {} })).toEqual({ decision: 'deny', reason: 'r' })
  expect(posts).toEqual([])
})

test('a harness that is not there never changes what tool.check answers', async ($, on) => {
  const { posts } = rig($, on, undefined, true)
  on('tool.check', () => ({ decision: 'ask' }))
  const out = await $.tool.check({ tool: 'Bash', input: {} })
  expect(out).toEqual({ decision: 'ask' })
  expect(posts).toEqual([])
})

test('session.end posts an end record', async ($, on) => {
  const { posts } = rig($, on)
  on('session.end', ($: any, e: any) => ({ sessionId: 'sess-1' }))
  await $.session.end({ reason: 'other' })
  expect(posts[0].body).toMatchObject({ v: 1, kind: 'end', sessionId: 'sess-1', reason: 'other' })
})
