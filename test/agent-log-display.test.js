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

test('M1: the part of a big transcript the host did not send is said, in sensible units', () => {
  const say = n => d.renderAgentLog(d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], skippedBytes: n })));
  assert.match(say(900), /the first 900 B of this transcript are not shown/);
  assert.match(say(2048), /the first 2 KB of this transcript are not shown/);
  assert.match(say(5 * 1024 * 1024), /the first 5\.0 MB of this transcript are not shown/);
  assert.ok(!/are not shown/.test(say(0)));
  // Strict: absence, a string, a float, a negative is not a size; a follow-up frame keeps it.
  for (const bad of [undefined, null, '5', 1.5, -2, NaN]) {
    assert.ok(!/are not shown/.test(say(bad)), String(bad));
  }
  const m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], skippedBytes: 4096 }));
  assert.strictEqual(d.applyFrame(m, frame({ reset: false, entries: [entry()], skippedBytes: undefined })).skippedBytes, 4096);
  assert.strictEqual(d.applyFrame(m, frame({ reset: true, entries: [entry()], skippedBytes: undefined })).skippedBytes, 0);
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

// ---- Miguel M3, PR #63: a live log is extended, not rebuilt, so a selection survives ----

// Just enough DOM for paint(): a container whose innerHTML setter is a REBUILD
// (every child replaced) and whose children are recognised by class. The real
// thing is measured in Chromium by verify/probe-agent-log.js.
function fakeContainer() {
  const c = { ops: [], els: {}, html: '' };
  const mk = () => ({ dataset: {}, scrollTop: 0, clientHeight: 100, scrollHeight: 1000, textContent: '', innerHTML: '',
    inserted: [], insertAdjacentHTML(pos, h) { this.inserted.push([pos, h]); } });
  Object.defineProperty(c, 'innerHTML', {
    get() { return c.html; },
    set(v) {
      c.html = v; c.ops.push('rebuild'); c.els = {};
      for (const [sel, cls] of [['.alog-body', 'alog-body'], ['.alog-rows', 'alog-rows'], ['.alog-status', 'alog-status'], ['.alog-notes', 'alog-notes']]) {
        if (v.includes(cls)) c.els[sel] = mk();
      }
      // Rows are 20px tall; a notes line above them pushes every row down by one.
      if (c.els['.alog-rows']) {
        const n = (v.match(/class="alog-entry/g) || []).length;
        const shift = v.includes('class="alog-note"') ? 1 : 0;
        c.els['.alog-rows'].children = Array.from({ length: n }, (_, i) => ({ offsetTop: (i + shift) * 20 }));
      }
    },
  });
  c.querySelector = sel => c.els[sel] || null;
  return c;
}

test('M3: the first paint builds; later frames only APPEND the new rows, on the same nodes', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ summary: 'a' }), entry({ summary: 'b' })], running: true, done: false }));
  assert.strictEqual(d.paint(c, m), 'rebuild');
  const rows = c.querySelector('.alog-rows');
  m = d.applyFrame(m, frame({ reset: false, running: true, done: false, entries: [entry({ summary: 'c' })] }));
  assert.strictEqual(m.render, 'append');
  assert.strictEqual(m.added, 1);
  assert.strictEqual(d.paint(c, m), 'append');
  assert.strictEqual(c.ops.length, 1, 'no second rebuild');
  assert.strictEqual(c.querySelector('.alog-rows'), rows, 'the rows container is the same node (a selection lives in it)');
  assert.strictEqual(rows.inserted.length, 1);
  assert.strictEqual(rows.inserted[0][0], 'beforeend');
  assert.ok(rows.inserted[0][1].includes('>c<') && !rows.inserted[0][1].includes('>a<'), 'only the new row is inserted');
  assert.strictEqual(rows.dataset.count, '3');
});

test('M3: a status-only frame changes the status text and touches no rows', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], running: true, done: false }));
  d.paint(c, m);
  m = d.applyFrame(m, frame({ reset: false, entries: [], running: false, done: true }));
  assert.strictEqual(m.render, 'status');
  assert.strictEqual(d.paint(c, m), 'status');
  assert.strictEqual(c.querySelector('.alog-status').textContent, 'finished');
  assert.strictEqual(c.querySelector('.alog-rows').inserted.length, 0);
  assert.strictEqual(c.ops.length, 1);
});

test('M3: anything that changes what is above the last row is a rebuild', () => {
  const base = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ summary: 'a' })] }));
  const cases = {
    'a reset': d.applyFrame(base, frame({ reset: true, entries: [entry({ summary: 'z' })] })),
    'another source': d.applyFrame(base, frame({ reset: false, source: '/p/other.jsonl', entries: [entry()] })),
    'the cap dropping rows': d.applyFrame(
      d.applyFrame(d.openLog('rev'), frame({ entries: Array.from({ length: d.MAX_ENTRIES }, () => entry()) })),
      frame({ reset: false, entries: [entry()] })),
    'the first row replacing "empty so far"': d.applyFrame(d.applyFrame(d.openLog('rev'), frame({ entries: [] })), frame({ reset: false, entries: [entry()] })),
    'an absence before it': d.applyFrame(d.applyFrame(base, { type: 'agent-log', agent: 'rev', source: null, reason: 'unreadable' }), frame({ reset: true, entries: [entry()] })),
  };
  for (const [name, m] of Object.entries(cases)) assert.strictEqual(m.render, 'rebuild', name);
  assert.strictEqual(d.openLog('rev').render, 'rebuild');
  assert.strictEqual(d.closeLog().render, 'rebuild');
});

test('M3: painting the same append model twice cannot duplicate rows -- the count check forces a rebuild', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry({ summary: 'a' })] }));
  d.paint(c, m);
  m = d.applyFrame(m, frame({ reset: false, entries: [entry({ summary: 'b' })] }));
  assert.strictEqual(d.paint(c, m), 'append');
  assert.strictEqual(d.paint(c, m), 'rebuild', 'the DOM already holds 2 rows: an append would make 3');
});

test('M3: notes are only rewritten when they change', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()], unknown: 1 }));
  d.paint(c, m);
  const notes = c.querySelector('.alog-notes');
  notes.innerHTML = 'SENTINEL';
  m = d.applyFrame(m, frame({ reset: false, entries: [entry()], unknown: 1 }));
  d.paint(c, m);
  assert.strictEqual(notes.innerHTML, 'SENTINEL', 'unchanged notes are left alone');
  m = d.applyFrame(m, frame({ reset: false, entries: [entry()], unknown: 2 }));
  d.paint(c, m);
  assert.match(notes.innerHTML, /2 lines of a kind/);
});

test('M3: paint keeps following when at the bottom, and leaves a reader who scrolled up where they are', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: [entry()] }));
  d.paint(c, m);
  const body = c.querySelector('.alog-body');
  body.scrollTop = 900;                            // clientHeight 100, scrollHeight 1000: at the bottom
  m = d.applyFrame(m, frame({ reset: false, entries: [entry()] }));
  d.paint(c, m);
  assert.strictEqual(body.scrollTop, body.scrollHeight);
  body.scrollTop = 200;                            // scrolled up
  m = d.applyFrame(m, frame({ reset: false, entries: [entry()] }));
  d.paint(c, m);
  assert.strictEqual(body.scrollTop, 200);
});

// ---- card clicks: a control inside a card (PR #66's hide button) must not open a log ----

// A tiny DOM: nodes with a parent, a tag, attributes, and the two methods the
// module uses. `closest` supports the selectors it is given here: `.class`,
// `[attr]`, `tag`, and comma-separated lists of those.
function node(tag, { cls = '', attrs = {}, dataset = {}, parent = null } = {}) {
  const n = { tag, classes: cls.split(/\s+/).filter(Boolean), attrs, dataset, parent };
  const matches = (el, sel) => sel.split(',').map(s => s.trim()).some((s) => {
    if (s.startsWith('.')) return el.classes.includes(s.slice(1));
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1) in el.attrs;
    return el.tag === s;
  });
  n.closest = (sel) => { for (let el = n; el; el = el.parent) if (matches(el, sel)) return el; return null; };
  n.contains = (other) => { for (let el = other; el; el = el.parent) if (el === n) return true; return false; };
  return n;
}

function card() {
  const row = node('div', { cls: 'agent', dataset: { agent: 'rev', state: 'sleeping' } });
  const face = node('div', { cls: 'face', parent: row });
  const faceImg = node('img', { parent: face });
  const meta = node('div', { cls: 'meta', parent: row });
  const name = node('div', { cls: 'name', parent: meta });
  const hide = node('button', { cls: 'agent-hide', parent: row });
  const hideIcon = node('span', { parent: hide });
  const marked = node('span', { attrs: { 'data-no-card-click': '' }, parent: meta });
  const markedInner = node('i', { parent: marked });
  return { row, face, faceImg, meta, name, hide, hideIcon, marked, markedInner };
}

// The renderer's handler, minus the socket: click -> maybe an `open` frame.
function click(target) {
  const sent = [];
  const agent = d.cardClickAgent(target);
  if (agent) sent.push({ type: 'agent-log', action: 'open', agent });
  return sent;
}

test('a click on the card body opens that agent\'s log', () => {
  const c = card();
  for (const t of [c.row, c.meta, c.name]) {
    assert.deepStrictEqual(click(t), [{ type: 'agent-log', action: 'open', agent: 'rev' }]);
  }
});

test('a click on the portrait opens nothing: it is the drop / upload target', () => {
  const c = card();
  assert.deepStrictEqual(click(c.face), []);
  assert.deepStrictEqual(click(c.faceImg), []);
});

test('a click on a BUTTON inside the card -- or on anything inside that button -- opens nothing', () => {
  const c = card();
  assert.deepStrictEqual(click(c.hide), []);
  assert.deepStrictEqual(click(c.hideIcon), []);
});

test('a click inside a [data-no-card-click] region opens nothing, so future card controls need no change here', () => {
  const c = card();
  assert.deepStrictEqual(click(c.marked), []);
  assert.deepStrictEqual(click(c.markedInner), []);
});

test('a control that merely CONTAINS the card does not swallow clicks on it', () => {
  const wrapper = node('button');
  const row = node('div', { cls: 'agent', dataset: { agent: 'rev' }, parent: wrapper });
  assert.deepStrictEqual(click(row), [{ type: 'agent-log', action: 'open', agent: 'rev' }]);
});

test('clicks that are not on a card at all, or on a card with no agent, open nothing', () => {
  assert.deepStrictEqual(click(node('div')), []);
  assert.deepStrictEqual(click(node('div', { cls: 'agent', dataset: {} })), []);
  assert.deepStrictEqual(click(node('div', { cls: 'agent', dataset: { agent: '' } })), []);
  for (const junk of [null, undefined, {}, 'x', 7]) assert.deepStrictEqual(click(junk), [], String(junk));
});

// ---- Dexter F9, PR #63: a reader who scrolled up keeps their ROW when the cap drops rows ----

test('F9: anchoredScrollTop finds the same row again after rows leave the top', () => {
  const oldTops = [0, 20, 40, 60, 80];
  const newTops = [0, 20, 40];                      // 2 rows dropped: old row 2 is new row 0
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops, newTops, dropped: 2 }), 5, 'row 2, 5px in');
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 80, oldTops, newTops, dropped: 2 }), 40);
  // With a note now above the rows, every new top is 20 lower.
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops, newTops: [20, 40, 60], dropped: 2 }), 25);
  // The row being read was itself dropped: the top of what remains.
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 25, oldTops, newTops, dropped: 2 }), 0);
  // Nothing to adjust, or nothing measurable: leave the position alone.
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops, newTops, dropped: 0 }), 45);
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops: [], newTops, dropped: 2 }), 45);
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops, newTops: [0, NaN], dropped: 2 }), 45);
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops, newTops, dropped: 1.5 }), 45);
  assert.strictEqual(d.anchoredScrollTop({ scrollTop: 45, oldTops, newTops: [], dropped: 2 }), 45, 'row not in the new list');
});

test('F9: a capped frame rebuilds, and a reader scrolled up stays on the same row', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: Array.from({ length: d.MAX_ENTRIES }, (_, i) => entry({ summary: 'n' + i })) }));
  d.paint(c, m);
  const body = c.querySelector('.alog-body');
  body.scrollHeight = 30000;
  body.scrollTop = 500 * 20 + 5;                    // 5px into row 500
  m = d.applyFrame(m, frame({ reset: false, entries: Array.from({ length: 3 }, () => entry()) }));
  assert.strictEqual(m.capDrop, 3);
  assert.strictEqual(d.paint(c, m), 'rebuild');
  // Old row 500 is now row 497, and the "earlier entries" note pushes rows down by one line.
  assert.strictEqual(c.querySelector('.alog-body').scrollTop, (497 + 1) * 20 + 5);
});

test('F9: a reader who is following is still pinned to the bottom through a capped frame; a reset is not anchored', () => {
  const c = fakeContainer();
  let m = d.applyFrame(d.openLog('rev'), frame({ entries: Array.from({ length: d.MAX_ENTRIES }, () => entry()) }));
  d.paint(c, m);
  c.querySelector('.alog-body').scrollTop = 900;    // at the bottom of a 1000px scroller
  m = d.applyFrame(m, frame({ reset: false, entries: [entry()] }));
  d.paint(c, m);
  const b = c.querySelector('.alog-body');
  assert.strictEqual(b.scrollTop, b.scrollHeight);
  const r = d.applyFrame(m, frame({ reset: true, entries: [entry()] }));
  assert.strictEqual(r.capDrop, 0, 'a reset replaces the list; there is no row to anchor to');
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
