'use strict';
/**
 * host/dev-servers.js against a REAL PowerShell (PR #198 Dexter r2 N5): kept out of test/dev-servers.test.js, which Stryker re-runs for every mutant.
 *
 * DETERMINISTIC ON A BUSY MACHINE (BACKLOG #178 a). The test reads the machine's real port table, and other lanes open and close ports all the
 * time. It used to compare two samples and assume nothing changed between them: one failed under load ("every pair already checked: no table
 * read") when another lane started listening in between, and the table read was then RIGHT. Now:
 *   - it brings its own listener (127.0.0.1, an OS-picked port, this process's pid), and waits, bounded, for the table to list it: the one
 *     fact the rest needs, which no other lane can take away;
 *   - "every pair checked: no table read" is asserted exactly, and in both directions on each sample: a sample that did NOT read the table saw
 *     no pair it wasn't sent, and a sample that DID read it saw one (its own listener rows are what it compared, so this is exact). A sample
 *     justified by a new listener is retried with that pair added, up to 5 times;
 *   - the "one pair unseen" step drops THIS test's own pair, which is still listening, so the read can't be undone by another lane's server
 *     going away (pairs[0] used to be whatever the machine listed first).
 * TOLERANCE: it fails only if five samples in a row each see a new listener, i.e. the machine's ports never hold still for one round trip.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const ds = require('../host/dev-servers');

const key = (p) => `${p.pid}:${p.port}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('real PowerShell: the table is read again when a listener is a pid:port pair the cache was not checked against (a stranger on a reused pid)', async () => {
  const { createPersistentExec } = require('../host/persistent-powershell');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const mine = { pid: process.pid, port: server.address().port };
  const ex = createPersistentExec();
  try {
    let first = null;
    for (let i = 0; i < 10; i++) {
      first = ds.parseTable(await ex(ds.scriptFor({ force: true })));
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.fresh, true);
      if (first.pairs.some(p => key(p) === key(mine))) break;
      await sleep(200);
    }
    assert.ok(first.pairs.some(p => key(p) === key(mine)), `this test's own listener ${key(mine)} is in the table within about 2 s`);

    let sent = first.pairs;
    let quiet = null;
    for (let i = 0; i < 5 && !quiet; i++) {
      const same = ds.parseTable(await ex(ds.scriptFor({ pairs: sent, force: false })));
      assert.strictEqual(same.ok, true);
      const sentKeys = new Set(sent.map(key));
      const unseen = same.pairs.filter(p => !sentKeys.has(key(p)));
      if (!same.fresh) {
        assert.deepStrictEqual(unseen, [], 'a sample that saw a pair it was not sent must read the table');
        quiet = same;
        break;
      }
      assert.ok(unseen.length > 0, `every pair already checked: no table read (sent ${sent.length}, it saw ${same.pairs.length}, none new)`);
      sent = [...sent, ...unseen];   // a new listener on the machine justified that read: check again with it known
    }
    assert.ok(quiet, 'five samples in a row each saw a new listener: the machine\'s ports never held still for one round trip');

    const dropped = ds.parseTable(await ex(ds.scriptFor({ pairs: sent.filter(p => key(p) !== key(mine)), force: false })));
    assert.strictEqual(dropped.ok, true);
    assert.strictEqual(dropped.fresh, true, 'one pair unseen (this test\'s own, still listening; the same pid may be cached): the table is read');
  } finally {
    ex.close();
    await new Promise(r => server.close(r));
  }
});
