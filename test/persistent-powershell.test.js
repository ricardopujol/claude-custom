'use strict';
/**
 * host/persistent-powershell.js (BACKLOG #100 c): ONE long-lived powershell.exe fed one script per sample over stdin,
 * instead of a fresh process per sample. Fake child for the protocol; one real powershell.exe at the end, because the
 * stdin protocol is the thing a fake cannot check.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const P = require('../host/persistent-powershell');

function fakeSpawn() {
  const children = [];
  const spawn = (file, args) => {
    const c = new EventEmitter();
    c.pid = 1000 + children.length;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.written = [];
    c.stdin = { write: (s) => { c.written.push(s); return true; }, end: () => {}, on: () => {} };
    c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); return true; };
    c.file = file; c.args = args;
    children.push(c);
    return c;
  };
  return { spawn, children };
}
const settle = () => new Promise(r => setImmediate(r));
const decode = (line) => {
  const m = /FromBase64String\('([^']*)'\)/.exec(line);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
};
const scripts = (child) => child.written.map(decode).filter(s => s !== null);

function fakeTimers() {
  const list = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; list.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    fire: (ms) => { const t = list.find(x => x.live && x.ms === ms); if (!t) throw new Error('no live timer of ' + ms); t.live = false; t.fn(); },
    live: () => list.filter(t => t.live),
  };
}

test('the first call spawns ONE shell on its stdin (-Command -), sets UTF-8 first, and sends the script base64-encoded on one line', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const p = exec('Write-Output "é"\n"END"');
  await settle();
  assert.strictEqual(children.length, 1);
  assert.deepStrictEqual(children[0].args.slice(-2), ['-Command', '-']);
  assert.ok(children[0].args.includes('-NoProfile') && children[0].args.includes('-NonInteractive'));
  assert.match(children[0].written[0], /OutputEncoding/);
  assert.deepStrictEqual(scripts(children[0]), ['Write-Output "é"\n"END"']);
  assert.ok(children[0].written.slice(1).every(l => l.endsWith('\n') && l.indexOf('\n') === l.length - 1), 'each script is exactly one line');
  children[0].stdout.emit('data', Buffer.from('hello\r\nEND\r\n'));
  assert.strictEqual(await p, 'hello\r\nEND\r\n');
});

test('later calls reuse the same shell: no second spawn', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const a = exec('one');
  await settle();
  children[0].stdout.emit('data', Buffer.from('a\nEND\n'));
  await a;
  const b = exec('two');
  await settle();
  children[0].stdout.emit('data', Buffer.from('b\nEND\n'));
  assert.strictEqual(await b, 'b\nEND\n');
  assert.strictEqual(children.length, 1);
  assert.deepStrictEqual(scripts(children[0]), ['one', 'two']);
});

test('output split across chunks, and an END that ends a chunk inside a line, are not the end', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const p = exec('x');
  await settle();
  const c = children[0];
  c.stdout.emit('data', Buffer.from('{"cmd":"C:\\\\tools\\\\LEGEND'));
  c.stdout.emit('data', Buffer.from('"}\r\nEN'));
  c.stdout.emit('data', Buffer.from('D\r\n'));
  assert.strictEqual(await p, '{"cmd":"C:\\\\tools\\\\LEGEND"}\r\nEND\r\n');
});

test('multi-byte characters split across two chunks decode whole', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const p = exec('x');
  await settle();
  const bytes = Buffer.from('caf\u00e9 \u2603\r\nEND\r\n', 'utf8');
  children[0].stdout.emit('data', bytes.subarray(0, 4));
  children[0].stdout.emit('data', bytes.subarray(4, 9));
  children[0].stdout.emit('data', bytes.subarray(9));
  assert.strictEqual(await p, 'caf\u00e9 \u2603\r\nEND\r\n');
});

test('calls made while one is in flight run one after the other, never interleaved', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const a = exec('first');
  const b = exec('second');
  await settle();
  assert.deepStrictEqual(scripts(children[0]), ['first'], 'the second waits for the first');
  children[0].stdout.emit('data', Buffer.from('1\nEND\n'));
  assert.strictEqual(await a, '1\nEND\n');
  await settle();
  assert.deepStrictEqual(scripts(children[0]), ['first', 'second']);
  children[0].stdout.emit('data', Buffer.from('2\nEND\n'));
  assert.strictEqual(await b, '2\nEND\n');
});

test('a call that outlives its timeout kills THAT shell by handle, rejects, and the next call starts a fresh one', async () => {
  const { spawn, children } = fakeSpawn();
  const timers = fakeTimers();
  const exec = P.createPersistentExec({ spawn, timeoutMs: 20000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const p = exec('slow');
  await settle();
  timers.fire(20000);
  await assert.rejects(p, /timed out/);
  assert.strictEqual(children[0].killed, true);
  const q = exec('again');
  await settle();
  assert.strictEqual(children.length, 2, 'a new shell');
  children[1].stdout.emit('data', Buffer.from('ok\nEND\n'));
  assert.strictEqual(await q, 'ok\nEND\n');
});

test('a late answer from the shell that timed out never leaks into the next call', async () => {
  const { spawn, children } = fakeSpawn();
  const timers = fakeTimers();
  const exec = P.createPersistentExec({ spawn, timeoutMs: 20000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const p = exec('slow');
  await settle();
  timers.fire(20000);
  await assert.rejects(p);
  const q = exec('next');
  await settle();
  children[0].stdout.emit('data', Buffer.from('LATE\nEND\n'));
  children[1].stdout.emit('data', Buffer.from('right\nEND\n'));
  assert.strictEqual(await q, 'right\nEND\n');
});

test('a shell that dies mid-call rejects the call; the next call spawns again', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const p = exec('x');
  await settle();
  children[0].emit('exit', 1, null);
  await assert.rejects(p, /exited/);
  const q = exec('y');
  await settle();
  assert.strictEqual(children.length, 2);
  children[1].stdout.emit('data', Buffer.from('y\nEND\n'));
  await q;
});

test('a spawn error rejects the call and is not remembered: the next call tries again', async () => {
  let n = 0;
  const { spawn: inner, children } = fakeSpawn();
  const spawn = (...a) => { n++; const c = inner(...a); if (n === 1) setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; };
  const exec = P.createPersistentExec({ spawn });
  await assert.rejects(exec('x'), /ENOENT/);
  const q = exec('y');
  await settle();
  children[1].stdout.emit('data', Buffer.from('y\nEND\n'));
  assert.strictEqual(await q, 'y\nEND\n');
});

test('after maxUses answers the shell is replaced (a long-lived PowerShell is bounded, not left to grow)', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn, maxUses: 2 });
  for (let i = 0; i < 3; i++) {
    const p = exec('s' + i);
    await settle();
    children[children.length - 1].stdout.emit('data', Buffer.from('r\nEND\n'));
    await p;
    await settle();
  }
  assert.strictEqual(children.length, 2, 'the third call runs on a second shell');
  assert.strictEqual(children[0].killed, true);
});

test('idle: a shell nobody has asked anything of for idleMs is ended, and the next call starts one', async () => {
  const { spawn, children } = fakeSpawn();
  const timers = fakeTimers();
  const exec = P.createPersistentExec({ spawn, idleMs: 60000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const p = exec('x');
  await settle();
  children[0].stdout.emit('data', Buffer.from('r\nEND\n'));
  await p;
  timers.fire(60000);
  assert.strictEqual(children[0].killed, true);
  const q = exec('y');
  await settle();
  assert.strictEqual(children.length, 2);
  children[1].stdout.emit('data', Buffer.from('r\nEND\n'));
  await q;
});

test('close() ends the shell by its own handle and refuses later calls; kill() on the promise does the same for that call', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  const p = exec('x');
  await settle();
  p.kill();
  assert.strictEqual(children[0].killed, true);
  await assert.rejects(p);
  exec.close();
  await assert.rejects(exec('y'), /closed/);
  assert.strictEqual(children.length, 1);
});

test('pid() is the live shell\'s pid, or null when none is running', async () => {
  const { spawn, children } = fakeSpawn();
  const exec = P.createPersistentExec({ spawn });
  assert.strictEqual(exec.pid(), null);
  const p = exec('x');
  await settle();
  assert.strictEqual(exec.pid(), children[0].pid);
  children[0].stdout.emit('data', Buffer.from('r\nEND\n'));
  await p;
  exec.close();
  assert.strictEqual(exec.pid(), null);
});

test('REAL powershell.exe: variables persist between calls (one process), non-ASCII survives, and close() ends it', { skip: process.platform !== 'win32' }, async () => {
  const exec = P.createPersistentExec({ timeoutMs: 30000 });
  try {
    const a = await exec("$n = 41\n'caf\u00e9 \u2603'\n'END'");
    assert.match(a, /^caf\u00e9 \u2603\r?\nEND\r?\n$/);
    const pid1 = exec.pid();
    const b = await exec("$n + 1\n'END'");
    assert.match(b, /^42\r?\nEND\r?\n$/);
    assert.strictEqual(exec.pid(), pid1, 'the same process answered both');
  } finally { exec.close(); }
  assert.strictEqual(exec.pid(), null);
});
