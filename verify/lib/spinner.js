'use strict';
/**
 * The source of a CPU spinner a probe starts as `node -e <source>` (verify/probe-renderer-backgrounding.js --load; BACKLOG
 * #113 M1). The old spinner was a bare `for(;;){}`: a probe killed hard (a tool timeout, Stop-Process) left it spinning one
 * core forever, and nothing recorded it. This one ends itself:
 *   - when the process that started it is gone (checked about every 20 ms with process.kill(pid, 0), which only tests
 *     liveness), so a dead probe's spinners stop within a fraction of a second, whatever killed it;
 *   - after `maxMs` in any case, so even a reused parent pid can't keep it alive past the probe's own limit.
 * The probe still records each spinner with noteChild (the heavy lock's work record) and stops it by its handle when it
 * ends; this is the net under both.
 */
function spinnerSource(parentPid, maxMs) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error(`spinnerSource: a parent pid is required, got ${parentPid}`);
  if (!Number.isInteger(maxMs) || maxMs <= 0) throw new Error(`spinnerSource: a positive maxMs is required, got ${maxMs}`);
  return `const p=${parentPid},end=Date.now()+${maxMs};`
    + 'for(;;){const t=Date.now()+20;while(Date.now()<t){}'
    + 'if(Date.now()>end)process.exit(0);'
    + 'try{process.kill(p,0)}catch(e){process.exit(0)}}';
}

module.exports = { spinnerSource };
