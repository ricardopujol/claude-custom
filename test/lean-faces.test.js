'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFaces, sanitizeFaces, MAX_FACES } = require('../app/lean-faces');

const face = (agent, extra = {}) => ({ agent, images: true, portrait: { kind: 'file', path: `C:/p/${agent}.png`, media: 'image', tier: 'forge' }, ...extra });

test('sanitizeFaces: keeps a name, the images flag and the portrait\'s plain fields; drops everything else', () => {
  const [f] = sanitizeFaces([{ agent: 'dexter', images: true, evil: 1, portrait: { kind: 'file', path: 'C:/p/d.png', media: 'image', tier: 'forge', mtimeMs: 5, script: 'x', fallback: { initials: 'DX', hue: 90, junk: 1 } } }]);
  assert.deepStrictEqual(f, { agent: 'dexter', images: true, portrait: { kind: 'file', path: 'C:/p/d.png', media: 'image', tier: 'forge', mtimeMs: 5, fallback: { kind: 'placeholder', initials: 'DX', hue: 90 } } });
});

test('sanitizeFaces: junk is dropped, a missing portrait is null, the images flag is true/false/null only, the list is capped', () => {
  assert.deepStrictEqual(sanitizeFaces('x'), []);
  assert.deepStrictEqual(sanitizeFaces([null, 3, { agent: '' }, { agent: 'a'.repeat(81) }, { agent: 'ok', images: 'yes' }]), [{ agent: 'ok', images: null, portrait: null }]);
  assert.strictEqual(sanitizeFaces(Array.from({ length: 60 }, (_, i) => face('a' + i))).length, MAX_FACES);
});

test('flat: every page\'s agents, one entry per name, in owner order', () => {
  const f = createFaces();
  f.set(1, [face('amy'), face('bob')]);
  f.set(2, [face('bob'), face('cat')]);
  assert.deepStrictEqual(f.flat().map(x => x.agent), ['amy', 'bob', 'cat']);
});

test('set reports a change only when the page\'s list changed; an empty list removes the page', () => {
  const f = createFaces();
  assert.strictEqual(f.set(1, [face('amy')]), true);
  assert.strictEqual(f.set(1, [face('amy')]), false);
  assert.strictEqual(f.set(1, []), true);
  assert.strictEqual(f.set(1, []), false);
  assert.deepStrictEqual(f.flat(), []);
});

test('drop: a closed page leaves no faces', () => {
  const f = createFaces();
  f.set(1, [face('amy')]);
  assert.strictEqual(f.drop(1), true);
  assert.strictEqual(f.drop(1), false);
  assert.deepStrictEqual(f.flat(), []);
});

const { safePortraitPath, SCAN_MAX } = require('../app/lean-faces');

test('Miguel Y2: only an absolute drive path with a media extension and no .. is loadable; UNC, device paths, traversal and other files are dropped', () => {
  for (const ok of ['C:/p/a.png', 'C:\\Users\\r\\.harness\\portraits\\x\\working.WEBP', 'D:/a b/c.mp4', 'C:/p/a.jpeg']) assert.strictEqual(safePortraitPath(ok), true, ok);
  for (const bad of ['\\\\server\\share\\a.png', '\\\\?\\C:\\a.png', 'C:/p/../../secret.png', 'C:\\p\\..\\a.png', '/etc/a.png', 'a.png', 'C:/p/a.exe', 'C:/p/a.png.txt', 'C:/p/notes', '', null, 5, 'C:/' + 'x'.repeat(1030) + '.png']) {
    assert.strictEqual(safePortraitPath(bad), false, String(bad));
  }
});

test('Miguel Y2: a face whose path is bad keeps its name but loses the path (it draws the initials), never the bad path', () => {
  const [f] = sanitizeFaces([{ agent: 'a', images: true, portrait: { kind: 'file', path: '\\\\evil\\share\\x.png', media: 'image', fallback: { initials: 'AB', hue: 3 } } }]);
  assert.strictEqual(f.portrait.path, undefined);
  assert.strictEqual(f.portrait.fallback.initials, 'AB');
});

test('Miguel S5: only the first SCAN_MAX entries are looked at, however much junk follows', () => {
  const junk = Array.from({ length: SCAN_MAX + 1000 }, () => null);
  junk.push({ agent: 'late' });
  assert.deepStrictEqual(sanitizeFaces(junk), []);
});
