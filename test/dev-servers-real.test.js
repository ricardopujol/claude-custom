'use strict';
/**
 * host/dev-servers.js against a REAL PowerShell (PR #198 Dexter r2 N5): kept out of test/dev-servers.test.js, which Stryker re-runs for every mutant.
 */
const test = require('node:test');
const assert = require('node:assert');
const ds = require('../host/dev-servers');

test('real PowerShell: the table is read again when a listener is a pid:port pair the cache was not checked against (a stranger on a reused pid)', async () => {
  const { createPersistentExec } = require('../host/persistent-powershell');
  const ex = createPersistentExec();
  try {
    const first = ds.parseTable(await ex(ds.scriptFor({ force: true })));
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.fresh, true);
    const pairs = first.pairs;
    const same = ds.parseTable(await ex(ds.scriptFor({ pairs, force: false })));
    assert.strictEqual(same.fresh, false, 'every pair already checked: no table read');
    const dropped = ds.parseTable(await ex(ds.scriptFor({ pairs: pairs.filter(p => !(p.pid === pairs[0].pid && p.port === pairs[0].port)), force: false })));
    assert.strictEqual(dropped.fresh, true, 'one pair unseen (the same pid may be cached): the table is read');
  } finally { ex.close(); }
});
