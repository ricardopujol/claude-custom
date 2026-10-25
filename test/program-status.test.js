'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  parseReport, createProgramStatus, QUERY_REPLY, MAX_REPORT_BYTES, MAX_RECORDS, MIN_RECORDS,
} = require('../host/program-status');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// --- the query ----------------------------------------------------------------

test('"?" is the capability query', () => {
  assert.deepStrictEqual(parseReport('?'), { query: true });
});

test('the reply names the states and kinds this terminal understands, framed as an OSC with a string terminator', () => {
  assert.strictEqual(QUERY_REPLY,
    '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\');
});

// --- parsing a report -----------------------------------------------------------

test('a bare state is a root report', () => {
  assert.deepStrictEqual(parseReport('state=working'), {
    report: { state: 'working', id: '', kind: null, progress: null, app: null, title: null, msg: null },
  });
});

test('every key is read', () => {
  const r = parseReport(`state=blocked:id=a/b:kind=permission:progress=40:app=claude:title=${b64('Edit file')}:msg=${b64('Allow Edit?')}`);
  assert.deepStrictEqual(r.report, {
    state: 'blocked', id: 'a/b', kind: 'permission', progress: 40, app: 'claude', title: 'Edit file', msg: 'Allow Edit?',
  });
});

test('unknown keys are ignored, the rest still counts', () => {
  assert.strictEqual(parseReport('state=done:colour=red').report.state, 'done');
});

test('a missing or unknown state discards the report whole', () => {
  for (const d of ['', 'id=x', 'state=', 'state=busy', 'state=WORKING', 'progress=3']) {
    assert.strictEqual(parseReport(d).report, undefined, d);
  }
});

test('clear is a state of its own', () => {
  assert.strictEqual(parseReport('state=clear:id=a').report.state, 'clear');
});

test('a token with no "=" or a repeated key discards the report whole', () => {
  assert.strictEqual(parseReport('state=done:oops').report, undefined);
  assert.strictEqual(parseReport('state=done:state=working').report, undefined);
});

test('kind only means something with blocked, and only the three known kinds', () => {
  assert.strictEqual(parseReport('state=working:kind=permission').report.kind, null);
  assert.strictEqual(parseReport('state=blocked:kind=question').report.kind, 'question');
  assert.strictEqual(parseReport('state=blocked:kind=banana').report, undefined);
  assert.strictEqual(parseReport('state=blocked').report.kind, null);
});

test('progress is a whole number 0..100, kept only for working and blocked', () => {
  assert.strictEqual(parseReport('state=working:progress=0').report.progress, 0);
  assert.strictEqual(parseReport('state=working:progress=100').report.progress, 100);
  assert.strictEqual(parseReport('state=blocked:progress=7').report.progress, 7);
  assert.strictEqual(parseReport('state=done:progress=7').report.progress, null);
  for (const p of ['101', '-1', '1.5', 'x', '', '07x']) {
    assert.strictEqual(parseReport(`state=working:progress=${p}`).report, undefined, p);
  }
});

test('app is at most 32 bytes', () => {
  assert.strictEqual(parseReport(`state=idle:app=${'a'.repeat(32)}`).report.app.length, 32);
  assert.strictEqual(parseReport(`state=idle:app=${'a'.repeat(33)}`).report, undefined);
});

test('title is base64 UTF-8, at most 192 decoded bytes', () => {
  assert.strictEqual(parseReport(`state=idle:title=${b64('héllo ✓')}`).report.title, 'héllo ✓');
  assert.strictEqual(parseReport(`state=idle:title=${b64('a'.repeat(192))}`).report.title.length, 192);
  assert.strictEqual(parseReport(`state=idle:title=${b64('a'.repeat(193))}`).report, undefined);
});

test('msg is base64 UTF-8, at most 2048 decoded bytes', () => {
  assert.strictEqual(parseReport(`state=idle:msg=${b64('a'.repeat(2048))}`).report.msg.length, 2048);
  assert.strictEqual(parseReport(`state=idle:msg=${b64('a'.repeat(2049))}`).report, undefined);
});

test('bad base64 or invalid UTF-8 discards the report whole', () => {
  for (const bad of ['!!!!', 'abc', 'YQ=', 'YQ==YQ==', '/w==', 'gA==']) {
    assert.strictEqual(parseReport(`state=idle:title=${bad}`).report, undefined, bad);
  }
});

test('an empty title is an empty title', () => {
  assert.strictEqual(parseReport('state=idle:title=').report.title, '');
});

test('a report over 4096 bytes is discarded whole, 4096 is not', () => {
  assert.strictEqual(MAX_REPORT_BYTES, 4096);
  // an unknown key is ignored, so it is a clean way to pad to an exact size
  const padded = (total) => { const base = 'state=idle:zz='; return base + 'z'.repeat(total - base.length); };
  assert.strictEqual(Buffer.byteLength(padded(4096)), 4096);
  assert.ok(parseReport(padded(4096)).report);
  assert.strictEqual(parseReport(padded(4097)).report, undefined);
});

test('the limit counts bytes, not characters', () => {
  const base = 'state=idle:zz=';
  const d = base + 'é'.repeat((4096 - base.length) / 2 + 1);   // one byte over in UTF-8, well under in characters
  assert.ok(d.length < 4096);
  assert.strictEqual(parseReport(d).report, undefined);
});

test('a control character anywhere discards the report whole', () => {
  for (const c of ['\x00', '\x07', '\x1b', '\x1f', '\x7f', '\x85', '\x9b', '\n']) {
    assert.strictEqual(parseReport(`state=idle:app=a${c}b`).report, undefined, JSON.stringify(c));
  }
});

test('id: 32 bytes per segment, 8 levels, no empty segment', () => {
  assert.ok(parseReport(`state=idle:id=${'a'.repeat(32)}`).report);
  assert.strictEqual(parseReport(`state=idle:id=${'a'.repeat(33)}`).report, undefined);
  assert.ok(parseReport(`state=idle:id=${Array(8).fill('a').join('/')}`).report);
  assert.strictEqual(parseReport(`state=idle:id=${Array(9).fill('a').join('/')}`).report, undefined);
  for (const bad of ['/a', 'a/', 'a//b']) assert.strictEqual(parseReport(`state=idle:id=${bad}`).report, undefined, bad);
});

test('an id of 128 bytes is kept, 129 is refused', () => {
  const ok = ['a'.repeat(32), 'a'.repeat(32), 'a'.repeat(32), 'a'.repeat(29)].join('/');   // 96 + 29 + 3 slashes
  assert.strictEqual(Buffer.byteLength(ok), 128);
  assert.ok(parseReport(`state=idle:id=${ok}`).report);
  const over = ['a'.repeat(32), 'a'.repeat(32), 'a'.repeat(32), 'a'.repeat(30)].join('/');
  assert.strictEqual(Buffer.byteLength(over), 129);
  assert.strictEqual(parseReport(`state=idle:id=${over}`).report, undefined);
});

test('an id may not hold "=" tricks: the value is everything after the first "="', () => {
  assert.strictEqual(parseReport('state=idle:id=a=b').report.id, 'a=b');
});

// --- properties -----------------------------------------------------------------

test('property: title and msg survive base64 exactly, any text within the limit', () => {
  const noControl = fc.string({ unit: 'binary', maxLength: 40 }).filter(s => Buffer.from(s, 'utf8').toString('utf8') === s);
  fc.assert(fc.property(noControl, noControl, (title, msg) => {
    const t = Buffer.from(title, 'utf8'); const m = Buffer.from(msg, 'utf8');
    fc.pre(t.length <= 192 && m.length <= 2048);
    const r = parseReport(`state=idle:title=${t.toString('base64')}:msg=${m.toString('base64')}`);
    assert.strictEqual(r.report.title, title);
    assert.strictEqual(r.report.msg, msg);
  }), { numRuns: 300 });
});

test('property: a decoded title over 192 bytes is always refused', () => {
  fc.assert(fc.property(fc.integer({ min: 193, max: 400 }), (n) => {
    assert.strictEqual(parseReport(`state=idle:title=${b64('a'.repeat(n))}`).report, undefined);
  }), { numRuns: 100 });
});

test('property: anything over 4096 bytes is refused, whatever it holds', () => {
  fc.assert(fc.property(fc.string({ minLength: 4097, maxLength: 4200, unit: 'grapheme-ascii' }), (s) => {
    assert.strictEqual(parseReport('state=idle:zz=' + s).report, undefined);
  }), { numRuns: 50 });
});

test('property: a valid id of up to 8 segments of 1..32 bytes within 128 total is kept verbatim', () => {
  const seg = fc.stringMatching(/^[a-z0-9_.-]{1,32}$/);
  fc.assert(fc.property(fc.array(seg, { minLength: 1, maxLength: 8 }), (segs) => {
    const id = segs.join('/');
    const r = parseReport(`state=idle:id=${id}`);
    if (Buffer.byteLength(id) <= 128) assert.strictEqual(r.report.id, id);
    else assert.strictEqual(r.report, undefined);
  }), { numRuns: 300 });
});

test('property: parseReport never throws on any string', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
    const r = parseReport(s);
    assert.ok(r && typeof r === 'object');
  }), { numRuns: 500 });
});

// --- the record store -----------------------------------------------------------

const rep = (state, extra = {}) => ({ state, id: '', kind: null, progress: null, app: null, title: null, msg: null, ...extra });

test('a report replaces its record, it does not merge', () => {
  const s = createProgramStatus();
  s.apply(rep('blocked', { kind: 'permission', msg: 'Allow?' }));
  s.apply(rep('working'));
  assert.deepStrictEqual(s.root(), rep('working'));
});

test('root is the record with no id; children are the rest', () => {
  const s = createProgramStatus();
  s.apply(rep('working'));
  s.apply(rep('blocked', { id: 'a', kind: 'question' }));
  s.apply(rep('done', { id: 'a/b' }));
  assert.strictEqual(s.root().state, 'working');
  assert.deepStrictEqual(s.snapshot().children.map(c => c.id), ['a', 'a/b']);
});

test('apply says whether anything changed', () => {
  const s = createProgramStatus();
  assert.strictEqual(s.apply(rep('working')), true);
  assert.strictEqual(s.apply(rep('working')), false);
  assert.strictEqual(s.apply(rep('done')), true);
  assert.strictEqual(s.apply(rep('clear', { id: 'nope' })), false);
});

test('clear with an id removes that record and its children, nothing else', () => {
  const s = createProgramStatus();
  for (const id of ['a', 'a/b', 'a/b/c', 'ab', 'z']) s.apply(rep('working', { id }));
  s.apply(rep('working'));
  assert.strictEqual(s.apply(rep('clear', { id: 'a' })), true);
  assert.deepStrictEqual(s.snapshot().children.map(c => c.id), ['ab', 'z']);
  assert.strictEqual(s.root().state, 'working');
});

test('clear with no id clears everything', () => {
  const s = createProgramStatus();
  s.apply(rep('working')); s.apply(rep('done', { id: 'a' }));
  assert.strictEqual(s.apply(rep('clear')), true);
  assert.strictEqual(s.root(), null);
  assert.deepStrictEqual(s.snapshot().children, []);
});

test('a new prompt or an exit drops working and blocked records, keeps done and error', () => {
  const s = createProgramStatus();
  s.apply(rep('working')); s.apply(rep('blocked', { id: 'a' })); s.apply(rep('done', { id: 'b' })); s.apply(rep('error', { id: 'c' })); s.apply(rep('idle', { id: 'd' }));
  assert.strictEqual(s.dropActive(), true);
  assert.deepStrictEqual(s.snapshot().children.map(c => c.id), ['b', 'c', 'd']);
  assert.strictEqual(s.root(), null);
  assert.strictEqual(s.dropActive(), false);
});

test('reset (RIS) clears all; the protocol stays live', () => {
  const s = createProgramStatus();
  s.apply(rep('done'));
  assert.strictEqual(s.reset(), true);
  assert.strictEqual(s.root(), null);
  assert.strictEqual(s.live(), true);
  assert.strictEqual(s.reset(), false);
});

test('live() is false until a valid report arrives, then stays true even after a clear', () => {
  const s = createProgramStatus();
  assert.strictEqual(s.live(), false);
  s.apply(rep('clear'));
  assert.strictEqual(s.live(), true);
});

test('the store holds at most 256 records and at least 64; the root is never the one evicted', () => {
  assert.strictEqual(MAX_RECORDS, 256);
  assert.strictEqual(MIN_RECORDS, 64);
  const s = createProgramStatus();
  s.apply(rep('working'));
  for (let i = 0; i < 400; i++) s.apply(rep('done', { id: `t${i}` }));
  const snap = s.snapshot();
  assert.strictEqual(snap.children.length + 1, 256);
  assert.strictEqual(s.root().state, 'working');
  assert.strictEqual(snap.children[snap.children.length - 1].id, 't399');   // newest kept
  assert.strictEqual(snap.children[0].id, 't145');                          // oldest went first
});

test('replacing an existing id never evicts anything', () => {
  const s = createProgramStatus();
  for (let i = 0; i < 256; i++) s.apply(rep('done', { id: `t${i}` }));
  s.apply(rep('working', { id: 't0' }));
  assert.strictEqual(s.snapshot().children.length, 256);
});

test('property: the store never exceeds 256 records whatever is reported', () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom('idle', 'working', 'done', 'blocked', 'error', 'clear'), fc.stringMatching(/^[a-c]{0,2}(\/[a-c]{1,2}){0,2}$/)), { maxLength: 600 }), (ops) => {
    const s = createProgramStatus();
    for (const [state, id] of ops) s.apply(rep(state, { id }));
    const snap = s.snapshot();
    assert.ok(snap.children.length + (snap.root ? 1 : 0) <= 256);
  }), { numRuns: 100 });
});

test('the snapshot is plain data a socket can carry, without a timestamp that would make every report a change', () => {
  const s = createProgramStatus();
  s.apply(rep('blocked', { kind: 'auth', msg: 'Log in' }));
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  assert.deepStrictEqual(snap, { live: true, root: rep('blocked', { kind: 'auth', msg: 'Log in' }), children: [] });
});

// --- PR #201 Miguel R4: what goes over the socket is bounded ------------------------------------------------------

const { frameOf, FRAME_CHILDREN, FRAME_MSG } = require('../host/program-status');

test('frameOf carries the root and at most 32 children, each msg cut to 500 characters, plus the true child count', () => {
  assert.strictEqual(FRAME_CHILDREN, 32);
  assert.strictEqual(FRAME_MSG, 500);
  const s = createProgramStatus();
  s.apply(rep('blocked', { msg: 'm'.repeat(2048) }));
  for (let i = 0; i < 255; i++) s.apply(rep('working', { id: `t${i}`, msg: 'c'.repeat(2048) }));
  const f = frameOf(s.snapshot());
  assert.strictEqual(f.live, true);
  assert.strictEqual(f.root.msg.length, 500);
  assert.strictEqual(f.children.length, 32);
  assert.ok(f.children.every(c => c.msg.length === 500));
  assert.strictEqual(f.childCount, 255);
  assert.ok(JSON.stringify(f).length < 25000, 'a frame stays small whatever the store holds');
});

test('frameOf keeps absence as null and the newest children are the ones sent', () => {
  const f = frameOf(createProgramStatus().snapshot());
  assert.deepStrictEqual(f, { live: false, root: null, children: [], childCount: 0 });
  const s = createProgramStatus();
  for (let i = 0; i < 40; i++) s.apply(rep('done', { id: `t${i}` }));
  const g = frameOf(s.snapshot());
  assert.strictEqual(g.children[g.children.length - 1].id, 't39');
  assert.strictEqual(g.childCount, 40);
});

test('property: a frame never holds more than 33 records or a msg over 500 whatever was reported', () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.stringMatching(/^[a-d]{0,3}$/), fc.string({ maxLength: 900 })), { maxLength: 300 }), (ops) => {
    const s = createProgramStatus();
    for (const [id, msg] of ops) s.apply(rep('working', { id, msg }));
    const f = frameOf(s.snapshot());
    assert.ok(f.children.length <= 32);
    for (const r of [f.root, ...f.children]) if (r) assert.ok(r.msg === null || r.msg.length <= 500);
  }), { numRuns: 100 });
});
