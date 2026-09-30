'use strict';
/**
 * WORKTREE_PORT_BASE (Extension X3): each worktree gets its own block of 100
 * ports in 20000-48999 -- clear of the host range 7700-7799 and below Windows'
 * dynamic range (49152+) -- so two worktrees' dev servers never collide.
 * First free block per worktree path, persisted in ONE user-wide file so two
 * projects never share a block and a restart keeps it. Blocks overlapping
 * Windows' excluded port ranges (Hyper-V, WSL and Docker reserve some) are
 * skipped. A worktree that no longer exists gives its block back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { allocate, parseExcludedRanges, excludedRanges, RANGE_START, RANGE_LAST_BASE, BLOCK } =
  require('../host/port-blocks');
const { normPath } = require('../host/project-layout');
const { tmpDir } = require('./tmp-dir');

const portsFile = () => path.join(tmpDir('port-blocks-'), 'state', 'worktree-ports.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// Folders that "exist", compared the way the module keys them.
function world(...paths) {
  const set = new Set(paths.map(normPath));
  // A drive root is always there unless a test says otherwise: pruning only
  // ever frees a block on a drive that is present (Miguel G5).
  return { set, exists: p => set.has(normPath(p)) || /^[a-z]:\\$/.test(normPath(p)) };
}

test('the range and block size are what the design says', () => {
  assert.strictEqual(RANGE_START, 20000);
  assert.strictEqual(RANGE_LAST_BASE, 48900);
  assert.strictEqual(BLOCK, 100);
});

test('the first worktree gets the first block, and it is written down', () => {
  const file = portsFile();
  const w = world('C:\\p\\feat-a');
  assert.strictEqual(allocate('C:\\p\\feat-a', { file, exists: w.exists }), 20000);
  assert.deepStrictEqual(read(file), { version: 1, blocks: { [normPath('C:\\p\\feat-a')]: 20000 } });
});

test('the same worktree keeps its block, however its path is spelled', () => {
  const file = portsFile();
  const w = world('C:\\p\\feat-a');
  allocate('C:\\p\\feat-a', { file, exists: w.exists });
  assert.strictEqual(allocate('c:/P/Feat-A/', { file, exists: w.exists }), 20000);
});

test('a second worktree gets the next block', () => {
  const file = portsFile();
  const w = world('C:\\p\\a', 'C:\\q\\b');
  assert.strictEqual(allocate('C:\\p\\a', { file, exists: w.exists }), 20000);
  assert.strictEqual(allocate('C:\\q\\b', { file, exists: w.exists }), 20100);
});

test('a removed worktree gives its block back to the next one', () => {
  const file = portsFile();
  const w = world('C:\\p\\a', 'C:\\p\\b', 'C:\\p\\c');
  allocate('C:\\p\\a', { file, exists: w.exists });
  allocate('C:\\p\\b', { file, exists: w.exists });
  w.set.delete(normPath('C:\\p\\a'));
  assert.strictEqual(allocate('C:\\p\\c', { file, exists: w.exists }), 20000);
  assert.ok(!(normPath('C:\\p\\a') in read(file).blocks));
});

test('a block overlapping an excluded range is skipped; one merely touching it is not', () => {
  const w = world('C:\\p\\a');
  assert.strictEqual(allocate('C:\\p\\a', { file: portsFile(), exists: w.exists, excluded: [{ start: 20099, end: 20099 }] }), 20100);
  assert.strictEqual(allocate('C:\\p\\a', { file: portsFile(), exists: w.exists, excluded: [{ start: 19000, end: 19999 }, { start: 20100, end: 20150 }] }), 20000);
  assert.strictEqual(allocate('C:\\p\\a', { file: portsFile(), exists: w.exists, excluded: [{ start: 19950, end: 20000 }] }), 20100);
});

test('a kept block that Windows has since excluded is moved', () => {
  const file = portsFile();
  const w = world('C:\\p\\a');
  allocate('C:\\p\\a', { file, exists: w.exists });
  assert.strictEqual(allocate('C:\\p\\a', { file, exists: w.exists, excluded: [{ start: 20010, end: 20020 }] }), 20100);
  assert.strictEqual(read(file).blocks[normPath('C:\\p\\a')], 20100);
});

test('when every block is taken, there is no block (null), and nothing is lost', () => {
  const file = portsFile();
  const blocks = {};
  const paths = [];
  for (let b = 20000, i = 0; b <= 48900; b += 100, i++) { const p = `C:\\full\\w${i}`; paths.push(p); blocks[normPath(p)] = b; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks }));
  const w = world(...paths, 'C:\\full\\new');
  assert.strictEqual(allocate('C:\\full\\new', { file, exists: w.exists }), null);
  assert.strictEqual(Object.keys(read(file).blocks).length, paths.length);
});

test('a corrupt file is set aside, not trusted and not silently overwritten', () => {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version":1,"blocks":{');
  const w = world('C:\\p\\a');
  assert.strictEqual(allocate('C:\\p\\a', { file, exists: w.exists }), 20000);
  const aside = fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('worktree-ports.json.corrupt-'));
  assert.strictEqual(aside.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8'), '{"version":1,"blocks":{');
});

test('a file of the wrong shape is set aside too', () => {
  for (const bad of ['[]', '{"version":1,"blocks":[]}', '{"blocks":{}}', 'null']) {
    const file = portsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bad);
    assert.strictEqual(allocate('C:\\p\\a', { file, exists: world('C:\\p\\a').exists }), 20000, bad);
    assert.strictEqual(fs.readdirSync(path.dirname(file)).filter(n => n.includes('.corrupt-')).length, 1, bad);
  }
});

test('entries that are not valid blocks are dropped, valid ones kept', () => {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const w = world('C:\\p\\a', 'C:\\p\\b', 'C:\\p\\c', 'C:\\p\\d', 'C:\\p\\new');
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks: {
    [normPath('C:\\p\\a')]: 20050, [normPath('C:\\p\\b')]: '20100', [normPath('C:\\p\\c')]: 49000, [normPath('C:\\p\\d')]: 20200,
  } }));
  assert.strictEqual(allocate('C:\\p\\new', { file, exists: w.exists }), 20000);
  assert.deepStrictEqual(read(file).blocks, { [normPath('C:\\p\\d')]: 20200, [normPath('C:\\p\\new')]: 20000 });
});

test('a lock it cannot get means no block, not an error and not a wait', () => {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.strictEqual(allocate('C:\\p\\a', { file, exists: world('C:\\p\\a').exists, deadlineMs: 0 }), null);
});

test('no worktree, no block', () => {
  assert.strictEqual(allocate(null, { file: portsFile() }), null);
  assert.strictEqual(allocate('', { file: portsFile() }), null);
});

test('the file\'s folder is created on first use, and no temp file is left', () => {
  const file = portsFile();
  allocate('C:\\p\\a', { file, exists: world('C:\\p\\a').exists });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['worktree-ports.json']);
});

const NETSH = [
  'Protocol tcp Port Exclusion Ranges', '', 'Start Port    End Port      ', '----------    --------      ',
  '     50000       50059     *', '     50816       50915      ', '     20400       20400      ', '', '* - Administered port exclusions.', '',
].join('\r\n');

test('netsh\'s table is parsed into ranges, junk and headers ignored', () => {
  assert.deepStrictEqual(parseExcludedRanges(NETSH),
    [{ start: 50000, end: 50059 }, { start: 50816, end: 50915 }, { start: 20400, end: 20400 }]);
  assert.deepStrictEqual(parseExcludedRanges('     9   5'), [], 'start after end');
  assert.deepStrictEqual(parseExcludedRanges(null), []);
});

test('excluded ranges are the union of IPv4 and IPv6; a failed query contributes nothing', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (args.includes('ipv6')) return '     21000       21099\r\n     50000       50059     *\r\n';
    return NETSH;
  };
  const r = await excludedRanges({ exec });
  assert.deepStrictEqual(r, [{ start: 20400, end: 20400 }, { start: 21000, end: 21099 }, { start: 50000, end: 50059 }, { start: 50816, end: 50915 }]);
  assert.ok(calls.some(c => /netsh int ipv4 show excludedportrange protocol=tcp/.test(c)));
  assert.ok(calls.some(c => /netsh int ipv6 show excludedportrange protocol=tcp/.test(c)));

  const failing = async (file, args) => { if (args.includes('ipv4')) throw new Error('x'); return '  21000  21099\r\n'; };
  assert.deepStrictEqual(await excludedRanges({ exec: failing }), [{ start: 21000, end: 21099 }]);
  assert.deepStrictEqual(await excludedRanges({ exec: async () => { throw new Error('x'); } }), []);
});

test('off Windows there are no excluded ranges to ask about', async () => {
  let called = false;
  assert.deepStrictEqual(await excludedRanges({ platform: 'linux', exec: async () => { called = true; return ''; } }), []);
  assert.strictEqual(called, false);
});

test('PROPERTY: blocks are unique, in range, on a boundary, clear of exclusions, and stable', () => {
  const PATHS = ['C:\\p\\a', 'C:\\p\\b', 'C:\\q\\c', 'D:\\d', 'C:\\p\\e'];
  fc.assert(fc.property(
    fc.array(fc.record({ start: fc.integer({ min: 19900, max: 21000 }), len: fc.integer({ min: 0, max: 250 }) }), { maxLength: 3 }),
    fc.array(fc.oneof(
      fc.record({ op: fc.constant('alloc'), i: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ op: fc.constant('remove'), i: fc.integer({ min: 0, max: 4 }) }),
    ), { minLength: 1, maxLength: 20 }),
    (ex, cmds) => {
      const excluded = ex.map(e => ({ start: e.start, end: e.start + e.len }));
      const file = portsFile();
      const w = world();
      const last = new Map();
      for (const c of cmds) {
        const p = PATHS[c.i];
        if (c.op === 'remove') { w.set.delete(normPath(p)); last.delete(p); continue; }
        w.set.add(normPath(p));
        const base = allocate(p, { file, exists: w.exists, excluded });
        assert.ok(base !== null, 'five worktrees always fit');
        assert.ok(base >= 20000 && base <= 48900 && (base - 20000) % 100 === 0, `bad base ${base}`);
        assert.ok(excluded.every(r => r.end < base || r.start > base + 99), `base ${base} overlaps an exclusion`);
        if (last.has(p)) assert.strictEqual(base, last.get(p), 'a live worktree\'s block moved');
        last.set(p, base);
        const values = Object.values(read(file).blocks);
        assert.strictEqual(new Set(values).size, values.length, 'two worktrees share a block');
      }
    }), { numRuns: 200 });
});

test('IPv4 and IPv6 are asked at the same time, not one after the other (Miguel, PR #71 Y2)', async () => {
  let inFlight = 0;
  let most = 0;
  const exec = async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise(r => setImmediate(r));
    inFlight--;
    return '';
  };
  await excludedRanges({ exec, platform: 'win32' });
  assert.strictEqual(most, 2);
});

// Dexter F3 / Miguel G5 (PR #71): pruning asked the filesystem about every
// saved path INSIDE the file lock. An offline network path answers after ~20 s,
// past file-lock's 10 s stale rule, so a second host broke the lock and both
// handed out the same block. And an unplugged drive's worktree lost its block.

test('a worktree on a drive that is not there keeps its block', () => {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks: { [normPath('X:\\usb\\wt')]: 20000 } }));
  const exists = p => normPath(p) === normPath('C:\\p\\a');     // X:\ is unplugged
  assert.strictEqual(allocate('C:\\p\\a', { file, exists }), 20100);
  assert.strictEqual(read(file).blocks[normPath('X:\\usb\\wt')], 20000);
});

test('a network path is never pruned: offline and gone look the same', () => {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unc = normPath('\\\\nas\\share\\wt');
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks: { [unc]: 20000 } }));
  let askedAboutUnc = false;
  const exists = p => { if (normPath(p).startsWith('\\\\')) askedAboutUnc = true; return true; };
  assert.strictEqual(allocate('C:\\p\\a', { file, exists }), 20100);
  assert.strictEqual(read(file).blocks[unc], 20000);
  assert.strictEqual(askedAboutUnc, false, 'a network path is not even asked about');
});

test('the filesystem is asked about saved paths OUTSIDE the file lock', () => {
  const file = portsFile();
  const w = world('C:\\p\\a', 'C:\\p\\b');
  allocate('C:\\p\\a', { file, exists: w.exists });
  const heldDuring = [];
  const exists = p => { heldDuring.push(fs.existsSync(`${file}.lock`)); return w.exists(p); };
  allocate('C:\\p\\b', { file, exists });
  assert.ok(heldDuring.length > 0, 'the saved path was checked at all');
  assert.deepStrictEqual(heldDuring.filter(Boolean), [], 'no existence check ran while the lock was held');
});
