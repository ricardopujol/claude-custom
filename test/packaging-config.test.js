'use strict';
/**
 * The installer's contract (build/electron-builder.yml), read as text so no YAML library is needed. What must hold:
 * the folders a second user doesn't need stay out of the package, the one build artefact the app can't work without
 * (the hook helper) goes back in AFTER `.harness` is excluded, nothing is signed, and `npm run dist` runs this file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const YML = fs.readFileSync(path.join(ROOT, 'build', 'electron-builder.yml'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const filesList = (() => {
  const m = /^files:\s*\n((?:\s+- .*\n?)+)/m.exec(YML);
  assert.ok(m, 'the yml must have a files: list');
  return m[1].split('\n').map(l => /^\s+- "?([^"]*)"?\s*$/.exec(l)).filter(Boolean).map(x => x[1]);
})();

test('test, verify, forge, documentation, reports and .harness are excluded', () => {
  for (const dir of ['test', 'verify', 'forge', 'documentation', 'reports', '.harness']) {
    assert.ok(filesList.includes(`!${dir}/**`), `${dir}/ must be excluded`);
  }
});

test('the app, host and registry folders are not excluded', () => {
  for (const dir of ['app', 'host', 'bin', 'registry']) {
    assert.ok(!filesList.includes(`!${dir}/**`), `${dir}/ must ship`);
  }
});

test('the hook helper is re-included after .harness is excluded', () => {
  const out = filesList.indexOf('!.harness/**');
  const back = filesList.indexOf('.harness/hook-helper.exe');
  assert.ok(out !== -1 && back > out);
});

test('the host looks for the helper exactly where the package puts it', () => {
  const host = fs.readFileSync(path.join(ROOT, 'host', 'host.js'), 'utf8');
  assert.match(host, /path\.join\(HARNESS_DIR, 'hook-helper\.exe'\)/);
  assert.match(host, /const HARNESS_DIR = path\.join\(__dirname, '\.\.', '\.harness'\)/);
});

test('a Windows NSIS installer and a zip, per-user, unsigned, and not packed into an asar', () => {
  assert.match(YML, /target: nsis/);
  assert.match(YML, /target: zip/);
  assert.match(YML, /^asar: false/m);
  assert.match(YML, /perMachine: false/);
  assert.match(YML, /signAndEditExecutable: false/);
});

test('npm run dist builds from that file, and electron-builder is pinned exactly', () => {
  assert.match(PKG.scripts.dist, /electron-builder --config build\/electron-builder\.yml/);
  assert.match(PKG.devDependencies['electron-builder'], /^\d+\.\d+\.\d+$/);
});
