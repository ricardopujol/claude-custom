'use strict';
/**
 * When the panel is told about running processes and the party.
 *
 * Two senders share one message: a hook event (something started or stopped)
 * and the host's once-a-second tick. The tick used to send only while a process
 * was running, which is right for the rising edge -- elapsed times need to tick
 * up -- and wrong for the falling one. When mood.tick() reaped stranded
 * background instances with no processes left, the party shrank and the panel
 * was never told, so a sleeping card kept "×2 running now" (Dexter, PR #34,
 * Finding 6). host.js's cooldowns broadcast learned the same lesson.
 *
 * So the tick also sends whenever the party differs from what was LAST SENT --
 * by either sender -- and stays quiet when nothing runs and nothing changed.
 */

function createProcessesBroadcast(broadcast) {
  let lastParty = null;           // JSON of the party last sent; null = never sent
  let lastRan = false;            // whether the last message sent listed any running row

  function send(running, party) {
    broadcast({ type: 'processes', running, party });
    lastParty = JSON.stringify(party);
    lastRan = running.length > 0;
  }

  // The running list's falling edge counts too: when processes.sweep() removes
  // the last stale row, nothing runs and the party may be unchanged, yet the
  // panel still shows that row until it is told (#45).
  function tick(running, party) {
    if (running.length || lastRan || JSON.stringify(party) !== lastParty) send(running, party);
  }

  return { send, tick };
}

module.exports = { createProcessesBroadcast };
