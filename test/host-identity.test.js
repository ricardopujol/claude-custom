'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeIdentity, readIdentity } = require('../host/host-identity');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ident-'));
const ALIVE = () => true;

test('a host publishes which project it serves, and it reads back', () => {
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  const got = readIdentity({ dir, port: 7700, isAlive: ALIVE });
  assert.strictEqual(got.cwd, 'C:/proj');
});

test('a host that is no longer running reads as ABSENT, not as its last claim', () => {
  // The file outlives the process that wrote it. A host killed with the window
  // open, a machine that lost power, a crashed run -- all leave a file saying
  // "port 7700 serves C:/proj". Believing it means refusing to start a new
  // host for a project whose host is long dead, forever, with no way out but
  // deleting a file the user does not know exists.
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: () => false }), null);
});

test('an unreadable or nonsense identity is ABSENT, never a guess', () => {
  const dir = tmp();
  // Nothing written at all.
  assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: ALIVE }), null);

  // Half-written: the host writes this at startup, so a crash mid-write is an
  // ordinary state rather than a corrupt-disk story.
  fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hosts', '7701.json'), '{"port":7701,"cwd"', 'utf8');
  assert.strictEqual(readIdentity({ dir, port: 7701, isAlive: ALIVE }), null);

  // Parses, but says nothing useful. `decideAttach` would refuse this anyway;
  // reporting it as absent keeps "there is no host" and "there is a host that
  // will not identify itself" as the different things they are.
  fs.writeFileSync(path.join(dir, 'hosts', '7702.json'), '{"port":7702,"pid":1}', 'utf8');
  assert.strictEqual(readIdentity({ dir, port: 7702, isAlive: ALIVE }), null);
});

test('an identity filed under the wrong port is not trusted', () => {
  // Guards a copied .harness directory and a hand-edited file. The port is
  // recorded inside as well as in the filename precisely so the two can be
  // checked against each other.
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  fs.renameSync(path.join(dir, 'hosts', '7700.json'), path.join(dir, 'hosts', '7900.json'));
  assert.strictEqual(readIdentity({ dir, port: 7900, isAlive: ALIVE }), null);
});
