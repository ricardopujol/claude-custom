'use strict';
/**
 * Stop the hosts a dead verify/ probe left behind (BACKLOG #169).
 *
 *   node verify/sweep-orphans.js            report what it would stop (dry run)
 *   node verify/sweep-orphans.js --stop     stop it
 *   node verify/sweep-orphans.js --dir <path>   read another folder's hosts/ (default: this checkout's .harness)
 *
 * Only hosts whose identity file carries a probe's mark (host/probe-mark.js), whose own pid is proven by its recorded start
 * time, and whose parent AND launching probe are both gone are ever stopped; every proof is in verify/lib/orphan-sweep.js. A
 * host without the mark, a person's live window, and a host its probe is still using are left alone, and each is said once.
 * Nothing is matched by name. Electron roots a probe launched are verify/reap-probes.js's (the ledger); this is for the hosts.
 */
const path = require('path');
const { sweep } = require('./lib/orphan-sweep');

function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const stop = argv.includes('--stop');
  const i = argv.indexOf('--dir');
  const dir = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(__dirname, '..', '.harness');
  const r = sweep({ dir, dryRun: !stop });
  if (r.unknown) { log('the process table could not be read; nothing was touched'); return 2; }
  log(`${r.files} identity file${r.files === 1 ? '' : 's'} in ${path.join(dir, 'hosts')}: ${r.marked} marked, ${r.unmarked} unmarked (never touched), ${r.unreadable} unreadable`);
  for (const l of r.left) log(`  left   pid ${l.pid} port ${l.port}: ${l.why}`);
  for (const w of r.wouldStop) log(`  ${stop ? 'orphan' : 'would stop'} pid ${w.pid} port ${w.port}: ${w.why}`);
  for (const s of r.stopped) log(`  stopped pid ${s.pid} port ${s.port}`);
  for (const f of r.failed) log(`  FAILED  pid ${f.pid} port ${f.port}: ${f.outcome}`);
  if (r.wouldStop.length === 0) log('no orphaned probe hosts; nothing stopped');
  else if (!stop) log(`${r.wouldStop.length} would be stopped (run with --stop)`);
  else log(`stopped ${r.stopped.length}, failed ${r.failed.length}`);
  return r.failed.length ? 1 : 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
