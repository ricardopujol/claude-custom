'use strict';
/**
 * The "where are we" summary's text side (host/summary-text.js, backlog #39 job 1,
 * documentation/DESIGN_SLAVE_MODE_SUMMARY.md): what is read out of a transcript, what is asked of the model, and
 * what is kept of its reply.
 *
 * The rules come from the 2026-10-03 serving measurement: only the person's and Claude's own words go in; skill
 * injections, system reminders and command wrappers filled the tails of two of three real sessions and must not.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const { flattenTranscript, buildPrompt, cleanReply, capMessage, MAX_CHARS, PER_MESSAGE } = require('../host/summary-text');

const line = (o) => JSON.stringify(o);
const user = (content, extra = {}) => line({ type: 'user', uuid: 'u-' + String(content).length + Math.random(), message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => line({ type: 'assistant', uuid: 'a-' + Math.random(), message: { role: 'assistant', content }, ...extra });
const text = (t) => ({ type: 'text', text: t });
const flat = (lines, opts) => flattenTranscript(lines.join('\n'), opts);

test('the design constants: about 10,000 characters in, about 1,500 per message', () => {
  assert.strictEqual(MAX_CHARS, 10000);
  assert.strictEqual(PER_MESSAGE, 1500);
});

test('user and assistant text survive, in order, labelled by who said them', () => {
  const r = flat([user('fix the drawer'), asst([text('Looking at it.')]), user([text('and the hover card')])]);
  assert.deepStrictEqual(r.messages.map(m => [m.role, m.text]), [
    ['user', 'fix the drawer'], ['assistant', 'Looking at it.'], ['user', 'and the hover card'],
  ]);
  assert.strictEqual(r.transcript, 'User: fix the drawer\n\nAssistant: Looking at it.\n\nUser: and the hover card');
});

test('tool calls, tool results and thinking never reach the model', () => {
  const r = flat([
    asst([{ type: 'thinking', thinking: 'secret chain of thought' }, text('Reading the file.'), { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\x' } }]),
    user([{ type: 'tool_result', tool_use_id: 't', content: 'FILE CONTENTS' }]),
    asst([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['Reading the file.']);
  assert.ok(!/secret|FILE CONTENTS|Bash|ls/.test(r.transcript));
});

test('subagent sidechains and meta messages (skill injections) are dropped', () => {
  const r = flat([
    user('real question'),
    asst([text('a subagent talking')], { isSidechain: true }),
    user([text('Base directory for this skill: C:\\x\n# Skill body')], { isMeta: true }),
    asst([text('real answer')]),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['real question', 'real answer']);
});

test('a skill injection that lost its isMeta flag is still recognised by its opening words', () => {
  const r = flat([user('Base directory for this skill: C:\\skills\\tdd\n\nbody'), user('go on')]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['go on']);
});

test('a reminder the CLI injected (its own block, or appended on its own lines) is cut out, and a message that was only one disappears', () => {
  const r = flat([
    user('keep this\n<system-reminder>\nremember the rules\n</system-reminder>'),
    user('<system-reminder>only a reminder</system-reminder>'),
    user([text('a text block'), text('<system-reminder>\nthe CLI added this\n</system-reminder>')]),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['keep this', 'a text block']);
});

// Dexter F4 (PR #105): the person's own words about the tag are not an injected one. Matched by shape: the tag opens a
// line and its closer ends one, so a mention in a sentence is kept whole, and an unclosed one never eats the rest.
test('a literal <system-reminder> the person typed or quoted keeps the whole message', () => {
  const said = 'Make the flattener drop <system-reminder> blocks, skill injections and command wrappers, then add tests.';
  const quoted = 'wrap it as <system-reminder>...</system-reminder> like the CLI does';
  const fenced = 'the CLI writes `<system-reminder>\nbody\n</system-reminder>` around it';
  const r = flat([user(said), asst([text(quoted)]), user(fenced)]);
  assert.deepStrictEqual(r.messages.map(m => m.text), [said, quoted, fenced]);
});

test('an unclosed <system-reminder> at the start of a line is not an injection (the CLI always closes it)', () => {
  const r = flat([user('<system-reminder>\nhow do I stop this tag eating my text')]);
  assert.strictEqual(r.messages.length, 1);
  assert.match(r.messages[0].text, /eating my text/);
});

// Dexter F2: Claude Code appends the compaction summary as a USER line flagged isCompactSummary. The fixture's line
// shape is copied from a real compacted transcript on this machine (content cut short).
test('a compaction summary is the CLI\'s, not the person\'s: dropped, and neither real turn around it is lost', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'summary-compact.fixture.jsonl'), 'utf8');
  assert.ok(fixture.includes('"isCompactSummary":true'));
  const r = flattenTranscript(fixture);
  assert.ok(!/continued from a previous conversation/.test(r.transcript));
  assert.deepStrictEqual(r.messages.map(m => m.text), ['run the review on the slot', 'Reviewing the slot now.', 'ok, carry on', 'Carrying on with the fix.']);
});

test('a compaction summary is recognised by its words too, if the flag is ever missing', () => {
  const r = flat([user('real question'),
    user('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\nSummary: ...'),
    user('go on')]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['real question', 'go on']);
});

test('the person typing the same words mid-message is not a compaction summary', () => {
  const r = flat([user('please explain: This session is being continued from a previous conversation, what does that line mean?')]);
  assert.strictEqual(r.messages.length, 1);
});

test('command wrappers, local command output, task notifications and interrupt markers are dropped', () => {
  const r = flat([
    user('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
    user('<local-command-stdout>done</local-command-stdout>'),
    user('<local-command-caveat>Caveat: generated by the user</local-command-caveat>'),
    user('<task-notification>\n<task-id>b05</task-id>\n</task-notification>'),
    user('[Request interrupted by user]'),
    user('<bash-input>ls</bash-input>'),
    user('a real message'),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['a real message']);
});

test('a malformed line, a blank line and a line of another type are skipped without losing the rest', () => {
  const r = flat([
    '{"type":"user","message":{"role":"user","cont', '', 'not json', 'null', '42', '[]',
    line({ type: 'last-prompt', text: 'x' }), line({ type: 'ai-title', title: 'y' }),
    user('survivor'),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['survivor']);
});

test('CRLF line endings read the same as LF', () => {
  const r = flattenTranscript([user('one'), asst([text('two')])].join('\r\n'));
  assert.deepStrictEqual(r.messages.map(m => m.text), ['one', 'two']);
});

test('nothing usable is an empty result with a null newestKey, never a made-up message', () => {
  for (const input of ['', '\n\n', 'garbage', line({ type: 'system' })]) {
    const r = flattenTranscript(input);
    assert.deepStrictEqual(r.messages, []);
    assert.strictEqual(r.transcript, '');
    assert.strictEqual(r.newestKey, null);
  }
  assert.strictEqual(flattenTranscript(null).newestKey, null);
  assert.strictEqual(flattenTranscript(undefined).transcript, '');
});

test('newestKey is the newest kept message\'s uuid, and a message without one still gets a stable key', () => {
  const a = flattenTranscript([line({ type: 'user', uuid: 'u1', message: { content: 'x' } }), line({ type: 'assistant', uuid: 'a2', message: { content: [text('y')] } })].join('\n'));
  assert.strictEqual(a.newestKey, 'a2');
  const bare = line({ type: 'user', message: { content: 'same words' } });
  const k1 = flattenTranscript(bare).newestKey;
  const k2 = flattenTranscript(bare).newestKey;
  assert.ok(typeof k1 === 'string' && k1 !== '');
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(k1, flattenTranscript(line({ type: 'user', message: { content: 'other words' } })).newestKey);
});

test('newest messages win the budget: the window is filled from the newest backwards, then put in order', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(i % 2 ? asst([text(`answer ${i} ` + 'x'.repeat(480))]) : user(`question ${i} ` + 'y'.repeat(480)));
  const r = flat(lines, { maxChars: 3000 });
  assert.ok(r.transcript.length <= 3000);
  const nums = r.messages.map(m => Number(/(\d+)/.exec(m.text)[1]));
  assert.strictEqual(nums[nums.length - 1], 39);
  assert.deepStrictEqual(nums, [...nums].sort((a, b) => a - b));
  assert.ok(nums.length >= 4 && nums[0] > 30);
});

test('one huge message is cut to the per-message cap, keeping its start AND its end (a conclusion lives at the end)', () => {
  const big = 'START ' + 'm'.repeat(5000) + ' END';
  const r = flat([asst([text(big)])]);
  const m = r.messages[0].text;
  assert.ok(m.length <= PER_MESSAGE);
  assert.ok(m.startsWith('START '));
  assert.ok(m.endsWith(' END'));
  assert.ok(m.includes('[...]'));
});

test('a message already within the cap is untouched', () => {
  assert.strictEqual(capMessage('short', 1500), 'short');
  assert.strictEqual(capMessage('x'.repeat(1500), 1500).length, 1500);
  assert.ok(capMessage('x'.repeat(1501), 1500).length <= 1500);
});

test('the cut never splits an emoji into a lone surrogate', () => {
  const s = '😀'.repeat(400);
  for (let cap = 20; cap < 60; cap++) {
    const out = capMessage(s, cap);
    assert.ok(out.length <= cap);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test('property: only text blocks survive, every message is within the cap, the window is within budget, order is kept', () => {
  const blockArb = fc.oneof(
    fc.string({ maxLength: 3000 }).map(t => text(t)),
    fc.constant({ type: 'tool_use', name: 'Bash', input: { command: 'TOOLCALL' } }),
    fc.constant({ type: 'tool_result', content: 'TOOLRESULT' }),
    fc.constant({ type: 'thinking', thinking: 'THINKING' }),
  );
  const msgArb = fc.record({ role: fc.constantFrom('user', 'assistant'), blocks: fc.array(blockArb, { maxLength: 4 }), side: fc.boolean() });
  const junkArb = fc.constantFrom('', 'junk', '{"type":"user"', '{}', 'null');
  fc.assert(fc.property(fc.array(fc.oneof(msgArb, junkArb), { maxLength: 40 }), fc.integer({ min: 1700, max: 12000 }), (items, maxChars) => {
    const lines = items.map((it, i) => typeof it === 'string' ? it
      : line({ type: it.role, uuid: 'id' + i, isSidechain: it.side, message: { role: it.role, content: it.blocks } }));
    const r = flattenTranscript(lines.join('\n'), { maxChars });
    assert.ok(r.transcript.length <= maxChars);
    assert.ok(!/TOOLCALL|TOOLRESULT|THINKING/.test(r.transcript));
    for (const m of r.messages) {
      assert.ok(m.text.length <= PER_MESSAGE);
      assert.ok(m.text.trim() !== '');
    }
    // order: the kept ids are an increasing subsequence of the input order, and the newest kept one is newestKey
    const ids = r.messages.map(m => Number(m.key.slice(2)));
    assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b));
    if (r.messages.length) assert.strictEqual(r.newestKey, r.messages[r.messages.length - 1].key);
    else assert.strictEqual(r.newestKey, null);
    // no sidechain text: the sidechain flag was set on those lines
    const sideIds = new Set(items.map((it, i) => (typeof it !== 'string' && it.side ? 'id' + i : null)).filter(Boolean));
    for (const m of r.messages) assert.ok(!sideIds.has(m.key));
  }), { numRuns: 200 });
});

test('property: the transcript is deterministic and a malformed line anywhere changes nothing', () => {
  fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 15 }), fc.nat(15), (words, at) => {
    const lines = words.map((w, i) => (i % 2 ? asst([text(w)]) : user(w)));
    const base = flat(lines);
    const withJunk = lines.slice();
    withJunk.splice(Math.min(at, withJunk.length), 0, '{"broken');
    assert.deepStrictEqual(flat(withJunk).messages.map(m => m.text), base.messages.map(m => m.text));
  }), { numRuns: 100 });
});

test('buildPrompt puts the transcript FIRST and the instruction LAST (the other way round gave stale summaries)', () => {
  const p = buildPrompt('User: hello\n\nAssistant: hi');
  assert.ok(p.startsWith('User: hello'));
  const at = p.indexOf('hello');
  const instr = p.search(/Working on:/);
  assert.ok(instr > at);
  assert.match(p, /last few messages/);
  assert.match(p, /plain text/i);
  assert.match(p, /do not invent/i);
});

test('cleanReply keeps 3 to 5 short plain lines and strips markdown', () => {
  const raw = '**Working on:** the "where are we" panel\n- Where it stands: tests are green\n\n## Next: open the PR\n1. extra\n2. more\n3. too many\n';
  const out = cleanReply(raw);
  const lines = out.split('\n');
  assert.ok(lines.length <= 5);
  assert.deepStrictEqual(lines.slice(0, 3), ['Working on: the "where are we" panel', 'Where it stands: tests are green', 'Next: open the PR']);
  assert.ok(!/[*#]|^- /m.test(out));
});

// Dexter F5: emphasis is stripped where it IS emphasis (a **bold** span), never from identifiers and globs.
test('cleanReply leaves __init__.py and src/**/*.js alone, and still drops real bold', () => {
  assert.strictEqual(cleanReply('Working on: fixing __init__.py imports and the src/**/*.js glob'), 'Working on: fixing __init__.py imports and the src/**/*.js glob');
  assert.strictEqual(cleanReply('Next: edit __init__.py and src/**/*.ts'), 'Next: edit __init__.py and src/**/*.ts');
  assert.strictEqual(cleanReply('Next: lint src/**/a.js and lib/**/b.js'), 'Next: lint src/**/a.js and lib/**/b.js', 'two globs are not one bold span');
  assert.strictEqual(cleanReply('**Working on:** x'), 'Working on: x');
  assert.strictEqual(cleanReply('It is **done** and **tested** now'), 'It is done and tested now');
});

// Miguel I3: a model fed web text can emit controls, bidi overrides and zero-width characters; they reach tab.title.
test('cleanReply strips control, bidi and zero-width characters (they would reach the native tooltip)', () => {
  const out = cleanReply('Working on: \u001b[31mred\u001b[0m text\u202e reversed\u200b zero\u0000 nul\u2066 iso\u0085\nNext: fine\u007f');
  assert.strictEqual(out, 'Working on: [31mred[0m text reversed zero nul iso\nNext: fine');
  assert.doesNotMatch(out, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
  assert.strictEqual(cleanReply('\u200b\u202e\u001b'), null, 'a reply of nothing but those says nothing');
});

test('cleanReply refuses a reply that says nothing: null, never an empty summary', () => {
  for (const raw of [undefined, null, 5, {}, '', '   \n\n  ', '```\n```', '**', '- ', '__', '***']) assert.strictEqual(cleanReply(raw), null);
});

test('cleanReply bounds a runaway reply: lines and characters', () => {
  const out = cleanReply(Array.from({ length: 30 }, (_, i) => 'line ' + i + ' ' + 'z'.repeat(500)).join('\n'));
  assert.ok(out.split('\n').length <= 5);
  for (const l of out.split('\n')) assert.ok(l.length <= 240);
  assert.ok(out.length <= 900);
});

test('property: cleanReply is null or a bounded, non-blank block with no controls, fences or bidi marks', () => {
  fc.assert(fc.property(fc.string({ maxLength: 4000 }), (raw) => {
    const out = cleanReply(raw);
    if (out === null) return;
    const lines = out.split('\n');
    assert.ok(lines.length >= 1 && lines.length <= 5);
    assert.ok(out.length <= 900);
    for (const l of lines) { assert.ok(l.trim() !== ''); assert.ok(l.length <= 240); }
    assert.ok(!out.includes('```'));
    assert.doesNotMatch(out, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
  }), { numRuns: 300 });
});

test('property: a word wrapped in ** comes out bare, and identifiers with underscores come out unchanged', () => {
  fc.assert(fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}[A-Za-z0-9]$/), fc.stringMatching(/^[a-z]{1,8}$/), (w, id) => {
    assert.strictEqual(cleanReply('Next: **' + w + '** now'), 'Next: ' + w + ' now');
    assert.strictEqual(cleanReply('Next: edit __' + id + '__.py'), 'Next: edit __' + id + '__.py');
  }), { numRuns: 100 });
});
