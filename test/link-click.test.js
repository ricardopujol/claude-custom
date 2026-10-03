'use strict';
/**
 * Which clicks on a terminal link open it, and what the hover line says
 * (fix/terminal-links, PR #81 Dexter F1 + F2).
 *
 * xterm 5.5's Linkifier calls the link handler on EVERY mouseup over a link,
 * whatever the button and however many clicks: without a filter, a
 * double-click opened two browser tabs and a right-click opened one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { shouldOpen, targetText, refusedText, REPEAT_MS } = require('../app/link-click');

const U = 'https://github.com/ricardopujol/claude-custom/pull/81';
const left = (detail = 1) => ({ button: 0, detail });

test('a plain left click opens the link and remembers it', () => {
  const r = shouldOpen(left(), U, null, 1000);
  assert.deepStrictEqual(r, { open: true, last: { uri: U, at: 1000 } });
});

test('the second mouseup of a double-click does not open it again', () => {
  const first = shouldOpen(left(1), U, null, 1000);
  const second = shouldOpen(left(2), U, first.last, 1150);
  assert.strictEqual(second.open, false);
  assert.deepStrictEqual(second.last, first.last, 'nothing new is remembered');
});

test('right and middle clicks never open a link', () => {
  for (const button of [1, 2, 3, 4]) assert.strictEqual(shouldOpen({ button, detail: 1 }, U, null, 0).open, false, `button ${button}`);
});

test('the same link clicked again within REPEAT_MS opens once; after it, again', () => {
  const a = shouldOpen(left(), U, null, 1000);
  assert.strictEqual(shouldOpen(left(), U, a.last, 1000 + REPEAT_MS - 1).open, false);
  assert.strictEqual(shouldOpen(left(), U, a.last, 1000 + REPEAT_MS).open, true);
});

test('another link right after one opens at once', () => {
  const a = shouldOpen(left(), U, null, 1000);
  assert.strictEqual(shouldOpen(left(), 'https://example.com/', a.last, 1001).open, true);
});

test('garbage never opens anything, and never throws', () => {
  for (const [ev, uri] of [[null, U], [undefined, U], [{}, U], [{ button: '0' }, U], [left(), ''], [left(), null], [left(), 42]]) {
    assert.strictEqual(shouldOpen(ev, uri, null, 0).open, false, JSON.stringify([ev, uri]));
  }
});

test('a missing click count (detail) counts as a single click', () => {
  assert.strictEqual(shouldOpen({ button: 0 }, U, null, 0).open, true);
});

test('PROPERTY: within REPEAT_MS, however many mouseups land on one link, it opens at most once', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ button: fc.integer({ min: 0, max: 4 }), detail: fc.integer({ min: 0, max: 4 }), dt: fc.integer({ min: 0, max: 60 }) }),
      { minLength: 1, maxLength: 12 }),
    (clicks) => {
      let last = null;
      let now = 5000;
      let opened = 0;
      for (const c of clicks) {
        now += c.dt;
        if (now - 5000 >= REPEAT_MS) break;
        const r = shouldOpen({ button: c.button, detail: c.detail }, U, last, now);
        if (r.open) opened++;
        last = r.last;
      }
      return opened <= 1;
    }), { numRuns: 500 });
});

test('targetText shows the REAL address the link goes to, capped', () => {
  assert.strictEqual(targetText(U), `Opens ${U}`);
  const long = `https://example.com/${'a'.repeat(500)}`;
  const t = targetText(long);
  assert.ok(t.length <= 300, String(t.length));
  assert.ok(t.endsWith('…'));
  assert.strictEqual(targetText(''), null);
  assert.strictEqual(targetText(null), null);
});

test('refusedText says the link was not opened, and why, in words', () => {
  assert.strictEqual(refusedText('https://user:pass@example.com/'),
    'Not opened: https://user:pass@example.com/ (only plain http and https links open in the browser)');
  assert.ok(refusedText(`https://x/${'b'.repeat(500)}`).length <= 400);
});

// --- #37 terminal file links -----------------------------------------------------

test('#37 fileTargetText says what a click will do, by what main decided', () => {
  const { fileTargetText } = require('../app/link-click');
  assert.strictEqual(fileTargetText({ action: 'open', isDir: false, name: 'mocks.html' }),
    'Opens mocks.html in its default app');
  assert.strictEqual(fileTargetText({ action: 'reveal', isDir: false, name: 'run.ps1' }),
    "Shows run.ps1 in Explorer (it could run, so it isn't opened)");
  assert.strictEqual(fileTargetText({ action: 'open', isDir: true, name: 'handoffs' }),
    'Opens folder handoffs in Explorer');
  for (const bad of [null, undefined, 'x', {}, { action: 'run', name: 'a' }, { action: 'open', name: '' }]) {
    assert.strictEqual(fileTargetText(bad), null, JSON.stringify(bad));
  }
  assert.ok(fileTargetText({ action: 'open', isDir: false, name: 'a'.repeat(1000) }).length <= 300);
});

test('#37 fileRefusedText says why nothing opened', () => {
  const { fileRefusedText } = require('../app/link-click');
  assert.strictEqual(fileRefusedText('C:\a.md', 'gone'), "Not opened: C:\a.md isn't there any more");
  assert.strictEqual(fileRefusedText('C:\a.md', 'refused'), 'Not opened: C:\a.md (not a local path this tab can open)');
  assert.strictEqual(fileRefusedText('C:\a.md', 'No application is associated'),
    'Not opened: C:\a.md (No application is associated)');
  assert.strictEqual(fileRefusedText(null, undefined), 'Not opened: that file');
  assert.ok(fileRefusedText('C:\a.md', 'x'.repeat(1000)).length <= 300);
});
