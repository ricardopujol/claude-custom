'use strict';
/**
 * The Git panel (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md Task 10; "Enhancement #46"): the Rings
 * dial from app/git-rings.js, its hover card, and the drawer a click (or an arrow key) opens.
 *
 *   render(root, tree, { onJump, onOpenPr, onCopy, onRunMerged, tabs, now })
 *                                     draws `tree` (the host's `git-tree` answer) into the panel
 *   cardModel(branch, { current, prsKnown })   what a spoke's hover card says
 *   drawerModel(branch, { tree, tab, hub })    what the drawer says: the card, who worked on it with bars,
 *                                              review verdicts, and five actions (app/git-actions.js)
 *   hubCard(tree) / footer(tree) / fmtTokens(n) / labelAt(...)
 *   motionState(dial)                 the swing's state, for the window probe
 *
 * The hover card is SMALL on purpose (Ricardo, 2026-10-01): the name with its PR and state, what it was
 * for (15 words at most, from the host), one summary line, and who worked on it. The DRAWER (#46) is the
 * drill-down: beside the dial in a wide zone, under it in a narrow one, reachable by keyboard. Colors
 * come from the theme through CSS classes (renderer.html `.git-*`), never literals. Every text is set
 * with textContent: branch names and PR titles are data (`feat/<b>x</b>&"q` is a legal branch name).
 *
 * THE DIAL MOVES (#46, mock A3 Settle): it swings on its own clock (app/git-swing.js), each spoke
 * breathes +-3%, and live branches stream sparks only for measured growth. Motion is a rAF loop that
 * writes attributes on the existing drawing; a redraw replaces the drawing, never the clock.
 *
 * THE PANEL IS REDRAWN EVERY 30s, so what the person is doing lives OUTSIDE the drawing (PR #85
 * Dexter F1 / Miguel B1, Y1, Y3): the listeners are attached to the dial ONCE and find their spoke
 * by delegation; the pinned drawer, the focused spoke or action and an action's answer are kept in
 * `dial.gitState` and put back after a redraw; an answer identical to the last one draws nothing.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitRingsDisplay`.
 */
(function (root) {

const isNode = typeof module !== 'undefined' && module.exports;
const rings = isNode ? require('./git-rings') : root.gitRings;
const swing = isNode ? require('./git-swing') : root.gitSwing;
const actionsLib = isNode ? require('./git-actions') : root.gitActions;
const SVG = 'http://www.w3.org/2000/svg';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PEOPLE_SHOWN = 4;
const HUB = '\u0000hub';   // the hub's key: no branch name can hold a NUL

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtTokens(n) {
  if (!isNum(n)) return null;
  // decide the unit on the ROUNDED value: 999,999 is "1.0M", never "1000k"; 9.96M is "10M",
  // never "10.0M" (PR #85 Dexter F4 / Miguel S2)
  if (n >= 999500) {
    const m = n / 1e6;
    return (Math.round(m * 10) / 10 >= 10 ? Math.round(m) : m.toFixed(1)) + 'M';
  }
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function shortDay(day) {
  const m = typeof day === 'string' ? /^(\d{4})-(\d\d)-(\d\d)/.exec(day) : null;
  if (!m) return null;
  const month = Number(m[2]);
  const d = Number(m[3]);
  if (month < 1 || month > 12 || d < 1 || d > 31) return null;
  return `${MON[month - 1]} ${d}`;
}

const STATE = { merged: 'merged', open: 'PR open', unmerged: 'unmerged, no PR', deleted: 'deleted, never merged' };
const PLACE = { worktree: 'its own worktree, open now', 'had-worktree': 'its own worktree', dev: null };

function peopleLines(people) {
  const list = Array.isArray(people) ? people : [];
  return {
    people: list.slice(0, PEOPLE_SHOWN).map(p => ({ name: p.name, runs: p.runs, spend: fmtTokens(p.spend) })),
    more: Math.max(0, list.length - PEOPLE_SHOWN),
  };
}

// When it was worked on: the ledger's first to last day, else the one day git gives.
function workDays(b) {
  const first = shortDay(b.first);
  const last = shortDay(b.last);
  if (first && last && first !== last) return `${first} → ${last}`;
  return first || last || shortDay(b.when);
}

function cardModel(b, { current = null, prsKnown = true } = {}) {
  let state = STATE[b.state] || b.state;
  if (b.state === 'unmerged' && !prsKnown) state = 'unmerged · PR status unknown';
  const kind = [b.pr ? `#${b.pr}` : null, state].filter(Boolean).join(' · ');
  let why = b.why;
  const whyMissing = !why;
  if (whyMissing) {
    why = b.state === 'deleted'
      ? 'No description: this branch is gone from git; it is known only in the transcripts.'
      : 'No description: no PR title and no commit of its own.';
  }
  const days = workDays(b);
  const merged = b.state === 'merged' && b.first && shortDay(b.when) && shortDay(b.when) !== shortDay(b.last)
    ? `merged ${shortDay(b.when)}` : null;
  const sum = [
    isNum(b.spend) ? `${fmtTokens(b.spend)} tokens` : 'no token record',
    b.commits ? plural(b.commits, 'commit') : null,
    days, merged,
    PLACE[b.place] || null,
  ].filter(Boolean).join(' · ');
  return {
    title: (b.name === current ? '▶ ' : '') + b.name, kind, why, whyMissing, sum,
    ...peopleLines(b.people),
    jump: b.place === 'worktree' && typeof b.folder === 'string' && b.folder !== '',
  };
}

/** The hub DRAWS the whole tree's total; its card names both numbers (PR #85 Dexter F8). */
function hubCard(tree) {
  const spend = tree.hub && tree.hub.spend;
  const own = isNum(spend) ? `${fmtTokens(spend)} ${isNum(tree.totalSpend) ? `on ${tree.integration} itself` : 'tokens'}` : 'no token record';
  const all = isNum(tree.totalSpend) && isNum(spend) ? `${fmtTokens(tree.totalSpend)} across every branch` : null;
  const main = isNum(tree.mainMerges) ? `main has ${plural(tree.mainMerges, 'merge')}` : null;
  return {
    title: (tree.integration === tree.current ? '▶ ' : '') + tree.integration, kind: 'integration branch',
    why: 'Every lane merges here before it goes to main.', whyMissing: false,
    sum: [own, all, main].filter(Boolean).join(' · '),
    ...peopleLines(tree.hub && tree.hub.people), jump: false,
  };
}

function footer(tree) {
  const count = s => tree.branches.filter(b => b.state === s).length;
  // Open PRs unknown (gh failed): never "0 open" -- unknown is not none (PR #85 Dexter F3).
  const line2 = tree.prsKnown === false
    ? `${count('merged')} merged · ${count('open') + count('unmerged')} not merged, PR status unknown · ${count('deleted')} deleted`
    : `${count('merged')} merged · ${count('open')} open · ${count('unmerged')} unmerged · ${count('deleted')} deleted`;
  return {
    line1: `${tree.branches.length} ${tree.branches.length === 1 ? 'branch' : 'branches'} · ${isNum(tree.totalSpend) ? `${fmtTokens(tree.totalSpend)} tokens` : 'no token record yet'}`,
    line2,
    main: isNum(tree.mainMerges) ? `main · ${plural(tree.mainMerges, 'merge')}` : null,
  };
}

// ---------- the drawer's model (Enhancement #46) ----------

const NO_VERDICT = 'report, no verdict line';
const NO_REVIEWS = 'no review reports yet';

/** People with a bar: a share of the biggest shown spender. No spend figure (or none above 0): no bar. */
function barredPeople(people) {
  const shown = (Array.isArray(people) ? people : []).slice(0, PEOPLE_SHOWN);
  const max = shown.reduce((m, p) => (isNum(p.spend) && p.spend > m ? p.spend : m), 0);
  return {
    people: shown.map(p => ({
      name: p.name, runs: p.runs, spend: fmtTokens(p.spend),
      pct: isNum(p.spend) && max > 0 && p.spend > 0 ? Math.round(p.spend / max * 100) : null,
    })),
    more: Math.max(0, (Array.isArray(people) ? people.length : 0) - PEOPLE_SHOWN),
  };
}

/**
 * What the drawer says for a branch (or, with `hub`, for the integration branch): the card's facts,
 * who worked on it, its review verdicts, and its actions. `tab` is what the shell knows of the
 * branch's worktree tab (app/git-actions.js); null is "not known".
 */
function drawerModel(b, { tree, tab = null, hub = false } = {}) {
  const t = tree || {};
  if (hub) {
    const c = hubCard(t);
    return { title: c.title, kind: c.kind, why: c.why, whyMissing: false, sum: c.sum, ...barredPeople(t.hub && t.hub.people),
      reviews: [], noReviews: null, actions: [{ id: 'copy', label: 'Copy name', enabled: true, why: null }] };
  }
  const c = cardModel(b, { current: t.current, prsKnown: t.prsKnown });
  const reviews = (Array.isArray(b.reviews) ? b.reviews : []).map(r => {
    const has = typeof r.verdict === 'string' && r.verdict !== '';
    return { who: r.reviewer, round: r.round, text: has ? r.verdict : NO_VERDICT, none: !has };
  });
  return {
    title: c.title, kind: c.kind, why: c.why, whyMissing: c.whyMissing, sum: c.sum, ...barredPeople(b.people),
    reviews, noReviews: reviews.length ? null : NO_REVIEWS,
    actions: actionsLib.actionsFor(b, { prsKnown: t.prsKnown, repoUrl: t.repoUrl || null, originHost: t.originHost || null, tab }),
  };
}

/**
 * Where a live spoke's label sits: beside its tip on the side the spoke points to, kept inside the
 * dial (a mono glyph is ~0.6em wide at 10px). `angle` is the spoke's direction in the drawing as it is
 * now turned, so a label follows its tip round the swing and its text stays upright.
 */
function labelAt({ tipX, tipY, angle, text, width }) {
  const c = Math.cos(angle);
  const w = String(text).length * 6;
  let x = tipX + c * 12;
  let anchor = c >= 0 ? 'start' : 'end';
  if (anchor === 'end' && x - w < 4) { anchor = 'start'; x = 4; }
  if (anchor === 'start' && x + w > width - 4) { anchor = 'end'; x = width - 4; }
  return { x, y: tipY + Math.sin(angle) * 12 + 3, anchor };
}

// ---------- the DOM ----------

// Below this the dial's own text (hub name, labels, ticks) would be under ~7px on screen: it is
// hidden and the card and the footer carry the words. Measured by the window probe: the default
// 180px right zone draws the dial at ~45%.
const NARROW_SCALE = 0.75;
// A panel at least this wide has the drawer beside the dial; narrower, under it.
const BESIDE_MIN_W = 520;
// Motion: a frame about every 33 ms is plenty for a 90 s swing and a 9 s breath; a hidden panel looks
// again every half second.
const FRAME_MS = 33;
const IDLE_MS = 500;
const SPARKS_PER_SPOKE = 4;

function fitText(dial) {
  const svg = dial.querySelector('.git-svg');
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const scale = Math.min(r.width / rings.DIAL.width, r.height / rings.DIAL.height);
  dial.classList.toggle('narrow', scale > 0 && scale < NARROW_SCALE);
  dial.classList.toggle('beside', (dial.clientWidth || 0) >= BESIDE_MIN_W);
}

function el(doc, tag, attrs, parent, ns) {
  const e = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const svgEl = (doc, tag, attrs, parent) => el(doc, tag, attrs, parent, SVG);

function stateOf(dial) {
  if (!dial.gitState) {
    dial.gitState = { key: null, tree: null, byName: new Map(), pinned: null, hover: null,
      said: null, wired: 0, renders: 0,
      // handlers for the drawer's actions (renderer.js): each answers a Promise
      onJump: null, onOpenPr: null, onCopy: null, onRunMerged: null,
      // what the shell knows of each worktree's tab, by the folder as the tree spells it
      tabs: new Map(), tabsKnown: false,
      // measured growth: the names whose spend grew in the last refresh that found any, and when
      grown: new Set(), grownAt: null,
      // motion
      swing: swing.start(), angle: 0, held: false, reduced: false, pointerIn: false, parts: [], floaters: [], rot: null,
      scheduled: false, lastApply: -Infinity, mq: null, sparksShown: new Set(), liveShown: new Set(),
      // the actions waiting on their answer: a second press does nothing until the first answers (PR #93 F4)
      busy: new Set() };
  }
  return dial.gitState;
}

const keyOfEl = g => (g.getAttribute('data-hub') ? HUB : g.getAttribute('data-name'));
const spokeAt = (dial, target) => {
  const g = target && target.closest ? target.closest('.git-spoke, .git-hub') : null;
  return g && dial.contains(g) ? g : null;
};
function elementFor(dial, key) {
  for (const g of dial.querySelectorAll('.git-spoke, .git-hub')) if (keyOfEl(g) === key) return g;
  return null;
}

function modelFor(st, key) {
  if (key === HUB) return hubCard(st.tree);
  const b = st.byName.get(key);
  return b ? cardModel(b, { current: st.tree.current, prsKnown: st.tree.prsKnown }) : null;
}

function drawerFor(st, key) {
  if (key === HUB) return drawerModel(null, { tree: st.tree, hub: true });
  const b = st.byName.get(key);
  if (!b) return null;
  const tab = typeof b.folder === 'string' && st.tabsKnown ? st.tabs.get(b.folder) || null : null;
  return drawerModel(b, { tree: st.tree, tab });
}

function placeCard(dial, card, x, y) {
  const box = dial.getBoundingClientRect();
  card.style.left = `${Math.max(4, Math.min(x - box.left + 12, box.width - card.offsetWidth - 4))}px`;
  card.style.top = `${Math.max(4, Math.min(y - box.top + 12, box.height - card.offsetHeight - 4))}px`;
}

// The hover card: facts only, never clickable. What a click opens is the drawer.
function fillCard(dial, card, key) {
  const st = stateOf(dial);
  const m = modelFor(st, key);
  const doc = card.ownerDocument;
  card.textContent = '';
  if (!m) return false;
  card.dataset.key = key;
  const top = el(doc, 'div', { class: 'git-card-top' }, card);
  el(doc, 'span', { class: 'git-card-name' }, top).textContent = m.title;
  el(doc, 'span', { class: 'git-card-kind' }, top).textContent = m.kind;
  el(doc, 'div', { class: m.whyMissing ? 'git-card-why none' : 'git-card-why' }, card).textContent = m.why;
  el(doc, 'div', { class: 'git-card-sum' }, card).textContent = m.sum;
  if (m.people.length) {
    const who = el(doc, 'div', { class: 'git-card-who' }, card);
    for (const p of m.people) {
      el(doc, 'span', {}, who).textContent = `${p.name} ×${p.runs}`;
      el(doc, 'span', { class: 'n' }, who).textContent = p.spend || '';
    }
    if (m.more) el(doc, 'span', {}, who).textContent = `+${m.more} more`;
  }
  return true;
}

function show(dial, key, x, y) {
  const card = dial.querySelector('.git-card');
  if (!card || !fillCard(dial, card, key)) return;
  card.hidden = false;
  placeCard(dial, card, x, y);
}
function hideCard(dial) {
  const card = dial.querySelector('.git-card');
  if (card) card.hidden = true;
}
function centerOf(g) {
  const r = g.getBoundingClientRect();
  return [r.right, r.bottom];
}

// ---------- the drawer ----------

function fillDrawer(dial, key) {
  const st = stateOf(dial);
  const drawer = dial.querySelector('.git-drawer');
  const m = drawerFor(st, key);
  if (!drawer || !m) return false;
  const doc = drawer.ownerDocument;
  drawer.textContent = '';
  drawer.dataset.key = key;
  drawer.setAttribute('aria-label', `${m.title}: details and actions`);
  const top = el(doc, 'div', { class: 'git-card-top' }, drawer);
  el(doc, 'span', { class: 'git-card-name' }, top).textContent = m.title;
  el(doc, 'span', { class: 'git-card-kind' }, top).textContent = m.kind;
  el(doc, 'div', { class: m.whyMissing ? 'git-card-why none' : 'git-card-why' }, drawer).textContent = m.why;
  el(doc, 'div', { class: 'git-card-sum' }, drawer).textContent = m.sum;

  if (m.people.length) {
    const who = el(doc, 'div', { class: 'git-drawer-who' }, drawer);
    for (const p of m.people) {
      el(doc, 'span', { class: 'p' }, who).textContent = `${p.name} ×${p.runs}`;
      const track = el(doc, 'span', { class: p.pct === null ? 'bar none' : 'bar' }, who);
      if (p.pct !== null) el(doc, 'i', {}, track).style.width = `${p.pct}%`;
      el(doc, 'span', { class: 'n' }, who).textContent = p.spend || '';
    }
    if (m.more) el(doc, 'span', { class: 'p more' }, who).textContent = `+${m.more} more`;
  }

  if (key !== HUB) {
    const rv = el(doc, 'div', { class: 'git-drawer-reviews' }, drawer);
    if (m.noReviews) {
      el(doc, 'div', { class: 'none' }, rv).textContent = m.noReviews;
    } else {
      for (const r of m.reviews) {
        el(doc, 'span', { class: 'p' }, rv).textContent = `${r.who} r${r.round}`;
        el(doc, 'span', { class: r.none ? 'v none' : 'v' }, rv).textContent = r.text;
      }
    }
  }

  const acts = el(doc, 'div', { class: 'git-acts' }, drawer);
  for (const a of m.actions) {
    const row = el(doc, 'div', { class: 'git-act-row' }, acts);
    const btn = el(doc, 'button', { type: 'button', class: `git-act ${a.id}`, 'data-act': a.id,
      'aria-disabled': a.enabled ? 'false' : 'true' }, row);
    btn.textContent = a.label;
    if (!a.enabled) {
      // Every disabled action says why, where it can be seen and heard: beside it, and as its description.
      // Not also as a title, which a screen reader announces a second time (PR #93 Miguel S2).
      const why = el(doc, 'span', { class: 'git-act-why', id: `git-act-why-${a.id}` }, row);
      why.textContent = a.why;
      btn.setAttribute('aria-describedby', why.id);
    }
  }
  syncSaid(st, key);
  return true;
}

/**
 * The answer to an action lives in ONE status node per panel (`.git-said`), made once and never rebuilt:
 * a live region inserted already holding its text is often not announced, and the drawer is rebuilt on
 * every redraw (PR #93 Miguel S2). It shows the answer for the open drawer's branch, and nothing else.
 */
function syncSaid(st, key) {
  const node = st.saidEl;
  if (!node) return;
  const want = st.said && key !== null && st.said.key === key ? st.said.text : '';
  if (node.textContent !== want) node.textContent = want;
}

function openDrawer(dial, key, { focus = null } = {}) {
  const st = stateOf(dial);
  const drawer = dial.querySelector('.git-drawer');
  if (!drawer || !fillDrawer(dial, key)) return false;
  st.pinned = key;
  hideCard(dial);
  drawer.hidden = false;
  if (focus === 'actions') {
    const m = drawerFor(st, key);
    const want = m ? actionsLib.firstFocus(m.actions) : null;
    const btn = drawer.querySelector(want ? `.git-act[data-act="${want}"]` : '.git-act');
    if (btn) btn.focus();
  }
  fitText(dial);
  return true;
}

function closeDrawer(dial, { refocus }) {
  const st = stateOf(dial);
  const was = st.pinned;
  st.pinned = null;
  const drawer = dial.querySelector('.git-drawer');
  if (drawer) { drawer.hidden = true; drawer.textContent = ''; }
  syncSaid(st, null);
  fitText(dial);
  if (refocus && was) { const g = elementFor(dial, was); if (g) g.focus(); }
}

// A click toggles; the keyboard and the arrow keys only ever open (or move) it.
function togglePin(dial, key) {
  const st = stateOf(dial);
  st.said = null;
  if (st.pinned === key) closeDrawer(dial, { refocus: false });
  else openDrawer(dial, key);
}

function say(dial, key, text) {
  const st = stateOf(dial);
  st.said = { key, text: String(text || '') };
  syncSaid(st, st.pinned);
}

const errText = err => (err && err.message) || String(err);

/** One of the drawer's actions. Disabled ones do nothing: their reason is already on screen. */
async function act(dial, id) {
  const st = stateOf(dial);
  const key = st.pinned;
  const m = key !== null ? drawerFor(st, key) : null;
  const a = m && m.actions.find(x => x.id === id);
  if (!a || !a.enabled) return;
  const b = key === HUB ? null : st.byName.get(key);
  // A double click or a held Enter on the button fires again before the first answer: ignored here, and
  // refused by the shell too (app/tab-shell.js runMerged, the authoritative guard).
  const busyKey = `${key}\u0000${id}`;
  if (st.busy.has(busyKey)) return;
  st.busy.add(busyKey);
  const btn = dial.querySelector(`.git-act[data-act="${id}"]`);
  if (btn) btn.setAttribute('aria-busy', 'true');
  try {
    if (id === 'jump') {
      if (!b || !b.folder || !st.onJump) return;
      const r = await st.onJump(b.folder);
      // an IPC's answer outlives a redraw: kept in state, shown on the new drawer (PR #85 Dexter F1)
      if (r && r.kind === 'explain') say(dial, key, r.text);
    } else if (id === 'open-pr') {
      if (!b || !st.onOpenPr) return say(dial, key, "Can't open a browser from here.");
      const ok = await st.onOpenPr(b.prUrl);
      say(dial, key, ok ? `Opened PR #${b.pr} in your browser.` : "Couldn't open the browser.");
    } else if (id === 'copy') {
      const name = key === HUB ? st.tree.integration : key;
      if (!st.onCopy) return say(dial, key, "Can't copy from here.");
      await st.onCopy(name);
      say(dial, key, `Copied ${name}.`);
    } else if (id === 'run-merged') {
      if (!b || !b.folder || !st.onRunMerged) return;
      const r = await st.onRunMerged(b.folder, b.name);
      // A box that wasn't empty was cleared first (a draft, or the CLI's placeholder: the text can't tell)
      if (r && r.kind === 'sent') {
        say(dial, key, `Sent /merged to ${r.branch || b.name}'s session.`
          + (r.cleared ? " Its input box wasn't empty: if that was a draft, Ctrl+Y in that tab brings it back." : ''));
      }
      else say(dial, key, (r && r.text) || "Couldn't run /merged.");
    }
  } catch (err) {
    say(dial, key, `Couldn't do that: ${errText(err)}`);
  } finally {
    st.busy.delete(busyKey);
    const now = dial.querySelector(`.git-act[data-act="${id}"]`);
    if (now) now.removeAttribute('aria-busy');
  }
}

// ---------- motion ----------

function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

const reducedMotion = st => {
  if (!st.mq && typeof matchMedia === 'function') st.mq = matchMedia('(prefers-reduced-motion: reduce)');
  return !!st.mq && st.mq.matches;
};

const growthActive = (st, wall) => swing.sparksOn(st.grownAt, wall);

/** Writes the swing, the breath, the sparks and the live look onto the drawing as it is now. */
function apply(dial, st, t, wall) {
  const { cx, cy } = rings.DIAL;
  const reduced = st.reduced;
  const angle = reduced ? 0 : swing.angleDeg(st.swing.clock);
  st.angle = angle;
  if (st.rot) {
    st.rot.setAttribute('transform', `rotate(${angle.toFixed(3)} ${cx} ${cy})`);
    st.rot.setAttribute('data-angle', angle.toFixed(3));
  }
  const active = growthActive(st, wall);
  const sparks = swing.sparkNames(st.grown, active);
  const working = new Set();
  for (const info of st.tabs.values()) if (info.working === true) working.add(info.folder);
  const live = swing.liveSet(st.tree ? st.tree.branches : [], working, st.grown, active);
  st.sparksShown = sparks;
  st.liveShown = live;
  const rad = angle * Math.PI / 180;
  for (const p of st.parts) {
    // On the swing's own clock, so the breath eases to a stop with the dial under a pin or the pointer: a
    // spoke never shifts under a click (PR #93 Miguel S1). PERIOD_S is a multiple of the breath's period,
    // so the clock wrapping never jumps it.
    const f = swing.breath(p.name, st.swing.clock, { reduced });
    const dx = (p.s.x1 - p.s.x0) * f;
    const dy = (p.s.y1 - p.s.y0) * f;
    const tx = p.s.x0 + dx;
    const ty = p.s.y0 + dy;
    if (f !== p.f) {
      p.f = f;
      const d = `M${p.s.x0} ${p.s.y0} L${tx} ${ty}`;
      p.stem.setAttribute('d', d);
      p.hit.setAttribute('d', d);
      p.tipg.setAttribute('transform', `translate(${tx - p.s.x1} ${ty - p.s.y1})`);
    }
    const isLive = live.has(p.name);
    if (isLive !== p.live) { p.live = isLive; p.g.classList.toggle('live', isLive); }
    if (p.sparks) {
      const on = sparks.has(p.name) && !reduced;
      p.sparksG.style.display = on ? '' : 'none';
      if (on) {
        const c = Math.cos(p.s.angle);
        const s = Math.sin(p.s.angle);
        p.sparkEls.forEach((e, i) => {
          const u = swing.sparkAt(i, p.sparkEls.length, t);
          const dist = 5 + u * 26;
          e.setAttribute('cx', (tx + c * dist).toFixed(2));
          e.setAttribute('cy', (ty + s * dist).toFixed(2));
          e.setAttribute('opacity', (1 - u).toFixed(2));
        });
      }
    }
    if (p.label) {
      const [rx, ry] = swing.rotatePoint(tx, ty, cx, cy, angle);
      const at = labelAt({ tipX: rx, tipY: ry, angle: p.s.angle + rad, text: p.labelText, width: rings.DIAL.width });
      p.label.setAttribute('x', at.x.toFixed(2));
      p.label.setAttribute('y', at.y.toFixed(2));
      p.label.setAttribute('text-anchor', at.anchor);
    }
  }
  // the 12 o'clock ticks travel with the gap they name but stay upright
  for (const f of st.floaters) {
    const [rx, ry] = swing.rotatePoint(f.x, f.y, cx, cy, angle);
    f.el.setAttribute('transform', `translate(${(rx - f.x).toFixed(2)} ${(ry - f.y).toFixed(2)})`);
  }
}

function tick(dial, t) {
  const st = stateOf(dial);
  st.scheduled = false;
  if (!dial.isConnected || !st.tree) return;
  const doc = dial.ownerDocument;
  const unseen = doc.visibilityState === 'hidden' || dial.getClientRects().length === 0;
  if (!unseen) {
    st.reduced = reducedMotion(st);
    st.held = st.pinned !== null || st.pointerIn;
    st.swing = swing.step(st.swing, t, { holding: st.held, reduced: st.reduced });
    if (t - st.lastApply >= FRAME_MS) { st.lastApply = t; apply(dial, st, t, Date.now()); }
  }
  schedule(dial, unseen || st.reduced);
}

function schedule(dial, slow) {
  const st = stateOf(dial);
  if (st.scheduled) return;
  st.scheduled = true;
  if (!slow && typeof requestAnimationFrame === 'function') requestAnimationFrame(t => tick(dial, t));
  else setTimeout(() => tick(dial, nowMs()), IDLE_MS);
}

/** The swing as the window probe reads it. */
function motionState(dial) {
  const st = stateOf(dial);
  const parts = {};
  for (const p of st.parts) parts[p.name] = { f: p.f, live: p.live === true, sparks: !!p.sparks && p.sparksG.style.display !== 'none' };
  return { angle: st.angle, clock: st.swing.clock, speed: st.swing.speed, held: st.held, reduced: st.reduced,
    pointerIn: st.pointerIn, running: st.scheduled, grownAt: st.grownAt, grown: [...st.grown],
    live: [...st.liveShown], sparks: [...st.sparksShown], parts };
}

// ONCE per dial: every pointer and key event is found by delegation, so a redraw never adds a
// listener (PR #85 Miguel B1 / Dexter F2: one more per 30s re-ask, each holding an old SVG).
function wire(dial) {
  const st = stateOf(dial);
  if (st.wired) return;
  st.wired += 1;
  // The dial holds still while the pointer is anywhere over the panel, so a spoke never slides from
  // under a click (A3 Settle).
  dial.addEventListener('pointerenter', () => { st.pointerIn = true; });
  dial.addEventListener('pointerleave', () => { st.pointerIn = false; });
  dial.addEventListener('mouseover', e => {
    const g = spokeAt(dial, e.target);
    if (!g || st.pinned !== null) return;
    const key = keyOfEl(g);
    const card = dial.querySelector('.git-card');
    if (st.hover === key && card && !card.hidden && card.dataset.key === key) {
      // the same spoke, its card already up: only place it again -- the panel may have moved zones since
      // (window probe 3b). Only if the card shows THIS spoke: a focus may have put another one up meanwhile.
      placeCard(dial, card, e.clientX, e.clientY);
      return;
    }
    st.hover = key;
    show(dial, key, e.clientX, e.clientY);
  });
  dial.addEventListener('mousemove', e => {
    // only MOVE the card: rebuilding it on every mousemove forced a layout per event (Miguel Y3)
    if (st.pinned !== null || st.hover === null) return;
    const card = dial.querySelector('.git-card');
    if (card && !card.hidden) placeCard(dial, card, e.clientX, e.clientY);
  });
  dial.addEventListener('mouseout', e => {
    const g = spokeAt(dial, e.target);
    if (!g || g.contains(e.relatedTarget)) return;
    st.hover = null;
    if (st.pinned === null) hideCard(dial);
  });
  dial.addEventListener('focusin', e => {
    const g = spokeAt(dial, e.target);
    // a redraw putting the focus back is not the person moving it: the card stays what it was (Miguel I4)
    if (!g || st.pinned !== null || st.restoringFocus) return;
    const [x, y] = centerOf(g);
    show(dial, keyOfEl(g), x, y);
  });
  dial.addEventListener('focusout', e => {
    if (st.pinned !== null || dial.contains(e.relatedTarget)) return;
    hideCard(dial);
  });
  dial.addEventListener('click', e => {
    const btn = e.target.closest ? e.target.closest('.git-act') : null;
    if (btn) { act(dial, btn.getAttribute('data-act')); return; }
    if (e.target.closest && (e.target.closest('.git-card') || e.target.closest('.git-drawer'))) return;
    const g = spokeAt(dial, e.target);
    if (g) togglePin(dial, keyOfEl(g));
    else if (st.pinned !== null) closeDrawer(dial, { refocus: false });
  });
  dial.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.pinned !== null) {
      // from anywhere in the panel, an action included (Miguel Y2)
      e.preventDefault();
      closeDrawer(dial, { refocus: true });
      return;
    }
    const g = spokeAt(dial, e.target);
    if (!g) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const key = keyOfEl(g);
      // a keyboard open takes the focus to the first action that works, so it's one key away, not every
      // spoke away (Miguel Y2); on a spoke the arrows already opened, Enter goes into the drawer
      st.said = st.pinned === key ? st.said : null;
      openDrawer(dial, key, { focus: 'actions' });
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step) {
      // the arrows walk the spokes in time order and the drawer follows, so a keyboard needs no click
      e.preventDefault();
      const spokes = [...dial.querySelectorAll('.git-spoke')];
      if (!spokes.length) return;
      const i = spokes.indexOf(g);
      const next = i < 0 ? spokes[step > 0 ? 0 : spokes.length - 1] : spokes[(i + step + spokes.length) % spokes.length];
      next.focus({ preventScroll: true });
      st.said = null;
      openDrawer(dial, keyOfEl(next));
    }
  });
}

/**
 * Draws `tree` into the panel. `rootEl` holds #git-status and #git-dial. deps: onJump(folder),
 * onOpenPr(url) -> Promise<boolean>, onCopy(name), onRunMerged(folder) -> Promise<{ kind, text?, branch? }>;
 * `tabs` is the shell's [{ folder, open, started, known, working, needsInput }] or null (not known);
 * `now` is the wall clock. An answer identical to the last one draws nothing (Dexter F1, Miguel Y1).
 */
function render(rootEl, tree, { onJump, onOpenPr, onCopy, onRunMerged, tabs = null, now = Date.now() } = {}) {
  const doc = rootEl.ownerDocument;
  const status = rootEl.querySelector('#git-status');
  const dial = rootEl.querySelector('#git-dial');
  const st = stateOf(dial);
  st.onJump = onJump || null;
  st.onOpenPr = onOpenPr || null;
  st.onCopy = onCopy || null;
  st.onRunMerged = onRunMerged || null;
  // the panel's one status node, made once (syncSaid says why)
  if (!st.saidEl || !st.saidEl.isConnected) {
    st.saidEl = rootEl.querySelector('.git-said') || el(doc, 'div', { class: 'git-said', role: 'status', 'aria-live': 'polite' }, rootEl);
  }
  const key = JSON.stringify([tree === undefined ? null : tree, tabs]);
  if (key === st.key) return;
  st.key = key;
  st.renders += 1;
  wire(dial);

  st.tabsKnown = Array.isArray(tabs);
  st.tabs = new Map((st.tabsKnown ? tabs : []).filter(t => t && typeof t.folder === 'string').map(t => [t.folder, t]));
  // Measured growth: a refresh whose spend is larger than the last answer's, for a branch measured both
  // times. The first answer, an unknown spend or a drop is not growth, so there are no sparks.
  if (tree && tree.ok) {
    const g = swing.grown(st.tree && st.tree.ok ? st.tree.branches : null, tree.branches);
    if (g.size) {
      st.grown = growthActive(st, now) ? new Set([...st.grown, ...g]) : g;
      st.grownAt = now;
    }
  }

  // what the person was doing, put back after the redraw
  const active = doc.activeElement;
  const focusedAct = active && dial.contains(active) && active.closest && active.closest('.git-act')
    ? active.closest('.git-act').getAttribute('data-act') : null;
  const focusedKey = !focusedAct && active && dial.contains(active) && spokeAt(dial, active) ? keyOfEl(spokeAt(dial, active)) : null;
  // the hover card under the pointer: the 2 s tab-state poll redraws, and no mouseover follows to show it
  // again (PR #93 Miguel I4). Its place is kept as it was set, so no layout is read here.
  const card0 = dial.querySelector('.git-card');
  const cardWas = card0 && !card0.hidden && st.pinned === null && st.hover !== null
    ? { key: st.hover, left: card0.style.left, top: card0.style.top } : null;

  dial.textContent = '';
  st.parts = [];
  st.floaters = [];
  st.rot = null;
  if (!tree || !tree.ok) {
    st.tree = null;
    st.byName = new Map();
    st.pinned = null;
    status.textContent = `Can't read this repo's history: ${(tree && tree.error) || 'no answer'}`;
    return;
  }
  st.tree = tree;
  st.byName = new Map(tree.branches.map(b => [b.name, b]));
  status.textContent = tree.ledgerOk === false ? 'Some transcripts could not be read, so some spend may be missing.' : '';

  const { DIAL } = rings;
  const { spokes, weeks } = rings.layout(tree.branches);
  const { cx, cy, r0, r1 } = DIAL;
  const sparkOn = swing.sparkNames(st.grown, growthActive(st, now));
  const working = new Set([...st.tabs.values()].filter(t => t.working === true).map(t => t.folder));
  const liveNow = swing.liveSet(tree.branches, working, st.grown, growthActive(st, now));

  const stage = el(doc, 'div', { class: 'git-stage' }, dial);
  // role "group", not "img": an image's children are hidden from assistive tech, and the spokes
  // are focusable controls (Miguel Y2)
  const svg = svgEl(doc, 'svg', { viewBox: `0 0 ${DIAL.width} ${DIAL.height}`, class: 'git-svg', role: 'group',
    'aria-label': `${tree.branches.length} branches of this project` }, stage);
  // everything that turns with the dial: the weeks, the 12 o'clock line and every spoke
  const rot = svgEl(doc, 'g', { class: 'git-rot', transform: 'rotate(0)' }, svg);
  st.rot = rot;

  for (const w of weeks) {
    const r = r0 - 9;
    const big = w.a1 - w.a0 > Math.PI ? 1 : 0;
    svgEl(doc, 'path', { class: w.alt ? 'git-week alt' : 'git-week',
      d: `M${cx + r * Math.cos(w.a0)} ${cy + r * Math.sin(w.a0)} A${r} ${r} 0 ${big} 1 ${cx + r * Math.cos(w.a1)} ${cy + r * Math.sin(w.a1)}` }, rot);
  }
  // 12 o'clock: where history starts and now ends
  svgEl(doc, 'line', { class: 'git-noon', x1: cx, y1: cy - r0 + 4, x2: cx, y2: cy - r1 - 4 }, rot);
  const firstDay = tree.branches.map(b => shortDay(b.when)).find(Boolean);
  if (firstDay) {
    const t = svgEl(doc, 'text', { class: 'git-tick', x: cx + 5, y: cy - r1 + 2 }, svg);
    t.textContent = `${firstDay} →`;
    st.floaters.push({ el: t, x: cx + 5, y: cy - r1 + 2 });
  }
  const now12 = svgEl(doc, 'text', { class: 'git-tick', x: cx - 5, y: cy - r1 + 2, 'text-anchor': 'end' }, svg);
  now12.textContent = '← now';
  st.floaters.push({ el: now12, x: cx - 5, y: cy - r1 + 2 });

  const labelEls = [];
  tree.branches.forEach((b, i) => {
    const s = spokes[i];
    // gh unknown: a live lane may have an open PR, so it isn't colored "no PR" (Dexter F3)
    const prUnknown = b.state === 'unmerged' && tree.prsKnown === false;
    const isLive = liveNow.has(b.name);
    const cls = ['git-spoke', b.state, prUnknown ? 'pr-unknown' : '', b.name === tree.current ? 'current' : '', b.place, isLive ? 'live' : '']
      .filter(Boolean).join(' ');
    const g = svgEl(doc, 'g', { class: cls, tabindex: '0', 'data-name': b.name,
      'aria-label': `${b.name}${b.why ? `: ${b.why}` : ''}${isLive ? ' (live)' : ''}` }, rot);
    const d = `M${s.x0} ${s.y0} L${s.x1} ${s.y1}`;
    const stem = svgEl(doc, 'path', { class: s.dashed ? 'git-stem dashed' : 'git-stem', d, 'stroke-width': s.width }, g);
    const hit = svgEl(doc, 'path', { class: 'git-hit', d }, g);
    // the tip, its ring and its hit area move together as the spoke breathes
    const tipg = svgEl(doc, 'g', { class: 'git-tipg' }, g);
    if (b.name === tree.current) svgEl(doc, 'circle', { class: 'git-here', cx: s.x1, cy: s.y1, r: s.tipR + 6 }, tipg);
    // unknown spend: the tip says "unknown" too, like the stem, not "no runs" (Dexter F7)
    const tipCls = s.dashed ? 'git-tip unknown' : b.runs ? 'git-tip' : 'git-tip empty';
    if (b.place === 'dev') {
      svgEl(doc, 'circle', { class: tipCls, cx: s.x1, cy: s.y1, r: s.tipR }, tipg);
    } else {
      const z = s.tipR * 1.8;
      svgEl(doc, 'rect', { class: tipCls, x: s.x1 - z / 2, y: s.y1 - z / 2, width: z, height: z, rx: 1.5 }, tipg);
      if (b.place === 'worktree') svgEl(doc, 'rect', { class: 'git-ring', x: s.x1 - z / 2 - 3, y: s.y1 - z / 2 - 3, width: z + 6, height: z + 6, rx: 3 }, tipg);
    }
    svgEl(doc, 'circle', { class: 'git-hit', cx: s.x1, cy: s.y1, r: Math.max(9, s.tipR + 4) }, tipg);

    const part = { name: b.name, s, g, stem, hit, tipg, f: 1, live: isLive, sparks: false, label: null, labelText: '' };
    // Sparks, only for a branch whose spend was MEASURED to grow (never decoration on a quiet one)
    if (sparkOn.has(b.name)) {
      part.sparks = true;
      part.sparksG = svgEl(doc, 'g', { class: 'git-sparks', 'aria-hidden': 'true' }, g);
      part.sparkEls = Array.from({ length: SPARKS_PER_SPOKE }, () => svgEl(doc, 'circle', { class: 'git-spark', r: 1.5, cx: s.x1, cy: s.y1 }, part.sparksG));
    }
    if (b.state === 'open' || prUnknown || b.name === tree.current || b.place === 'worktree' || isLive) {
      part.labelText = (b.name === tree.current ? '▶ ' : '') + b.name.replace(/^(feat|fix)\//, '') + (b.pr && b.state !== 'merged' ? ` #${b.pr}` : '');
      labelEls.push({ part, cls: `git-label ${b.state}${b.name === tree.current ? ' current' : ''}${isLive ? ' live' : ''}` });
    }
    st.parts.push(part);
  });

  const hub = svgEl(doc, 'g', { class: tree.integration === tree.current ? 'git-hub current' : 'git-hub', tabindex: '0',
    'data-hub': '1', 'aria-label': tree.integration }, svg);
  svgEl(doc, 'circle', { cx, cy, r: r0 - 18 }, hub);
  svgEl(doc, 'text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'git-hub-name' }, hub).textContent = tree.integration;
  svgEl(doc, 'text', { x: cx, y: cy + 12, 'text-anchor': 'middle', class: 'git-hub-sum' }, hub).textContent =
    isNum(tree.totalSpend) ? fmtTokens(tree.totalSpend) : '?';

  // Labels sit OUTSIDE the turning group so their text stays upright; apply() places each beside its tip.
  for (const l of labelEls) l.part.label = svgEl(doc, 'text', { class: l.cls, x: 0, y: 0 }, svg), l.part.label.textContent = l.part.labelText;

  el(doc, 'aside', { class: 'git-drawer', hidden: '', tabindex: '-1', role: 'region', 'aria-label': 'Branch details' }, stage);
  el(doc, 'div', { class: 'git-card', hidden: '' }, dial);

  const f = footer(tree);
  const foot = el(doc, 'div', { class: 'git-foot' }, dial);
  const row = el(doc, 'div', { class: 'git-foot-row' }, foot);
  el(doc, 'b', {}, row).textContent = f.line1;
  if (f.main) el(doc, 'span', { class: 'git-foot-main' }, row).textContent = f.main;
  el(doc, 'div', { class: 'git-foot-states' }, foot).textContent = f.line2;

  // Zones are dragged wider and narrower: re-check the text size whenever the dial changes size.
  fitText(dial);
  if (!dial.gitResize && typeof ResizeObserver !== 'undefined') {
    dial.gitResize = new ResizeObserver(() => fitText(dial));
    dial.gitResize.observe(dial);
  }

  // Put back what the person was doing (Dexter F1): the open drawer, and the focus.
  if (st.pinned !== null) {
    const g = st.pinned === HUB || st.byName.has(st.pinned) ? elementFor(dial, st.pinned) : null;
    if (g) openDrawer(dial, st.pinned);
    else st.pinned = null;
  }
  st.restoringFocus = true;
  try {
    if (focusedAct) {
      const btn = dial.querySelector(`.git-act[data-act="${focusedAct}"]`);
      if (btn) btn.focus();
      else if (st.pinned !== null) { const g = elementFor(dial, st.pinned); if (g) g.focus({ preventScroll: true }); }
    } else if (focusedKey !== null) {
      const g = elementFor(dial, focusedKey);
      if (g) g.focus({ preventScroll: true });
    }
  } finally {
    st.restoringFocus = false;
  }
  // the hover card, after the focus: the pointer is still over the spoke it was showing
  if (cardWas && st.pinned === null && st.hover === cardWas.key && (cardWas.key === HUB || st.byName.has(cardWas.key))) {
    const card = dial.querySelector('.git-card');
    if (card && fillCard(dial, card, cardWas.key)) {
      card.hidden = false;
      card.style.left = cardWas.left;
      card.style.top = cardWas.top;
    }
  }

  // the drawing is new: put the swing and the breath on it now, then keep them going
  st.reduced = reducedMotion(st);
  apply(dial, st, nowMs(), now);
  schedule(dial, false);
}

const api = { render, cardModel, drawerModel, hubCard, footer, fmtTokens, labelAt, motionState };

if (isNode) {
  module.exports = api;
} else {
  root.gitRingsDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
