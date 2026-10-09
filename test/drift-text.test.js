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
const SHOWN_DIFF = diffOf('host/ask-index.js', '-  await refreshIndex();\n+  // the refresh now runs after the answer');
const item = (o = {}) => ({ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', evidence: '+  // the refresh now runs after the answer', why: 'The refresh moved.', ...o });

test('buildPrompt: hands back the diff text the model was shown, so evidence can be checked against it', () => {
  const { diff, prompt } = sample();
  assert.match(diff, /host\/ask-index\.js/);
  assert.ok(prompt.includes(diff));
});

test('parseReply: a flag whose sentence is in the named doc AND whose evidence is in the shown diff survives', () => {
  const got = parseReply(JSON.stringify([item()]), given, SHOWN_DIFF);
  assert.deepStrictEqual(got, [{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', evidence: '// the refresh now runs after the answer', why: 'The refresh moved.' }]);
});

test('parseReply: a made-up sentence, an unknown doc, an empty why, a missing field are all dropped', () => {
  const reply = JSON.stringify([
    item({ sentence: 'The index is rebuilt nightly.' }),
    item({ doc: 'DESIGN_OTHER.md' }),
    item({ why: '  ' }),
    item({ why: undefined }),
    item({ evidence: undefined }),
    'not an object', null, 7,
  ]);
  assert.deepStrictEqual(parseReply(reply, given, SHOWN_DIFF), []);
});

test('parseReply: evidence that is not in the diff the model was shown is dropped (the model invented it)', () => {
  assert.deepStrictEqual(parseReply(JSON.stringify([item({ evidence: '+  rebuildNightly();' })]), given, SHOWN_DIFF), []);
  assert.deepStrictEqual(parseReply(JSON.stringify([item()]), given, ''), []);
  assert.deepStrictEqual(parseReply(JSON.stringify([item()]), given), []);
});

test('parseReply: markers, spacing and comment asterisks around the evidence do not matter (a real reply garbled them)', () => {
  const d = diffOf('host/w.js', '+ *   docsOf({ root, dev })              -> { ok: true, dir, canCreate }');
  const g = [{ rel: 'PLAN_W.md', excerpt: 'The writer exposes docsOf(projectDev) to find the docs.' }];
  const it = { doc: 'PLAN_W.md', sentence: 'The writer exposes docsOf(projectDev) to find the docs.', evidence: '- *docsOf*({ root, dev }) -> { ok: true, dir, canCreate }', why: 'its argument changed' };
  assert.strictEqual(parseReply(JSON.stringify([it]), g, d).length, 1);
  assert.deepStrictEqual(parseReply(JSON.stringify([{ ...it, evidence: '- *docsOf*({ root }) -> { ok: false }' }]), g, d), []);
  assert.deepStrictEqual(parseReply(JSON.stringify([{ ...it, evidence: '+ a' }]), g, d), [], 'too short to prove anything');
});

test('parseReply: evidence must be about the sentence: they share a distinctive word', () => {
  const unrelated = item({ sentence: 'It lives in host/ask-index.js.', evidence: '+  // the refresh now runs after the answer' });
  assert.deepStrictEqual(parseReply(JSON.stringify([unrelated]), given, SHOWN_DIFF), []);
  const related = item({ sentence: 'It lives in host/ask-index.js.', evidence: '+++ b/host/ask-index.js' });
  assert.strictEqual(parseReply(JSON.stringify([related]), given, SHOWN_DIFF).length, 1);
});

test('parseReply: the model naming the doc with a prefix ("DOCUMENT X.md") still finds the doc', () => {
  const got = parseReply(JSON.stringify([item({ doc: 'DOCUMENT DESIGN_ASK_REPO.md' })]), given, SHOWN_DIFF);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].doc, 'DESIGN_ASK_REPO.md');
});

test('parseReply: whitespace differences do not hide a real sentence; fences and chatter around the JSON are tolerated', () => {
  const reply = 'Here you go:\n```json\n' + JSON.stringify([item({ sentence: 'The  index   refreshes\nbefore each question.' })]) + '\n```';
  const got = parseReply(reply, given, SHOWN_DIFF);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sentence, 'The index refreshes before each question.');
});

test('parseReply: a reply cut off mid-list keeps the items that were whole', () => {
  const whole = JSON.stringify(item());
  const cut = '[' + whole + ',' + JSON.stringify(item({ sentence: 'It lives in host/ask-index.js.', evidence: '+++ b/host/ask-index.js' })).slice(0, 60);
  const got = parseReply(cut, given, SHOWN_DIFF);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sentence, 'The index refreshes before each question.');
});

test('parseReply: [] and garbage are no flags; null means the reply was not usable at all', () => {
  assert.deepStrictEqual(parseReply('[]', given, SHOWN_DIFF), []);
  assert.strictEqual(parseReply('I think the docs are fine.', given, SHOWN_DIFF), null);
  assert.strictEqual(parseReply('', given, SHOWN_DIFF), null);
  assert.strictEqual(parseReply(null, given, SHOWN_DIFF), null);
  assert.strictEqual(parseReply('{"a":1}', given, SHOWN_DIFF), null);
  assert.strictEqual(parseReply('[ {"doc": "DESIGN_ASK_REPO.md", "sent', given, SHOWN_DIFF), null);
});

test('parseReply: duplicates collapse, the flag count and field lengths are capped', () => {
  const one = item({ why: 'w'.repeat(2000) });
  const out = parseReply(JSON.stringify([one, one, one]), given, SHOWN_DIFF);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].why.length <= 300);
  const lines = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} about widgets is here.`);
  const g = [{ rel: 'DESIGN_M.md', excerpt: lines.join('\n') }];
  const diff = diffOf('x.js', '+widgets changed');
  const many = parseReply(JSON.stringify(lines.map(s => ({ doc: 'DESIGN_M.md', sentence: s, evidence: '+widgets changed', why: 'w' }))), g, diff);
  assert.strictEqual(many.length, MAX_FLAGS);
});
