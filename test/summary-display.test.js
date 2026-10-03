'use strict';
/**
 * The where-are-we summary's display rules (app/summary-display.js, backlog #39 job 1, DESIGN_SLAVE_MODE_SUMMARY.md
 * decision 4). Pure: the page only paints what these say.
 *
 *   - Switching to a tab untouched for 10 minutes or more opens the panel, until the first keystroke or 30 s.
 *     Click pins it open; Esc closes.
 *   - It is always labelled "local model - llama3.2:3b - 4 min ago": never mistaken for Claude's words.
 *   - A summary read back from before a restart is dimmed; Ollama or the model missing is SAID, beside the last summary.
 *   - Absence is never a value: no summary and nothing wrong is no panel, an unknown time is "unknown", not zero.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/summary-display');

const MIN = 60_000;
const NOW = 10_000_000;
const SUMMARY = { text: 'Working on: the drawer\nWhere it stands: reading it\nNext: fix it', model: 'llama3.2:3b', at: NOW - 4 * MIN, stale: false };
const OFF_DOWN = { reason: 'ollama-down', model: 'llama3.2:3b' };

test('the design constants: 10 minutes untouched, 30 seconds open', () => {
  assert.strictEqual(D.UNTOUCHED_MS, 10 * MIN);
  assert.strictEqual(D.SHOW_MS, 30_000);
});

test('ageLabel is the bar\'s own ("4 min ago"), and an unknown time says nothing', () => {
  assert.strictEqual(D.labelOf(SUMMARY, NOW), 'local model · llama3.2:3b · 4 min ago');
  assert.strictEqual(D.labelOf({ ...SUMMARY, at: NOW + 5 * MIN }, NOW), 'local model · llama3.2:3b', 'a clock skew says no age, not a negative one');
});

test('a stale summary says it has not been refreshed', () => {
  assert.strictEqual(D.labelOf({ ...SUMMARY, stale: true }, NOW), 'local model · llama3.2:3b · 4 min ago · not refreshed yet');
});

test('offNote: each way the model can be missing is said plainly, with the fix where there is one', () => {
  assert.strictEqual(D.offNote(OFF_DOWN), "Local summary off: Ollama isn't running");
  assert.strictEqual(D.offNote({ reason: 'model-missing', model: 'llama3.2:3b' }), 'Local summary off: model not installed. Run: ollama pull llama3.2:3b');
  assert.strictEqual(D.offNote({ reason: 'failed', model: 'llama3.2:3b', detail: 'timeout' }), "Local summary: the last try failed (timeout). It'll try again");
  assert.strictEqual(D.offNote(null), null);
  assert.strictEqual(D.offNote({ reason: 'nonsense' }), null);
  assert.strictEqual(D.offNote('x'), null);
});

test('offNote never prints a model name it was not given', () => {
  assert.doesNotMatch(D.offNote({ reason: 'model-missing' }), /undefined|null/);
});

test('hasContent: a summary or a reason there is none; nothing else', () => {
  assert.strictEqual(D.hasContent(SUMMARY, null), true);
  assert.strictEqual(D.hasContent(null, OFF_DOWN), true);
  assert.strictEqual(D.hasContent(null, null), false);
  assert.strictEqual(D.hasContent({ ...SUMMARY, text: '' }, null), false, 'an empty summary is no summary');
  assert.strictEqual(D.hasContent({ ...SUMMARY, at: null }, null), false, 'Number(null) is 0: a missing time is not time zero');
  assert.strictEqual(D.hasContent(undefined, { reason: 'bogus' }), false);
});

test('untouched long enough: 10 minutes exactly counts, 10 minutes less a millisecond does not, unknown counts', () => {
  assert.strictEqual(D.untouchedLongEnough(NOW - 10 * MIN, NOW), true);
  assert.strictEqual(D.untouchedLongEnough(NOW - 10 * MIN + 1, NOW), false);
  assert.strictEqual(D.untouchedLongEnough(null, NOW), true);
  assert.strictEqual(D.untouchedLongEnough(undefined, NOW), true);
  assert.strictEqual(D.untouchedLongEnough(NaN, NOW), true);
  assert.strictEqual(D.untouchedLongEnough(NOW + 5000, NOW), false, 'a touch from the future is a touch');
  assert.strictEqual(D.untouchedLongEnough(NOW - 99 * MIN, null), false, 'no clock, no claim');
});

test('lastTouchedAt: the newest known time; none known is null, never 0', () => {
  assert.strictEqual(D.lastTouchedAt(5, 9, 7), 9);
  assert.strictEqual(D.lastTouchedAt(null, 9, undefined, NaN, '12'), 9);
  assert.strictEqual(D.lastTouchedAt(null, undefined), null);
  assert.strictEqual(D.lastTouchedAt(), null);
});

test('openOnSelect: only with something to say AND a tab untouched for 10 minutes', () => {
  assert.strictEqual(D.openOnSelect({ summary: SUMMARY, off: null, lastInputAt: NOW - 11 * MIN, now: NOW }), true);
  assert.strictEqual(D.openOnSelect({ summary: SUMMARY, off: null, lastInputAt: NOW - 9 * MIN, now: NOW }), false);
  assert.strictEqual(D.openOnSelect({ summary: null, off: null, lastInputAt: NOW - 99 * MIN, now: NOW }), false);
  assert.strictEqual(D.openOnSelect({ summary: null, off: OFF_DOWN, lastInputAt: NOW - 99 * MIN, now: NOW }), true, 'Ollama off with nothing to show is still said');
  assert.strictEqual(D.openOnSelect({ summary: SUMMARY, off: null, lastInputAt: null, now: NOW }), true, 'a tab nobody has typed in this run');
  assert.strictEqual(D.openOnSelect({}), false);
  assert.strictEqual(D.openOnSelect(), false);
});

const open = (over = {}) => ({ summary: SUMMARY, off: null, now: NOW + 5000, openedAt: NOW, pinned: false, typed: false, ...over });

test('panelModel: open for 30 seconds from when it opened, not a millisecond more', () => {
  assert.notStrictEqual(D.panelModel(open({ now: NOW + D.SHOW_MS - 1 })), null);
  assert.strictEqual(D.panelModel(open({ now: NOW + D.SHOW_MS })), null);
});

test('panelModel: the first keystroke hides it', () => {
  assert.strictEqual(D.panelModel(open({ typed: true })), null);
});

test('panelModel: a pinned panel survives typing and the 30 seconds; it is closed by unpinning', () => {
  assert.notStrictEqual(D.panelModel(open({ pinned: true, typed: true, now: NOW + 99 * MIN })), null);
  assert.strictEqual(D.panelModel(open({ pinned: false, typed: true, now: NOW + 99 * MIN })), null);
});

test('panelModel: never opened and not pinned is no panel', () => {
  assert.strictEqual(D.panelModel(open({ openedAt: null })), null);
  assert.strictEqual(D.panelModel(open({ openedAt: undefined })), null);
  assert.strictEqual(D.panelModel(open({ openedAt: NaN })), null);
  assert.strictEqual(D.panelModel(open({ now: null })), null);
});

test('panelModel: nothing to say is no panel, pinned or not', () => {
  assert.strictEqual(D.panelModel(open({ summary: null, off: null })), null);
  assert.strictEqual(D.panelModel(open({ summary: null, off: null, pinned: true })), null);
});

test('panelModel: the lines, the label and nothing dim for a fresh summary', () => {
  assert.deepStrictEqual(D.panelModel(open()), {
    label: 'local model · llama3.2:3b · 4 min ago',
    lines: ['Working on: the drawer', 'Where it stands: reading it', 'Next: fix it'],
    note: null, dim: false, pinned: false,
  });
});

test('panelModel: a stale summary is dimmed', () => {
  const m = D.panelModel(open({ summary: { ...SUMMARY, stale: true } }));
  assert.strictEqual(m.dim, true);
  assert.match(m.label, /not refreshed yet/);
});

test('panelModel: Ollama off keeps the last summary, dimmed, with the note beside it', () => {
  const m = D.panelModel(open({ off: OFF_DOWN }));
  assert.strictEqual(m.dim, true);
  assert.strictEqual(m.note, "Local summary off: Ollama isn't running");
  assert.strictEqual(m.lines.length, 3);
});

test('panelModel: Ollama off and no summary yet is the note alone, never an empty panel', () => {
  const m = D.panelModel(open({ summary: null, off: OFF_DOWN }));
  assert.deepStrictEqual(m.lines, []);
  assert.strictEqual(m.note, "Local summary off: Ollama isn't running");
  assert.strictEqual(m.label, 'local model · llama3.2:3b');
  assert.strictEqual(m.dim, true);
});

test('panelModel: at most five lines, blank lines dropped', () => {
  const m = D.panelModel(open({ summary: { ...SUMMARY, text: 'a\n\n b \n c\nd\ne\nf\ng' } }));
  assert.deepStrictEqual(m.lines, ['a', 'b', 'c', 'd', 'e']);
});

test('hoverLines: the strip\'s hover card carries the same label, then the lines, then any note', () => {
  assert.deepStrictEqual(D.hoverLines(SUMMARY, NOW), [
    "Where we're at (local model · llama3.2:3b · 4 min ago):",
    'Working on: the drawer', 'Where it stands: reading it', 'Next: fix it',
  ]);
  assert.deepStrictEqual(D.hoverLines({ ...SUMMARY, note: "Local summary off: Ollama isn't running" }, NOW).slice(-1), ["Local summary off: Ollama isn't running"]);
  assert.deepStrictEqual(D.hoverLines(null, NOW), []);
  assert.deepStrictEqual(D.hoverLines({ text: '' }, NOW), []);
});

test('property: the panel is open exactly when there is something to say AND (pinned OR opened, untyped, inside 30 s)', () => {
  const t = fc.integer({ min: 0, max: 10 ** 9 });
  fc.assert(fc.property(
    fc.boolean(), fc.boolean(), fc.option(t, { nil: null }), t, fc.boolean(), fc.boolean(),
    (hasSummary, hasOff, openedAt, now, pinned, typed) => {
      const m = D.panelModel({ summary: hasSummary ? { ...SUMMARY, at: 5 } : null, off: hasOff ? OFF_DOWN : null, now, openedAt, pinned, typed });
      const content = hasSummary || hasOff;
      const within = openedAt !== null && !typed && now >= openedAt && now - openedAt < D.SHOW_MS;
      assert.strictEqual(m !== null, content && (pinned || within));
      if (m !== null) {
        assert.ok(m.label.startsWith('local model'), 'always labelled as a local model');
        assert.ok(m.lines.length > 0 || m.note !== null, 'never an empty panel');
        assert.strictEqual(m.pinned, pinned);
      }
    }), { numRuns: 500 });
});

test('property: switching opens the panel only for a tab untouched 10 minutes or more (or never touched)', () => {
  const t = fc.integer({ min: 0, max: 10 ** 9 });
  fc.assert(fc.property(fc.option(t, { nil: null }), t, (touched, now) => {
    const open = D.openOnSelect({ summary: SUMMARY, off: null, lastInputAt: touched, now });
    const expected = touched === null || now - touched >= D.UNTOUCHED_MS;
    assert.strictEqual(open, expected);
  }), { numRuns: 500 });
});

test('property: a summary with markup in its words is only ever text (the painter sets textContent)', () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim() !== ''), (text) => {
    const m = D.panelModel(open({ summary: { ...SUMMARY, text } }));
    assert.ok(m === null || m.lines.every(l => typeof l === 'string'));
  }), { numRuns: 100 });
});
