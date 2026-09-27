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

const { pasteAction, isPasteKey, IMAGE_PASTE_BYTES } = require('../app/paste-action');

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

test("line endings become CR exactly as xterm's own paste makes them", () => {
  // xterm 5.5: e.replace(/\r?\n/g, "\r"). Several lines stay ONE paste.
  assert.strictEqual(JSON.parse(pasteFrame('a\r\nb\nc', true)).data, '\x1b[200~a\rb\rc\x1b[201~');
  assert.strictEqual(JSON.parse(pasteFrame('a\r\nb\nc', false)).data, 'a\rb\rc');
});
