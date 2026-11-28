'use strict';
/**
 * app/home-display.js: Jiandu Home's page (plan documentation/PLAN_PROJECT_HUB.md H-PR2). Pure strings and a click resolver; the page
 * wiring runs in jsdom here and in a real window in verify/probe-home.js (the one-global-scope trap is only seen there).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const D = require('../app/home-display');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const card = (over = {}) => ({
  key: 'c:\\p\\viral', root: 'C:\\p\\viral', label: 'viral', pinned: false, state: 'closed', tabs: null, needs: 0, sessions: null,
  lastUsed: NOW - 5 * 60_000, lanes: [], actions: ['open', 'pin', 'show-in-explorer', 'remove'], ...over,
});
const payload = (cards, over = {}) => ({ cards, summary: { open: 0, needs: 0, total: cards.length, shown: cards.length }, filter: '', empty: null, now: NOW, ...over });

test('a closed card: its name, folder, "closed", the time it was used, and its buttons in words', () => {
  const html = D.cardsHtml(payload([card()]));
  assert.match(html, /data-key="c:\\p\\viral"/);
  assert.match(html, />viral</);
  assert.match(html, />C:\\p\\viral</);
  assert.match(html, /closed/);
  assert.match(html, /used 5 min ago/);
  for (const label of ['Open', 'Pin', 'Show in Explorer', 'Remove from the list']) assert.match(html, new RegExp(`>${label}<`));
  assert.doesNotMatch(html, /Go to window|Close window/);
});

test('an open card: tabs and needs, Go to window and Close window (its tip says the sessions keep running), lanes with their cue', () => {
  const html = D.cardsHtml(payload([card({ state: 'open', tabs: 3, needs: 1, actions: ['go-to', 'close-window', 'unpin', 'show-in-explorer'], pinned: true,
    lanes: [{ key: 'k1', label: 'dev', path: 'C:\\p\\viral\\dev', needs: false }, { key: 'k2', label: 'feat-x', path: 'C:\\p\\viral\\feat-x', needs: true }] })]));
  assert.match(html, /open · 3 tabs · needs you/);
  assert.match(html, /class="card open needs pinned"/);
  assert.match(html, />Go to window</);
  assert.match(html, /title="Closes the window\. Its sessions keep running in the tray\."[^>]*>Close window</);
  assert.match(html, />Unpin</);
  assert.match(html, /data-act="lane" data-lane="C:\\p\\viral\\feat-x"[^>]*class="lane needs"/);
});

test('a windowless card: its session count and no window', () => {
  assert.match(D.cardsHtml(payload([card({ state: 'windowless', sessions: 2, actions: ['open', 'pin', 'show-in-explorer'] })])), /2 sessions, no window/);
  assert.match(D.cardsHtml(payload([card({ state: 'windowless', sessions: 1, actions: ['open'] })])), /1 session, no window/);
});

test('every string from a card is escaped (a folder may be named anything)', () => {
  const html = D.cardsHtml(payload([card({ label: '<img src=x onerror=alert(1)>', root: 'C:\\"a&b\'', lanes: [{ key: 'k', label: '<b>', path: 'C:\\<b>', needs: false }] })]));
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /C:\\&quot;a&amp;b&#39;/);
});

test('the times: just now, minutes, hours, days, and nothing when there is no time (never "0")', () => {
  assert.strictEqual(D.usedText(NOW - 20_000, NOW), 'used just now');
  assert.strictEqual(D.usedText(NOW - 59 * 60_000, NOW), 'used 59 min ago');
  assert.strictEqual(D.usedText(NOW - 3 * 3_600_000, NOW), 'used 3 h ago');
  assert.strictEqual(D.usedText(NOW - 2 * 86_400_000, NOW), 'used 2 days ago');
  assert.strictEqual(D.usedText(NOW - 86_400_000, NOW), 'used 1 day ago');
  for (const bad of [null, 0, '5', NaN, undefined]) assert.strictEqual(D.usedText(bad, NOW), '', String(bad));
  assert.strictEqual(D.usedText(NOW + 60_000, NOW), 'used just now', 'a clock a little ahead is not "in the future"');
});

test('the summary line: "N open · N need you", the needs part only when some card needs you', () => {
  assert.strictEqual(D.summaryText({ open: 2, needs: 0, total: 5, shown: 5 }), '2 open');
  assert.strictEqual(D.summaryText({ open: 2, needs: 1, total: 5, shown: 5 }), '2 open · 1 needs you');
  assert.strictEqual(D.summaryText({ open: 0, needs: 3, total: 5, shown: 5 }), '0 open · 3 need you');
  assert.strictEqual(D.summaryText(null), '');
});

test('the empty state is the payload\'s line, escaped', () => {
  assert.match(D.cardsHtml(payload([], { empty: 'No project matches "<x>".' })), /class="empty">No project matches &quot;&lt;x&gt;&quot;\.</);
});

test('clickTarget: a button names its action and card; a lane its path; anything else is nothing', () => {
  const dom = new JSDOM(`<div id="cards">${D.cardsHtml(payload([card({ state: 'open', actions: ['go-to'], lanes: [{ key: 'k', label: 'dev', path: 'C:\\p\\viral\\dev', needs: false }] })]))}</div>`);
  const doc = dom.window.document;
  assert.deepStrictEqual(D.clickTarget(doc.querySelector('[data-act="go-to"]')), { action: 'go-to', key: 'c:\\p\\viral' });
  assert.deepStrictEqual(D.clickTarget(doc.querySelector('[data-act="lane"]')), { action: 'lane', key: 'c:\\p\\viral', lane: 'C:\\p\\viral\\dev' });
  assert.strictEqual(D.clickTarget(doc.querySelector('.label')), null);
  assert.strictEqual(D.clickTarget(null), null);
});

test('the page: home.html loads the display in a strict CSP, the display is wrapped in an IIFE and leaves ONE name', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'home.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"/);
  assert.match(html, /<script src="home-display\.js"><\/script>/);
  assert.match(html, /Home stays open\. Closing it leaves every project window as it is\./);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'home-display.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const before = new Set(Object.keys(dom.window));
  dom.window.eval(src);
  const leaked = Object.keys(dom.window).filter((k) => !before.has(k));
  assert.deepStrictEqual(leaked, ['homeDisplay']);
});

test('the page wiring: a push draws the cards and the summary; a click acts; typing filters; a remove says the folder is not touched', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'home.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const acts = [];
  let onModel = null;
  // copied through JSON: an object made in the page's realm is not deepStrictEqual to one made here
  dom.window.home = { onModel: (fn) => { onModel = fn; }, act: (m) => { acts.push(JSON.parse(JSON.stringify(m))); } };
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'app', 'home-display.js'), 'utf8'));
  dom.window.homeDisplay.start(dom.window.document, dom.window.home);
  const doc = dom.window.document;
  onModel(payload([card(), card({ key: 'k2', root: 'C:\\q', label: 'q' })], { summary: { open: 1, needs: 0, total: 2, shown: 2 } }));
  assert.strictEqual(doc.querySelectorAll('.card').length, 2);
  assert.strictEqual(doc.getElementById('summary').textContent, '1 open');
  doc.querySelector('[data-key="k2"] [data-act="open"]').click();
  assert.deepStrictEqual(acts.pop(), { action: 'open', key: 'k2' });
  const box = doc.getElementById('filter');
  box.value = 'vir';
  box.dispatchEvent(new dom.window.Event('input'));
  assert.deepStrictEqual(acts.pop(), { action: 'filter', text: 'vir' });
  doc.getElementById('choose').click();
  assert.deepStrictEqual(acts.pop(), { action: 'choose-folder' });
  doc.querySelector('[data-key="k2"] [data-act="remove"]').click();
  assert.deepStrictEqual(acts.pop(), { action: 'remove', key: 'k2' });
  assert.strictEqual(doc.getElementById('notice').textContent, 'q removed from the list. Its folder is not touched.');
});
