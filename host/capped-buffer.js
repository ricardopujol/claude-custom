'use strict';
/**
 * Keeps the FIRST and LAST `cap` bytes of a stream, never holding more.
 *
 * Two reasons a child process's output cannot simply be accumulated in the
 * host: past V8's ~512MB string limit `out +=` throws RangeError inside a
 * 'data' listener, killing the host and the user's live session; and long
 * before that, growing a huge string forces major GC pauses in the one event
 * loop that must accept the hook helper's connection within 80ms.
 *
 * HEAD *AND* TAIL, because test runners disagree about where the summary goes:
 *
 *   pytest     prints its counts LAST                    -> the tail has it
 *   node:test  prints its counters, THEN the failing-    -> the HEAD has it
 *              tests detail, which is the bulk
 *
 * A blind tail was measured losing node:test's counter block at roughly 48
 * failures. On a real 120-failure run the counters sit 2,845 bytes in and the
 * output is 116KB, so the last 64KB contains no counters at all and the suite
 * reported "unknown" instead of "critical" -- the exact defect this project
 * called blocker-grade for pytest, reintroduced for its own default runner,
 * firing precisely when the bar matters most.
 *
 * Lives in its own file because requiring host.js boots a pty and a WebSocket
 * server; a helper nothing can require is a helper nothing can test.
 */

function createCappedBuffer(cap) {
  if (!(cap > 0)) throw new Error('createCappedBuffer: cap must be positive');
  let head = '';
  let tail = '';
  let dropped = 0;

  return {
    push(chunk) {
      const text = String(chunk == null ? '' : chunk);
      let rest = text;
      if (head.length < cap) {
        const room = cap - head.length;
        head += text.slice(0, room);
        rest = text.slice(room);
      }
      if (rest) tail += rest;
      if (tail.length > cap) {
        dropped += tail.length - cap;
        tail = tail.slice(-cap);
      }
    },

    text() {
      if (!tail) return head;              // everything fitted in the head
      if (!dropped) return head + tail;    // under 2*cap: verbatim, no marker
      // The marker matters: a parser that silently received a spliced stream
      // would report a confident wrong answer instead of an unparseable one.
      const nl = String.fromCharCode(10);
      return head + nl + '[... ' + dropped + ' bytes omitted ...]' + nl + tail;
    },

    get dropped() { return dropped; },
  };
}

module.exports = { createCappedBuffer };
