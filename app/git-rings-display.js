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
 * textContent: branch names and PR titles are data.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitRingsDisplay`.
 */
(function (root) {

const rings = typeof module !== 'undefined' && module.exports ? require('./git-rings') : root.gitRings;
const SVG = 'http://www.w3.org/2000/svg';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PEOPLE_SHOWN = 4;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function fmtTokens(n) {
  if (!isNum(n)) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function shortDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d\d-\d\d/.test(day)) return null;
  const [, m, d] = day.slice(0, 10).split('-');
  return `${MON[Number(m) - 1]} ${Number(d)}`;
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
  const sum = [
    isNum(b.spend) ? `${fmtTokens(b.spend)} tokens` : 'no token record',
    b.commits ? `${b.commits} commit${b.commits === 1 ? '' : 's'}` : null,
    shortDay(b.when),
    PLACE[b.place] || null,
  ].filter(Boolean).join(' · ');
  return {
    title: (b.name === current ? '▶ ' : '') + b.name, kind, why, whyMissing, sum,
    ...peopleLines(b.people),
    jump: b.place === 'worktree' && typeof b.folder === 'string' && b.folder !== '',
  };
}

function hubCard(tree) {
  const spend = tree.hub && tree.hub.spend;
  const sum = [isNum(spend) ? `${fmtTokens(spend)} tokens` : 'no token record',
    isNum(tree.mainMerges) ? `main has ${tree.mainMerges} merges` : null].filter(Boolean).join(' · ');
  return {
    title: (tree.integration === tree.current ? '▶ ' : '') + tree.integration, kind: 'integration branch',
    why: 'Every lane merges here before it goes to main.', whyMissing: false, sum,
    ...peopleLines(tree.hub && tree.hub.people), jump: false,
  };
}

function footer(tree) {
  const count = s => tree.branches.filter(b => b.state === s).length;
  return {
    line1: `${tree.branches.length} branches · ${isNum(tree.totalSpend) ? `${fmtTokens(tree.totalSpend)} tokens` : 'no token record yet'}`,
    line2: `${count('merged')} merged · ${count('open')} open · ${count('unmerged')} unmerged · ${count('deleted')} deleted`,
    main: isNum(tree.mainMerges) ? `main · ${tree.mainMerges} merges` : null,
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

function fillCard(card, m, { pinned, onJump }) {
  const doc = card.ownerDocument;
  card.textContent = '';
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
  if (pinned && m.jump && onJump) {
    const btn = el(doc, 'button', { type: 'button', class: 'git-card-jump' }, card);
    btn.textContent = 'Jump to its tab';
    const said = el(doc, 'div', { class: 'git-card-said' }, card);
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const r = await onJump();
      if (r && r.kind === 'explain') said.textContent = r.text;
    });
  }
}

/**
 * Draws `tree` into the panel. `rootEl` holds #git-status and #git-dial. deps.onJump(folder) ->
 * Promise<{ kind, text? }>. Returns nothing; every redraw replaces the last one.
 */
function render(rootEl, tree, { onJump } = {}) {
  const doc = rootEl.ownerDocument;
  const status = rootEl.querySelector('#git-status');
  const dial = rootEl.querySelector('#git-dial');
  dial.textContent = '';
  if (!tree || !tree.ok) {
    status.textContent = `Can't read this repo's history: ${(tree && tree.error) || 'no answer'}`;
    return;
  }
  status.textContent = tree.ledgerOk === false ? 'Some transcripts could not be read, so some spend may be missing.' : '';

  const { DIAL } = rings;
  const { spokes, weeks } = rings.layout(tree.branches);
  const { cx, cy, r0, r1 } = DIAL;
  const svg = svgEl(doc, 'svg', { viewBox: `0 0 ${DIAL.width} ${DIAL.height}`, class: 'git-svg', role: 'img',
    'aria-label': `${tree.branches.length} branches of this project` }, dial);

  for (const w of weeks) {
    const r = r0 - 9;
    const big = w.a1 - w.a0 > Math.PI ? 1 : 0;
    svgEl(doc, 'path', { class: w.alt ? 'git-week alt' : 'git-week',
      d: `M${cx + r * Math.cos(w.a0)} ${cy + r * Math.sin(w.a0)} A${r} ${r} 0 ${big} 1 ${cx + r * Math.cos(w.a1)} ${cy + r * Math.sin(w.a1)}` }, svg);
  }
  // 12 o'clock: where history starts and now ends
  svgEl(doc, 'line', { class: 'git-noon', x1: cx, y1: cy - r0 + 4, x2: cx, y2: cy - r1 - 4 }, svg);
  const first = tree.branches.find(b => b.when);
  if (first) svgEl(doc, 'text', { class: 'git-tick', x: cx + 5, y: cy - r1 + 2 }, svg).textContent = `${shortDay(first.when)} →`;
  svgEl(doc, 'text', { class: 'git-tick', x: cx - 5, y: cy - r1 + 2, 'text-anchor': 'end' }, svg).textContent = '← now';

  const card = el(doc, 'div', { class: 'git-card', hidden: '' }, dial);
  let pinned = null;
  const show = (m, x, y, isPinned, jump) => {
    fillCard(card, m, { pinned: isPinned, onJump: jump });
    card.hidden = false;
    card.classList.toggle('pinned', isPinned);
    const box = dial.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    card.style.left = `${Math.max(4, Math.min(x - box.left + 12, box.width - w - 4))}px`;
    card.style.top = `${Math.max(4, Math.min(y - box.top + 12, box.height - h - 4))}px`;
  };
  const hide = () => { if (!pinned) card.hidden = true; };
  const hook = (g, model, jump) => {
    g.setAttribute('tabindex', '0');
    g.addEventListener('mouseenter', e => { if (!pinned) show(model(), e.clientX, e.clientY, false); });
    g.addEventListener('mousemove', e => { if (!pinned) show(model(), e.clientX, e.clientY, false); });
    g.addEventListener('mouseleave', hide);
    g.addEventListener('focus', () => { if (!pinned) { const r = g.getBoundingClientRect(); show(model(), r.right, r.bottom, false); } });
    g.addEventListener('blur', hide);
    const pin = (x, y) => {
      pinned = pinned === g ? null : g;
      if (pinned) show(model(), x, y, true, jump); else card.hidden = true;
    };
    g.addEventListener('click', e => { e.stopPropagation(); pin(e.clientX, e.clientY); });
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const r = g.getBoundingClientRect(); pin(r.right, r.bottom); }
      if (e.key === 'Escape') { pinned = null; card.hidden = true; }
    });
  };
  dial.addEventListener('click', e => { if (!card.contains(e.target)) { pinned = null; card.hidden = true; } });

  const labels = [];
  tree.branches.forEach((b, i) => {
    const s = spokes[i];
    const cls = ['git-spoke', b.state, b.name === tree.current ? 'current' : '', b.place].filter(Boolean).join(' ');
    const g = svgEl(doc, 'g', { class: cls, 'data-name': b.name, 'aria-label': `${b.name}${b.why ? `: ${b.why}` : ''}` }, svg);
    const d = `M${s.x0} ${s.y0} L${s.x1} ${s.y1}`;
    svgEl(doc, 'path', { class: s.dashed ? 'git-stem dashed' : 'git-stem', d, 'stroke-width': s.width }, g);
    svgEl(doc, 'path', { class: 'git-hit', d }, g);
    if (b.name === tree.current) svgEl(doc, 'circle', { class: 'git-here', cx: s.x1, cy: s.y1, r: s.tipR + 6 }, g);
    if (b.place === 'dev') {
      svgEl(doc, 'circle', { class: b.runs ? 'git-tip' : 'git-tip empty', cx: s.x1, cy: s.y1, r: s.tipR }, g);
    } else {
      const z = s.tipR * 1.8;
      svgEl(doc, 'rect', { class: b.runs ? 'git-tip' : 'git-tip empty', x: s.x1 - z / 2, y: s.y1 - z / 2, width: z, height: z, rx: 1.5 }, g);
      if (b.place === 'worktree') svgEl(doc, 'rect', { class: 'git-ring', x: s.x1 - z / 2 - 3, y: s.y1 - z / 2 - 3, width: z + 6, height: z + 6, rx: 3 }, g);
    }
    svgEl(doc, 'circle', { class: 'git-hit', cx: s.x1, cy: s.y1, r: Math.max(9, s.tipR + 4) }, g);
    const jump = b.place === 'worktree' && b.folder && onJump ? () => onJump(b.folder) : null;
    hook(g, () => cardModel(b, { current: tree.current, prsKnown: tree.prsKnown }), jump);
    if (b.state === 'open' || b.name === tree.current || b.place === 'worktree') {
      const c = Math.cos(s.angle);
      labels.push({ x: s.x1 + c * 12, y: s.y1 + Math.sin(s.angle) * 12 + 3, anchor: c >= 0 ? 'start' : 'end',
        text: (b.name === tree.current ? '▶ ' : '') + b.name.replace(/^(feat|fix)\//, '') + (b.pr && b.state !== 'merged' ? ` #${b.pr}` : ''),
        cls: `git-label ${b.state}${b.name === tree.current ? ' current' : ''}` });
    }
  });

  const hub = svgEl(doc, 'g', { class: tree.integration === tree.current ? 'git-hub current' : 'git-hub', 'aria-label': tree.integration }, svg);
  svgEl(doc, 'circle', { cx, cy, r: r0 - 18 }, hub);
  svgEl(doc, 'text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'git-hub-name' }, hub).textContent = tree.integration;
  svgEl(doc, 'text', { x: cx, y: cy + 12, 'text-anchor': 'middle', class: 'git-hub-sum' }, hub).textContent =
    isNum(tree.totalSpend) ? fmtTokens(tree.totalSpend) : '?';
  hook(hub, () => hubCard(tree), null);

  for (const l of labels) {
    // keep it inside the dial: a mono glyph is ~0.6em wide at 10px
    const w = l.text.length * 6;
    let { x, anchor } = l;
    if (anchor === 'end' && x - w < 4) { anchor = 'start'; x = 4; }
    if (anchor === 'start' && x + w > DIAL.width - 4) { anchor = 'end'; x = DIAL.width - 4; }
    svgEl(doc, 'text', { class: l.cls, x, y: l.y, 'text-anchor': anchor }, svg).textContent = l.text;
  }

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
}

const api = { render, cardModel, hubCard, footer, fmtTokens };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.gitRingsDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
