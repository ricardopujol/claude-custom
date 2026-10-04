'use strict';
/**
 * app/loadout-display.js -- the belt strip and inline picker on a roster card
 * (BACKLOG #17). Pure functions; renderer.js only wires them.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/loadout-display');
const L = require('../host/loadout');

const items = L.catalogue();
const hello = (agents = {}) => ({ type: 'hello', loadout: { agents, items } });
// Only a refusal THIS window asked for is shown (Dexter F6): ask, then answer.
const refuse = (state, over = {}) => D.reduce(
  D.ask(state, { kind: 'equip', agent: over.agentType || 'a', itemId: over.itemId || 'pace-haiku' }),
  frame({ ok: false, ...over }));
const frame = (over = {}) => ({ type: 'loadout', ok: true, reason: null, agentType: 'a', itemId: 'pace-haiku',
  agents: { a: ['pace-haiku'] }, items, ...over });

// --- reduce ------------------------------------------------------------------

test('hello seeds the belts and the catalogue', () => {
  const s = D.reduce(D.emptyState(), hello({ a: ['pace-haiku'] }));
  assert.deepStrictEqual(s.agents.get('a'), ['pace-haiku']);
  assert.strictEqual(s.items.length, items.length);
});

test('a hello with no loadout leaves the state alone rather than blanking the belts', () => {
  const seeded = D.reduce(D.emptyState(), hello({ a: ['pace-haiku'] }));
  assert.strictEqual(D.reduce(seeded, { type: 'hello' }), seeded);
  assert.strictEqual(D.reduce(seeded, { type: 'hello', loadout: null }), seeded);
});

test('a successful frame updates the belts', () => {
  const s = D.reduce(D.reduce(D.emptyState(), hello()), frame());
  assert.deepStrictEqual(s.agents.get('a'), ['pace-haiku']);
  assert.strictEqual(s.error, null);
});

test('a refusal keeps the belts the host reports and records WHICH agent and item it was for', () => {
  const s = refuse(D.reduce(D.emptyState(), hello({ a: ['pace-haiku'] })),
    { reason: 'both set the agent\'s model', itemId: 'pace-opus' });
  assert.deepStrictEqual(s.error, { agentType: 'a', itemId: 'pace-opus', reason: 'both set the agent\'s model' });
  assert.deepStrictEqual(s.agents.get('a'), ['pace-haiku']);
});

test('a refusal with no reason still says something', () => {
  const s = refuse(D.emptyState(), { reason: undefined });
  assert.strictEqual(typeof s.error.reason, 'string');
  assert.ok(s.error.reason.length > 0);
});

test('PR #64 N1: a QUIET frame neither sets nor clears the error line', () => {
  const refused = refuse(D.emptyState(), { reason: 'no' });
  const echoed = D.reduce(refused, frame({ quiet: true, ok: true, agents: { a: ['review-twice'] } }));
  assert.deepStrictEqual(echoed.error, refused.error, 'the refusal must survive an echo');
  assert.deepStrictEqual(echoed.agents.get('a'), ['review-twice'], 'but the echo still refreshes the belts');
  const quietRefusal = D.reduce(D.emptyState(), frame({ quiet: true, ok: false, reason: 'x' }));
  assert.strictEqual(quietRefusal.error, null, 'and a quiet frame never SETS one either');
});

test('F6: a refusal this window did NOT ask for changes nothing on screen', () => {
  // W1 shows its own refusal for X; W2's user makes a conflicting equip on Y.
  // The broadcast must not replace W1's alert, and must not appear as an error
  // in a window whose user never clicked.
  const mine = refuse(D.emptyState(), { agentType: 'x', itemId: 'pace-opus', reason: 'mine' });
  const other = D.reduce(mine, frame({ ok: false, agentType: 'y', itemId: 'pace-opus', reason: 'theirs', agents: { y: ['pace-haiku'] } }));
  assert.deepStrictEqual(other.error, mine.error);
  assert.deepStrictEqual(other.agents.get('y'), ['pace-haiku'], 'but the belts it reports are still applied');
  const cold = D.reduce(D.emptyState(), frame({ ok: false, agentType: 'x', itemId: 'pace-opus', reason: 'theirs' }));
  assert.strictEqual(cold.error, null, 'nothing was asked here, so nothing is shown');
});

test('F6: a refusal must match the item that was asked, not only the agent', () => {
  const asked = D.ask(D.emptyState(), { kind: 'equip', agent: 'x', itemId: 'pace-opus' });
  const wrong = D.reduce(asked, frame({ ok: false, agentType: 'x', itemId: 'pace-sonnet', reason: 'other click' }));
  assert.strictEqual(wrong.error, null);
  const right = D.reduce(asked, frame({ ok: false, agentType: 'x', itemId: 'pace-opus', reason: 'mine' }));
  assert.strictEqual(right.error.reason, 'mine');
});

test('F6: the answer consumes the ask, so a later broadcast of the same refusal is not shown', () => {
  const first = refuse(D.emptyState(), { reason: 'mine' });
  const cleared = D.reduce(first, frame({ ok: true, agentType: 'a', itemId: 'pace-haiku', agents: {} }));
  assert.strictEqual(cleared.error, null);
  const echo = D.reduce(cleared, frame({ ok: false, reason: 'someone else' }));
  assert.strictEqual(echo.error, null);
});

test('F6: ask() ignores anything that is not an equip/unequip action', () => {
  const s = D.emptyState();
  for (const a of [null, undefined, {}, { kind: 'toggle', agent: 'a' }, { kind: 'equip' }, { kind: 'equip', agent: 'a' }]) {
    assert.strictEqual(D.ask(s, a), s, JSON.stringify(a));
  }
});

test('a hello is quiet too: a reattach does not wipe a refusal on screen', () => {
  const refused = refuse(D.emptyState(), { reason: 'no' });
  assert.deepStrictEqual(D.reduce(refused, hello({ a: ['pace-haiku'] })).error, refused.error);
});

test('a success for the SAME agent clears its refusal; for another agent it does not', () => {
  const refused = refuse(D.emptyState(), { reason: 'no' });
  assert.strictEqual(D.reduce(refused, frame({ ok: true, agentType: 'a' })).error, null);
  assert.deepStrictEqual(D.reduce(refused, frame({ ok: true, agentType: 'b', agents: { b: ['pace-opus'] } })).error, refused.error);
});

test('a later refusal replaces an earlier one', () => {
  let s = refuse(D.emptyState(), { reason: 'first' });
  s = refuse(s, { reason: 'second', agentType: 'b' });
  assert.strictEqual(s.error.reason, 'second');
  assert.strictEqual(s.error.agentType, 'b');
});

test('junk frames change nothing and never throw', () => {
  const s = D.emptyState();
  for (const junk of [null, undefined, 7, 'x', [], {}, { type: 'loadout' }, { type: 'nope' },
    { type: 'loadout', agents: 5, items: 'x' }, { type: 'loadout', agents: [] }]) {
    assert.doesNotThrow(() => D.reduce(s, junk), JSON.stringify(junk));
  }
  assert.strictEqual(D.reduce(s, { type: 'nope' }), s);
});

test('a __proto__ agent key from the wire is a plain key, not a prototype write', () => {
  const wire = JSON.parse('{"type":"loadout","ok":true,"agentType":"x","agents":{"__proto__":["pace-haiku"],"ok":["pace-opus"]},"items":[]}');
  const s = D.reduce(D.emptyState(), wire);
  assert.strictEqual(({}).polluted, undefined);
  assert.deepStrictEqual(s.agents.get('ok'), ['pace-opus']);
});

test('the belts are replaced, never merged: an agent that lost its last item disappears', () => {
  let s = D.reduce(D.emptyState(), hello({ a: ['pace-haiku'], b: ['pace-opus'] }));
  s = D.reduce(s, frame({ agents: { b: ['pace-opus'] }, agentType: 'a' }));
  assert.strictEqual(s.agents.has('a'), false);
});

test('reduce never mutates the state it was given', () => {
  const s = D.reduce(D.emptyState(), hello({ a: ['pace-haiku'] }));
  const before = JSON.stringify([...s.agents]);
  D.reduce(s, frame({ agents: {} }));
  assert.strictEqual(JSON.stringify([...s.agents]), before);
});

// --- toggle ------------------------------------------------------------------

test('toggle opens one picker at a time and closes it again', () => {
  let s = D.emptyState();
  s = D.toggle(s, 'a');
  assert.strictEqual(s.open, 'a');
  s = D.toggle(s, 'b');
  assert.strictEqual(s.open, 'b');
  s = D.toggle(s, 'b');
  assert.strictEqual(s.open, null);
});

test('toggling clears a refusal: it was about a picker that is no longer showing', () => {
  const refused = refuse(D.emptyState(), { reason: 'no' });
  assert.strictEqual(D.toggle(refused, 'a').error, null);
});

// --- view --------------------------------------------------------------------

const seeded = (agents = {}) => D.reduce(D.emptyState(), hello(agents));

test('an unequipped agent has an empty strip and a closed picker', () => {
  const v = D.view(seeded(), 'a', {});
  assert.deepStrictEqual(v.equipped, []);
  assert.strictEqual(v.open, false);
  assert.deepStrictEqual(v.rows, [], 'no rows while closed');
});

test('the strip lists what is equipped, by catalogue entry', () => {
  const v = D.view(seeded({ a: ['pace-haiku', 'review-twice'] }), 'a', {});
  assert.deepStrictEqual(v.equipped.map(e => e.id), ['pace-haiku', 'review-twice']);
  assert.strictEqual(v.equipped[0].name, 'Pace: haiku');
  assert.strictEqual(v.equipped[0].glyph, items.find(i => i.id === 'pace-haiku').glyph);
});

test('an id the catalogue does not know is not drawn as an item', () => {
  const v = D.view(seeded({ a: ['pace-haiku', 'gone-item'] }), 'a', {});
  assert.deepStrictEqual(v.equipped.map(e => e.id), ['pace-haiku']);
});

test('an open picker lists every item with the action it would take', () => {
  const s = D.toggle(seeded({ a: ['pace-haiku'] }), 'a');
  const v = D.view(s, 'a', {});
  assert.strictEqual(v.open, true);
  assert.strictEqual(v.rows.length, items.length);
  assert.strictEqual(v.rows.find(r => r.id === 'pace-haiku').action, 'unequip');
  assert.strictEqual(v.rows.find(r => r.id === 'pace-haiku').equipped, true);
  assert.strictEqual(v.rows.find(r => r.id === 'review-twice').action, 'equip');
});

test('a row that would conflict says what it conflicts with, derived from the fields it writes', () => {
  const s = D.toggle(seeded({ a: ['pace-haiku'] }), 'a');
  const v = D.view(s, 'a', {});
  assert.match(v.rows.find(r => r.id === 'pace-opus').hint, /Pace: haiku/);
  assert.strictEqual(v.rows.find(r => r.id === 'review-twice').hint, null);
  assert.strictEqual(v.rows.find(r => r.id === 'pace-haiku').hint, null, 'an item is not in conflict with itself');
});

test('the conflicting row stays clickable so the host\'s refusal is what the user reads', () => {
  const s = D.toggle(seeded({ a: ['pace-haiku'] }), 'a');
  const row = D.view(s, 'a', {}).rows.find(r => r.id === 'pace-opus');
  assert.notStrictEqual(row.disabled, true);
});

test('the picker says it applies to the NEXT run', () => {
  const v = D.view(D.toggle(seeded(), 'a'), 'a', { running: false });
  assert.match(v.note, /next run/i);
  assert.doesNotMatch(v.note, /isn't affected/);
});

test('an agent that is running right now is told its current run is not affected', () => {
  const v = D.view(D.toggle(seeded(), 'a'), 'a', { running: true });
  assert.match(v.note, /current run isn't affected/);
  assert.match(v.note, /next run/i);
});

test('the note is only there while the picker is open', () => {
  assert.strictEqual(D.view(seeded(), 'a', { running: true }).note, null);
});

test('a refusal shows on the agent it was for, and only there', () => {
  const s = D.toggle(refuse(seeded({ a: ['pace-haiku'] }), { reason: 'both set model', itemId: 'pace-opus' }), 'a');
  // toggle cleared it (it is a new picker), so re-send the refusal:
  const refused = refuse(s, { reason: 'both set model', itemId: 'pace-opus' });
  assert.strictEqual(D.view(refused, 'a', {}).error, 'both set model');
  assert.strictEqual(D.view(refused, 'b', {}).error, null);
});

test('view is total over junk agent names and options', () => {
  for (const agent of [undefined, null, 5, '', '__proto__', 'constructor']) {
    assert.doesNotThrow(() => D.view(seeded(), agent, null));
  }
  assert.doesNotThrow(() => D.view(null, 'a', {}));
});

// --- html --------------------------------------------------------------------

test('the belt control is a real <button>: a control inside a card must never open the card', () => {
  const html = D.html(D.view(seeded(), 'a', {}));
  assert.match(html, /<button[^>]*data-loadout-toggle="a"/);
  assert.match(html, /type="button"/);
});

test('every picker row control is a <button> too, and carries what the click needs', () => {
  const html = D.html(D.view(D.toggle(seeded({ a: ['pace-haiku'] }), 'a'), 'a', {}));
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.strictEqual(buttons.length, 1 + items.length);
  assert.match(html, /data-loadout-act="unequip"[^>]*data-loadout-agent="a"[^>]*data-loadout-item="pace-haiku"/);
  assert.match(html, /data-loadout-act="equip"[^>]*data-loadout-agent="a"[^>]*data-loadout-item="review-twice"/);
  assert.doesNotMatch(html, /<a\b|onclick=/i);
});

test('the strip draws each equipped glyph and name', () => {
  const html = D.html(D.view(seeded({ a: ['review-twice'] }), 'a', {}));
  assert.ok(html.includes('Method: review twice'));
  assert.ok(html.includes(items.find(i => i.id === 'review-twice').glyph));
});

test('the open picker draws the note, and the refusal when there is one', () => {
  const base = D.toggle(seeded({ a: ['pace-haiku'] }), 'a');
  assert.match(D.html(D.view(base, 'a', { running: true })), /current run isn(&#39;|')t affected/);
  const refused = refuse(base, { reason: 'both set the model', itemId: 'pace-opus' });
  const html = D.html(D.view(refused, 'a', {}));
  assert.match(html, /class="belt-error"[^>]*>[^<]*both set the model/);
});

test('the open picker is a no-card-click region: its note and refusal text do not open the agent log', () => {
  // PR #68's known bug (build log, wave 2): a click on the picker's note or
  // refusal text fell through to the card and opened the agent log, because
  // only <button>s were exempt. agent-log-display.js's cardClickAgent skips
  // anything inside [data-no-card-click], so marking the picker is the whole fix.
  const base = D.toggle(seeded({ a: ['pace-haiku'] }), 'a');
  const refused = refuse(base, { reason: 'both set the model', itemId: 'pace-opus' });
  const html = D.html(D.view(refused, 'a', {}));

  // The picker's REAL attributes, read off the markup (order-independent) ...
  const tag = /<div class="belt-picker"([^>]*)>/.exec(html);
  assert.ok(tag, 'the open picker is drawn');
  const attrs = {};
  for (const m of tag[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] === undefined ? '' : m[2];
  const inside = (cls) => html.indexOf(`class="${cls}"`) > tag.index;
  assert.ok(inside('belt-note') && inside('belt-error'), 'the note and the refusal sit inside the picker');

  // ... composed with the card-click rule itself (Miguel, PR #72): a click on
  // the note must open nothing, and the same click without the picker's
  // attributes WOULD open the log -- so this pins the behaviour, not a string.
  const { cardClickAgent } = require('../app/agent-log-display');
  const el = (cls, parent, a = {}) => {
    const n = { classes: [cls], attrs: a, dataset: {}, parent };
    const hit = (e, sel) => sel.split(',').map(s => s.trim()).some(s =>
      (s.startsWith('.') ? e.classes.includes(s.slice(1)) : s.startsWith('[') ? s.slice(1, -1) in e.attrs : false));
    n.closest = sel => { for (let e = n; e; e = e.parent) if (hit(e, sel)) return e; return null; };
    n.contains = o => { for (let e = o; e; e = e.parent) if (e === n) return true; return false; };
    return n;
  };
  const row = el('agent', null);
  row.dataset.agent = 'a';
  const note = el('belt-note', el('belt-picker', row, attrs));
  assert.strictEqual(cardClickAgent(note), null, 'a click on the note opened the agent log');
  const bareNote = el('belt-note', el('belt-picker', row, {}));
  assert.strictEqual(cardClickAgent(bareNote), 'a', 'control: without the attribute it would have');
});

test('names and reasons from the wire are escaped', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const s = D.toggle(seeded(), evil);
  const refused = refuse(s, { agentType: evil, reason: evil });
  const html = D.html(D.view(refused, evil, {}));
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes(evil), 'the raw string must never appear');
  assert.ok(html.includes('&quot;&gt;&lt;img'), 'it appears escaped');
});

test('nothing equipped and closed: only the button, no empty strip element', () => {
  const html = D.html(D.view(seeded(), 'a', {}));
  assert.doesNotMatch(html, /belt-strip/);
});

// --- availability (Dexter F2, F3) ------------------------------------------------------

test('F2: a label row (resolved:false) can never match a subagent_type, so it gets no belt', () => {
  assert.match(D.unavailableReason({ resolved: false }), /label, not an agent type/);
  assert.strictEqual(D.unavailableReason({ resolved: true }), null);
  assert.strictEqual(D.unavailableReason({}), null, 'unknown is not false: only an explicit resolved:false hides it');
});

test('F3: with hooks off nothing can apply, and the belt says so', () => {
  assert.match(D.unavailableReason({ hooks: false }), /hooks are off/i);
  assert.strictEqual(D.unavailableReason({ hooks: true }), null);
  assert.strictEqual(D.unavailableReason({ hooks: undefined }), null, 'before the first hello nothing is claimed');
  assert.strictEqual(D.unavailableReason(null), null);
});

test('an unavailable card has no button and no picker row, only the reason', () => {
  const reason = D.unavailableReason({ resolved: false });
  const open = D.toggle(seeded(), 'miguel-usage');                  // even if a picker was open
  const v = D.view(open, 'miguel-usage', { unavailable: reason });
  assert.strictEqual(v.unavailable, reason);
  assert.strictEqual(v.open, false);
  assert.deepStrictEqual(v.rows, []);
  const html = D.html(v);
  assert.doesNotMatch(html, /<button|data-loadout-/);
  assert.match(html, /class="belt-off"/);
  assert.ok(html.includes('label, not an agent type'));
});

test('an unavailable card that already has items still shows the strip', () => {
  const v = D.view(seeded({ a: ['pace-haiku'] }), 'a', { unavailable: D.unavailableReason({ hooks: false }) });
  assert.match(D.html(v), /belt-strip/);
  assert.doesNotMatch(D.html(v), /<button/);
});

test('an available card is unchanged: unavailable is null', () => {
  assert.strictEqual(D.view(seeded(), 'a', {}).unavailable, null);
});

// --- accessibility (Miguel S1) ---------------------------------------------------------

test('S1: every toggle names its agent, rows expose pressed state, glyphs are hidden from readers', () => {
  const html = D.html(D.view(D.toggle(seeded({ a: ['pace-haiku'] }), 'a'), 'a', {}));
  assert.match(html, /data-loadout-toggle="a"[^>]*aria-label="Tool belt for a"/);
  assert.match(html, /data-loadout-item="pace-haiku"[^>]*aria-pressed="true"/);
  assert.match(html, /data-loadout-item="review-twice"[^>]*aria-pressed="false"/);
  const glyphs = html.match(/<span class="belt-glyph"[^>]*>/g) || [];
  assert.ok(glyphs.length > 0);
  for (const g of glyphs) assert.match(g, /aria-hidden="true"/);
});

test('S1: the aria-label is escaped like everything else from the wire', () => {
  const evil = '"><b>';
  const html = D.html(D.view(seeded(), evil, {}));
  assert.ok(!html.includes('aria-label="Tool belt for "><b>'));
  assert.ok(html.includes('aria-label="Tool belt for &quot;&gt;&lt;b&gt;"'));
});

// --- click decoding ---------------------------------------------------------------

test('clickAction decodes a toggle, an equip and an unequip from a dataset', () => {
  assert.deepStrictEqual(D.clickAction({ loadoutToggle: 'a' }), { kind: 'toggle', agent: 'a' });
  assert.deepStrictEqual(D.clickAction({ loadoutAct: 'equip', loadoutAgent: 'a', loadoutItem: 'pace-haiku' }),
    { kind: 'equip', agent: 'a', itemId: 'pace-haiku' });
  assert.deepStrictEqual(D.clickAction({ loadoutAct: 'unequip', loadoutAgent: 'a', loadoutItem: 'pace-haiku' }),
    { kind: 'unequip', agent: 'a', itemId: 'pace-haiku' });
});

test('clickAction ignores anything else, and an incomplete action', () => {
  for (const ds of [null, undefined, {}, { loadoutAct: 'zap', loadoutAgent: 'a', loadoutItem: 'x' },
    { loadoutAct: 'equip', loadoutAgent: 'a' }, { loadoutAct: 'equip', loadoutItem: 'x' }, { loadoutToggle: '' }]) {
    assert.strictEqual(D.clickAction(ds), null, JSON.stringify(ds));
  }
});

test('the control messages are exactly what host/control.js and loadout-control.js expect', () => {
  assert.deepStrictEqual(D.controlMessage({ kind: 'equip', agent: 'a', itemId: 'pace-haiku' }),
    { type: 'loadout-equip', agentType: 'a', itemId: 'pace-haiku' });
  assert.deepStrictEqual(D.controlMessage({ kind: 'unequip', agent: 'a', itemId: 'pace-haiku' }),
    { type: 'loadout-unequip', agentType: 'a', itemId: 'pace-haiku' });
  assert.strictEqual(D.controlMessage({ kind: 'toggle', agent: 'a' }), null);
  const { CONTROL_TYPES } = require('../host/control');
  assert.ok(CONTROL_TYPES.has(D.controlMessage({ kind: 'equip', agent: 'a', itemId: 'x' }).type));
});

// --- properties ---------------------------------------------------------------------

test('PROPERTY: reduce and view are total over arbitrary frames', () => {
  const anyJson = fc.jsonValue();
  fc.assert(fc.property(anyJson, anyJson, (a, b) => {
    let s = D.emptyState();
    for (const m of [a, b, { type: 'loadout', ok: false, reason: 5, agents: a, items: b }, { type: 'hello', loadout: a }]) {
      s = D.reduce(s, m);
    }
    D.html(D.view(D.toggle(s, 'x'), 'x', { running: true }));
  }), { numRuns: 200 });
});

test('PROPERTY: a quiet frame never changes the error, whatever it carries', () => {
  fc.assert(fc.property(fc.jsonValue(), fc.boolean(), (agents, ok) => {
    const refused = refuse(D.emptyState(), { reason: 'kept' });
    const after = D.reduce(refused, { type: 'loadout', quiet: true, ok, agents, items, agentType: 'a', reason: 'other' });
    assert.deepStrictEqual(after.error, refused.error);
  }), { numRuns: 200 });
});
