'use strict';
/**
 * app/home-controller.js (plan documentation/PLAN_PROJECT_HUB.md H-PR2): Home's main-side logic with every effect faked. It builds the
 * cards (app/home-model.js) from the record, the cached recents, the windows and the windowless sessions; pushes the page a payload;
 * filters per keystroke with filterCards on the last built list; validates every act from the page; keeps the last good record.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createHomeController, pagePayload, EMPTY_TEXT, WIRED_ACTIONS } = require('../app/home-controller');

const keyOf = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').toLowerCase() : null);
const labelOf = (root) => String(root).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const projectOf = (p) => {
  if (typeof p !== 'string' || !p) return null;
  const m = /^(.*?)\\(dev|feat-[^\\]+)(\\.*)?$/i.exec(p);
  return m ? { kind: 'container', root: m[1], dev: `${m[1]}\\dev` } : { kind: 'flat', root: p, dev: p };
};
const flush = () => new Promise((r) => setImmediate(r));

function rig(over = {}) {
  const pushed = [];
  const effects = [];
  const s = {
    record: { projects: [{ root: 'C:\\a', lastOpened: 20 }, { root: 'C:\\b', lastOpened: 10 }], pins: [], removed: [] },
    readFails: false, recents: [], recentsReads: 0, windows: [], windowless: [], windowlessReads: 0, time: 1000,
  };
  const record = {
    readFresh: () => (s.readFails ? null : s.record),
    pin: (root, on) => { effects.push(['pin', root, on]); s.record = { ...s.record, pins: on ? [...s.record.pins, root] : s.record.pins.filter((p) => p !== root) }; return s.record; },
    remove: (root) => { effects.push(['remove', root]); s.record = { ...s.record, removed: [...s.record.removed, root] }; return s.record; },
  };
  const c = createHomeController({
    record,
    readRecents: async () => { s.recentsReads++; return s.recents; },
    windows: () => s.windows,
    windowless: async () => { s.windowlessReads++; return s.windowless; },
    projectOf, exists: () => true, keyOf, labelOf,
    push: (p) => pushed.push(p),
    effects: {
      open: (cwd) => effects.push(['open', cwd]), goTo: (root) => effects.push(['goTo', root]),
      closeWindow: (root) => effects.push(['closeWindow', root]), showInExplorer: (root) => effects.push(['explorer', root]),
      chooseFolder: () => effects.push(['chooseFolder']),
    },
    now: () => s.time,
    log: () => {},
    ...over,
  });
  return { c, s, pushed, effects, last: () => pushed[pushed.length - 1] };
}

test('sync builds the cards from the record and pushes the page its payload', () => {
  const t = rig();
  t.c.sync();
  assert.deepStrictEqual(t.last().cards.map((c) => c.key), ['c:\\a', 'c:\\b']);
  assert.deepStrictEqual(t.last().summary, { open: 0, needs: 0, total: 2, shown: 2 });
  assert.strictEqual(t.last().filter, '');
  assert.strictEqual(t.last().empty, null);
  assert.strictEqual(t.last().now, 1000);
});

test('H-PR3: the page gets Stop its sessions (windowless cards only) and New lane', () => {
  const t = rig();
  t.s.windowless = [{ cwd: 'C:\\a\\dev' }, { cwd: 'C:\\a\\feat-x' }];
  t.c.sync();
  return t.c.refresh({ force: true }).then(() => {
    const a = t.last().cards.find((c) => c.key === 'c:\\a');
    assert.deepStrictEqual(a.actions, ['open', 'stop-sessions', 'pin', 'show-in-explorer', 'new-lane']);
    assert.strictEqual(a.sessions, 2);
    const b = t.last().cards.find((c) => c.key === 'c:\\b');
    assert.ok(!b.actions.includes('stop-sessions'), 'a closed card has no sessions to stop');
    assert.ok(WIRED_ACTIONS.includes('stop-sessions') && WIRED_ACTIONS.includes('new-lane'));
  });
});

function stopRig(report, { askAnswer } = {}) {
  const calls = [];
  const t = rig({ effects: {
    open() {}, goTo() {}, closeWindow() {}, showInExplorer() {}, chooseFolder() {},
    askStop: async (key) => { calls.push(['ask', key]); return askAnswer || { ok: true, token: 'tok', count: 2 }; },
    stopSessions: async (key, token) => {
      calls.push(['stop', key, token]);
      if (report instanceof Error) throw report;
      if (typeof report === 'function') return report();
      return report;
    },
    newLane: async (root, branch) => { calls.push(['lane', root, branch]); return { ok: true, branch }; },
  } });
  t.s.windowless = [{ cwd: 'C:\\a\\dev' }, { cwd: 'C:\\a\\feat-x' }];
  return { t, calls };
}

test('PR #265 Dexter 3, 5: the ask is main\'s: stop-ask answers the count and a token; a stop with no token stops nothing', async () => {
  const { t, calls } = stopRig({ ok: true, asked: 2, stopped: 2, kept: 0, texts: [] });
  await t.c.refresh({ force: true });
  assert.deepStrictEqual(await t.c.act({ action: 'stop-ask', key: 'c:\\a' }), { ok: true, token: 'tok', count: 2 });
  for (const token of [undefined, '', 5, null]) {
    assert.deepStrictEqual(await t.c.act({ action: 'stop-sessions', key: 'c:\\a', token, confirmed: true }), { ok: false, error: 'a stop needs its question first' });
  }
  assert.deepStrictEqual(calls, [['ask', 'c:\\a']]);
  assert.deepStrictEqual(await t.c.act({ action: 'stop-ask', key: 'c:\\b' }), { ok: false, error: 'that card does not offer stop-sessions' });
});

test('an ask main refused (no session now, a stop running) is said; the page gets no token', async () => {
  const { t } = stopRig(null, { askAnswer: { ok: false, error: 'no session of this project runs with no window now' } });
  await t.c.refresh({ force: true });
  assert.deepStrictEqual(await t.c.act({ action: 'stop-ask', key: 'c:\\a' }), { ok: false, error: 'no session of this project runs with no window now' });
  const odd = stopRig(null, { askAnswer: { ok: true, token: 'x', count: 0 } });
  await odd.t.c.refresh({ force: true });
  assert.strictEqual((await odd.t.c.act({ action: 'stop-ask', key: 'c:\\a' })).ok, false, 'a question about no session is no question');
});

test('H8: a stop with its token runs on the card\'s KEY, answers the counts, and awaits a forced refresh before it answers (Miguel G1)', async () => {
  const { t, calls } = stopRig({ ok: true, asked: 2, stopped: 2, kept: 0, texts: [] });
  await t.c.refresh({ force: true });
  const reads = t.s.windowlessReads;
  t.s.windowless = [];
  assert.deepStrictEqual(await t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' }), { ok: true, asked: 2, stopped: 2, kept: 0 });
  assert.deepStrictEqual(calls, [['stop', 'c:\\a', 'tok']]);
  assert.strictEqual(t.s.windowlessReads, reads + 1, 'a forced refresh, already done when the answer came');
  assert.strictEqual(t.last().cards.find((c) => c.key === 'c:\\a').state, 'closed');
});

test('Miguel G1: a stop that threw still reads the cards again before it answers', async () => {
  const { t } = stopRig(new Error('powershell failed'));
  await t.c.refresh({ force: true });
  const reads = t.s.windowlessReads;
  assert.deepStrictEqual(await t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' }), { ok: false, asked: 0, stopped: 0, kept: 0, error: 'powershell failed' });
  assert.strictEqual(t.s.windowlessReads, reads + 1);
});

test('H8: a stop that kept a session says so with its text; a refusal passes through; a shapeless answer is no success', async () => {
  const kept = stopRig({ ok: false, asked: 2, stopped: 1, kept: 1, texts: ['Couldn\'t stop that session: it has a window open.'] });
  await kept.t.c.refresh({ force: true });
  assert.deepStrictEqual(await kept.t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' }),
    { ok: false, asked: 2, stopped: 1, kept: 1, error: 'Couldn\'t stop that session: it has a window open.' });
  const refused = stopRig({ ok: false, error: 'the question expired; ask again' });
  await refused.t.c.refresh({ force: true });
  assert.deepStrictEqual(await refused.t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' }), { ok: false, error: 'the question expired; ask again' });
  for (const bad of [null, {}, { asked: 2, stopped: '2', kept: 0 }]) {
    const r = stopRig(bad);
    await r.t.c.refresh({ force: true });
    assert.strictEqual((await r.t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' })).ok, false, JSON.stringify(bad));
  }
});

test('PR #265 Dexter 6 / Miguel Y3: while a stop runs the card offers no Stop, says it is stopping, and a second stop is refused', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { t, calls } = stopRig(async () => { await gate; return { ok: true, asked: 2, stopped: 2, kept: 0, texts: [] }; });
  await t.c.refresh({ force: true });
  const first = t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' });
  await flush();
  const during = t.last().cards.find((c) => c.key === 'c:\\a');
  assert.ok(!during.actions.includes('stop-sessions'), 'no Stop while one runs');
  assert.strictEqual(during.stopping, true);
  assert.deepStrictEqual(await t.c.act({ action: 'stop-sessions', key: 'c:\\a', token: 'tok' }), { ok: false, error: 'a stop is already running for this project' });
  assert.deepStrictEqual(await t.c.act({ action: 'stop-ask', key: 'c:\\a' }), { ok: false, error: 'a stop is already running for this project' });
  release();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(calls.filter((c) => c[0] === 'stop').length, 1);
  assert.strictEqual(t.last().cards.find((c) => c.key === 'c:\\a').stopping, undefined);
});

test('New lane: a bad branch name or a bare type is refused before any call; a good one runs on the card\'s root', async () => {
  const { t, calls } = stopRig(null);
  t.c.sync();
  for (const branch of [undefined, '', '  ', '-x', 'feat/a b', 'feat/"x"', 'feat/', 'refactor/']) {
    const r = await t.c.act({ action: 'new-lane', key: 'c:\\b', branch });
    assert.strictEqual(r.ok, false, JSON.stringify(branch));
    assert.strictEqual(typeof r.error, 'string');
  }
  assert.deepStrictEqual(await t.c.act({ action: 'new-lane', key: 'c:\\b', branch: 'feat/' }), { ok: false, error: 'type a name after the branch type' });
  assert.deepStrictEqual(await t.c.act({ action: 'new-lane', key: 'c:\\b', branch: ' feat/x ' }), { ok: true, branch: 'feat/x' });
  assert.deepStrictEqual(calls, [['lane', 'C:\\b', 'feat/x']]);
  assert.deepStrictEqual(await t.c.act({ action: 'new-lane', key: 'c:\\b', branch: `feat/${'x'.repeat(200)}` }), { ok: false, error: 'a branch name is at most 120 characters' });
});

test('New lane: a create that failed answers its error word for word; a throw is an error; a made lane with a failed setup says made', async () => {
  const t = rig({ effects: { open() {}, goTo() {}, closeWindow() {}, showInExplorer() {}, chooseFolder() {}, askStop: async () => null, stopSessions: async () => null,
    newLane: async (root, branch) => {
      if (branch === 'feat/boom') throw new Error('the window did not start');
      if (branch === 'feat/half') return { ok: false, made: true, branch, error: 'its setup failed: npm ci failed' };
      return { ok: false, error: 'demo has no prefix: use feat/.' };
    } } });
  t.c.sync();
  assert.deepStrictEqual(await t.c.act({ action: 'new-lane', key: 'c:\\b', branch: 'demo' }), { ok: false, error: 'demo has no prefix: use feat/.' });
  assert.deepStrictEqual(await t.c.act({ action: 'new-lane', key: 'c:\\b', branch: 'feat/boom' }), { ok: false, error: 'the window did not start' });
  assert.deepStrictEqual(await t.c.act({ action: 'new-lane', key: 'c:\\b', branch: 'feat/half' }),
    { ok: false, made: true, branch: 'feat/half', error: 'its setup failed: npm ci failed' });
});

test('Dexter 5: a read that fails just now keeps the last good record, so the pins and the order do not flip', () => {
  const t = rig();
  t.s.record = { ...t.s.record, pins: ['C:\\b'] };
  t.c.sync();
  assert.deepStrictEqual(t.last().cards.map((c) => [c.key, c.pinned]), [['c:\\b', true], ['c:\\a', false]]);
  t.s.readFails = true;
  t.c.sync();
  assert.deepStrictEqual(t.last().cards.map((c) => [c.key, c.pinned]), [['c:\\b', true], ['c:\\a', false]]);
});

test('a read that fails before any good read shows the empty record (nothing to keep)', () => {
  const t = rig();
  t.s.readFails = true;
  t.c.sync();
  assert.deepStrictEqual(t.last().cards, []);
});

test('filter per keystroke: filterCards on the last built list, with no rebuild (no record read, no recents read)', () => {
  let reads = 0;
  const record = { projects: [{ root: 'C:\\a', lastOpened: 20 }, { root: 'C:\\b', lastOpened: 10 }], pins: [], removed: [] };
  const t2 = rig({ record: { readFresh: () => { reads++; return record; }, pin() {}, remove() {} } });
  t2.c.sync();
  const before = reads;
  t2.c.act({ action: 'filter', text: 'B' });
  assert.strictEqual(reads, before, 'no rebuild');
  assert.deepStrictEqual(t2.last().cards.map((c) => c.key), ['c:\\b']);
  assert.deepStrictEqual(t2.last().summary, { open: 0, needs: 0, total: 2, shown: 1 });
  assert.strictEqual(t2.last().filter, 'B');
  t2.c.sync();
  assert.deepStrictEqual(t2.last().cards.map((c) => c.key), ['c:\\b'], 'a rebuild keeps the filter');
});

test('a filter that is not text, or over 200 characters, is refused and changes nothing', () => {
  const t = rig();
  t.c.sync();
  const n = t.pushed.length;
  assert.deepStrictEqual(t.c.act({ action: 'filter', text: 5 }), { ok: false, error: 'a filter is text' });
  assert.deepStrictEqual(t.c.act({ action: 'filter', text: 'x'.repeat(201) }), { ok: false, error: 'a filter is text' });
  assert.strictEqual(t.pushed.length, n);
});

test('the empty state: no project at all, and no project matching the filter, each say so', () => {
  assert.strictEqual(EMPTY_TEXT, 'No projects yet. Choose a folder to open one.');
  assert.strictEqual(pagePayload({ cards: [], summary: { open: 0, needs: 0, total: 0, shown: 0 } }, '', 1).empty, EMPTY_TEXT);
  const some = { cards: [{ key: 'k', label: 'viral', root: 'C:\\viral', roots: ['C:\\viral'], actions: ['open'] }], summary: { open: 0, needs: 0, total: 1, shown: 1 } };
  assert.strictEqual(pagePayload(some, 'zz', 1).empty, 'No project matches "zz".');
  assert.strictEqual(pagePayload(some, 'vir', 1).empty, null);
});

test('acts on a card: each wired action runs its one effect on the card\'s root', () => {
  const t = rig();
  t.s.windows = [{ root: 'C:\\a', label: 'a', tabs: 1, needs: 0, lanes: [{ key: 'c:\\a\\dev', label: 'dev', path: 'C:\\a\\dev', needs: false }] }];
  t.c.sync();
  assert.deepStrictEqual(t.c.act({ action: 'go-to', key: 'c:\\a' }), { ok: true });
  assert.deepStrictEqual(t.c.act({ action: 'close-window', key: 'c:\\a' }), { ok: true });
  assert.deepStrictEqual(t.c.act({ action: 'show-in-explorer', key: 'c:\\a' }), { ok: true });
  assert.deepStrictEqual(t.c.act({ action: 'open', key: 'c:\\b' }), { ok: true });
  assert.deepStrictEqual(t.c.act({ action: 'lane', key: 'c:\\a', lane: 'C:\\a\\dev' }), { ok: true });
  assert.deepStrictEqual(t.c.act({ action: 'choose-folder' }), { ok: true });
  assert.deepStrictEqual(t.effects, [['goTo', 'C:\\a'], ['closeWindow', 'C:\\a'], ['explorer', 'C:\\a'], ['open', 'C:\\b'], ['open', 'C:\\a\\dev'], ['chooseFolder']]);
});

test('pin, unpin and remove edit the record by the card\'s root and push a fresh build', () => {
  const t = rig();
  t.c.sync();
  t.c.act({ action: 'pin', key: 'c:\\b' });
  assert.deepStrictEqual(t.last().cards.map((c) => [c.key, c.pinned]), [['c:\\b', true], ['c:\\a', false]]);
  t.c.act({ action: 'unpin', key: 'c:\\b' });
  t.c.act({ action: 'remove', key: 'c:\\a' });
  assert.deepStrictEqual(t.effects, [['pin', 'C:\\b', true], ['pin', 'C:\\b', false], ['remove', 'C:\\a']]);
  assert.deepStrictEqual(t.last().cards.map((c) => c.key), ['c:\\b']);
});

test('every act is validated: an unknown key, an action the card does not offer, an unknown lane, a bad message', () => {
  const t = rig();
  t.c.sync();
  assert.deepStrictEqual(t.c.act({ action: 'open', key: 'c:\\nope' }), { ok: false, error: 'no such card' });
  assert.deepStrictEqual(t.c.act({ action: 'go-to', key: 'c:\\a' }), { ok: false, error: 'that card does not offer go-to' });
  assert.deepStrictEqual(t.c.act({ action: 'stop-sessions', key: 'c:\\a' }), { ok: false, error: 'that card does not offer stop-sessions' });
  assert.deepStrictEqual(t.c.act({ action: 'lane', key: 'c:\\a', lane: 'C:\\elsewhere' }), { ok: false, error: 'no such lane' });
  for (const bad of [null, 'open', [], { action: 7 }, { action: 'open' }]) assert.strictEqual(t.c.act(bad).ok, false, JSON.stringify(bad));
  assert.deepStrictEqual(t.effects, []);
});

test('a key is checked against ALL the cards, not only the ones the filter shows', () => {
  const t = rig();
  t.c.sync();
  t.c.act({ action: 'filter', text: 'a' });
  assert.deepStrictEqual(t.c.act({ action: 'open', key: 'c:\\b' }), { ok: true });
});

test('an effect that throws answers ok: false with its message; the controller goes on', () => {
  const t = rig({ effects: { open: () => { throw new Error('gone'); }, goTo() {}, closeWindow() {}, showInExplorer() {}, chooseFolder() {} } });
  t.c.sync();
  assert.deepStrictEqual(t.c.act({ action: 'open', key: 'c:\\a' }), { ok: false, error: 'gone' });
  assert.deepStrictEqual(t.c.act({ action: 'filter', text: '' }), { ok: true });
});

test('refresh reads the recents and the windowless sessions at most once a minute unless forced (Miguel G2: no powershell every 30 s); then it pushes', async () => {
  const t = rig();
  t.s.recents = [{ path: 'C:\\z\\dev', approximate: false, lastUsed: 99 }];
  await t.c.refresh({ force: true });
  assert.strictEqual(t.s.recentsReads, 1);
  assert.deepStrictEqual(t.last().cards.map((c) => c.key), ['c:\\z', 'c:\\a', 'c:\\b']);
  t.s.time += 30_000;
  const n = t.pushed.length;
  await t.c.refresh();
  assert.strictEqual(t.s.recentsReads, 1, 'fresh enough');
  assert.strictEqual(t.s.windowlessReads, 1, 'fresh enough: no powershell');
  assert.strictEqual(t.pushed.length, n + 1, 'it still pushes');
  t.s.time += 31_000;
  await t.c.refresh();
  assert.strictEqual(t.s.recentsReads, 2);
  assert.strictEqual(t.s.windowlessReads, 2);
});

test('PR #263 Miguel Y1: syncSoon (the strip push) coalesces: two pushes in one turn build once, and a card that needs you shows it', async () => {
  const deferred = [];
  let reads = 0;
  const record = { projects: [{ root: 'C:\\a', lastOpened: 20 }], pins: [], removed: [] };
  const t = rig({ defer: (fn) => deferred.push(fn), record: { readFresh: () => { reads++; return record; }, pin() {}, remove() {} } });
  t.s.windows = [{ root: 'C:\\a', label: 'a', tabs: 2, needs: 0, lanes: [] }];
  t.c.syncSoon();
  t.s.windows = [{ root: 'C:\\a', label: 'a', tabs: 2, needs: 1, lanes: [] }];
  t.c.syncSoon();
  assert.strictEqual(deferred.length, 1, 'one sync queued');
  assert.strictEqual(reads, 0, 'nothing built yet');
  deferred.shift()();
  assert.strictEqual(reads, 1);
  assert.strictEqual(t.last().cards[0].needs, 1);
  assert.deepStrictEqual(t.last().summary.needs, 1);
  t.c.syncSoon();
  assert.strictEqual(deferred.length, 1, 'a later push queues again');
});

test('PR #263 Miguel Y2: onSourcesChanged runs when a refresh read different lists, or was forced; never on the same lists', async () => {
  let changed = 0;
  const t = rig({ onSourcesChanged: () => { changed++; } });
  t.s.recents = [{ path: 'C:\\z', approximate: false, lastUsed: 99 }];
  await t.c.refresh({ force: true });
  assert.strictEqual(changed, 1, 'forced');
  t.s.time += 61_000;
  await t.c.refresh();
  assert.strictEqual(changed, 1, 'the same lists: the cached disk facts stay');
  t.s.time += 61_000;
  t.s.windowless = [{ cwd: 'C:\\w' }];
  await t.c.refresh();
  assert.strictEqual(changed, 2, 'a windowless session appeared');
});

test('PR #263 Miguel G3: a forced refresh asked while an unforced one is in flight is not lost: it runs after it', async () => {
  const t = rig();
  await t.c.refresh({ force: true });
  t.s.time += 1000;                                 // fresh: the unforced refresh reads no recents
  const a = t.c.refresh();
  const b = t.c.refresh({ force: true });
  await Promise.all([a, b]);
  assert.strictEqual(t.s.recentsReads, 2, 'the forced read ran');
  const c = t.c.refresh({ force: true });
  const d = t.c.refresh({ force: true });
  await Promise.all([c, d]);
  assert.strictEqual(t.s.recentsReads, 3, 'a forced one in flight is shared by another forced one');
});

test('PR #263 Miguel Y3: a pin or remove the record refused answers ok: false and says so; nothing is reported done', () => {
  const t = rig({ record: { readFresh: () => ({ projects: [{ root: 'C:\\a', lastOpened: 20 }], pins: [], removed: [] }), pin: () => null, remove: () => null } });
  t.c.sync();
  assert.deepStrictEqual(t.c.act({ action: 'pin', key: 'c:\\a' }), { ok: false, error: 'the record was not written' });
  assert.deepStrictEqual(t.c.act({ action: 'remove', key: 'c:\\a' }), { ok: false, error: 'the record was not written' });
});

test('PR #263 Dexter 1: closed() resets the filter, so a Home made again shows every card under an empty filter box', () => {
  const t = rig();
  t.c.sync();
  t.c.act({ action: 'filter', text: 'zz' });
  assert.strictEqual(t.last().empty, 'No project matches "zz".');
  t.c.closed();
  const m = t.c.model();
  assert.strictEqual(m.filter, '');
  assert.deepStrictEqual(m.cards.map((c) => c.key), ['c:\\a', 'c:\\b']);
  assert.strictEqual(m.empty, null);
});

test('PR #263 Miguel G8: a lane matches its card\'s lane by the exact path main sent; page input is never normalised', () => {
  const seen = [];
  const t = rig({ keyOf: (p) => { seen.push(p); return keyOf(p); } });
  t.s.windows = [{ root: 'C:\\a', label: 'a', tabs: 1, needs: 0, lanes: [{ key: 'c:\\a\\dev', label: 'dev', path: 'C:\\a\\dev', needs: false }] }];
  t.c.sync();
  seen.length = 0;
  assert.deepStrictEqual(t.c.act({ action: 'lane', key: 'c:\\a', lane: 'c:\\A\\DEV' }), { ok: false, error: 'no such lane' });
  assert.ok(!seen.includes('c:\\A\\DEV'), 'no keyOf on the page\'s string');
  assert.deepStrictEqual(t.c.act({ action: 'lane', key: 'c:\\a', lane: 'C:\\a\\dev' }), { ok: true });
});

test('PR #263 Dexter 8: windowFacts leaves out a registered window whose BrowserWindow is gone, so its card offers Open', () => {
  const { windowFacts } = require('../app/home-controller');
  const tabs = [{ key: 'k1', cwd: 'C:\\a\\dev', branch: 'dev' }, { key: 'k2', cwd: 'C:\\a\\feat-x', branch: 'feat/x' }, { key: 's', cwd: 'C:\\a', side: true }];
  const pw = (root, win) => ({ root, label: root, win, tabShell: { snapshot: () => ({ tabs }) } });
  const alive = { isDestroyed: () => false };
  const dead = { isDestroyed: () => true };
  const facts = windowFacts([pw('C:\\a', alive), pw('C:\\b', dead), pw('C:\\c', null)], () => ['k2']);
  assert.deepStrictEqual(facts, [{ root: 'C:\\a', label: 'C:\\a', tabs: 3, needs: 1, lanes: [
    { key: 'k1', label: 'dev', path: 'C:\\a\\dev', needs: false }, { key: 'k2', label: 'feat/x', path: 'C:\\a\\feat-x', needs: true }] }]);
  const t = rig();
  t.s.windows = facts;
  t.c.sync();
  assert.deepStrictEqual(t.last().cards.find((c) => c.key === 'c:\\b').actions.includes('open'), true);
});

test('a recents read that fails (null) keeps the last list; a windowless read that throws keeps the last one', async () => {
  let calls = 0;
  const t = rig({ windowless: async () => { calls++; if (calls > 1) throw new Error('powershell'); return [{ cwd: 'C:\\w' }]; } });
  t.s.recents = [{ path: 'C:\\z', approximate: false, lastUsed: 99 }];
  await t.c.refresh({ force: true });
  t.s.recents = null;
  await t.c.refresh({ force: true });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(t.last().cards.map((c) => c.key).sort(), ['c:\\a', 'c:\\b', 'c:\\w', 'c:\\z']);
});

test('two refreshes at once read once each source (a refresh in flight is shared)', async () => {
  const t = rig();
  await Promise.all([t.c.refresh({ force: true }), t.c.refresh({ force: true })]);
  assert.strictEqual(t.s.recentsReads, 1);
  assert.strictEqual(t.s.windowlessReads, 1);
});

test('before any push the page asks: model() answers the last payload, or the build from now', async () => {
  const t = rig();
  assert.deepStrictEqual(t.c.model().cards.map((c) => c.key), ['c:\\a', 'c:\\b']);
  await flush();
});
