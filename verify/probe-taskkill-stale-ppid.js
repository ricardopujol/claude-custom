'use strict';
require('./lib/launch-electron');   // #243 Miguel I4: takes the heavy-work lock: up to 4000 node starts one after another are load
/* PROBE (re-runnable): does `taskkill /PID n /T` follow a STALE parent link? (PR #113, Dexter finding 1)
 *
 *   node verify/probe-taskkill-stale-ppid.js        (exit 0 = measured; the verdict is printed either way)
 *
 * Windows never rewrites a ParentProcessId when the parent dies, and it reuses pids. So an orphan O whose parent P died
 * still names P's pid; when a NEW process Q gets that pid, O looks like Q's child. This probe builds exactly that, using
 * only processes it starts itself (each by its own PID, never by name):
 *   1. P (a node sleeper) starts O (a node sleeper) and waits.
 *   2. P is killed by its PID. O lives on with ppid = P's pid.
 *   3. New sleepers Q are started (and ended by their own PID when they miss) until one gets P's pid.
 *   4. `taskkill /PID Q /T /F`: does O die, although it started BEFORE Q?
 * Step 3 can start up to 4000 node sleepers, one after another, until one lands on P's pid: a few idle ones alive at a time,
 * every one ended by its own PID, but thousands of starts are load, so it takes the heavy-work lock itself (#243 Miguel I4).
 */
const { spawn, spawnSync } = require('child_process');
const sleeperSrc = 'setTimeout(() => {}, 90000)';
const mine = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const endMine = () => { for (const pid of mine) { try { process.kill(pid); } catch { /* gone */ } } };   // kill-ok(own-spawn): this probe's own sleepers; the experiment is about pid reuse itself
process.on('exit', endMine);

function sleeper() {
  const c = spawn(process.execPath, ['-e', sleeperSrc], { stdio: 'ignore', windowsHide: true });   // lock-ok: an idle node sleeper this probe ends by its own pid; a noteChild per start (a 1 s query) would break the pid-reuse race
  mine.add(c.pid);
  return c;
}

async function main() {
  // P starts O and reports its pid on stdout, then waits.
  const parentSrc = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(sleeperSrc)}],{stdio:'ignore',windowsHide:true,detached:true});c.unref();console.log(c.pid);setTimeout(()=>{},90000)`;
  const P = spawn(process.execPath, ['-e', parentSrc], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });   // lock-ok: the sleeper parent P, ended by its own pid within the step
  mine.add(P.pid);
  const oPid = await new Promise((resolve) => { P.stdout.once('data', d => resolve(Number(String(d).trim()))); });
  mine.add(oPid);
  console.log(`P=${P.pid} started O=${oPid}`);
  P.kill();   // through the handle (PR #130, Dexter #1): the same TerminateProcess, but never a reused pid
  await sleep(300);
  console.log(`P killed by its pid; O still alive: ${alive(oPid)}`);

  let q = null;
  for (let i = 0; i < 4000 && !q; i++) {
    const c = sleeper();
    if (c.pid === P.pid) q = c;
    else { try { c.kill(); } catch { /* gone */ } mine.delete(c.pid); await sleep(2); }
  }
  if (!q) { console.log('INCONCLUSIVE: no new process got the freed pid in 4000 tries (nothing was killed by /T)'); return 2; }
  console.log(`Q=${q.pid} got P's old pid; O (${oPid}) started before Q and names it as parent`);
  // The experiment itself is a raw `taskkill /T` (its status is the measurement), so it runs only while q, which this
  // probe spawned and still holds, is provably running.
  if (q.exitCode !== null || q.signalCode !== null) { console.log('INCONCLUSIVE: Q exited before the taskkill'); return 2; }
  const qPid = q.pid;
  const r = spawnSync('taskkill', ['/PID', String(qPid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });   // kill-ok(own-spawn): the experiment's taskkill /T, gated two lines up on q (held) still running
  await sleep(500);
  const oDied = !alive(oPid);
  console.log(`Q: taskkill /PID ${q.pid} /T /F -> status ${r.status}; O alive after: ${!oDied}`);
  console.log(oDied
    ? 'FINDING: /T FOLLOWS A STALE PARENT LINK (no start-time check): it killed an older orphan that only names the reused pid.'
    : 'FINDING: /T did not kill the older orphan here.');
  return 0;
}
main().then((code) => { endMine(); process.exit(code); }, (e) => { console.error(e); endMine(); process.exit(1); });
