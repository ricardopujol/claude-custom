'use strict';
/**
 * The host's side of the Program Status Protocol (OSC 7501, BACKLOG #116), with its collaborators injected so it is tested by what
 * it DOES (PR #201 Miguel R5). host/host.js builds one and hands its methods to the headless terminal, the pty and the sockets.
 *
 *   createProgramStatusHost({ writePty, broadcast, attention, windowAttached, hostAnswersQueries })
 *     deliver()          call once per pty chunk, BEFORE it is written to the headless terminal; returns the write callback
 *     onOsc(data)        the headless terminal's OSC 7501 handler (the payload after "7501;")
 *     onPromptStart()    OSC 133 A         onReset()    RIS
 *     onResponse(answer) what the headless terminal itself answers (DA1, cursor position...)
 *     input(data)        a window's input on its way to the pty: a DA1 answer waits for the parse (host/parse-gate.js)
 *     frame()            the capped snapshot for a hello or a broadcast (host/program-status.js frameOf)
 *
 * WHO ANSWERS A TERMINAL QUERY. With a window attached when the chunk arrived, the window's xterm does, and its answer goes through
 * `input`. With none, the host's own terminal does (onResponse), when the pty backend leaves queries unanswered (the bundled
 * ConPTY; the OS's conhost answers for itself, so a second answer would be a duplicate). The decision is made when the chunk is
 * DELIVERED and travels with it: the answer comes out later, during the parse, and by then a window may have attached (it was never
 * sent these bytes, it gets the screen) or left (its answer is already on its way, held by the gate) (PR #201 Dexter 4).
 */
const { parseReport, createProgramStatus, frameOf, QUERY_REPLY } = require('./program-status');
const { createParseGate } = require('./parse-gate');

// Is a window attached, for the decision who answers the terminal's queries: a connection that is not a one-shot control client AND is
// OPEN. The send loop skips a socket that is not open, so a closing window gets no bytes and cannot answer (PR #201 Dexter r2 N6).
function windowAttachedAmong(clients) {
  return [...clients].some((c) => c && c.isWindow === true && c.readyState === 1);
}

function createProgramStatusHost({ writePty, broadcast, attention, windowAttached, hostAnswersQueries = true } = {}) {
  const store = createProgramStatus();
  const gate = createParseGate();
  const flags = [];                  // per chunk delivered and not yet parsed: was a window attached when it arrived
  let lastFrameJson = null;

  function publish(changed) {
    const frame = frameOf(store.snapshot());
    const json = JSON.stringify(frame);
    const first = lastFrameJson === null;
    if (changed || first) attention.programStatus(store.snapshot());
    if (json === lastFrameJson) return;
    lastFrameJson = json;
    broadcast({ type: 'program-status', ...frame });
  }

  return {
    deliver() {
      flags.push(windowAttached() === true);
      const parsed = gate.track();
      return () => { flags.shift(); parsed(); };
    },
    onOsc(data) {
      const parsed = parseReport(data);
      if (parsed.query) {
        // Synchronously, inside the parse: this is what puts the answer ahead of the DA1 sentinel's.
        writePty(QUERY_REPLY);
        return;
      }
      if (parsed.report) publish(store.apply(parsed.report));
    },
    // A new prompt: what was in flight is not any more (done and error stay). RIS clears everything.
    onPromptStart() { if (store.dropActive()) publish(true); },
    onReset() { if (store.reset()) publish(true); },
    onResponse(answer) {
      if (hostAnswersQueries && flags.length > 0 && flags[0] === false) writePty(answer);
    },
    input(data, send) { gate.submit(data, send); },
    frame: () => frameOf(store.snapshot()),
  };
}

module.exports = { createProgramStatusHost, windowAttachedAmong };
