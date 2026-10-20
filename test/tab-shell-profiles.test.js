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

function harness({ chosen = {}, profiles = true, stopFails = false, stubborn = false, stopSlow = false } = {}) {
  const h = {
    running: {}, spawns: [], controls: [], viewsMade: [], viewsGone: [], sent: [], changes: [], order: [],
    remembered: [], chooses: [], tokens: 0, slept: 0, stopFails, stubborn,
  };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: { list: async () => porcelain(TWO), marker: () => null },
    ops: NO_OPS,
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
      },
      wait: async () => true,
      tokenFor: tokenOf,
      tokenFile: tokenOf,
      newToken: () => `fresh-${++h.tokens}`,
      control: async (c) => {
        h.controls.push(c);
        if (c.msg.type === 'stop') {
          h.order.push(`stop:${c.port}`);
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
  if (profiles) {
    deps.profiles = {
      choose: (tab) => { h.chooses.push(tab.key); return chosen[tab.key] || 'default'; },
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
