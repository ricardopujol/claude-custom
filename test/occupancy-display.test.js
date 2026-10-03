'use strict';
/**
 * app/occupancy-display.js (backlog #44 + #47): what the live claims look like on the strip, in a worktree's
 * window and on the hub's agent cards. Pure; the strip, the page and the shell only draw what it says.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/occupancy-display');

const MIN = 60_000;
const key = p => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
const NOW = 10_000_000;
const claim = (over = {}) => ({
  agentId: 'a1', agent: 'electron-pro', worktree: 'C:/p/feat-x', also: [], fromBranch: 'develop', fromRoot: 'C:/p/dev',
  firstAt: NOW - 4 * MIN, lastAt: NOW - 1000, ...over,
});
const occ = (claims, k = 'c:/p/feat-x', opts = {}) => D.tabOccupancy(claims, k, { keyOf: key, now: NOW, ...opts });

test('initials: the first letters of the first two words, upper-cased', () => {
  assert.strictEqual(D.initials('electron-pro'), 'EP');
  assert.strictEqual(D.initials('logic-reviewer'), 'LR');
  assert.strictEqual(D.initials('general-purpose'), 'GP');
  assert.strictEqual(D.initials('plugin:helper'), 'PH');
  assert.strictEqual(D.initials('Explore'), 'EX');
  assert.strictEqual(D.initials('a'), 'A');
  assert.strictEqual(D.initials('one-two-three'), 'OT');
});

test('initials: a missing or empty name is "?", never an empty tag', () => {
  for (const v of [null, undefined, '', '  ', '--', 5, {}]) assert.strictEqual(D.initials(v), '?', String(v));
});

test('minutesLabel: whole minutes, with hours for a long run; no time or a clock gone backwards says nothing', () => {
  assert.strictEqual(D.minutesLabel(NOW - 4 * MIN, NOW), '4 min');
  assert.strictEqual(D.minutesLabel(NOW - 30_000, NOW), '<1 min');
  assert.strictEqual(D.minutesLabel(NOW - 59 * MIN, NOW), '59 min');
  assert.strictEqual(D.minutesLabel(NOW - 60 * MIN, NOW), '1 h');
  assert.strictEqual(D.minutesLabel(NOW - 125 * MIN, NOW), '2 h 5 min');
  for (const bad of [null, undefined, 'x', NaN, Infinity, NOW + MIN]) assert.strictEqual(D.minutesLabel(bad, NOW), null, String(bad));
  assert.strictEqual(D.minutesLabel(NOW - MIN, undefined), null);
});

test('tabOccupancy: nothing claims the tab, nothing is drawn (null, never an empty object)', () => {
  assert.strictEqual(occ([]), null);
  assert.strictEqual(occ(null), null);
  assert.strictEqual(occ([claim({ worktree: 'C:/p/feat-y' })]), null);
});

test('tabOccupancy: one agent -> a tag, a hover line, and no warning', () => {
  const o = occ([claim()]);
  assert.deepStrictEqual(o.tags, ['EP']);
  assert.strictEqual(o.more, 0);
  assert.strictEqual(o.warn, false);
  assert.deepStrictEqual(o.lines, ['electron-pro \u00b7 from develop \u00b7 4 min']);
  assert.strictEqual(o.count, 1);
});

test('tabOccupancy: a second agent is a second tag, in the order they arrived', () => {
  const o = occ([claim({ agentId: 'b', agent: 'logic-reviewer', firstAt: NOW - MIN }), claim({ agentId: 'a' })]);
  assert.deepStrictEqual(o.tags, ['EP', 'LR']);
  assert.strictEqual(o.lines.length, 2);
  assert.match(o.lines[1], /^logic-reviewer/);
});

test('tabOccupancy: more than three agents show three tags and a count of the rest', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((id, i) => claim({ agentId: id, agent: `agent-${id}`, firstAt: NOW - (10 - i) * MIN }));
  const o = occ(many);
  assert.strictEqual(o.tags.length, 3);
  assert.strictEqual(o.more, 2);
  assert.strictEqual(o.lines.length, 5, 'the hover still names every agent');
});

test('tabOccupancy: the tab\'s own session mid-turn is the two-writers warning, and the hover says so', () => {
  const o = occ([claim()], 'c:/p/feat-x', { turn: 'turn' });
  assert.strictEqual(o.warn, true);
  assert.ok(o.lines.includes("this tab's own session is writing too"));
});

test('tabOccupancy: idle, a dialog, or an unknown turn is NOT the warning (it only ever says what is known)', () => {
  for (const turn of ['idle', 'prompt', null, undefined, 'x', true, 1]) {
    assert.strictEqual(occ([claim()], 'c:/p/feat-x', { turn }).warn, false, String(turn));
  }
});

test('tabOccupancy: an agent with no name is "an agent", with no branch the "from" is left out, with no time too', () => {
  const o = occ([claim({ agent: null, fromBranch: null, firstAt: NOW + 5 * MIN })]);
  assert.deepStrictEqual(o.lines, ['an agent']);
  assert.deepStrictEqual(o.tags, ['?']);
});

test('tabOccupancy: matches the tab by KEY, so the same folder spelled another way is the same tab', () => {
  assert.ok(occ([claim({ worktree: 'C:\\P\\Feat-X\\' })]));
});

test('tabOccupancy: one agent id is one agent, however many claims name it', () => {
  assert.strictEqual(occ([claim(), claim({ lastAt: 5 })]).count, 1);
});

test('tabOccupancy: junk claims are ignored, not thrown on', () => {
  assert.strictEqual(occ([null, 3, {}, { worktree: 5 }, { agentId: 'x' }]), null);
});

// --- the page's banner --------------------------------------------------------------------------

test('banner: who, from where, how long, and where Jump goes', () => {
  const b = D.bannerModel([claim()], { keyOf: key, now: NOW });
  assert.strictEqual(b.text, 'electron-pro (from develop) is working in this folder');
  assert.strictEqual(b.since, '4 min');
  assert.strictEqual(b.more, '');
  assert.strictEqual(b.warn, false);
  assert.deepStrictEqual(b.jump, { label: 'Jump to develop', root: 'C:/p/dev' });
});

test('banner: a second agent is `+1 name`; more are counted and named', () => {
  const two = D.bannerModel([claim(), claim({ agentId: 'b', agent: 'logic-reviewer', firstAt: NOW })], { keyOf: key, now: NOW });
  assert.strictEqual(two.more, '+1 logic-reviewer');
  const three = D.bannerModel([claim(), claim({ agentId: 'b', agent: 'x', firstAt: NOW - 1 }), claim({ agentId: 'c', agent: 'y', firstAt: NOW })], { keyOf: key, now: NOW });
  assert.strictEqual(three.more, '+2 x, y');
});

test('banner: the warning colour only when this tab\'s own session is mid-turn, with the reason in words', () => {
  const w = D.bannerModel([claim()], { keyOf: key, now: NOW, turn: 'turn' });
  assert.strictEqual(w.warn, true);
  assert.match(w.note, /own session is writing too/);
  assert.strictEqual(D.bannerModel([claim()], { keyOf: key, now: NOW, turn: 'idle' }).note, '');
});

test('banner: nothing in, nothing out; no known launcher means no Jump (never a guessed one)', () => {
  assert.strictEqual(D.bannerModel([], { keyOf: key, now: NOW }), null);
  assert.strictEqual(D.bannerModel(null, { keyOf: key, now: NOW }), null);
  assert.strictEqual(D.bannerModel([claim({ fromRoot: '' })], { keyOf: key, now: NOW }).jump, null);
});

test('banner: the Jump label names the launching branch, or just the session when it has none', () => {
  assert.strictEqual(D.bannerModel([claim({ fromBranch: null })], { keyOf: key, now: NOW }).jump.label, 'Jump to its session');
});

// --- the hub's card -----------------------------------------------------------------------------

test('card line: the worktree the agent is in, by folder name, and where a click goes', () => {
  const c = D.cardLine([claim({ worktree: 'C:/p/feat-git-tree-living' })], 'electron-pro');
  assert.deepStrictEqual(c, { text: '\u2192 feat-git-tree-living', plus: 0, root: 'C:/p/feat-git-tree-living', title: 'electron-pro is working in C:/p/feat-git-tree-living' });
});

test('card line: a second worktree is `+1`, and the click still goes to the latest', () => {
  const c = D.cardLine([claim({ worktree: 'C:/p/feat-y', also: ['C:/p/feat-x'] })], 'electron-pro');
  assert.strictEqual(c.plus, 1);
  assert.strictEqual(c.text, '\u2192 feat-y');
  assert.strictEqual(c.root, 'C:/p/feat-y');
});

test('card line: two runs of one agent type in two worktrees: the latest, plus one', () => {
  const c = D.cardLine([claim({ agentId: 'a', worktree: 'C:/p/feat-x', lastAt: 1 }), claim({ agentId: 'b', worktree: 'C:/p/feat-y', lastAt: 9 })], 'electron-pro');
  assert.strictEqual(c.root, 'C:/p/feat-y');
  assert.strictEqual(c.plus, 1);
});

test('card line: the same worktree twice is not a +1', () => {
  const c = D.cardLine([claim({ agentId: 'a', lastAt: 1 }), claim({ agentId: 'b', lastAt: 9 })], 'electron-pro');
  assert.strictEqual(c.plus, 0);
});

test('card line: an agent with no claim shows nothing (an agent that hasn\'t touched another worktree is silent)', () => {
  assert.strictEqual(D.cardLine([claim()], 'logic-reviewer'), null);
  assert.strictEqual(D.cardLine([], 'electron-pro'), null);
  assert.strictEqual(D.cardLine(null, 'electron-pro'), null);
  assert.strictEqual(D.cardLine([claim()], ''), null);
  assert.strictEqual(D.cardLine([claim({ agent: null })], null), null, 'a nameless claim matches no card');
});

test('card line: matches the name exactly, as an own-property lookup (a card called __proto__ is just a name)', () => {
  assert.strictEqual(D.cardLine([claim({ agent: '__proto__' })], '__proto__').root, 'C:/p/feat-x');
  assert.strictEqual(D.cardLine([claim()], 'toString'), null);
});

// --- what main pushes to a page -----------------------------------------------------------------

test('viewPayload: the claims that occupy this tab, and the ones this tab\'s session launched', () => {
  const claims = [
    claim({ agentId: 'in', worktree: 'C:/p/feat-x', fromRoot: 'C:/p/dev' }),
    claim({ agentId: 'out', worktree: 'C:/p/feat-y', fromRoot: 'C:/p/feat-x' }),
    claim({ agentId: 'other', worktree: 'C:/p/feat-z', fromRoot: 'C:/p/feat-z-launcher' }),
  ];
  const v = D.viewPayload(claims, 'c:/p/feat-x', { keyOf: key });
  assert.deepStrictEqual(v.here.map(c => c.agentId), ['in']);
  assert.deepStrictEqual(v.launched.map(c => c.agentId), ['out']);
});

test('viewPayload: only the fields a page draws from cross the bridge', () => {
  const v = D.viewPayload([claim({ hostPid: 4242, hostStartedAt: '1', count: 9 })], 'c:/p/feat-x', { keyOf: key });
  assert.deepStrictEqual(Object.keys(v.here[0]).sort(),
    ['agent', 'agentId', 'also', 'firstAt', 'fromBranch', 'fromRoot', 'lastAt', 'worktree']);
});

test('viewPayload: nothing to say is two empty lists, never undefined', () => {
  assert.deepStrictEqual(D.viewPayload(null, 'x', { keyOf: key }), { here: [], launched: [] });
});

test('PROPERTY: initials are 1-2 characters, never empty, whatever the name', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.integer()), (name) => {
    const i = D.initials(name);
    assert.strictEqual(typeof i, 'string');
    const n = Array.from(i).length;
    assert.ok(n >= 1 && n <= 2, JSON.stringify(i));
    return true;
  }), { numRuns: 300 });
});

test('PROPERTY: the tags + more always account for every agent in the hover', () => {
  const agent = fc.record({ agentId: fc.stringMatching(/^[a-z]{1,6}$/), agent: fc.option(fc.stringMatching(/^[a-z-]{1,10}$/), { nil: null }), firstAt: fc.integer({ min: 0, max: NOW }) });
  fc.assert(fc.property(fc.array(agent, { maxLength: 8 }), (as) => {
    const o = occ(as.map(a => claim(a)));
    if (o === null) return as.length === 0;
    assert.strictEqual(o.tags.length + o.more, o.count);
    assert.ok(o.lines.length >= o.count);
    return true;
  }), { numRuns: 200 });
});
