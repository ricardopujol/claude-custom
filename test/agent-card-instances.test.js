'use strict';
/**
 * BACKLOG #142 b, the card's half: one card per running instance, with the same portrait and name and its own state; the "×N"
 * badge goes. The host sends the rows (host/mood-machine.js instancesOf, on the `mood` frame as `instances`, each with its own
 * portrait); app/agent-state-display.js instanceRows turns one roster row into the cards it draws. Medals, hides and pauses stay
 * keyed by the agent's name (the open question's default): every card of a name carries the same `data-agent`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { agentStateDisplay: D } = require('../app/agent-state-display');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const row = (extra = {}) => ({ agent: 'code-reviewer', state: 'working', detail: 'working', portrait: { tier: 'text' }, ...extra });

test('instanceRows: a row without instances is its one card, unchanged', () => {
  const r = row();
  assert.deepStrictEqual(D.instanceRows(r), [r]);
  assert.deepStrictEqual(D.instanceRows(row({ instances: null })), [row({ instances: null })]);
});

test('instanceRows: two instances are two cards of the same agent, each with its own state, detail, cause and portrait', () => {
  // The name's own cause and wait (PR #239 Miguel S1) must never leak onto an instance card that has none.
  const cards = D.instanceRows(row({ state: 'stressed', cause: 'the name\'s own', wait: { on: 'npm test', since: 1 }, instances: [
    { id: 'toolu_A', state: 'working', detail: 'reading', portrait: { tier: 'file', src: 'a' } },
    { id: 'toolu_B', state: 'stressed', detail: 'stressed', cause: 'A Bash call failed' },
  ] }));
  assert.strictEqual(cards.length, 2);
  assert.deepStrictEqual(cards.map(c => [c.agent, c.instance, c.state, c.detail, c.cause]),
    [['code-reviewer', 'toolu_A', 'working', 'reading', undefined], ['code-reviewer', 'toolu_B', 'stressed', 'stressed', 'A Bash call failed']]);
  assert.deepStrictEqual(cards[0].portrait, { tier: 'file', src: 'a' });
  assert.deepStrictEqual(cards[1].portrait, { tier: 'text' }, 'no portrait of its own: the agent\'s');
  assert.ok(cards.every(c => !('instances' in c) || c.instances === undefined), 'a card never carries the list again');
  assert.ok(!('cause' in cards[0]) && !('wait' in cards[0]), 'the working card carries neither the name\'s cause nor its wait');
  assert.strictEqual(cards[1].cause, 'A Bash call failed', 'the stressed card carries its own cause, not the name\'s');
});

test('instanceRows: a malformed instance is skipped, and fewer than two good ones is the one card', () => {
  const r = row({ instances: [{ id: 'toolu_A', state: 'working', detail: 'working' }, { id: 7 }, null, { state: 'working' }] });
  assert.deepStrictEqual(D.instanceRows(r), [r]);
});

test('property: instanceRows never invents a card, and never loses one', () => {
  const inst = fc.record({ id: fc.oneof(fc.string(), fc.constant(null)), state: fc.constantFrom('working', 'stressed', 'happy', 'bogus'), detail: fc.string() });
  fc.assert(fc.property(fc.option(fc.array(inst, { maxLength: 5 })), (instances) => {
    const cards = D.instanceRows(row({ instances }));
    const good = (instances || []).filter(i => typeof i.id === 'string' && i.id !== '' && typeof i.state === 'string');
    assert.strictEqual(cards.length, good.length >= 2 ? good.length : 1);
    assert.ok(cards.every(c => c.agent === 'code-reviewer'));
  }));
});

test('the host puts each instance on the mood frame with its own portrait', () => {
  const host = read('host/host.js');
  assert.match(host, /const instances = mood\.instancesOf\(agent\);/);
  assert.match(host, /out\.instances = instances\.map\(\(i\) => \(\{ \.\.\.i, portrait: portraitOf\(agent, BG_WAIT_DETAILS\.has\(i\.detail\) \? i\.state : i\.detail, i\.state\) \}\)\);/);
});

test('the roster draws one card per instance, and the ×N badge is gone', () => {
  const js = read('app/renderer.js');
  assert.match(js, /\.flatMap\(\(r\) => window\.agentStateDisplay\.instanceRows\(r\)\)/);
  assert.match(js, /\(r\.instance \? ` data-instance="\$\{escapeHtml\(r\.instance\)\}"` : ''\)/);
  assert.doesNotMatch(js, /function countBadgeHtml/);
  assert.doesNotMatch(js, /class="agent-count"/);
});

// ---- PR #239 Dexter 4: a finished instance's card offers no Pause; a live one's Pause names its own run ---------------------------

const P = require('../app/agent-pause-display');

test('A4: cardHtml draws no Pause on a finished instance card, and a live instance card\'s Pause carries its own task id', () => {
  const pause = { kind: 'pause' };
  assert.strictEqual(P.cardHtml(pause, { agent: 'code-reviewer', instance: 'toolu_A', ended: true, agentId: 'aA1' }), '', 'a flash is not a run');
  const live = P.cardHtml(pause, { agent: 'code-reviewer', instance: 'toolu_B', agentId: 'acode-reviewer-00000000000000bb' });
  assert.match(live, /data-agent-pause-task="acode-reviewer-00000000000000bb"/);
  assert.strictEqual(P.cardHtml(pause, { agent: 'code-reviewer' }), P.html(pause, 'code-reviewer'), 'a name card is unchanged');
  assert.doesNotMatch(P.cardHtml(pause, { agent: 'code-reviewer', instance: 'toolu_B', agentId: 'not plain!' }), /data-agent-pause-task/, 'only a plain id');
});

test('A4: a click on a live instance card\'s Pause names that run', () => {
  assert.deepStrictEqual(P.clickAction({ agentPauseAct: 'pause', agent: 'code-reviewer', agentPauseTask: 'aB_1' }),
    { act: 'pause', agent: 'code-reviewer', taskId: 'aB_1' });
  assert.deepStrictEqual(P.clickAction({ agentPauseAct: 'pause', agent: 'code-reviewer' }), { act: 'pause', agent: 'code-reviewer' });
  assert.deepStrictEqual(P.clickAction({ agentPauseAct: 'pause', agent: 'code-reviewer', agentPauseTask: 'x y' }), { act: 'pause', agent: 'code-reviewer' });
});

test('A4: an instance card carries whether it ended and its run\'s agent_id', () => {
  const cards = D.instanceRows(row({ instances: [
    { id: 'toolu_A', state: 'happy', detail: 'happy', ended: true, agentId: 'aA' },
    { id: 'toolu_B', state: 'working', detail: 'working', agentId: 'aB' },
  ] }));
  assert.deepStrictEqual(cards.map(c => [c.instance, c.ended === true, c.agentId]), [['toolu_A', true, 'aA'], ['toolu_B', false, 'aB']]);
});

test('A4: the roster card draws its Pause through cardHtml, and the click prefers the card\'s own task id', () => {
  const js = read('app/renderer.js');
  assert.match(js, /window\.agentPauseDisplay\.cardHtml\(agentPauses\.view\(r\.agent, counts\.get\(r\.agent\) \|\| 0\), r\)/);
  assert.match(js, /const taskId = act\.taskId !== undefined \? act\.taskId : ids\.length === 1 \? ids\[0\] : undefined;/);
});

// ---- PR #239 Miguel Y1 (A9): two cards on one face key each keep their own live video ----------------------------------------

const M = require('../app/portrait-media-display');

test('A9: pairVideoReuse gives every fresh video of a key its own old node, in order, and never one node twice', () => {
  assert.deepStrictEqual(M.pairVideoReuse(['k', 'k'], ['k', 'k']), [0, 1], 'two cards, two live videos kept');
  assert.deepStrictEqual(M.pairVideoReuse(['k'], ['k', 'k']), [0, -1], 'a second card is new: one fresh node');
  assert.deepStrictEqual(M.pairVideoReuse(['a', 'k', 'b'], ['b', 'a', 'x']), [2, 0, -1]);
  assert.deepStrictEqual(M.pairVideoReuse([], ['k']), [-1]);
});

test('A9: property: pairVideoReuse never reuses a node twice and only pairs equal keys, as many as the keys allow', () => {
  const key = fc.constantFrom('a', 'b', 'c');
  fc.assert(fc.property(fc.array(key, { maxLength: 6 }), fc.array(key, { maxLength: 6 }), (olds, news) => {
    const pairs = M.pairVideoReuse(olds, news);
    assert.strictEqual(pairs.length, news.length);
    const used = pairs.filter(i => i >= 0);
    assert.strictEqual(new Set(used).size, used.length);
    pairs.forEach((i, j) => { if (i >= 0) assert.strictEqual(olds[i], news[j]); });
    for (const k of new Set(news)) {
      const want = Math.min(olds.filter(x => x === k).length, news.filter(x => x === k).length);
      assert.strictEqual(pairs.filter((i, j) => i >= 0 && news[j] === k).length, want);
    }
  }));
});

test('A9: setRosterHtml keeps a LIST of live videos per face key', () => {
  const js = read('app/renderer.js');
  assert.match(js, /portraitMedia\.pairVideoReuse\(/);
  assert.doesNotMatch(js, /if \(!oldByKey\.has\(v\.dataset\.faceKey\)\) oldByKey\.set/);
});

// ---- PR #239 Dexter 5 / Miguel Y5 (A5): a repaint replaces only the cards whose markup changed --------------------------------

const cardOf = (agent, instance, html) => ({ key: agent + '|' + (instance || ''), html });

test('A5: rosterPatch replaces only the changed cards when the same cards are in the same places', () => {
  const old = [cardOf('a', '', '<1>'), cardOf('b', 'toolu_1', '<2>'), cardOf('b', 'toolu_2', '<3>')];
  assert.deepStrictEqual(D.rosterPatch(old, [cardOf('a', '', '<1>'), cardOf('b', 'toolu_1', '<2x>'), cardOf('b', 'toolu_2', '<3>')]),
    { full: false, replace: [1] });
  assert.deepStrictEqual(D.rosterPatch(old, old.map(c => ({ ...c }))), { full: false, replace: [] });
});

test('A5: rosterPatch replaces everything when the cards, their order or their number changed, or a node is not a card', () => {
  const old = [cardOf('a', '', '<1>'), cardOf('b', '', '<2>')];
  assert.deepStrictEqual(D.rosterPatch(old, [cardOf('b', '', '<2>'), cardOf('a', '', '<1>')]), { full: true });
  assert.deepStrictEqual(D.rosterPatch(old, [cardOf('a', '', '<1>')]), { full: true });
  assert.deepStrictEqual(D.rosterPatch(old, [cardOf('a', '', '<1>'), { key: null, html: 'x' }]), { full: true });
  assert.deepStrictEqual(D.rosterPatch([], []), { full: true }, 'an empty roster is a plain replace');
  assert.deepStrictEqual(D.rosterPatch([{ key: 'a|', html: undefined }], [cardOf('a', '', '<1>')]), { full: false, replace: [0] },
    'a card whose painted markup is unknown is replaced');
});

test('A5: setRosterHtml patches through rosterPatch, keyed by data-agent and data-instance', () => {
  const js = read('app/renderer.js');
  assert.match(js, /window\.agentStateDisplay\.rosterPatch\(/);
  assert.match(js, /n\.dataset\.agent \+ '\|' \+ \(n\.dataset\.instance \|\| ''\)/);
});
