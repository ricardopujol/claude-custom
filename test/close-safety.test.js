'use strict';
/**
 * Backlog #77: Ctrl+click closes a merged, safe tab with no confirm (host/close-safety.js).
 * Safe means ALL of: merged, nothing uncommitted, nothing unpushed, no agent working there, and the tab's own
 * session at rest. Anything unknown is NOT safe.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  isSafeToClose, closeReasons, closeReason, readCloseFacts, makeRun, GIT_TIMEOUT_MS, STATUS_ARGS,
} = require('../host/close-safety');

const SAFE = { merged: true, dirtyCount: 0, unpushedCount: 0, agentsHere: 0, session: 'idle' };

test('isSafeToClose: merged, clean, pushed, unoccupied and at rest is safe', () => {
  assert.strictEqual(isSafeToClose(SAFE), true);
});

test('isSafeToClose: every combination -- only the all-clear one is safe', () => {
  for (const merged of [true, false]) {
    for (const dirtyCount of [0, 2]) {
      for (const unpushedCount of [0, 3]) {
        for (const agentsHere of [0, 1]) {
          for (const session of ['idle', 'busy', 'waiting']) {
            const expected = merged && dirtyCount === 0 && unpushedCount === 0 && agentsHere === 0 && session === 'idle';
            const facts = { merged, dirtyCount, unpushedCount, agentsHere, session };
            assert.strictEqual(isSafeToClose(facts), expected, JSON.stringify(facts));
            assert.strictEqual(closeReasons(facts).length === 0, expected, JSON.stringify(facts));
          }
        }
      }
    }
  }
});

test('isSafeToClose: unknown is never safe (null, undefined, strings, NaN, negatives)', () => {
  for (const bad of [null, undefined, '0', NaN, -1, 1.5, {}, false]) {
    for (const k of ['dirtyCount', 'unpushedCount', 'agentsHere']) {
      assert.strictEqual(isSafeToClose({ ...SAFE, [k]: bad }), false, `${k}=${String(bad)}`);
    }
  }
  for (const bad of [null, undefined, 'true', 1, 0, false]) {
    assert.strictEqual(isSafeToClose({ ...SAFE, merged: bad }), false, `merged=${String(bad)}`);
  }
  for (const bad of [null, undefined, '', 'idle ', 'IDLE', true, 0]) {
    assert.strictEqual(isSafeToClose({ ...SAFE, session: bad }), false, `session=${String(bad)}`);
  }
  assert.strictEqual(isSafeToClose(null), false);
  assert.strictEqual(isSafeToClose(undefined), false);
  assert.strictEqual(isSafeToClose('x'), false);
});

test('closeReasons: names each thing that is wrong, in a fixed order', () => {
  assert.deepStrictEqual(closeReasons({ merged: false, dirtyCount: 2, unpushedCount: 3, agentsHere: 1, session: 'busy' }),
    ['not merged', '2 uncommitted files', '3 unpushed commits', 'an agent is working here', 'Claude is still working in this tab']);
});

test('closeReasons: singular and plural', () => {
  assert.deepStrictEqual(closeReasons({ ...SAFE, dirtyCount: 1 }), ['1 uncommitted file']);
  assert.deepStrictEqual(closeReasons({ ...SAFE, unpushedCount: 1 }), ['1 unpushed commit']);
  assert.deepStrictEqual(closeReasons({ ...SAFE, agentsHere: 2 }), ['2 agents are working here']);
});

test("closeReasons: the tab's own session, busy or waiting, is a reason (D1)", () => {
  assert.deepStrictEqual(closeReasons({ ...SAFE, session: 'busy' }), ['Claude is still working in this tab']);
  assert.deepStrictEqual(closeReasons({ ...SAFE, session: 'waiting' }), ['Claude is waiting for you in this tab']);
});

test('closeReasons: an unknown fact says it could not be checked, never "0"', () => {
  assert.deepStrictEqual(closeReasons({ ...SAFE, dirtyCount: null }), ["couldn't check for uncommitted files"]);
  assert.deepStrictEqual(closeReasons({ ...SAFE, unpushedCount: undefined }), ["couldn't check for unpushed commits"]);
  assert.deepStrictEqual(closeReasons({ ...SAFE, agentsHere: null }), ["couldn't check for agents"]);
  assert.deepStrictEqual(closeReasons({ ...SAFE, merged: null }), ["couldn't check whether it's merged"]);
  assert.deepStrictEqual(closeReasons({ ...SAFE, session: null }), ["couldn't check what Claude is doing in this tab"]);
  assert.deepStrictEqual(closeReasons(null).length > 0, true);
});

test('closeReason: joins the reasons for the confirm, or is empty when safe', () => {
  assert.strictEqual(closeReason(SAFE), '');
  assert.strictEqual(closeReason({ ...SAFE, dirtyCount: 2, merged: false }), 'not merged; 2 uncommitted files');
});

test('property: safe exactly when closeReasons is empty', () => {
  const n = fc.oneof(fc.nat(5), fc.constant(null), fc.constant(undefined), fc.constant(NaN), fc.constant('0'));
  const session = fc.constantFrom('idle', 'busy', 'waiting', null, undefined, 'x');
  fc.assert(fc.property(fc.oneof(fc.boolean(), fc.constant(null)), n, n, n, session, (merged, dirtyCount, unpushedCount, agentsHere, s) => {
    const f = { merged, dirtyCount, unpushedCount, agentsHere, session: s };
    assert.strictEqual(isSafeToClose(f), closeReasons(f).length === 0);
  }));
});

// --- readCloseFacts: git facts through an injected runner --------------------------------------------

const STATUS = STATUS_ARGS.join(' ');
const UP = 'rev-list --count feat/a@{upstream}..refs/heads/feat/a';
const FALLBACK = 'rev-list --count origin/develop..refs/heads/feat/a';
const BRANCH = 'symbolic-ref --short -q HEAD';
const ANCESTOR = 'merge-base --is-ancestor HEAD origin/develop';
const exit1 = Object.assign(new Error('not an ancestor'), { code: 1 });

const runner = (table, seen = []) => async (args) => {
  const key = args.join(' ');
  seen.push(key);
  if (Object.prototype.hasOwnProperty.call(table, key)) {
    const v = table[key];
    if (v instanceof Error) throw v;
    return v;
  }
  throw new Error(`unexpected git ${key}`);
};
const ALL_OK = { [STATUS]: '', [BRANCH]: 'feat/a\n', [UP]: '0\n', [ANCESTOR]: '' };

test('readCloseFacts: counts porcelain lines and the branch\'s commits not on its upstream', async () => {
  const run = runner({ ...ALL_OK, [STATUS]: ' M a.js\n?? b.js\n', [UP]: '3\n' });
  assert.deepStrictEqual(await readCloseFacts('/x', { run }),
    { branch: 'feat/a', dirtyCount: 2, unpushedCount: 3, headInDevelop: true });
});

test('readCloseFacts: a clean tree is 0, not unknown', async () => {
  assert.deepStrictEqual(await readCloseFacts('/x', { run: runner(ALL_OK) }),
    { branch: 'feat/a', dirtyCount: 0, unpushedCount: 0, headInDevelop: true });
});

test('D4: status asks for every untracked file and every submodule change, whatever the config says', async () => {
  assert.ok(STATUS_ARGS.includes('--untracked-files=all'));
  assert.ok(STATUS_ARGS.includes('--ignore-submodules=none'));
  const seen = [];
  await readCloseFacts('/x', { run: runner(ALL_OK, seen) });
  assert.ok(seen.includes('status --porcelain --untracked-files=all --ignore-submodules=none'), JSON.stringify(seen));
});

test('readCloseFacts: no upstream falls back to origin/develop, for the BRANCH', async () => {
  const run = runner({ ...ALL_OK, [UP]: new Error('no upstream'), [FALLBACK]: '4\n' });
  assert.strictEqual((await readCloseFacts('/x', { run })).unpushedCount, 4);
});

test('D3: a detached HEAD is unknown, never 0 -- nothing is counted for a branch that isn\'t checked out', async () => {
  const seen = [];
  const run = runner({ ...ALL_OK, [BRANCH]: new Error('detached') }, seen);
  const r = await readCloseFacts('/x', { run });
  assert.strictEqual(r.branch, null);
  assert.strictEqual(r.unpushedCount, null);
  assert.ok(!seen.some(k => k.startsWith('rev-list')), 'no commit count against HEAD');
  assert.strictEqual((await readCloseFacts('/x', { run: runner({ ...ALL_OK, [BRANCH]: '\n' }) })).unpushedCount, null);
});

test('D5: HEAD on origin/develop is true, exit 1 is false (a commit after the merge), any other failure is unknown', async () => {
  assert.strictEqual((await readCloseFacts('/x', { run: runner(ALL_OK) })).headInDevelop, true);
  assert.strictEqual((await readCloseFacts('/x', { run: runner({ ...ALL_OK, [ANCESTOR]: exit1 }) })).headInDevelop, false);
  assert.strictEqual((await readCloseFacts('/x', { run: runner({ ...ALL_OK, [ANCESTOR]: new Error('bad ref') }) })).headInDevelop, null);
  const killed = Object.assign(new Error('timed out'), { code: null, killed: true });
  assert.strictEqual((await readCloseFacts('/x', { run: runner({ ...ALL_OK, [ANCESTOR]: killed }) })).headInDevelop, null);
  const code128 = Object.assign(new Error('fatal'), { code: 128 });
  assert.strictEqual((await readCloseFacts('/x', { run: runner({ ...ALL_OK, [ANCESTOR]: code128 }) })).headInDevelop, null);
});

test('readCloseFacts: git failing is unknown (null), never zero', async () => {
  const none = runner({
    [STATUS]: new Error('boom'), [BRANCH]: new Error('no'), [ANCESTOR]: new Error('no'),
  });
  assert.deepStrictEqual(await readCloseFacts('/x', { run: none }),
    { branch: null, dirtyCount: null, unpushedCount: null, headInDevelop: null });
  const junk = runner({ ...ALL_OK, [UP]: 'banana', [FALLBACK]: 'banana' });
  assert.strictEqual((await readCloseFacts('/x', { run: junk })).unpushedCount, null, 'a non-number answer is unknown');
});

test('readCloseFacts: a bad folder is unknown without running git', async () => {
  let ran = 0;
  const run = async () => { ran++; return ''; };
  const unknown = { branch: null, dirtyCount: null, unpushedCount: null, headInDevelop: null };
  assert.deepStrictEqual(await readCloseFacts('', { run }), unknown);
  assert.deepStrictEqual(await readCloseFacts(null, { run }), unknown);
  assert.strictEqual(ran, 0);
});

test('M2: the reads run side by side, not one after another', async () => {
  let inFlight = 0;
  let peak = 0;
  const run = async (args) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 15));
    inFlight--;
    const key = args.join(' ');
    if (key === BRANCH) return 'feat/a\n';
    if (key === STATUS) return '';
    if (key === UP) return '0\n';
    return '';
  };
  await readCloseFacts('/x', { run });
  assert.ok(peak >= 3, `status, branch and ancestor start together (peak ${peak})`);
});

test('M2 + D8: every git read has a short timeout and takes no optional lock', async () => {
  assert.ok(GIT_TIMEOUT_MS <= 3000);
  const seen = [];
  const exec = (file, args, opts, cb) => { seen.push({ file, args, opts }); cb(null, ''); };
  await makeRun({ exec })(['status'], '/x');
  assert.strictEqual(seen[0].file, 'git');
  assert.strictEqual(seen[0].opts.timeout, GIT_TIMEOUT_MS);
  assert.strictEqual(seen[0].opts.env.GIT_OPTIONAL_LOCKS, '0');
  assert.strictEqual(seen[0].opts.cwd, '/x');
  // an error from git (exit code kept) rejects; a timeout is an error too
  const bad = (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 1 }));
  await assert.rejects(makeRun({ exec: bad })(['x'], '/x'), (e) => e.code === 1);
});

// --- a real repo: the argv above really does what the fakes say ----------------------------------------

test('real git: showUntrackedFiles=no can\'t hide a file; a detached HEAD is unknown; a commit after develop is "not in develop"', async () => {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const { tmpDir } = require('./tmp-dir');
  const dir = tmpDir('cc-close-safety-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'develop');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  git('switch', '-q', '-c', 'feat/a');
  git('config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
  assert.strictEqual(git('status', '--porcelain'), '', 'precondition: the config does hide it from a plain status');
  let r = await readCloseFacts(dir);
  assert.deepStrictEqual(r, { branch: 'feat/a', dirtyCount: 1, unpushedCount: 0, headInDevelop: true });
  git('add', 'new.txt');
  git('commit', '-q', '-m', 'after');
  r = await readCloseFacts(dir);
  assert.strictEqual(r.headInDevelop, false, 'a commit after the merge');
  assert.strictEqual(r.unpushedCount, 1, 'counted for the branch, against origin/develop when there is no upstream');
  git('checkout', '-q', '--detach', 'origin/develop');
  r = await readCloseFacts(dir);
  assert.strictEqual(r.branch, null);
  assert.strictEqual(r.unpushedCount, null, 'the branch\'s unpushed commit is NOT hidden by a detached HEAD');
});
