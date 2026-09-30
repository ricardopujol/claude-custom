'use strict';
/**
 * A block of 100 ports per worktree: WORKTREE_PORT_BASE (Extension X3,
 * documentation/PLAN_WORKTREE_TABS.md, confirmed by Ricardo 2026-09-29).
 *
 * Bases run 20000, 20100 ... 48900: clear of the host's own range (7700-7799)
 * and below Windows' dynamic range (49152+), where the OS hands out ephemeral
 * ports. Each worktree path gets the FIRST FREE block, recorded in one
 * user-wide file (`~\.claude-custom\worktree-ports.json`) so two projects never
 * share a block and a restart keeps it. A hash of the path was rejected: stable,
 * but two paths can collide and nothing would notice.
 *
 * Blocks overlapping Windows' excluded port ranges (Hyper-V, WSL and Docker
 * reserve some, and they can change across reboots) are skipped -- and a kept
 * block that has since become excluded moves, rather than half its ports
 * failing to bind. A worktree whose folder is gone gives its block back the
 * next time anything allocates.
 *
 * Never in the way of a session: a lock it can't get or a file it can't write
 * means no block (null) and the variable is simply not set.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { withFileLock } = require('./file-lock');
const { renameWithRetry } = require('./atomic-write');
const { normPath } = require('./project-layout');

const RANGE_START = 20000;
const RANGE_LAST_BASE = 48900;       // its block ends at 48999
const BLOCK = 100;

function defaultPortsFile() {
  return path.join(os.homedir(), '.claude-custom', 'worktree-ports.json');
}

const validBase = b => Number.isInteger(b) && b >= RANGE_START && b <= RANGE_LAST_BASE && (b - RANGE_START) % BLOCK === 0;
const overlaps = (base, ranges) => ranges.some(r => r.start <= base + BLOCK - 1 && r.end >= base);

function parseExcludedRanges(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start <= end) out.push({ start, end });
  }
  return out;
}

function defaultExec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

/**
 * Windows' excluded TCP port ranges, IPv4 and IPv6 together. A query that
 * fails contributes nothing: a block that turns out to be reserved fails to
 * bind visibly, which beats refusing to allocate at all.
 */
async function excludedRanges({ exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const ask = async family => {
    try {
      return parseExcludedRanges(await exec('netsh', ['int', family, 'show', 'excludedportrange', 'protocol=tcp']));
    } catch {
      return [];
    }
  };
  // Together, not one after the other (Miguel, PR #71 Y2): each can take up
  // to its 5 s timeout, and a session's start waits on the answer.
  const [v4, v6] = await Promise.all([ask('ipv4'), ask('ipv6')]);
  const all = [...v4, ...v6];
  const seen = new Set();
  return all
    .filter(r => { const k = `${r.start}-${r.end}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

// The blocks on disk, or null when the file is there and isn't a blocks file.
function readBlocks(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1) return null;
  if (!doc.blocks || typeof doc.blocks !== 'object' || Array.isArray(doc.blocks)) return null;
  const blocks = {};
  for (const [k, v] of Object.entries(doc.blocks)) if (validBase(v)) blocks[k] = v;
  return blocks;
}

function writeBlocks(file, blocks) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, blocks }, null, 2), { flag: 'wx' });
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never renamed */ }
    throw err;
  }
}

/**
 * The port base for `worktree`, allocating one if it has none. null when no
 * block is free or the file can't be used.
 * opts: { file, excluded: [{start, end}], exists, deadlineMs }
 */
function allocate(worktree, opts = {}) {
  const key = typeof worktree === 'string' && worktree ? normPath(worktree) : null;
  if (!key) return null;
  const file = opts.file || defaultPortsFile();
  const excluded = Array.isArray(opts.excluded) ? opts.excluded : [];
  const exists = opts.exists || fs.existsSync;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withFileLock(`${file}.lock`, () => {
      let blocks = readBlocks(file);
      if (blocks === null) {
        // Set aside, never trusted and never silently overwritten: it may be
        // the only record of which worktree has which ports.
        renameWithRetry(file, `${file}.corrupt-${Date.now()}`);
        blocks = {};
      }
      const before = JSON.stringify(blocks);

      for (const k of Object.keys(blocks)) if (k !== key && !exists(k)) delete blocks[k];

      let base = blocks[key];
      if (base === undefined || overlaps(base, excluded)) {
        delete blocks[key];
        const used = new Set(Object.values(blocks));
        base = null;
        for (let b = RANGE_START; b <= RANGE_LAST_BASE; b += BLOCK) {
          if (!used.has(b) && !overlaps(b, excluded)) { base = b; break; }
        }
        if (base !== null) blocks[key] = base;
      }

      if (JSON.stringify(blocks) !== before) writeBlocks(file, blocks);
      return base;
    }, { deadlineMs: Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : undefined });
  } catch {
    return null;
  }
}

module.exports = { allocate, parseExcludedRanges, excludedRanges, defaultPortsFile, RANGE_START, RANGE_LAST_BASE, BLOCK };
