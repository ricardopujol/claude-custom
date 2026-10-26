'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePortraitsDir, FLAT_DIR, DEV_DIR } = require('../host/portraits-dir');

const none = () => false;

test('env override wins over everything', () => {
  const exists = () => true;
  assert.equal(resolvePortraitsDir({ CLAUDE_CUSTOM_PORTRAITS: 'X:\\p' }, exists), 'X:\\p');
});

test('dev path wins when it exists', () => {
  const exists = (p) => p === DEV_DIR;
  assert.equal(resolvePortraitsDir({}, exists), DEV_DIR);
});

test('flat path is the fallback when the dev path is absent', () => {
  assert.equal(resolvePortraitsDir({}, none), FLAT_DIR);
});

test('an empty env override is ignored', () => {
  assert.equal(resolvePortraitsDir({ CLAUDE_CUSTOM_PORTRAITS: '' }, none), FLAT_DIR);
});

test('the two defaults are the agent-creator layouts', () => {
  assert.equal(FLAT_DIR, 'C:\\Users\\ricar\\VibeCode\\agent-creator\\portraits');
  assert.equal(DEV_DIR, 'C:\\Users\\ricar\\VibeCode\\agent-creator\\dev\\portraits');
});
