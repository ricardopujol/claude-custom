'use strict';
/* How does a background shell show up for the CLI's hooks, and how old is it?   (re-runnable, offline, free)

   BACKLOG #78 follow-up. "finished" must wait for a background shell younger than 10 minutes (host/attention.js), so
   what is needed is (1) the shape of a shell in a Stop payload's `background_tasks`, and (2) where its START is. A
   real capture needs a billed `claude` run, which this probe never makes. It reads what the CLI already left here:

     1. THE SHAPE. The installed claude.exe carries the schema of a `background_tasks` entry (zod, `Xw`). Read from the
        binary itself, so it is the version that is installed, not the docs: { id, type, status, description, command?,
        agent_type?, server?, tool?, name? }, type 'shell' | 'subagent' | 'monitor' | 'workflow'. There is NO start-time
        field.
     2. THE START. Every shell's output is written to <TEMP>/claude/<project>/<session>/tasks/<id>.output, a sibling of
        the `scratchpad_dir` every hook payload carries. Compared here, for real shells this machine ran, with the
        session transcript: the file's BIRTH time against the moment the transcript says the command started (the
        tool call), and its last-write time against the completion notice. If birth ~ start and mtime ~ end, a shell's
        age is `now - birthtime`.

   Run:  node verify/probe-background-shell.js        (exit 0 = both measured and consistent; 1 = it could not observe)
         PROBE_MAX=40 raises how many shells are compared (default 25, newest first).  */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
};

// --- 1. the shape, from the installed binary ------------------------------------------------------------------------
function findExe() {
  const roots = [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')];
  return roots.find(p => fs.existsSync(p)) || null;
}

// Streams the file in 8 MiB chunks, keeping the tail so a match can't be cut by a boundary.
function grepBinary(file, needle, takeAfter) {
  const fd = fs.openSync(file, 'r');
  const CH = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CH);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CH, null);
      if (n === 0) return null;
      const hay = Buffer.concat([carry, buf.subarray(0, n)]);
      const at = hay.indexOf(needle);
      if (at >= 0 && at + takeAfter <= hay.length) return hay.subarray(Math.max(0, at - 120), at + takeAfter).toString('latin1');
      carry = hay.subarray(Math.max(0, hay.length - (takeAfter + needle.length)));
    }
  } finally { fs.closeSync(fd); }
}

function measureShape() {
  const exe = findExe();
  if (!exe) { check('the installed claude.exe was found', false, 'no npm global install under %APPDATA%'); return; }
  const text = grepBinary(exe, 'describe("Friendly task-type label', 1500);
  check('the background_tasks entry schema was read from ' + exe, !!text);
  if (!text) return;
  const field = name => new RegExp('[{,]' + name + ':').test(text);
  console.log('      ' + text.replace(/\s+/g, ' ').slice(0, 700));
  for (const f of ['id', 'type', 'status', 'description', 'command']) check(`entry has "${f}"`, field(f));
  check("entry type names 'shell'", /'shell'/.test(text));
  const startish = /\b(start|started|started_at|startedAt|created|created_at|age|elapsed|duration)\s*:/.test(text.split('Qw=')[0]);
  check('entry has NO start-time field (so the age must come from elsewhere)', !startish);
}

// --- 2. the start, from real shells this machine ran ---------------------------------------------------------------
const TMP_ROOT = path.join(os.tmpdir(), 'claude');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function shellFiles() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(TMP_ROOT); } catch { return out; }
  for (const proj of projects) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(TMP_ROOT, proj)); } catch { continue; }
    for (const sess of sessions) {
      const dir = path.join(TMP_ROOT, proj, sess, 'tasks');
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        // A shell's id starts with "b", a subagent's with "a" (measured below against the transcripts).
        if (!/^b[a-z0-9]+\.output$/.test(n)) continue;
        try { const st = fs.statSync(path.join(dir, n)); out.push({ id: n.slice(0, -7), sess, file: path.join(dir, n), birth: st.birthtimeMs, mtime: st.mtimeMs }); } catch { /* gone */ }
      }
    }
  }
  return out.sort((a, b) => b.birth - a.birth);
}

function transcriptFor(sess) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, sess + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// The two moments a transcript records for one task id: the tool result that names it (the command was moved to
// the background, or started there) and the task-notification that ends it.
async function momentsIn(file, id) {
  const m = { backgrounded: null, ended: null };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(id)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp);
    if (!Number.isFinite(t)) continue;
    const body = JSON.stringify(o.message || o.content || '');
    if (m.backgrounded === null && /moved to the background \(ID: |running in background with ID: /.test(body) && body.includes(id)) m.backgrounded = t;
    if (m.ended === null && o.type === 'user' && /<task-notification>/.test(body) && body.includes('<task-id>' + id + '</task-id>')) m.ended = t;
  }
  return m;
}

async function measureStart() {
  const max = Number(process.env.PROBE_MAX) || 25;
  const files = shellFiles();
  check('shell task-output files exist on this machine', files.length > 0, `${files.length} found under ${TMP_ROOT}`);
  const rows = [];
  for (const f of files) {
    if (rows.length >= max) break;
    const tr = transcriptFor(f.sess);
    if (!tr) continue;
    const m = await momentsIn(tr, f.id);
    if (m.backgrounded === null) continue;
    rows.push({ ...f, ...m });
  }
  check('some of them could be matched to a transcript', rows.length > 0, `${rows.length} matched`);
  const s = x => (x / 1000).toFixed(0) + 's';
  console.log('\n      id         born -> backgrounded   last write -> ended notice');
  for (const r of rows) {
    console.log(`      ${r.id.padEnd(10)} ${s(r.backgrounded - r.birth).padStart(8)}              ` +
      (r.ended === null ? '(no completion notice: stopped, or still running)' : s(r.ended - r.mtime).padStart(8)));
  }
  console.log('');
  // The file is born when the command starts. The CLI moves a command to the background after its 120 s timeout,
  // so "born -> backgrounded" is ~0 for a run_in_background command, ~120 s for one that hit the default
  // timeout, and up to ~600 s for one given the longest timeout.
  const early = rows.filter(r => r.backgrounded - r.birth >= -5000);
  check('the file is born before the transcript says the command was backgrounded (within 5 s)', rows.length > 0 && early.length === rows.length,
    `${early.length}/${rows.length}`);
  const near = rows.filter(r => r.backgrounded - r.birth <= 605000);
  check('and no more than 10 min + 5 s before it (the longest Bash timeout): birth is the START, not a later write', rows.length > 0 && near.length === rows.length,
    `${near.length}/${rows.length}`);
  const ended = rows.filter(r => r.ended !== null);
  const closed = ended.filter(r => Math.abs(r.ended - r.mtime) <= 15000);
  check('the last write is within 15 s of the completion notice (mtime marks the end)', ended.length === 0 || closed.length === ended.length,
    `${closed.length}/${ended.length}`);
}

(async () => {
  measureShape();
  await measureStart();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks held');
  process.exit(failures ? 1 : 0);
})();
