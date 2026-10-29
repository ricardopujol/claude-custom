'use strict';
/**
 * Claude's reply as safe blocks with their copy targets (app/chat-blocks.js, BACKLOG #157 + #149).
 * Pure data, no DOM and no HTML anywhere: the display builds nodes from it with textContent, so model text can't become markup.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { parseMarkdown, parseInline, looksLikeCommand, looksLikePath, copyTargets, isSafeHref } = require('../app/chat-blocks');

const plain = (inlines) => inlines.map(i => (i.t === 'text' || i.t === 'code' ? i.v : plain(i.c || []))).join('');

test('paragraphs, headings and a rule', () => {
  const b = parseMarkdown('# Title\n\nFirst line\nsecond line\n\n---\n\n### Sub');
  assert.deepStrictEqual(b.map(x => x.type), ['heading', 'paragraph', 'hr', 'heading']);
  assert.strictEqual(b[0].level, 1);
  assert.strictEqual(plain(b[1].inlines), 'First line\nsecond line');
  assert.strictEqual(b[3].level, 3);
});

test('a fenced block keeps its text exactly and is a copy target', () => {
  const b = parseMarkdown('Run:\n\n```bash\nnpm test\n  --watch\n```\n\ndone');
  const code = b.find(x => x.type === 'code');
  assert.deepStrictEqual({ lang: code.lang, text: code.text }, { lang: 'bash', text: 'npm test\n  --watch' });
  assert.ok(copyTargets(b).some(t => t.kind === 'code' && t.text === 'npm test\n  --watch'));
});

test('an unclosed fence still ends as code, and ~~~ fences work', () => {
  assert.strictEqual(parseMarkdown('```\nabc')[0].text, 'abc');
  assert.strictEqual(parseMarkdown('~~~js\nlet a;\n~~~')[0].text, 'let a;');
});

test('a longer fence is not closed by a shorter one', () => {
  const b = parseMarkdown('````\n```\ninner\n```\n````');
  assert.strictEqual(b[0].text, '```\ninner\n```');
});

test('a blockquote is one copy target with the markers stripped', () => {
  const b = parseMarkdown('> Hi Sam,\n>\n> Thanks for the update.\n\nafter');
  assert.strictEqual(b[0].type, 'quote');
  assert.strictEqual(b[0].text, 'Hi Sam,\n\nThanks for the update.');
  assert.ok(copyTargets(b).some(t => t.kind === 'quote' && t.text === b[0].text));
});

test('lists, ordered and not, with their depth', () => {
  const b = parseMarkdown('- one\n- two\n  - nested\n\n1. a\n2) b');
  assert.strictEqual(b[0].type, 'list');
  assert.deepStrictEqual(b[0].items.map(i => [plain(i.inlines), i.depth]), [['one', 0], ['two', 0], ['nested', 1]]);
  assert.strictEqual(b[0].ordered, false);
  assert.strictEqual(b[1].ordered, true);
});

test('a table is rows of cells', () => {
  const b = parseMarkdown('| a | b |\n|---|---|\n| 1 | `x` |');
  assert.strictEqual(b[0].type, 'table');
  assert.deepStrictEqual(b[0].head.map(plain), ['a', 'b']);
  assert.deepStrictEqual(b[0].rows[0].map(plain), ['1', 'x']);
});

test('draft cue: a paragraph right after a line ending in paste:, send: or draft: is a copy target', () => {
  for (const cue of ['Here is the reply to paste:', 'Draft:', '**Send:**', 'the email to send:  ']) {
    const b = parseMarkdown(`${cue}\n\nHi Sam, thanks.\nSee you Monday.\n\nUnrelated.`);
    assert.strictEqual(b[1].draft, true, cue);
    assert.ok(copyTargets(b).some(t => t.kind === 'draft' && t.text === 'Hi Sam, thanks.\nSee you Monday.'), cue);
    assert.notStrictEqual(b[2].draft, true);
  }
});

test('no draft cue, no draft: an ordinary paragraph after an ordinary one', () => {
  const b = parseMarkdown('I looked at it.\n\nIt works.');
  assert.ok(b.every(x => x.draft !== true));
  assert.deepStrictEqual(copyTargets(b), []);
});

test('inline code that looks like a command or a path is a copy target; a bare word is not', () => {
  const i = parseInline('Run `git status` in `C:\\Users\\me\\app` or `src/a.js`, not `foo` or `x`.');
  const codes = i.filter(n => n.t === 'code');
  assert.deepStrictEqual(codes.map(c => [c.v, c.copy]), [['git status', true], ['C:\\Users\\me\\app', true], ['src/a.js', true], ['foo', false], ['x', false]]);
});

test('looksLikeCommand and looksLikePath', () => {
  for (const s of ['npm test', 'git log --oneline', 'node app/main.js', 'npx electron .', '$ ls -la', 'pytest -q', 'cd ..', 'gh pr create']) assert.ok(looksLikeCommand(s), s);
  for (const s of ['foo', 'the thing', 'x = 1', '', 'two\nlines']) assert.ok(!looksLikeCommand(s), s);
  for (const s of ['C:\\Users\\me', 'src/a.js', './run.sh', '~/notes', '/etc/hosts', 'a\\b\\c.txt', '..\\x']) assert.ok(looksLikePath(s), s);
  for (const s of ['foo', 'a b/c', 'and/or maybe', '', 'x\ny/z', 'a/ b']) assert.ok(!looksLikePath(s), s);
});

test('bold, italic and links; HTML stays text', () => {
  const i = parseInline('a **b** _c_ *d* [site](https://example.com/x?y=1) <b>raw</b> <script>alert(1)</script>');
  assert.deepStrictEqual(i.filter(n => n.t === 'strong').map(n => plain(n.c)), ['b']);
  assert.deepStrictEqual(i.filter(n => n.t === 'em').map(n => plain(n.c)), ['c', 'd']);
  const link = i.find(n => n.t === 'link');
  assert.strictEqual(link.href, 'https://example.com/x?y=1');
  assert.strictEqual(plain(link.c), 'site');
  assert.ok(plain(i).includes('<b>raw</b> <script>alert(1)</script>'));
});

test('only http, https and mailto links are links', () => {
  assert.ok(isSafeHref('https://a.b/c'));
  assert.ok(isSafeHref('http://a.b'));
  assert.ok(isSafeHref('mailto:a@b.c'));
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///C:/x', ' javascript:x', 'vbscript:x', '//evil.com', '/rel', '', 'https://a b', 'https://x\u0000.y']) assert.ok(!isSafeHref(bad), bad);
  const i = parseInline('[x](javascript:alert(1))');
  assert.ok(!i.some(n => n.t === 'link'));
  assert.strictEqual(plain(i), '[x](javascript:alert(1))');
});

test('depth: a deeply nested quote never recurses without end', () => {
  const b = parseMarkdown('>'.repeat(500) + ' deep');
  assert.ok(Array.isArray(b));
});

test('property: it never throws and every block has a known type', () => {
  const TYPES = new Set(['heading', 'paragraph', 'code', 'quote', 'list', 'table', 'hr']);
  fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
    const b = parseMarkdown(s);
    return Array.isArray(b) && b.every(x => TYPES.has(x.type));
  }));
  fc.assert(fc.property(fc.stringMatching(/^[ #>`~*_\-|\[\]()!<>a-z0-9\n:.\\/]{0,200}$/), (s) => {
    const b = parseMarkdown(s);
    return Array.isArray(b);
  }));
});

test('property: every link href that comes out is http, https or mailto and has no space or control character', () => {
  const walk = (inlines, out) => { for (const n of inlines) { if (n.t === 'link') out.push(n.href); if (n.c) walk(n.c, out); } return out; };
  const blocks = (bs, out) => {
    for (const b of bs) {
      if (b.inlines) walk(b.inlines, out);
      if (b.items) b.items.forEach(i => walk(i.inlines, out));
      if (b.blocks) blocks(b.blocks, out);
      if (b.head) b.head.forEach(c => walk(c, out));
      if (b.rows) b.rows.forEach(r => r.forEach(c => walk(c, out)));
    }
    return out;
  };
  fc.assert(fc.property(fc.string({ maxLength: 120 }), fc.string({ maxLength: 40 }), (label, href) => {
    const hrefs = blocks(parseMarkdown(`[${label}](${href}) and ${label}`), []);
    return hrefs.every(h => /^(https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i.test(h));
  }));
});

test('property: a fenced block\'s text round-trips whatever is inside it (no fence line inside)', () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 20 }).filter(l => !/^\s{0,3}(`{3,}|~{3,})/.test(l) && !l.includes('\n') && !l.includes('\r')), { minLength: 1, maxLength: 6 }), (lines) => {
    const body = lines.join('\n');
    const b = parseMarkdown('```\n' + body + '\n```');
    return b.length === 1 && b[0].type === 'code' && b[0].text === body;
  }));
});

test('property: a draft is only ever the block right after a paragraph that ends in a cue', () => {
  const CUE = /(paste|send|draft):\**_*\s*$/i;
  fc.assert(fc.property(fc.array(fc.constantFrom('Hello there', 'Draft:', 'paste:', '> quote', '```\ncode\n```', '- item', 'Send:', 'ok'), { maxLength: 8 }), (parts) => {
    const b = parseMarkdown(parts.join('\n\n'));
    return b.every((x, i) => x.draft !== true || (i > 0 && b[i - 1].type === 'paragraph' && CUE.test(plain(b[i - 1].inlines).split('\n').pop())));
  }));
});
