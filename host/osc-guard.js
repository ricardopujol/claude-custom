'use strict';
/**
 * Which OSC 7501 sequences are clean (BACKLOG #116, PR #201 Dexter 5).
 *
 * The spec discards a report that holds a control character, and one that is not properly terminated. The terminal never
 * shows us that: xterm's parser silently DROPS C0 bytes inside an OSC string (0x01 and the rest), ends the string
 * "successfully" at a bare ESC (`ESC ] 7501 ; state=done ESC [ 0 m` hands the handler `state=done`), and ends it at the C1
 * ST (0x9c). Measured with the real parser (scratchpad osc-bytes.js, 2026-10-20): CAN, SUB and C1 codes other than 0x9c
 * abort the string and the handler never runs.
 *
 * So this watches the RAW text on its way into the terminal, across chunk boundaries, and keeps one record per 7501 sequence
 * that ends: its payload as xterm will pass it on, and whether it was clean (terminated by BEL or ESC \ and holding no control
 * character). When xterm's handler then runs with a payload, `take(payload)` says whether to apply it:
 *   - the oldest record with that payload decides (records before it were aborted strings the handler never saw);
 *   - no record at all: not applied. Failing closed is the point: anything this scanner did not understand is discarded.
 *
 *   scan(text)        feed raw pty text, in order
 *   take(payload)     -> true to apply the report, false to discard it
 */
const ESC = 0x1b;
const BEL = 0x07;
const MAX_PAYLOAD = 8192;       // the spec's limit is 4096; past this the text is no longer kept, only the verdict (not clean)
const MAX_RECORDS = 64;

function createOscGuard() {
  let state = 'ground';         // ground | esc | num | other | otherEsc | body | bodyEsc
  let num = '';
  let raw = '';
  let dirty = false;
  const records = [];

  const finish = (clean) => {
    records.push({ payload: raw, clean: clean && !dirty });
    if (records.length > MAX_RECORDS) records.shift();
    raw = ''; dirty = false;
  };

  function step(code, ch) {
    switch (state) {
      case 'ground':
        if (code === ESC) state = 'esc';
        return;
      case 'esc':
        if (ch === ']') { state = 'num'; num = ''; } else if (code !== ESC) state = 'ground';
        return;
      case 'num':
        if (ch >= '0' && ch <= '9') { num += ch; if (num.length > 6) state = 'other'; } else if (ch === ';') {
          if (num === '7501') { state = 'body'; raw = ''; dirty = false; } else state = 'other';
        } else if (code === ESC) state = 'esc'; else state = 'ground';
        return;
      case 'other':
        if (code === BEL) state = 'ground'; else if (code === ESC) state = 'otherEsc';
        return;
      case 'otherEsc':
        if (ch === '\\') state = 'ground'; else { state = 'esc'; step(code, ch); }
        return;
      case 'body':
        if (code === BEL) { finish(true); state = 'ground'; return; }
        if (code === ESC) { state = 'bodyEsc'; return; }
        if (code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f && code !== 0x9c)) { raw = ''; dirty = false; state = 'ground'; return; }   // xterm aborts: no handler call, no record
        if (code === 0x9c) { finish(false); state = 'ground'; return; }
        if (code < 0x20 || code === 0x7f) { dirty = true; return; }                  // xterm drops it; the report is not clean
        if (raw.length < MAX_PAYLOAD) raw += ch; else dirty = true;
        return;
      case 'bodyEsc':
        if (ch === '\\') { finish(true); state = 'ground'; return; }
        finish(false);                                                              // a bare ESC ends it, wrongly
        state = 'esc'; step(code, ch);
        return;
      default:
        state = 'ground';
    }
  }

  return {
    scan(text) {
      if (typeof text !== 'string') return;
      for (let i = 0; i < text.length; i++) step(text.charCodeAt(i), text[i]);
    },
    take(payload) {
      const i = records.findIndex((r) => r.payload === payload);
      if (i < 0) return false;
      const { clean } = records[i];
      records.splice(0, i + 1);                     // it, and the aborted strings before it
      return clean;
    },
  };
}

module.exports = { createOscGuard };
