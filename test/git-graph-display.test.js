'use strict';
/**
 * The Graph view's page half (app/git-graph-display.js): where the dots and edges go, what the detail strip says and
 * offers, the remembered Rings|Graph choice, and the drawing driven through a fake document (test/fake-dom.js). The look
 * and the real window's scope are the probe's (verify/probe-git-graph.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { FakeDocument } = require('./fake-dom');
const display = require('../app/git-graph-display');
const { buildGraph } = require('../host/git-graph');

const c = (hash, parents = [], extra = {}) => ({ hash, parents, time: 1_760_000_000, author: 'Ann', subject: `msg ${hash}`, refs: [], ...extra });
const graphOf = (...commits) => ({ ok: true, integration: 'develop', ...buildGraph(commits) });
const { ROW_H, LANE_W, PAD } = display;
const ref = (name, remote = false) => ({ name, remote });

// ---------- the choice, remembered per project ----------

test('the view is Rings unless Graph was chosen, per project', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.strictEqual(display.readView(storage, 'C:\\p'), 'rings');
  display.writeView(storage, 'C:\\p', 'graph');
  assert.strictEqual(display.readView(storage, 'C:\\p'), 'graph');
  assert.strictEqual(display.readView(storage, 'C:\\other'), 'rings');
  display.writeView(storage, 'C:\\p', 'nonsense');
  assert.strictEqual(display.readView(storage, 'C:\\p'), 'rings', 'only the two views are ever kept');
  assert.notStrictEqual(display.viewKey('a'), display.viewKey('b'));
});

test('a storage that throws or is missing never breaks the choice', () => {
  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.strictEqual(display.readView(boom, 'p'), 'rings');
  assert.doesNotThrow(() => display.writeView(boom, 'p', 'graph'));
  assert.strictEqual(display.readView(null, 'p'), 'rings');
  assert.doesNotThrow(() => display.writeView(null, 'p', 'graph'));
  assert.strictEqual(display.readView({ getItem: () => 'graph' }, undefined), 'graph');
});

// ---------- geometry ----------

test('a dot per commit, one row apart, a lane to the right per lane', () => {
  const g = display.geometry(graphOf(c('m', ['d', 'f']), c('f', ['b']), c('d', ['b']), c('b')));
  assert.strictEqual(g.nodes.length, 4);
  assert.deepStrictEqual(g.nodes.map(n => n.y), [0, 1, 2, 3].map(i => i * ROW_H + ROW_H / 2));
  assert.deepStrictEqual(g.nodes.map(n => n.x), [0, 1, 0, 1].map(l => PAD + l * LANE_W));
  assert.deepStrictEqual(g.nodes.map(n => n.merge), [true, false, false, false]);
  assert.strictEqual(g.width, PAD * 2 + LANE_W);
  assert.strictEqual(g.height, 4 * ROW_H);
});

test('a straight line draws straight edges; a merge draws a curve and says it is a merge', () => {
  const line = display.geometry(graphOf(c('a', ['b']), c('b', ['c']), c('c')));
  assert.strictEqual(line.edges.length, 2);
  for (const e of line.edges) assert.ok(!e.d.includes('C'), e.d);
  const merge = display.geometry(graphOf(c('m', ['d', 'f']), c('f', ['b']), c('d', ['b']), c('b')));
  const curves = merge.edges.filter(e => e.d.includes('C'));
  assert.ok(curves.length >= 2);
  assert.strictEqual(merge.edges.filter(e => e.merge).length, 1);
});

test('an edge to a parent beyond the window runs off the bottom of the drawing', () => {
  const g = display.geometry(graphOf(c('a', ['gone'])));
  assert.strictEqual(g.edges.length, 1);
  assert.match(g.edges[0].d, new RegExp(`L${PAD} ${g.height}$`));
});

test('geometry of nothing, or of garbage, is an empty drawing', () => {
  for (const x of [null, undefined, {}, { commits: 'x' }]) {
    const g = display.geometry(x);
    assert.deepStrictEqual([g.nodes.length, g.edges.length, g.height], [0, 0, 0]);
  }
  assert.strictEqual(display.geometry(graphOf()).width, PAD * 2);
});

test('property: every dot and every edge end sits inside the drawing', () => {
  const dag = fc.integer({ min: 1, max: 25 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) =>
    fc.uniqueArray(fc.integer({ min: i + 1, max: n + 2 }), { maxLength: 3 }))))
    .map(ps => ps.map((p, i) => c(`h${i}`, p.map(x => `h${x}`))));
  fc.assert(fc.property(dag, commits => {
    const g = display.geometry({ ok: true, ...buildGraph(commits) });
    for (const n of g.nodes) {
      assert.ok(n.x >= 0 && n.x <= g.width && n.y > 0 && n.y < g.height);
    }
    for (const e of g.edges) {
      const nums = e.d.match(/-?\d+(\.\d+)?/g).map(Number);
      for (let i = 0; i < nums.length; i += 2) assert.ok(nums[i] >= 0 && nums[i] <= g.width, e.d);
      for (let i = 1; i < nums.length; i += 2) assert.ok(nums[i] >= 0 && nums[i] <= g.height, e.d);
    }
  }));
});

// ---------- the detail strip's model ----------

const TREE = { ok: true, prsKnown: true, repoUrl: 'https://github.com/o/r', originHost: null, branches: [
  { name: 'feat/a', state: 'open', place: 'worktree', folder: 'C:/p/feat-a', pr: 3 },
  { name: 'feat/b', state: 'unmerged', place: 'dev', folder: null, pr: null },
] };

test('the model names the commit: message, short hash, author, day, merge, refs', () => {
  const m = display.commitModel(c('abcdef0123456789', ['p1', 'p2'], { refs: [ref('develop')] }), { tree: TREE });
  assert.strictEqual(m.title, 'msg abcdef0123456789');
  assert.match(m.meta, /^abcdef0 · Ann · [A-Z][a-z]{2} \d{1,2} · merge of 2 parents$/);
  assert.deepStrictEqual(m.refs, ['develop']);
  assert.deepStrictEqual(m.actions.map(a => a.id), ['open-commit', 'jump', 'copy']);
});

test('no message and no time say so; they are never blank or 1970', () => {
  const m = display.commitModel({ hash: 'abcdef0', parents: [], subject: '', time: null, author: '' }, { tree: TREE });
  assert.strictEqual(m.title, '(no message)');
  assert.strictEqual(m.meta, 'abcdef0 · unknown date');
  assert.strictEqual(display.dayOf(null), null);
  assert.strictEqual(display.dayOf(NaN), null);
  assert.strictEqual(display.dayOf('5'), null);
  assert.strictEqual(display.dayOf(Number.MAX_VALUE), null);
});

test('Open commit follows origin: enabled with a GitHub repo, else disabled and says why', () => {
  const act = tree => display.commitModel(c('abcdef0'), { tree }).actions.find(a => a.id === 'open-commit');
  assert.strictEqual(act(TREE).enabled, true);
  assert.strictEqual(act({ ...TREE, repoUrl: null }).why, 'no GitHub remote ("origin") to open it on');
  assert.match(act({ ...TREE, repoUrl: null, originHost: 'github-work' }).why, /github-work, not a github\.com address/);
  assert.strictEqual(act(null).enabled, false);
  assert.match(act({ ok: false }).why, /hasn't loaded/);
});

test('Jump to its tab: only for the tip of a branch with an open worktree; the tab can veto it', () => {
  const jump = (commit, tab) => display.commitModel(commit, { tree: TREE, tab }).actions.find(a => a.id === 'jump');
  assert.strictEqual(jump(c('x1', [], { refs: [ref('feat/a')] })).enabled, true);
  assert.strictEqual(jump(c('x1', [], { refs: [ref('feat/a')] }), { open: false }).enabled, false);
  assert.match(jump(c('x1', [], { refs: [ref('feat/a')] }), { open: false }).why, /no tab/);
  assert.match(jump(c('x2', [], { refs: [ref('feat/b')] })).why, /no open worktree/);
  assert.strictEqual(jump(c('x3')).why, 'not the tip of a branch with an open worktree');
  assert.strictEqual(jump(c('x4', [], { refs: [ref('origin/feat/a', true)] })).enabled, false, 'a remote ref is not a worktree branch');
});

test('commitLink builds the URL from the repo and a hex hash only', () => {
  assert.strictEqual(display.commitLink(c('abcdef0'), TREE), 'https://github.com/o/r/commit/abcdef0');
  assert.strictEqual(display.commitLink(c('zzz'), TREE), null);
  assert.strictEqual(display.commitLink(c('abcdef0'), { ...TREE, repoUrl: null }), null);
  assert.strictEqual(display.commitLink(c('abcdef0'), null), null);
  assert.strictEqual(display.commitLink(null, TREE), null);
});

// ---------- the drawing ----------

const flush = () => new Promise(res => setImmediate(res));

function rig({ graph = graphOf(c('a1b2c3d', ['e4f5a6b'], { refs: [ref('develop')] }), c('e4f5a6b', [], { subject: '<b>x</b>' })), tree = TREE, tabs = [], handlers = {} } = {}) {
  const doc = new FakeDocument();
  const rootEl = doc.createElement('section');
  doc.root.appendChild(rootEl);
  const status = doc.createElement('div'); status.setAttribute('id', 'git-graph-status'); rootEl.appendChild(status);
  const graphEl = doc.createElement('div'); graphEl.setAttribute('id', 'git-graph'); rootEl.appendChild(graphEl);
  const calls = { open: [], jump: [], copy: [] };
  const deps = {
    onOpenUrl: handlers.onOpenUrl || (async url => { calls.open.push(url); return true; }),
    onJump: handlers.onJump || (async folder => { calls.jump.push(folder); return null; }),
    onCopy: handlers.onCopy || (async text => { calls.copy.push(text); }),
  };
  const redraw = (g = graph, t = tree, tb = tabs) => display.render(rootEl, g, { ...deps, tree: t, tabs: tb });
  redraw();
  const rows = () => graphEl.querySelectorAll('.gg-row');
  const row = hash => rows().find(r => r.getAttribute('data-hash') === hash);
  const button = id => graphEl.querySelector(`.git-act[data-act="${id}"]`);
  const said = () => graphEl.querySelector('.gg-said').textContent;
  const detail = () => graphEl.querySelector('.gg-detail');
  return { doc, rootEl, status, graphEl, calls, redraw, rows, row, button, said, detail };
}

test('one row per commit with its ref chips and message, one dot and the edges in the svg', () => {
  const r = rig();
  assert.strictEqual(r.rows().length, 2);
  assert.strictEqual(r.row('a1b2c3d').querySelector('.gg-ref').textContent, 'develop');
  assert.strictEqual(r.row('a1b2c3d').querySelector('.gg-msg').textContent, 'msg a1b2c3d');
  assert.strictEqual(r.graphEl.querySelectorAll('.gg-dot').length, 2);
  assert.strictEqual(r.graphEl.querySelectorAll('.gg-edge').length, 1);
  assert.strictEqual(r.status.textContent, '');
  assert.strictEqual(r.detail().hidden, true);
});

test('a subject is text, never markup', () => {
  const r = rig();
  assert.strictEqual(r.row('e4f5a6b').querySelector('.gg-msg').textContent, '<b>x</b>');
  assert.strictEqual(r.row('e4f5a6b').querySelectorAll('b').length, 0);
});

test('a remote ref is marked as one', () => {
  const r = rig({ graph: graphOf(c('a1b2c3d', [], { refs: [ref('develop'), ref('origin/develop', true)] })) });
  const chips = r.graphEl.querySelectorAll('.gg-ref');
  assert.deepStrictEqual(chips.map(x => x.classList.contains('remote')), [false, true]);
});

test('a failed or missing answer says so and draws nothing; an empty repo says there are no commits', () => {
  const r = rig({ graph: { ok: false, error: 'not a git repository' } });
  assert.strictEqual(r.status.textContent, "Can't read this repo's commits: not a git repository");
  assert.strictEqual(r.rows().length, 0);
  r.redraw(null);
  assert.match(r.status.textContent, /no answer/);
  r.redraw(graphOf());
  assert.strictEqual(r.status.textContent, '');
  assert.strictEqual(r.graphEl.querySelector('.gg-empty').textContent, 'No commits yet.');
  assert.strictEqual(r.graphEl.querySelectorAll('.gg-empty').length, 1);
});

test('an identical answer redraws nothing; a changed one does', () => {
  const r = rig();
  const before = r.graphEl.ggState.renders;
  r.redraw();
  assert.strictEqual(r.graphEl.ggState.renders, before);
  r.redraw(graphOf(c('ffffff0')));
  assert.strictEqual(r.graphEl.ggState.renders, before + 1);
  assert.strictEqual(r.rows().length, 1);
  r.redraw(graphOf(c('ffffff0')), { ...TREE, repoUrl: null });
  assert.strictEqual(r.graphEl.ggState.renders, before + 2, 'the tree\'s address is part of what the strip says');
});

test('listeners are added once, however often it is redrawn', () => {
  const r = rig();
  r.redraw(graphOf(c('1111111')));
  r.redraw(graphOf(c('2222222')));
  assert.strictEqual(r.graphEl.ggState.wired, 1);
  assert.strictEqual(r.graphEl.listeners.get('click').length, 1);
});

test('clicking a commit opens its detail strip; clicking it again, or Escape, closes it', () => {
  const r = rig();
  r.row('a1b2c3d').dispatch('click');
  assert.strictEqual(r.detail().hidden, false);
  assert.strictEqual(r.detail().querySelector('.gg-detail-title').textContent, 'msg a1b2c3d');
  assert.ok(r.row('a1b2c3d').classList.contains('sel'));
  r.row('e4f5a6b').dispatch('click');
  assert.ok(!r.row('a1b2c3d').classList.contains('sel'));
  assert.strictEqual(r.detail().querySelector('.gg-detail-title').textContent, '<b>x</b>');
  r.row('e4f5a6b').dispatch('click');
  assert.strictEqual(r.detail().hidden, true);
  r.row('a1b2c3d').dispatch('click');
  const e = r.row('a1b2c3d').dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(r.detail().hidden, true);
  assert.strictEqual(r.doc.activeElement, r.row('a1b2c3d'));
});

test('Enter and Space open a commit from the keyboard; the arrows walk the rows', () => {
  const r = rig();
  const k = r.row('a1b2c3d').dispatch('keydown', { key: 'Enter' });
  assert.strictEqual(k.defaultPrevented, true);
  assert.strictEqual(r.detail().hidden, false);
  r.row('a1b2c3d').dispatch('keydown', { key: 'ArrowDown' });
  assert.strictEqual(r.doc.activeElement, r.row('e4f5a6b'));
  r.row('e4f5a6b').dispatch('keydown', { key: 'ArrowDown' });
  assert.strictEqual(r.doc.activeElement, r.row('e4f5a6b'), 'no row past the last');
  r.row('e4f5a6b').dispatch('keydown', { key: 'ArrowUp' });
  assert.strictEqual(r.doc.activeElement, r.row('a1b2c3d'));
  r.row('a1b2c3d').dispatch('keydown', { key: 'ArrowUp' });
  assert.strictEqual(r.doc.activeElement, r.row('a1b2c3d'));
  r.row('e4f5a6b').dispatch('keydown', { key: ' ' });
  assert.strictEqual(r.detail().querySelector('.gg-detail-title').textContent, '<b>x</b>');
  const other = r.row('e4f5a6b').dispatch('keydown', { key: 'a' });
  assert.strictEqual(other.defaultPrevented, false);
});

test('the open strip survives a redraw, and goes if its commit does', () => {
  const r = rig();
  r.row('a1b2c3d').dispatch('click');
  r.redraw(graphOf(c('a1b2c3d', ['e4f5a6b']), c('e4f5a6b'), c('99999990')));
  assert.strictEqual(r.detail().hidden, false);
  assert.ok(r.row('a1b2c3d').classList.contains('sel'));
  r.redraw(graphOf(c('99999990')));
  assert.strictEqual(r.detail().hidden, true);
  assert.strictEqual(r.graphEl.ggState.selected, null);
});

test('the focused row is put back after a redraw', () => {
  const r = rig();
  r.row('e4f5a6b').focus();
  r.redraw(graphOf(c('a1b2c3d', ['e4f5a6b']), c('e4f5a6b'), c('99999990')));
  assert.strictEqual(r.doc.activeElement.getAttribute('data-hash'), 'e4f5a6b');
});

test('Copy hash copies the full hash and says so under the strip', async () => {
  const r = rig();
  r.row('a1b2c3d').dispatch('click');
  r.button('copy').dispatch('click');
  await flush();
  assert.deepStrictEqual(r.calls.copy, ['a1b2c3d']);
  assert.strictEqual(r.said(), 'Copied a1b2c3d.');
  r.row('e4f5a6b').dispatch('click');
  assert.strictEqual(r.said(), '', 'an answer belongs to the commit it was for');
});

test('Open commit sends the commit page to the browser gate and reports the outcome', async () => {
  const r = rig();
  r.row('a1b2c3d').dispatch('click');
  r.button('open-commit').dispatch('click');
  await flush();
  assert.deepStrictEqual(r.calls.open, ['https://github.com/o/r/commit/a1b2c3d']);
  assert.strictEqual(r.said(), 'Opened a1b2c3d in your browser.');
  const refused = rig({ handlers: { onOpenUrl: async () => false } });
  refused.row('a1b2c3d').dispatch('click');
  refused.button('open-commit').dispatch('click');
  await flush();
  assert.strictEqual(refused.said(), "Couldn't open the browser.");
});

test('a disabled action does nothing, and its reason is on screen beside it', async () => {
  const r = rig({ tree: { ...TREE, repoUrl: null } });
  r.row('a1b2c3d').dispatch('click');
  r.button('open-commit').dispatch('click');
  await flush();
  assert.deepStrictEqual(r.calls.open, []);
  assert.strictEqual(r.button('open-commit').getAttribute('aria-disabled'), 'true');
  const why = r.graphEl.querySelector('#gg-act-why-open-commit');
  assert.strictEqual(why.textContent, 'no GitHub remote ("origin") to open it on');
  assert.strictEqual(r.button('open-commit').getAttribute('aria-describedby'), 'gg-act-why-open-commit');
  assert.strictEqual(r.button('copy').getAttribute('aria-disabled'), 'false');
});

test('Jump selects the worktree tab of the branch the commit is the tip of', async () => {
  const graph = graphOf(c('a1b2c3d', [], { refs: [ref('feat/a')] }));
  const r = rig({ graph });
  r.row('a1b2c3d').dispatch('click');
  r.button('jump').dispatch('click');
  await flush();
  assert.deepStrictEqual(r.calls.jump, ['C:/p/feat-a']);
  const explain = rig({ graph, handlers: { onJump: async () => ({ kind: 'explain', text: 'No tab for it.' }) } });
  explain.row('a1b2c3d').dispatch('click');
  explain.button('jump').dispatch('click');
  await flush();
  assert.strictEqual(explain.said(), 'No tab for it.');
});

test('a tab the shell says is closed turns Jump off', () => {
  const graph = graphOf(c('a1b2c3d', [], { refs: [ref('feat/a')] }));
  const r = rig({ graph, tabs: [{ folder: 'C:/p/feat-a', open: false }] });
  r.row('a1b2c3d').dispatch('click');
  assert.strictEqual(r.button('jump').getAttribute('aria-disabled'), 'true');
});

test('a handler that throws is reported, not swallowed; a second press while one is running does nothing', async () => {
  const bad = rig({ handlers: { onCopy: async () => { throw new Error('clipboard refused'); } } });
  bad.row('a1b2c3d').dispatch('click');
  bad.button('copy').dispatch('click');
  await flush();
  assert.strictEqual(bad.said(), "Couldn't do that: clipboard refused");
  let n = 0;
  let release;
  const gate = new Promise(res => { release = res; });
  const slow = rig({ handlers: { onCopy: async () => { n++; await gate; } } });
  slow.row('a1b2c3d').dispatch('click');
  slow.button('copy').dispatch('click');
  slow.button('copy').dispatch('click');
  release();
  await flush();
  assert.strictEqual(n, 1);
});

test('without handlers the actions say so instead of failing silently', async () => {
  const r = rig();
  r.graphEl.ggState.onOpenUrl = null;
  r.row('a1b2c3d').dispatch('click');
  display.render(r.rootEl, r.graphEl.ggState.graph, { tree: TREE, tabs: [{ folder: 'x', open: true }] });
  r.button('copy').dispatch('click');
  await flush();
  assert.strictEqual(r.said(), "Can't copy from here.");
  r.button('open-commit').dispatch('click');
  await flush();
  assert.strictEqual(r.said(), "Can't open a browser from here.");
});

test('when the project becomes known: a view chosen meanwhile wins and is saved; otherwise the saved one applies', () => {
  assert.deepStrictEqual(display.adoptView({ chosen: false, current: 'rings', saved: 'graph' }), { view: 'graph', persist: false });
  assert.deepStrictEqual(display.adoptView({ chosen: false, current: 'rings', saved: 'rings' }), { view: 'rings', persist: false });
  assert.deepStrictEqual(display.adoptView({ chosen: true, current: 'graph', saved: 'rings' }), { view: 'graph', persist: true });
  assert.deepStrictEqual(display.adoptView({ chosen: true, current: 'rings', saved: 'graph' }), { view: 'rings', persist: true });
  assert.deepStrictEqual(display.adoptView({ chosen: false, current: 'rings', saved: 'junk' }), { view: 'rings', persist: false });
  assert.deepStrictEqual(display.adoptView({ chosen: true, current: 'junk', saved: 'graph' }), { view: 'rings', persist: true });
});

// ---------- the ask: nothing is sent to a host that doesn't list `git-graph` (it would TYPE the frame into the session) ----------

test('the ask goes only to a host whose hello lists git-graph; an older one gets nothing and the panel says why', () => {
  const sent = [];
  const asker = display.createAsker(frame => { sent.push(frame); return true; });
  assert.deepStrictEqual(asker.ask(), { sent: false, note: null }, 'before the hello it is not known: nothing sent, nothing said');
  asker.setControls(['git-tree', 'repo']);
  assert.deepStrictEqual(asker.ask(), { sent: false, note: display.NEEDS_NEWER });
  assert.match(display.NEEDS_NEWER, /newer session/);
  asker.setControls(undefined);
  assert.strictEqual(asker.ask().sent, false);
  asker.setControls('git-graph');
  assert.strictEqual(asker.ask().sent, false, 'a string is not a list');
  assert.deepStrictEqual(sent, []);
  asker.setControls(['git-tree', 'git-graph']);
  assert.deepStrictEqual(asker.ask(), { sent: true, note: null });
  assert.deepStrictEqual(sent, ['{"type":"git-graph"}']);
});

test('a socket that cannot send is "not sent", with no note', () => {
  const asker = display.createAsker(() => false);
  asker.setControls(['git-graph']);
  assert.deepStrictEqual(asker.ask(), { sent: false, note: null });
});

// ---------- review fixes (PR #157) ----------

test('what the host sends is what the page draws: a commit with chips, pushed and lane geometry', () => {
  const g = display.geometry(graphOf(c('a1', ['b1'], { refs: [ref('develop'), ref('origin/develop', true)], pushed: true }), c('b1', [], { pushed: null })));
  assert.strictEqual(g.nodes.length, 2);
  assert.strictEqual(g.edges.length, 1);
});

test('Open commit is off for a commit no remote reaches; on when it is, or when that is unknown', () => {
  const act = commit => display.commitModel(commit, { tree: TREE }).actions.find(a => a.id === 'open-commit');
  const no = act(c('abcdef0', [], { pushed: false }));
  assert.strictEqual(no.enabled, false);
  assert.strictEqual(no.why, 'not pushed to GitHub yet');
  assert.strictEqual(act(c('abcdef0', [], { pushed: true })).enabled, true);
  assert.strictEqual(act(c('abcdef0', [], { pushed: null })).enabled, true);
  assert.strictEqual(act(c('abcdef0')).enabled, true, 'no pushed field: unknown');
  // no GitHub address wins as the reason: it is the more basic one
  assert.match(display.commitModel(c('abcdef0', [], { pushed: false }), { tree: { ...TREE, repoUrl: null } }).actions[0].why, /no GitHub remote/);
});

const TIP = c('a1b2c3d', [], { refs: [ref('feat/a')] });
const TAB_A = { folder: 'C:/p/feat-a', open: true, working: true, needsInput: false, turn: 'turn', lock: 'held' };

test('a tab that only changes what it is doing redraws nothing; one that opens or closes does, and the focus comes back to the same button', () => {
  const r = rig({ graph: graphOf(TIP), tabs: [TAB_A] });
  r.row('a1b2c3d').dispatch('click');
  r.button('copy').focus();
  const before = r.graphEl.ggState.renders;
  r.redraw(graphOf(TIP), TREE, [{ ...TAB_A, working: false, turn: 'idle' }]);
  assert.strictEqual(r.graphEl.ggState.renders, before, 'working / turn are not what the strip shows');
  assert.strictEqual(r.doc.activeElement, r.button('copy'));
  r.redraw(graphOf(TIP), { ...TREE, branches: TREE.branches.map(b => ({ ...b, state: 'merged', pr: 9 })) }, [TAB_A]);
  assert.strictEqual(r.graphEl.ggState.renders, before, 'a branch\'s state or PR is not what the strip shows');
  r.redraw(graphOf(TIP), TREE, [{ ...TAB_A, open: false }]);
  assert.strictEqual(r.graphEl.ggState.renders, before + 1);
  assert.strictEqual(r.button('jump').getAttribute('aria-disabled'), 'true');
  assert.ok(r.doc.activeElement && r.doc.activeElement.isConnected, 'the focus is on something still on the page');
  assert.strictEqual(r.doc.activeElement.getAttribute('data-act'), 'copy');
});

test('a tab for a folder the tree has no branch for does not redraw the graph', () => {
  const r = rig({ graph: graphOf(TIP), tabs: [] });
  const before = r.graphEl.ggState.renders;
  r.redraw(graphOf(TIP), TREE, [{ folder: 'C:/elsewhere', open: true, working: true }]);
  assert.strictEqual(r.graphEl.ggState.renders, before);
});

test('Enter and Space toggle a commit, as a click does', () => {
  const r = rig();
  r.row('a1b2c3d').dispatch('keydown', { key: 'Enter' });
  assert.strictEqual(r.detail().hidden, false);
  r.row('a1b2c3d').dispatch('keydown', { key: 'Enter' });
  assert.strictEqual(r.detail().hidden, true);
  r.row('a1b2c3d').dispatch('keydown', { key: ' ' });
  assert.strictEqual(r.detail().hidden, false);
  r.row('a1b2c3d').dispatch('keydown', { key: ' ' });
  assert.strictEqual(r.detail().hidden, true);
});

test('an ok answer with no commit list is said, not thrown', () => {
  const r = rig();
  assert.doesNotThrow(() => r.redraw({ ok: true }));
  assert.match(r.status.textContent, /no commit list/);
  assert.strictEqual(r.rows().length, 0);
});
