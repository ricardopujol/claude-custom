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
  assert.deepStrictEqual(readSeams({}), { openPrsFixture: null, projectsDir: null, reviewsDir: null, claudeHome: null, ollamaUrl: null, summaryDir: null, summaryPower: null, indexingJournal: null, askRecord: null, askIndexDir: null, uiStateDir: null, gh: null, active: [] });
  assert.deepStrictEqual(readSeams({ CLAUDE_CUSTOM_REVIEWS_DIR: '' }).active, [], 'an empty value is unset');
});

test('readSeams: each seam, and which are active', () => {
  const s = readSeams({ CLAUDE_CUSTOM_OPEN_PRS_FIXTURE: 'C:/p/prs.json', CLAUDE_CUSTOM_REVIEWS_DIR: 'C:/p/reviews', OTHER: 'x' });
  assert.strictEqual(s.openPrsFixture, 'C:/p/prs.json');
  assert.strictEqual(s.reviewsDir, 'C:/p/reviews');
  assert.strictEqual(s.projectsDir, null);
  assert.deepStrictEqual(s.active, ['CLAUDE_CUSTOM_OPEN_PRS_FIXTURE', 'CLAUDE_CUSTOM_REVIEWS_DIR']);
  assert.deepStrictEqual(SEAMS, ['CLAUDE_CUSTOM_OPEN_PRS_FIXTURE', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_REVIEWS_DIR', 'CLAUDE_CUSTOM_CLAUDE_HOME', 'CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_SUMMARY_DIR', 'CLAUDE_CUSTOM_SUMMARY_POWER', 'CLAUDE_CUSTOM_INDEXING_JOURNAL', 'CLAUDE_CUSTOM_ASK_RECORD', 'CLAUDE_CUSTOM_ASK_INDEX_DIR', 'CLAUDE_CUSTOM_UI_STATE_DIR', 'CLAUDE_CUSTOM_GH']);
  assert.strictEqual(readSeams({ CLAUDE_CUSTOM_UI_STATE_DIR: 'C:/p/ui' }).uiStateDir, 'C:/p/ui', 'a probe keeps the UI records (fonts, layouts) out of the real state folder');
  assert.strictEqual(readSeams({ CLAUDE_CUSTOM_CLAUDE_HOME: 'C:/p/claude' }).claudeHome, 'C:/p/claude');
  // the where-are-we summary (verify/probe-where-summary.js): a fake Ollama, and a throwaway summaries/slot folder
  const sm = readSeams({ CLAUDE_CUSTOM_OLLAMA_URL: 'http://127.0.0.1:5555', CLAUDE_CUSTOM_SUMMARY_DIR: 'C:/p/sum' });
  assert.strictEqual(sm.ollamaUrl, 'http://127.0.0.1:5555');
  assert.strictEqual(sm.summaryDir, 'C:/p/sum');
  assert.deepStrictEqual(sm.active, ['CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_SUMMARY_DIR']);
  // the probe must not depend on whether the machine running it is plugged in: only 'mains' and 'battery' mean anything
  assert.strictEqual(readSeams({ CLAUDE_CUSTOM_SUMMARY_POWER: 'mains' }).summaryPower, 'mains');
  assert.strictEqual(readSeams({ CLAUDE_CUSTOM_SUMMARY_POWER: 'battery' }).summaryPower, 'battery');
  assert.strictEqual(readSeams({ CLAUDE_CUSTOM_SUMMARY_POWER: 'solar' }).summaryPower, null);
  assert.deepStrictEqual(readSeams({ CLAUDE_CUSTOM_SUMMARY_POWER: 'solar' }).active, [], 'a value that means nothing is no seam');
});

test('the indexing journal seam (#66): a probe points the strip field at its own journal', () => {
  const s = readSeams({ CLAUDE_CUSTOM_INDEXING_JOURNAL: 'C:/t/j.jsonl' });
  assert.strictEqual(s.indexingJournal, 'C:/t/j.jsonl');
  assert.deepStrictEqual(s.active, ['CLAUDE_CUSTOM_INDEXING_JOURNAL']);
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

