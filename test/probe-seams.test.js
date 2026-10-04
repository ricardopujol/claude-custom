'use strict';
/**
 * The git panel's probe seams (host/probe-seams.js). PR #93 Miguel I5: they're read in the production host,
 * so when one is set it must be visible (logged once), and a fixture that can't be read must say so instead
 * of looking like gh being down.
 */
const test = require('node:test');
const assert = require('node:assert');

const { readSeams, announce, fixtureReader, SEAMS } = require('../host/probe-seams');
const { parseOpenPrs } = require('../host/open-prs');

test('readSeams: unset in real use is no seam at all', () => {
  assert.deepStrictEqual(readSeams({}), { openPrsFixture: null, projectsDir: null, reviewsDir: null, claudeHome: null, active: [] });
  assert.deepStrictEqual(readSeams({ CLAUDE_CUSTOM_REVIEWS_DIR: '' }).active, [], 'an empty value is unset');
});

test('readSeams: each seam, and which are active', () => {
  const s = readSeams({ CLAUDE_CUSTOM_OPEN_PRS_FIXTURE: 'C:/p/prs.json', CLAUDE_CUSTOM_REVIEWS_DIR: 'C:/p/reviews', OTHER: 'x' });
  assert.strictEqual(s.openPrsFixture, 'C:/p/prs.json');
  assert.strictEqual(s.reviewsDir, 'C:/p/reviews');
  assert.strictEqual(s.projectsDir, null);
  assert.deepStrictEqual(s.active, ['CLAUDE_CUSTOM_OPEN_PRS_FIXTURE', 'CLAUDE_CUSTOM_REVIEWS_DIR']);
  assert.deepStrictEqual(SEAMS, ['CLAUDE_CUSTOM_OPEN_PRS_FIXTURE', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_REVIEWS_DIR', 'CLAUDE_CUSTOM_CLAUDE_HOME']);
  assert.strictEqual(readSeams({ CLAUDE_CUSTOM_CLAUDE_HOME: 'C:/p/claude' }).claudeHome, 'C:/p/claude');
});

test('Miguel I5: announce logs one line naming every active seam, and nothing when none is set', () => {
  const lines = [];
  assert.strictEqual(announce(readSeams({}), (l) => lines.push(l)), false);
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(announce(readSeams({ CLAUDE_CUSTOM_GIT_PROJECTS_DIR: 'C:/p' }), (l) => lines.push(l)), true);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /CLAUDE_CUSTOM_GIT_PROJECTS_DIR/);
  assert.match(lines[0], /probe/);
});

test('Miguel I5: an unreadable or malformed fixture answers unknown AND says so, once, never silently', async () => {
  const lines = [];
  const missing = fixtureReader('C:/nope/prs.json', { parse: parseOpenPrs, log: (l) => lines.push(l),
    readFile: () => { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; } });
  assert.strictEqual(await missing(), null);
  assert.strictEqual(await missing(), null);
  assert.strictEqual(lines.length, 1, 'logged once, not on every refresh');
  assert.match(lines[0], /C:\/nope\/prs\.json/);
  assert.match(lines[0], /ENOENT/);
  const junk = fixtureReader('C:/p/prs.json', { parse: parseOpenPrs, log: (l) => lines.push(l), readFile: () => '{not json' });
  assert.strictEqual(await junk(), null);
  assert.match(lines[1], /not gh pr list JSON/);
});

test('a readable fixture is parsed like gh\'s own answer', async () => {
  const read = fixtureReader('C:/p/prs.json', { parse: parseOpenPrs, log: () => assert.fail('nothing to say'),
    readFile: () => JSON.stringify([{ number: 91, title: 't', headRefName: 'feat/b' }]) });
  const m = await read();
  assert.deepStrictEqual([...m.entries()], [['feat/b', { pr: 91, title: 't' }]]);
});

