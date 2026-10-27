'use strict';
/**
 * The rail's three groups (chrome grammar, Ricardo's picks 2026-10-26): Work, Repo, Me, a separator between them. Pure: the dock
 * (app/dock-tree-display.js) draws what groupRail returns. The layout's own order is untouched (a saved layout names the same ids);
 * only the order the buttons are DRAWN in is grouped.
 *
 * The reader is a Repo item in the picks but is no rail module (it opens from the Files tab), so it has no entry here.
 * Map and Schedules were not in the picks: Map follows Resources in Work (open question for Ricardo), Schedules follows Map.
 *
 * WRAPPED IN AN IIFE: renderer.html loads these as plain <script> tags sharing ONE global scope (test/renderer-scope.test.js).
 */
(function (root) {

const GROUPS = [
  { name: 'Work', ids: ['agents', 'git', 'fog', 'resources', 'map', 'schedules'] },
  { name: 'Repo', ids: ['ask', 'changes', 'preview'] },
  { name: 'Me', ids: ['style', 'vault', 'wand', 'games', 'models', 'projects', 'bugvault', 'canvas'] },
];

/** The group an id belongs to; an id nobody listed is Me's (the last group), so a new module still shows. */
function groupOf(id) {
  const g = GROUPS.find(x => x.ids.includes(id));
  return g ? g.name : GROUPS[GROUPS.length - 1].name;
}

/**
 * `ids` (a rail's modules) -> [{ id } | { sep: true }]: grouped, each group in the order above (unlisted ids last, in the order given),
 * one separator between two non-empty groups and none at either end. Anything that is not a non-empty string is dropped.
 */
function groupRail(ids) {
  const list = Array.isArray(ids) ? ids.filter(i => typeof i === 'string' && i !== '') : [];
  const out = [];
  GROUPS.forEach((g, gi) => {
    const last = gi === GROUPS.length - 1;
    const mine = list.filter(i => (last ? groupOf(i) === g.name : g.ids.includes(i)));
    const ordered = mine.filter(i => g.ids.includes(i)).sort((a, b) => g.ids.indexOf(a) - g.ids.indexOf(b));
    const leftover = mine.filter(i => !g.ids.includes(i));
    const part = [...ordered, ...leftover];
    if (!part.length) return;
    if (out.length) out.push({ sep: true });
    for (const id of part) out.push({ id });
  });
  return out;
}

const API = { GROUPS, groupOf, groupRail };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.railGroups = API;

})(typeof window !== 'undefined' ? window : globalThis);
