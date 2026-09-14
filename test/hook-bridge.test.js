'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { createHookBridge } = require('../host/hook-bridge');

const pipeName = () => `\\\\.\\pipe\\claude-custom-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

// Writes one framed line to the bridge exactly as the native helper will.
function sendLine(name, line) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(name, () => sock.end(line + '\n'));
    sock.on('close', resolve);
    sock.on('error', reject);
  });
}

const nextEvent = bridge => new Promise(resolve => bridge.once('event', resolve));

test('receives a hook event written to the pipe', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: name });
  await bridge.listening;
  const got = nextEvent(bridge);
  await sendLine(name, JSON.stringify({ event: 'PreToolUse', payload: { subagent_type: 'code-reviewer' } }));
  const ev = await got;
  assert.strictEqual(ev.event, 'PreToolUse');
  assert.strictEqual(ev.payload.subagent_type, 'code-reviewer');
  await bridge.close();
});

test('handles several events arriving on one connection', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: name });
  await bridge.listening;

  const seen = [];
  bridge.on('event', e => seen.push(e.event));

  await new Promise((resolve, reject) => {
    const sock = net.connect(name, () => {
      sock.end(
        JSON.stringify({ event: 'PreToolUse', payload: {} }) + '\n' +
        JSON.stringify({ event: 'PostToolUse', payload: {} }) + '\n' +
        JSON.stringify({ event: 'SubagentStop', payload: {} }) + '\n'
      );
    });
    sock.on('close', resolve);
    sock.on('error', reject);
  });

  await new Promise(r => setTimeout(r, 120));
  assert.deepStrictEqual(seen, ['PreToolUse', 'PostToolUse', 'SubagentStop']);
  await bridge.close();
});

test('a partial line is buffered until its newline arrives', async () => {
  // A pipe write can split anywhere. Parsing per-chunk would drop or corrupt
  // events under exactly the load the mood engine cares about.
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: name });
  await bridge.listening;
  const got = nextEvent(bridge);

  const full = JSON.stringify({ event: 'PostToolUse', payload: { ok: true } }) + '\n';
  await new Promise((resolve, reject) => {
    const sock = net.connect(name, () => {
      sock.write(full.slice(0, 12));
      setTimeout(() => sock.end(full.slice(12)), 40);
    });
    sock.on('close', resolve);
    sock.on('error', reject);
  });

  const ev = await got;
  assert.strictEqual(ev.event, 'PostToolUse');
  assert.strictEqual(ev.payload.ok, true);
  await bridge.close();
});

test('malformed JSON does not crash the bridge or stop later events', async () => {
  // The bridge sits in the host process. A hook writing junk must not take the
  // session down with it.
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: name });
  await bridge.listening;

  const errors = [];
  bridge.on('parse-error', e => errors.push(e));
  const got = nextEvent(bridge);

  await sendLine(name, '{not json');
  await sendLine(name, JSON.stringify({ event: 'SubagentStop', payload: {} }));

  const ev = await got;
  assert.strictEqual(ev.event, 'SubagentStop');
  assert.strictEqual(errors.length, 1);
  await bridge.close();
});

test('close releases the pipe so a new bridge can bind the same name', async () => {
  // Detach/reattach and host restarts both depend on this.
  const name = pipeName();
  const first = createHookBridge({ pipeName: name });
  await first.listening;
  await first.close();

  const second = createHookBridge({ pipeName: name });
  await second.listening;
  const got = nextEvent(second);
  await sendLine(name, JSON.stringify({ event: 'PreToolUse', payload: {} }));
  assert.strictEqual((await got).event, 'PreToolUse');
  await second.close();
});
