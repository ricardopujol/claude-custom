'use strict';
/**
 * Invisible usage counters (audit move 2): one install-wide file, `.harness/state/usage-counters.json`,
 * `{ "<key>": { count, last } }`. Keys and ISO timestamps only. The store's guarantees: counts never go down,
 * a file it can't read is never written over, and the renderer's keys are checked against an allow-list.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createUsageCounters, isValidKey, STATIC_KEYS, PANEL_IDS, GAME_IDS, STORE_KEY, KEYS_MAX, RATE_PER_SEC, LOCK_WAIT_MS } = require('../host/usage-counters');
const sideTabs = require('../app/side-tabs');
const gamesDisplay = require('../app/games-display');

function setup() {
  const dir = tmpDir('usage-counters');
  const store = createStore({ dir });
  let t = Date.parse('2026-10-15T10:00:00Z');
  const clock = { advance: (ms) => { t += ms; } };
  const counters = createUsageCounters({ store, now: () => t });
  return { dir, store, counters, clock, file: path.join(dir, `${STORE_KEY}.json`) };
}

test('the store key is usage-counters', () => assert.strictEqual(STORE_KEY, 'usage-counters'));

test('a bump creates the file and counts one, with an ISO timestamp', () => {
  const { counters, file } = setup();
  assert.deepStrictEqual(counters.bump('ask:question'), { ok: true, count: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'ask:question': { count: 1, last: '2026-10-15T10:00:00.000Z' } });
});

test('bumps add up and move "last"', () => {
  const { counters, clock } = setup();
  counters.bump('wand:click'); clock.advance(5000); counters.bump('wand:click');
  assert.deepStrictEqual(counters.all(), { 'wand:click': { count: 2, last: '2026-10-15T10:00:05.000Z' } });
});

test('other keys are written back verbatim, unknown ones too', () => {
  const { counters, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ 'future:key': { count: 7, last: 'x', extra: 1 } }));
  counters.bump('git:opened');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['future:key'], { count: 7, last: 'x', extra: 1 });
});

test('junk keys are refused and nothing is written', () => {
  const { counters, file } = setup();
  for (const k of ['', 'nope', 'panel:zzz', 'panel:Git', 'game:nope:start', 'panel:__proto__', 'ask:question ', '__proto__', 'panel:', 'panel:../x', 'panel:' + 'a'.repeat(40), 'game:x:stop', 7, null, undefined, {}, 'C:\\secret\\path']) {
    assert.strictEqual(counters.bump(k).ok, false, String(k));
  }
  assert.strictEqual(fs.existsSync(file), false);
});

test('isValidKey takes the fixed keys, panel:<id> and game:<name>:start', () => {
  for (const k of STATIC_KEYS) assert.ok(isValidKey(k), k);
  assert.ok(isValidKey('panel:git'));
  assert.ok(isValidKey('game:stack:start'));
  assert.ok(!isValidKey('panel:Git Hub'));
});

test("the brief's keys are all in the set", () => {
  for (const k of ['ask:question', 'ask:place-opened', 'medal:given', 'wand:click', 'style:changed', 'vault:opened', 'git:opened',
    'projects:switch', 'canvas:render', 'focus:on', 'lean:on', 'terminal:file-link', 'terminal:drop', 'tab:new-worktree',
    'tab:merged-close', 'bedtime:start', 'quota:countdown-shown']) assert.ok(STATIC_KEYS.includes(k), k);
});

test('a panel shown twice inside 2 s counts once; after 2 s it counts again; other keys are not debounced', () => {
  const { counters, clock } = setup();
  assert.strictEqual(counters.bump('panel:git').ok, true);
  clock.advance(1999);
  assert.deepStrictEqual(counters.bump('panel:git'), { ok: false, reason: 'debounced' });
  assert.strictEqual(counters.bump('panel:ask').ok, true);
  clock.advance(1);
  assert.strictEqual(counters.bump('panel:git').count, 2);
  assert.strictEqual(counters.bump('ask:question').count, 1);
  assert.strictEqual(counters.bump('ask:question').count, 2);
});

test('style:changed is debounced too (a slider drag is one change)', () => {
  const { counters, clock } = setup();
  assert.strictEqual(counters.bump('style:changed').ok, true);
  clock.advance(500);
  assert.strictEqual(counters.bump('style:changed').reason, 'debounced');
  clock.advance(1500);
  assert.strictEqual(counters.bump('style:changed').count, 2);
});

test('an unreadable file is never written over: it is copied aside once and left alone', () => {
  const { counters, file } = setup();
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(counters.bump('git:opened'), { ok: false, reason: 'unreadable' });
  counters.bump('git:opened');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.strictEqual(fs.readFileSync(`${file}.bad`, 'utf8'), '{ not json');
  assert.strictEqual(counters.all(), null);
});

test('the wrong shape (an array, a bad entry for the key) is unreadable too, and untouched', () => {
  for (const content of ['[]', '"x"', JSON.stringify({ 'git:opened': { count: -1, last: 'x' } }), JSON.stringify({ 'git:opened': 5 })]) {
    const { counters, file } = setup();
    fs.writeFileSync(file, content);
    assert.strictEqual(counters.bump('git:opened').ok, false, content);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
  }
});

test('a failed write is reported and the file keeps its old content', () => {
  const { counters, store, file } = setup();
  counters.bump('git:opened');
  const before = fs.readFileSync(file, 'utf8');
  const broken = createUsageCounters({ store: { ...store, write() { throw new Error('EPERM'); } } });
  assert.deepStrictEqual(broken.bump('git:opened'), { ok: false, reason: 'write-failed' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('all() is {} for a missing file and null for an unreadable one', () => {
  const { counters, file } = setup();
  assert.deepStrictEqual(counters.all(), {});
  counters.bump('git:opened');
  fs.writeFileSync(file, 'garbage');
  assert.strictEqual(counters.all(), null);
});

test('PROPERTY: over any run of bumps, every count only goes up and equals the number of accepted bumps', () => {
  const keys = ['git:opened', 'ask:question', 'wand:click', 'panel:git', 'junk'];
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom(...keys), fc.integer({ min: 0, max: 3000 })), { maxLength: 25 }), (steps) => {
    const { counters, clock } = setup();
    const accepted = {};
    let prev = {};
    for (const [key, dt] of steps) {
      clock.advance(dt);
      const r = counters.bump(key);
      if (r.ok) accepted[key] = (accepted[key] || 0) + 1;
      const now = counters.all();
      for (const k of Object.keys(prev)) assert.ok(now[k].count >= prev[k].count);
      prev = now;
    }
    for (const k of Object.keys(accepted)) assert.strictEqual(prev[k].count, accepted[k]);
    assert.deepStrictEqual(Object.keys(prev).sort(), Object.keys(accepted).sort());
  }), { numRuns: 30 });
});

test('PROPERTY: a file the store can\'t read is byte-for-byte unchanged after any run of bumps', () => {
  const unreadable = fc.string({ maxLength: 40 }).filter((s) => {
    try { const v = JSON.parse(s); return v === null || typeof v !== 'object' || Array.isArray(v); } catch { return true; }
  });
  fc.assert(fc.property(unreadable, fc.array(fc.constantFrom('git:opened', 'wand:click'), { maxLength: 5 }), (content, bumps) => {
    const { counters, file } = setup();
    fs.writeFileSync(file, content);
    for (const k of bumps) counters.bump(k);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
  }), { numRuns: 30 });
});

test('the real-id lists are the dock\'s panels and the games\' names (I1)', () => {
  assert.deepStrictEqual([...PANEL_IDS].sort(), sideTabs.TABS.map((t) => t.id).sort());
  assert.deepStrictEqual([...GAME_IDS], gamesDisplay.ORDER);
  assert.ok(isValidKey('panel:fog'));
  assert.ok(!isValidKey('panel:zzz'));
});

test('a flood is dropped: RATE_PER_SEC bumps in one instant, then a second later there is room again (I2)', () => {
  const { counters, clock } = setup();
  let ok = 0;
  for (let i = 0; i < RATE_PER_SEC + 10; i++) if (counters.bump('wand:click').ok) ok++;
  assert.strictEqual(ok, RATE_PER_SEC);
  assert.deepStrictEqual(counters.bump('wand:click'), { ok: false, reason: 'rate' });
  clock.advance(1000);
  assert.strictEqual(counters.bump('wand:click').ok, true);
  while (counters.bump('wand:click').ok);
  clock.advance(500);
  let half = 0;
  for (let i = 0; i < 30; i++) if (counters.bump('wand:click').ok) half++;
  assert.ok(half >= RATE_PER_SEC / 2 - 1 && half <= RATE_PER_SEC / 2 + 1, String(half));
});

test('the edit runs inside the store lock, with a short wait, and a lock that cannot be taken is busy (I4/I2)', () => {
  const { store } = setup();
  let inLock = false; let opts = null;
  const spy = {
    ...store,
    withLock(name, fn, o) { opts = o; inLock = true; try { return store.withLock(name, fn, o); } finally { inLock = false; } },
    readState(name) { assert.ok(inLock, 'read outside the lock'); return store.readState(name); },
    write(name, v) { assert.ok(inLock, 'write outside the lock'); return store.write(name, v); },
  };
  assert.strictEqual(createUsageCounters({ store: spy }).bump('git:opened').ok, true);
  assert.deepStrictEqual(opts, { deadlineMs: LOCK_WAIT_MS });
  const busy = createUsageCounters({ store: { ...store, withLock() { throw new Error('lock timeout'); } } });
  assert.deepStrictEqual(busy.bump('git:opened'), { ok: false, reason: 'busy' });
});

test('the unreadable file is set aside ONCE: a second, different bad file does not replace the first copy', () => {
  const { counters, file } = setup();
  fs.writeFileSync(file, 'AAA{');
  counters.bump('git:opened');
  fs.writeFileSync(file, 'BBB{');
  counters.bump('git:opened');
  assert.strictEqual(fs.readFileSync(`${file}.bad`, 'utf8'), 'AAA{');
});

test('a copy that fails is logged, and the bump is still refused', () => {
  const { store } = setup();
  const lines = [];
  const bad = { ...store, readState: () => ({ status: 'corrupt', value: null }), pathOf: () => { throw new Error('no path'); } };
  const c = createUsageCounters({ store: bad, log: (l) => lines.push(l) });
  assert.strictEqual(c.bump('git:opened').reason, 'unreadable');
  assert.match(lines.join('\n'), /could not set the unreadable counters file aside: no path/);
});

test('the file holds at most KEYS_MAX keys: a new key is refused (bytes unchanged), an existing one still counts', () => {
  const { counters, file } = setup();
  const seeded = {};
  for (let i = 0; i < KEYS_MAX; i++) seeded['old:' + i] = { count: 1, last: 'x' };
  seeded['git:opened'] = { count: 4, last: 'x' };
  delete seeded['old:0'];
  const text = JSON.stringify(seeded);
  fs.writeFileSync(file, text);
  assert.deepStrictEqual(counters.bump('wand:click'), { ok: false, reason: 'full' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  assert.strictEqual(counters.bump('git:opened').count, 5);
});

test('extra fields on the bumped key survive (a newer build\'s data), and an overflowing count is refused', () => {
  const { counters, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ 'git:opened': { count: 1, last: 'x', extra: 1 } }));
  counters.bump('git:opened');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['git:opened'].extra, 1);
  fs.writeFileSync(file, JSON.stringify({ 'git:opened': { count: Number.MAX_SAFE_INTEGER, last: 'x' } }));
  assert.deepStrictEqual(counters.bump('git:opened'), { ok: false, reason: 'full' });
});

// ---- BACKLOG #97 (Ricardo 2026-11-06: "Fix the count first"): only his own gestures in his own windows count ------------------
// MEASURED 2026-11-07 (verify/probe-dock-tree.js in a lane, before and after; numbers in the PR): a probe's window drives the dock
// through window.__dockProbe, every action of which went through commitPlacement / selectModule and so counted as a gesture; the
// host and main it starts write the counters of the checkout it runs from (dev's, when a probe runs there). So counting is OFF in
// any process a probe started (the probe mark, host/probe-mark.js), in main started under the tabs probe, and in anything a
// `node --test` run started.

const { countingOff, resetPrefix } = require('../host/usage-counters');
const { MARK_VAR, makeMark } = require('../host/probe-mark');

test('#97: countingOff says why a process never counts, and null for a person\'s own window', () => {
  assert.strictEqual(typeof countingOff, 'function');
  assert.strictEqual(countingOff({}), null);
  assert.strictEqual(countingOff({ PATH: 'x', CLAUDE_CUSTOM_SESSION: '1' }), null, 'a harness-hosted session is a person\'s');
  assert.strictEqual(countingOff({ [MARK_VAR]: makeMark(1234) }), 'probe');
  assert.strictEqual(countingOff({ CLAUDE_CUSTOM_TABS_PROBE: '7790' }), 'probe');
  assert.strictEqual(countingOff({ NODE_TEST_CONTEXT: 'child-v8' }), 'test');
  assert.strictEqual(countingOff(undefined), null);
});

test('#97: a counter that is off refuses every bump and never creates the file', () => {
  const dir = tmpDir('usage-counters-off');
  const store = createStore({ dir });
  const counters = createUsageCounters({ store, off: 'probe' });
  for (const key of ['panel:agents', 'git:opened', 'game:stack:start']) assert.deepStrictEqual(counters.bump(key), { ok: false, reason: 'off' }, key);
  assert.ok(!fs.existsSync(path.join(dir, `${STORE_KEY}.json`)));
});

test('#97: a counter that is not off counts as before', () => {
  const dir = tmpDir('usage-counters-on');
  const counters = createUsageCounters({ store: createStore({ dir }), off: null });
  assert.strictEqual(counters.bump('panel:agents').count, 1);
});

test('#97 reset: resetPrefix drops the panel:* keys, keeps every other key verbatim, and keeps the old file whole beside it', () => {
  const { store, file, dir } = setup();
  const before = { 'panel:agents': { count: 76, last: 'a' }, 'panel:style': { count: 87, last: 'b' }, 'git:opened': { count: 134, last: 'c', extra: 1 },
    'game:stack:start': { count: 1, last: 'd' } };
  const text = JSON.stringify(before, null, 2);
  fs.writeFileSync(file, text);
  const r = resetPrefix({ store, prefix: 'panel:', now: () => Date.parse('2026-11-07T18:30:00Z') });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.removed.sort(), ['panel:agents', 'panel:style']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'git:opened': before['git:opened'], 'game:stack:start': before['game:stack:start'] });
  assert.strictEqual(r.archive, path.join(dir, `${STORE_KEY}.before-reset-2026-11-07T18-30-00Z.json`));
  assert.strictEqual(fs.readFileSync(r.archive, 'utf8'), text, 'the old values are kept, byte for byte');
});

test('#97 reset: a missing file resets nothing and writes nothing; an unreadable one is refused and left alone', () => {
  const a = setup();
  assert.deepStrictEqual(resetPrefix({ store: a.store, prefix: 'panel:' }), { ok: true, removed: [], archive: null });
  assert.ok(!fs.existsSync(a.file));
  const b = setup();
  fs.writeFileSync(b.file, '{ not json');
  const r = resetPrefix({ store: b.store, prefix: 'panel:' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(b.file, 'utf8'), '{ not json');
  assert.ok(!fs.readdirSync(b.dir).some(f => f.includes('before-reset')));
});

test('Y1 (PR #246): a copy that fails half way leaves no archive and drops no key; a short copy is caught and refused', () => {
  const before = { 'panel:agents': { count: 7, last: 'a' }, 'git:opened': { count: 3, last: 'b' } };
  // the copy dies after writing part of the file
  const a = setup();
  const text = JSON.stringify(before);
  fs.writeFileSync(a.file, text);
  const dying = (src, dest) => { fs.writeFileSync(dest, text.slice(0, 10)); throw new Error('disk full'); };
  const r = resetPrefix({ store: a.store, prefix: 'panel:', now: () => Date.parse('2026-11-07T18:30:00Z'), copyFile: dying });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /could not be kept/);
  assert.strictEqual(fs.readFileSync(a.file, 'utf8'), text, 'no key was dropped');
  assert.ok(!fs.readdirSync(a.dir).some(f => f.includes('before-reset')), 'no truncated archive, no .partial left: ' + fs.readdirSync(a.dir));
  // a copy that "succeeds" but is short
  const b = setup();
  fs.writeFileSync(b.file, text);
  const short = (src, dest) => fs.writeFileSync(dest, text.slice(0, 10));
  const r2 = resetPrefix({ store: b.store, prefix: 'panel:', copyFile: short });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(fs.readFileSync(b.file, 'utf8'), text);
  assert.ok(!fs.readdirSync(b.dir).some(f => f.includes('before-reset')));
  // an archive of that name already there is never overwritten
  const c = setup();
  fs.writeFileSync(c.file, text);
  const stamp = () => Date.parse('2026-11-07T18:30:00Z');
  const first = resetPrefix({ store: c.store, prefix: 'panel:', now: stamp });
  assert.strictEqual(first.ok, true);
  fs.writeFileSync(c.file, text);
  assert.strictEqual(resetPrefix({ store: c.store, prefix: 'panel:', now: stamp }).ok, false, 'same second, same name: refused');
  assert.strictEqual(fs.readFileSync(first.archive, 'utf8'), text);
});

test('#97 reset: only a prefix that names a counter family is accepted (an empty one would wipe everything)', () => {
  const { store, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ 'git:opened': { count: 2, last: 'x' } }));
  for (const bad of ['', ':', 'panel', undefined, 'git:opened:']) assert.strictEqual(resetPrefix({ store, prefix: bad }).ok, false, String(bad));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['git:opened'].count, 2);
});

test('#97 wiring: host and main build their counters off for a probe or a test process; the page counts nothing on a probe page', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const read = (f) => strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  assert.match(read('host/host.js'), /createUsageCounters\(\{ store, off: countingOff\(process\.env\)/);
  assert.match(read('app/main.js'), /createUsageCounters\(\{ store: uiStore, off: countingOff\(process\.env\) \}\)/);
  const r = read('app/renderer.js');
  assert.match(r, /function usage\(key\) \{ if \(usageOff\) return; sendJson/);
  assert.match(r, /const usageOff = new URLSearchParams\(location\.search\)\.get\('probe'\) === '1';/);
  // Claude's own canvas render reveals its panel, but it is not a gesture of the person's
  assert.match(r, /function canvasDock\(\) \{[\s\S]*?try \{ revealModule\('canvas', \{ gesture: false \}\); \} finally \{ uncountedReveal = false; \}/);
  assert.match(r, /function revealModule\(id, \{ gesture = true \} = \{\}\) \{\s*if \(gesture\) usageGesture\(\);/);
  assert.match(r, /function commitPlacement\(next, \{ justThisTab = false, select = null, userAction = true, refit = true, gesture = true \} = \{\}\) \{[\s\S]{0,200}if \(gesture\) usageGesture\(\);/);
});
