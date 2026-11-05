'use strict';
// BACKLOG #169, PR #232 (Dexter 2 / Miguel Y1): a verify/ script that starts a host.js or an Electron must carry the probe mark, or the
// orphan sweep never sees what it leaves behind. The mark is set by requiring verify/lib/mark-probe.js, directly or through
// launch-electron.js / process-hygiene.js. This reads the sources: no probe is run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VERIFY = path.join(__dirname, '..', 'verify');

// What "starts a host or an Electron" looks like in a probe's source: the host script, the electron package, or a plain node child
// that runs a file under host/.
const SPAWNS = /host[\\/'",\s]+host\.js|['"]host\.js['"]|node_modules[\\/'",\s]+electron|require\(\s*['"]electron['"]\s*\)/;
// What reaches the mark: the three modules, however the path is written.
const MARKS = /lib[\\/'",\s]+(launch-electron|mark-probe|process-hygiene)\b/;

const scripts = () => fs.readdirSync(VERIFY).filter(n => n.endsWith('.js')).map(n => ({ name: n, src: fs.readFileSync(path.join(VERIFY, n), 'utf8') }));

test('the classifier: a hand spawn of host.js and an electron launch are seen; the three marking modules are recognised; a plain script is neither', () => {
  assert.ok(SPAWNS.test("spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')])"));
  assert.ok(SPAWNS.test("const HOST = path.join(__dirname, '..', 'host', 'host.js');"));
  assert.ok(SPAWNS.test("require(path.join(ROOT, 'node_modules', 'electron'))"));
  assert.ok(SPAWNS.test("const electron = require('electron');"));
  assert.ok(!SPAWNS.test("const net = require('net'); console.log('hosts/');"));
  for (const m of ['launch-electron', 'mark-probe', 'process-hygiene']) {
    assert.ok(MARKS.test(`require('./lib/${m}')`), m);
    assert.ok(MARKS.test(`require(path.join(__dirname, 'lib', '${m}'))`), m);
  }
  assert.ok(!MARKS.test("require('./lib/file-snapshot')"));
});

test('every verify/ script that starts a host or an Electron reaches the probe mark', () => {
  const all = scripts();
  const spawners = all.filter(s => SPAWNS.test(s.src));
  assert.ok(spawners.length > 40, `the scan must see the probes that spawn hosts (${spawners.length})`);
  const unmarked = spawners.filter(s => !MARKS.test(s.src)).map(s => s.name);
  assert.deepStrictEqual(unmarked, [], `these start a host or an Electron without the probe mark; add require('./lib/mark-probe') at the top: ${unmarked.join(', ')}`);
});

test('the marking modules do mark: launch-electron and process-hygiene both require mark-probe, which marks only a verify/ script', () => {
  const read = (f) => fs.readFileSync(path.join(VERIFY, 'lib', f), 'utf8');
  assert.match(read('launch-electron.js'), /require\('\.\/mark-probe'\)/);
  assert.match(read('process-hygiene.js'), /require\('\.\/mark-probe'\)/);
  const { spawnSync } = require('child_process');
  const code = `const m = require(${JSON.stringify(path.join(VERIFY, 'lib', 'mark-probe.js'))}); console.log(JSON.stringify({ mark: m.mark, env: process.env.CC_PROBE_MARK || null }));`;
  const env = { ...process.env }; delete env.CC_PROBE_MARK;
  const asProbe = spawnSync(process.execPath, ['-e', `process.argv[1] = ${JSON.stringify(path.join(VERIFY, 'probe-x.js'))};\n${code}`], { encoding: 'utf8', env });
  const a = JSON.parse(asProbe.stdout.trim().split('\n').pop());
  assert.match(a.mark, /^pm1-\d+-[0-9a-f]{12}$/);
  assert.strictEqual(a.env, a.mark, 'a probe\'s own process.env carries it');
  const asOther = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
  const b = JSON.parse(asOther.stdout.trim().split('\n').pop());
  assert.deepStrictEqual(b, { mark: null, env: null }, 'a script outside verify/ is not marked');
});
