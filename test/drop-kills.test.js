'use strict';
/**
 * Kill tests for Mortimer's release-gate survivor S24 (2026-10-09), host/drop.js half: the `!dir` refusal in
 * refusalFor, the `cfgKey` config-dir guard, and `dir || entry.path` in the refused record. drop.js decides which
 * folders a drag grants to a session, so each is asserted by the refusal it produces.
 */
const test = require('node:test');
const assert = require('node:assert');

const { planDrop, normSlashes } = require('../host/drop');

const CWD = 'C:/w/proj';
const at = (p, isDirectory = false) => ({ path: p, isDirectory });
const keys = arr => arr.map(normSlashes);

test('S24: a relative path is refused as "not absolute", and the refusal names the path as dropped', () => {
  const plan = planDrop({ entries: [at('notes/readme.txt')], cwd: CWD });
  assert.deepStrictEqual(plan.dirsToAdd, []);
  assert.strictEqual(plan.refused.length, 1);
  // `dir || entry.path`: the resolved dir is '' here, so the record falls back to the entry's own path.
  assert.strictEqual(plan.refused[0].dir, 'notes/readme.txt');
  // `!dir` -> false would reach isRootish('') and report "a drive, share or filesystem root" instead.
  assert.match(plan.refused[0].why, /not absolute/);
});

test('S24: a refusal names the FOLDER being refused, not the dropped file inside it', () => {
  const plan = planDrop({ entries: [at('C:/other/.ssh/id_rsa')], cwd: CWD });
  assert.deepStrictEqual(plan.dirsToAdd, []);
  assert.strictEqual(plan.refused.length, 1);
  assert.strictEqual(normSlashes(plan.refused[0].dir), 'c:/other/.ssh', 'dir differs from entry.path, and dir wins when it is set');
  assert.match(plan.refused[0].why, /\.ssh/);
});

test('S24: with a configDir, that folder and anything inside it is refused as holding credentials', () => {
  const configDir = 'D:/cfg/claude-home';
  for (const p of ['D:/cfg/claude-home', 'D:/cfg/claude-home/projects/x']) {
    const plan = planDrop({ entries: [at(p, true)], cwd: CWD, configDir });
    assert.deepStrictEqual(plan.dirsToAdd, [], p);
    assert.strictEqual(plan.refused.length, 1, p);
    assert.match(plan.refused[0].why, /Claude config directory holds credentials/, p);
  }
});

test('S24: with a configDir, a folder that CONTAINS it is refused too', () => {
  const plan = planDrop({ entries: [at('D:/cfg', true)], cwd: CWD, configDir: 'D:/cfg/claude-home' });
  assert.deepStrictEqual(plan.dirsToAdd, []);
  assert.strictEqual(plan.refused.length, 1);
  assert.match(plan.refused[0].why, /contains the Claude config directory/);
});

test('S24: a sibling that merely shares the configDir\'s name prefix is NOT refused', () => {
  const plan = planDrop({ entries: [at('D:/cfg/claude-home-extra', true)], cwd: CWD, configDir: 'D:/cfg/claude-home' });
  assert.deepStrictEqual(keys(plan.dirsToAdd), ['d:/cfg/claude-home-extra']);
  assert.deepStrictEqual(plan.refused, []);
});

test('S24: with NO configDir the same folders are granted (the guard is not a blanket refusal)', () => {
  for (const configDir of [null, undefined, '']) {
    const plan = planDrop({ entries: [at('D:/cfg/claude-home/projects', true)], cwd: CWD, configDir });
    assert.deepStrictEqual(keys(plan.dirsToAdd), ['d:/cfg/claude-home/projects'], String(configDir));
    assert.deepStrictEqual(plan.refused, [], String(configDir));
  }
});
