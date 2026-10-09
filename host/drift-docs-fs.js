'use strict';
/**
 * Reads a project's documentation folder for "docs drift" (BACKLOG #39 job 2). READ-ONLY: it lists and reads, it never writes,
 * renames or deletes (test/drift-service.test.js reads this file's source to check).
 *
 *   readDocsDir(dir) -> { buildLog: text | null, buildLogName: name | null, docs: [{ rel, text }] }      never throws; a missing folder is { buildLog: null, docs: [] }
 *
 * Only top-level `.md` files, no sub-folders (handoffs are working notes, not design). A file over MAX_FILE_BYTES is skipped,
 * and so is anything that is not a plain file (a link or junction could point anywhere).
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 400 * 1024;
const { isBuildLog } = require('./drift-text');

async function readDocsDir(dir) {
  const empty = { buildLog: null, buildLogName: null, docs: [] };
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return empty; }
  const out = { buildLog: null, buildLogName: null, docs: [] };
  let logTime = -Infinity;
  for (const name of names.filter(n => /\.md$/i.test(n)).sort()) {
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const text = await fs.promises.readFile(file, 'utf8');
      // Any <NAME>_BUILD_LOG.md is the build log (the newest if there are several); the rest are documents.
      if (isBuildLog(name)) {
        if (st.mtimeMs >= logTime) { logTime = st.mtimeMs; out.buildLog = text; out.buildLogName = name; }
      } else out.docs.push({ rel: name, text });
    } catch { /* unreadable now: skipped */ }
  }
  return out;
}

module.exports = { readDocsDir, MAX_FILE_BYTES };
