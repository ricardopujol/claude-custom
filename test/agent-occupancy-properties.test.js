'use strict';
/**
 * PROPERTIES for host/agent-occupancy.js (backlog #44 + #47, item 5 of the merge gate). The invariants the
 * design's Testing section names, stated over generated roots and paths rather than a few hand-picked ones:
 *
 *   - for any roots and any path, a claim names at most one root, and it is the LONGEST one containing it;
 *   - the launching session's own root never claims;
 *   - a Bash command with no root string in it never claims;
 *   - an event without a usable agent_id never claims;
 * plus: `latest` is order-stable and loses nothing; the claim file round-trips; parseClaim is total.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fc = require('fast-check');

const O = require('../host/agent-occupancy');
const { isInside, samePath, normPath } = require('../host/project-layout');

const BASE = path.resolve('/occ-prop');
// Short, overlapping segment names, so roots nest (`a` inside `a\b`'s parent, `ab` beside `a`) often.
const seg = fc.constantFrom('a', 'ab', 'b', 'a-b', 'dev', 'dev2', '.claude', 'worktrees', 'x');
const rel = fc.array(seg, { minLength: 1, maxLength: 4 });
const root = rel.map(parts => path.join(BASE, ...parts));
const roots = fc.array(root, { minLength: 1, maxLength: 6 });
const AGENT = 'agent_1';

const preFile = (file, extra = {}) => ({
  event: 'PreToolUse',
  payload: { tool_name: 'Edit', tool_input: { file_path: file }, agent_id: AGENT, agent_type: 'electron-pro', ...extra },
});
const preBash = command => ({
  event: 'PreToolUse',
  payload: { tool_name: 'Bash', tool_input: { command }, agent_id: AGENT },
});

test('a path claims at most one root, and it is the longest root containing it', () => {
  fc.assert(fc.property(roots, root, rel, fc.integer({ min: 0, max: 5 }), (rs, own, tail, pick) => {
    const base = rs[pick % rs.length];
    const file = path.join(base, ...tail);
    const c = O.claimFrom(preFile(file), rs, own);
    const containing = rs.filter(r => isInside(file, r));
    if (c === null) {
      // nothing claimed: either nothing contains it, or the longest container is the own root
      if (containing.length === 0) return true;
      const longest = Math.max(...containing.map(r => normPath(r).length));
      return containing.filter(r => normPath(r).length === longest).some(r => samePath(r, own));
    }
    assert.ok(rs.includes(c.worktree), 'it names one of the roots');
    assert.ok(isInside(file, c.worktree), 'that contains the path');
    assert.ok(!samePath(c.worktree, own), 'and is not the own root');
    for (const r of containing) {
      assert.ok(normPath(r).length <= normPath(c.worktree).length, `${r} is longer and contains it`);
    }
    return true;
  }), { numRuns: 400 });
});

test('a search path (Grep, Glob) claims the longest root that contains it OR is it, and never the own root', () => {
  const preSearch = (tool, p) => ({ event: 'PreToolUse', payload: { tool_name: tool, tool_input: { pattern: 'x', path: p }, agent_id: AGENT } });
  // the searched path is a root itself (no tail) about as often as something under one
  const tailOrNone = fc.oneof(fc.constant([]), rel);
  fc.assert(fc.property(roots, root, tailOrNone, fc.integer({ min: 0, max: 5 }), fc.constantFrom('Grep', 'Glob'), (rs, own, tail, pick, tool) => {
    const searched = path.join(rs[pick % rs.length], ...tail);
    const c = O.claimFrom(preSearch(tool, searched), rs, own);
    const holding = rs.filter(r => isInside(searched, r) || samePath(searched, r));
    assert.ok(holding.length > 0, 'the generator always searches in or at a root');
    const longest = Math.max(...holding.map(r => normPath(r).length));
    const winner = holding.find(r => normPath(r).length === longest);
    if (samePath(winner, own)) return c === null;
    assert.ok(c !== null, `${searched} is in or at ${winner}`);
    assert.ok(samePath(c.worktree, winner));
    assert.ok(rs.includes(c.worktree), 'named as one of the roots given');
    // the same answer without an event
    assert.ok(samePath(O.touchOf(tool, { pattern: 'x', path: searched }, rs, own), winner));
    return true;
  }), { numRuns: 400 });
});

test('the own root never claims, whatever the path or the other roots', () => {
  fc.assert(fc.property(roots, rel, (rs, tail) => {
    for (const own of rs) {
      // a path in the own folder that no OTHER (longer) root contains
      const file = path.join(own, ...tail);
      const c = O.claimFrom(preFile(file), rs, own);
      if (c !== null) assert.ok(!samePath(c.worktree, own));
      const cmd = O.claimFrom(preBash(`cd ${own} && ls`), rs, own);
      if (cmd !== null) assert.ok(!samePath(cmd.worktree, own));
    }
    return true;
  }), { numRuns: 300 });
});

test('a Bash command claims only a root whose path it actually contains', () => {
  const word = fc.constantFrom('git', 'status', 'ls', '-la', 'cd', '&&', 'npm', 'test', '"', '\'', '../x', './y',
    '/', '\\', 'a', 'ab', 'dev', 'worktrees', '.claude');
  const command = fc.array(fc.oneof(word, root), { maxLength: 8 }).map(w => w.join(' '));
  fc.assert(fc.property(roots, root, command, (rs, own, cmd) => {
    const c = O.claimFrom(preBash(cmd), rs, own);
    if (c === null) return true;
    const squash = s => s.replace(/[\\/]+/g, '/').toLowerCase();
    assert.ok(squash(cmd).includes(squash(normPath(c.worktree))) || squash(cmd).includes(squash(c.worktree)),
      'the claimed root is spelled in the command');
    assert.ok(!samePath(c.worktree, own));
    return true;
  }), { numRuns: 400 });
});

test('a Bash command with no root string never claims', () => {
  const word = fc.constantFrom('git', 'status', 'ls', '-la', 'cd', '&&', 'npm', 'test', '../a', './dev', 'x/y');
  fc.assert(fc.property(roots, root, fc.array(word, { maxLength: 8 }), (rs, own, words) => {
    return O.claimFrom(preBash(words.join(' ')), rs, own) === null;
  }), { numRuns: 300 });
});

test('an event without a usable agent_id never claims, for any tool', () => {
  const badId = fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant(''), fc.integer(), fc.boolean(),
    fc.constantFrom('../x', 'a/b', 'a b', 'x.json', '..'), fc.string({ maxLength: 12 }).filter(s => !/^[A-Za-z0-9_-]{1,64}$/.test(s)));
  fc.assert(fc.property(roots, root, rel, badId, (rs, own, tail, id) => {
    const file = path.join(rs[0], ...tail);
    const files = O.claimFrom(preFile(file, { agent_id: id }), rs, own);
    const bash = O.claimFrom({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: rs[0] }, agent_id: id } }, rs, own);
    return files === null && bash === null;
  }), { numRuns: 300 });
});

test('only a PreToolUse claims, for any other event name', () => {
  fc.assert(fc.property(roots, root, rel, fc.constantFrom('PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'Stop', 'x', ''),
    (rs, own, tail, name) => O.claimFrom({ ...preFile(path.join(rs[0], ...tail)), event: name }, rs, own) === null),
  { numRuns: 100 });
});

// --- latest -------------------------------------------------------------------------------------

const touch = fc.record({
  worktree: root,
  lastAt: fc.integer({ min: 0, max: 50 }),
  firstAt: fc.integer({ min: 0, max: 50 }),
  count: fc.integer({ min: 1, max: 9 }),
});

test('latest: the winner has the maximum lastAt, `also` never repeats it or itself, and every worktree is accounted for', () => {
  fc.assert(fc.property(fc.array(touch, { minLength: 1, maxLength: 8 }), (ts) => {
    const r = O.latest(ts);
    assert.ok(r !== null);
    assert.strictEqual(r.touch.lastAt, Math.max(...ts.map(t => t.lastAt)));
    const keys = [r.worktree, ...r.also].map(normPath);
    assert.strictEqual(new Set(keys).size, keys.length, 'each worktree once');
    assert.deepStrictEqual([...keys].sort(), [...new Set(ts.map(t => normPath(t.worktree)))].sort(),
      'no worktree is invented or lost');
    return true;
  }), { numRuns: 300 });
});

test('latest: is the same whatever order the touches arrive in, apart from ties', () => {
  const distinct = fc.uniqueArray(touch, { minLength: 1, maxLength: 6, selector: t => `${normPath(t.worktree)}|${t.lastAt}` })
    .filter(ts => new Set(ts.map(t => t.lastAt)).size === ts.length && new Set(ts.map(t => normPath(t.worktree))).size === ts.length);
  fc.assert(fc.property(distinct, (ts) => {
    const a = O.latest(ts);
    const b = O.latest([...ts].reverse());
    assert.strictEqual(normPath(a.worktree), normPath(b.worktree));
    assert.deepStrictEqual(a.also.map(normPath), b.also.map(normPath));
    return true;
  }), { numRuns: 200 });
});

// --- the claim file -----------------------------------------------------------------------------

const claimRecord = fc.record({
  agentId: fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
  agent: fc.oneof(fc.constant(null), fc.constantFrom('electron-pro', 'logic-reviewer')),
  worktree: root,
  also: fc.array(root, { maxLength: O.ALSO_MAX }),
  fromBranch: fc.oneof(fc.constant(null), fc.constantFrom('develop', 'feat/x')),
  fromRoot: root,
  sessionId: fc.oneof(fc.constant(null), fc.uuid(), fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)),
  hostPid: fc.integer({ min: 1, max: 4000000 }),
  hostStartedAt: fc.oneof(fc.constant(null), fc.bigInt({ min: 1n, max: 9999999999999999999n }).map(String)),
  firstAt: fc.integer({ min: 0, max: 2 ** 40 }),
  lastAt: fc.integer({ min: 0, max: 2 ** 40 }),
  count: fc.integer({ min: 1, max: 100000 }),
});

test('serialize then parse is the identity on every valid claim', () => {
  fc.assert(fc.property(claimRecord, (c) => {
    const r = O.parseClaim(O.serializeClaim(c));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.claim, { ...c });
    return true;
  }), { numRuns: 300 });
});

test('parseClaim is total: any JSON text gives a verdict, and an ok claim always carries a safe file name', () => {
  const json = fc.oneof(fc.jsonValue().map(v => JSON.stringify(v)), fc.string(),
    claimRecord.chain(c => fc.constantFrom('agentId', 'worktree', 'hostPid', 'lastAt', 'count', 'fromRoot')
      .map(k => JSON.stringify({ ...c, [k]: null }))));
  fc.assert(fc.property(json, (text) => {
    const r = O.parseClaim(text);
    assert.strictEqual(typeof r.ok, 'boolean');
    if (r.ok) {
      assert.notStrictEqual(O.claimFileName(r.claim.agentId), null);
      assert.ok(path.isAbsolute(r.claim.worktree) && path.isAbsolute(r.claim.fromRoot));
      assert.ok(Number.isInteger(r.claim.hostPid) && r.claim.hostPid > 0);
    } else {
      assert.strictEqual(typeof r.reason, 'string');
    }
    return true;
  }), { numRuns: 500 });
});

test('buildClaim round-trips through the file for any touches', () => {
  fc.assert(fc.property(fc.array(touch, { minLength: 1, maxLength: 6 }), (ts) => {
    const b = O.buildClaim({ agentId: AGENT, agent: 'a', fromBranch: 'develop', fromRoot: BASE, hostPid: 9,
      hostStartedAt: '133800000000000000', touches: ts });
    const r = O.parseClaim(O.serializeClaim(b));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.claim, b);
    return true;
  }), { numRuns: 200 });
});
