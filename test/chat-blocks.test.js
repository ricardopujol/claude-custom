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

test('lists, ordered and not, with their nesting', () => {
  const b = parseMarkdown('- one\n- two\n  - nested\n\n1. a\n2) b');
  assert.strictEqual(b[0].type, 'list');
  assert.deepStrictEqual(b[0].items.map(i => plain(i.inlines)), ['one', 'two']);
  const nested = b[0].items[1].blocks[0];
  assert.strictEqual(nested.type, 'list');
  assert.deepStrictEqual(nested.items.map(i => plain(i.inlines)), ['nested']);
  assert.strictEqual(b[0].ordered, false);
  assert.strictEqual(b[1].ordered, true);
});

// The rendered number of item k of an ordered list is start + k: the display sets <ol start>, so this is what the person reads.
const numbers = (b) => b.items.map((_, k) => b.start + k);

test('ordered lists keep their numbers across blank lines, wrapped lines, sub-bullets and a fence (PR #226 Miguel B2, Dexter 8)', () => {
  const loose = parseMarkdown('1. a\n\n2. b\n\n3. c');
  assert.strictEqual(loose.length, 1);
  assert.deepStrictEqual(numbers(loose[0]), [1, 2, 3]);

  const fenced = parseMarkdown('1. Install:\n\n```bash\nnpm i\n```\n\n2. Run the tests');
  assert.deepStrictEqual(fenced.map(x => x.type), ['list', 'code', 'list'], 'a fence at column 0 does end the list: the next list must then count on');
  assert.strictEqual(fenced[2].start, 2, 'and it is numbered 2, not 1');
});

test('an indented fence is part of its item, so the next item is still the next number', () => {
  const b = parseMarkdown('1. Install:\n   ```bash\n   npm i\n   ```\n2. Run the tests\n3. Done');
  assert.strictEqual(b.length, 1);
  assert.deepStrictEqual(numbers(b[0]), [1, 2, 3]);
  assert.strictEqual(b[0].items[0].blocks[0].type, 'code');
  assert.strictEqual(b[0].items[0].blocks[0].text, 'npm i');
  assert.ok(copyTargets(b).some(t => t.kind === 'code' && t.text === 'npm i'));
});

test('a wrapped line and a sub-bullet belong to their item; an ordered list keeps counting past them', () => {
  const wrapped = parseMarkdown('1. one\n   more of one\n2. two');
  assert.strictEqual(wrapped.length, 1);
  assert.strictEqual(plain(wrapped[0].items[0].inlines), 'one\nmore of one');
  const sub = parseMarkdown('1. one\n   - x\n   - y\n2. two\n3. three');
  assert.strictEqual(sub.length, 1);
  assert.strictEqual(sub[0].items[0].blocks[0].ordered, false);
  assert.deepStrictEqual(numbers(sub[0]), [1, 2, 3]);
  const lazy = parseMarkdown('1. one\nlazy\n2. two');
  assert.strictEqual(lazy.length, 1);
  assert.strictEqual(plain(lazy[0].items[0].inlines), 'one\nlazy');
});

test('the first number is honoured: a list starting at 5 starts at 5', () => {
  const b = parseMarkdown('5. five\n6. six');
  assert.strictEqual(b[0].start, 5);
  assert.deepStrictEqual(numbers(b[0]), [5, 6]);
  assert.strictEqual(parseMarkdown('- a')[0].start, undefined, 'a bullet list has no start');
});

test('a fence indented 1-4 spaces is a code block and its indent is not in the copied code (PR #226 Dexter 9)', () => {
  const two = parseMarkdown('10. Run:\n    ```bash\n    npm test\n    ```');
  assert.strictEqual(two[0].items[0].blocks[0].text, 'npm test');
  const py = parseMarkdown('1. x\n   ```py\n   def f():\n       return 1\n   ```');
  assert.strictEqual(py[0].items[0].blocks[0].text, 'def f():\n    return 1');
  const nested = parseMarkdown('- a\n  - b\n    ```\n    ls\n    ```');
  assert.strictEqual(nested[0].items[0].blocks[0].items[0].blocks[0].text, 'ls');
  const loose = parseMarkdown('  ```sh\n  one\n    two\n  ```');
  assert.strictEqual(loose[0].text, 'one\n  two', 'outside a list the opener\'s own indent is stripped too');
});

test('property: an ordered list of n items, separated by any mix of blank lines, is one list counting 1..n', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 9 }), fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }), fc.integer({ min: 1, max: 50 }), (n, gaps, start) => {
    const src = Array.from({ length: n }, (_, k) => `${start + k}. item ${k}`).map((l, k) => (k > 0 && gaps[k] ? '\n' + l : l)).join('\n');
    const b = parseMarkdown(src);
    return b.length === 1 && b[0].type === 'list' && b[0].start === start && b[0].items.length === n;
  }));
});

test('a table is rows of cells', () => {
  const b = parseMarkdown('| a | b |\n|---|---|\n| 1 | `x` |');
  assert.strictEqual(b[0].type, 'table');
  assert.deepStrictEqual(b[0].head.map(plain), ['a', 'b']);
  assert.deepStrictEqual(b[0].rows[0].map(plain), ['1', 'x']);
});

test('draft cue: the paragraphs right after a line ending in paste:, send: or draft: are ONE copy target (PR #226 Dexter 10)', () => {
  for (const cue of ['Here is the reply to paste:', 'Draft:', '**Send:**', 'the email to send:  ']) {
    const b = parseMarkdown(`${cue}\n\nHi Sam, thanks.\nSee you Monday.\n\n---\n\nUnrelated.`);
    assert.deepStrictEqual(b.map(x => x.type), ['paragraph', 'draft', 'hr', 'paragraph'], cue);
    assert.ok(copyTargets(b).some(t => t.kind === 'draft' && t.text === 'Hi Sam, thanks.\nSee you Monday.'), cue);
  }
});

test('an email of several paragraphs copies whole, and a heading cue counts too', () => {
  const email = parseMarkdown("Here's the email to send:\n\nHi Ana,\n\nThe build is green. I'll merge it today.\n\nBest,\nRicardo");
  assert.deepStrictEqual(email.map(x => x.type), ['paragraph', 'draft']);
  assert.strictEqual(email[1].text, "Hi Ana,\n\nThe build is green. I'll merge it today.\n\nBest,\nRicardo");
  for (const h of ['## Draft:', '## Draft', '### Reply to send:']) {
    const b = parseMarkdown(`${h}\n\nHi Sam.\n\nThanks.`);
    assert.deepStrictEqual(b.map(x => x.type), ['heading', 'draft'], h);
  }
  const two = parseMarkdown('Draft:\n\nOne.\n\nAlso send:\n\nTwo.');
  assert.deepStrictEqual(two.map(x => x.type), ['paragraph', 'draft', 'paragraph', 'draft'], 'a second lead-in starts a second draft');
});

test('a heading keeps a trailing # that is part of its text; a closing run needs a space (PR #226 Dexter 12)', () => {
  assert.strictEqual(plain(parseMarkdown('## Using C#')[0].inlines), 'Using C#');
  assert.strictEqual(plain(parseMarkdown('# F#')[0].inlines), 'F#');
  assert.strictEqual(plain(parseMarkdown('## Title ##')[0].inlines), 'Title');
});

test('a table may interrupt a paragraph: "Results:" straight above its rows (PR #226 Dexter 13)', () => {
  const b = parseMarkdown('Results:\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.deepStrictEqual(b.map(x => x.type), ['paragraph', 'table']);
});

test('inline `$ npm test` copies the command without the prompt sign (PR #226 Dexter 14)', () => {
  const t = copyTargets(parseMarkdown('Run `$ npm test` then `> git status`.'));
  assert.deepStrictEqual(t.map(x => x.text), ['npm test', 'git status']);
});

test('no draft cue, no draft: an ordinary paragraph after an ordinary one', () => {
  const b = parseMarkdown('I looked at it.\n\nIt works.');
  assert.ok(b.every(x => x.type !== 'draft'));
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

test('a double underscore inside code-ish text is not emphasis: window.__pwned and x.__y keep every character', () => {
  for (const s of ['window.__pwned = 1 and x.__y', 'a __b c _d', 'snake_case and __dunder__x']) {
    const out = parseInline(s);
    assert.ok(out.every(i => i.t === 'text'), s);
    assert.strictEqual(plain(out), s);
  }
  assert.strictEqual(parseInline('__init__ is special')[0].t, 'strong');
  assert.strictEqual(parseInline('_a_ ok')[0].t, 'em');
});

test('only http, https and mailto links are links', () => {
  assert.ok(isSafeHref('https://a.b/c'));
  assert.ok(isSafeHref('http://a.b'));
  assert.ok(!isSafeHref('mailto:a@b.c'), 'a mailto link would do nothing when clicked');
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
      if (b.items) b.items.forEach(i => { walk(i.inlines, out); blocks(i.blocks, out); });
      if (b.blocks) blocks(b.blocks, out);
      if (b.head) b.head.forEach(c => walk(c, out));
      if (b.rows) b.rows.forEach(r => r.forEach(c => walk(c, out)));
    }
    return out;
  };
  fc.assert(fc.property(fc.string({ maxLength: 120 }), fc.string({ maxLength: 40 }), (label, href) => {
    const hrefs = blocks(parseMarkdown(`[${label}](${href}) and ${label}`), []);
    return hrefs.every(h => /^(https?:\/\/)[^\s\u0000-\u001f]+$/i.test(h));
  }));
});

test('property: a fenced block\'s text round-trips whatever is inside it (no fence line inside)', () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 20 }).filter(l => !/^\s{0,3}(`{3,}|~{3,})/.test(l) && !l.includes('\n') && !l.includes('\r')), { minLength: 1, maxLength: 6 }), (lines) => {
    const body = lines.join('\n');
    const b = parseMarkdown('```\n' + body + '\n```');
    return b.length === 1 && b[0].type === 'code' && b[0].text === body;
  }));
});

test('property: a draft is only ever a run of paragraphs right after a lead-in paragraph or heading', () => {
  const CUE = /(paste|send|draft):\**_*\s*$/i;
  fc.assert(fc.property(fc.array(fc.constantFrom('Hello there', 'Draft:', 'paste:', '> quote', '```\ncode\n```', '- item', 'Send:', 'ok', '## Draft:'), { maxLength: 8 }), (parts) => {
    const b = parseMarkdown(parts.join('\n\n'));
    return b.every((x, i) => x.type !== 'draft' || (i > 0 && x.blocks.length > 0 && x.blocks.every(p => p.type === 'paragraph')
      && (b[i - 1].type === 'heading' || (b[i - 1].type === 'paragraph' && CUE.test(plain(b[i - 1].inlines).split('\n').pop())))));
  }));
});
