'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const {
  redact, trimDiff, changedFilesOf, buildLogNow, candidateDocs, buildPrompt, parseReply,
  DIFF_MAX_CHARS, PROMPT_MAX_CHARS, MAX_FLAGS,
} = require('../host/drift-text');

const diffOf = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n${body}\n`;

test('redact: tokens, keys and credential assignments never survive', () => {
  const cases = [
    'const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghijkl',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'password = hunter2hunter2',
    'API_KEY: "abcd1234"',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const out = redact(c);
    assert.match(out, /\[redacted\]/, c);
    assert.doesNotMatch(out, /abcdefghijklmnop|hunter2|abcd1234|MIIEabc/, c);
  }
});

test('redact: ordinary code is left alone', () => {
  const code = 'const tokens = countTokens(text); // the token budget\nfunction keyOf(m) { return m.uuid; }';
  assert.strictEqual(redact(code), code);
});

test('trimDiff: secret-bearing and noise files are dropped whole, and say so', () => {
  const diff = diffOf('.env', '+KEY=1') + diffOf('package-lock.json', '+x') + diffOf('app/app.min.js', '+x')
    + diffOf('certs/server.pem', '+x') + diffOf('host/real.js', '+const a = 1;');
  const out = trimDiff(diff);
  assert.match(out, /host\/real\.js/);
  for (const f of ['.env', 'package-lock.json', 'app.min.js', 'server.pem']) assert.doesNotMatch(out, new RegExp(f.replace('.', '\\.')));
});

test('trimDiff: per-file and total caps hold, with a visible cut marker', () => {
  const big = '+' + 'x'.repeat(50_000);
  const out = trimDiff(diffOf('a.js', big) + diffOf('b.js', big) + diffOf('c.js', big), { maxChars: 6_000, perFile: 2_000 });
  assert.ok(out.length <= 6_000 + 200);
  assert.match(out, /\[diff cut\]/);
});

test('trimDiff: redacts what it keeps', () => {
  const out = trimDiff(diffOf('host/x.js', '+const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";'));
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwxyz0123/);
});

test('property: trimDiff never exceeds its cap by more than the marker', () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 400 }), { maxLength: 30 }), fc.integer({ min: 500, max: 5000 }), (bodies, maxChars) => {
    const diff = bodies.map((b, i) => diffOf(`f${i}.js`, '+' + b.replace(/\n/g, ' '))).join('');
    return trimDiff(diff, { maxChars, perFile: 1000 }).length <= maxChars + 60;
  }), { numRuns: 100 });
});

test('changedFilesOf: the b-side paths, once each, in order', () => {
  const diff = diffOf('host/a.js', '+1') + diffOf('app/b.js', '+2') + diffOf('host/a.js', '+3');
  assert.deepStrictEqual(changedFilesOf(diff), ['host/a.js', 'app/b.js']);
  assert.deepStrictEqual(changedFilesOf(''), []);
  assert.deepStrictEqual(changedFilesOf(null), []);
});

test('buildLogNow: the Now section only, capped, null when there is none', () => {
  const log = '# Log\n\n## Now\n\nline one\nline two\n\n## Status Legend\n\nother\n';
  assert.strictEqual(buildLogNow(log), 'line one\nline two');
  assert.strictEqual(buildLogNow('# Log\n\n## Other\n\nx'), null);
  assert.strictEqual(buildLogNow(null), null);
  assert.ok(buildLogNow('## Now\n\n' + 'y'.repeat(9000), 100).length <= 100);
});

const docs = [
  { rel: 'DESIGN_ASK_REPO.md', text: 'The index lives in host/ask-index.js.\nIt refreshes before each question.\n' },
  { rel: 'DESIGN_WAND.md', text: 'The wand types a skill.\nUnrelated.\n' },
  { rel: 'PLAN_SUMMARY.md', text: 'The summary-service watches a transcript. summary-service ticks every 5 s.\n' },
  { rel: 'CLAUDE_CUSTOM_DESIGN.md', text: 'frozen: host/ask-index.js\n' },
  { rel: 'CLAUDECUSTOM_HISTORY.md', text: 'old: host/ask-index.js\n' },
  { rel: 'README.md', text: 'host/ask-index.js\n' },
];

test('candidateDocs: design/plan docs that name a changed file, best first; frozen, history and README never', () => {
  const got = candidateDocs({ changedFiles: ['host/ask-index.js', 'host/summary-service.js'], docs });
  assert.deepStrictEqual(got.map(d => d.rel), ['PLAN_SUMMARY.md', 'DESIGN_ASK_REPO.md']);
});

test('candidateDocs: a doc that names nothing changed is not a candidate; the cap holds', () => {
  assert.deepStrictEqual(candidateDocs({ changedFiles: ['host/other.js'], docs }), []);
  const many = Array.from({ length: 6 }, (_, i) => ({ rel: `DESIGN_${i}.md`, text: 'host/ask-index.js' }));
  assert.strictEqual(candidateDocs({ changedFiles: ['host/ask-index.js'], docs: many, max: 2 }).length, 2);
});

test('candidateDocs: a short generic basename ("a.js", "index.js") matches only by its full path', () => {
  const d = [{ rel: 'DESIGN_X.md', text: 'We have an index.js somewhere and a.js too.' }];
  assert.deepStrictEqual(candidateDocs({ changedFiles: ['host/index.js', 'host/a.js'], docs: d }), []);
  const d2 = [{ rel: 'DESIGN_X.md', text: 'See host/index.js.' }];
  assert.strictEqual(candidateDocs({ changedFiles: ['host/index.js'], docs: d2 }).length, 1);
});

test('candidateDocs: the excerpt keeps whole lines, those naming the change first, within the cap', () => {
  const text = Array.from({ length: 200 }, (_, i) => `filler line ${i} ${'z'.repeat(40)}`).join('\n') + '\nThe host/ask-index.js refresh runs first.\n';
  const [one] = candidateDocs({ changedFiles: ['host/ask-index.js'], docs: [{ rel: 'DESIGN_Z.md', text }], excerptChars: 600 });
  assert.ok(one.excerpt.length <= 600);
  assert.match(one.excerpt, /host\/ask-index\.js refresh runs first/);
  for (const line of one.excerpt.split('\n')) assert.ok(text.includes(line), 'every excerpt line is a whole line of the doc');
});

const sample = () => buildPrompt({
  subject: 'Merge pull request #1', sha: 'abcdef1234567890', diff: diffOf('host/ask-index.js', '+const x = 1;'),
  now: 'Now text', docs: [{ rel: 'DESIGN_ASK_REPO.md', excerpt: 'The index refreshes.' }],
});

test('buildPrompt: names the commit, the diff, the Now text and each doc; asks for JSON only', () => {
  const { system, prompt } = sample();
  assert.match(prompt, /abcdef123456/);
  assert.match(prompt, /host\/ask-index\.js/);
  assert.match(prompt, /Now text/);
  assert.match(prompt, /DESIGN_ASK_REPO\.md/);
  assert.match(system, /JSON/);
  assert.match(system, /\[\]/);
});

test('buildPrompt: the whole prompt stays under its cap whatever the inputs', () => {
  const huge = 'q'.repeat(200_000);
  const { prompt, system } = buildPrompt({
    subject: huge, sha: 'a'.repeat(40), diff: diffOf('x.js', '+' + huge), now: huge,
    docs: [{ rel: 'DESIGN_A.md', excerpt: huge }, { rel: 'DESIGN_B.md', excerpt: huge }],
  });
  assert.ok(prompt.length + system.length <= PROMPT_MAX_CHARS, String(prompt.length));
  assert.ok(DIFF_MAX_CHARS < PROMPT_MAX_CHARS);
});

test('buildPrompt: no secret reaches it, from the diff, the subject, the Now text or an excerpt', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const { prompt } = buildPrompt({
    subject: `fix ${key}`, sha: 'abc', diff: diffOf('host/x.js', `+const k = "${key}";`), now: `token ${key}`,
    docs: [{ rel: 'DESIGN_A.md', excerpt: `key ${key}` }],
  });
  assert.doesNotMatch(prompt, /abcdefghijklmnopqrstuvwxyz0123/);
});

test('property: buildPrompt is bounded for any inputs', () => {
  fc.assert(fc.property(fc.string({ maxLength: 40_000 }), fc.string({ maxLength: 40_000 }), (a, b) => {
    const { prompt, system } = buildPrompt({ subject: a, sha: 'abc', diff: diffOf('x.js', '+' + a.replace(/\n/g, ' ')), now: b, docs: [{ rel: 'DESIGN_A.md', excerpt: b }] });
    return prompt.length + system.length <= PROMPT_MAX_CHARS;
  }), { numRuns: 60 });
});

const given = [{ rel: 'DESIGN_ASK_REPO.md', excerpt: 'The index refreshes before each question.\nIt lives in host/ask-index.js.' }];

test('parseReply: a flag whose sentence is really in the named doc survives', () => {
  const reply = JSON.stringify([{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', why: 'The refresh now runs after.' }]);
  assert.deepStrictEqual(parseReply(reply, given), [{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', why: 'The refresh now runs after.' }]);
});

test('parseReply: a made-up sentence, an unknown doc, an empty why are all dropped', () => {
  const reply = JSON.stringify([
    { doc: 'DESIGN_ASK_REPO.md', sentence: 'The index is rebuilt nightly.', why: 'x' },
    { doc: 'DESIGN_OTHER.md', sentence: 'The index refreshes before each question.', why: 'x' },
    { doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', why: '  ' },
    { doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.' },
    'not an object', null, 7,
  ]);
  assert.deepStrictEqual(parseReply(reply, given), []);
});

test('parseReply: whitespace differences do not hide a real sentence; fences and chatter around the JSON are tolerated', () => {
  const reply = 'Here you go:\n```json\n' + JSON.stringify([{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The  index   refreshes\nbefore each question.', why: 'changed' }]) + '\n```';
  const got = parseReply(reply, given);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sentence, 'The index refreshes before each question.');
});

test('parseReply: [] and garbage are no flags; null means the reply was not usable at all', () => {
  assert.deepStrictEqual(parseReply('[]', given), []);
  assert.strictEqual(parseReply('I think the docs are fine.', given), null);
  assert.strictEqual(parseReply('', given), null);
  assert.strictEqual(parseReply(null, given), null);
  assert.strictEqual(parseReply('{"a":1}', given), null);
});

test('parseReply: duplicates collapse, the flag count and field lengths are capped', () => {
  const one = { doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', why: 'w'.repeat(2000) };
  const out = parseReply(JSON.stringify([one, one, one]), given);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].why.length <= 300);
  const lines = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} is here.`);
  const g = [{ rel: 'DESIGN_M.md', excerpt: lines.join('\n') }];
  const many = parseReply(JSON.stringify(lines.map(s => ({ doc: 'DESIGN_M.md', sentence: s, why: 'w' }))), g);
  assert.strictEqual(many.length, MAX_FLAGS);
});
