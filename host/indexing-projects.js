'use strict';
/**
 * Which projects the indexing field's chip offers (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md pick 2: the
 * selected tab's project is the default, and a click on the chip switches project).
 *
 *   projectChoices({ current, recents, projectOf, labelOf, hasBacklog }) -> [{ root, label, current }]
 *       this window's project first (always, backlog or not: a note there says why it waits), then the recent projects
 *       that have a backlog to file into, once each by root, at most MAX_CHOICES. Pure.
 *   readRecentsOffThread({ projectsDir }) -> Promise<recents | null>
 *       host/recent.js's list, read in a worker: it scans transcripts and took 2.7 s cold on this machine, which on
 *       Electron main would freeze the window. null when it failed (not "no projects").
 */

const path = require('path');
const { normPath } = require('./project-layout');

const MAX_CHOICES = 10;

function projectChoices({ current, recents, projectOf, labelOf, hasBacklog }) {
  const out = [];
  const seen = new Set();
  const add = (root, isCurrent) => {
    const key = normPath(root);
    if (key === null || seen.has(key) || out.length >= MAX_CHOICES) return;
    seen.add(key);
    out.push({ root, label: labelOf(root), current: isCurrent });
  };
  add(current, true);
  for (const r of Array.isArray(recents) ? recents : []) {
    if (!r || r.approximate === true || typeof r.path !== 'string') continue;
    try {
      const p = projectOf(r.path);
      if (p && typeof p.root === 'string' && !seen.has(normPath(p.root)) && hasBacklog(p)) add(p.root, false);
    } catch { /* that one is skipped */ }
  }
  return out;
}

function readRecentsOffThread({ projectsDir } = {}) {
  return new Promise((resolve) => {
    let Worker;
    try { ({ Worker } = require('worker_threads')); } catch { resolve(null); return; }
    const code = `
      const { parentPort, workerData } = require('worker_threads');
      const { listRecentProjects } = require(workerData.recent);
      try { parentPort.postMessage(listRecentProjects({ projectsDir: workerData.projectsDir || undefined, limit: 20 })); }
      catch { parentPort.postMessage(null); }`;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(Array.isArray(v) ? v : null); } };
    try {
      const w = new Worker(code, { eval: true, workerData: { recent: path.join(__dirname, 'recent.js'), projectsDir: projectsDir || null } });
      w.once('message', finish);
      w.once('error', () => finish(null));
      w.once('exit', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

module.exports = { projectChoices, readRecentsOffThread, MAX_CHOICES };
