'use strict';
/**
 * BACKLOG #33 gamification, the page's side: the explainer as a roster member. Pure rules (app/ask-explainer-display.js): which tab it is on,
 * what its card says, its counts (unknown is never 0), its words, and that a rename keeps what belongs to it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const X = require('../app/ask-explainer-display');
const { agentStateDisplay } = require('../app/agent-state-display');
const md = require('../app/medals-display');
const rs = require('../app/roster-search-display');

const NAMED = { named: true, name: 'Professor Byte', portrait: { kind: 'upload' } };
const frame = (over = {}) => ({ state: 'sleeping', detail: 'sleeping', panels: 0, counts: { questions: 142, places: 318 }, portrait: { kind: 'text', tier: 'text' }, ...over });

test('the explainer is keyed by one fixed agent id, never by its name, and is tagged "local helper" with the role "Ask the repo"', () => {
  assert.strictEqual(X.AGENT, 'ask-explainer');
  assert.strictEqual(X.ROLE, 'Ask the repo');
  assert.strictEqual(X.TAG, 'local helper');
  assert.match(X.tagHtml(), /class="agent-tag"[^>]*>local helper</);
});

test('frameOf accepts the host\'s frame and refuses anything that isn\'t one (an unknown frame is no frame, never a sleeping one)', () => {
  assert.deepStrictEqual(X.frameOf(frame()), frame());
  for (const bad of [null, undefined, 7, 'x', [], {}, frame({ state: 'inactive' }), frame({ state: 5 }), frame({ detail: 5 }), frame({ panels: -1 }), frame({ panels: 1.5 }), frame({ panels: '1' }), frame({ panels: null })]) {
    assert.strictEqual(X.frameOf(bad), null, JSON.stringify(bad));
  }
});

test('frameOf keeps counts only when BOTH are whole numbers from 0; anything else is unknown (null), never 0', () => {
  for (const bad of [null, undefined, {}, { questions: 1 }, { questions: null, places: 2 }, { questions: '1', places: 2 }, { questions: -1, places: 0 }, { questions: 1.5, places: 0 }, { questions: NaN, places: 0 }, 5]) {
    assert.strictEqual(X.frameOf(frame({ counts: bad })).counts, null, JSON.stringify(bad));
  }
  assert.deepStrictEqual(X.frameOf(frame({ counts: { questions: 0, places: 0 } })).counts, { questions: 0, places: 0 });
});

test('it is on Active while an Ask panel is open somewhere, on Inactive otherwise, and nowhere until it has been named or the host has spoken', () => {
  assert.strictEqual(X.tabFor(frame({ panels: 1 }), NAMED), 'active');
  assert.strictEqual(X.tabFor(frame({ panels: 3 }), NAMED), 'active');
  assert.strictEqual(X.tabFor(frame({ panels: 0 }), NAMED), 'inactive');
  assert.strictEqual(X.tabFor(frame({ panels: 1 }), { ...NAMED, named: false }), null, 'not on the roster until it is named');
  assert.strictEqual(X.tabFor(frame({ panels: 1 }), { ...NAMED, name: '' }), null);
  assert.strictEqual(X.tabFor(null, NAMED), null, 'the host has not said');
  assert.strictEqual(X.tabFor(frame(), null), null);
});

test('its card row carries the fixed agent id and the host\'s state, so it sorts like an agent', () => {
  const rows = [
    { agent: 'miguel', state: 'sleeping', detail: 'sleeping' },
    X.row(frame({ panels: 1, state: 'working', detail: 'writing' }), NAMED),
    { agent: 'dexter', state: 'stressed', detail: 'stressed' },
  ];
  assert.deepStrictEqual(agentStateDisplay.sortRows(rows).map(r => r.agent), ['ask-explainer', 'dexter', 'miguel']);
  const r = X.row(frame({ panels: 1, state: 'working', detail: 'reading' }), NAMED);
  assert.deepStrictEqual([r.agent, r.state, r.detail, r.explainer], ['ask-explainer', 'working', 'reading', true]);
  assert.strictEqual(X.row(frame({ panels: 0 }), NAMED), null, 'the active row exists only on the active tab');
});

test('look: the agents\' own display for the state, with the explainer\'s words for what it is doing', () => {
  assert.deepStrictEqual(X.look('working', 'reading'), { state: 'working', detail: 'reading', words: 'searching', badge: { icon: '\u{1F4D6}', label: 'reading' } });
  assert.deepStrictEqual(X.look('working', 'writing'), { state: 'working', detail: 'writing', words: 'writing the explanation', badge: { icon: '✏️', label: 'writing' } });
  assert.strictEqual(X.look('sleeping', 'sleeping').words, 'sleeping');
  assert.strictEqual(X.look('happy', 'happy').words, 'happy');
  assert.strictEqual(X.look('stressed', 'stressed').words, 'stressed');
  assert.strictEqual(X.look('stressed', 'stressed').badge, null);
  // the agents' own display decides the badge and what fits what: the explainer adds only words
  for (const [s, d] of [['working', 'reading'], ['working', 'writing'], ['sleeping', 'sleeping'], ['happy', 'happy'], ['stressed', 'stressed'], ['sleeping', 'reading']]) {
    const mine = X.look(s, d);
    const theirs = agentStateDisplay.describeState(s, d);
    assert.deepStrictEqual([mine.state, mine.detail, mine.badge], [theirs.state, theirs.detail, theirs.badge]);
  }
  assert.strictEqual(X.look('sleeping', 'reading').words, 'sleeping', 'a detail that does not fit the state is not drawn');
});

test('the reading/writing badges are the 📖 and ✏️ the design names, drawn by the agents\' own badge', () => {
  assert.match(agentStateDisplay.badgeHtml('working', 'reading'), /📖|\u{1F4D6}/u);
  assert.match(agentStateDisplay.badgeHtml('working', 'writing'), /✏️/);
});

test('the counts line: "N questions · M places opened", singular for one, a real 0, and unknown is a dash, not 0', () => {
  assert.strictEqual(X.countsText({ questions: 142, places: 318 }), '142 questions · 318 places opened');
  assert.strictEqual(X.countsText({ questions: 1, places: 1 }), '1 question · 1 place opened');
  assert.strictEqual(X.countsText({ questions: 0, places: 0 }), '0 questions · 0 places opened');
  assert.strictEqual(X.countsText(null), null);
  assert.match(X.countsHtml({ questions: 142, places: 318 }), /142 questions · 318 places opened/);
  assert.match(X.countsHtml(null), /career-unknown[^>]*title="[^"]*[Cc]ouldn't read[^"]*"[^>]*>—</);
  assert.doesNotMatch(X.countsHtml(null), /\b0\b/);
});

test('names: the Persona mode shows its name, the Role mode shows "Ask the repo", each with the other small beside it', () => {
  assert.deepStrictEqual(rs.cardNames(X.ROLE, X.entry(NAMED), 'name'), { big: 'Professor Byte', small: 'Ask the repo' });
  assert.deepStrictEqual(rs.cardNames(X.ROLE, X.entry(NAMED), 'role'), { big: 'Ask the repo', small: 'Professor Byte' });
});

test('search finds it by its name, its role or "local helper", and nothing else', () => {
  for (const q of ['byte', 'PROFESSOR', 'ask the', 'repo', 'local', 'helper', '']) assert.strictEqual(X.matches(NAMED, q), true, q);
  for (const q of ['miguel', 'zzz']) assert.strictEqual(X.matches(NAMED, q), false, q);
});

test('the log page shows the counts, and says so plainly when they could not be read', () => {
  const ok = X.logPageHtml({ name: 'Professor Byte', counts: { questions: 142, places: 318 } });
  assert.match(ok, /data-agent-log-close/);
  assert.match(ok, /Professor Byte/);
  assert.match(ok, /142[^<]*<\/b>[^<]*questions answered/);
  assert.match(ok, /318[^<]*<\/b>[^<]*places opened/);
  const unknown = X.logPageHtml({ name: 'Ada', counts: null });
  assert.match(unknown, /[Cc]ouldn't read/);
  assert.doesNotMatch(unknown, /<b>0<\/b>/);
  assert.match(X.logPageHtml({ name: '<img onerror=x>', counts: null }), /&lt;img onerror=x&gt;/);
});

test('portraitFor: an agent\'s picture chosen on the naming card follows that agent, else the explainer\'s own', () => {
  const own = { kind: 'file', tier: 'uploaded' };
  const f = frame({ portrait: own });
  const lookup = (a) => (a === 'naomi' ? { kind: 'file', tier: 'forge', agent: 'naomi' } : null);
  assert.deepStrictEqual(X.portraitFor({ ...NAMED, portrait: { kind: 'agent', agent: 'naomi' } }, f, lookup).agent, 'naomi');
  assert.strictEqual(X.portraitFor({ ...NAMED, portrait: { kind: 'agent', agent: 'gone' } }, f, lookup), own);
  assert.strictEqual(X.portraitFor(NAMED, f, lookup), own);
  assert.strictEqual(X.portraitFor(NAMED, null, lookup), null);
});


test('PROPERTY: a rename never loses medals or counts: the card row, the medals key and the counts do not depend on the name', () => {
  const list = [{ agent: X.AGENT, medals: [{ id: 'a', kind: 'fast' }, { id: 'b', kind: 'spot-on' }] }, { agent: 'miguel', medals: [{ id: 'c', kind: 'fast' }] }];
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 24 }).filter(s => s.trim() !== ''), fc.string({ minLength: 1, maxLength: 24 }).filter(s => s.trim() !== ''), fc.nat(1000), fc.nat(1000), (a, b, q, p) => {
    const f = frame({ panels: 1, counts: { questions: q, places: p } });
    const ra = X.row(f, { ...NAMED, name: a });
    const rb = X.row(f, { ...NAMED, name: b });
    assert.strictEqual(ra.agent, rb.agent);
    assert.strictEqual(md.countOf(list, ra.agent), 2);
    assert.strictEqual(md.countOf(list, rb.agent), 2);
    assert.strictEqual(X.countsText(f.counts), X.countsText(f.counts));
    assert.strictEqual(X.frameOf(f).counts.questions, q);
  }));
});

test('PROPERTY: every frame the host can send is either refused or yields a look whose badge fits its state, and a tabFor it can explain', () => {
  const states = fc.constantFrom('sleeping', 'working', 'happy', 'stressed', 'inactive', 'weird');
  const details = fc.constantFrom('sleeping', 'working', 'happy', 'stressed', 'reading', 'writing', 'running', 'waiting', 'stuck', 'helper', 'weird');
  fc.assert(fc.property(states, details, fc.nat(4), (state, detail, panels) => {
    const f = X.frameOf(frame({ state, detail, panels }));
    if (f === null) { assert.ok(!['sleeping', 'working', 'happy', 'stressed'].includes(state)); return; }
    const l = X.look(f.state, f.detail);
    assert.strictEqual(l.state, f.state);
    if (l.badge) assert.ok(f.state === 'working' || f.state === 'stressed');
    assert.strictEqual(X.tabFor(f, NAMED), panels > 0 ? 'active' : 'inactive');
  }));
});

// --- the resting state (PR #178 Miguel I4): awake and calm between its work and sleep ----------------------------------------------

test('resting: the host\'s frame may say it, it is drawn awake with no ring or badge, and it sorts after happy and before sleeping', () => {
  assert.deepStrictEqual(X.frameOf(frame({ state: 'resting', detail: 'resting' })).state, 'resting');
  const l = X.look('resting', 'resting');
  assert.deepStrictEqual([l.state, l.detail, l.words, l.badge], ['resting', 'resting', 'resting', null]);
  const rows = ['sleeping', 'resting', 'happy', 'stressed', 'working'].map(s => ({ agent: s, state: s, detail: s }));
  assert.deepStrictEqual(agentStateDisplay.sortRows(rows).map(r => r.agent), ['working', 'stressed', 'happy', 'resting', 'sleeping']);
  assert.strictEqual(X.tabFor(X.frameOf(frame({ state: 'resting', detail: 'resting', panels: 1 })), NAMED), 'active');
});

// --- Ricardo's pick: Active = "docked anywhere" -------------------------------------------------------------------------------------

test('docked: an Ask panel is in the layout (a group, a float, or the rail) unless the layout has it hidden; no layout is unknown, never "hidden"', () => {
  assert.strictEqual(X.docked({ hidden: [] }), true);
  assert.strictEqual(X.docked({ hidden: ['vault', 'ask'] }), false);
  assert.strictEqual(X.docked({ hidden: ['vault'], rail: ['ask'] }), true, 'on the rail still counts');
  assert.strictEqual(X.docked({}), true, 'a layout that lists nothing hidden');
  for (const none of [null, undefined, 7, 'x', []]) assert.strictEqual(X.docked(none), null, String(none));
  assert.strictEqual(X.docked({ hidden: 'ask' }), null, 'a malformed list is unknown');
});
