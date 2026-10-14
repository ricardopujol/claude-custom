'use strict';
/**
 * app/ask-controller.js (BACKLOG #33): the panel's asks, run against a fake host. What is pinned: the order things happen in (places
 * first, then the words), that a question is never asked before the explainer is named, that the explainer is refused (in the page too)
 * for a model that hasn't passed, the drill-down, Simpler / Deeper, Ask Claude instead, and the first index's polling.
 */
const test = require('node:test');
const assert = require('node:assert');
const { create } = require('../app/ask-controller');
const P = require('../app/ask-profile');

const mem = (seed) => {
  const m = new Map(seed ? [[P.KEY, seed]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
};
const NAMED = JSON.stringify({ named: true, name: 'Professor Byte', level: 'comfortable', model: 'local', aboutMe: 'C# audio', portrait: { kind: 'emoji', value: '🦉' } });
const HOST_OFF = {
  ok: true, index: { state: 'ready', files: 3, chunks: 9 }, ollama: { ok: true }, examples: ['What does a do?'],
  models: [{ id: 'local', model: 'qwen3.5:4b', where: 'qwen3.5:4b · local', explainer: false }, { id: 'haiku', model: 'Haiku', where: 'Haiku · Claude, uses your plan', explainer: true }, { id: 'sonnet', model: 'Sonnet', where: 'Sonnet · Claude, uses your plan', explainer: false }],
};
const place = (file, line) => ({ file, line, endLine: line + 1, why: '', lines: [] });

function rig({ profile = NAMED, host = HOST_OFF } = {}) {
  const asked = [];
  const timers = [];
  let changes = 0;
  const pending = new Map();
  const request = (op, body) => new Promise((resolve) => {
    const call = { op, body, resolve: (r) => resolve(r) };
    asked.push(call);
    pending.set(call, true);
  });
  const c = create({
    request, storage: mem(profile), onChange: () => { changes += 1; },
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimer: (i) => { if (timers[i]) timers[i].live = false; },
  });
  const last = (op) => [...asked].reverse().find(a => a.op === op);
  const all = (op) => asked.filter(a => a.op === op);
  const answerStatus = async (h = host) => { last('status').resolve(h); await tick(); };
  return { c, asked, timers, last, all, answerStatus, changes: () => changes };
}
const tick = () => new Promise(r => setImmediate(r));

test('opening the panel asks the host for its status and starts the first index (warm)', async () => {
  const r = rig();
  r.c.show();
  assert.deepStrictEqual(r.last('status').body, { warm: true });
  await r.answerStatus();
  assert.strictEqual(r.c.state().host.index.state, 'ready');
  assert.strictEqual(r.c.state().hostError, null);
});

test('a status that failed is said, and the next open still asks for the first index', async () => {
  const r = rig();
  r.c.show();
  r.last('status').resolve({ ok: false, error: 'Waiting for the session to connect.' });
  await tick();
  assert.strictEqual(r.c.state().hostError, 'Waiting for the session to connect.');
  r.c.show();
  assert.deepStrictEqual(r.all('status')[1].body, { warm: true });
});

test('while the first index is building, the status is polled until it is ready; hiding stops the polling', async () => {
  const r = rig();
  r.c.show();
  await r.answerStatus({ ...HOST_OFF, index: { state: 'building', progress: { done: 3, total: 10 } } });
  assert.strictEqual(r.timers.filter(t => t.live).length, 1);
  r.timers[0].live = false;     // a timer that fired is no longer waiting
  r.timers[0].fn();
  assert.strictEqual(r.all('status').length, 2);
  await r.answerStatus({ ...HOST_OFF, index: { state: 'ready', files: 10 } });
  assert.strictEqual(r.timers.filter(t => t.live).length, 0, 'ready: no more polling');
  r.c.show();
  await r.answerStatus({ ...HOST_OFF, index: { state: 'building', progress: { done: 1, total: 10 } } });
  r.c.hide();
  assert.strictEqual(r.timers.filter(t => t.live).length, 0);
});

test('a worktree reported as not read yet is polled a few times (its first index is starting), then left alone', async () => {
  const r = rig();
  const none = { ...HOST_OFF, index: { state: 'none', files: 0 } };
  r.c.show();
  await r.answerStatus(none);
  let polls = 0;
  for (let i = 0; i < 20; i += 1) {
    const live = r.timers.filter(t => t.live);
    if (!live.length) break;
    polls += 1;
    live[0].live = false;
    live[0].fn();
    await r.answerStatus(none);
  }
  assert.strictEqual(polls, 8, 'a bounded look, not a loop that never ends');
  assert.strictEqual(r.timers.filter(t => t.live).length, 0);
  r.c.show();
  await r.answerStatus(none);
  assert.strictEqual(r.timers.filter(t => t.live).length, 1, 'opening the panel again looks again');
});

test('nothing is asked of the model before the explainer is named; the question waits for the naming card', async () => {
  const r = rig({ profile: null });
  r.c.ask('where is x?');
  assert.strictEqual(r.asked.length, 0);
  assert.strictEqual(r.c.state().view, 'naming');
});

test('naming: a name and a face are saved, and an empty name is refused with words', () => {
  const r = rig({ profile: null });
  assert.strictEqual(r.c.state().ui.naming.name, 'Professor Byte', 'pre-filled');
  r.c.setNamingName('   ');
  assert.strictEqual(r.c.saveNaming(), false);
  assert.match(r.c.state().ui.naming.error, /name/i);
  r.c.setNamingName('Ada');
  r.c.setNamingPortrait({ kind: 'emoji', value: P.PORTRAITS[2] });
  assert.strictEqual(r.c.saveNaming(), true);
  assert.deepStrictEqual([r.c.state().profile.named, r.c.state().profile.name, r.c.state().profile.portrait.value], [true, 'Ada', P.PORTRAITS[2]]);
  assert.strictEqual(r.c.state().view, 'empty');
});

test('a selection clicked before naming waits, and is explained once the name is saved', async () => {
  const r = rig({ profile: null, host: { ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: true })) } });
  r.c.show();
  await r.answerStatus({ ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: true })) });
  r.c.explain({ file: 'a.js', start: 1, end: 3 });
  assert.strictEqual(r.all('explain').length, 0);
  r.c.setNamingName('Echo');
  r.c.saveNaming();
  assert.strictEqual(r.all('explain').length, 1, 'now it asks');
  assert.strictEqual(r.all('places').length, 1);
});

test('a typed question: places are asked, the answer is asked, the cards show before the words', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  const done = r.c.ask('where is the lock?');
  assert.strictEqual(r.c.state().view, 'waiting');
  assert.deepStrictEqual(r.last('places').body, { question: 'where is the lock?', model: 'local' });
  assert.deepStrictEqual(r.last('ask').body, { question: 'where is the lock?', model: 'local' });
  r.last('places').resolve({ ok: true, places: [place('a.js', 1), place('b.js', 2)] });
  await tick();
  const e = r.c.state().entry;
  assert.strictEqual(e.places.length, 2);
  assert.strictEqual(e.stage, 'loading');
  assert.strictEqual(r.c.state().view, 'waiting');
  r.last('ask').resolve({ ok: true, text: 'It is in a.js:1.', places: [place('a.js', 1)], model: 'local' });
  await done;
  assert.strictEqual(r.c.state().view, 'answer');
  assert.strictEqual(r.c.state().entry.reply.text, 'It is in a.js:1.');
});

test('the third waiting step comes after a pause once the places are in (the model is loading, then writing)', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  r.c.ask('q');
  r.last('places').resolve({ ok: true, places: [place('a.js', 1)] });
  await tick();
  const t = r.timers.filter(x => x.live).at(-1);
  assert.strictEqual(t.ms, 4000, 'a local model takes ~4 s to load');
  t.fn();
  assert.strictEqual(r.c.state().entry.stage, 'writing');
});

test('for a Claude model the middle step is short and nothing is said about loading', async () => {
  const r = rig({ profile: JSON.stringify({ ...JSON.parse(NAMED), model: 'haiku' }) });
  r.c.show(); await r.answerStatus();
  r.c.ask('q');
  assert.strictEqual(r.last('ask').body.model, 'haiku');
  r.last('places').resolve({ ok: true, places: [place('a.js', 1)] });
  await tick();
  assert.strictEqual(r.timers.filter(x => x.live).at(-1).ms, 2500);
});

test('a failed ask is a note that keeps the places the search found', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  const done = r.c.ask('q');
  r.last('places').resolve({ ok: true, places: [place('a.js', 1)] });
  r.last('ask').resolve({ ok: false, reason: 'ollama-down', places: [place('a.js', 1)] });
  await done;
  assert.strictEqual(r.c.state().view, 'note');
  assert.strictEqual(r.c.state().entry.places.length, 1);
});

test('the answer of an earlier question does not overwrite the question asked after it', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  const first = r.c.ask('first');
  const firstAsk = r.last('ask');
  const second = r.c.ask('second');
  firstAsk.resolve({ ok: true, text: 'A1', places: [], model: 'local' });
  await first;
  assert.strictEqual(r.c.state().entry.label, 'second', 'the second question is still the one on screen');
  assert.strictEqual(r.c.state().view, 'waiting');
  r.last('ask').resolve({ ok: true, text: 'A2', places: [], model: 'local' });
  await second;
  assert.strictEqual(r.c.state().entry.reply.text, 'A2');
  assert.strictEqual(r.c.state().history.find(e => e.label === 'first').reply.text, 'A1');
});

test('a blank question asks nothing', () => {
  const r = rig();
  r.c.ask('   ');
  assert.strictEqual(r.asked.length, 0);
});

test('explain on a model that has not passed: refused in the page too, no request is sent, and it says why', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  r.c.explain({ file: 'a.js', start: 1, end: 3 });
  assert.strictEqual(r.all('explain').length, 0);
  assert.strictEqual(r.c.state().view, 'note');
  assert.strictEqual(r.c.state().entry.reply.reason, 'explainer-off');
});

test('explain on a passed model sends the selection with the level and About me; the places go first', async () => {
  const on = { ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: true })) };
  const r = rig({ host: on });
  r.c.show(); await r.answerStatus(on);
  const done = r.c.explain({ file: 'host/a.js', start: 3, end: 5 });
  assert.deepStrictEqual(r.last('explain').body, { file: 'host/a.js', start: 3, end: 5, level: 'comfortable', aboutMe: 'C# audio', model: 'local' });
  assert.strictEqual(r.c.state().entry.label, 'host/a.js:3-5');
  r.last('places').resolve({ ok: true, places: [place('b.js', 1)] });
  r.last('explain').resolve({ ok: true, text: 'The idea.', places: [], model: 'local' });
  await done;
  assert.strictEqual(r.c.state().view, 'answer');
});

test('Simpler / Deeper re-ask the same selection once, as a sibling, not a replacement', async () => {
  const on = { ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: true })) };
  const r = rig({ host: on });
  r.c.show(); await r.answerStatus(on);
  const d1 = r.c.explain({ file: 'a.js', start: 1, end: 2 });
  r.last('explain').resolve({ ok: true, text: 'first', places: [], model: 'local' });
  await d1;
  const d2 = r.c.reask('simpler');
  assert.strictEqual(r.last('explain').body.direction, 'simpler');
  assert.strictEqual(r.last('explain').body.start, 1);
  r.last('explain').resolve({ ok: true, text: 'simpler text', places: [], model: 'local' });
  await d2;
  assert.strictEqual(r.c.state().entry.reply.text, 'simpler text');
  assert.strictEqual(r.c.state().history.length, 2);
  assert.strictEqual(r.c.reask('sideways'), undefined, 'only simpler and deeper');
  assert.strictEqual(r.all('explain').length, 2);
});

test('the drill-down: highlighted words become a step from this answer, with the answer\'s text, and the breadcrumb grows', async () => {
  const on = { ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: true })) };
  const r = rig({ host: on });
  r.c.show(); await r.answerStatus(on);
  const d1 = r.c.explain({ file: 'a.js', start: 1, end: 2 });
  r.last('explain').resolve({ ok: true, text: 'It sends an HTTP request.', places: [], model: 'local' });
  await d1;
  const d2 = r.c.drill('HTTP request');
  assert.deepStrictEqual(
    { term: r.last('explain').body.term, answer: r.last('explain').body.answer, file: r.last('explain').body.file },
    { term: 'HTTP request', answer: 'It sends an HTTP request.', file: 'a.js' },
  );
  r.last('explain').resolve({ ok: true, text: 'A request is...', places: [], model: 'local' });
  await d2;
  assert.deepStrictEqual(r.c.state().trail.map(t => t.label), ['a.js:1-2', 'HTTP request']);
  r.c.select(r.c.state().trail[0].id);
  assert.strictEqual(r.c.state().entry.reply.text, 'It sends an HTTP request.');
});

test('drilling into a typed answer asks "what is X?" as a question', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  const d1 = r.c.ask('how does it log?');
  r.last('ask').resolve({ ok: true, text: 'It uses a ring buffer.', places: [], model: 'local' });
  await d1;
  r.c.drill('ring buffer');
  assert.strictEqual(r.last('ask').body.question, 'What is ring buffer?');
  assert.deepStrictEqual(r.c.state().trail.map(t => t.label), ['how does it log?', 'What is ring buffer?']);
});

test('Ask Claude instead: a question goes to Haiku (not the local model) and only on the click', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  const d1 = r.c.ask('where?');
  r.last('ask').resolve({ ok: false, reason: 'ollama-down', places: [] });
  await d1;
  assert.strictEqual(r.all('ask').filter(a => a.body.model !== 'local').length, 0, 'nothing went to Claude by itself');
  r.c.askClaude();
  assert.strictEqual(r.last('ask').body.model, 'haiku');
  assert.strictEqual(r.last('ask').body.question, 'where?');
});

test('Ask Claude instead on a selection: Haiku explains it if Haiku has passed, else it is asked as a question', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  // the local explainer is off, so the click on a selection leaves a note; asking Claude then explains it (Haiku passed in HOST_OFF)
  r.c.explain({ file: 'a.js', start: 1, end: 3 });
  r.c.askClaude();
  assert.strictEqual(r.last('explain').body.model, 'haiku');
  const noHaiku = rig({ host: { ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: false })) } });
  noHaiku.c.show(); await noHaiku.answerStatus({ ...HOST_OFF, models: HOST_OFF.models.map(m => ({ ...m, explainer: false })) });
  noHaiku.c.explain({ file: 'a.js', start: 1, end: 3 });
  noHaiku.c.askClaude();
  assert.strictEqual(noHaiku.all('explain').length, 0);
  assert.match(noHaiku.last('ask').body.question, /a\.js lines 1-3/);
  assert.strictEqual(noHaiku.last('ask').body.model, 'haiku');
});

test('Ask Claude instead uses the person\'s own Claude choice when they made one', async () => {
  const r = rig({ profile: JSON.stringify({ ...JSON.parse(NAMED), model: 'sonnet' }) });
  r.c.show(); await r.answerStatus();
  r.c.ask('q');
  assert.strictEqual(r.last('ask').body.model, 'sonnet');
  r.c.askClaude();
  assert.strictEqual(r.last('ask').body.model, 'sonnet');
});

test('Start Ollama: says it is starting, then what happened, and asks the status again', async () => {
  const r = rig();
  r.c.show(); await r.answerStatus();
  r.c.startOllama();
  assert.match(r.c.state().ui.startMsg, /Starting/);
  r.last('start-ollama').resolve({ ok: true });
  await tick();
  assert.match(r.c.state().ui.startMsg, /starting\. Ask again/i);
  assert.strictEqual(r.all('status').length, 2);
  const r2 = rig();
  r2.c.show(); await r2.answerStatus();
  r2.c.startOllama();
  r2.last('start-ollama').resolve({ ok: false, reason: 'ollama-not-installed' });
  await tick();
  assert.match(r2.c.state().ui.startMsg, /ollama-not-installed/);
});

test('settings: level, About me and model are saved together; a bad value changes nothing', async () => {
  const r = rig();
  r.c.toggleSettings();
  assert.strictEqual(r.c.state().ui.settings, true);
  r.c.saveSettings({ name: 'Echo', level: 'new', aboutMe: '  from music  ', model: 'sonnet' });
  const p = r.c.state().profile;
  assert.deepStrictEqual([p.name, p.level, p.aboutMe, p.model], ['Echo', 'new', 'from music', 'sonnet']);
  assert.strictEqual(r.c.state().ui.settings, false);
  r.c.saveSettings({ name: '', level: 'wizard', aboutMe: null, model: 'gpt' });
  const q = r.c.state().profile;
  assert.deepStrictEqual([q.name, q.level, q.aboutMe, q.model], ['Echo', 'new', 'from music', 'local']);
});

test('Change portrait goes back to the naming card with the current name and face', () => {
  const r = rig();
  r.c.rename();
  assert.strictEqual(r.c.state().view, 'naming');
  assert.strictEqual(r.c.state().ui.naming.name, 'Professor Byte');
});

test('a dropped host is said, and the panel does not crash on a reply with no body', async () => {
  const r = rig();
  r.c.show();
  r.last('status').resolve(undefined);
  await tick();
  assert.match(r.c.state().hostError, /did not answer/);
  const d = r.c.ask('q');
  r.last('ask').resolve(undefined);
  r.last('places').resolve(null);
  await d;
  assert.strictEqual(r.c.state().view, 'note');
});

test('the controller tells the display on every change', async () => {
  const r = rig();
  const before = r.changes();
  r.c.show();
  await r.answerStatus();
  assert.ok(r.changes() > before);
});
