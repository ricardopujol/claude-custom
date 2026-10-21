'use strict';
/**
 * Holds a DA1 answer from a window until the host has PARSED everything the pty had said before it.
 *
 * Why (host/program-status.js has the measured background): the CLI asks "OSC 7501 ; ? ST" and then sends a DA1
 * sentinel. The window's xterm answers DA1 on its own, and that answer reaches the host as input. The host answers the
 * 7501 query from inside its headless parse, which is asynchronous (xterm queues writes). If the window's round trip
 * ever beat the parse, DA1 would reach the program first and the protocol would be marked unsupported for the whole
 * session. So a DA1-shaped input is released only once the parse has passed every chunk received before it. The query
 * precedes its sentinel in the stream, so by then the query has been answered.
 *
 *   track()            call once per chunk the host feeds its headless terminal; returns the write callback to pass it
 *   submit(data, send) send(data) now, or once the chunks received so far are parsed (a DA1 answer, or anything that
 *                      arrives behind one: typing never overtakes a held answer, and never waits when none is held)
 *
 * Keystrokes pay nothing in the normal case: only a DA1-shaped input ever starts the wait.
 */

// CSI [?>] digits;digits c : the device-attributes answers xterm gives (and a bare "CSI c").
const DA1_REPLY = /^\x1b\[[?>]?[\d;]*c$/;
const isDa1Reply = (data) => typeof data === 'string' && DA1_REPLY.test(data);

function createParseGate() {
  let issued = 0;          // chunks handed to the terminal
  let parsed = 0;          // chunks it has finished (xterm's callbacks arrive in order)
  const held = [];         // { need, data, send }, in arrival order

  function release() {
    while (held.length && held[0].need <= parsed) {
      const { data, send } = held.shift();
      try { send(data); } catch { /* the socket is the caller's to report; the ones behind must still go */ }
    }
  }

  return {
    track() {
      const n = ++issued;
      return () => { if (n > parsed) parsed = n; release(); };
    },
    submit(data, send) {
      if (held.length === 0 && (parsed >= issued || !isDa1Reply(data))) { send(data); return; }
      held.push({ need: issued, data, send });
    },
  };
}

module.exports = { createParseGate, isDa1Reply };
