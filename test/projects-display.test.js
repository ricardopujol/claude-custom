'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { projectsDisplay } = require('../app/projects-display');

const p = (over = {}) => ({
  path: 'C:/a/thing', name: 'thing', approximate: false,
  lastUsed: Date.now(), tokens: 0, sessions: 1, current: false, ...over,
});

test('the project you are in is marked and not offered as a destination', () => {
  const { rows } = projectsDisplay({ ok: true, projects: [p({ current: true })] });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].current, true);
  assert.strictEqual(rows[0].openable, false, 'clicking it would open the window you are in');
});

test('another project IS offered as a destination', () => {
  const { rows } = projectsDisplay({ ok: true, projects: [p({ current: false })] });
  assert.strictEqual(rows[0].openable, true);
});

test('a failed read says so instead of showing an empty history', () => {
  // `ok:false` means we could not read ~/.claude/projects. Drawing that as "no
  // recent projects" is the absence-reported-as-zero bug in panel form.
  const { note } = projectsDisplay({ ok: false, projects: [] });
  assert.match(note, /could not/i);
});

test('an empty history reads as new, not as broken', () => {
  const { note } = projectsDisplay({ ok: true, projects: [] });
  assert.doesNotMatch(note, /could not/i);
  assert.match(note, /no other/i);
});

test('a path recovered only from a folder name is marked approximate', () => {
  // recent.js cannot always recover the real path: the folder name is a lossy
  // encoding, so "claude-custom" and "claude/custom" are indistinguishable. A
  // row that might be wrong must not look identical to one that is known.
  const { rows } = projectsDisplay({ ok: true, projects: [p({ approximate: true })] });
  assert.strictEqual(rows[0].approximate, true);
  assert.match(rows[0].title, /approximate|guess/i);
});

test('token counts are never invented for a project with none', () => {
  // Number(null) is 0, the trap this codebase names in its own CLAUDE.md. A
  // project whose transcripts carry no usage must not be drawn as "0 tokens",
  // which reads as a fact about the project rather than about our knowledge.
  const { rows } = projectsDisplay({ ok: true, projects: [p({ tokens: null })] });
  assert.doesNotMatch(rows[0].detail, /\b0\b/);
});

test('a real token count IS shown', () => {
  const { rows } = projectsDisplay({ ok: true, projects: [p({ tokens: 1234567 })] });
  assert.match(rows[0].detail, /1\.2M|1234567|1,234,567/);
});
