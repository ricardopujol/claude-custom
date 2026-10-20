'use strict';
/**
 * Authoritative terminal state for the session, kept in the host.
 *
 * This is the VS Code terminal-reconnect pattern: the host runs a headless
 * emulator alongside the pty, so a GUI attaching later can be handed the
 * CURRENT SCREEN rather than a replay of every byte ever written. Replaying raw
 * bytes would re-run old animations, redraw stale frames and generally look
 * wrong; replaying state shows what is on screen now.
 *
 * Without this a fresh attach sees nothing until the TUI happens to repaint --
 * which is exactly what the step 0 detach probe observed.
 */

const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

function createTerminalState({ cols = 120, rows = 30, scrollback = 1000, onProgramStatus, onPromptStart, onReset, onResponse } = {}) {
  const term = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });

  // Ink positions box-drawing by computed character width, and xterm defaults to
  // a Unicode 6 table that measures emoji differently. Mismatched widths mean a
  // subtly shredded TUI rather than an obvious failure.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  const serializer = new SerializeAddon();
  term.loadAddon(serializer);

  // The Program Status Protocol (host/program-status.js). These run INSIDE xterm's parse, in stream order, which is
  // what lets the host answer a 7501 query before anything that follows it in the byte stream. A throwing listener
  // is the listener's bug and must never stop the stream. Handlers that only listen return false so xterm's own
  // handling (RIS resetting the screen) still runs.
  const guard = (fn) => { try { fn(); } catch { /* the listener's to report */ } };
  if (onProgramStatus) term.parser.registerOscHandler(7501, (data) => { guard(() => onProgramStatus(data)); return true; });
  if (onPromptStart) {
    // OSC 133 ; A is "a new prompt starts" (FinalTerm / shell integration); B, C and D are other moments.
    term.parser.registerOscHandler(133, (data) => { if (data === 'A' || data.startsWith('A;')) guard(onPromptStart); return false; });
  }
  // What the terminal itself answers (DA1, cursor position...): for a host with no window attached to answer them. Fires from
  // inside the parse, so an answer comes after the OSC handler of the same chunk, in stream order.
  if (onResponse) term.onData((answer) => guard(() => onResponse(answer)));
  // RIS (ESC c), not DECSTR (CSI ! p): the protocol clears everything on a full reset only.
  if (onReset) term.parser.registerEscHandler({ final: 'c' }, () => { guard(onReset); return false; });

  return {
    // The optional callback fires once xterm has PARSED this data (writes are
    // queued and parsed asynchronously, in order).
    write: (data, cb) => term.write(data, cb),
    serialize: () => serializer.serialize(),

    // Plain text rows. serialize() carries ANSI because replay needs it, which
    // makes it the wrong thing to parse: a colour change mid-phrase splits the
    // text and a regex that should match quietly does not.
    lines() {
      const buf = term.buffer.active;
      const out = [];
      // baseY is the offset of the VIEWPORT within the buffer. getLine() is
      // indexed from the start of scrollback, so without it y=0 is the oldest
      // line in history rather than the top of the current screen -- which made
      // the permission-mode reader parse the startup banner forever.
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.baseY + y);
        if (line) out.push(line.translateToString(true));
      }
      return out;
    },
    resize(nextCols, nextRows) { term.resize(nextCols, nextRows); },
    size: () => ({ cols: term.cols, rows: term.rows }),
    unicodeVersion: () => term.unicode.activeVersion,
    dispose() { try { term.dispose(); } catch {} },
  };
}

module.exports = { createTerminalState };
