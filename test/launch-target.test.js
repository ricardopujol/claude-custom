'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLaunchTarget, launchEnv } = require('../host/launch-target');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-'));

test('no argument means the folder you are standing in', () => {
  const dir = tmpDir();
  assert.strictEqual(resolveLaunchTarget(undefined, { cwd: dir }), path.resolve(dir));
});

test('a relative argument resolves against where you ran it', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.strictEqual(
    resolveLaunchTarget('sub', { cwd: dir }),
    path.join(path.resolve(dir), 'sub'),
  );
});

test('a folder that is not there is refused, and named', () => {
  // The launcher is the first thing a new user runs and a typo is the likeliest
  // way to get it wrong. Refusing here means one clear line; accepting means a
  // window opens on a folder that does not exist and claude fails inside the
  // pty, where the message is buried in a TUI.
  const dir = tmpDir();
  assert.throws(
    () => resolveLaunchTarget('nope', { cwd: dir }),
    /nope/,
  );
});

test('a FILE is not a project', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.throws(
    () => resolveLaunchTarget('notes.txt', { cwd: dir }),
    /not a folder/i,
  );
});

test('ELECTRON_RUN_AS_NODE never reaches the window we are launching', () => {
  // THE TRAP THIS PROJECT ALREADY PAID FOR, from its own CLAUDE.md:
  // "ELECTRON_RUN_AS_NODE is inherited ... any probe that spawns Electron from
  // a session must delete that variable or the child starts as plain Node --
  // with errors that name anything but the cause."
  //
  // It bites HERE for a reason that looks correct at every step. The host
  // spawns this launcher with ELECTRON_RUN_AS_NODE=1 on purpose: the host's own
  // execPath is electron, and the launcher is a node script, so it MUST be set.
  // The launcher then passed {...process.env} to electron, carrying it through
  // -- and electron dutifully started as Node, tried to execute the app
  // directory, and exited. Measured: the Projects panel logged "opening
  // project", no window ever appeared, and stdio:'ignore' meant nothing said
  // why.
  const out = launchEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1' }, 'C:/proj');
  assert.strictEqual('ELECTRON_RUN_AS_NODE' in out, false);
  assert.strictEqual(out.CLAUDE_CUSTOM_CWD, 'C:/proj');
  assert.strictEqual(out.PATH, '/x', 'the rest of the environment is passed through');
});

test('a port meant for the OLD project does not follow us to the new one', () => {
  // CLAUDE_CUSTOM_PORT is honoured exactly and never stepped. Inheriting it
  // into a different project would hand the new window the old project's port,
  // where main.js would find the old host, refuse it, and exit -- so the picker
  // would appear to do nothing at all.
  const out = launchEnv({ CLAUDE_CUSTOM_PORT: '7681' }, 'C:/proj');
  assert.strictEqual('CLAUDE_CUSTOM_PORT' in out, false);
});

test('NO CLAUDE_CUSTOM_* variable is inherited except the cwd we are setting', () => {
  // Dexter, PR #31 Finding 4 (High). launchEnv stripped exactly two variables
  // -- the two whose harm I had already been bitten by. At least four more
  // matter, and the worst of them is not a nuisance:
  //
  //   CLAUDE_CUSTOM_TOKEN       the host spawns the launcher with its own env,
  //                             so the NEW window reuses project A's session
  //                             token for project B's host. Every project
  //                             reachable by a chain of picker clicks then
  //                             SHARES ONE TOKEN, and anything that learns one
  //                             can drive all of them. The feature whose whole
  //                             purpose is keeping projects apart was wiring
  //                             their control channels together.
  //   CLAUDE_CUSTOM_INPUT_TEST  app/main.js reads it and SYNTHESISES
  //                             KEYSTROKES into the window. Inherited, those
  //                             land in a different project's live claude.
  //   CLAUDE_CUSTOM_SCREENSHOT  the new window screenshots itself and exits,
  //                             so the picker appears to open a window that
  //                             vanishes.
  //   CLAUDE_CUSTOM_VAULT_PROBE the new window writes a probe entry into the
  //                             shared secret vault.
  //   CLAUDE_CUSTOM_SESSION_ID  host.js derives PIPE_NAME from it, so both
  //                             hosts compute the SAME pipe and the hook
  //                             cross-talk stops needing a race at all.
  //
  // A DENYLIST is the wrong shape here. host.js:826 argues for an explicit
  // list over a wildcard for CLAUDE_CODE_*, and is right to, because that
  // namespace carries the user's own config. CLAUDE_CUSTOM_* carries none of
  // that -- it is entirely this harness talking to itself -- so it is the one
  // namespace where the wildcard is correct: strip all of it, then put back
  // the single variable we mean to pass.
  const dirty = {
    PATH: '/keep/me',
    HOME: '/keep/me/too',
    ELECTRON_RUN_AS_NODE: '1',
    CLAUDE_CUSTOM_PORT: '7742',
    CLAUDE_CUSTOM_TOKEN: 'project-a-secret',
    CLAUDE_CUSTOM_SESSION_ID: 'session-of-a',
    CLAUDE_CUSTOM_INPUT_TEST: '1',
    CLAUDE_CUSTOM_SCREENSHOT: 'C:/shot.png',
    CLAUDE_CUSTOM_SCREENSHOT_DELAY: '9000',
    CLAUDE_CUSTOM_VAULT_PROBE: 'hunter2',
    CLAUDE_CUSTOM_SIDE_TAB: 'projects',
    CLAUDE_CUSTOM_DEMO_SECRET: 'x',
    CLAUDE_CUSTOM_FLOURISH: 'x',
    CLAUDE_CUSTOM_ANYTHING_ADDED_LATER: 'x',
  };
  const out = launchEnv(dirty, 'C:/project-b');

  const ours = Object.keys(out).filter(k => k.startsWith('CLAUDE_CUSTOM_'));
  assert.deepStrictEqual(ours, ['CLAUDE_CUSTOM_CWD'],
    'the only CLAUDE_CUSTOM_* variable the new window may inherit is the cwd we set');
  assert.strictEqual(out.CLAUDE_CUSTOM_CWD, 'C:/project-b');
  assert.strictEqual('ELECTRON_RUN_AS_NODE' in out, false);

  // Everything that is not ours passes through untouched -- stripping the
  // namespace must not cost the child its PATH.
  assert.strictEqual(out.PATH, '/keep/me');
  assert.strictEqual(out.HOME, '/keep/me/too');
});

test('a variable added to the namespace LATER is stripped without anyone remembering to', () => {
  // The point of the wildcard: the denylist was correct for the variables its
  // author had thought of, and silently wrong for every one added afterwards.
  const out = launchEnv({ CLAUDE_CUSTOM_INVENTED_TOMORROW: 'boom' }, 'C:/p');
  assert.strictEqual('CLAUDE_CUSTOM_INVENTED_TOMORROW' in out, false);
});
