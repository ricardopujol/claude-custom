'use strict';
/**
 * The Git panel (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md Task 10): the Rings dial from
 * app/git-rings.js, its hover card, and *Jump to its tab*.
 *
 *   render(root, tree, { onJump })    draws `tree` (the host's `git-tree` answer) into the panel
 *   cardModel(branch, { current, prsKnown })   what a spoke's card says
 *   hubCard(tree) / footer(tree) / fmtTokens(n)
 *
 * The card is SMALL on purpose (Ricardo, 2026-10-01): the name with its PR and state, what it was
 * for (15 words at most, from the host), one summary line, and who worked on it. Colors come from
 * the theme through CSS classes (renderer.html `.git-*`), never literals. Every text is set with
 * textContent: branch names and PR titles are data (`feat/<b>x</b>&"q` is a legal branch name).
 *
 * THE PANEL IS REDRAWN EVERY 30s, so what the person is doing lives OUTSIDE the drawing (PR #85
 * Dexter F1 / Miguel B1, Y1, Y3): the listeners are attached to the dial ONCE and find their spoke
 * by delegation; the pinned card, the focused spoke and a jump's answer are kept in `dial.gitState`
 * and put back after a redraw; an answer identical to the last one draws nothing at all.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitRingsDisplay`.
 */
(function (root) {

const rings = typeof module !== 'undefined' && module.exports ? require('./git-rings') : root.gitRings;
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

// ---------- the DOM ----------

// Below this the dial's own text (hub name, labels, ticks) would be under ~7px on screen: it is
// hidden and the card and the footer carry the words. Measured by the window probe: the default
// 180px right zone draws the dial at ~45%.
const NARROW_SCALE = 0.75;

function fitText(dial) {
  const svg = dial.querySelector('.git-svg');
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const scale = Math.min(r.width / rings.DIAL.width, r.height / rings.DIAL.height);
  dial.classList.toggle('narrow', scale > 0 && scale < NARROW_SCALE);
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
    dial.gitState = { key: null, tree: null, byName: new Map(), onJump: null, pinned: null, hover: null,
      said: null, wired: 0, renders: 0 };
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

function placeCard(dial, card, x, y) {
  const box = dial.getBoundingClientRect();
  card.style.left = `${Math.max(4, Math.min(x - box.left + 12, box.width - card.offsetWidth - 4))}px`;
  card.style.top = `${Math.max(4, Math.min(y - box.top + 12, box.height - card.offsetHeight - 4))}px`;
}

function fillCard(dial, card, key, pinned) {
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
  if (pinned && m.jump && st.onJump) {
    el(doc, 'button', { type: 'button', class: 'git-card-jump' }, card).textContent = 'Jump to its tab';
    // a jump's answer outlives a redraw (PR #85 Dexter F1): kept in state, shown on the new card
    el(doc, 'div', { class: 'git-card-said' }, card).textContent = st.said && st.said.key === key ? st.said.text : '';
  }
  return true;
}

function show(dial, key, x, y, pinned) {
  const card = dial.querySelector('.git-card');
  if (!card || !fillCard(dial, card, key, pinned)) return;
  card.hidden = false;
  card.classList.toggle('pinned', pinned);
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

function pin(dial, key, x, y, { focusJump = false } = {}) {
  const st = stateOf(dial);
  if (st.pinned === key) { unpin(dial, { refocus: false }); return; }
  st.pinned = key;
  st.said = null;
  show(dial, key, x, y, true);
  const btn = dial.querySelector('.git-card-jump');
  if (focusJump && btn) btn.focus();
}
function unpin(dial, { refocus }) {
  const st = stateOf(dial);
  const was = st.pinned;
  st.pinned = null;
  hideCard(dial);
  if (refocus && was) { const g = elementFor(dial, was); if (g) g.focus(); }
}

async function jump(dial) {
  const st = stateOf(dial);
  const key = st.pinned;
  const b = key && st.byName.get(key);
  if (!b || !b.folder || !st.onJump) return;
  let r;
  try {
    r = await st.onJump(b.folder);
  } catch (err) {
    // an IPC that rejects is said, never swallowed (PR #85 Miguel S1)
    r = { kind: 'explain', text: `Couldn't switch tabs: ${(err && err.message) || err}` };
  }
  if (r && r.kind === 'explain') {
    st.said = { key, text: String(r.text || '') };
    const card = dial.querySelector('.git-card');
    const said = card && card.dataset.key === key ? card.querySelector('.git-card-said') : null;
    if (said) said.textContent = st.said.text;
  }
}

// ONCE per dial: every pointer and key event is found by delegation, so a redraw never adds a
// listener (PR #85 Miguel B1 / Dexter F2: one more per 30s re-ask, each holding an old SVG).
function wire(dial) {
  const st = stateOf(dial);
  if (st.wired) return;
  st.wired += 1;
  dial.addEventListener('mouseover', e => {
    const g = spokeAt(dial, e.target);
    if (!g || st.pinned) return;
    const key = keyOfEl(g);
    const card = dial.querySelector('.git-card');
    if (st.hover === key && card && !card.hidden) {
      // the same spoke: only place it again -- the panel may have moved zones since (window probe 3b)
      placeCard(dial, card, e.clientX, e.clientY);
      return;
    }
    st.hover = key;
    show(dial, key, e.clientX, e.clientY, false);
  });
  dial.addEventListener('mousemove', e => {
    // only MOVE the card: rebuilding it on every mousemove forced a layout per event (Miguel Y3)
    if (st.pinned || st.hover === null) return;
    const card = dial.querySelector('.git-card');
    if (card && !card.hidden) placeCard(dial, card, e.clientX, e.clientY);
  });
  dial.addEventListener('mouseout', e => {
    const g = spokeAt(dial, e.target);
    if (!g || g.contains(e.relatedTarget)) return;
    st.hover = null;
    if (!st.pinned) hideCard(dial);
  });
  dial.addEventListener('focusin', e => {
    const g = spokeAt(dial, e.target);
    if (!g || st.pinned) return;
    const [x, y] = centerOf(g);
    show(dial, keyOfEl(g), x, y, false);
  });
  dial.addEventListener('focusout', e => {
    if (st.pinned || dial.contains(e.relatedTarget)) return;
    hideCard(dial);
  });
  dial.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('.git-card-jump')) { jump(dial); return; }
    if (e.target.closest && e.target.closest('.git-card')) return;
    const g = spokeAt(dial, e.target);
    if (g) pin(dial, keyOfEl(g), e.clientX, e.clientY);
    else if (st.pinned) unpin(dial, { refocus: false });
  });
  dial.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.pinned) {
      // from anywhere in the panel, the Jump button included (Miguel Y2)
      e.preventDefault();
      unpin(dial, { refocus: true });
      return;
    }
    const g = spokeAt(dial, e.target);
    if (g && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const [x, y] = centerOf(g);
      // a keyboard pin takes the focus to Jump, so it's one key away, not every spoke away (Miguel Y2)
      pin(dial, keyOfEl(g), x, y, { focusJump: true });
    }
  });
}

/**
 * Draws `tree` into the panel. `rootEl` holds #git-status and #git-dial. deps.onJump(folder) ->
 * Promise<{ kind, text? }>. An answer identical to the last one draws nothing (Dexter F1, Miguel Y1).
 */
function render(rootEl, tree, { onJump } = {}) {
  const doc = rootEl.ownerDocument;
  const status = rootEl.querySelector('#git-status');
  const dial = rootEl.querySelector('#git-dial');
  const st = stateOf(dial);
  st.onJump = onJump || null;
  const key = JSON.stringify(tree === undefined ? null : tree);
  if (key === st.key) return;
  st.key = key;
  st.renders += 1;
  wire(dial);

  // what the person was doing, put back after the redraw
  const active = doc.activeElement;
  const focusedKey = active && dial.contains(active)
    ? (active.closest && active.closest('.git-card-jump') ? 'jump' : (spokeAt(dial, active) ? keyOfEl(spokeAt(dial, active)) : null))
    : null;
  const card0 = dial.querySelector('.git-card');
  const cardAt = card0 && !card0.hidden ? card0.getBoundingClientRect() : null;

  dial.textContent = '';
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
  // role "group", not "img": an image's children are hidden from assistive tech, and the spokes
  // are focusable controls (Miguel Y2)
  const svg = svgEl(doc, 'svg', { viewBox: `0 0 ${DIAL.width} ${DIAL.height}`, class: 'git-svg', role: 'group',
    'aria-label': `${tree.branches.length} branches of this project` }, dial);

  for (const w of weeks) {
    const r = r0 - 9;
    const big = w.a1 - w.a0 > Math.PI ? 1 : 0;
    svgEl(doc, 'path', { class: w.alt ? 'git-week alt' : 'git-week',
      d: `M${cx + r * Math.cos(w.a0)} ${cy + r * Math.sin(w.a0)} A${r} ${r} 0 ${big} 1 ${cx + r * Math.cos(w.a1)} ${cy + r * Math.sin(w.a1)}` }, svg);
  }
  // 12 o'clock: where history starts and now ends
  svgEl(doc, 'line', { class: 'git-noon', x1: cx, y1: cy - r0 + 4, x2: cx, y2: cy - r1 - 4 }, svg);
  const firstDay = tree.branches.map(b => shortDay(b.when)).find(Boolean);
  if (firstDay) svgEl(doc, 'text', { class: 'git-tick', x: cx + 5, y: cy - r1 + 2 }, svg).textContent = `${firstDay} →`;
  svgEl(doc, 'text', { class: 'git-tick', x: cx - 5, y: cy - r1 + 2, 'text-anchor': 'end' }, svg).textContent = '← now';

  const labels = [];
  tree.branches.forEach((b, i) => {
    const s = spokes[i];
    // gh unknown: a live lane may have an open PR, so it isn't colored "no PR" (Dexter F3)
    const prUnknown = b.state === 'unmerged' && tree.prsKnown === false;
    const cls = ['git-spoke', b.state, prUnknown ? 'pr-unknown' : '', b.name === tree.current ? 'current' : '', b.place]
      .filter(Boolean).join(' ');
    const g = svgEl(doc, 'g', { class: cls, tabindex: '0', 'data-name': b.name,
      'aria-label': `${b.name}${b.why ? `: ${b.why}` : ''}` }, svg);
    const d = `M${s.x0} ${s.y0} L${s.x1} ${s.y1}`;
    svgEl(doc, 'path', { class: s.dashed ? 'git-stem dashed' : 'git-stem', d, 'stroke-width': s.width }, g);
    svgEl(doc, 'path', { class: 'git-hit', d }, g);
    if (b.name === tree.current) svgEl(doc, 'circle', { class: 'git-here', cx: s.x1, cy: s.y1, r: s.tipR + 6 }, g);
    // unknown spend: the tip says "unknown" too, like the stem, not "no runs" (Dexter F7)
    const tipCls = s.dashed ? 'git-tip unknown' : b.runs ? 'git-tip' : 'git-tip empty';
    if (b.place === 'dev') {
      svgEl(doc, 'circle', { class: tipCls, cx: s.x1, cy: s.y1, r: s.tipR }, g);
    } else {
      const z = s.tipR * 1.8;
      svgEl(doc, 'rect', { class: tipCls, x: s.x1 - z / 2, y: s.y1 - z / 2, width: z, height: z, rx: 1.5 }, g);
      if (b.place === 'worktree') svgEl(doc, 'rect', { class: 'git-ring', x: s.x1 - z / 2 - 3, y: s.y1 - z / 2 - 3, width: z + 6, height: z + 6, rx: 3 }, g);
    }
    svgEl(doc, 'circle', { class: 'git-hit', cx: s.x1, cy: s.y1, r: Math.max(9, s.tipR + 4) }, g);
    if (b.state === 'open' || prUnknown || b.name === tree.current || b.place === 'worktree') {
      const c = Math.cos(s.angle);
      labels.push({ x: s.x1 + c * 12, y: s.y1 + Math.sin(s.angle) * 12 + 3, anchor: c >= 0 ? 'start' : 'end',
        text: (b.name === tree.current ? '▶ ' : '') + b.name.replace(/^(feat|fix)\//, '') + (b.pr && b.state !== 'merged' ? ` #${b.pr}` : ''),
        cls: `git-label ${b.state}${b.name === tree.current ? ' current' : ''}` });
    }
  });

  const hub = svgEl(doc, 'g', { class: tree.integration === tree.current ? 'git-hub current' : 'git-hub', tabindex: '0',
    'data-hub': '1', 'aria-label': tree.integration }, svg);
  svgEl(doc, 'circle', { cx, cy, r: r0 - 18 }, hub);
  svgEl(doc, 'text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'git-hub-name' }, hub).textContent = tree.integration;
  svgEl(doc, 'text', { x: cx, y: cy + 12, 'text-anchor': 'middle', class: 'git-hub-sum' }, hub).textContent =
    isNum(tree.totalSpend) ? fmtTokens(tree.totalSpend) : '?';

  for (const l of labels) {
    // keep it inside the dial: a mono glyph is ~0.6em wide at 10px
    const w = l.text.length * 6;
    let { x, anchor } = l;
    if (anchor === 'end' && x - w < 4) { anchor = 'start'; x = 4; }
    if (anchor === 'start' && x + w > DIAL.width - 4) { anchor = 'end'; x = DIAL.width - 4; }
    svgEl(doc, 'text', { class: l.cls, x, y: l.y, 'text-anchor': anchor }, svg).textContent = l.text;
  }

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

  // Put back what the person was doing (Dexter F1): the pinned card where it was, and the focus.
  if (st.pinned !== null) {
    const g = st.pinned === HUB || st.byName.has(st.pinned) ? elementFor(dial, st.pinned) : null;
    if (g) {
      // where the card was (placeCard adds 12 to the point it is given), else beside its spoke
      const [x, y] = cardAt ? [cardAt.left - 12, cardAt.top - 12] : centerOf(g);
      show(dial, st.pinned, x, y, true);
    } else {
      st.pinned = null;
    }
  }
  if (focusedKey === 'jump') {
    const btn = dial.querySelector('.git-card-jump');
    if (btn) btn.focus();
  } else if (focusedKey !== null) {
    const g = elementFor(dial, focusedKey);
    if (g) g.focus({ preventScroll: true });
  }
}

const api = { render, cardModel, hubCard, footer, fmtTokens };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.gitRingsDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
