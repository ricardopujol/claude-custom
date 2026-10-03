'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const m = require('../app/tab-model');

const DEV = { path: 'C:\\p\\dev', branch: 'develop', isDev: true, phase: 'live', hostSeen: true };
const A = { path: 'C:\\p\\feat-a', branch: 'feat/a', isDev: false, phase: 'live', hostSeen: true };
const B = { path: 'C:\\p\\feat-b', branch: 'feat/b', isDev: false, phase: 'live', hostSeen: false };
const keyOf = p => p.toLowerCase();
const strip = (tabs, runtime = {}, sel = keyOf(DEV.path)) => m.stripModel({ tabs }, runtime, sel, { keyOf });

test('label is the branch', () => {
  assert.deepStrictEqual(strip([DEV, A]).map(e => e.label), ['develop', 'feat/a']);
});

test('a null or non-string branch labels with the folder name', () => {
  const rebasing = { ...A, branch: null };
  assert.strictEqual(strip([DEV, rebasing])[1].label, 'feat-a');
  assert.strictEqual(strip([DEV, { ...A, branch: 42 }])[1].label, 'feat-a');
  assert.strictEqual(strip([DEV, { ...A, path: 'C:\\p\\feat-a\\', branch: null }])[1].label, 'feat-a');
  assert.strictEqual(strip([DEV, { ...A, path: '/p/feat-a', branch: null }])[1].label, 'feat-a');
});

test('Dexter F4 (PR #80): a tab whose folder is being removed is not closable', () => {
  assert.deepStrictEqual(strip([DEV, { ...A, phase: 'removing' }, B]).map(e => e.closable), [false, false, true]);
});

test('closable: never dev, never a lone tab', () => {
  assert.deepStrictEqual(strip([DEV, A, B]).map(e => e.closable), [false, true, true]);
  assert.deepStrictEqual(strip([DEV]).map(e => e.closable), [false]);
  assert.deepStrictEqual(strip([A]).map(e => e.closable), [false]);
});

test('lock glyphs', () => {
  const g = lock => strip([DEV], { [keyOf(DEV.path)]: { status: { lock } } })[0].lockGlyph;
  assert.strictEqual(g('override'), 'open');
  assert.strictEqual(g('unlocked'), 'warn');
  assert.strictEqual(g('blocked'), 'blocked');
  assert.strictEqual(g('held'), null);
  assert.strictEqual(g('pending'), null);
  assert.strictEqual(g(null), null);
  assert.strictEqual(g('whatever'), null);
});

test('health passes through as text; null stays null', () => {
  const h = health => strip([DEV], new Map([[keyOf(DEV.path), { status: { health } }]]))[0].health;
  assert.strictEqual(h('↓3'), '↓3');
  assert.strictEqual(h('+12'), '+12');
  assert.strictEqual(h(null), null);
  assert.strictEqual(h(undefined), null);
  assert.strictEqual(h(''), null);
});

test('working / needsInput follow the status; a null status is false / null everywhere', () => {
  const k = keyOf(DEV.path);
  const on = strip([DEV], { [k]: { started: true, status: { working: true, needsInput: true } } })[0];
  assert.strictEqual(on.working, true);
  assert.strictEqual(on.needsInput, true);
  assert.strictEqual(on.started, true);
  for (const rt of [{}, { [k]: { started: false, status: null } }, { [k]: {} }]) {
    const e = strip([DEV], rt)[0];
    assert.strictEqual(e.working, false);
    assert.strictEqual(e.needsInput, false);
    assert.strictEqual(e.lockGlyph, null);
    assert.strictEqual(e.health, null);
    assert.strictEqual(e.started, false);
  }
});

test('#31 pulse: needs outranks done, a tab with neither or no status has none', () => {
  const k = keyOf(A.path);
  const pulse = status => strip([DEV, A], { [k]: { started: true, status } })[1].pulse;
  assert.strictEqual(pulse({ needsInput: true }), 'needs');
  assert.strictEqual(pulse({ finished: true }), 'done');
  assert.strictEqual(pulse({ needsInput: true, finished: true }), 'needs');
  assert.strictEqual(pulse({ working: true }), null);
  assert.strictEqual(pulse({ needsInput: 1, finished: 'yes' }), null, 'only a real true counts');
  assert.strictEqual(pulse(null), null);
  assert.strictEqual(strip([DEV, A])[1].pulse, null, 'no runtime at all');
});

test('#31 PROPERTY: the selected tab never pulses, whatever its status says', () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), (needsInput, finished) => {
    const rt = { [keyOf(DEV.path)]: { status: { needsInput, finished } }, [keyOf(A.path)]: { status: { needsInput, finished } } };
    for (const sel of [keyOf(DEV.path), keyOf(A.path)]) {
      const e = m.stripModel({ tabs: [DEV, A] }, rt, sel, { keyOf });
      for (const x of e) {
        if (x.selected) assert.strictEqual(x.pulse, null);
        else assert.strictEqual(x.pulse, needsInput ? 'needs' : finished ? 'done' : null);
      }
    }
  }));
});

test('phase and error come from the reducer', () => {
  const e = strip([DEV, { ...A, phase: 'remove-failed', error: 'busy' }])[1];
  assert.strictEqual(e.phase, 'remove-failed');
  assert.strictEqual(e.error, 'busy');
  assert.strictEqual(strip([DEV])[0].error, null);
});

// --- PR 3: what the strip says about a phase, a setup, a creation warning --------

test('note, setup and createdWarning come through; absent ones are null', () => {
  const k = keyOf(A.path);
  const e = strip([DEV, { ...A, phase: 'kept', note: 'still has a brief' }],
    { [k]: { started: true, setup: { running: true, line: 'npm ci', error: null, log: null }, createdWarning: 'no lane row' } })[1];
  assert.strictEqual(e.note, 'still has a brief');
  assert.deepStrictEqual(e.setup, { running: true, line: 'npm ci', error: null, log: null });
  assert.strictEqual(e.createdWarning, 'no lane row');
  const d = strip([DEV])[0];
  assert.strictEqual(d.note, null);
  assert.strictEqual(d.setup, null);
  assert.strictEqual(d.createdWarning, null);
});

const entry = (over = {}) => ({ label: 'feat/a', phase: 'live', error: null, note: null, setup: null, createdWarning: null, ...over });

test('phaseText for each phase of a merged worktree', () => {
  assert.strictEqual(m.phaseText(entry({ phase: 'finishing' })), 'Merged. When its session ends, this worktree is removed.');
  assert.strictEqual(m.phaseText(entry({ phase: 'removing' })), 'Removing this worktree…');
  assert.strictEqual(m.phaseText(entry({ phase: 'kept', note: 'feat/a still has a handoff brief' })),
    'Merged, and kept: feat/a still has a handoff brief');
  assert.strictEqual(m.phaseText(entry({ phase: 'remove-failed', error: 'has uncommitted changes' })),
    "Couldn't remove this worktree: has uncommitted changes");
});

test('phaseText for a setup and a creation warning; nothing for a plain live tab', () => {
  assert.strictEqual(m.phaseText(entry({ setup: { running: false, error: 'run failed', log: 'C:\\l.log' } })),
    'Setup failed: run failed Log: C:\\l.log');
  assert.strictEqual(m.phaseText(entry({ setup: { running: false, error: 'bad manifest', log: null } })),
    'Setup failed: bad manifest');
  // The real script quotes its log in the message: never name it twice (probe, 2026-09-30).
  assert.strictEqual(m.phaseText(entry({ setup: { running: false, error: "run: 'npm ci' exited with 1 (output in C:\\l.log).", log: 'C:\\l.log' } })),
    "Setup failed: run: 'npm ci' exited with 1 (output in C:\\l.log).");
  assert.strictEqual(m.phaseText(entry({ setup: { running: true, line: 'x', error: null } })), null,
    'a running setup is the pane\'s to show, not the alert\'s');
  assert.strictEqual(m.phaseText(entry({ createdWarning: 'Active Lanes row not added' })),
    'Created, but: Active Lanes row not added');
  assert.strictEqual(m.phaseText(entry()), null);
  assert.strictEqual(m.phaseText(null), null);
});

test('a phase outranks a setup failure, which outranks a creation warning', () => {
  const all = entry({ phase: 'finishing', setup: { running: false, error: 'e' }, createdWarning: 'w' });
  assert.match(m.phaseText(all), /^Merged/);
  assert.match(m.phaseText({ ...all, phase: 'live' }), /^Setup failed/);
});

test('badgeFor: merged for a merged worktree, warn for a failure, else null', () => {
  for (const phase of ['finishing', 'removing', 'kept']) assert.strictEqual(m.badgeFor(entry({ phase })), 'merged', phase);
  assert.strictEqual(m.badgeFor(entry({ phase: 'remove-failed', error: 'x' })), 'warn');
  assert.strictEqual(m.badgeFor(entry({ setup: { running: false, error: 'x' } })), 'warn');
  assert.strictEqual(m.badgeFor(entry({ setup: { running: true, error: null } })), null);
  assert.strictEqual(m.badgeFor(entry()), null);
  assert.strictEqual(m.badgeFor(undefined), null);
});

test('PROPERTY: phaseText never prints "null" or "undefined"', () => {
  const maybe = fc.option(fc.string(), { nil: null });
  fc.assert(fc.property(
    fc.constantFrom('live', 'finishing', 'removing', 'kept', 'remove-failed', null, undefined),
    maybe, maybe, fc.option(fc.record({ running: fc.boolean(), line: maybe, error: maybe, log: maybe }), { nil: null }), maybe,
    (phase, error, note, setup, createdWarning) => {
      const t = m.phaseText({ label: 'x', phase, error, note, setup, createdWarning });
      return t === null || (!t.includes('null') && !t.includes('undefined')) ||
        [error, note, createdWarning, setup && setup.error, setup && setup.log].some(v => typeof v === 'string' && /null|undefined/.test(v));
    }), { numRuns: 300 });
});

test('selection: matching key, else dev', () => {
  const sel = model => model.filter(e => e.selected).map(e => e.key);
  assert.deepStrictEqual(sel(strip([DEV, A, B], {}, keyOf(B.path))), [keyOf(B.path)]);
  assert.deepStrictEqual(sel(strip([DEV, A, B], {}, 'nope')), [keyOf(DEV.path)]);
  assert.deepStrictEqual(sel(strip([DEV, A, B], {}, undefined)), [keyOf(DEV.path)]);
});

test('dev is moved first', () => {
  assert.strictEqual(strip([A, DEV, B])[0].isDev, true);
});

test('select: existing key or the selection unchanged', () => {
  const model = strip([DEV, A], {}, keyOf(A.path));
  assert.strictEqual(m.select(model, keyOf(DEV.path)), keyOf(DEV.path));
  assert.strictEqual(m.select(model, 'nope'), keyOf(A.path));
});

test('neighbour wraps both ways', () => {
  const model = strip([DEV, A, B]);
  const [d, a, b] = model.map(e => e.key);
  assert.strictEqual(m.neighbour(model, d, 1), a);
  assert.strictEqual(m.neighbour(model, b, 1), d);
  assert.strictEqual(m.neighbour(model, d, -1), b);
  assert.strictEqual(m.neighbour(model, a, -1), d);
});

test('afterClose: unselected close keeps selection; selected goes right, else left', () => {
  const model = strip([DEV, A, B]);
  const [d, a, b] = model.map(e => e.key);
  assert.strictEqual(m.afterClose(model, b, a), a);
  assert.strictEqual(m.afterClose(model, a, a), b);
  assert.strictEqual(m.afterClose(model, b, b), a);
  assert.strictEqual(m.afterClose(strip([DEV, A]), keyOf(A.path), keyOf(A.path)), d);
});

test('initialSelection: equal, containing (deepest), else dev', () => {
  const isInside = (child, parent) => child.toLowerCase().startsWith(parent.toLowerCase() + '\\');
  const opts = { keyOf, isInside };
  const tabs = [DEV, A, B];
  assert.strictEqual(m.initialSelection(tabs, 'C:\\P\\FEAT-A', opts), keyOf(A.path));
  assert.strictEqual(m.initialSelection(tabs, 'C:\\p\\feat-b\\src\\x', opts), keyOf(B.path));
  assert.strictEqual(m.initialSelection(tabs, 'C:\\elsewhere', opts), keyOf(DEV.path));
  assert.strictEqual(m.initialSelection(tabs, null, opts), keyOf(DEV.path));
  assert.strictEqual(m.initialSelection([], 'C:\\x', opts), null);
  const nested = [DEV, { ...A, path: 'C:\\p\\feat-a' }, { ...B, path: 'C:\\p\\feat-a\\inner' }];
  assert.strictEqual(m.initialSelection(nested, 'C:\\p\\feat-a\\inner\\z', opts), keyOf('C:\\p\\feat-a\\inner'));
});

// --- properties ------------------------------------------------------------

const stateArb = fc.tuple(
  fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 0, maxLength: 6 }),
  fc.boolean(),
).map(([names, devFirst]) => {
  const tabs = names.map(n => ({ path: `C:\\p\\${n}`, branch: n, isDev: false, phase: 'live', hostSeen: true }));
  return devFirst ? [{ ...DEV }, ...tabs] : [...tabs, { ...DEV }];
});

test('PROPERTY: dev is first and unique; exactly one selected; dev never closable', () => {
  fc.assert(fc.property(stateArb, fc.string(), (tabs, sel) => {
    const model = strip(tabs, {}, sel);
    assert.strictEqual(model[0].isDev, true);
    assert.strictEqual(model.filter(e => e.isDev).length, 1);
    assert.strictEqual(model.filter(e => e.selected).length, 1);
    assert.ok(model.every(e => !(e.isDev && e.closable)));
    assert.ok(model.some(e => e.key === m.select(model, sel)));
  }));
});

test('PROPERTY: neighbour stepping +1 n times visits every tab once and returns to the start', () => {
  fc.assert(fc.property(stateArb, fc.nat(), (tabs, pick) => {
    const model = strip(tabs);
    const start = model[pick % model.length].key;
    const seen = [];
    let cur = start;
    for (let i = 0; i < model.length; i++) { cur = m.neighbour(model, cur, 1); seen.push(cur); }
    assert.strictEqual(cur, start);
    assert.deepStrictEqual([...seen].sort(), model.map(e => e.key).sort());
    assert.strictEqual(m.neighbour(model, m.neighbour(model, start, 1), -1), start);
  }));
});

test('PROPERTY: afterClose never selects the closed key and always names an existing tab', () => {
  fc.assert(fc.property(stateArb, fc.nat(), fc.nat(), (tabs, ci, si) => {
    const model = strip(tabs);
    fc.pre(model.length > 1);
    const closed = model[ci % model.length].key;
    const selected = model[si % model.length].key;
    const next = m.afterClose(model, closed, selected);
    assert.notStrictEqual(next, closed);
    assert.ok(model.some(e => e.key === next));
    if (closed !== selected) assert.strictEqual(next, selected);
  }));
});

// Backlog #52: a tab whose session is in a /bedtime night turns night-blue and wears a moon (the strip paints it).
test('night follows the status: only a real true, and a tab with no status has none', () => {
  const k = keyOf(DEV.path);
  const kA = keyOf(A.path);
  const [dev, a] = strip([DEV, A], { [k]: { started: true, status: { night: true } }, [kA]: { started: true, status: { night: 'yes' } } });
  assert.strictEqual(dev.night, true);
  assert.strictEqual(a.night, false);
  assert.strictEqual(strip([DEV], {})[0].night, false);
  assert.strictEqual(strip([DEV], { [k]: { started: false, status: null } })[0].night, false);
});

// Backlog #39: the tab's "where are we" summary comes from its status, for the strip's hover card.
test('summary follows the status: a usable one is carried, none is null', () => {
  const k = keyOf(DEV.path);
  const kA = keyOf(A.path);
  const sum = { text: 'Working on: x', model: 'llama3.2:3b', at: 5, stale: false, note: null };
  const [dev, a] = strip([DEV, A], { [k]: { started: true, status: { summary: sum } }, [kA]: { started: true, status: { summary: 'nope' } } });
  assert.deepStrictEqual(dev.summary, sum);
  assert.strictEqual(a.summary, null);
  assert.strictEqual(strip([DEV], {})[0].summary, null);
  assert.strictEqual(strip([DEV], { [k]: { started: false, status: null } })[0].summary, null);
});

test('summaryNote follows the status: a string is carried, anything else is null', () => {
  const k = keyOf(DEV.path);
  const [dev] = strip([DEV], { [k]: { started: true, status: { summaryNote: 'Local summary off' } } });
  assert.strictEqual(dev.summaryNote, 'Local summary off');
  assert.strictEqual(strip([DEV], { [k]: { started: true, status: { summaryNote: 5 } } })[0].summaryNote, null);
  assert.strictEqual(strip([DEV], {})[0].summaryNote, null);
});
