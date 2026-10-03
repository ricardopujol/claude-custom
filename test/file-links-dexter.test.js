'use strict';
/**
 * PR #92, Dexter's review (2026-10-02): each finding pinned by the test that
 * fails without its fix. Report:
 * C:\Users\ricar\.claude\reviews\claude-custom\2026-10-02-feat-terminal-file-links-dexter.md
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { findCandidates, MAX_OPTIONS } = require('../app/file-path-parse');
const { safePath, actionFor, check, open, newState } = require('../app/file-link');

const CWD = 'C:\\Users\\ricar\\VibeCode\\claude-custom\\feat-terminal-file-links';
const optionsOf = (text, breaks) => findCandidates(text, breaks).map(c => c.options.map(o => o.path));
const fileStat = { isFile: () => true, isDirectory: () => false };
const dirStat = { isFile: () => false, isDirectory: () => true };
const plainLstat = { isSymbolicLink: () => false };
const recordingShell = (calls) => ({
  openPath: async (p) => { calls.push(['open', p]); return ''; },
  showItemInFolder: (p) => calls.push(['reveal', p]),
});

// --- F1: the 8-option cap kept the 8 LONGEST endings ----------------------------

test('F1: a path followed by a long sentence keeps its real ending', () => {
  const o = optionsOf('I updated C:\\proj\\notes.md so the parser now handles every edge case we found today')[0];
  assert.ok(o.includes('C:\\proj\\notes.md'), JSON.stringify(o));
  assert.ok(o.length <= MAX_OPTIONS);
});

// --- round 2 (Dexter r2, 2026-10-02): N1-N3 ----------------------------------------

test('N1: a folder followed by many dotted words keeps its real ending', () => {
  const o = optionsOf('C:\\proj\\dist holds main.js, main.css, index.html, app.js, vendor.js, logo.png, robots.txt and favicon.ico')[0];
  assert.ok(o.includes('C:\\proj\\dist'), JSON.stringify(o));
});

test('N1: prose with forward-slash paths after a backslash path does not crowd it out', () => {
  const words = 'abcdefgh'.split('').map(c => `src/${c}.js`).join(' ');
  const o = optionsOf(`C:\\proj\\notes.md mirrors ${words}`)[0];
  assert.ok(o.includes('C:\\proj\\notes.md'), JSON.stringify(o));
  assert.ok(!o.some(p => p.includes(' ') && p.includes('/')), 'no ending mixes the two separators across a space');
});

test('N3: a glued relative path after an absolute path in the same block is still found', () => {
  const text = 'I changed C:\\proj\\README.md and the parser inapp\\file-path-parse.js too';
  const b = text.indexOf('app\\file');
  assert.ok(findCandidates(text, [b]).some(c => c.start === b
    && c.options.some(o => o.path === 'app\\file-path-parse.js')));
});

test('N2: a chain of symlinks is followed hop by hop; a remote hop anywhere is refused', async () => {
  const links = { 'docs\\notes.md': '..\\.cache\\n.md', '.cache\\n.md': '\\\\attacker\\share\\n.md' };
  const linkOf = (p) => Object.keys(links).find(k => p.endsWith(k));
  const seen = [];
  const fsx = {
    lstat: async (p) => { seen.push('lstat'); return { isSymbolicLink: () => !!linkOf(p) }; },
    readlink: async (p) => links[linkOf(p)],
    stat: async () => { seen.push('stat'); return fileStat; },
    realpath: async (p) => { seen.push('realpath'); return p; },
  };
  assert.deepStrictEqual(await check([['docs\\notes.md']], CWD, fsx, { state: newState() }), [null]);
  assert.ok(!seen.includes('stat') && !seen.includes('realpath'), JSON.stringify(seen));
  // a local two-hop chain is followed
  links['.cache\\n.md'] = 'C:\\real\\n.md';
  const [a] = await check([['docs\\notes.md']], CWD, fsx, { state: newState() });
  assert.strictEqual(a && a.action, 'open');
  // a loop is refused, not followed forever
  links['.cache\\n.md'] = '..\\docs\\notes.md';
  assert.deepStrictEqual(await check([['docs\\notes.md']], CWD, fsx, { state: newState() }), [null]);
});

test('F1 PROPERTY: an absolute file path followed by any prose is always offered', () => {
  const seg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_ -]{0,10}[A-Za-z0-9_-]$/);
  fc.assert(fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), fc.stringMatching(/^[a-z]{1,5}$/),
    fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 25 }), (parts, ext, words) => {
      const p = `C:\\${parts.join('\\')}.${ext}`;
      const text = `saved ${p} ${words.join(' ')}`.trimEnd();
      const c = findCandidates(text).find(x => x.start === 6);
      return !!c && c.options.some(o => o.path === p);
    }));
});

// --- F2: Windows strips a trailing dot or space; Node's stat does not ------------

test('F2: a path with a segment ending in a dot or a space is refused', () => {
  for (const p of ['C:\\x\\tool.exe.', 'C:\\x\\tool.exe ', 'C:\\x.\\a.md', 'C:\\x \\a.md', 'app\\tool.exe.',
                   'C:\\x\\tool.exe...']) {
    assert.strictEqual(safePath(p, CWD), null, JSON.stringify(p));
  }
  assert.notStrictEqual(safePath('C:\\x\\..\\a.md', CWD), null, '. and .. segments are fine');
  assert.notStrictEqual(safePath('.\\a.md', CWD), null);
});

test('F2: a folder is opened WITH a trailing separator, so a file swapped in its place is not run', async () => {
  const calls = [];
  const fsx = { stat: async () => dirStat, lstat: async () => plainLstat, realpath: async (p) => p };
  assert.deepStrictEqual(await open('C:\\x\\dir', CWD, fsx, recordingShell(calls), { state: newState() }),
    { ok: true, action: 'open' });
  assert.deepStrictEqual(calls, [['open', 'C:\\x\\dir\\']]);
});

// --- F3: a symlink to a UNC path leaked NTLM on the hover's stat ------------------

test('F3: a final symlink that points at a UNC path is refused before anything follows it', async () => {
  for (const target of ['\\\\attacker\\share\\notes.md', '//attacker/share/notes.md',
                        '\\\\?\\UNC\\attacker\\share\\notes.md', 'UNC\\attacker\\share']) {
    const seen = [];
    const fsx = {
      lstat: async (p) => { seen.push('lstat'); return { isSymbolicLink: () => p.endsWith('notes.md') }; },
      readlink: async () => target,
      stat: async () => { seen.push('stat'); return fileStat; },
      realpath: async (p) => { seen.push('realpath'); return p; },
    };
    assert.deepStrictEqual(await check([['docs\\notes.md']], CWD, fsx, { state: newState() }), [null], target);
    assert.deepStrictEqual(seen, ['lstat'], `nothing followed the link to ${target}`);
    const calls = [];
    assert.deepStrictEqual(await open('docs\\notes.md', CWD, fsx, recordingShell(calls), { state: newState() }),
      { ok: false, why: 'refused' });
    assert.deepStrictEqual(calls, []);
  }
});

test('F3: a symlink to a local target is followed as before', async () => {
  for (const target of ['C:\\real\\notes.md', '\\\\?\\C:\\real\\notes.md', '..\\real\\notes.md']) {
    const fsx = {
      // only the link itself is a link; where it points is a plain file
      lstat: async (p) => ({ isSymbolicLink: () => p.includes('\\docs\\') }),
      readlink: async () => target,
      stat: async () => fileStat,
      realpath: async () => 'C:\\real\\notes.md',
    };
    const [a] = await check([['docs\\notes.md']], CWD, fsx, { state: newState() });
    assert.strictEqual(a && a.action, 'open', target);
  }
});

// --- F4: the second half of a broken absolute path, read as a relative path ------

test('F4: a break inside an absolute path never starts a relative path of its own', () => {
  const text = 'C:\\Users\\ricar\\VibeCode\\claude-custom\\dev\\app\\file-link.js';
  const b = text.indexOf('app\\file');
  assert.ok(!findCandidates(text, [b]).some(x => x.start === b));
  const mid = text.indexOf('ile-link');                    // broken mid-word
  assert.ok(!findCandidates(text, [mid]).some(x => x.start === mid));
  // a relative path after a space, not glued, is still found
  assert.ok(findCandidates('C:\\a\\x.txt and app\\y.md').some(x => x.options.some(o => o.path === 'app\\y.md')));
});

// --- F5: a full row that ended at a dropped space glued two words ----------------

test('F5: a glued break also offers the spaced reading, tried before the bare prefix', () => {
  const text = 'C:\\x\\claude-customdocs\\a.md';
  const b = text.indexOf('docs');
  const o = optionsOf(text, [b])[0];
  const spaced = 'C:\\x\\claude-custom docs\\a.md';
  assert.ok(o.includes(spaced), JSON.stringify(o));
  assert.ok(o.indexOf(spaced) < o.indexOf('C:\\x\\claude-custom'), JSON.stringify(o));
  // a virtual-space break (text[b] is the space) needs no extra reading
  const t2 = 'C:\\x\\claude-custom docs\\a.md';
  assert.strictEqual(optionsOf(t2, [t2.indexOf(' docs')])[0].filter(p => p.includes('  ')).length, 0);
});

// --- F6: .xml can open in Word ---------------------------------------------------

test('F6: .xml is revealed, not opened', () => {
  assert.strictEqual(actionFor({ given: 'C:\\a.xml', real: 'C:\\a.xml', isDir: false }), 'reveal');
});

// --- F7: an absolute path inside a URL --------------------------------------------

test('F7: nothing inside a URL is offered, absolute paths included', () => {
  assert.deepStrictEqual(optionsOf('see https://x.com/?f=C:\\a\\b.md now'), []);
  assert.deepStrictEqual(optionsOf('see https://x.com/?f=C:/a/b.md'), []);
  assert.ok(optionsOf('https://x.com/ and C:\\a\\b.md').some(o => o.includes('C:\\a\\b.md')));
});

// --- F8: one slow stat blocked a whole drive, clicks included --------------------

test('F8: a slow drive is skipped on hover, but a click still asks the disk', async () => {
  let hang = true;
  const fsx = {
    stat: () => (hang ? new Promise(() => {}) : Promise.resolve(fileStat)),
    lstat: async () => plainLstat,
    realpath: async (p) => p,
  };
  const opts = { state: newState(), now: () => 0, timeoutMs: 20 };
  assert.deepStrictEqual(await check([['C:\\a.md']], CWD, fsx, opts), [null]);   // times out: C: is slow
  hang = false;
  assert.deepStrictEqual(await check([['C:\\a.md']], CWD, fsx, opts), [null], 'hover skips a slow drive');
  const calls = [];
  assert.deepStrictEqual(await open('C:\\a.md', CWD, fsx, recordingShell(calls), opts), { ok: true, action: 'open' });
  assert.deepStrictEqual(calls, [['open', 'C:\\a.md']]);
});

test('F8: a slow drive cools in seconds, not a minute', async () => {
  let t = 0;
  let stats = 0;
  const fsx = { stat: () => { stats++; return new Promise(() => {}); }, lstat: async () => plainLstat, realpath: async (p) => p };
  const opts = { state: newState(), now: () => t, timeoutMs: 20 };
  await check([['C:\\a.md']], CWD, fsx, opts);
  t += 16000;
  await check([['C:\\b.md']], CWD, fsx, opts);
  assert.strictEqual(stats, 2);
});
