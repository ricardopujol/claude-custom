'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { decideAttach } = require('../host/handshake');

test('a free port means spawn our own host', () => {
  const d = decideAttach({ requestedCwd: 'C:/proj', occupant: null });
  assert.strictEqual(d.action, 'spawn');
});

test('a host already serving this project is ours to reattach to', () => {
  // The property that keeps the existing behaviour worth having: closing the
  // window detaches without ending the session, so reopening it must find the
  // same host rather than start a second one.
  const d = decideAttach({
    requestedCwd: 'C:/proj',
    occupant: { cwd: 'C:\\proj\\' },
  });
  assert.strictEqual(d.action, 'attach');
});

test('a host serving a DIFFERENT project is refused, and says whose it is', () => {
  // This is the bug the feature exists to remove. Before it, app/main.js saw
  // "something is listening" and reattached, so opening project B while A was
  // alive gave you A's session inside B's window with no error anywhere. The
  // occupant's own cwd is reported because "refused" without "it belongs to
  // claude-custom" is not something a person can act on.
  const d = decideAttach({
    requestedCwd: 'C:/proj-b',
    occupant: { cwd: 'C:/proj-a' },
  });
  assert.strictEqual(d.action, 'refuse');
  assert.strictEqual(d.reason, 'other-project');
  assert.strictEqual(d.occupiedBy, 'C:/proj-a');
});

test('an occupant that cannot say which project it serves is REFUSED, not assumed', () => {
  // ABSENCE IS NOT ZERO, applied to the port. Something is listening and we
  // could not identify it -- a stale host from a crashed run, a half-started
  // one, or a different program entirely (7681 is ttyd's default port, so this
  // is a real collision and not a hypothetical). None of those are "probably
  // our session", and attaching to one hands the window to a socket nobody
  // vouched for.
  //
  // The reason must be distinguishable from 'other-project': that one means a
  // known sibling and the launcher may step to the next port, this one means
  // we are flying blind and must say so.
  for (const occupant of [{}, { cwd: null }, { cwd: '' }, { cwd: '   ' }]) {
    const d = decideAttach({ requestedCwd: 'C:/proj', occupant });
    assert.strictEqual(d.action, 'refuse', `occupant ${JSON.stringify(occupant)}`);
    assert.strictEqual(d.reason, 'unidentified', `occupant ${JSON.stringify(occupant)}`);
  }
});

test('a request that cannot say which project it WANTS is refused too', () => {
  // The mirror of the above, and the one a caller is likelier to get wrong:
  // main.js reads the cwd from an environment variable, so an unset variable
  // must not become "attach to whatever is there".
  const d = decideAttach({ requestedCwd: '', occupant: { cwd: 'C:/proj-a' } });
  assert.strictEqual(d.action, 'refuse');
  assert.strictEqual(d.reason, 'no-request');
});
