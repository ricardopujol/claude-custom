'use strict';
/**
 * Which display a tab shows, and what the type box puts on the pty (app/chat-view-state.js, BACKLOG #157).
 * The invariants: when the CLI needs the person the terminal is showing, whatever else is true; the chat is shown
 * only when it was asked for; and the type box can never put anything on the pty that typing couldn't.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { viewFor, isChatKey, sanitizeInput, planChatSend, readWanted, writeWanted, FLIP_NOTE } = require('../app/chat-view-state');
const { createTurnState } = require('../host/turn-state');
const { NEEDS_INPUT } = require('../host/attention');

const TURNS = [null, 'idle', 'turn', 'prompt'];

test('the terminal is shown unless the chat was asked for', () => {
  for (const turn of TURNS) for (const blocked of [false, true]) {
    assert.deepStrictEqual(viewFor({ wanted: false, turn, blocked }), { show: 'terminal', note: null });
  }
});

test('asked for and the session is known to be at its prompt or in a turn: the chat', () => {
  for (const turn of ['idle', 'turn']) assert.deepStrictEqual(viewFor({ wanted: true, turn, blocked: false }), { show: 'chat', note: null });
});

test('an unknown session is not at the prompt: the terminal, no note (a trust dialog, an MCP approval, a resume picker fire no hook) (PR #226 Miguel I1)', () => {
  for (const turn of [null, undefined, 'something-else']) assert.deepStrictEqual(viewFor({ wanted: true, turn, blocked: false }), { show: 'terminal', note: null });
});

test('a dialog or picker the SCREEN shows flips to the terminal although the hooks say idle (/model, /resume) (PR #226 Dexter 6)', () => {
  assert.deepStrictEqual(viewFor({ wanted: true, turn: 'idle', blocked: false, screen: 'dialog' }), { show: 'terminal', note: FLIP_NOTE });
  assert.strictEqual(viewFor({ wanted: true, turn: 'idle', blocked: false, screen: 'ready' }).show, 'chat');
  assert.strictEqual(viewFor({ wanted: true, turn: 'turn', blocked: false, screen: 'multiline' }).show, 'chat');
});

test('a dialog or a blocked program flips to the terminal with a one-line note', () => {
  assert.deepStrictEqual(viewFor({ wanted: true, turn: 'prompt', blocked: false }), { show: 'terminal', note: FLIP_NOTE });
  assert.deepStrictEqual(viewFor({ wanted: true, turn: 'turn', blocked: true }), { show: 'terminal', note: FLIP_NOTE });
  assert.ok(!FLIP_NOTE.includes('\n'));
});

test('missing input is "not asked for", never a crash', () => {
  assert.strictEqual(viewFor().show, 'terminal');
  assert.strictEqual(viewFor({}).show, 'terminal');
  assert.strictEqual(viewFor({ wanted: 'yes' }).show, 'terminal');
});

test('property: the terminal shows whenever the CLI needs the person', () => {
  fc.assert(fc.property(fc.boolean(), fc.constantFrom(...TURNS), fc.boolean(), (wanted, turn, blocked) => {
    const v = viewFor({ wanted, turn, blocked });
    if (turn === 'prompt' || blocked) return v.show === 'terminal';
    if (turn === null) return v.show === 'terminal';
    return v.show === (wanted ? 'chat' : 'terminal');
  }));
});

test('property: after ANY hook sequence ending in a NEEDS_INPUT Notification the terminal shows; it returns when the turn resumes or ends', () => {
  const needs = fc.constantFrom(...NEEDS_INPUT).map(t => ({ event: 'Notification', payload: { notification_type: t } }));
  const noise = fc.oneof(
    fc.constantFrom('PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop').map(e => ({ event: e, payload: {} })),
    fc.constant({ event: 'Notification', payload: { notification_type: 'idle_prompt' } }));
  fc.assert(fc.property(fc.array(noise, { maxLength: 12 }), needs, (before, ask) => {
    const t = createTurnState();
    for (const e of [{ event: 'SessionStart', payload: { source: 'startup' } }, ...before, ask]) t.handle(e);
    const flipped = viewFor({ wanted: true, turn: t.snapshot(), blocked: false });
    t.handle({ event: 'PostToolUse', payload: { tool_name: 'Bash' } });
    const resumed = viewFor({ wanted: true, turn: t.snapshot(), blocked: false });
    t.handle({ event: 'Stop', payload: {} });
    const ended = viewFor({ wanted: true, turn: t.snapshot(), blocked: false });
    return flipped.show === 'terminal' && flipped.note === FLIP_NOTE && resumed.show === 'chat' && ended.show === 'chat';
  }));
});

test('a rejected or Esc-ed permission prompt fires no Stop: Claude Code\'s idle_prompt brings the chat back (PR #226 Dexter 2)', () => {
  const idle = { event: 'Notification', payload: { notification_type: 'idle_prompt' } };
  const ask = { event: 'Notification', payload: { notification_type: 'permission_prompt' } };
  const START = { event: 'SessionStart', payload: { source: 'startup' } };
  const prompt = { event: 'UserPromptSubmit', payload: { prompt: 'edit it' } };
  for (const seq of [[START, ask, idle], [START, prompt, ask, idle]]) {
    const t = createTurnState();
    for (const e of seq.slice(0, -1)) t.handle(e);
    assert.strictEqual(viewFor({ wanted: true, turn: t.snapshot(), blocked: false }).show, 'terminal');
    t.handle(seq[seq.length - 1]);
    assert.strictEqual(viewFor({ wanted: true, turn: t.snapshot(), blocked: false }).show, 'chat', JSON.stringify(seq.map(e => e.event)));
  }
});

test('the shortcut is Ctrl+Shift+H on keydown only, with no other modifier', () => {
  const k = (o) => ({ type: 'keydown', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'KeyH', key: 'H', ...o });
  assert.ok(isChatKey(k()));
  assert.ok(isChatKey(k({ key: 'h' })));
  for (const bad of [{ type: 'keyup' }, { ctrlKey: false }, { shiftKey: false }, { altKey: true }, { metaKey: true }, { code: 'KeyG', key: 'G' }]) assert.ok(!isChatKey(k(bad)), JSON.stringify(bad));
  assert.ok(!isChatKey(null));
});

test('sanitizeInput drops every control character but newline and tab, and normalises line ends', () => {
  assert.strictEqual(sanitizeInput('a\x1b[201~b\x07\x7f\x00c'), 'a[201~bc');
  assert.strictEqual(sanitizeInput('one\r\ntwo\rthree\n'), 'one\ntwo\nthree');
  assert.strictEqual(sanitizeInput('  \n\n '), '');
  assert.strictEqual(sanitizeInput(null), '');
  assert.strictEqual(sanitizeInput('x\u0085y\u2028z'), 'xyz');
});

const data = (frame) => JSON.parse(frame).data;

test('a one-line message is typed, then Enter as its own spaced frame', () => {
  const plan = planChatSend('fix the bug', { bracketed: false });
  assert.deepStrictEqual(plan.map(p => [data(p.frame), p.afterMs > 0]), [['fix the bug', false], ['\r', true]]);
  assert.ok(plan.every(p => JSON.parse(p.frame).type === 'input'));
});

test('a multi-line message is ONE bracketed paste when the CLI asked for it, then Enter', () => {
  const plan = planChatSend('line one\nline two', { bracketed: true });
  assert.deepStrictEqual(plan.map(p => data(p.frame)), ['\x1b[200~line one\rline two\x1b[201~', '\r']);
});

test('a multi-line message without bracketed paste uses Shift+Enter\'s bytes, so no line submits early', () => {
  const plan = planChatSend('a\nb\nc', { bracketed: false });
  assert.deepStrictEqual(plan.map(p => data(p.frame)), ['a\x1b\rb\x1b\rc', '\r']);
});

test('nothing to send is no frames', () => {
  assert.deepStrictEqual(planChatSend('   \n ', { bracketed: true }), []);
  assert.deepStrictEqual(planChatSend(undefined, {}), []);
});

test('property: the only bytes that reach the pty are the person\'s printable text, the paste brackets, Shift+Enter joins and one final Enter', () => {
  fc.assert(fc.property(fc.string({ maxLength: 80 }), fc.boolean(), (raw, bracketed) => {
    const plan = planChatSend(raw, { bracketed });
    if (plan.length === 0) return sanitizeInput(raw) === '';
    if (plan.length !== 2 || data(plan[1].frame) !== '\r') return false;
    let body = data(plan[0].frame);
    if (body.startsWith('\x1b[200~')) {
      if (!body.endsWith('\x1b[201~')) return false;
      body = body.slice(6, -6).replace(/\r/g, '\n');
    } else {
      body = body.replace(/\x1b\r/g, '\n');
    }
    // after undoing the wrappers, no escape or carriage return is left: the text could not have broken out
    return !/[\x00-\x08\x0b-\x1f\x7f]/.test(body) && body === sanitizeInput(raw);
  }));
});

test('property: text typed by the person can never close the bracketed paste early', () => {
  fc.assert(fc.property(fc.array(fc.constantFrom('\x1b', '[201~', 'a', '\n', ' '), { maxLength: 20 }).map(a => a.join('')), (raw) => {
    const [first] = planChatSend(raw + '\nx', { bracketed: true });
    if (!first) return true;
    const body = data(first.frame);
    // a message that stayed one line is typed as is; a pasted one has its closing bracket exactly once, at the very end
    return !body.startsWith('\x1b[200~') ? !body.includes('\x1b') : body.indexOf('\x1b[201~') === body.length - 6;
  }));
});

test('the wish is remembered per tab, by its folder', () => {
  const store = new Map();
  const storage = { read: (k) => (store.has(k) ? store.get(k) : null), write: (k, v) => store.set(k, v) };
  assert.strictEqual(readWanted(storage, 'C:/a'), false);
  writeWanted(storage, 'C:/a', true);
  assert.strictEqual(readWanted(storage, 'C:/a'), true);
  assert.strictEqual(readWanted(storage, 'C:/b'), false);
  writeWanted(storage, 'C:/a', false);
  assert.strictEqual(readWanted(storage, 'C:/a'), false);
  assert.strictEqual(readWanted(null, 'C:/a'), false);
  assert.doesNotThrow(() => writeWanted({ read() { throw new Error('x'); }, write() { throw new Error('x'); } }, 'C:/a', true));
  assert.strictEqual(readWanted({ read() { throw new Error('x'); } }, 'C:/a'), false);
});
