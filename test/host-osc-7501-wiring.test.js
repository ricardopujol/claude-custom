'use strict';
/**
 * OSC 7501 (BACKLOG #116): the wiring in host/host.js. The decisions are pure and tested elsewhere (program-status.test.js,
 * parse-gate.test.js, terminal-state.test.js, attention.test.js); these pin that the host USES them, in the order that
 * matters. host.js cannot be required (it starts a server), so these are source assertions, and verify/probe-osc-7501.js
 * is the live proof of the same rules.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const code = HOST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

test('the pty data is fed to the headless terminal with the parse gate tracking each chunk', () => {
  assert.match(code, /termState\.write\(data, parseGate\.track\(\)\)/);
});

test('every path that types into the pty goes through the gate; nothing else calls term.write with input', () => {
  const writes = code.match(/\bterm\.write\(/g) || [];
  // the gate's own sender, the queued drop lines (enqueuePty), the 7501 reply, and the terminal's own answer when no window is there
  const allowed = ['parseGate.submit(data, (d) => { if (term) term.write(d); })', 'term.write(next)', 'term.write(QUERY_REPLY)', 'term.write(answer)'];
  for (const a of allowed) assert.ok(code.includes(a), `expected ${a}`);
  assert.strictEqual(writes.length, allowed.length, 'a new term.write that bypasses the gate would let a DA1 answer overtake the 7501 reply');
  assert.match(code, /if \(typeof msg\.data === 'string' && term\) writeInput\(msg\.data\)/);
  assert.match(code, /\(t\) => \{ if \(term\) writeInput\(t\); \}/);
  assert.match(code, /if \(term\) writeInput\(raw\.toString\('utf8'\)\)/);
});

test('the query is answered inside the parse handler, synchronously, to the pty', () => {
  const start = code.indexOf('function onProgramStatusOsc');
  assert.ok(start !== -1);
  const body = code.slice(start, code.indexOf('\n}', start));
  assert.match(body, /parsed\.query/);
  assert.match(body, /term\.write\(QUERY_REPLY\)/);
  assert.doesNotMatch(body, /await|setTimeout|setImmediate|then\(|nextTick/, 'the reply must not be deferred');
});

test('the terminal state is created with the three 7501 hooks', () => {
  const start = code.indexOf('const termState = createTerminalState(');
  const body = code.slice(start, code.indexOf('});', start));
  for (const k of ['onProgramStatus: onProgramStatusOsc', 'onPromptStart', 'onReset']) assert.ok(body.includes(k), k);
  assert.match(body, /programStatus\.dropActive\(\)/);
  assert.match(body, /programStatus\.reset\(\)/);
});

test('a change is broadcast as a program-status control frame, handed to attention, and sent in the hello', () => {
  const start = code.indexOf('function publishProgramStatus');
  const body = code.slice(start, code.indexOf('\n}', start));
  assert.match(body, /broadcastControl\(\{ type: 'program-status', \.\.\.snapshot \}\)/);
  assert.match(body, /attention\.programStatus\(snapshot\)/);
  assert.match(code, /programStatus: programStatus\.snapshot\(\)/);
});

test('the pty is spawned with the ConPTY choice, so the 7501 query reaches the host (measured: the OS ConPTY answers DA1 itself and drops the reply)', () => {
  assert.match(code, /\.\.\.ptyWindowsOptions\(process\.env\)/);
});

test('the terminal\'s own answers are sent on to the pty only while no window is attached, straight from the parse', () => {
  const start = code.indexOf('const termState = createTerminalState(');
  const body = code.slice(start, code.indexOf('});', start));
  assert.match(body, /onResponse: \(answer\) => \{ if \(!windowAttached\(\) && term\) term\.write\(answer\); \}/);
  assert.match(code, /const windowAttached = \(\) => \[\.\.\.clients\]\.some\(\(c\) => c\.isWindow === true\)/);
  assert.match(code, /ws\.isWindow = !isControlClient\(req && req\.url\)/);
});
