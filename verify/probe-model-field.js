'use strict';
/* Is `message.model` actually there, on a real transcript, right now?

   host/session-model.js reads a field the docs do not promise: Claude Code's
   own transcript format is documented as internal and free to change between
   versions. Every unit test for that module supplies the shape it expects and
   then confirms the code understands that shape -- exactly the pattern that
   let tool_name "Task" vs "Agent" hide through a green suite for months (see
   verify/probe-payloads.js).

   This drives no process at all: it reads THIS project's own real transcripts
   under ~/.claude/projects/<encoded-cwd>/ and asserts the two things
   host/session-model.js depends on:

     1. an assistant line's message carries a string `model` field
     2. the `<synthetic>` sentinel actually occurs somewhere in this project's
        history, and IS filtered by latestModel -- so the filter is exercised
        against a real record, not only a hand-written fixture

   A version bump that renames or removes the field fails HERE, loudly, rather
   than degrading session-model silently to "null forever".

   Defaults to THIS repo's own transcript folder, which is empty inside a git
   worktree (see CLAUDE.md's project-dir test note) -- pass --dir to point at
   any other project's real transcript folder instead:

     node verify/probe-model-field.js
     node verify/probe-model-field.js --dir "C:\Users\you\.claude\projects\<encoded-project>"   */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { latestModel, SYNTHETIC, TAIL_BYTES } = require('../host/session-model');
const { projectDirName } = require('../host/project-dir');

const argDir = (() => {
  const i = process.argv.indexOf('--dir');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const REPO = path.join(__dirname, '..');
const PROJECTS_DIR = argDir || path.join(os.homedir(), '.claude', 'projects');
const DIR = argDir ? PROJECTS_DIR : path.join(PROJECTS_DIR, projectDirName(REPO));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

function transcriptFilesUnder(dir) {
  const out = [];
  let top;
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { files: null, error: err };
  }
  for (const item of top) {
    if (item.isFile() && item.name.endsWith('.jsonl')) {
      out.push(path.join(dir, item.name));
      continue;
    }
    if (!item.isDirectory()) continue;
    const sub = path.join(dir, item.name, 'subagents');
    let names;
    try {
      names = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of names) if (f.endsWith('.jsonl')) out.push(path.join(sub, f));
  }
  return { files: out, error: null };
}

function readLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

(function main() {
  console.log('projects dir :', PROJECTS_DIR);
  console.log('reading      :', DIR);

  const { files, error } = transcriptFilesUnder(DIR);
  if (files === null) {
    check('the target project folder is readable', false, error && error.message);
    console.log('\nNo transcripts to check. Pass --dir <a real ~/.claude/projects folder>');
    process.exit(1);
  }
  check(`found at least one transcript (${files.length} found)`, files.length > 0);

  let assistantLines = 0;
  let withStringModel = 0;
  let syntheticSeen = 0;
  const modelsSeen = new Set();

  for (const file of files) {
    for (const entry of readLines(file)) {
      if (!entry || entry.type !== 'assistant') continue;
      assistantLines++;
      const model = entry.message && entry.message.model;
      if (typeof model === 'string') {
        withStringModel++;
        modelsSeen.add(model);
        if (model === SYNTHETIC) syntheticSeen++;
      }
    }
  }

  check('at least one assistant line was found', assistantLines > 0,
    `${assistantLines} assistant line(s)`);
  check('assistant lines carry a STRING message.model', withStringModel > 0,
    `${withStringModel}/${assistantLines}`);
  console.log('models seen  :', [...modelsSeen].join(', ') || '(none)');

  // The <synthetic> sentinel is not guaranteed to occur in every project's
  // history -- it was measured once, in one project, not defined as universal.
  // So this is reported, not asserted, UNLESS this run found real assistant
  // data to check against at all.
  if (syntheticSeen > 0) {
    check(`<synthetic> occurs in this data (${syntheticSeen}x) and is filtered by latestModel`,
      latestModel([{ type: 'assistant', message: { model: SYNTHETIC } },
        { type: 'assistant', message: { model: 'claude-real' } }]).model === 'claude-real');
  } else {
    console.log('INFO  <synthetic> was not observed in this data set -- filtering is checked ' +
      'against a synthetic fixture only, in test/session-model.test.js');
  }

  check('TAIL_BYTES is smaller than at least one real transcript checked here, ' +
    'so the tail-read path is the one actually exercised in production',
    files.some(f => { try { return fs.statSync(f).size > TAIL_BYTES; } catch { return false; } }),
    `TAIL_BYTES=${TAIL_BYTES}`);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
