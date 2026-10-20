'use strict';
/**
 * app/schedules-display.js: the Schedules panel's markup and state (BACKLOG #119 A7). Pure strings and a reducer; renderer.js wires the
 * click and the IPC (test/renderer-schedules-wiring.test.js), verify/probe-schedules.js drives it in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('../app/schedules-display');
const S = require('../host/schedules');

const NOW = new Date(2026, 9, 19, 22, 0, 0, 0).getTime();
const MIN = 60_000;
const row = (id, at, o = {}) => ({ id, kind: 'wakeup', at, prompt: `prompt ${id}`, reason: null, createdAt: NOW - MIN, durable: false, cron: null, recurring: false, human: null, ...o });
const entry = (rows, o = {}) => ({ key: '1', cwd: 'C:/p/a', label: 'proj / feat-a', pid: 1, updatedAt: NOW, endedAt: null, rows, ...o });
const view = (entries) => S.buildView(entries, NOW);
const stateOf = (entries) => D.reduce(D.emptyState(), { type: 'hello', schedules: view(entries) });

test('before any host has spoken the panel says so; it never invents an empty schedule', () => {
  const html = D.html(D.emptyState());
  assert.match(html, /sched-wait/);
  assert.doesNotMatch(html, /Nothing scheduled/);
});

test('hello and a schedules frame both set the list; other frames and junk change nothing', () => {
  const v = view({ '1': entry([row('a', NOW + 5 * MIN)]) });
  const hello = D.reduce(D.emptyState(), { type: 'hello', schedules: v });
  assert.strictEqual(hello.view.groups.length, 1);
  const frame = D.reduce(D.emptyState(), { type: 'schedules', schedules: v });
  assert.deepStrictEqual(frame.view, hello.view);
  for (const junk of [null, undefined, 3, 'x', {}, { type: 'bedtime' }, { type: 'schedules' }, { type: 'schedules', schedules: 'no' }, { type: 'schedules', schedules: { groups: 'no' } }, { type: 'hello' }]) {
    assert.strictEqual(D.reduce(hello, junk), hello, JSON.stringify(junk));
  }
  assert.strictEqual(D.reduce(D.emptyState(), { type: 'hello' }).view, null, 'an older host sends none: still "not heard"');
});

test('an empty list reads "Nothing scheduled" and still carries the footer', () => {
  const html = D.html(D.reduce(D.emptyState(), { type: 'schedules', schedules: view({}) }));
  assert.match(html, /Nothing scheduled/);
  assert.match(html, /Routines/);
});

test('grouping headers appear in order, each with its rows, and empty groups have no header', () => {
  const html = D.html(stateOf({ '1': entry([
    row('later', new Date(2026, 9, 22, 14, 0).getTime()), row('hour', NOW + 5 * MIN), row('night', new Date(2026, 9, 20, 3, 0).getTime()),
    { ...row('c', null), kind: 'cron', cron: '0 6 * * *', recurring: true, human: 'every day 06:00' },
  ]) }));
  const heads = [...html.matchAll(/<h3 class="sched-head"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepStrictEqual(heads, ['Next hour', 'Tonight', 'Later', 'Recurring']);
  const order = ['hour', 'night', 'later', 'c'].map(id => html.indexOf(`data-sched-id="${id}"`));
  assert.ok(order.every(i => i !== -1) && order.every((i, k) => k === 0 || i > order[k - 1]), 'rows follow their headers');
  const none = D.html(stateOf({ '1': entry([row('hour', NOW + 5 * MIN)]) }));
  assert.deepStrictEqual([...none.matchAll(/<h3 class="sched-head"[^>]*>([^<]+)</g)].map(m => m[1]), ['Next hour']);
});

test('a row shows when, kind chip, the prompt line, the session, and a wakeup\'s reason', () => {
  const html = D.html(stateOf({ '1': entry([row('a', NOW + 23 * MIN, { prompt: 'check the PRs\nand more', reason: 'CI takes ~20 min' })]) }));
  assert.match(html, /<span class="sched-when">in 23 min<\/span>/);
  assert.match(html, /<span class="sched-chip sched-kind-wakeup">wakeup<\/span>/);
  assert.match(html, /<span class="sched-what">check the PRs<\/span>/);
  assert.match(html, /<span class="sched-session">proj \/ feat-a<\/span>/);
  assert.match(html, /<span class="sched-reason">CI takes ~20 min<\/span>/);
  assert.match(html, /title="check the PRs\nand more/, 'the full prompt is on the hover');
});

test('the kind chip names loop, bedtime and cron rows too, and a bedtime row shows its night', () => {
  const night = { startedAt: new Date(2026, 9, 19, 21, 30).getTime(), wakes: 3, prs: 4 };
  const html = D.html(stateOf({ '1': entry([
    row('l', NOW + 5 * MIN, { kind: 'loop', prompt: '/loop 5m x' }), row('b', NOW + 6 * MIN, { kind: 'bedtime', night }),
    { ...row('c', null), kind: 'cron', cron: '*/10 * * * *', recurring: true },
  ]) }));
  for (const k of ['loop', 'bedtime', 'cron']) assert.match(html, new RegExp(`sched-kind-${k}">${k}<`), k);
  assert.match(html, /<span class="sched-detail">night since 21:30 · 3 wakes · 4 PRs<\/span>/);
});

test('a recurring job shows its schedule and its next run; an unreadable one shows "schedule: <raw>"', () => {
  const html = D.html(stateOf({ '1': entry([
    { ...row('d', null), kind: 'cron', cron: '0 6 * * *', recurring: true, human: 'every day 06:00' },
    { ...row('w', null), kind: 'cron', cron: '0 9 * * MON', recurring: true },
  ]) }));
  assert.match(html, /<span class="sched-when">every day 06:00<\/span>/);
  assert.match(html, /<span class="sched-next">next tomorrow 06:00<\/span>/);
  assert.match(html, /<span class="sched-when">schedule: 0 9 \* \* MON<\/span>/);
});

test('a row is a button that carries the session\'s folder, so a click can select its tab; one with no folder cannot be clicked', () => {
  const html = D.html(stateOf({ '1': entry([row('a', NOW + 5 * MIN)]), '2': entry([row('b', NOW + 6 * MIN)], { key: '2', cwd: null }) }));
  assert.match(html, /<button type="button" class="sched-btn"[^>]*data-sched-cwd="C:\/p\/a"/);
  assert.match(html, /<button type="button" class="sched-btn"[^>]*data-sched-id="b"[^>]*disabled/);
  assert.match(html, /The session owns its schedule/, 'read-only, and the hover says where to change it');
});

test('rows of an ended session are dimmed and say "session ended"', () => {
  const html = D.html(stateOf({ '1': entry([row('a', NOW + 5 * MIN)], { endedAt: NOW - 2 * MIN }) }));
  assert.match(html, /class="sched-row sched-ended"/);
  assert.match(html, /<span class="sched-gone">session ended<\/span>/);
  assert.doesNotMatch(D.html(stateOf({ '1': entry([row('a', NOW + 5 * MIN)]) })), /sched-ended|session ended/);
});

test('everything a session or a prompt says is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"&\'';
  const html = D.html(stateOf({ '1': entry([row('a', NOW + 5 * MIN, { prompt: evil, reason: evil })], { label: evil, cwd: evil }) }));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the footer says Routines are cloud-side and links to claude.ai/code through a data attribute, whatever the payload says', () => {
  const st = D.reduce(D.emptyState(), { type: 'schedules', schedules: { ...view({}), footer: { text: 'x', url: 'https://evil.example' } } });
  const html = D.html(st);
  assert.match(html, /Routines on <a [^>]*data-sched-link="https:\/\/claude\.ai\/code"[^>]*>claude\.ai\/code<\/a> run in the cloud and are not listed here\./);
  assert.doesNotMatch(html, /evil\.example/);
});

test('badge: the count of live Next-hour rows, 0 when there is nothing or the host has not spoken', () => {
  assert.strictEqual(D.badge(D.emptyState()), 0);
  assert.strictEqual(D.badge(stateOf({})), 0);
  assert.strictEqual(D.badge(stateOf({ '1': entry([row('a', NOW + 5 * MIN), row('b', NOW + 9 * MIN), row('c', NOW + 3 * 3600_000)]) })), 2);
  assert.strictEqual(D.badge(stateOf({ '1': entry([row('a', NOW + 5 * MIN)], { endedAt: NOW - MIN }) })), 0, 'a dead session\'s wake is not coming up');
  assert.strictEqual(D.badge({ view: { nextHour: -3 } }), 0);
  assert.strictEqual(D.badge({ view: { nextHour: 'x' } }), 0);
  assert.strictEqual(D.badgeText(0), '');
  assert.strictEqual(D.badgeText(2), '2');
  assert.strictEqual(D.badgeText(120), '99+');
});

test('rowTarget: the folder of the clicked row, the link of the clicked link, and nothing for anything else', () => {
  const el = (dataset) => ({ dataset, closest(sel) { return sel === '[data-sched-link]' && dataset.schedLink ? this : (sel === '[data-sched-cwd]' && dataset.schedCwd ? this : null); } });
  assert.deepStrictEqual(D.clickTarget(el({ schedCwd: 'C:/p/a' })), { kind: 'select', folder: 'C:/p/a' });
  assert.deepStrictEqual(D.clickTarget(el({ schedLink: 'https://claude.ai/code' })), { kind: 'link', url: 'https://claude.ai/code' });
  assert.deepStrictEqual(D.clickTarget(el({ schedLink: 'https://evil.example' })), null, 'only our own link');
  assert.strictEqual(D.clickTarget(el({})), null);
  assert.strictEqual(D.clickTarget(null), null);
  assert.strictEqual(D.clickTarget({}), null);
});
