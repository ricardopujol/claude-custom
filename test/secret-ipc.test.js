'use strict';
/**
 * The bridge between the window and the vault.
 *
 * Split out of main.js so the rules can be asserted without launching Electron.
 * These are the rules that decide whether a secret ever reaches a place it
 * should not, so they get tested rather than reviewed.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createSecretService } = require('../app/secret-service');

function service(overrides = {}) {
  const store = new Map();
  const clipboard = { value: '', writes: [] };
  const vault = {
    available: () => true,
    list: () => [...store.values()].map(e => ({ id: e.id, label: e.label, note: '', createdAt: 0 })),
    add: ({ label, secret }) => {
      const id = 'id' + store.size;
      store.set(id, { id, label, secret });
      return { id, label, note: '', createdAt: 0 };
    },
    get: (id) => (store.get(id) ? store.get(id).secret : null),
    remove: (id) => store.delete(id),
  };
  return {
    svc: createSecretService({
      vault,
      clipboard: {
        writeText: (t) => { clipboard.value = t; clipboard.writes.push(t); },
        readText: () => clipboard.value,
        clear: () => { clipboard.value = ''; },
      },
      ...overrides,
    }),
    clipboard,
    vault,
  };
}

test('copy puts the secret on the OS clipboard', () => {
  const { svc, clipboard } = service();
  const e = svc.add({ label: 'k', secret: 'sk-live-123' }).entry;
  const res = svc.copy(e.id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(clipboard.value, 'sk-live-123');
});

test('copy NEVER returns the secret to the caller', () => {
  // The window asked for a copy, not for the value. Returning it would put the
  // secret in the renderer for no reason, where a stray console.log finds it.
  const { svc } = service();
  const e = svc.add({ label: 'k', secret: 'sk-live-123' }).entry;
  assert.ok(!JSON.stringify(svc.copy(e.id)).includes('sk-live-123'));
});

test('the clipboard is cleared after the timeout', () => {
  let scheduled = null;
  const { svc, clipboard } = service({ setTimer: (fn, ms) => { scheduled = { fn, ms }; return 1; } });
  const e = svc.add({ label: 'k', secret: 'sk-live-123' }).entry;
  svc.copy(e.id);
  assert.ok(scheduled, 'no clear was scheduled');
  scheduled.fn();
  assert.strictEqual(clipboard.value, '');
});

test('the clear does NOT wipe something the user copied since', () => {
  // Clearing unconditionally would eat whatever they copied in the meantime,
  // which is someone else's work destroyed by a feature they were not using.
  let scheduled = null;
  const { svc, clipboard } = service({ setTimer: (fn) => { scheduled = { fn }; return 1; } });
  const e = svc.add({ label: 'k', secret: 'sk-live-123' }).entry;
  svc.copy(e.id);
  clipboard.value = 'something the user copied afterwards';
  scheduled.fn();
  assert.strictEqual(clipboard.value, 'something the user copied afterwards');
});

test('copying a second secret reschedules, so the first clear cannot wipe it early', () => {
  const timers = [];
  const cleared = [];
  const { svc } = service({
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => cleared.push(id),
  });
  const a = svc.add({ label: 'a', secret: 'one' }).entry;
  const b = svc.add({ label: 'b', secret: 'two' }).entry;
  svc.copy(a.id);
  svc.copy(b.id);
  assert.ok(cleared.length >= 1, 'the first clear timer was never cancelled');
});

test('copying an unknown id reports failure instead of clearing the clipboard', () => {
  const { svc, clipboard } = service();
  clipboard.value = 'unrelated';
  const res = svc.copy('nope');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(clipboard.value, 'unrelated');
});

test('reveal returns the secret, because that is what it is for', () => {
  // The one path that hands a secret to the window. It exists because a value
  // that can never be seen cannot be checked against the service it belongs to.
  const { svc } = service();
  const e = svc.add({ label: 'k', secret: 'sk-live-123' }).entry;
  assert.strictEqual(svc.reveal(e.id).secret, 'sk-live-123');
});

test('list is free of secrets', () => {
  const { svc } = service();
  svc.add({ label: 'k', secret: 'sk-live-123' });
  assert.ok(!JSON.stringify(svc.list()).includes('sk-live-123'));
});

test('search matches labels only, never secret values', () => {
  // A search that matched secret text would put a secret on screen for a typo,
  // and the person typing would not know they had done it.
  const { svc } = service();
  svc.add({ label: 'github', secret: 'correct-horse' });
  assert.strictEqual(svc.list({ query: 'github' }).length, 1);
  assert.strictEqual(svc.list({ query: 'correct-horse' }).length, 0);
});

test('search is case-insensitive, since labels are typed casually', () => {
  const { svc } = service();
  svc.add({ label: 'GitHub Token', secret: 's' });
  assert.strictEqual(svc.list({ query: 'github' }).length, 1);
});

test('an unavailable vault reports why rather than failing silently', () => {
  const { svc } = service();
  const broken = createSecretService({
    vault: { available: () => false, list: () => [], add: () => { throw new Error('encryption is unavailable'); } },
    clipboard: { writeText() {}, readText: () => '', clear() {} },
  });
  assert.strictEqual(broken.available(), false);
  const res = broken.add({ label: 'k', secret: 's' });
  assert.strictEqual(res.ok, false);
  assert.ok(/encryption/i.test(res.error), res.error);
  assert.strictEqual(svc.available(), true);
});
