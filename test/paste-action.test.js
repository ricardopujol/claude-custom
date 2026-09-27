'use strict';
/**
 * What Ctrl+V does, decided in one pure place (BACKLOG #12 text, #8 image).
 *
 * Measured by verify/probe-paste.js on 2026-09-27: before this, Ctrl+V put the
 * single byte \x16 on the pty and pasted nothing; and `claude` attaches a
 * clipboard image itself when it receives ESC+v (Alt+V) -- "[Image #1]" --
 * but not on \x16.
 */
const test = require('node:test');
const assert = require('node:assert');

const { pasteAction, isPasteKey, copyKeyAction, selectionVisible, IMAGE_PASTE_BYTES } = require('../app/paste-action');

test('text on the clipboard is pasted as text', () => {
  assert.deepStrictEqual(pasteAction({ text: 'hello', hasImage: false }), { kind: 'text', text: 'hello' });
});

test('multi-line text is handed over whole, as ONE paste', () => {
  // term.paste brackets it; splitting it here would submit line by line.
  const text = 'line one\r\nline two\nline three';
  assert.deepStrictEqual(pasteAction({ text, hasImage: false }), { kind: 'text', text });
});

test('text wins over an image when the clipboard holds both', () => {
  // Copying from a browser or Word often carries a bitmap alongside the text;
  // the user copied words, and words are what they expect back.
  assert.deepStrictEqual(pasteAction({ text: 'caption', hasImage: true }), { kind: 'text', text: 'caption' });
});

test('an image with no text asks claude to paste it itself (Alt+V)', () => {
  assert.deepStrictEqual(pasteAction({ text: '', hasImage: true }), { kind: 'image', data: '\x1bv' });
});

test('the image bytes are exactly ESC v -- what the probe proved claude accepts', () => {
  assert.strictEqual(IMAGE_PASTE_BYTES, '\x1bv');
});

test('whitespace-only text does not beat an image (Miguel, PR #55, S1)', () => {
  // Office can leave a residual text/plain -- a lone space -- beside a bitmap.
  assert.deepStrictEqual(pasteAction({ text: ' \r\n\t', hasImage: true }), { kind: 'image', data: '\x1bv' });
  assert.deepStrictEqual(pasteAction({ text: '  ', hasImage: false }), { kind: 'none' });
});

test('real text keeps its own whitespace -- only the emptiness check trims', () => {
  assert.deepStrictEqual(pasteAction({ text: '  indented\n', hasImage: true }), { kind: 'text', text: '  indented\n' });
});

test('an empty clipboard does nothing', () => {
  assert.deepStrictEqual(pasteAction({ text: '', hasImage: false }), { kind: 'none' });
});

test('a missing or malformed read does nothing, never a confident paste', () => {
  // Number(null) is 0 in this codebase's history; here the equivalent is a
  // `null` text turning into the string "null" typed into the prompt.
  for (const bad of [undefined, null, {}, { text: null }, { text: 42 }, { hasImage: 'yes' }]) {
    assert.deepStrictEqual(pasteAction(bad), { kind: 'none' }, JSON.stringify(bad));
  }
});

test('hasImage must be literally true to trigger an image paste', () => {
  assert.deepStrictEqual(pasteAction({ text: '', hasImage: 1 }), { kind: 'none' });
});

const key = (over) => ({ type: 'keydown', key: 'v', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...over });

test('Ctrl+V keydown is the paste key', () => {
  assert.strictEqual(isPasteKey(key()), true);
});

test('Caps Lock does not break it (key arrives as "V")', () => {
  assert.strictEqual(isPasteKey(key({ key: 'V' })), true);
});

test('only keydown counts, or one press would paste twice', () => {
  assert.strictEqual(isPasteKey(key({ type: 'keyup' })), false);
  assert.strictEqual(isPasteKey(key({ type: 'keypress' })), false);
});

test('Ctrl+V with any other modifier is not ours', () => {
  assert.strictEqual(isPasteKey(key({ shiftKey: true })), false);
  assert.strictEqual(isPasteKey(key({ altKey: true })), false);
  assert.strictEqual(isPasteKey(key({ metaKey: true })), false);
});

test('V without Ctrl, and Ctrl with another letter, are not the paste key', () => {
  assert.strictEqual(isPasteKey(key({ ctrlKey: false })), false);
  assert.strictEqual(isPasteKey(key({ key: 'c' })), false, 'Ctrl+C is left completely alone');
  assert.strictEqual(isPasteKey(null), false);
});

// --- Miguel, PR #55, B1: a paste must never parse as a control message -------

const { pasteFrame } = require('../app/paste-action');
const { parseControlFrame } = require('../host/control');

// Types the host treats as control messages. A clipboard holding any of these
// verbatim -- copied from a page that wrote it there -- must still be TEXT.
const HOSTILE = [
  '{"type":"open","path":"C:\\\\Users\\\\victim"}',
  '{"type":"drop","entries":[{"path":"C:\\\\Users","isDirectory":true}]}',
  '{"type":"resize","cols":2,"rows":2}',
  '{"type":"input","data":"rm -rf /\\r"}',
];

for (const bracketed of [false, true]) {
  test(`allow-listed JSON pasted with bracketed mode ${bracketed ? 'ON' : 'OFF'} is never a control message`, () => {
    for (const text of HOSTILE) {
      assert.ok(parseControlFrame(text), `precondition: sent raw, ${text} WOULD be control`);
      const msg = parseControlFrame(pasteFrame(text, bracketed));
      // Only ever the explicit input wrapper, carrying the pasted bytes as
      // data, which the host writes to the pty literally.
      assert.strictEqual(msg && msg.type, 'input', text);
      assert.strictEqual(msg.data, bracketed ? '\x1b[200~' + text + '\x1b[201~' : text);
    }
  });
}

test('brackets are added only when the CLI asked for them', () => {
  assert.strictEqual(JSON.parse(pasteFrame('abc', false)).data, 'abc');
  assert.strictEqual(JSON.parse(pasteFrame('abc', true)).data, '\x1b[200~abc\x1b[201~');
  assert.strictEqual(JSON.parse(pasteFrame('abc', 1)).data, 'abc', 'only a literal true brackets');
});

test('the renderer sends pastes through pasteFrame, never term.paste', () => {
  // The unit tests above prove pasteFrame is safe; this proves it is the path.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'renderer.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /term\.paste\(/);
  const fn = src.slice(src.indexOf('async function pasteFromClipboard'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /send\(\s*pasteFrame\(|pasteFrame\([^)]*term\.modes\.bracketedPasteMode\)/);
});

// --- Miguel, PR #55, S2: a failed read is said out loud ---------------------

const { pasteFailureNote } = require('../app/paste-action');

test('a clipboard read that threw says so on screen, with the reason', () => {
  const note = pasteFailureNote(new Error('locked by another app'));
  assert.match(note.name, /Ctrl\+V/);
  assert.match(note.name, /clipboard/);
  assert.match(note.name, /locked by another app/);
  assert.strictEqual(typeof note.icon, 'string');
  assert.ok(note.icon.length > 0);
});

test('a missing bridge is a failure too, named without "null" or "undefined"', () => {
  for (const why of [null, undefined, {}]) {
    const note = pasteFailureNote(why);
    assert.match(note.name, /clipboard/);
    assert.doesNotMatch(note.name, /null|undefined|object/);
  }
});

test('the renderer shows the note when the bridge is missing or throws', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'renderer.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fn = src.slice(src.indexOf('async function pasteFromClipboard'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.strictEqual((body.match(/flourish\(\s*pasteFailureNote\(/g) || []).length, 2,
    'both the missing-bridge and the thrown-read paths must surface the note');
});

test("line endings become CR exactly as xterm's own paste makes them", () => {
  // xterm 5.5: e.replace(/\r?\n/g, "\r"). Several lines stay ONE paste.
  assert.strictEqual(JSON.parse(pasteFrame('a\r\nb\nc', true)).data, '\x1b[200~a\rb\rc\x1b[201~');
  assert.strictEqual(JSON.parse(pasteFrame('a\r\nb\nc', false)).data, 'a\rb\rc');
});

// --- Ctrl+C: copy when there's a selection, interrupt when there isn't ------
// Windows Terminal's rule (Ricardo, 2026-09-27). The CLI's ^C is untouched
// whenever nothing is selected, so Esc/interrupt/exit behave exactly as before.

const ctrlC = (over) => key({ key: 'c', ...over });

test('Ctrl+C with a selection copies it', () => {
  assert.deepStrictEqual(copyKeyAction(ctrlC(), 'some text', true), { kind: 'copy', text: 'some text' });
});

test('Ctrl+C with nothing selected passes through to the CLI as ^C', () => {
  for (const none of ['', undefined, null]) {
    assert.deepStrictEqual(copyKeyAction(ctrlC(), none, true), { kind: 'pass' }, String(none));
  }
});

test('a selection of only whitespace is still what the user selected, and is copied', () => {
  assert.deepStrictEqual(copyKeyAction(ctrlC(), '   ', true), { kind: 'copy', text: '   ' });
});

test('Caps Lock does not break the copy key', () => {
  assert.deepStrictEqual(copyKeyAction(ctrlC({ key: 'C' }), 'x', true), { kind: 'copy', text: 'x' });
});

test('only a plain Ctrl+C keydown copies', () => {
  for (const over of [{ type: 'keyup' }, { shiftKey: true }, { altKey: true }, { metaKey: true },
                      { ctrlKey: false }, { key: 'v' }]) {
    assert.deepStrictEqual(copyKeyAction(ctrlC(over), 'x', true), { kind: 'pass' }, JSON.stringify(over));
  }
});

test('a non-string selection is never copied', () => {
  for (const bad of [42, {}, ['x']]) {
    assert.deepStrictEqual(copyKeyAction(ctrlC(), bad, true), { kind: 'pass' }, JSON.stringify(bad));
  }
});

// Miguel, PR #58, I1: xterm anchors a selection to the BUFFER, so one made
// earlier can sit scrolled out of sight. Ctrl+C then silently copied it and
// the ^C the user meant -- to stop a runaway claude -- never went out. A
// selection the user can't see is STALE: it's dropped, and ^C goes through.

test('Ctrl+C with a selection that is out of sight is stale, not a copy', () => {
  assert.deepStrictEqual(copyKeyAction(ctrlC(), 'old text', false), { kind: 'stale' });
});

test('visibility must be literally true to copy', () => {
  for (const v of [undefined, null, 1, 'yes']) {
    assert.deepStrictEqual(copyKeyAction(ctrlC(), 'x', v), { kind: 'stale' }, String(v));
  }
});

test('with nothing selected, visibility does not matter: it is ^C', () => {
  assert.deepStrictEqual(copyKeyAction(ctrlC(), '', false), { kind: 'pass' });
});

// selectionVisible(range, viewportY, rows): range rows are 0-based buffer
// lines, as measured in the real window (verify/probe-paste.js, copy/rows).
const range = (sy, ey) => ({ start: { x: 0, y: sy }, end: { x: 5, y: ey } });

test('a selection inside the viewport is visible', () => {
  assert.strictEqual(selectionVisible(range(12, 14), 10, 30), true);
});

test('a selection on the first or last viewport row is visible', () => {
  assert.strictEqual(selectionVisible(range(10, 10), 10, 30), true);
  assert.strictEqual(selectionVisible(range(39, 39), 10, 30), true);
});

test('a selection just above or just below the viewport is not', () => {
  assert.strictEqual(selectionVisible(range(9, 9), 10, 30), false);
  assert.strictEqual(selectionVisible(range(40, 40), 10, 30), false);
  assert.strictEqual(selectionVisible(range(0, 5), 10, 30), false);
});

test('a selection that straddles the viewport edge is visible', () => {
  assert.strictEqual(selectionVisible(range(5, 12), 10, 30), true);
  assert.strictEqual(selectionVisible(range(35, 60), 10, 30), true);
});

test('a backwards selection (end before start) is judged the same', () => {
  assert.strictEqual(selectionVisible(range(14, 12), 10, 30), true);
  assert.strictEqual(selectionVisible(range(5, 0), 10, 30), false);
});

test('no range, or anything not a number, is not visible', () => {
  for (const bad of [undefined, null, {}, { start: { y: 1 } }, range('1', 2), range(NaN, 2)]) {
    assert.strictEqual(selectionVisible(bad, 0, 30), false, JSON.stringify(bad));
  }
  assert.strictEqual(selectionVisible(range(1, 2), undefined, 30), false);
  assert.strictEqual(selectionVisible(range(1, 2), 0, null), false);
});
