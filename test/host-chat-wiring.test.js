'use strict';
/**
 * host.js's half of the chat view (BACKLOG #157): source assertions in the style of test/host-bar-wiring.test.js, because
 * host.js can't be loaded by a unit test. The behaviour runs end to end in verify/probe-chat-view.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const WRITER = fs.readFileSync(path.join(__dirname, '..', 'host', 'settings-writer.js'), 'utf8');

function handlerBody() {
  const start = HOST.indexOf("hookBridge.on('event', (ev) => {");
  assert.ok(start !== -1, 'the hook bridge event handler');
  return HOST.slice(start, HOST.indexOf("hookBridge.on('parse-error'", start));
}

test('the feed is built once, from the hooks the harness already registers (no new matcher is needed)', () => {
  assert.match(HOST, /const \{ createChatFeed \} = require\('\.\/chat-feed'\);/);
  assert.match(HOST, /const \{ readTranscript, readLastTurnTexts \} = require\('\.\/chat-transcript'\);/);
  assert.strictEqual((HOST.match(/createChatFeed\(\)/g) || []).length, 1);
  assert.match(WRITER, /UserPromptSubmit: \[entry\('', 'UserPromptSubmit'\)\]/);
  assert.match(WRITER, /Stop: \[entry\('', 'Stop'\)\]/);
});

test('every hook event reaches the feed, before the early returns, after the Status document', () => {
  const body = handlerBody();
  const at = body.indexOf('noteChat(ev);');
  assert.ok(at !== -1, 'noteChat(ev) is called');
  assert.strictEqual((body.match(/noteChat\(/g) || []).length, 1);
  assert.ok(at > body.indexOf("if (ev.event === 'Status')"), 'the Status document is not a hook');
  assert.ok(at < body.indexOf('if (isOccupancyOnly(ev)) { mood.handle(ev); return; }'), 'before the occupancy-only return');
});

test('a Stop reads the turn\'s whole text from the transcript and swaps it into that reply (Ricardo, live: only the closing line showed)', () => {
  const fn = HOST.slice(HOST.indexOf('function noteChat(ev) {'), HOST.indexOf('function noteChat(ev) {') + 1800);
  assert.match(fn, /ev\.event === 'Stop' && changed/);
  assert.match(fn, /payload\.transcript_path/);
  assert.match(fn, /readLastTurnTexts\(from\)/);
  assert.match(fn, /chatFeed\.expandReply\(id, blocks\)/);
});

test('a change is pushed as { type: chat }, and the transcript is read only after a SessionStart', () => {
  const fn = HOST.slice(HOST.indexOf('function noteChat(ev) {'), HOST.indexOf('function noteChat(ev) {') + 1800);
  assert.match(fn, /broadcastControl\(\{ type: 'chat', chat: chatFeed\.snapshot\(\) \}\)/);
  assert.match(fn, /if \(ev\.event !== 'SessionStart'\) return;/);
  assert.match(fn, /readTranscript\(file\)/);
  assert.match(fn, /\.catch\(/);
});

test('the person\'s words and Claude\'s replies are never logged by the chat wiring', () => {
  const fn = HOST.slice(HOST.indexOf('function noteChat(ev) {'), HOST.indexOf('function noteChat(ev) {') + 800);
  assert.doesNotMatch(fn, /console\.log/);
});

test('hello carries the conversation, for a window that attaches mid-session', () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf("type: 'hello',") + 4500);
  assert.match(hello, /\n\s+chat: chatFeed\.snapshot\(\),/);
});
