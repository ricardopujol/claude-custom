'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const {
  redact, trimDiff, changedFilesOf, buildLogNow, candidateDocs, buildPrompt, parseReply, isBuildLog,
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
const IMPORT_LINE = "+import { build } from './ask-index.js';";
const CONTEXT_LINE = ' const RETRY_MS = 60_000;';
const SHOWN_DIFF = diffOf('host/ask-index.js', [CONTEXT_LINE, '-  await refreshIndex();', '+  // the refresh now runs after the answer', IMPORT_LINE].join('\n'));
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
  const related = item({ sentence: 'It lives in host/ask-index.js.', evidence: IMPORT_LINE });
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
  const cut = '[' + whole + ',' + JSON.stringify(item({ sentence: 'It lives in host/ask-index.js.', evidence: IMPORT_LINE })).slice(0, 60);
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

// ---- PR #153 review fixes ----------------------------------------------------------------------------------------

test('redact: environment-style and quoted-JSON secrets lose their value (Dexter 5)', () => {
  const lines = [
    'DB_PASSWORD=hunter2hunter2',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    '  "password": "hunter2hunter2",',
    'STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop',
    'client_secret: abcdef123456',
    'clientSecret = "abcdef123456"',
    'const stripe = "sk_test_abcdefghijklmnop1234";',
    'GITHUB_TOKEN: ghs_abcdefghijklmnopqrstuvwxyz0123',
    'api-key: abcd1234efgh',
  ];
  for (const l of lines) {
    const out = redact('+' + l);
    assert.match(out, /\[redacted\]/, l);
    assert.doesNotMatch(out, /hunter2|wJalr|51Habc|abcdef123456|abcdefghijklmnop1234|ghs_abc|abcd1234efgh/, l);
  }
});

test('redact: still leaves ordinary code and prose alone', () => {
  for (const l of ['const tokens = countTokens(text);', 'function keyOf(m) { return m.uuid; }', 'the token budget is 8192', 'if (auth) { return 1; }', 'const authorName = "x";', 'passwordless login is out of scope']) {
    assert.strictEqual(redact(l), l);
  }
});

test('redact: a long run of identifier characters is linear, not quadratic', () => {
  const blob = 'a'.repeat(200_000) + '=1';
  const t = Date.now();
  redact(blob);
  assert.ok(Date.now() - t < 1500, String(Date.now() - t));
});

test('trimDiff: .env variants and key files are excluded wherever they sit (Dexter 5)', () => {
  const secret = '+API_KEY=zzzzzzzzzzzz';
  for (const f of ['config/.env-prod', 'prod.env', '.envrc', 'a/b/.env.local', 'deploy/id_rsa', 'config/credentials.json']) {
    assert.doesNotMatch(trimDiff(diffOf(f, secret) + diffOf('host/ok.js', '+const a = 1;')), new RegExp(f.replace(/[./]/g, '\\$&')), f);
  }
  assert.match(trimDiff(diffOf('host/environment.js', '+const a = 1;')), /host\/environment\.js/);
});

test('parseReply: the model\'s reason and evidence are redacted before they can be stored (Dexter 5)', () => {
  const d = diffOf('host/ask-index.js', '+  // the refresh now runs after the answer');
  const out = parseReply(JSON.stringify([item({ why: 'changed DB_PASSWORD=hunter2hunter2 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' })]), given, d);
  assert.strictEqual(out.length, 1);
  assert.doesNotMatch(out[0].why, /hunter2|abcdefghijklmnopqrstuvwxyz0123/);
});

test('parseReply: evidence that is only an unchanged context line, a file header or a hunk header is dropped (Dexter 4)', () => {
  assert.deepStrictEqual(parseReply(JSON.stringify([item({ sentence: 'It retries at most once a minute (RETRY_MS).', evidence: 'const RETRY_MS = 60_000;' })]),
    [{ rel: 'DESIGN_ASK_REPO.md', excerpt: 'It retries at most once a minute (RETRY_MS).' }], SHOWN_DIFF), []);
  const headerOnly = [{ rel: 'DESIGN_ASK_REPO.md', excerpt: 'It lives in host/ask-index.js.' }];
  for (const ev of ['diff --git a/host/ask-index.js b/host/ask-index.js', '+++ b/host/ask-index.js', '--- a/host/ask-index.js', '@@ -1,2 +1,2 @@']) {
    assert.deepStrictEqual(parseReply(JSON.stringify([item({ sentence: 'It lives in host/ask-index.js.', evidence: ev })]), headerOnly, SHOWN_DIFF), [], ev);
  }
});

test('parseReply: evidence is one changed line: text spread over two lines, or across the - and + lines, does not count (Dexter 4)', () => {
  const d = diffOf('host/w.js', '+const alphaValue = computeFirst();\n+const betaValue = computeSecond();');
  const g = [{ rel: 'DESIGN_W.md', excerpt: 'The alphaValue and the betaValue are computed.' }];
  const one = (ev) => parseReply(JSON.stringify([{ doc: 'DESIGN_W.md', sentence: 'The alphaValue and the betaValue are computed.', evidence: ev, why: 'w' }]), g, d);
  assert.strictEqual(one('const alphaValue = computeFirst();').length, 1);
  assert.deepStrictEqual(one('const alphaValue = computeFirst(); const betaValue = computeSecond();'), []);
});

test('candidateDocs: lines that are not next to each other are joined by a gap marker, so a quote spanning the gap is not in the excerpt (Dexter 10)', () => {
  const text = ['The service polls git.', 'See host/drift-service.js for the loop.', 'It never retries.', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'Old text.', 'host/drift-service.js reads docs.', 'Ends here.'].join('\n');
  const [one] = candidateDocs({ changedFiles: ['host/drift-service.js'], docs: [{ rel: 'DESIGN_S.md', text }] });
  assert.match(one.excerpt, /\n\[\.\.\.\]\n/);
  const g = [{ rel: 'DESIGN_S.md', excerpt: one.excerpt }];
  const d = diffOf('host/drift-service.js', '+const retries = 0;');
  const flag = (sentence) => parseReply(JSON.stringify([{ doc: 'DESIGN_S.md', sentence, evidence: '+const retries = 0;', why: 'w' }]), g, d);
  assert.deepStrictEqual(flag('It never retries. Old text.'), []);
  assert.strictEqual(flag('It never retries.').length, 1);
});

test('buildPrompt: the "Now" section is shown under the name of the build log it came from', () => {
  const { prompt, docs } = buildPrompt({ subject: 's', sha: 'abc', diff: diffOf('x.js', '+a'), now: 'Now text', nowRel: 'FOO_BUILD_LOG.md', docs: [] });
  assert.match(prompt, /FILE FOO_BUILD_LOG\.md \(its "Now" section\)/);
  assert.strictEqual(docs[0].rel, 'FOO_BUILD_LOG.md');
});

test('isBuildLog: any <NAME>_BUILD_LOG.md is a build log (Dexter 8)', () => {
  for (const n of ['CLAUDECUSTOM_BUILD_LOG.md', 'FACEBOOKDEALS_BUILD_LOG.md', 'x_build_log.md']) assert.strictEqual(isBuildLog(n), true, n);
  for (const n of ['BUILD_LOG.md', 'DESIGN_BUILD_LOG_NOTES.md', 'CLAUDECUSTOM_HISTORY.md', 'FOO_BUILD_LOG.md.bak', null]) assert.strictEqual(isBuildLog(n), false, String(n));
});
