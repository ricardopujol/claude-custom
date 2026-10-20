'use strict';
/**
 * BACKLOG #119 A1: account profiles in the tab shell (app/tab-shell.js).
 *
 * A tab has a profile. It is chosen when the tab's session first starts (the tab's own remembered one, else the project's last used, else
 * the default), it rides on the record into hosts.spawn (main turns it into CLAUDE_CONFIG_DIR), and it can be changed by hand:
 * `changeProfile` restarts the session under the new account (the person has already confirmed), but only after the old host has really
 * ended, and it leaves everything as it was when the old one won't stop. The shell holds ids only; `deps.profiles` resolves them.
 *
 * Every effect is a recording fake, as in test/tab-shell.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const { sideKeyOf } = require('../host/side-session');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-profiles');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));

const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\n` +
  (branch ? `branch refs/heads/${branch}\n` : 'detached\n')).join('\n') + '\n';
const TWO = [['dev', 'develop'], ['feat-a', 'feat/a']];

const NO_OPS = {
  available: () => ({ create: false, setup: false, remove: false }),
  create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
  remove: async () => ({ ok: false, error: 'no' }),
};
const PROFILES = {
  default: { id: 'default', name: 'Default', colour: null },
  work: { id: 'work', name: 'Work', colour: '#4c8bf5' },
  play: { id: 'play', name: 'Play', colour: '#4caf6a' },
};

const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await settle(); };

function harness({ chosen = {}, profiles = true, stopFails = false, stubborn = false, stopSlow = false, killer = null, merged = false, chooseThrows = null, failWaitOnce = false, hostProfile } = {}) {
  const h = {
    running: {}, spawns: [], controls: [], viewsMade: [], viewsGone: [], sent: [], changes: [], order: [],
    remembered: [], chooses: [], tokens: 0, slept: 0, stopFails, stubborn, kills: [], identities: {}, onStop: null, spawnN: 0, removes: [], waits: 0,
  };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: { list: async () => porcelain(TWO), marker: (p, branch) => (merged && branch === 'feat/a' ? { branch, pr: 1, mergedAt: '2026-10-20T00:00:00Z' } : null) },
    ops: { ...NO_OPS, available: () => ({ create: false, setup: false, remove: true }), remove: async ({ path: p }) => { h.removes.push(normPath(p)); return { ok: true, already: false }; } },
    hosts: {
      choosePort: async (tab) => {
        let free = null;
        for (let p = base; p < base + 50; p++) {
          const occ = h.running[p];
          if (occ === undefined) { if (free === null) free = p; continue; }
          if (normPath(occ.cwd) === normPath(tab.cwd) && (occ.side === true) === (tab.side === true)) return { port: p, action: 'attach' };
        }
        return free === null ? null : { port: free, action: 'spawn' };
      },
      probe: async (port) => (h.running[port] !== undefined ? 'listening' : 'refused'),
      spawn: ({ tab, port, token }) => {
        h.order.push(`spawn:${tab.key}`);
        h.spawns.push({ key: tab.key, port, token, profileId: tab.profileId, side: tab.side === true });
        h.running[port] = { cwd: tab.cwd, side: tab.side === true };
        // the host's identity file: its pid and OS start time (what a proven kill is built from) and the profile it runs under
        if (killer !== null) h.identities[port] = { pid: 4000 + ++h.spawnN, start: `S${h.spawnN}`, ...(hostProfile ? { profile: hostProfile } : {}) };
      },
      wait: async () => !(failWaitOnce && ++h.waits === 1),
      tokenFor: tokenOf,
      tokenFile: tokenOf,
      newToken: () => `fresh-${++h.tokens}`,
      control: async (c) => {
        h.controls.push(c);
        if (c.msg.type === 'stop') {
          h.order.push(`stop:${c.port}`);
          if (h.onStop) await h.onStop(c);
          if (h.stopFails) return { ok: false, error: 'no answer' };
          // host-client waits 3 s for a reply and a host that is tearing down can outlast it: the host is gone, the reply is an error
          if (stopSlow) { delete h.running[c.port]; return { ok: false, error: 'timed out after 3000ms' }; }
          if (!h.stubborn) delete h.running[c.port];
        }
        return { ok: true, reply: null };
      },
      identity: () => null,
      readToken: () => null,
    },
    views: {
      create: (tab) => { const v = { tab: tab.key, id: h.viewsMade.length }; h.viewsMade.push(v); return v; },
      destroy: (tab) => { h.order.push(`destroy:${tab.key}`); h.viewsGone.push(tab.key); },
      send: (tab, channel, payload) => { h.sent.push([tab.key, channel, payload]); },
      owns: (tab, sender) => tab.view === sender,
    },
    ui: {
      confirmClose: async () => true,
      changed: (snap) => h.changes.push(snap),
      focusWindow: () => {},
      isFocused: () => true,
    },
    now: () => 1_000_000_000,
    sleep: async () => { h.slept++; },
  };
  // killer: 'ok' | 'none' (nothing provable: identify answers null) | an outcome string. A proven kill ends the host the way taskkill would.
  if (killer !== null) {
    deps.hosts.identify = ({ port }) => (killer === 'none' || h.hideIdent ? null : (h.identities[port] || null));
    deps.hosts.kill = async ({ pid, start }) => {
      h.order.push(`kill:${pid}`);
      h.kills.push([pid, start]);
      if (killer === 'ok') for (const [p, id] of Object.entries(h.identities)) if (id.pid === pid && id.start === start) delete h.running[p];
      return killer === 'ok' ? 'killed' : killer;
    };
  }
  if (profiles) {
    deps.profiles = {
      choose: (tab) => { h.chooses.push(tab.key); if (chooseThrows) throw new Error(chooseThrows); return chosen[tab.key] || 'default'; },
      resolve: (id) => PROFILES[id] || null,
      remember: (tab, id) => { h.remembered.push([tab.key, id]); },
    };
  }
  h.shell = createShell(deps);
  return h;
}

async function opened(over) {
  const h = harness(over);
  await h.shell.open();
  await flush();
  return h;
}

const entryOf = (h, name) => h.shell.model().find(e => e.key === key(name));

test('a tab\'s first start asks for its profile once and spawns under it', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  assert.deepStrictEqual(h.chooses, [key('dev')]);
  assert.deepStrictEqual(h.spawns.map(s => [s.key, s.profileId]), [[key('dev'), 'work']]);
});

test('each tab gets its own profile: dev under work, feat-a under the default', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  await h.shell.select(key('feat-a'));
  await flush();
  assert.deepStrictEqual(h.spawns.map(s => [s.key, s.profileId]), [[key('dev'), 'work'], [key('feat-a'), 'default']]);
});

test('the strip model carries the tab\'s profile as a dot; the default has none', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  await h.shell.select(key('feat-a'));
  await flush();
  assert.deepStrictEqual(entryOf(h, 'dev').profileDot, { colour: '#4c8bf5', name: 'Work' });
  assert.strictEqual(entryOf(h, 'feat-a').profileDot, null);
});

test('without a profile store the shell works as before: no profile, nothing asked', async () => {
  const h = await opened({ profiles: false });
  assert.strictEqual(h.spawns.length, 1);
  assert.strictEqual(h.spawns[0].profileId, null);
  assert.strictEqual(entryOf(h, 'dev').profileDot, null);
});

test('changeProfile on a tab with no session sets it, remembers it, and restarts nothing', async () => {
  const h = await opened();
  const r = await h.shell.changeProfile(key('feat-a'), 'play');
  assert.deepStrictEqual(r, { ok: true, restarted: false });
  assert.deepStrictEqual(h.remembered, [[key('feat-a'), 'play']]);
  assert.strictEqual(h.controls.length, 0);
  await h.shell.select(key('feat-a'));
  await flush();
  assert.strictEqual(h.spawns.find(s => s.key === key('feat-a')).profileId, 'play');
  assert.strictEqual(h.chooses.includes(key('feat-a')), false, 'a hand pick is not overridden by the remembered choice');
});

test('changeProfile on a live tab stops the old host, waits for it to go, then spawns under the new profile', async () => {
  const h = await opened();
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.deepStrictEqual(h.order.filter(o => /dev|stop/.test(o)).map(o => o.replace(/:.*/, '')), ['spawn', 'stop', 'destroy', 'spawn']);
  assert.deepStrictEqual(h.spawns.map(s => s.profileId), ['default', 'work']);
  assert.deepStrictEqual(h.remembered, [[key('dev'), 'work']]);
  assert.strictEqual(entryOf(h, 'dev').started, true);
  assert.deepStrictEqual(entryOf(h, 'dev').profileDot, { colour: '#4c8bf5', name: 'Work' });
});

test('changeProfile does not spawn while the old host still answers; it gives up and leaves the old profile', async () => {
  const h = await opened({ stubborn: true });
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /didn't end|still/i);
  assert.strictEqual(h.spawns.length, 1, 'no second host onto a live session');
  assert.deepStrictEqual(h.remembered, []);
  assert.strictEqual(entryOf(h, 'dev').started, true);
  assert.strictEqual(h.viewsGone.length, 0, 'the page stays');
});

test('a stop whose reply timed out still counts when the host is really gone: the port, not the reply, is the truth', async () => {
  const h = await opened({ stopSlow: true });
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.deepStrictEqual(h.spawns.map(s => s.profileId), ['default', 'work']);
});

const killOps = (h) => h.order.filter(o => /^(spawn|stop|kill|destroy)/.test(o)).map(o => o.replace(/:.*/, ''));

test('a host that will not leave after the stop is ended by a PROVEN kill of the pid and start the tab last SAW, then the restart goes on', async () => {
  const h = await opened({ stubborn: true, killer: 'ok' });
  const seen = { ...h.identities[h.shell.tabByKey(key('dev')).port] };
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.deepStrictEqual(h.kills, [[seen.pid, seen.start]]);
  assert.deepStrictEqual(killOps(h), ['spawn', 'stop', 'kill', 'destroy', 'spawn']);
  assert.deepStrictEqual(h.spawns.map(s => s.profileId), ['default', 'work']);
});

test('a polite exit needs no kill', async () => {
  const h = await opened({ killer: 'ok' });
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.deepStrictEqual(h.kills, []);
});

test('a stubborn host the tab never saw an identity for is left alone: no kill, no restart, the old profile stays', async () => {
  const h = await opened({ stubborn: true, killer: 'none' });
  const r = await h.shell.changeProfile(key('dev'), 'work');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(h.kills, []);
  assert.strictEqual(h.spawns.length, 1);
  assert.strictEqual(h.viewsGone.length, 0);
});

test('a kill that did not take (mismatch, failed, unknown) restarts nothing, and says the session was told to stop and still runs (Dexter 12a)', async () => {
  for (const outcome of ['mismatch', 'failed', 'unknown']) {
    const h = await opened({ stubborn: true, killer: outcome });
    const r = await h.shell.changeProfile(key('dev'), 'work');
    assert.strictEqual(r.ok, false, outcome);
    assert.match(r.error, /didn't end/, outcome);
    assert.match(r.error, /told to stop and is still running/, outcome);
    assert.match(r.error, /Nothing was restarted/, outcome);
    assert.strictEqual(h.spawns.length, 1, outcome);
  }
});

test('REUSED PORT: the tab\'s host exited unseen and another folder\'s host bound its port; switching kills NOTHING of the stranger (Dexter 1)', async () => {
  const h = await opened({ stubborn: true, killer: 'ok' });
  const port = h.shell.tabByKey(key('dev')).port;
  // A's host is gone and B (another project, another window) now serves the port, with its own pid and start time
  h.identities[port] = { pid: 9999, start: 'B-START' };
  h.running[port] = { cwd: wt('some-other-project'), side: false };
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(h.kills, [], 'B was not killed');
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop'), [], 'and was not sent A\'s stop either');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.spawns.map(s => s.profileId), ['default', 'work'], 'A restarts under the new profile on a port of its own');
  assert.notStrictEqual(h.spawns[1].port, port);
});

test('the same pid with a DIFFERENT start time is a different process (pid reuse): nothing is killed', async () => {
  const h = await opened({ stubborn: true, killer: 'ok' });
  const port = h.shell.tabByKey(key('dev')).port;
  h.identities[port] = { pid: h.identities[port].pid, start: 'REUSED-PID' };
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(h.kills, []);
  assert.strictEqual(r.ok, true);
});

test('the identity file being gone mid-teardown is not "someone else": the recorded proof is still what is killed', async () => {
  const h = await opened({ stubborn: true, killer: 'ok' });
  const port = h.shell.tabByKey(key('dev')).port;
  const seen = { ...h.identities[port] };
  h.onStop = async () => { h.hideIdent = true; };               // the stopping host removes its identity file
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(h.kills, [[seen.pid, seen.start]]);
  assert.strictEqual(r.ok, true);
});

test('a switch does not let the merged-lane poll read its own stop as "session ended, remove the worktree" (Dexter 5)', async () => {
  const h = await opened({ merged: true });
  await h.shell.select(key('feat-a'));
  await flush();
  await h.shell.poll();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')).started, true);
  h.onStop = async (c) => { delete h.running[c.port]; await h.shell.poll(); };   // the host is gone, and the poll lands before the restart
  const r = await h.shell.changeProfile(key('feat-a'), 'work');
  await flush();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.removes, [], 'the worktree is not removed');
  const e = h.shell.model().find(x => x.key === key('feat-a'));
  assert.notStrictEqual(e.phase, 'removing');
  assert.strictEqual(h.shell.tabByKey(key('feat-a')).started, true, 'and the tab is running again');
});

test('a pick made while the first host is still coming up drops that pending host, so the next start is under the NEW profile (Dexter 6)', async () => {
  const h = await opened({ failWaitOnce: true });
  const tab = h.shell.tabByKey(key('dev'));
  assert.strictEqual(tab.started, false, 'the first start timed out');
  assert.ok(tab.pending, 'with a host that may still be coming up');
  const r = await h.shell.changeProfile(key('dev'), 'work');
  assert.deepStrictEqual(r, { ok: true, restarted: false });
  assert.strictEqual(tab.pending, null);
  assert.strictEqual(h.controls.filter(c => c.msg.type === 'stop').length, 1, 'the old-profile host was told to stop');
  await h.shell.select(key('dev'));
  await flush();
  assert.strictEqual(h.spawns[h.spawns.length - 1].profileId, 'work');
  assert.strictEqual(h.shell.tabByKey(key('dev')).started, true);
});

test('a pending host that will not go blocks the pick instead of letting Retry attach to it under the old account', async () => {
  const h = await opened({ failWaitOnce: true, stubborn: true });
  const r = await h.shell.changeProfile(key('dev'), 'work');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /still coming up|still running|didn't end/);
});

test('a host attached at open reveals its profile before any hello: it counts as in use at once (Miguel Y4)', async () => {
  const h = harness({ killer: 'ok', hostProfile: 'work' });
  h.running[7700] = { cwd: wt('dev'), side: false };
  h.identities[7700] = { pid: 4242, start: 'S0', profile: 'work' };
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('dev')).started, true);
  assert.deepStrictEqual([...h.shell.profilesInUse()], ['work']);
  assert.deepStrictEqual(entryOf(h, 'dev').profileDot, { colour: '#4c8bf5', name: 'Work' });
});

test('a profile store that cannot be read refuses the tab\'s start with the reason; nothing is spawned on a guessed account (Dexter 4)', async () => {
  const h = await opened({ chooseThrows: 'couldn\'t read your profiles file' });
  const tab = h.shell.tabByKey(key('dev'));
  assert.strictEqual(tab.started, false);
  assert.match(tab.error, /couldn't read your profiles file/);
  assert.strictEqual(h.spawns.length, 0);
});

test('changeProfile when the old host will not take the stop changes nothing', async () => {
  const h = await opened({ stopFails: true });
  const r = await h.shell.changeProfile(key('dev'), 'work');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(h.remembered, []);
  assert.strictEqual(h.spawns.length, 1);
  assert.strictEqual(h.viewsGone.length, 0);
  assert.deepStrictEqual(entryOf(h, 'dev').profileDot, null);
});

test('changeProfile to the profile it already has does nothing; an unknown profile, tab or side key is refused', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  assert.deepStrictEqual(await h.shell.changeProfile(key('dev'), 'work'), { ok: true, restarted: false });
  assert.strictEqual(h.controls.length, 0);
  for (const bad of [['ghost', 'work'], [key('dev'), 'ghost'], [key('dev'), 5], [key('dev'), ''], [sideKeyOf(key('dev')), 'work']]) {
    assert.strictEqual((await h.shell.changeProfile(...bad)).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(h.controls.length, 0);
  assert.deepStrictEqual(h.remembered, []);
});

test('the default profile can be picked by id even though the store lists it first', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  const r = await h.shell.changeProfile(key('dev'), 'default');
  await flush();
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.strictEqual(h.spawns[h.spawns.length - 1].profileId, 'default');
});

test('a host that reports its own profile is believed: the record follows it, and nothing is remembered', async () => {
  const h = await opened();
  const tab = h.shell.tabByKey(key('dev'));
  h.shell.reportProfile(tab.view, 'work');
  assert.deepStrictEqual(entryOf(h, 'dev').profileDot, { colour: '#4c8bf5', name: 'Work' });
  assert.deepStrictEqual(h.remembered, []);
  h.shell.reportProfile(tab.view, 5);
  h.shell.reportProfile(tab.view, '');
  h.shell.reportProfile({}, 'play');
  assert.deepStrictEqual(entryOf(h, 'dev').profileDot, { colour: '#4c8bf5', name: 'Work' }, 'garbage and strangers change nothing');
});

test('a side session runs under its branch tab\'s profile, and is dropped when that tab changes account', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  await h.shell.openSide(key('dev'));
  await flush();
  const side = h.spawns.find(s => s.side);
  assert.strictEqual(side.profileId, 'work');
  const sk = sideKeyOf(key('dev'));
  assert.ok(h.shell.tabByKey(sk));
  const r = await h.shell.changeProfile(key('dev'), 'play');
  await flush();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.shell.tabByKey(sk), null, 'the old account\'s side session is gone');
});

test('profilesInUse lists the ids of every tab', async () => {
  const h = await opened({ chosen: { [key('dev')]: 'work' } });
  await h.shell.changeProfile(key('feat-a'), 'play');
  assert.deepStrictEqual([...h.shell.profilesInUse()].sort(), ['play', 'work']);
});

// --- the probe driver ----------------------------------------------------------------------------------------

const { handleProbeCommand } = require('../app/tab-shell');
const PROBE_TOKEN = 'p'.repeat(32);
const probe = (cmd, api) => handleProbeCommand(JSON.stringify({ token: PROBE_TOKEN, ...cmd }), api, PROBE_TOKEN);

test('the probe driver can pick a tab\'s profile by label and id, and refuses it without both', async () => {
  const seen = [];
  const api = { profile: async (label, id) => { seen.push([label, id]); return { ok: true }; } };
  assert.deepStrictEqual(await probe({ cmd: 'profile', label: 'feat/a', id: 'work' }, api), { ok: true });
  assert.deepStrictEqual(seen, [['feat/a', 'work']]);
  for (const bad of [{}, { label: 'x' }, { id: 'work' }, { label: '', id: 'work' }, { label: 'x', id: '' }, { label: 5, id: 'work' }, { label: 'x', id: 5 }]) {
    assert.strictEqual((await probe({ cmd: 'profile', ...bad }, api)).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(seen.length, 1);
});

test('a tab whose session already ended restarts under the new profile without stopping anything', async () => {
  const h = await opened();
  const tab = h.shell.tabByKey(key('dev'));
  delete h.running[tab.port];                 // the session ended; the page is still there
  tab.ended = true;
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.strictEqual(h.controls.length, 0, 'nothing to stop');
  assert.strictEqual(h.spawns[h.spawns.length - 1].profileId, 'work');
  assert.strictEqual(entryOf(h, 'dev').started, true);
});

test('an identity file that main marks FOREIGN (another folder\'s host on the tab\'s port) is a stranger: no stop, no kill, never a proof (Dexter 1)', async () => {
  const h = await opened({ stubborn: true, killer: 'ok' });
  const port = h.shell.tabByKey(key('dev')).port;
  h.identities[port] = { pid: 7777, start: 'OTHER', foreign: true };
  h.running[port] = { cwd: wt('some-other-project'), side: false };
  const r = await h.shell.changeProfile(key('dev'), 'work');
  await flush();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.kills, []);
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop'), []);
});

test('a foreign identity is never recorded as the tab\'s proof, at start or from a status report', async () => {
  const h = harness({ killer: 'ok' });
  h.running[7700] = { cwd: wt('dev'), side: false };
  h.identities[7700] = { pid: 1, start: 'X', foreign: true };
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('dev')).hostProof, null);
});
