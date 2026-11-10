'use strict';
/**
 * host/continue-flag.js (BACKLOG #166; documentation/DESIGN_TABS_SESSIONS.md 3.1): does the folder have an earlier conversation for
 * `claude --continue` to pick up? MEASURED (verify/probe-continue.js tty, CLI 2.1.322): the interactive CLI with --continue and nothing
 * to continue prints "No conversation found to continue" and EXITS 1, so the host passes the flag only when the CLI's own session
 * store proves a conversation exists. Every doubt answers false (a fresh session: nothing lost but a resume, and no error screen).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasConversation } = require('../host/continue-flag');
const { projectDirName } = require('../host/project-dir');

const USER_LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd: 'x' }) + '\n';
const SNAP_LINE = JSON.stringify({ type: 'file-history-snapshot', messageId: 'm' }) + '\n';

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-continue-'));
  const cwd = path.join(root, 'proj', 'lane');
  const dir = path.join(root, '.claude', 'projects', projectDirName(cwd));
  return {
    root, cwd, dir,
    opts: { env: {}, homeDir: root },
    put(name, body) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), body); },
    done() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('no session store at all, or no folder for this project: no conversation', () => {
  const s = store();
  try {
    assert.strictEqual(hasConversation(s.cwd, s.opts), false, 'no ~/.claude/projects');
    fs.mkdirSync(path.join(s.root, '.claude', 'projects', 'C--other'), { recursive: true });
    assert.strictEqual(hasConversation(s.cwd, s.opts), false, 'projects exists, this project has no folder');
  } finally { s.done(); }
});

test('a folder with a conversation (a transcript with a user or assistant entry) is a conversation', () => {
  const s = store();
  try {
    s.put('11111111-aaaa.jsonl', USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, s.opts), true);
  } finally { s.done(); }
});

test('an empty transcript, one of only bookkeeping lines, or other files are not a conversation', () => {
  const s = store();
  try {
    s.put('a.jsonl', '');
    s.put('b.jsonl', SNAP_LINE);
    s.put('notes.txt', USER_LINE);
    s.put('c.meta.json', USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, s.opts), false);
    s.put('d.jsonl', SNAP_LINE + USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, s.opts), true, 'one real transcript among them is enough');
  } finally { s.done(); }
});

test('a subagent transcript in a sub-folder is not the folder\'s conversation', () => {
  const s = store();
  try {
    fs.mkdirSync(path.join(s.dir, 'sess', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'sess', 'subagents', 'agent-1.jsonl'), USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, s.opts), false);
  } finally { s.done(); }
});

test('the folder is found whatever the case of its name (C-- and c-- are the same folder on Windows)', () => {
  const s = store();
  try {
    const odd = path.join(s.root, '.claude', 'projects', projectDirName(s.cwd).toUpperCase());
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(path.join(odd, 'x.jsonl'), USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, s.opts), true);
  } finally { s.done(); }
});

test('CLAUDE_CONFIG_DIR moves the store: the CLI reads its sessions from there, so so do we', () => {
  const s = store();
  try {
    const cfg = path.join(s.root, 'cfg');
    const dir = path.join(cfg, 'projects', projectDirName(s.cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.jsonl'), USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, { env: { CLAUDE_CONFIG_DIR: cfg }, homeDir: s.root }), true);
    assert.strictEqual(hasConversation(s.cwd, s.opts), false, 'and not from ~/.claude when it is set');
  } finally { s.done(); }
});

test('a projects dir handed in is the store', () => {
  const s = store();
  try {
    s.put('x.jsonl', USER_LINE);
    assert.strictEqual(hasConversation(s.cwd, { projectsDir: path.join(s.root, '.claude', 'projects') }), true);
    assert.strictEqual(hasConversation(s.cwd, { projectsDir: path.join(s.root, 'nowhere') }), false);
  } finally { s.done(); }
});

test('every doubt is "no conversation": no folder, a name too long to trust, an unreadable store', () => {
  const s = store();
  try {
    s.put('x.jsonl', USER_LINE);
    for (const bad of [undefined, null, '', '   ', 5, {}]) assert.strictEqual(hasConversation(bad, s.opts), false, String(bad));
    assert.strictEqual(hasConversation(path.join(s.root, 'x'.repeat(300)), s.opts), false, 'the CLI shortens long names with a hash we cannot reproduce');
    const unreadable = { ...s.opts, fsImpl: { ...fs, readdirSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } } };
    assert.strictEqual(hasConversation(s.cwd, unreadable), false);
  } finally { s.done(); }
});

test('reads only the head of a transcript: a huge one is not loaded whole', () => {
  const s = store();
  try {
    s.put('big.jsonl', USER_LINE + 'x'.repeat(5 * 1024 * 1024));
    let biggest = 0;
    const spy = { ...fs, readSync: (fd, buf, ...rest) => { biggest = Math.max(biggest, buf.length); return fs.readSync(fd, buf, ...rest); } };
    assert.strictEqual(hasConversation(s.cwd, { ...s.opts, fsImpl: spy }), true);
    assert.ok(biggest <= 128 * 1024, `read buffer ${biggest}`);
  } finally { s.done(); }
});
