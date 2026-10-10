'use strict';
/**
 * BACKLOG #81 (Ricardo's answer): in the strip's ▾ background-sessions list a side host is LABELLED "side", not an ordinary row.
 * Open on one that is a tab of this window goes to that tab; Open on one that is not is refused (null): a window attached to a side
 * host would be refused by the handshake anyway, and a side session lives as a tab of its branch's tab.
 */
const test = require('node:test');
const assert = require('node:assert');
const { listBackgroundHosts } = require('../host/background-hosts');
const { menuModel } = require('../app/background-menu');

const OWN = 'C:\cc\feat-a';
const ft = ms => String((BigInt(ms) + 11644473600000n) * 10000n);
const NOW = 1790000000000;

async function rowsFor(files) {
  const deps = {
    installs: () => [OWN],
    identities: () => Object.entries(files).map(([port, parsed]) => ({ port: Number(port), parsed })),
    startTimes: async (pids) => new Map(pids.map(p => [p, ft(4800)])),
    windowCounts: async (targets) => new Map(targets.map(t => [t.pid, 0])),
  };
  return (await listBackgroundHosts({ ownInstall: OWN }, deps)).rows;
}

test('a side host\'s row says so; an ordinary row is what it always was (no side key)', async () => {
  const rows = await rowsFor({
    7701: { port: 7701, cwd: 'C:/proj/feat-a', pid: 101, startedAt: 5000 },
    7702: { port: 7702, cwd: 'C:/proj/feat-a', pid: 102, startedAt: 5100, side: true },
    7703: { port: 7703, cwd: 'C:/proj/feat-b', pid: 103, startedAt: 5200, side: 'yes' },
  });
  const by = Object.fromEntries(rows.map(r => [r.port, r]));
  assert.strictEqual(by[7702].side, true);
  assert.ok(!('side' in by[7701]));
  assert.ok(!('side' in by[7703]), 'only a real true');
});

const row = (over = {}) => ({
  install: OWN, build: 'feat-a', own: true, port: 7701, pid: 101, cwd: 'C:/Users/ricar/proj/feat-a',
  startedAt: NOW - 3 * 3600e3, processStartedAt: '1', windows: 0, ...over,
});
const model = (rows, tabsByPort = new Map()) => menuModel({ rows, verified: true }, { now: NOW, tabsByPort });

test('the ▾ label of a side host carries the word "side"; an ordinary host\'s does not', () => {
  const [plain, sided] = model([row(), row({ port: 7702, pid: 102, side: true })]).items;
  assert.ok(!/side/.test(plain.label), plain.label);
  assert.match(sided.label, /feat-a\s+\S+\s+side\s+\S+\s+feat-a/);
});

test('Open on a side host that is a tab of this window goes to that tab; on one that is not, it is refused (null), never a window', () => {
  const m = model([row({ port: 7702, pid: 102, side: true })], new Map([[7702, 'c:\proj\feat-a|side']]));
  assert.deepStrictEqual(m.items[0].open, { kind: 'select-tab', key: 'c:\proj\feat-a|side' });
  const away = model([row({ port: 7702, pid: 102, side: true })]);
  assert.strictEqual(away.items[0].open, null);
  // an ordinary own host that is not a tab still opens a window
  assert.strictEqual(model([row()]).items[0].open.kind, 'window');
});

test('a side host still offers Stop when it is not a tab here (it is a running claude like any other)', () => {
  assert.strictEqual(model([row({ port: 7702, pid: 102, side: true })]).items[0].stop, true);
});
