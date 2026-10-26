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

const exclusions = filesList.filter(f => f.startsWith('!')).map(f => f.slice(1));
const inclusions = filesList.filter(f => !f.startsWith('!'));

test('files is an ALLOW-LIST: it names the app folders and nothing like "everything"', () => {
  assert.ok(!inclusions.includes('**/*') && !inclusions.includes('**') && !inclusions.includes('*'), 'electron-builder reads the disk, not git');
  assert.deepEqual(inclusions.sort(), ['.harness/hook-helper.exe', 'app/**', 'bin/**', 'host/**', 'mods/**', 'package.json', 'registry/**']);
});

test('test, verify, forge, documentation, reports, backgrounds and portraits are excluded as well', () => {
  for (const dir of ['test', 'verify', 'forge', 'documentation', 'reports', 'backgrounds', 'portraits']) {
    assert.ok(filesList.includes(`!${dir}/**`), `${dir}/ must be excluded`);
  }
});

test('what can sit inside a shipped folder and must not ship is excluded: env files, logs, tokens, the vault, migration leftovers', () => {
  for (const pat of ['**/.env*', '**/*.log', '**/*.pre-migration', '**/secrets.enc', '**/session-token', '**/*.token', '**/*.map']) {
    assert.ok(filesList.includes(`!${pat}`), `${pat} must be excluded`);
  }
});

// A pattern -> regexp, enough for the globs used in the yml: `**/` (any folders), `**` (anything), `*` (within a name).
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const shipped = (rel) => inclusions.some(g => globToRe(g).test(rel)) && !exclusions.some(g => globToRe(g).test(rel));

test('no gitignored file on disk under a shipped folder would be packed (a local .env, backgrounds, a log, a pre-migration copy)', () => {
  const { execFileSync } = require('child_process');
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'app', 'host', 'bin', 'registry', 'mods'],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  } catch { return; }   // not a git checkout (a source tarball): nothing to compare
  const escaped = out.split('\n').map(l => l.trim()).filter(Boolean).filter(shipped);
  assert.deepEqual(escaped, [], 'these ignored files would ship: add a pattern to build/electron-builder.yml');
});

test('and the matcher itself: a made-up ignored file under each shipped folder is caught by the patterns above', () => {
  for (const f of ['app/notes.log', 'host/.env', 'host/.env.local', 'registry/projects.json.pre-migration', 'app/x/secrets.enc', 'host/a.map']) {
    assert.equal(shipped(f), false, f);
  }
  for (const f of ['app/main.js', 'host/host.js', 'bin/claude-custom.js', 'registry/projects.json', '.harness/hook-helper.exe', 'package.json']) {
    assert.equal(shipped(f), true, f);
  }
  assert.equal(shipped('backgrounds/a.svg'), false);
  assert.equal(shipped('app/deep/er/file.js'), true, 'a nested file under app/** ships');
  assert.equal(shipped('mods/claude-custom/hooks/hooks.json'), true);
  assert.equal(shipped('.harness/session-token'), false);
});

// Folders the app reads beside its code at runtime must ship, unless they are deliberately local. Found by reading the source, so a
// new `path.join(__dirname, '..', '<dir>')` that the allow-list forgets (as `mods/` was, at a merge) fails here.
const DELIBERATELY_LOCAL = new Set(['backgrounds', '.harness', 'helper']);   // per-user art, runtime state (only the helper exe ships), the build source (its absence marks an installed build)

test('every folder host/ and app/ read beside the code at runtime is shipped or deliberately local', () => {
  const dirs = new Set();
  for (const sub of ['host', 'app']) {
    for (const f of fs.readdirSync(path.join(ROOT, sub)).filter(x => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(ROOT, sub, f), 'utf8');
      for (const m of src.matchAll(/path\.join\(__dirname, '\.\.', '([A-Za-z.][A-Za-z0-9._-]*)'/g)) dirs.add(m[1]);
    }
  }
  assert.ok(dirs.has('mods') && dirs.has('registry'), 'the scan finds the folders it should');
  for (const d of dirs) {
    if (DELIBERATELY_LOCAL.has(d)) continue;
    assert.ok(inclusions.some(g => g === `${d}/**` || g.startsWith(`${d}/`)), `"${d}/" is read at runtime but not shipped by build/electron-builder.yml`);
  }
});

test('the mod ships its runtime files (hooks, plugin manifest) and not its tests or type stubs', () => {
  for (const f of ['mods/claude-custom/hooks/hooks.json', 'mods/claude-custom/hooks/register.js', 'mods/claude-custom/.claude-plugin/plugin.json']) assert.equal(shipped(f), true, f);
  for (const f of ['mods/claude-custom/tests/feed.test.ts', 'mods/claude-custom/.claude-plugin/types/claude-code/index.d.ts', 'mods/claude-custom/tsconfig.json']) assert.equal(shipped(f), false, f);
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
  assert.match(YML, /allowToChangeInstallationDirectory: false/, 'per-user only: the app writes .harness beside its code');
  assert.match(YML, /signAndEditExecutable: false/);
});

test('npm run dist builds from that file, and electron-builder is pinned exactly', () => {
  assert.match(PKG.scripts.dist, /electron-builder --config build\/electron-builder\.yml/);
  assert.match(PKG.devDependencies['electron-builder'], /^\d+\.\d+\.\d+$/);
});
