'use strict';
/**
 * The DOM half of app/git-rings-display.js, driven through a fake document (test/fake-dom.js). Mortimer's gate on release
 * PR #109 (survivor 1) found that half had 6 kills out of 1,243 mutants: it was exercised only by the real-window probe
 * verify/probe-git-tree.js, which Stryker never runs, and the one edit that landed there (the /merged reply wired through
 * actionsLib.mergedSaid) was untested.
 *
 * What is pinned here is what a person sees and what the handlers are given: the answer under the drawer for each action
 * (and for a failure), the drawer's text and accessibility, who may be pressed twice, what a bad answer says, and that an
 * identical answer redraws nothing. The look (the swing, the sparks, the geometry) stays the probe's.
 */
const test = require('node:test');
const assert = require('node:assert');

const { makePanel } = require('./fake-dom');
const display = require('../app/git-rings-display');
const actionsLib = require('../app/git-actions');

// The module schedules its motion with requestAnimationFrame when there is one; hold the callbacks so no timer survives.
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
test.after(() => { delete globalThis.requestAnimationFrame; });

const TAB = { folder: 'C:/p/feat-a', open: true, started: true, known: true, working: false, needsInput: false, turn: 'idle', lock: 'held' };
const branch = (extra) => ({ name: 'feat/a', state: 'open', place: 'worktree', folder: 'C:/p/feat-a', pr: 91, prUrl: 'https://github.com/o/r/pull/91',
  why: 'Dock zones', when: '2026-10-01', first: '2026-09-28', last: '2026-10-01', commits: 12, spend: 1234567, runs: 3, people: [], reviews: [], ...extra });
const treeOf = (branches, extra) => ({ ok: true, integration: 'develop', current: 'develop', prsKnown: true, repoUrl: 'https://github.com/o/r',
  ledgerOk: true, totalSpend: 5000, mainMerges: 3, hub: { spend: 1000, people: [] }, branches, ...extra });
const flush = () => new Promise(res => setImmediate(res));

function rig({ tree = treeOf([branch(), branch({ name: 'fix/b', pr: null, prUrl: null, state: 'unmerged', place: 'dev', folder: null })]), tabs = [TAB], handlers = {} } = {}) {
  const p = makePanel();
  p.dial.clientWidth = 800;
  const h = { calls: { typeMerged: [], openPr: [], copy: [], jump: [] }, ...handlers };
  const deps = {
    onTypeMerged: handlers.onTypeMerged || (async (folder, name) => { h.calls.typeMerged.push([folder, name]); return { kind: 'typed', submitted: true }; }),
    onOpenPr: handlers.onOpenPr || (async (url) => { h.calls.openPr.push(url); return true; }),
    onCopy: handlers.onCopy || (async (name) => { h.calls.copy.push(name); }),
    onJump: handlers.onJump || (async (folder) => { h.calls.jump.push(folder); return null; }),
    tabs,
  };
  for (const k of ['onTypeMerged', 'onOpenPr', 'onCopy', 'onJump']) if (handlers[k] === null) delete deps[k];
  const redraw = (t = tree, tb = tabs) => display.render(p.rootEl, t, { ...deps, tabs: tb, now: 1_000_000 });
  redraw();
  const said = () => p.rootEl.querySelector('.git-said').textContent;
  const spoke = (name) => p.dial.querySelectorAll('.git-spoke').find(g => g.getAttribute('data-name') === name);
  const open = (name) => { spoke(name).dispatch('click'); };
  const button = (id) => p.dial.querySelector(`.git-act[data-act="${id}"]`);
  const press = async (id) => { button(id).dispatch('click'); await flush(); };
  return { ...p, h, deps, redraw, said, spoke, open, button, press };
}

test('the /merged answer is what actionsLib.mergedSaid says: sent, typed, the shell\'s own words, or a plain failure', async () => {
  const replies = [
    { kind: 'typed', submitted: true },
    { kind: 'typed', submitted: false },
    { kind: 'typed', submitted: true, branch: 'feat/other' },
    { kind: 'explain', text: 'That tab is busy.' },
    undefined,
  ];
  for (const reply of replies) {
    const r = rig({ handlers: { onTypeMerged: async () => reply } });
    r.open('feat/a');
    await r.press('type-merged');
    assert.strictEqual(r.said(), actionsLib.mergedSaid(reply, 'feat/a'), JSON.stringify(reply));
    assert.notStrictEqual(r.said(), '');
  }
  // literals, so the oracle above is not the only witness
  const literal = async (reply) => {
    const r = rig({ handlers: { onTypeMerged: async () => reply } });
    r.open('feat/a');
    await r.press('type-merged');
    return r.said();
  };
  assert.strictEqual(await literal({ kind: 'explain', text: 'That tab is busy.' }), 'That tab is busy.');
  assert.strictEqual(await literal(undefined), "Couldn't run /merged.");
  assert.strictEqual(await literal({ kind: 'typed', submitted: false }), "Typed /merged in feat/a's tab: press Enter there to run it.");
  const sent = rig();
  sent.open('feat/a');
  await sent.press('type-merged');
  assert.strictEqual(sent.said(), "Sent /merged to feat/a's session.");
  assert.deepStrictEqual(sent.h.calls.typeMerged, [['C:/p/feat-a', 'feat/a']]);
});

test('Run /merged with no handler, or on a branch with no folder, does nothing and says nothing', async () => {
  const none = rig({ handlers: { onTypeMerged: null } });
  none.open('feat/a');
  await none.press('type-merged');
  assert.strictEqual(none.said(), '');

  // a branch with no folder: the action is off with its reason, and pressing it asks nothing of the handler
  const folderless = rig({ tree: treeOf([branch({ folder: null })]) });
  folderless.open('feat/a');
  assert.strictEqual(folderless.button('type-merged').getAttribute('aria-disabled'), 'true');
  await folderless.press('type-merged');
  assert.deepStrictEqual(folderless.h.calls.typeMerged, []);
  assert.strictEqual(folderless.said(), '');
});

test('open PR: the handler gets the PR\'s URL and the answer says opened, or could not; no handler says so', async () => {
  const ok = rig();
  ok.open('feat/a');
  await ok.press('open-pr');
  assert.deepStrictEqual(ok.h.calls.openPr, ['https://github.com/o/r/pull/91']);
  assert.strictEqual(ok.said(), 'Opened PR #91 in your browser.');

  const refused = rig({ handlers: { onOpenPr: async () => false } });
  refused.open('feat/a');
  await refused.press('open-pr');
  assert.strictEqual(refused.said(), "Couldn't open the browser.");

  const none = rig({ handlers: { onOpenPr: null } });
  none.open('feat/a');
  await none.press('open-pr');
  assert.strictEqual(none.said(), "Can't open a browser from here.");
});

test('copy: a branch copies its own name, the hub copies the integration branch; no handler says it can\'t', async () => {
  const r = rig();
  r.open('feat/a');
  await r.press('copy');
  assert.deepStrictEqual(r.h.calls.copy, ['feat/a']);
  assert.strictEqual(r.said(), 'Copied feat/a.');

  const hub = rig();
  hub.dial.querySelector('.git-hub').dispatch('click');
  await hub.press('copy');
  assert.deepStrictEqual(hub.h.calls.copy, ['develop']);
  assert.strictEqual(hub.said(), 'Copied develop.');

  const none = rig({ handlers: { onCopy: null } });
  none.open('feat/a');
  await none.press('copy');
  assert.strictEqual(none.said(), "Can't copy from here.");
});

test('jump: the handler gets the worktree folder; an explanation from the shell is shown, a plain success says nothing', async () => {
  const r = rig({ handlers: { onJump: async () => ({ kind: 'explain', text: 'No such tab.' }) } });
  r.open('feat/a');
  await r.press('jump');
  assert.strictEqual(r.said(), 'No such tab.');
  const plain = rig();
  plain.open('feat/a');
  await plain.press('jump');
  assert.deepStrictEqual(plain.h.calls.jump, ['C:/p/feat-a']);
  assert.strictEqual(plain.said(), '');
});

test('a handler that throws is said, not lost: "Couldn\'t do that: <why>"', async () => {
  const r = rig({ handlers: { onCopy: async () => { throw new Error('clipboard locked'); } } });
  r.open('feat/a');
  await r.press('copy');
  assert.strictEqual(r.said(), "Couldn't do that: clipboard locked");
  const bare = rig({ handlers: { onCopy: async () => { throw 'plain string'; } } });   // eslint-disable-line no-throw-literal
  bare.open('feat/a');
  await bare.press('copy');
  assert.strictEqual(bare.said(), "Couldn't do that: plain string");
});

test('a second press while the first is waiting does nothing; the button is marked busy meanwhile and freed after', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  let calls = 0;
  const r = rig({ handlers: { onCopy: async () => { calls += 1; await gate; } } });
  r.open('feat/a');
  r.button('copy').dispatch('click');
  r.button('copy').dispatch('click');
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.button('copy').getAttribute('aria-busy'), 'true');
  release();
  await flush();
  assert.strictEqual(r.button('copy').getAttribute('aria-busy'), null);
  r.button('copy').dispatch('click');
  await flush();
  assert.strictEqual(calls, 2, 'and it can be pressed again once answered');
});

test('a disabled action does nothing when pressed: its reason is already on screen', async () => {
  const r = rig();
  r.open('feat/a');
  assert.strictEqual(r.button('open-worktree').getAttribute('aria-disabled'), 'true');
  await r.press('open-worktree');
  assert.strictEqual(r.said(), '');
  const idle = rig({ tabs: [{ ...TAB, working: true }] });
  idle.open('feat/a');
  await idle.press('type-merged');
  assert.strictEqual(idle.h.calls.typeMerged.length, 0);
});

test('the drawer: opened by a click on the spoke, titled for the branch, closed by a second click, Escape or a click elsewhere', () => {
  const r = rig();
  const drawer = () => r.dial.querySelector('.git-drawer');
  assert.strictEqual(drawer().hidden, true, 'closed until asked');
  r.open('feat/a');
  assert.strictEqual(drawer().hidden, false);
  assert.strictEqual(drawer().getAttribute('aria-label'), 'feat/a: details and actions');
  assert.match(drawer().textContent, /feat\/a/);
  assert.match(drawer().textContent, /#91 · PR open/);
  r.spoke('feat/a').dispatch('click');
  assert.strictEqual(drawer().hidden, true);
  assert.strictEqual(drawer().textContent, '', 'a closed drawer holds nothing');

  r.open('feat/a');
  r.dial.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(drawer().hidden, true);

  r.open('feat/a');
  r.dial.dispatch('click');                                  // empty space in the panel
  assert.strictEqual(drawer().hidden, true);

  r.open('feat/a');
  drawer().dispatch('click');                                // inside the drawer: stays
  assert.strictEqual(drawer().hidden, false);
});

test('opening another branch\'s drawer drops the previous answer; a click on the same spoke twice closes and forgets it', async () => {
  const r = rig();
  r.open('feat/a');
  await r.press('copy');
  assert.strictEqual(r.said(), 'Copied feat/a.');
  r.open('fix/b');
  assert.strictEqual(r.said(), '', 'it is feat/a\'s answer, not fix/b\'s');
  r.open('feat/a');
  assert.strictEqual(r.said(), '');
});

test('every disabled action says why beside it, and is described by that, never also by a title', () => {
  const r = rig();
  r.open('feat/a');
  const off = r.button('open-worktree');
  const why = r.dial.querySelector('.git-act-why');
  assert.ok(why, 'a reason is drawn');
  assert.strictEqual(off.getAttribute('aria-describedby'), why.getAttribute('id'));
  assert.strictEqual(why.textContent, 'its worktree is already open: use Jump to its tab');
  assert.strictEqual(off.title, undefined);
  const on = r.button('copy');
  assert.strictEqual(on.getAttribute('aria-disabled'), 'false');
  assert.strictEqual(on.getAttribute('aria-describedby'), null);
  assert.strictEqual(on.textContent, 'Copy name');
});

test('the drawer lists who worked on it with bars by tokens, the reviews with verdicts, and says when there are none', () => {
  const people = [{ name: 'Dexter', runs: 2, spend: 1000 }, { name: 'Miguel', runs: 1, spend: 500 }, { name: 'Z', runs: 1, spend: null }];
  const reviews = [{ reviewer: 'Dexter', round: 2, date: '2026-10-02', verdict: 'CLEAN' }, { reviewer: 'Miguel', round: 1, date: '2026-10-02', verdict: null }];
  const r = rig({ tree: treeOf([branch({ people, reviews }), branch({ name: 'fix/b', state: 'unmerged', place: 'dev', folder: null, pr: null, prUrl: null })]) });
  r.open('feat/a');
  const who = r.dial.querySelector('.git-drawer-who');
  assert.match(who.textContent, /Dexter ×2/);
  const bars = who.querySelectorAll('.bar');
  assert.deepStrictEqual(bars.map(b => b.classList.contains('none')), [false, false, true]);
  assert.strictEqual(bars[0].children[0].style.width, '100%');
  assert.strictEqual(bars[1].children[0].style.width, '50%');
  const rv = r.dial.querySelector('.git-drawer-reviews');
  assert.match(rv.textContent, /Dexter r2CLEAN/);
  assert.strictEqual(rv.querySelectorAll('.v.none').length, 1, 'a report with no verdict line is dimmed');

  r.open('fix/b');
  assert.strictEqual(r.dial.querySelector('.git-drawer-reviews').textContent, 'no review reports yet');
});

test('a branch with many people shows four and "+N more"', () => {
  const people = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, runs: 1, spend: 100 - i }));
  const r = rig({ tree: treeOf([branch({ people })]) });
  r.open('feat/a');
  assert.match(r.dial.querySelector('.git-drawer-who').textContent, /\+2 more$/);
});

test('the hub\'s drawer has only Copy name and no review block', () => {
  const r = rig();
  r.dial.querySelector('.git-hub').dispatch('click');
  assert.deepStrictEqual(r.dial.querySelectorAll('.git-act').map(b => b.getAttribute('data-act')), ['copy']);
  assert.strictEqual(r.dial.querySelector('.git-drawer-reviews'), null);
  assert.strictEqual(r.dial.querySelector('.git-drawer').getAttribute('aria-label'), '▶ develop: details and actions');
});

test('the panel has ONE status node, made once and kept across redraws', () => {
  const r = rig();
  const node = r.rootEl.querySelector('.git-said');
  assert.strictEqual(node.getAttribute('role'), 'status');
  assert.strictEqual(node.getAttribute('aria-live'), 'polite');
  r.redraw(treeOf([branch(), branch({ name: 'x/c', state: 'unmerged', place: 'dev', folder: null, pr: null, prUrl: null })]));
  assert.strictEqual(r.rootEl.querySelectorAll('.git-said').length, 1);
  assert.strictEqual(r.rootEl.querySelector('.git-said'), node);
});

test('an answer identical to the last draws nothing; a changed one redraws and keeps the open drawer and its answer', async () => {
  const r = rig();
  const stage = r.dial.querySelector('.git-stage');
  r.redraw();
  assert.strictEqual(r.dial.querySelector('.git-stage'), stage, 'nothing was drawn');

  r.open('feat/a');
  await r.press('copy');
  r.redraw(treeOf([branch({ commits: 13 }), branch({ name: 'fix/b', state: 'unmerged', place: 'dev', folder: null, pr: null, prUrl: null })]));
  assert.notStrictEqual(r.dial.querySelector('.git-stage'), stage);
  assert.strictEqual(r.dial.querySelector('.git-drawer').hidden, false, 'the drawer the person had open is put back');
  assert.match(r.dial.querySelector('.git-drawer').textContent, /13 commits/);
  assert.strictEqual(r.said(), 'Copied feat/a.', 'and its answer');

  r.redraw(treeOf([branch({ name: 'fix/b', state: 'unmerged', place: 'dev', folder: null, pr: null, prUrl: null })]));
  assert.strictEqual(r.dial.querySelector('.git-drawer').hidden, true, 'its branch is gone: the drawer closes');
});

test('the drawing: one spoke per branch named and labelled, the hub named, the dial described', () => {
  const r = rig({ tree: treeOf([branch({ why: 'Dock zones' }), branch({ name: 'fix/b', state: 'merged', place: 'dev', folder: null, pr: 7, prUrl: null, why: '' })], { current: 'fix/b' }) });
  const spokes = r.dial.querySelectorAll('.git-spoke');
  assert.deepStrictEqual(spokes.map(g => g.getAttribute('data-name')), ['feat/a', 'fix/b']);
  assert.strictEqual(spokes[0].getAttribute('aria-label'), 'feat/a: Dock zones');
  assert.strictEqual(spokes[1].getAttribute('aria-label'), 'fix/b');
  assert.ok(spokes[1].classList.contains('current') && !spokes[0].classList.contains('current'));
  assert.ok(spokes[0].classList.contains('open') && spokes[0].classList.contains('worktree'));
  assert.strictEqual(r.dial.querySelector('.git-svg').getAttribute('aria-label'), '2 branches of this project');
  assert.strictEqual(r.dial.querySelector('.git-hub-name').textContent, 'develop');
  assert.strictEqual(r.dial.querySelector('.git-hub-sum').textContent, '5k');
  assert.strictEqual(r.dial.querySelector('.git-hub').getAttribute('aria-label'), 'develop');
  assert.ok(spokes.every(g => g.getAttribute('tabindex') === '0'), 'each spoke is reachable by keyboard');
  const labels = r.dial.querySelectorAll('.git-label').map(l => l.textContent);
  assert.deepStrictEqual(labels, ['a #91', '▶ b']);
  assert.strictEqual(r.dial.querySelector('.git-foot').textContent,
    '2 branches · 5k tokensmain · 3 merges1 merged · 1 open · 0 unmerged · 0 deleted');
});

test('a hub with no total spend says "?", never 0', () => {
  const r = rig({ tree: treeOf([branch()], { totalSpend: null }) });
  assert.strictEqual(r.dial.querySelector('.git-hub-sum').textContent, '?');
});

test('a tree that could not be read says so, with the reason, and draws no dial; a good one after it comes back', () => {
  const r = rig();
  r.redraw({ ok: false, error: 'not a git repository' });
  assert.strictEqual(r.status.textContent, "Can't read this repo's history: not a git repository");
  assert.strictEqual(r.dial.querySelector('.git-svg'), null);
  r.redraw(null);
  assert.strictEqual(r.status.textContent, "Can't read this repo's history: no answer");
  r.redraw(treeOf([branch()]));
  assert.strictEqual(r.status.textContent, '');
  assert.ok(r.dial.querySelector('.git-svg'));
});

test('a ledger that could not be fully read is said above the dial', () => {
  const r = rig({ tree: treeOf([branch()], { ledgerOk: false }) });
  assert.strictEqual(r.status.textContent, 'Some transcripts could not be read, so some spend may be missing.');
});

test('hovering a spoke shows its card with the facts and moves it with the pointer; leaving hides it; a pinned drawer suppresses it', () => {
  const r = rig();
  r.dial.layout = { width: 800, height: 600 };
  const card = r.dial.querySelector('.git-card');
  assert.strictEqual(card.hidden, true);
  r.spoke('feat/a').dispatch('mouseover', { clientX: 30, clientY: 40 });
  assert.strictEqual(card.hidden, false);
  assert.strictEqual(card.dataset.key, 'feat/a');
  assert.match(card.textContent, /feat\/a/);
  assert.match(card.textContent, /1\.2M tokens · 12 commits/);
  assert.deepStrictEqual([card.style.left, card.style.top], ['42px', '52px'], 'beside the pointer (+12)');
  r.dial.dispatch('mousemove', { clientX: 100, clientY: 200 });
  assert.deepStrictEqual([card.style.left, card.style.top], ['112px', '212px'], 'and it follows the pointer');
  r.spoke('feat/a').dispatch('mouseout', { relatedTarget: r.dial });
  assert.strictEqual(card.hidden, true);

  r.open('feat/a');
  r.spoke('fix/b').dispatch('mouseover', { clientX: 1, clientY: 1 });
  assert.strictEqual(card.hidden, true, 'a pinned drawer keeps the hover card away');
});

test('the keyboard: Enter opens the drawer and focuses the first action that works; the arrows walk the spokes', () => {
  const r = rig();
  const enter = r.spoke('feat/a').dispatch('keydown', { key: 'Enter' });
  assert.strictEqual(enter.defaultPrevented, true);
  assert.strictEqual(r.dial.querySelector('.git-drawer').hidden, false);
  assert.strictEqual(r.doc.activeElement.getAttribute('data-act'), 'jump', 'Jump if it works');

  const title = () => r.dial.querySelector('.git-drawer').getAttribute('aria-label');
  const right = r.spoke('feat/a').dispatch('keydown', { key: 'ArrowRight' });
  assert.strictEqual(right.defaultPrevented, true);
  assert.strictEqual(r.doc.activeElement, r.spoke('fix/b'), 'the next spoke takes the focus');
  assert.strictEqual(title(), 'fix/b: details and actions', 'and the drawer follows');
  r.spoke('fix/b').dispatch('keydown', { key: 'ArrowDown' });
  assert.strictEqual(r.doc.activeElement, r.spoke('feat/a'), 'past the last spoke it wraps to the first');
  r.spoke('feat/a').dispatch('keydown', { key: 'ArrowLeft' });
  assert.strictEqual(r.doc.activeElement, r.spoke('fix/b'), 'and back before the first it wraps to the last');
  assert.strictEqual(title(), 'fix/b: details and actions');
  r.spoke('fix/b').dispatch('keydown', { key: 'ArrowUp' });
  assert.strictEqual(r.doc.activeElement, r.spoke('feat/a'));
});

test('an answer that arrives after the person opened another branch\'s drawer is not shown there', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const r = rig({ handlers: { onCopy: async () => { await gate; } } });
  r.open('feat/a');
  r.button('copy').dispatch('click');
  r.open('fix/b');                                           // moves on while feat/a's copy is still pending
  release();
  await flush();
  assert.strictEqual(r.said(), '', 'it was feat/a\'s answer');
});

test('a branch whose worktree tab is working is drawn live, and labelled; an idle one is not', () => {
  const busy = rig({ tabs: [{ ...TAB, working: true }] });
  const g = busy.spoke('feat/a');
  assert.ok(g.classList.contains('live'));
  assert.match(g.getAttribute('aria-label'), /\(live\)$/);
  assert.ok(busy.dial.querySelectorAll('.git-label').some(l => l.classList.contains('live')));
  const idle = rig();
  assert.ok(!idle.spoke('feat/a').classList.contains('live'));
  assert.doesNotMatch(idle.spoke('feat/a').getAttribute('aria-label'), /live/);
  assert.strictEqual(display.motionState(idle.dial).live.length, 0);
  assert.deepStrictEqual(display.motionState(busy.dial).live, ['feat/a']);
});
