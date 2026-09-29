'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLaunchTarget, launchEnv } = require('../host/launch-target');
const { tmpDir } = require('./tmp-dir');

// This file's own helper was already called `tmpDir`, so the shared one would
// have shadowed itself into infinite recursion. Renamed rather than aliased on
// import, because the call sites below read better as `dir()`.
const dir_ = () => tmpDir('cc-launch-');

test('no argument means the folder you are standing in', () => {
  const dir = dir_();
  assert.strictEqual(resolveLaunchTarget(undefined, { cwd: dir }), path.resolve(dir));
});

test('a relative argument resolves against where you ran it', () => {
  const dir = dir_();
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
  const dir = dir_();
  assert.throws(
    () => resolveLaunchTarget('nope', { cwd: dir }),
    /nope/,
  );
});

test('a FILE is not a project', () => {
  const dir = dir_();
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

test('CLAUDE_CUSTOM_NEW does not leak into a project opened from the picker', () => {
  // The newest member of the namespace, and the exact class Dexter's Finding 4
  // was about: a CLAUDE_CUSTOM_* variable surviving into another project's
  // session. Here it would mean clicking a project in the picker silently
  // spawned a SECOND session of it instead of reattaching -- a duplicate the
  // user never asked for, every time.
  //
  // The wildcard already handles it; that function's own comment anticipates
  // "whatever is added to it next year by someone who never reads this
  // function". This asserts the anticipation actually held, because a wildcard
  // nobody tests is a promise rather than a guarantee.
  const env = launchEnv({ CLAUDE_CUSTOM_NEW: '1', PATH: '/usr/bin' }, 'C:/work/other');
  assert.strictEqual(env.CLAUDE_CUSTOM_NEW, undefined);
  assert.strictEqual(env.PATH, '/usr/bin', 'and unrelated variables still pass through');
});

// --- the --new wiring, testable (Dexter #41 F2, Miguel #2) --------------------
//
// Deleting `wantsNew`, the CLAUDE_CUSTOM_NEW:'1' in the child env, or main's
// `=== '1'` each left the suite green: bin/ and main.js are not loadable by a
// test. The decisions now live here, and those files only call them.

const { parseLaunchArgs, isFreshLaunch, hostEnv } = require('../host/launch-target');

test('parseLaunchArgs: --new is read wherever it sits, and is never taken for the folder', () => {
  assert.deepStrictEqual(parseLaunchArgs([]), { help: false, fresh: false, folder: undefined });
  assert.deepStrictEqual(parseLaunchArgs(['proj']), { help: false, fresh: false, folder: 'proj' });
  assert.deepStrictEqual(parseLaunchArgs(['--new']), { help: false, fresh: true, folder: undefined });
  assert.deepStrictEqual(parseLaunchArgs(['proj', '--new']), { help: false, fresh: true, folder: 'proj' });
  assert.deepStrictEqual(parseLaunchArgs(['--new', 'proj']), { help: false, fresh: true, folder: 'proj' });
  assert.strictEqual(parseLaunchArgs(['-h']).help, true);
  assert.strictEqual(parseLaunchArgs(['proj', '--help']).help, true);
});

test('parseLaunchArgs: there is no -n alias -- a folder named -n is a folder (Dexter F5)', () => {
  assert.deepStrictEqual(parseLaunchArgs(['-n']), { help: false, fresh: false, folder: '-n' });
});

test('launchEnv carries CLAUDE_CUSTOM_NEW=1 exactly when a fresh session is asked for', () => {
  assert.strictEqual(launchEnv({}, 'C:/p', { fresh: true }).CLAUDE_CUSTOM_NEW, '1');
  assert.ok(!('CLAUDE_CUSTOM_NEW' in launchEnv({}, 'C:/p', { fresh: false })));
  assert.ok(!('CLAUDE_CUSTOM_NEW' in launchEnv({ CLAUDE_CUSTOM_NEW: '1' }, 'C:/p')),
    'an inherited flag must not survive a plain launch');
});

test('isFreshLaunch: only the exact value the launcher writes counts', () => {
  assert.strictEqual(isFreshLaunch({ CLAUDE_CUSTOM_NEW: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.strictEqual(isFreshLaunch({ CLAUDE_CUSTOM_NEW: v }), false, `for ${JSON.stringify(v)}`);
  }
  assert.strictEqual(isFreshLaunch(undefined), false);
});

test('hostEnv: the detached host gets its port, cwd and token, and NOT the --new flag (Miguel #4)', () => {
  // Inherited, the flag reached the host and its `claude` child -- so `npm
  // start` run inside a --new session's terminal carried it (Dexter F4).
  const env = hostEnv({ PATH: 'x', CLAUDE_CUSTOM_NEW: '1' }, { port: 7764, cwd: 'C:/p', token: 't' });
  assert.strictEqual(env.PATH, 'x');
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(env.CLAUDE_CUSTOM_PORT, '7764');
  assert.strictEqual(env.CLAUDE_CUSTOM_CWD, 'C:/p');
  assert.strictEqual(env.CLAUDE_CUSTOM_TOKEN, 't');
  assert.ok(!('CLAUDE_CUSTOM_NEW' in env));
});

test('bin/ and main.js route through these helpers, not their own copies', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const bin = read('bin/claude-custom.js');
  const main = read('app/main.js');
  assert.match(bin, /parseLaunchArgs\(/);
  assert.match(bin, /launchEnv\([^)]*fresh/);
  assert.doesNotMatch(bin, /CLAUDE_CUSTOM_NEW/, 'bin/ must not build the flag by hand');
  assert.match(main, /isFreshLaunch\(process\.env\)/);
  assert.match(main, /hostEnv\(process\.env/);
  assert.doesNotMatch(main, /CLAUDE_CUSTOM_NEW\s*===/, 'main.js must not re-read the flag by hand');
});
