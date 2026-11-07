'use strict';
/**
 * The source of a CPU spinner a probe starts as `node -e <source>` (verify/probe-renderer-backgrounding.js --load; BACKLOG
 * #113 M1). The old spinner was a bare `for(;;){}`: a probe killed hard (a tool timeout, Stop-Process) left it spinning one
 * core forever, and nothing recorded it. This one ends itself:
 *   - when the process that started it is gone (checked about every 20 ms with process.kill(pid, 0), which only tests
 *     liveness), so a dead probe's spinners stop within a fraction of a second, whatever killed it;
 *   - after `maxMs` in any case, so even a reused parent pid can't keep it alive past the probe's own limit.
 * Both the 20 ms cadence and the cap run on performance.now(), a monotonic clock (#237 Dexter 8): a wall-clock step back
 * would spin unchecked for that long, and a step forward (a resume from sleep) would end every spinner mid-measurement.
 * The probe still records each spinner with noteChild (the heavy lock's work record) and stops it by its handle when it
 * ends; this is the net under both.
 */
function spinnerSource(parentPid, maxMs) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error(`spinnerSource: a parent pid is required, got ${parentPid}`);
  if (!Number.isInteger(maxMs) || maxMs <= 0) throw new Error(`spinnerSource: a positive maxMs is required, got ${maxMs}`);
  return `const p=${parentPid},end=performance.now()+${maxMs};`
    + 'for(;;){const t=performance.now()+20;while(performance.now()<t){}'
    + 'if(performance.now()>end)process.exit(0);'
    + 'try{process.kill(p,0)}catch(e){process.exit(0)}}';
}

module.exports = { spinnerSource };
