'use strict';
/**
 * The indexing assistant's display decisions (app/indexing-display.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md pick 1
 * (A: a strip field that files, Undo in a toast), the accuracy gate's propose mode, and "Claude's call" 4, 5, 6 and 9).
 * Pure: what the counter says, where a note went in words, why one waits, the picker's options, the toast and the list.
 */
const test = require('node:test');
const assert = require('node:assert');

const d = require('../app/indexing-display');

// --- the counter -----------------------------------------------------------------------------------------------------

test('counterText: "N filed", and what still waits or needs a place, never a waiting note counted as filed', () => {
  assert.strictEqual(d.counterText({ filed: 3, waiting: 0, asking: 0 }), '3 filed');
  assert.strictEqual(d.counterText({ filed: 0, waiting: 1, asking: 0 }), '1 waiting');
  assert.strictEqual(d.counterText({ filed: 2, waiting: 1, asking: 2 }), '2 filed · 1 waiting · 2 to place');
  assert.strictEqual(d.counterText({ filed: 0, waiting: 0, asking: 1 }), '1 to place');
  assert.strictEqual(d.counterText({ filed: 0, waiting: 0, asking: 0 }), '0 filed');
});

test('counterText: counts that are not numbers are not drawn as numbers', () => {
  assert.strictEqual(d.counterText(null), '0 filed');
  assert.strictEqual(d.counterText({ filed: null, waiting: '2', asking: undefined }), '0 filed');
});

// --- where a note went -----------------------------------------------------------------------------------------------

test('placeText: a new item with its number, an addition to #N, the history with its kind', () => {
  assert.strictEqual(d.placeText({ target: 'new', n: 72, title: 'Glow' }), 'New backlog item #72');
  assert.strictEqual(d.placeText({ target: 66, n: 66 }), 'Added to #66');
  assert.strictEqual(d.placeText({ target: 'history', kind: 'learning' }), 'History · learning');
  assert.strictEqual(d.placeText({ target: 'new' }), 'New backlog item');
  assert.strictEqual(d.placeText(null), '');
});

test('reasonText: why a note waits, in words; an unknown reason still says it waits', () => {
  assert.strictEqual(d.reasonText('ollama-down'), "Ollama isn't answering");
  assert.strictEqual(d.reasonText('battery'), 'On battery');
  assert.strictEqual(d.reasonText('busy'), 'The local model is busy');
  assert.strictEqual(d.reasonText('no-backlog'), 'This project has no backlog file');
  assert.strictEqual(d.reasonText(null), 'Filing…');
  assert.strictEqual(d.reasonText('something-new'), 'Waiting');
});

// --- the picker ------------------------------------------------------------------------------------------------------

const TITLES = { 61: 'Wand buttons run the skill', 63: 'A resource panel', 66: 'The indexing assistant' };

test('pickerOptions: the guess first, then a new item, the closest items, and the history (decision, learning)', () => {
  const row = { state: 'asking', guess: { kind: 'idea', target: 63, title: null, sure: true }, options: [63, 61, 66] };
  const opts = d.pickerOptions(row, TITLES);
  assert.deepStrictEqual(opts.map(o => o.value), ['63', 'new', '61', '66', 'history:decision', 'history:learning']);
  assert.strictEqual(opts[0].label, '#63 A resource panel');
  assert.strictEqual(opts[0].guess, true);
  assert.strictEqual(opts.filter(o => o.guess).length, 1);
});

test('pickerOptions: a history guess is first with its kind; a new-item guess carries its title', () => {
  const h = d.pickerOptions({ guess: { kind: 'learning', target: 'history' }, options: [61] }, TITLES);
  assert.deepStrictEqual(h.map(o => o.value), ['history:learning', 'new', '61', 'history:decision']);
  const n = d.pickerOptions({ guess: { kind: 'bug', target: 'new', title: 'Tabs flicker' }, options: [] }, TITLES);
  assert.strictEqual(n[0].value, 'new');
  assert.strictEqual(n[0].label, 'New backlog item: Tabs flicker');
});

test('pickerOptions: no guess (the kind was unreadable) starts at a new item; an item with no known title shows its number', () => {
  const o = d.pickerOptions({ guess: { kind: null, target: null }, options: [99] }, TITLES);
  assert.deepStrictEqual(o.map(x => x.value), ['new', '99', 'history:decision', 'history:learning']);
  assert.strictEqual(o[1].label, '#99');
  assert.ok(o.every(x => x.guess !== true));
});

test('pickerOptions for Move: the place it is already in is left out', () => {
  const row = { state: 'filed', where: { target: 61, kind: 'idea', n: 61 }, guess: { kind: 'idea', target: 61 }, options: [61, 63] };
  assert.deepStrictEqual(d.pickerOptions(row, TITLES, { moving: true }).map(o => o.value), ['new', '63', 'history:decision', 'history:learning']);
  const hist = { state: 'filed', where: { target: 'history', kind: 'decision' }, options: [] };
  assert.deepStrictEqual(d.pickerOptions(hist, TITLES, { moving: true }).map(o => o.value), ['new', 'history:learning']);
});

test('choiceOf: a picker value back into a choice for the service; anything else is null', () => {
  assert.deepStrictEqual(d.choiceOf('new'), { target: 'new' });
  assert.deepStrictEqual(d.choiceOf('63'), { target: 63 });
  assert.deepStrictEqual(d.choiceOf('history:learning'), { target: 'history', kind: 'learning' });
  for (const v of ['', 'history:idea', '0', '-3', '6.5', 'x', null, 7]) assert.strictEqual(d.choiceOf(v), null, String(v));
});

// --- the toast -------------------------------------------------------------------------------------------------------

test('toastModel: a note just typed is filing; one that waits says why and that it files when it can', () => {
  assert.deepStrictEqual(d.toastModel({ state: 'waiting', reason: null, text: 'x' }), { kind: 'filing', text: 'x', line: 'Filing…' });
  assert.deepStrictEqual(d.toastModel({ state: 'waiting', reason: 'battery', text: 'x' }),
    { kind: 'waiting', text: 'x', line: 'Waiting: On battery. It files when it can.' });
});

test('toastModel: filed shows where, with Undo only while Undo is still exact', () => {
  const t = d.toastModel({ state: 'filed', text: 'x', where: { target: 66, n: 66 }, undoable: true });
  assert.deepStrictEqual(t, { kind: 'filed', text: 'x', line: 'Filed: Added to #66', undo: true, move: true });
  assert.strictEqual(d.toastModel({ state: 'filed', text: 'x', where: { target: 66, n: 66 }, undoable: false }).undo, false);
});

test('toastModel: asking (propose mode, or not sure) asks where, with the guess named', () => {
  const t = d.toastModel({ state: 'asking', text: 'x', guess: { kind: 'idea', target: 63 }, options: [63] }, TITLES);
  assert.strictEqual(t.kind, 'asking');
  assert.strictEqual(t.line, 'Where should this go? Best guess: #63 A resource panel');
  const none = d.toastModel({ state: 'asking', text: 'x', guess: { kind: null, target: null }, options: [] }, TITLES);
  assert.strictEqual(none.line, 'Where should this go?');
});

test('toastModel: undone, and an Undo that could not happen (names the file, offers to open it)', () => {
  assert.deepStrictEqual(d.toastModel({ state: 'undone', text: 'x' }), { kind: 'undone', text: 'x', line: 'Undone. Nothing was kept.' });
  assert.deepStrictEqual(d.resultToast({ ok: false, reason: 'changed', file: 'C:\\p\\documentation\\P_BACKLOG.md' }),
    { kind: 'cant-undo', line: "Can't undo: P_BACKLOG.md changed since. Open it?", open: 'C:\\p\\documentation\\P_BACKLOG.md' });
  assert.deepStrictEqual(d.resultToast({ ok: false, reason: 'no-item' }), { kind: 'error', line: "Couldn't file it: that item isn't in the backlog any more." });
  assert.strictEqual(d.resultToast({ ok: true }), null);
});

test('toastMs: a filed note shows 10 s, undone 2.5 s, asking and waiting stay until dealt with', () => {
  assert.strictEqual(d.toastMs('filed'), 10_000);
  assert.strictEqual(d.toastMs('undone'), 2_500);
  assert.strictEqual(d.toastMs('asking'), null);
  assert.strictEqual(d.toastMs('filing'), null);
  assert.strictEqual(d.toastMs('waiting'), 10_000);
});

// --- the list --------------------------------------------------------------------------------------------------------

test('listRow: the text, the time, and the state in words', () => {
  const at = new Date(2026, 9, 5, 9, 7).getTime();
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'filed', where: { target: 'new', n: 72 }, undoable: true }),
    { text: 't', time: '09:07', where: 'New backlog item #72', undo: true, move: true, pick: false });
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'undone', where: { target: 61, n: 61 } }),
    { text: 't', time: '09:07', where: 'Undone', undo: false, move: false, pick: false });
  assert.deepStrictEqual(d.listRow({ text: 't', at, state: 'asking', guess: {}, options: [] }),
    { text: 't', time: '09:07', where: 'Needs a place', undo: false, move: false, pick: true });
  assert.strictEqual(d.listRow({ text: 't', at, state: 'waiting', reason: 'ollama-down' }).where, "Waiting: Ollama isn't answering");
  assert.strictEqual(d.listRow({ text: 't', at: null, state: 'waiting' }).time, '');
});

test('short: a long note is cut for one line, never mid surrogate pair', () => {
  assert.strictEqual(d.short('abc', 64), 'abc');
  assert.strictEqual(d.short('x'.repeat(70), 64).length, 64);
  assert.ok(d.short('x'.repeat(70), 64).endsWith('…'));
  const s = d.short('a'.repeat(62) + '😀😀', 64);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(s));
});
