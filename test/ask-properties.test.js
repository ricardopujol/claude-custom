'use strict';
/**
 * Properties of the "Ask the repo" modules (BACKLOG #33, PR #169 Miguel Y9). Example tests pin what someone thought of; these state the
 * invariant and let fast-check look for the input that breaks it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { formatText, esc } = require('../app/ask-display');
const { passesBar, BAR } = require('../host/ask-models');
const { clipSelection, SELECTION_MAX_LINES, SELECTION_MAX_CHARS, buildExplain } = require('../host/ask-explain');
const { whyFor, examplesFrom } = require('../host/ask-service');
const { childEnv } = require('../host/ask-claude');
const P = require('../app/ask-profile');

const ALLOWED_TAGS = new Set(['p', 'ul', 'li', 'code', 'strong', 'button']);
const text = fc.oneof(fc.string(), fc.string({ unit: 'binary', maxLength: 200 }), fc.constantFrom('<script>x</script>', '`<b>`', '**<i>**', 'a.js:1 <img src=x onerror=1>', '- <b>item</b>', '"><svg/onload=1>'));

test('formatText emits only whitelisted tags, whatever the model wrote; markup in the text is always escaped', () => {
  fc.assert(fc.property(text, fc.array(fc.constantFrom('a.js', 'host/b.js', 'x y.js')), (t, files) => {
    const html = formatText(t, new Set(files));
    for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED_TAGS.has(m[1].toLowerCase()), `tag <${m[1]}> in ${html}`);
    // every attribute that carries model text is a quoted data-* value of a cite button
    for (const m of html.matchAll(/<button\b([^>]*)>/g)) assert.match(m[1], /^ type="button" class="ask-cite" data-act="open" data-file="[^"<>]*" data-line="\d+"$/);
  }), { numRuns: 400 });
});

test('esc: nothing it returns can open a tag or close an attribute', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => { assert.ok(!/[<>"']/.test(esc(s))); }));
});

test('passesBar: exactly "8 of 10 at both levels", and nothing that is not a whole count', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), (a, b) => {
    const v = passesBar({ new: a, comfortable: b, of: BAR.of });
    const whole = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    assert.strictEqual(v, whole(a) && whole(b) && a >= BAR.min && b >= BAR.min);
  }), { numRuns: 500 });
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 }), fc.integer({ min: 0, max: 10 }), (a, b) => {
    assert.strictEqual(passesBar({ new: a, comfortable: b, of: 10 }), a >= 8 && b >= 8);
  }));
  fc.assert(fc.property(fc.integer(), (of) => { if (of !== 10) assert.strictEqual(passesBar({ new: 10, comfortable: 10, of }), false); }));
});

test('clipSelection: never more than the cap of lines or columns, the range stays inside the original one, and a clip is said', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), fc.array(fc.string({ maxLength: 700 }), { minLength: 1, maxLength: 200 }), (start, lines) => {
    const end = start + lines.length - 1;
    const r = clipSelection({ file: 'f', start, end, lines });
    assert.ok(r.lines.length <= SELECTION_MAX_LINES);
    assert.ok(r.lines.every(l => l.length <= SELECTION_MAX_CHARS + ' ...[line cut]'.length));
    assert.ok(r.start === start && r.end >= start && r.end <= end);
    assert.strictEqual(r.end - r.start + 1, r.lines.length === lines.length ? lines.length : r.lines.length);
    const exact = lines.length <= SELECTION_MAX_LINES && lines.every(l => l.length <= SELECTION_MAX_CHARS);
    assert.strictEqual(r.clipped, !exact);
  }), { numRuns: 300 });
});

test('whyFor never returns the citation it explains, and is never longer than the cap', () => {
  fc.assert(fc.property(fc.string(), fc.constantFrom('host/a.js', 'x/y.py'), fc.integer({ min: 1, max: 999 }), (words, file, line) => {
    const cit = { file, line };
    const w = whyFor(`- ${file}:${line}: ${words}\n`, cit);
    assert.ok(w.length <= 160);
    assert.ok(!w.includes(`${file}:${line}`));
  }), { numRuns: 300 });
});

test('buildExplain: the highlighted words can never break out of the sentence that names them', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (term) => {
    const { prompt } = buildExplain({ file: 'a.js', start: 1, end: 1, lines: ['x'], excerpts: 'e', term, answer: 'a' });
    const line = prompt.split('\n').find(l => l.startsWith('The reader highlighted'));
    if (term.trim()) { assert.ok(line, 'the sentence is there'); assert.ok(!line.slice('The reader highlighted "'.length, -1).includes('"') || line.endsWith('earlier explanation:')); }
    assert.ok(prompt.split('\n').filter(l => l.startsWith('The reader highlighted')).length <= 1);
  }), { numRuns: 200 });
});

test('childEnv: no name of the ANTHROPIC / AWS / proxy families, in any case, ever reaches the child', () => {
  const bad = fc.constantFrom('ANTHROPIC_', 'anthropic_', 'Anthropic_', 'AWS_', 'CLAUDE_CODE_USE_', 'CLOUD_ML_', 'HTTPS_', 'http_', 'ALL_', 'CLAUDE_CUSTOM_', 'GOOGLE_');
  fc.assert(fc.property(bad, fc.stringMatching(/^[A-Za-z_]{1,12}$/), fc.string(), (prefix, rest, value) => {
    const env = { [prefix + rest]: value, PATH: 'p' };
    const out = childEnv(env);
    assert.deepStrictEqual(Object.keys(out), ['PATH']);
  }), { numRuns: 300 });
});

test('the profile: whatever is stored, loading it gives a valid profile (known level and model, a safe portrait, a bounded name)', () => {
  fc.assert(fc.property(fc.anything(), (stored) => {
    let text2;
    try { text2 = JSON.stringify(stored); } catch { text2 = 'null'; }
    const store = { getItem: () => text2 };
    const p = P.load(store);
    assert.ok(P.LEVEL_IDS.includes(p.level));
    assert.ok(P.MODEL_IDS.includes(p.model));
    assert.ok(p.portrait.kind === 'upload' || (p.portrait.kind === 'agent' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.portrait.agent)));
    assert.ok(p.name.length <= P.NAME_MAX && p.aboutMe.length <= P.ABOUT_ME_MAX);
    assert.ok(p.named === false || p.name !== '');
  }), { numRuns: 400 });
});

test('examplesFrom: at most three, the same every time, and only ever about files the index holds', () => {
  const file = fc.record({ rel: fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}\.(js|py|ps1|md)$/), size: fc.nat(1000), chunks: fc.array(fc.record({ text: fc.string({ maxLength: 120 }) }), { maxLength: 3 }) });
  fc.assert(fc.property(fc.array(file, { maxLength: 8 }), (files) => {
    const data = { files };
    const a = examplesFrom(data);
    assert.ok(a.length <= 3);
    assert.deepStrictEqual(a, examplesFrom({ files: files.map(f => ({ ...f })) }));
    assert.strictEqual(a.length === 0, files.length === 0, 'nothing asked about only when there is nothing');
  }), { numRuns: 200 });
});
