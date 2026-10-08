'use strict';
/**
 * Miguel I1 (PR #64): verify/probe-avatar-roster.js deleted the developer's
 * REAL global default picture and orphaned its children on Ctrl+C.
 * Source assertions: the probe is not run by `npm test` (needs ffmpeg and
 * Electron), so these pin the properties that keep it safe.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROBE = fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-avatar-roster.js'), 'utf8');
const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the host lets a probe redirect its uploads folder', () => {
  assert.match(HOST, /const UPLOADS_DIR = process\.env\.CLAUDE_CUSTOM_UPLOADS \|\| path\.join\(HARNESS_DIR, 'portraits'\);/);
});

test('the probe points the host at a temp uploads folder', () => {
  assert.match(PROBE, /CLAUDE_CUSTOM_UPLOADS: path\.join\(tmp, 'uploads'\)/);
});

test('the probe never deletes anything under the repo\'s real .harness', () => {
  assert.doesNotMatch(PROBE, /rmSync\([^)]*\.harness/);
  assert.doesNotMatch(PROBE, /'\.harness'/);
});

test('both children are registered with the hygiene registry and the registry is installed', () => {
  assert.match(PROBE, /require\('\.\/lib\/process-hygiene'\)/);
  assert.match(PROBE, /hygiene\.install\(\)/);
  assert.match(PROBE, /hygiene\.registerChild\(host\)/);
  assert.match(PROBE, /hygiene\.registerChild\(electron\)/);
});

test('the probe kills whole trees (not a top pid) on every exit path', () => {
  assert.doesNotMatch(PROBE, /host\.kill\(\)|electron\.kill\(\)/);
  assert.ok((PROBE.match(/_emergencyCleanup\(/g) || []).length >= 3, 'timeout, done and startup-failed paths');
});
