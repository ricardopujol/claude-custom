'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { portForCwd, resolvePort, PORT_BASE, PORT_SPAN } = require('../host/port-for-project');

const PROJ = 'C:/Users/ricar/VibeCode/thing';
// `occupantAt` answers for every port EXCEPT the ones named here, which are free.
const occupiedExcept = (free, occupant) => port => (free.includes(port) ? null : occupant);

test('a project always gets the same port', () => {
  // The whole reason the port is derived rather than allocated: closing the
  // window and reopening it must find the host it left running, without any
  // shared registry to consult or keep in step.
  const a = portForCwd('C:/Users/ricar/VibeCode/thing');
  const b = portForCwd('C:/Users/ricar/VibeCode/thing');
  assert.strictEqual(a, b);
  assert.ok(Number.isInteger(a), `got ${a}`);
});

// PIN, honest labelling: this passed when written, because the minimal
// implementation already hashed the normalized path rather than the raw
// string. Kept because it is the property a future "just hash the string"
// simplification would break, and it would break it silently -- you would get
// a second host for a project you already had open, differing only by how the
// path was spelled.
test('the same project spelled differently still gets one port', () => {
  const a = portForCwd('C:\\Users\\ricar\\VibeCode\\thing');
  const b = portForCwd('c:/users/ricar/vibecode/thing/');
  assert.strictEqual(a, b);
});

test('a project with no path is an ERROR, not port 7700', () => {
  // Absence must not collapse to the base port. If it did, every project whose
  // cwd failed to reach this function would pile onto one port and refuse each
  // other -- and the symptom would be "the launcher is broken", miles from the
  // unset variable that caused it.
  for (const bad of [null, undefined, '', '   ']) {
    assert.throws(() => portForCwd(bad), /path/i, `for ${JSON.stringify(bad)}`);
  }
});

test('a free derived port is where we start our own host', async () => {
  const r = await resolvePort({ cwd: PROJ, occupantAt: () => null });
  assert.strictEqual(r.port, portForCwd(PROJ));
  assert.strictEqual(r.action, 'spawn');
});

test('our own host on the derived port is reattached to, not stepped past', async () => {
  const r = await resolvePort({ cwd: PROJ, occupantAt: () => ({ cwd: PROJ }) });
  assert.strictEqual(r.port, portForCwd(PROJ));
  assert.strictEqual(r.action, 'attach');
});

test('another project on our derived port makes us step, not refuse', async () => {
  // Two projects CAN hash to the same port -- 100 ports and no uniqueness
  // guarantee. That must be an invisible inconvenience, not a failure the user
  // has to understand, so the second project quietly takes the next free port.
  const base = portForCwd(PROJ);
  const r = await resolvePort({
    cwd: PROJ,
    occupantAt: occupiedExcept([base + 1], { cwd: 'C:/some/other/project' }),
  });
  assert.strictEqual(r.port, base + 1);
  assert.strictEqual(r.action, 'spawn');
});

test('an unidentified occupant is stepped past, never taken over', async () => {
  // Something is listening and would not say whose it is. Taking the port
  // anyway is the one thing we must not do -- that is the whole point of the
  // handshake -- so it is treated exactly like a stranger's project.
  const base = portForCwd(PROJ);
  const r = await resolvePort({
    cwd: PROJ,
    occupantAt: occupiedExcept([base + 2], {}),
  });
  assert.strictEqual(r.port, base + 2);
  assert.strictEqual(r.action, 'spawn');
});

test('a full range TERMINATES with an error instead of looping', async () => {
  // The probe walks a bounded range. Without a bound this is an infinite loop
  // in the launcher -- a hang with no output, which is the worst possible
  // symptom for the first thing a user runs.
  await assert.rejects(
    () => resolvePort({ cwd: PROJ, occupantAt: () => ({ cwd: 'C:/occupied' }) }),
    /no free port/i,
  );
});

test('stepping stays inside the declared range', async () => {
  // Wraps rather than walking off the end into whatever lives at 7800+.
  const seen = [];
  try {
    await resolvePort({
      cwd: PROJ,
      occupantAt: (port) => { seen.push(port); return { cwd: 'C:/occupied' }; },
    });
  } catch { /* exhaustion is the point of the previous test */ }
  assert.strictEqual(seen.length, PORT_SPAN, 'probes every port exactly once');
  assert.strictEqual(new Set(seen).size, PORT_SPAN, 'and never probes one twice');
  for (const p of seen) {
    assert.ok(p >= PORT_BASE && p < PORT_BASE + PORT_SPAN, `port ${p} outside the range`);
  }
});

test('resolvePort gives up on WALL CLOCK, not just on attempt count', async () => {
  // Dexter, PR #31 Finding 12. The probe in app/main.js has a 400ms socket
  // timeout, and resolvePort walks up to PORT_SPAN ports BEFORE createWindow is
  // called. Behind a DROP-style firewall rule every probe times out, so the
  // worst case is 100 x 400ms = 40 SECONDS with no window on screen, then
  // app.exit(1) to a console a picker-launched user never sees -- it goes to
  // .harness/launcher.log.
  //
  // "Bounded" was true and useless: the header promises a bound precisely so
  // there is no hang, and 40s of blank screen is the hang. The iteration count
  // bounds the wrong axis.
  const slow = async () => { await new Promise(r => setTimeout(r, 30)); return { cwd: 'C:/other' }; };
  const t0 = Date.now();
  await assert.rejects(
    () => resolvePort({ cwd: PROJ, occupantAt: slow, deadlineMs: 150 }),
    /took too long|no free port/i);
  const took = Date.now() - t0;
  assert.ok(took < 1000, `gave up after ${took}ms, which is not a deadline`);
});

test('a deadline does not cut short a probe that is answering quickly', async () => {
  // The bound must not become a new failure mode: a normal resolve is
  // microseconds and must never trip it.
  const r = await resolvePort({ cwd: PROJ, occupantAt: () => null, deadlineMs: 150 });
  assert.strictEqual(r.action, 'spawn');
});

test('different projects do NOT all land on one port', () => {
  // MUTATION-DRIVEN, and it is the worst gap in the branch. Mortimer's run:
  // the hash loop can be deleted outright -- `for (let i = 0; false; i++)` --
  // and ALL of the tests above still pass, because every one of them compares
  // portForCwd(X) against portForCwd(X). They test STABILITY and never test
  // DISTRIBUTION, and a function returning a constant satisfies stability
  // perfectly. `assert.ok(Number.isInteger(a))` was the only assertion on the
  // value itself, and 7700 is an integer.
  //
  // With the hash gone every project on the machine derives 7700. decideAttach
  // then answers 'other-project' for all of them and resolvePort linear-probes
  // from one point for every window ever opened -- which is exactly the hazard
  // the test named 'a project with no path is an ERROR, not port 7700' exists
  // to prevent. That test guards the ERROR path; nothing guarded the success
  // path, where it would affect every project rather than only broken ones.
  const ports = Array.from({ length: 200 }, (_, i) => portForCwd(`C:/VibeCode/project-${i}`));
  const distinct = new Set(ports).size;
  assert.ok(distinct > 50, `200 projects produced only ${distinct} distinct ports`);

  // And it must actually use the whole range rather than clustering.
  assert.ok(Math.min(...ports) < PORT_BASE + 25, 'the low end of the range is unused');
  assert.ok(Math.max(...ports) > PORT_BASE + PORT_SPAN - 25, 'the high end of the range is unused');
});

test('a one-character difference in the path changes the port', () => {
  // The other half of distribution: neighbouring paths must not collide
  // systematically, or sibling projects in one folder all pile onto one port.
  const a = portForCwd('C:/VibeCode/alpha');
  const b = portForCwd('C:/VibeCode/alphb');
  const c = portForCwd('C:/VibeCode/alpha2');
  assert.ok(new Set([a, b, c]).size >= 2, 'near-identical paths collapsed to one port');
});

test('two projects with the same leaf folder do not share a port', () => {
  // Mortimer Survivor 3: `h * 31` -> `h / 31` survives the distribution test,
  // because after division `h` is dominated by the CURRENT character, so the
  // port depends almost entirely on the path's last character. Identically
  // named leaf folders across sibling projects are the common case, not the
  // exotic one -- src/, app/, web/.
  assert.notStrictEqual(
    portForCwd('C:/VibeCode/alpha/src'), portForCwd('C:/VibeCode/bravo/src'),
    'two projects with the same leaf folder must not share a port');
  assert.notStrictEqual(
    portForCwd('C:/VibeCode/one/app'), portForCwd('C:/VibeCode/two/app'));
});

test('the tuned constants are pinned to LITERALS, not to themselves', () => {
  // Mortimer's sharpest observation, and it applies to my tests rather than to
  // the code. StrykerJS has no numeric-literal mutator, so PORT_BASE,
  // PORT_SPAN and DEADLINE_MS generate ZERO mutants -- absent from the report
  // entirely. That alone would be survivable if the suite pinned them.
  //
  // IT DID NOT, AND COULD NOT: the assertions IMPORT the constants.
  // `assert.strictEqual(seen.length, PORT_SPAN)` has the constant on both
  // sides, so both move together and the assertion cannot fail when the value
  // changes. Change PORT_SPAN to 50 and nothing in the branch went red -- the
  // value was unpinned by the mutation score AND by the suite, which is the
  // worst of both instruments agreeing on nothing.
  //
  // Literals here, deliberately. If someone changes the range this test fails
  // and they must justify it, which is the entire point of a tuned constant.
  assert.strictEqual(PORT_BASE, 7700, 'the derived range starts at 7700');
  assert.strictEqual(PORT_SPAN, 100, 'and is 100 ports wide');

  // The boundary those two define, asserted as a boundary rather than inferred.
  const ports = Array.from({ length: 300 }, (_, i) => portForCwd(`C:/p/${i}`));
  assert.ok(Math.min(...ports) >= 7700, 'nothing below the base');
  assert.ok(Math.max(...ports) <= 7799, 'nothing at or above base + span');
});

test('the port-probe deadline is pinned, including the direction that reintroduces the hang', () => {
  // Mortimer: DEADLINE_MS is invisible three ways at once -- not a mutable
  // literal, not reachable as a default-parameter mutant, and never exercised
  // at its real value, because both deadline tests inject deadlineMs: 150.
  //
  // Making it SMALLER is caught incidentally. Making it LARGER -- the
  // direction that reintroduces Dexter's F12 forty-second blank screen -- was
  // undetectable by anything in this branch.
  const { DEADLINE_MS } = require('../host/port-for-project');
  assert.strictEqual(DEADLINE_MS, 6000,
    'a longer deadline is a longer blank screen; changing this needs a reason');
});
