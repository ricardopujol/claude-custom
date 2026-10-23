'use strict';
/**
 * BACKLOG #119 A1, design point 4: quota meters follow the tab's profile. A host started under a profile gets that profile's folder as
 * CLAUDE_CONFIG_DIR (host/tab-env.js); the quota files and the credentials are then keyed by that same folder, so two profiles never
 * share a meter and a poller lease stays one per (machine, profile).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { hostEnv } = require('../host/tab-env');
const { claudeConfigDir } = require('../host/claude-config-dir');
const { quotaPath, leasePath, accountKey } = require('../host/quota-share');
const { defaultCredentialsPath } = require('../host/quota');

const FLAT = { kind: 'flat', root: 'C:\\repo', dev: 'C:\\repo' };
const DIR = 'C:\\Users\\x\\.claude-custom';
const WORK = 'C:\\Users\\x\\.claude-profiles\\work';
const PLAY = 'C:\\Users\\x\\.claude-profiles\\play';

test('two profile folders never share a quota file or a poller lease', () => {
  assert.notStrictEqual(quotaPath(DIR, WORK), quotaPath(DIR, PLAY));
  assert.notStrictEqual(leasePath(DIR, WORK), leasePath(DIR, PLAY));
  assert.notStrictEqual(accountKey(WORK), accountKey(path.join(require('os').homedir(), '.claude')));
});

test('one profile folder is one file and one lease, however its path is spelled', () => {
  assert.strictEqual(quotaPath(DIR, WORK), quotaPath(DIR, WORK));
  if (process.platform === 'win32') assert.strictEqual(quotaPath(DIR, WORK), quotaPath(DIR, WORK.toUpperCase()));
});

test('a host started under a profile reads credentials and the quota file from that profile\'s folder', () => {
  const env = hostEnv({}, { cwd: 'C:\\repo', port: 4100, token: 't', project: FLAT, configDir: WORK, profileId: 'work' });
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;       // what the host process sees at boot
  try {
    assert.strictEqual(claudeConfigDir(), WORK);
    assert.strictEqual(defaultCredentialsPath(), path.join(WORK, '.credentials.json'));
    assert.strictEqual(quotaPath(DIR), quotaPath(DIR, WORK));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
