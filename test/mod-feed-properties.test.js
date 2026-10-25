'use strict';
/**
 * Properties of the mod feed (BACKLOG #119 A2): any valid record round-trips through the host's parser, any record with one
 * wrong-typed field is refused, nothing the mod's own record builders emit is ever refused by the host (the two halves agree),
 * and the parser never throws.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const fc = require('fast-check');

const { parseRecord, windowsFromRateLimits, contextFromUsage } = require('../host/mod-feed');

const text = fc.string({ minLength: 1, maxLength: 40 });
const num = fc.double({ noNaN: true, noDefaultInfinity: true });
const rateLimit = fc.record({ kind: text, percentUsed: num }, { requiredKeys: ['kind', 'percentUsed'] })
  .chain(r => fc.oneof(fc.constant(r), text.map(resetsAt => ({ ...r, resetsAt }))));
const context = fc.record({ tokens: num, window: num, percent: num }, { requiredKeys: [] });
const usageBody = fc.record({
  rateLimits: fc.array(rateLimit, { maxLength: 8 }),
  context,
  cost: fc.record({ usd: num }),
  startedAt: num,
}, { requiredKeys: ['rateLimits'] });
const agent = fc.record({ id: text, status: text, type: text, name: text, parentId: text }, { requiredKeys: ['id', 'status'] });
const head = fc.record({ v: fc.constant(1), sessionId: text, at: num });
const validRecord = fc.oneof(
  fc.tuple(head, usageBody).map(([h, usage]) => ({ ...h, kind: 'usage', usage })),
  fc.tuple(head, fc.array(agent, { maxLength: 10 })).map(([h, agents]) => ({ ...h, kind: 'agents', agents })),
  fc.tuple(head, fc.record({ tool: text, agentId: text }, { requiredKeys: ['tool'] })).map(([h, ask]) => ({ ...h, kind: 'ask', ask })),
  fc.tuple(head, fc.record({ reason: text }, { requiredKeys: [] })).map(([h, r]) => ({ ...h, kind: 'end', ...r })),
);

// -0 does not survive JSON.stringify; compare through it.
const viaJson = (v) => JSON.parse(JSON.stringify(v));

test('any valid record round-trips through the parser unchanged', () => {
  fc.assert(fc.property(validRecord, (rec) => {
    const r = parseRecord(JSON.stringify(rec));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.record, viaJson(rec));
  }));
});

const nonText = fc.constantFrom(null, 5, true, [], {}, 0);
const nonNumber = fc.constantFrom(null, 'x', '5', true, [], {});
const WRONG = { at: nonNumber, sessionId: fc.oneof(nonText, fc.constant('')), v: fc.constantFrom(2, 0, '1', null, true), kind: fc.constantFrom('other', '', 5, null) };
test('a valid record with its time, session id, version or kind replaced by a wrong value is always refused', () => {
  fc.assert(fc.property(validRecord, fc.constantFrom('at', 'sessionId', 'v', 'kind'), fc.nat(1000), (rec, field, n) => {
    const pool = fc.sample(WRONG[field], { numRuns: 1, seed: n });
    const broken = { ...rec, [field]: pool[0] };
    assert.strictEqual(parseRecord(JSON.stringify(broken)).ok, false);
  }));
});

test('a usage record with any one rate-limit field wrong-typed is refused', () => {
  const wrongFor = { kind: nonText, percentUsed: nonNumber, resetsAt: nonText };
  fc.assert(fc.property(head, fc.array(rateLimit, { minLength: 1, maxLength: 5 }), fc.nat(4), fc.constantFrom('kind', 'percentUsed', 'resetsAt'), fc.nat(1000), (h, limits, i, field, n) => {
    const at = i % limits.length;
    const value = fc.sample(wrongFor[field], { numRuns: 1, seed: n })[0];
    const rows = limits.map((r, j) => (j === at ? { ...r, [field]: value } : r));
    assert.strictEqual(parseRecord(JSON.stringify({ ...h, kind: 'usage', usage: { rateLimits: rows } })).ok, false);
  }));
});

test('the parser never throws, whatever it is given', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.json(), fc.jsonValue().map(v => JSON.stringify(v))), (t) => {
    const r = parseRecord(t);
    assert.ok(r.ok === true || typeof r.error === 'string');
  }), { numRuns: 500 });
});

test('windows: one per valid row, exactly one binding, a percent that is the row\'s own number', () => {
  fc.assert(fc.property(fc.array(rateLimit, { maxLength: 8 }), (rows) => {
    const w = windowsFromRateLimits(rows);
    assert.strictEqual(w.length, rows.length);
    assert.strictEqual(w.filter(x => x.isActive).length, rows.length ? 1 : 0);
    w.forEach((x, i) => { assert.strictEqual(x.percent, rows[i].percentUsed); assert.strictEqual(typeof x.percent, 'number'); });
    if (rows.length) assert.strictEqual(w.find(x => x.isActive).percent, Math.max(...rows.map(r => r.percentUsed)));
  }));
});

test('context: null, or a positive size with a used count that is a finite non-negative number', () => {
  fc.assert(fc.property(fc.record({ context }, { requiredKeys: [] }), (u) => {
    const c = contextFromUsage(u);
    if (c === null) return;
    assert.ok(c.size > 0 && Number.isFinite(c.used) && c.used >= 0);
  }));
});

test('what the mod\'s own record builders emit is always accepted by the host (the two halves agree)', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'mods', 'claude-custom', 'hooks', 'records.js')).href);
  const anything = fc.oneof(fc.constant(undefined), fc.constant(null), text, num, fc.constant(NaN), fc.object({ maxDepth: 2 }));
  const looseUsage = fc.record({ context: anything, rateLimits: fc.oneof(anything, fc.array(fc.record({ kind: anything, percentUsed: anything, resetsAt: anything }), { maxLength: 5 })), cost: anything, startedAt: anything }, { requiredKeys: [] });
  fc.assert(fc.property(text, num, looseUsage, fc.array(fc.record({ id: anything, status: anything, type: anything, name: anything, parentId: anything }, { requiredKeys: [] }), { maxLength: 80 }), anything, anything, (sessionId, at, usage, list, event, reason) => {
    for (const rec of [
      mod.usageRecord({ sessionId, at, usage }), mod.agentsRecord({ sessionId, at, list }),
      mod.askRecord({ sessionId, at, event }), mod.endRecord({ sessionId, at, reason }),
    ]) {
      const r = parseRecord(JSON.stringify(rec));
      assert.strictEqual(r.ok, true, `${r.error}: ${JSON.stringify(rec).slice(0, 200)}`);
    }
  }), { numRuns: 300 });
});
