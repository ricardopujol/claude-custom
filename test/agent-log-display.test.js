'use strict';
/**
 * BACKLOG #10, the drawing half: frames in, HTML out. Pure, so it is tested as
 * pure. The three things this module must not do are the three this repo keeps
 * paying for: draw a failure as an empty list, put a transcript's own text into
 * markup unescaped, and coerce "no value" into a confident zero.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const d = require('../app/agent-log-display');

const entry = (over = {}) => ({ ts: Date.UTC(2026, 8, 29, 12, 0, 0), kind: 'text', name: 'assistant', summary: 'hello', ...over });
const frame = (over = {}) => ({ type: 'agent-log', agent: 'rev', source: '/p/agent-a.jsonl', entries: [], reset: true, running: false, done: true, unknown: 0, ...over });

test('a closed log draws nothing', () => {
  assert.strictEqual(d.renderAgentLog(d.emptyLog()), '');
  assert.strictEqual(d.emptyLog().open, false);
});

test('opening a log is "waiting", which is said, not an empty list', () => {
  const m = d.openLog('rev');
  assert.strictEqual(m.open, true);
  assert.strictEqual(m.agent, 'rev');
  assert.strictEqual(m.waiting, true);
  assert.match(d.renderAgentLog(m), /waiting for the host/);
});

test('closing returns to the empty model', () => {
  assert.deepStrictEqual(d.closeLog(), d.emptyLog());
});

test('a frame with entries appends them, and clears waiting', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ summary: 'a' }), entry({ summary: 'b' })] }));
  assert.strictEqual(m.waiting, false);
  assert.deepStrictEqual(m.entries.map(e => e.summary), ['a', 'b']);
  assert.strictEqual(m.source, '/p/agent-a.jsonl');
  const m2 = d.applyFrame(m, frame({ reset: false, entries: [entry({ summary: 'c' })] }));
  assert.deepStrictEqual(m2.entries.map(e => e.summary), ['a', 'b', 'c']);
});

test('reset replaces what is held; so does a different source', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ summary: 'a' })] }));
  const r = d.applyFrame(m, frame({ reset: true, entries: [entry({ summary: 'z' })] }));
  assert.deepStrictEqual(r.entries.map(e => e.summary), ['z']);
  const other = d.applyFrame(m, frame({ reset: false, source: '/p/agent-b.jsonl', entries: [entry({ summary: 'y' })] }));
  assert.deepStrictEqual(other.entries.map(e => e.summary), ['y']);
});

test('a frame for another agent, or for a closed log, changes nothing', () => {
  const open = d.openLog('rev');
  assert.strictEqual(d.applyFrame(open, frame({ agent: 'someone-else' })), open);
  const closed = d.emptyLog();
  assert.strictEqual(d.applyFrame(closed, frame()), closed);
});

test('junk frames change nothing', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()] }));
  for (const junk of [null, undefined, 'x', 7, [], {}, { type: 'other', agent: 'rev' }, frame({ source: 42 }), frame({ source: undefined })]) {
    assert.strictEqual(d.applyFrame(m, junk), m, JSON.stringify(junk));
  }
});

test('no transcript is stated in words and the list is not shown', () => {
  for (const [reason, re] of [
    ['no-transcript', /no transcript found for rev/],
    ['unidentified', /rev is running but hasn&#39;t said which run it is yet/],
    ['pending', /rev is running, but its transcript isn&#39;t written yet/],
    ['unreadable', /couldn&#39;t read the transcript for rev/],
    ['something-new', /no transcript available for rev \(something-new\)/],
  ]) {
    const m = d.applyFrame(d.openLog('rev'), { type: 'agent-log', agent: 'rev', source: null, reason, running: false });
    const html = d.renderAgentLog(m);
    assert.match(html, re, reason);
    assert.ok(!html.includes('alog-entry'), 'no entry rows for an absent transcript');
    assert.ok(!/empty so far/.test(html));
  }
});

test('a missing reason is still an explicit absence', () => {
  const m = d.applyFrame(d.openLog('rev'), { type: 'agent-log', agent: 'rev', source: null });
  assert.strictEqual(m.reason, 'no-transcript');
});

test('an absence after a log clears the old entries: it cannot sit under "no transcript"', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()] }));
  const gone = d.applyFrame(m, { type: 'agent-log', agent: 'rev', source: null, reason: 'no-transcript', running: false });
  assert.deepStrictEqual(gone.entries, []);
  assert.strictEqual(gone.source, null);
});

test('a transcript with no lines yet says so, instead of drawing an empty list', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [], running: true, done: false }));
  assert.match(d.renderAgentLog(m), /the transcript is empty so far/);
});

test('the status says live, finished, or neither -- from the frame, never guessed', () => {
  const live = d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], running: true, done: false })));
  assert.match(live, /alog-status[^>]*>live</);
  const fin = d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], running: false, done: true })));
  assert.match(fin, /alog-status[^>]*>finished</);
  const mid = d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], running: false, done: false })));
  assert.match(mid, /alog-status[^>]*>reading</);
});

test('F4: a run this host does not track is "latest run", never "finished"', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], running: false, done: false, tracked: false }));
  assert.strictEqual(m.tracked, false);
  assert.match(d.renderAgentLog(m), /alog-status[^>]*>latest run</);
  // A tracked, quiet, over run is "finished"; a frame that says nothing about tracking is treated as tracked.
  const fin = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], done: true, tracked: true }));
  assert.match(d.renderAgentLog(fin), /alog-status[^>]*>finished</);
  assert.strictEqual(d.applyFrame(d.openLog('rev'), frame({ tracked: undefined })).tracked, true);
});

test('the log is capped, and says how many earlier entries are not shown', () => {
  const many = Array.from({ length: d.MAX_ENTRIES + 25 }, (_, i) => entry({ summary: 'n' + i }));
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: many }));
  assert.strictEqual(m.entries.length, d.MAX_ENTRIES);
  assert.strictEqual(m.dropped, 25);
  assert.strictEqual(m.entries[0].summary, 'n25', 'the newest are kept');
  assert.match(d.renderAgentLog(m), /25 earlier entries not shown/);
  const more = d.applyFrame(m, frame({ reset: false, entries: [entry({ summary: 'tail' })] }));
  assert.strictEqual(more.dropped, 26);
  assert.match(d.renderAgentLog(more), /26 earlier entries not shown/);
  assert.match(d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [entry()] }))), /^(?!.*earlier entr)/s);
  const one = d.applyFrame(d.openLog('rev'), frame({ entries: Array.from({ length: d.MAX_ENTRIES + 1 }, () => entry()) }));
  assert.match(d.renderAgentLog(one), /1 earlier entry not shown/);
});

test('unrecognised lines are counted for the reader', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ kind: 'unknown', name: 'attachment', summary: '' })], unknown: 3 }));
  assert.strictEqual(m.unknown, 3);
  assert.match(d.renderAgentLog(m), /3 lines of a kind this view cannot show as a call or message/);
  const one = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], unknown: 1 }));
  assert.match(d.renderAgentLog(one), /1 line of a kind/);
  const none = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], unknown: 0 }));
  assert.ok(!/lines? of a kind/.test(d.renderAgentLog(none)));
  // Strict: absence, a string, a float or a negative is not a count.
  for (const bad of [undefined, null, '5', 1.5, -2, NaN]) {
    const m2 = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], unknown: bad }));
    assert.strictEqual(m2.unknown, 0, String(bad));
  }
});

test('entries of every kind render their own class and label', () => {
  const html = d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [
    entry({ kind: 'tool_use', name: 'Bash', summary: 'ls' }),
    entry({ kind: 'tool_result', name: 'Bash', summary: 'ok', error: false }),
    entry({ kind: 'tool_result', name: 'Bash', summary: 'boom', error: true }),
    entry({ kind: 'text', name: 'assistant', summary: 'hi' }),
    entry({ kind: 'unknown', name: 'attachment', summary: '' }),
  ] })));
  assert.match(html, /alog-entry alog-tool_use"/);
  assert.match(html, /alog-entry alog-tool_result"/);
  assert.match(html, /alog-entry alog-tool_result alog-error"/);
  assert.match(html, /alog-entry alog-text"/);
  assert.match(html, /alog-entry alog-unknown"/);
  assert.match(html, />call</);
  assert.match(html, />error</);
  assert.match(html, />say</);
});

test('a kind the host invents is shown as unknown, never dropped, never a class injection', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ kind: '"><script>x</script>' })] }));
  assert.strictEqual(m.entries.length, 1);
  assert.strictEqual(m.entries[0].kind, 'unknown');
});

test('a junk entry is kept as an unknown one, not skipped', () => {
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [null, 7, 'x', { kind: 'text' }] }));
  assert.strictEqual(m.entries.length, 4);
  assert.ok(m.entries.slice(0, 3).every(e => e.kind === 'unknown'));
  assert.deepStrictEqual(m.entries[3], { ts: null, kind: 'text', name: '', summary: '', error: false });
});

test('the time is HH:MM:SS local, and an entry without one shows a dash -- not 00:00:00', () => {
  const ts = new Date(2026, 8, 29, 7, 5, 9).getTime();
  const html = d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ ts }), entry({ ts: null }), entry({ ts: 'soon' })] })));
  assert.match(html, />07:05:09</);
  assert.strictEqual((html.match(/alog-time">—</g) || []).length, 2);
  assert.ok(!html.includes('00:00:00'));
});

test('EVERYTHING from the transcript is escaped: agent, source, name, summary, reason', () => {
  const HOSTILE = '"><img src=x onerror=alert(1)>';
  const m = d.applyFrame(d.openLog(HOSTILE), {
    type: 'agent-log', agent: HOSTILE, source: `/p/${HOSTILE}.jsonl`, running: true, done: false, unknown: 0, reset: true,
    entries: [entry({ name: HOSTILE, summary: HOSTILE, kind: 'tool_use' })],
  });
  const none = d.applyFrame(d.openLog(HOSTILE), { type: 'agent-log', agent: HOSTILE, source: null, reason: HOSTILE });
  for (const html of [d.renderAgentLog(m), d.renderAgentLog(none)]) {
    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('"><img'), html);
    assert.ok(html.includes('&quot;&gt;&lt;img'), 'the hostile text is present, but as escaped text');
  }
});

test('PROPERTY: no string in a frame ever reaches the markup as a tag or a quote break', () => {
  fc.assert(fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (agent, name, summary, source) => {
    if (!agent) return;
    const m = d.applyFrame(d.openLog(agent), {
      type: 'agent-log', agent, source: source || 'x', reset: true, running: false, done: true,
      entries: [entry({ name, summary })],
    });
    const html = d.renderAgentLog(m);
    // Strip the markup this module emits itself; what remains of any transcript
    // string must contain no raw `<`, `>` or `"` outside tags.
    const stripped = html.replace(/<\/?(div|span|button)\b[^<>]*>/g, '');
    assert.ok(!/[<>]/.test(stripped), stripped);
    const attrs = html.match(/<[^>]*>/g) || [];
    for (const tag of attrs) assert.ok((tag.match(/"/g) || []).length % 2 === 0, tag);
  }), { numRuns: 300 });
});

test('the close button is a real, addressable control', () => {
  const html = d.renderAgentLog(d.openLog('rev'));
  assert.match(html, /<button[^>]*data-agent-log-close/);
});

test('shouldFollow: pinned to the bottom unless the reader scrolled up', () => {
  assert.strictEqual(d.shouldFollow({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), true);
  assert.strictEqual(d.shouldFollow({ scrollTop: 880, clientHeight: 100, scrollHeight: 1000 }), true, 'within the slack');
  assert.strictEqual(d.shouldFollow({ scrollTop: 500, clientHeight: 100, scrollHeight: 1000 }), false);
  assert.strictEqual(d.shouldFollow({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 }), true, 'nothing to scroll');
  // Nothing measured yet (a first render): follow, the reader has not scrolled anywhere.
  assert.strictEqual(d.shouldFollow(null), true);
  assert.strictEqual(d.shouldFollow({ scrollTop: NaN, clientHeight: 100, scrollHeight: 1000 }), true);
});
