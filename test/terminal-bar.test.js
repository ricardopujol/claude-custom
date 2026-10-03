'use strict';
/**
 * The terminal bar's decisions (app/terminal-bar.js, backlog #49 + #52, DESIGN_TERMINAL_BAR.md). The page only
 * paints these. Hand-written cases pin the rules; the properties state them over generated buffers and times.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const T = require('../app/terminal-bar');

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;
const prompt = (extra = {}) => ({ text: 'fix the drawer', at: NOW - 4 * MIN, seq: 3, ...extra });
const view = (extra = {}) => ({ viewportY: 100, bufferLength: 300, full: false, epoch: 0, ...extra });
const anchorAt = (line, extra = {}) => ({ seq: 3, line, epoch: 0, ...extra });

// --- makeAnchor -------------------------------------------------------------------------------------------

test('makeAnchor: the line the CLI is echoing at is baseY + cursorY, tied to that prompt and epoch', () => {
  assert.deepStrictEqual(T.makeAnchor(prompt(), { baseY: 40, cursorY: 7, epoch: 2 }), { seq: 3, line: 47, epoch: 2 });
  assert.deepStrictEqual(T.makeAnchor(prompt(), { baseY: 0, cursorY: 0 }), { seq: 3, line: 0, epoch: 0 }, 'line 0 is a real line');
});

test('makeAnchor: anything the buffer can\'t say is no anchor (null), never a made-up line', () => {
  for (const bad of [{ baseY: NaN, cursorY: 1 }, { baseY: 1, cursorY: undefined }, { baseY: null, cursorY: 1 }, { baseY: -1, cursorY: 0 },
    { baseY: 0, cursorY: -1 }, { baseY: '3', cursorY: 1 }, {}]) {
    assert.strictEqual(T.makeAnchor(prompt(), bad), null, JSON.stringify(bad));
  }
  for (const bad of [null, undefined, {}, { seq: 'x' }, { seq: NaN }]) assert.strictEqual(T.makeAnchor(bad, { baseY: 1, cursorY: 1 }), null);
  assert.strictEqual(T.makeAnchor(prompt(), undefined), null);
});

// --- scrolledAway -----------------------------------------------------------------------------------------

test('the prompt is due only once its line is above the top of the viewport', () => {
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), view({ viewportY: 51 })), true, 'one row past: gone from the top');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), view({ viewportY: 50 })), false, 'on the first visible row: still on screen');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), view({ viewportY: 10 })), false, 'scrolled back up to it: hides again');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(0), view({ viewportY: 1 })), true, 'line 0 is a real line too');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(0), view({ viewportY: 0 })), false);
});

test('no prompt: never due, whatever the buffer says', () => {
  for (const none of [null, undefined, {}, { seq: 'x' }, { text: 'x' }]) assert.strictEqual(T.scrolledAway(none, anchorAt(1), view({ viewportY: 99 })), false);
});

test('FAILS VISIBLE: a prompt that was never anchored, or anchored to another prompt, shows', () => {
  for (const a of [null, undefined, {}, anchorAt(50, { seq: 2 }), anchorAt(50, { seq: undefined }), 'x', 5]) {
    assert.strictEqual(T.scrolledAway(prompt(), a, view({ viewportY: 0 })), true, JSON.stringify(a));
  }
});

test('FAILS VISIBLE: another epoch (a resize reflowed the lines, a /clear moved them) shows', () => {
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), view({ viewportY: 0, epoch: 1 })), true);
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50, { epoch: 4 }), view({ viewportY: 0, epoch: 4 })), false, 'the same epoch is trusted');
});

test('FAILS VISIBLE: a line outside the buffer, or a buffer that is trimming from the top, shows', () => {
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(300), view({ viewportY: 0, bufferLength: 300 })), true, 'one past the last line');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(299), view({ viewportY: 0, bufferLength: 300 })), false, 'the last line is inside');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(-1), view({ viewportY: 0 })), true);
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), view({ viewportY: 0, full: true })), true, 'scrollback is full: every line has moved');
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), view({ viewportY: 0, full: false })), false);
});

test('FAILS VISIBLE: numbers that aren\'t numbers (Number(null) is 0, so null is checked, not coerced)', () => {
  for (const v of [null, undefined, {}, view({ viewportY: null }), view({ viewportY: NaN }), view({ viewportY: '5' }), view({ bufferLength: null }),
    view({ bufferLength: undefined }), view({ bufferLength: Infinity })]) {
    assert.strictEqual(T.scrolledAway(prompt(), anchorAt(50), v), true, JSON.stringify(v));
  }
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(NaN), view({ viewportY: 0 })), true);
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(null), view({ viewportY: 0 })), true, 'a null line is not line 0');
});

const arb = {
  line: fc.integer({ min: 0, max: 400 }),
  vy: fc.integer({ min: 0, max: 400 }),
  len: fc.integer({ min: 1, max: 500 }),
};

test('property: with a valid anchor the prompt is due exactly when viewportY > line', () => {
  fc.assert(fc.property(arb.line, arb.vy, arb.len, (line, vy, len) => {
    fc.pre(line < len);
    return T.scrolledAway(prompt(), anchorAt(line), view({ viewportY: vy, bufferLength: len })) === (vy > line);
  }));
});

test('property: scrolling DOWN never hides a due prompt, scrolling UP never shows a hidden one (monotone in viewportY)', () => {
  fc.assert(fc.property(arb.line, arb.vy, arb.vy, arb.len, (line, a, b, len) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const at = (vy) => T.scrolledAway(prompt(), anchorAt(line), view({ viewportY: vy, bufferLength: len }));
    return !at(lo) || at(hi);
  }));
});

test('property: an invalid anchor ALWAYS shows, wherever the viewport is', () => {
  const bad = fc.oneof(
    fc.constant(null), fc.constant(undefined),
    arb.line.map(l => anchorAt(l, { seq: 99 })),
    arb.line.map(l => anchorAt(l, { epoch: 7 })),
    fc.integer({ min: -50, max: -1 }).map(l => anchorAt(l)),
    fc.constant(anchorAt(NaN)),
  );
  fc.assert(fc.property(bad, arb.vy, arb.len, (a, vy, len) => T.scrolledAway(prompt(), a, view({ viewportY: vy, bufferLength: len })) === true));
});

test('property: a full buffer or a line past the end shows, wherever the viewport is', () => {
  fc.assert(fc.property(arb.line, arb.vy, arb.len, (line, vy, len) => {
    const past = T.scrolledAway(prompt(), anchorAt(line + len), view({ viewportY: vy, bufferLength: len }));
    const full = T.scrolledAway(prompt(), anchorAt(Math.min(line, len - 1)), view({ viewportY: vy, bufferLength: len, full: true }));
    return past === true && full === true;
  }));
});

// --- the prompt part --------------------------------------------------------------------------------------

test('ageLabel: minutes, hours, days; "just now" under a minute; nothing for an unknown or future time', () => {
  assert.strictEqual(T.ageLabel(NOW - 30_000, NOW), 'just now');
  assert.strictEqual(T.ageLabel(NOW, NOW), 'just now');
  assert.strictEqual(T.ageLabel(NOW - MIN, NOW), '1 min ago');
  assert.strictEqual(T.ageLabel(NOW - 59 * MIN, NOW), '59 min ago');
  assert.strictEqual(T.ageLabel(NOW - 60 * MIN, NOW), '1 h ago');
  assert.strictEqual(T.ageLabel(NOW - 23 * 60 * MIN, NOW), '23 h ago');
  assert.strictEqual(T.ageLabel(NOW - 24 * 60 * MIN, NOW), '1 d ago');
  assert.strictEqual(T.ageLabel(NOW - 49 * 60 * MIN, NOW), '2 d ago');
  for (const [at, now] of [[NOW + 1, NOW], [null, NOW], [undefined, NOW], [NaN, NOW], [NOW, null], [NOW, undefined], ['1', NOW], [NOW, Infinity]]) {
    assert.strictEqual(T.ageLabel(at, now), null, `${at} ${now}`);
  }
});

test('promptModel: the first line, whole text for the hover, its age', () => {
  const m = T.promptModel(prompt({ text: 'fix the drawer\nand the hover card' }), NOW);
  assert.deepStrictEqual(m, { head: 'fix the drawer', full: 'fix the drawer\nand the hover card', age: '4 min ago' });
});

test('promptModel: a slash command shows as typed; leading blank lines are skipped; CRLF is a line break', () => {
  assert.strictEqual(T.promptModel(prompt({ text: '/checkpoint' }), NOW).head, '/checkpoint');
  assert.strictEqual(T.promptModel(prompt({ text: '\n\n  later line\nx' }), NOW).head, 'later line');
  assert.strictEqual(T.promptModel(prompt({ text: 'one\r\ntwo' }), NOW).head, 'one');
});

test('promptModel: a long first line is clipped with an ellipsis; a short one never gets one', () => {
  const long = 'a'.repeat(T.PROMPT_HEAD_MAX + 50);
  const m = T.promptModel(prompt({ text: long }), NOW);
  assert.strictEqual(m.head, 'a'.repeat(T.PROMPT_HEAD_MAX) + '…');
  assert.strictEqual(m.full, long, 'the hover has all of it');
  const exact = 'b'.repeat(T.PROMPT_HEAD_MAX);
  assert.strictEqual(T.promptModel(prompt({ text: exact }), NOW).head, exact);
});

test('promptModel: the clip never cuts a character in half', () => {
  const m = T.promptModel(prompt({ text: '\u{1F319}'.repeat(T.PROMPT_HEAD_MAX + 5) }), NOW);
  assert.strictEqual(Array.from(m.head).length, T.PROMPT_HEAD_MAX + 1);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(m.head));
});

test('promptModel: pasted images read [image], in the head and the hover', () => {
  const m = T.promptModel(prompt({ text: 'look at [Image #1] and [image #22]' }), NOW);
  assert.strictEqual(m.head, 'look at [image] and [image]');
  assert.strictEqual(m.full, 'look at [image] and [image]');
  assert.strictEqual(T.promptModel(prompt({ text: '[Image #1]' }), NOW).head, '[image]');
});

test('promptModel: no prompt, no text, blank text: no prompt part; an unknown time says no age, not a wrong one', () => {
  for (const bad of [null, undefined, {}, { text: '' }, { text: '   \n ' }, { text: 5 }, { text: null }]) assert.strictEqual(T.promptModel(bad, NOW), null, JSON.stringify(bad));
  assert.strictEqual(T.promptModel({ text: 'x', at: null }, NOW).age, null);
  assert.strictEqual(T.promptModel({ text: 'x' }, NOW).age, null);
});

test('property: the head is one line, never longer than the cap plus the ellipsis, and the hover keeps every word', () => {
  fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 600 }), (text) => {
    const m = T.promptModel({ text, at: NOW, seq: 1 }, NOW);
    if (text.trim() === '') return m === null;
    return m !== null && !/[\r\n]/.test(m.head) && Array.from(m.head).length <= T.PROMPT_HEAD_MAX + 1 && m.head.trim() !== ''
      && m.full === text.replace(/\[Image #\d+\]/gi, '[image]').trim();
  }));
});

// --- the chips --------------------------------------------------------------------------------------------

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const night = (extra = {}) => ({ startedAt: NOW - 3 * 60 * MIN, nextWakeAt: NOW + 25 * MIN, awake: false, wakes: 4, lastWakeAt: NOW - 5 * MIN, prs: 3, ...extra });

test('bedtimeChip: the moon, the next wake as a clock time, and the PRs so far', () => {
  const c = T.bedtimeChip(night(), NOW);
  assert.strictEqual(c.kind, 'bedtime');
  assert.strictEqual(c.short, `🌙 overnight · next wake ${hhmm(NOW + 25 * MIN)} · 3 PRs`);
  assert.strictEqual(c.long, [`overnight run since ${hhmm(NOW - 180 * MIN)}`, `next wake ${hhmm(NOW + 25 * MIN)}`, '4 wakes so far', '3 PRs so far'].join('\n'));
  assert.strictEqual(c.warn, false);
});

test('bedtimeChip: one PR is singular, one wake is singular, no wakes yet says nothing about wakes', () => {
  assert.match(T.bedtimeChip(night({ prs: 1 }), NOW).short, /· 1 PR$/);
  assert.match(T.bedtimeChip(night({ wakes: 1 }), NOW).long, /\n1 wake so far\n/);
  assert.doesNotMatch(T.bedtimeChip(night({ wakes: 0 }), NOW).long, /wake so far|wakes so far/);
  assert.match(T.bedtimeChip(night({ prs: 0 }), NOW).short, /· 0 PRs$/, 'a real zero is shown as a zero');
});

test('bedtimeChip: an unknown PR count is "PRs: ?", never 0', () => {
  for (const prs of [null, undefined, NaN, -1, 1.5, '3']) {
    const c = T.bedtimeChip(night({ prs }), NOW);
    assert.match(c.short, /· PRs: \?$/, String(prs));
    assert.match(c.long, /PRs so far: unknown$/, String(prs));
    assert.doesNotMatch(c.short, /\b0 PRs\b/);
  }
});

test('bedtimeChip: awake with no wake scheduled says working; a wake in the past says due; no time says nothing', () => {
  assert.match(T.bedtimeChip(night({ awake: true, nextWakeAt: null }), NOW).short, /^🌙 overnight · working · 3 PRs$/);
  assert.match(T.bedtimeChip(night({ awake: true, nextWakeAt: null }), NOW).long, /awake now, working/);
  assert.match(T.bedtimeChip(night({ nextWakeAt: NOW - MIN }), NOW).short, new RegExp(`wake due ${hhmm(NOW - MIN)}`));
  assert.strictEqual(T.bedtimeChip(night({ nextWakeAt: NOW }), NOW).short.includes('wake due'), true, 'due exactly now');
  assert.strictEqual(T.bedtimeChip(night({ awake: false, nextWakeAt: null }), NOW).short, '🌙 overnight · 3 PRs');
});

test('bedtimeChip: no night, or a payload with no start, is no chip', () => {
  for (const bad of [null, undefined, {}, 4, 'x', { startedAt: null }, { startedAt: NaN }, { startedAt: '5' }]) assert.strictEqual(T.bedtimeChip(bad, NOW), null, JSON.stringify(bad));
});

test('occupancyChip: the initials, the +n, the hover lines, the warning colour and the jump', () => {
  const c = T.occupancyChip({ tags: ['EP', 'LR'], more: 2, warn: true, lines: ['electron-pro · from develop · 4 min', "this tab's own session is writing too"],
    jump: { label: 'Jump to develop', root: 'C:/p/dev' } });
  assert.deepStrictEqual(c, { kind: 'occupancy', short: 'EP LR +2', long: "electron-pro · from develop · 4 min\nthis tab's own session is writing too", warn: true,
    jump: { label: 'Jump to develop', root: 'C:/p/dev' } });
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: ['x'] }).warn, false);
  assert.strictEqual('jump' in T.occupancyChip({ tags: ['EP'], lines: [], jump: null }), false);
  assert.strictEqual('jump' in T.occupancyChip({ tags: ['EP'], lines: [], jump: { label: 'x', root: '' } }), false);
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [], jump: { root: 'C:/p' } }).jump.label, 'Jump to its session');
});

test('occupancyChip: nobody here, or a malformed model, is no chip', () => {
  for (const bad of [null, undefined, {}, [], { tags: [] }, { tags: 'EP' }, { tags: [''] }, { tags: [3, null] }]) assert.strictEqual(T.occupancyChip(bad), null, JSON.stringify(bad));
});

// --- the bar ----------------------------------------------------------------------------------------------

test('barVisible: shown when the prompt is due OR a chip is active; never in focus mode; absent when there is nothing to say', () => {
  const chip = [{ kind: 'bedtime' }];
  assert.strictEqual(T.barVisible({ promptDue: true, chips: [] }), true);
  assert.strictEqual(T.barVisible({ promptDue: false, chips: chip }), true);
  assert.strictEqual(T.barVisible({ promptDue: true, chips: chip }), true);
  assert.strictEqual(T.barVisible({ promptDue: false, chips: [] }), false);
  assert.strictEqual(T.barVisible({ promptDue: true, chips: chip, focusMode: true }), false);
  assert.strictEqual(T.barVisible({}), false);
  assert.strictEqual(T.barVisible(), false);
  assert.strictEqual(T.barVisible({ promptDue: 'yes', chips: 'x' }), false, 'only a real true counts');
});

test('barModel: the prompt scrolled away and a night: one bar, the prompt left, the chips right', () => {
  const m = T.barModel({ prompt: prompt(), anchor: anchorAt(10), view: view({ viewportY: 40 }), now: NOW, bedtime: night(),
    occupancy: { tags: ['EP'], lines: ['x'], warn: false } });
  assert.strictEqual(m.visible, true);
  assert.strictEqual(m.prompt.head, 'fix the drawer');
  assert.deepStrictEqual(m.chips.map(c => c.kind), ['bedtime', 'occupancy']);
});

test('barModel: the prompt still on screen and nothing else active: the bar is absent', () => {
  const m = T.barModel({ prompt: prompt(), anchor: anchorAt(60), view: view({ viewportY: 40 }), now: NOW });
  assert.deepStrictEqual(m, { visible: false, prompt: null, chips: [] });
});

test('barModel: the prompt on screen but a chip active: the bar shows with the chip and WITHOUT the prompt part', () => {
  const m = T.barModel({ prompt: prompt(), anchor: anchorAt(60), view: view({ viewportY: 40 }), now: NOW, bedtime: night() });
  assert.strictEqual(m.visible, true);
  assert.strictEqual(m.prompt, null);
  assert.strictEqual(m.chips.length, 1);
});

test('barModel: no prompt yet, no chips: nothing; a window that attached late (no anchor) shows the prompt it was told', () => {
  assert.strictEqual(T.barModel({ now: NOW }).visible, false);
  const late = T.barModel({ prompt: prompt(), anchor: null, view: view({ viewportY: 0 }), now: NOW });
  assert.strictEqual(late.visible, true);
  assert.strictEqual(late.prompt.head, 'fix the drawer');
});

test('barModel: focus mode hides all of it', () => {
  const m = T.barModel({ prompt: prompt(), anchor: null, now: NOW, bedtime: night(), focusMode: true });
  assert.strictEqual(m.visible, false);
});

test('property: the bar is visible exactly when (the prompt is due or a chip is active) and focus mode is off', () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), arb.line, arb.vy, (hasPrompt, hasNight, hasOcc, focus, line, vy) => {
    const p = hasPrompt ? prompt() : null;
    const m = T.barModel({
      prompt: p, anchor: anchorAt(line), view: view({ viewportY: vy, bufferLength: 500 }), now: NOW,
      bedtime: hasNight ? night() : null, occupancy: hasOcc ? { tags: ['EP'], lines: [] } : null, focusMode: focus,
    });
    const due = hasPrompt && vy > line;
    return m.visible === (!focus && (due || hasNight || hasOcc)) && (m.prompt !== null) === (due && !focus);
  }));
});

test('property: the prompt part is present only when the bar is visible', () => {
  fc.assert(fc.property(fc.boolean(), arb.line, arb.vy, fc.boolean(), (hasPrompt, line, vy, focus) => {
    const m = T.barModel({ prompt: hasPrompt ? prompt() : null, anchor: anchorAt(line), view: view({ viewportY: vy, bufferLength: 500 }), now: NOW, focusMode: focus });
    return m.prompt === null || m.visible === true;
  }));
});

// --- found by mutation testing -------------------------------------------------------------------------------
test('a line below the buffer\'s start is not a place, even for a viewport that is somehow above it', () => {
  assert.strictEqual(T.scrolledAway(prompt(), anchorAt(-1), view({ viewportY: -5 })), true);
});

test('promptModel: surrounding whitespace never reaches the head or the hover', () => {
  assert.deepStrictEqual(T.promptModel(prompt({ text: '  hello  ' }), NOW), { head: 'hello', full: 'hello', age: '4 min ago' });
  assert.strictEqual(T.promptModel(prompt({ text: 'abc   \nsecond' }), NOW).head, 'abc', 'trailing blanks on the first line');
  assert.strictEqual(T.promptModel(prompt({ text: '   \nsecond' }), NOW).head, 'second', 'a blank first line is skipped');
});

test('bedtimeChip: the hover says how many PRs, in the singular too, and a real zero as a zero', () => {
  assert.match(T.bedtimeChip(night({ prs: 0 }), NOW).long, /\n0 PRs so far$/);
  assert.match(T.bedtimeChip(night({ prs: 1 }), NOW).long, /\n1 PR so far$/);
  assert.match(T.bedtimeChip(night({ prs: 12 }), NOW).long, /\n12 PRs so far$/);
});

test('bedtimeChip: a start time no clock can show still leaves the chip, with the plain heading', () => {
  const c = T.bedtimeChip(night({ startedAt: 8.64e15 + 1 }), NOW);
  assert.strictEqual(c.long.split('\n')[0], 'overnight run');
});

test('occupancyChip: +n only for a real positive integer count', () => {
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [], more: 0 }).short, 'EP');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [] }).short, 'EP');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [], more: -1 }).short, 'EP');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [], more: 2.5 }).short, 'EP');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [], more: '3' }).short, 'EP');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: [], more: 1 }).short, 'EP +1');
});

test('occupancyChip: only real strings reach the hover, and no lines is an empty hover', () => {
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: ['a', null, 5, '', 'b'] }).long, 'a\nb');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'] }).long, '');
  assert.strictEqual(T.occupancyChip({ tags: ['EP'], lines: 'a' }).long, '');
});

test('barModel: a prompt with no showable text never opens a bar on its own', () => {
  const m = T.barModel({ prompt: { text: '   ', seq: 3, at: NOW }, anchor: null, view: view(), now: NOW });
  assert.deepStrictEqual(m, { visible: false, prompt: null, chips: [] });
});
