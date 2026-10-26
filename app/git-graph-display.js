'use strict';
/**
 * The Git panel's "Graph" view (BACKLOG #2 follow-up; Ricardo's pick A, "lanes and commits",
 * documentation/DESIGN_ROUND_2026-10-09B.md round 9): a column per lane, a dot per commit, merges as curves,
 * the message beside each commit. The last 50 commits of develop, main and the open branches, newest on top.
 *
 *   render(rootEl, graph, { tree, tabs, onJump, onOpenUrl, onCopy })
 *                              draws the host's `git-graph` answer into #git-graph
 *   geometry(graph)            { width, height, nodes, edges }: where every dot sits and the path of every edge
 *   commitModel(commit, { tree, tab })   what the detail strip says and which actions it offers
 *   readView / writeView / viewKey       the Rings|Graph choice, remembered per project
 *
 * READ-ONLY and STILL: no animation, no timer, no observer, no requestAnimationFrame. The renderer re-asks
 * every 30 s while this view shows; an answer identical to the last one draws nothing. Clicking (or Enter on) a
 * commit opens a detail strip: Open commit on GitHub, Jump to its tab (when the commit is the tip of a branch
 * with an open worktree), Copy hash. Colours come from the theme through CSS classes (renderer.html `.gg-*`);
 * every text is set with textContent: subjects and branch names are data.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitGraphDisplay`.
 */
(function (root) {

const isNode = typeof module !== 'undefined' && module.exports;
const actionsLib = isNode ? require('./git-actions') : root.gitActions;
const SVG = 'http://www.w3.org/2000/svg';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ROW_H = 24;
const LANE_W = 14;
const PAD = 10;
const DOT_R = 4;
const LANE_COLOURS = 6;   // .gg-l0 .. .gg-l5 in renderer.html

// ---------- the ask ----------

const NEEDS_NEWER = 'The graph needs a newer session: restart this tab.';

/**
 * The page's ask for the graph. Hosts outlive windows, so a new page can attach to a host that doesn't list
 * `git-graph` in its hello: that host would TYPE the frame into the session. So nothing is sent until the hello says
 * the host accepts it (the check app/repo-requester.js makes for `repo`). `ask()` -> { sent, note }: `note` is what the
 * panel should say when the host is too old; before the hello arrives it is not known, so nothing is sent or said.
 */
function createAsker(send) {
  let controls = null;
  return {
    setControls(list) { controls = list; },
    // a dropped socket forgets what its host accepted: the next one may be an older host
    forget() { controls = null; },
    ask() {
      if (!Array.isArray(controls)) return { sent: false, note: null };
      if (!controls.includes('git-graph')) return { sent: false, note: NEEDS_NEWER };
      return { sent: send('{"type":"git-graph"}') === true, note: null };
    },
  };
}

// ---------- the view choice ----------

const VIEWS = ['rings', 'graph'];
const viewKey = project => `gitView:${typeof project === 'string' ? project : ''}`;
const normalizeView = v => (VIEWS.includes(v) ? v : 'rings');

function readView(storage, project) {
  try { return normalizeView(storage && storage.getItem(viewKey(project))); } catch { return 'rings'; }
}
function writeView(storage, project, view) {
  try { if (storage) storage.setItem(viewKey(project), normalizeView(view)); } catch { /* the choice just isn't remembered */ }
}

/**
 * The first tree answer names the project, which can be after the person already pressed a button: what they chose
 * wins (and is saved for the project); otherwise the project's saved view applies.
 */
function adoptView({ chosen, current, saved }) {
  return chosen ? { view: normalizeView(current), persist: true } : { view: normalizeView(saved), persist: false };
}

// ---------- geometry ----------

const laneX = lane => PAD + lane * LANE_W;
const rowY = row => row * ROW_H + ROW_H / 2;

// A smooth step between two points one row (or more) apart; straight when the x's agree.
function step(x0, y0, x1, y1) {
  if (x0 === x1) return `L${x1} ${y1}`;
  const mid = (y0 + y1) / 2;
  return `C${x0} ${mid} ${x1} ${mid} ${x1} ${y1}`;
}

/**
 * One edge from the commit at `row`: it bends into its parent's lane in the first row gap, runs straight down it, and
 * ends at the parent. A parent outside the window runs off the bottom.
 */
function edgePath(edge, row, lane, rows) {
  const x0 = laneX(lane);
  const y0 = rowY(row);
  const x1 = laneX(edge.lane);
  if (edge.row === null) {
    const bottom = rows * ROW_H;
    return `M${x0} ${y0} ${step(x0, y0, x1, Math.min(y0 + ROW_H, bottom))} L${x1} ${bottom}`;
  }
  const y1 = rowY(edge.row);
  if (edge.row === row + 1) return `M${x0} ${y0} ${step(x0, y0, x1, y1)}`;
  return `M${x0} ${y0} ${step(x0, y0, x1, y0 + ROW_H)} L${x1} ${y1}`;
}

/** graph -> { width, height, nodes: [{ hash, x, y, lane, merge }], edges: [{ d, lane, merge }] } */
function geometry(graph) {
  const commits = graph && Array.isArray(graph.commits) ? graph.commits : [];
  const laneCount = graph && Number.isInteger(graph.laneCount) ? graph.laneCount : 0;
  const rows = commits.length;
  const nodes = commits.map((c, i) => ({ hash: c.hash, x: laneX(c.lane), y: rowY(i), lane: c.lane, merge: c.parents.length > 1 }));
  const edges = [];
  commits.forEach((c, i) => {
    for (const e of c.edges) edges.push({ d: edgePath(e, i, c.lane, rows), lane: e.lane, merge: e.merge });
  });
  return { width: PAD * 2 + Math.max(0, laneCount - 1) * LANE_W, height: rows * ROW_H, nodes, edges };
}

// ---------- what the detail strip says ----------

function dayOf(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null;
  const d = new Date(time * 1000);
  return Number.isNaN(d.getTime()) ? null : `${MON[d.getMonth()]} ${d.getDate()}`;
}

/** The tree's branch whose tip this commit is (a local ref on it), preferring one with an open worktree. */
function branchAt(commit, tree) {
  const branches = tree && Array.isArray(tree.branches) ? tree.branches : [];
  const mine = (commit.refs || []).filter(x => !x.remote).map(x => branches.find(b => b.name === x.name)).filter(Boolean);
  return mine.find(b => b.place === 'worktree') || mine[0] || null;
}

function openCommit(commit, tree) {
  const label = 'Open commit on GitHub';
  const t = tree && tree.ok ? tree : null;
  if (!t) return { id: 'open-commit', label, enabled: false, why: "the branch list hasn't loaded yet" };
  if (typeof t.repoUrl === 'string' && t.repoUrl) {
    // `pushed` is false only when git said no remote reaches it; unknown (null, absent) is not "no"
    if (commit && commit.pushed === false) return { id: 'open-commit', label, enabled: false, why: 'not pushed to GitHub yet' };
    return { id: 'open-commit', label, enabled: true, why: null };
  }
  if (typeof t.originHost === 'string' && t.originHost) {
    return { id: 'open-commit', label, enabled: false, why: `origin points at ${t.originHost}, not a github.com address it can open` };
  }
  return { id: 'open-commit', label, enabled: false, why: 'no GitHub remote ("origin") to open it on' };
}

function jumpAction(commit, tree, tab) {
  const label = 'Jump to its tab';
  const b = branchAt(commit, tree);
  if (!b) return { id: 'jump', label, enabled: false, why: 'not the tip of a branch with an open worktree' };
  const a = actionsLib.actionsFor(b, { prsKnown: tree.prsKnown, tab }).find(x => x.id === 'jump');
  return { id: 'jump', label, enabled: a.enabled, why: a.why };
}

function commitModel(commit, { tree = null, tab = null } = {}) {
  const c = commit || {};
  const parents = Array.isArray(c.parents) ? c.parents : [];
  const refs = (Array.isArray(c.refs) ? c.refs : []).map(x => x.name);
  const meta = [
    typeof c.hash === 'string' ? c.hash.slice(0, 7) : null,
    c.author || null,
    dayOf(c.time) || 'unknown date',
    parents.length > 1 ? `merge of ${parents.length} parents` : null,
  ].filter(Boolean).join(' · ');
  return {
    title: c.subject ? c.subject : '(no message)',
    meta, refs,
    actions: [openCommit(c, tree), jumpAction(c, tree, tab), { id: 'copy', label: 'Copy hash', enabled: true, why: null }],
  };
}

/** The URL the Open action goes to, or null (never built from anything but the repo's URL and a hex hash). */
function commitLink(commit, tree) {
  const repo = tree && tree.ok && typeof tree.repoUrl === 'string' ? tree.repoUrl : null;
  const hash = commit && typeof commit.hash === 'string' ? commit.hash : '';
  return repo && /^[0-9a-f]{7,64}$/i.test(hash) ? `${repo}/commit/${hash}` : null;
}

// ---------- the DOM ----------

function el(doc, tag, attrs, parent, ns) {
  const e = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const svgEl = (doc, tag, attrs, parent) => el(doc, tag, attrs, parent, SVG);
const colour = lane => `gg-l${lane % LANE_COLOURS}`;

function stateOf(graphEl) {
  if (!graphEl.ggState) {
    graphEl.ggState = { key: null, graph: null, byHash: new Map(), selected: null, tree: null, tabs: new Map(),
      wired: 0, renders: 0, said: null, busy: new Set(), onJump: null, onOpenUrl: null, onCopy: null };
  }
  return graphEl.ggState;
}

const rowOf = (graphEl, target) => {
  const r = target && target.closest ? target.closest('.gg-row') : null;
  return r && graphEl.contains(r) ? r : null;
};

function tabFor(st, commit) {
  const b = branchAt(commit, st.tree);
  return b && typeof b.folder === 'string' ? st.tabs.get(b.folder) || null : null;
}

function fillDetail(graphEl) {
  const st = stateOf(graphEl);
  const detail = graphEl.querySelector('.gg-detail');
  const commit = st.selected !== null ? st.byHash.get(st.selected) : null;
  if (!detail) return;
  if (!commit) { detail.hidden = true; detail.textContent = ''; return; }
  const doc = detail.ownerDocument;
  const m = commitModel(commit, { tree: st.tree, tab: tabFor(st, commit) });
  detail.textContent = '';
  detail.hidden = false;
  detail.setAttribute('aria-label', `Commit ${commit.hash.slice(0, 7)}: details and actions`);
  el(doc, 'div', { class: 'gg-detail-title' }, detail).textContent = m.title;
  el(doc, 'div', { class: 'gg-detail-meta' }, detail).textContent = m.meta;
  if (m.refs.length) el(doc, 'div', { class: 'gg-detail-refs' }, detail).textContent = m.refs.join(', ');
  const acts = el(doc, 'div', { class: 'git-acts' }, detail);
  for (const a of m.actions) {
    const row = el(doc, 'div', { class: 'git-act-row' }, acts);
    const btn = el(doc, 'button', { type: 'button', class: `git-act ${a.id}`, 'data-act': a.id, 'aria-disabled': a.enabled ? 'false' : 'true' }, row);
    btn.textContent = a.label;
    if (!a.enabled) {
      const why = el(doc, 'span', { class: 'git-act-why', id: `gg-act-why-${a.id}` }, row);
      why.textContent = a.why;
      btn.setAttribute('aria-describedby', why.id);
    }
  }
  syncSaid(st);
}

function syncSaid(st) {
  const node = st.saidEl;
  if (!node) return;
  const want = st.said && st.selected !== null && st.said.hash === st.selected ? st.said.text : '';
  if (node.textContent !== want) node.textContent = want;
}

function select(graphEl, hash) {
  const st = stateOf(graphEl);
  st.said = null;
  st.selected = hash;
  for (const r of graphEl.querySelectorAll('.gg-row')) r.classList.toggle('sel', r.getAttribute('data-hash') === hash);
  fillDetail(graphEl);
}

const errText = err => (err && err.message) || String(err);

async function act(graphEl, id) {
  const st = stateOf(graphEl);
  const hash = st.selected;
  const commit = hash !== null ? st.byHash.get(hash) : null;
  if (!commit) return;
  const a = commitModel(commit, { tree: st.tree, tab: tabFor(st, commit) }).actions.find(x => x.id === id);
  if (!a || !a.enabled) return;
  const busyKey = `${hash}\u0000${id}`;
  if (st.busy.has(busyKey)) return;
  st.busy.add(busyKey);
  const say = text => { st.said = { hash, text }; syncSaid(st); };
  try {
    if (id === 'open-commit') {
      const url = commitLink(commit, st.tree);
      if (!url || !st.onOpenUrl) return say("Can't open a browser from here.");
      say((await st.onOpenUrl(url)) ? `Opened ${hash.slice(0, 7)} in your browser.` : "Couldn't open the browser.");
    } else if (id === 'jump') {
      const b = branchAt(commit, st.tree);
      if (!b || !b.folder || !st.onJump) return;
      const r = await st.onJump(b.folder);
      if (r && r.kind === 'explain') say(r.text);
    } else if (id === 'copy') {
      if (!st.onCopy) return say("Can't copy from here.");
      await st.onCopy(hash);
      say(`Copied ${hash.slice(0, 7)}.`);
    }
  } catch (err) {
    say(`Couldn't do that: ${errText(err)}`);
  } finally {
    st.busy.delete(busyKey);
  }
}

// ONCE per element: events are found by delegation, so a redraw never adds a listener.
function wire(graphEl) {
  const st = stateOf(graphEl);
  if (st.wired) return;
  st.wired += 1;
  graphEl.addEventListener('click', e => {
    const btn = e.target.closest ? e.target.closest('.git-act') : null;
    if (btn) { act(graphEl, btn.getAttribute('data-act')); return; }
    if (e.target.closest && e.target.closest('.gg-detail')) return;
    const row = rowOf(graphEl, e.target);
    if (!row) return;
    const hash = row.getAttribute('data-hash');
    if (st.selected === hash) select(graphEl, null); else select(graphEl, hash);
  });
  graphEl.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.selected !== null) {
      e.preventDefault();
      const was = st.selected;
      select(graphEl, null);
      const r = [...graphEl.querySelectorAll('.gg-row')].find(x => x.getAttribute('data-hash') === was);
      if (r) r.focus();
      return;
    }
    const row = rowOf(graphEl, e.target);
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const hash = row.getAttribute('data-hash');
      select(graphEl, st.selected === hash ? null : hash);
      return;
    }
    const delta = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const rows = [...graphEl.querySelectorAll('.gg-row')];
    const next = rows[rows.indexOf(row) + delta];
    if (next) next.focus();
  });
}

/**
 * What changes the drawing: the graph, and the little of the tree and the tabs the strip reads. The strip reads a
 * branch's name, place and folder, the repo's address, and whether the branch's worktree tab is open: not a branch's
 * state or PR, and not what a tab is doing (those change every few seconds).
 */
function keyOf(graph, tree, tabs) {
  const open = new Map((Array.isArray(tabs) ? tabs : []).filter(t => t && typeof t.folder === 'string').map(t => [t.folder, t.open]));
  const t = tree && tree.ok ? { repoUrl: tree.repoUrl || null, originHost: tree.originHost || null,
    branches: (tree.branches || []).map(b => [b.name, b.place, b.folder || null, typeof b.folder === 'string' && open.has(b.folder) ? open.get(b.folder) : null]) } : null;
  return JSON.stringify([graph === undefined ? null : graph, t]);
}

/**
 * Draws `graph` (the host's `git-graph` answer) into `#git-graph` under `rootEl` (its message goes to #git-graph-status). `tree` is the host's last
 * `git-tree` answer (for the GitHub address and the branches' worktrees); `tabs` is the shell's tab states or
 * null. Handlers: onOpenUrl(url) -> Promise<boolean>, onJump(folder) -> Promise<{ kind, text }|null>,
 * onCopy(text) -> Promise. A failed or unknown answer says so in #git-status; it never draws a guess.
 */
function render(rootEl, graph, { tree = null, tabs = null, onJump, onOpenUrl, onCopy } = {}) {
  const doc = rootEl.ownerDocument;
  const graphEl = rootEl.querySelector('#git-graph');
  const status = rootEl.querySelector('#git-graph-status');
  const st = stateOf(graphEl);
  st.onJump = onJump || null;
  st.onOpenUrl = onOpenUrl || null;
  st.onCopy = onCopy || null;
  if (!st.saidEl || !st.saidEl.isConnected) {
    st.saidEl = el(doc, 'div', { class: 'gg-said', role: 'status', 'aria-live': 'polite' }, graphEl);
  }
  if (!st.bodyEl || !st.bodyEl.isConnected) st.bodyEl = el(doc, 'div', { class: 'gg-body' }, graphEl);
  const body = st.bodyEl;
  const key = keyOf(graph, tree, tabs);
  if (key === st.key) return;
  st.key = key;
  st.renders += 1;
  wire(graphEl);
  st.tree = tree && tree.ok ? tree : null;
  st.tabs = new Map((Array.isArray(tabs) ? tabs : []).filter(t => t && typeof t.folder === 'string').map(t => [t.folder, t]));

  // the scroll position is the person's: a redraw puts it back
  const was = body.querySelector('.gg-scroll');
  const scrollTop = was ? was.scrollTop : 0;
  const at = doc.activeElement && graphEl.contains(doc.activeElement) && doc.activeElement.getAttribute ? doc.activeElement : null;
  const focusedAct = at ? at.getAttribute('data-act') : null;
  const focused = at && !focusedAct ? at.getAttribute('data-hash') : null;

  body.textContent = '';
  if (!graph || !graph.ok || !Array.isArray(graph.commits)) {
    st.graph = null;
    st.byHash = new Map();
    st.selected = null;
    status.textContent = `Can't read this repo's commits: ${(graph && graph.error) || (graph && graph.ok ? 'no commit list in the answer' : 'no answer')}`;
    return;
  }
  status.textContent = '';
  st.graph = graph;
  st.byHash = new Map(graph.commits.map(c => [c.hash, c]));
  if (st.selected !== null && !st.byHash.has(st.selected)) st.selected = null;
  if (!graph.commits.length) {
    el(doc, 'div', { class: 'gg-empty' }, body).textContent = 'No commits yet.';
    return;
  }

  const g = geometry(graph);
  const scroll = el(doc, 'div', { class: 'gg-scroll' }, body);
  const wrap = el(doc, 'div', { class: 'gg-wrap' }, scroll);
  const svg = svgEl(doc, 'svg', { class: 'gg-svg', width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`,
    'aria-hidden': 'true', focusable: 'false' }, wrap);
  for (const e of g.edges) svgEl(doc, 'path', { class: `gg-edge ${colour(e.lane)}${e.merge ? ' merge' : ''}`, d: e.d }, svg);
  for (const n of g.nodes) {
    svgEl(doc, 'circle', { class: `gg-dot ${colour(n.lane)}${n.merge ? ' merge' : ''}`, cx: n.x, cy: n.y, r: DOT_R }, svg);
  }
  const list = el(doc, 'div', { class: 'gg-rows', role: 'list', 'aria-label': `${graph.commits.length} recent commits` }, wrap);
  graph.commits.forEach(c => {
    const row = el(doc, 'div', { class: `gg-row${st.selected === c.hash ? ' sel' : ''}`, role: 'listitem', tabindex: '0', 'data-hash': c.hash,
      'aria-label': `${c.hash.slice(0, 7)} ${c.subject || '(no message)'}` }, list);
    row.style.height = `${ROW_H}px`;
    for (const x of c.refs) el(doc, 'span', { class: `gg-ref${x.remote ? ' remote' : ''}` }, row).textContent = x.name;
    el(doc, 'span', { class: 'gg-msg' }, row).textContent = c.subject || '(no message)';
  });
  el(doc, 'aside', { class: 'gg-detail', hidden: '', tabindex: '-1', role: 'region', 'aria-label': 'Commit details' }, body);
  fillDetail(graphEl);
  scroll.scrollTop = scrollTop;
  if (focusedAct) {
    const b = [...graphEl.querySelectorAll('.git-act')].find(x => x.getAttribute('data-act') === focusedAct);
    if (b) b.focus();
  } else if (focused) {
    const r = [...graphEl.querySelectorAll('.gg-row')].find(x => x.getAttribute('data-hash') === focused);
    if (r) r.focus();
  }
}

const api = { render, geometry, commitModel, commitLink, readView, writeView, viewKey, normalizeView, adoptView, createAsker, NEEDS_NEWER, dayOf, ROW_H, LANE_W, PAD };

if (isNode) {
  module.exports = api;
} else {
  root.gitGraphDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
