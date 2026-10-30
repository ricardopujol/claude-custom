'use strict';
/**
 * Claude's reply as safe blocks with their copy targets (BACKLOG #157 chat view, #149 Copy buttons).
 *
 *   parseMarkdown(text) -> blocks     parseInline(text) -> inlines     copyTargets(blocks) -> [{ kind, text }]
 *
 * PURE DATA, and the reason it is not a library: model text is untrusted, so nothing here ever produces HTML. The
 * display (app/chat-display.js) builds elements from these blocks with textContent; raw HTML in a reply stays literal
 * text, and a link survives only if its address is http, https or mailto (isSafeHref). A small subset is enough for a
 * chat: headings, paragraphs, fenced code, blockquotes, lists, tables, a rule; bold, italic, inline code, links.
 *
 * Copy targets (the design's open question, built as recommended): a fenced block, a blockquote, inline code that looks
 * like a command or a path, and a paragraph right after a line ending in "paste:" / "send:" / "draft:" (`draft: true`).
 * "Copy reply" on the whole message is the display's catch-all.
 *
 * Loaded as a plain <script> in renderer.html, so it is wrapped: every file there shares ONE global scope (CLAUDE.md).
 */

(function (root) {

const MAX_DEPTH = 4;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const DRAFT_CUE = /\b(?:paste|send|draft)\s*:[\s*_]*$/i;

const COMMAND_HEADS = new Set(['git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'python', 'python3', 'py', 'pip', 'pip3', 'pytest', 'cd', 'ls', 'dir', 'cat',
  'curl', 'wget', 'docker', 'gh', 'claude', 'cargo', 'rustc', 'go', 'make', 'cmake', 'powershell', 'pwsh', 'bash', 'sh', 'sudo', 'rm', 'mv', 'cp', 'mkdir',
  'echo', 'grep', 'rg', 'ssh', 'scp', 'tar', 'kubectl', 'dotnet', 'java', 'mvn', 'gradle', 'tsc', 'deno', 'bun', 'uv', 'winget', 'choco', 'brew', 'apt', 'code']);

function looksLikeCommand(s) {
  if (typeof s !== 'string' || s === '' || /[\r\n]/.test(s)) return false;
  const t = s.replace(/^[$>]\s+/, '');
  if (t !== s) return t.trim() !== '';
  const head = t.split(/\s+/)[0].toLowerCase();
  return COMMAND_HEADS.has(head) && (t.includes(' ') || head === 'ls' || head === 'dir');
}

function looksLikePath(s) {
  if (typeof s !== 'string' || s === '' || /[\r\n]/.test(s) || /\s\//.test(s) || /\/\s/.test(s) && !/^[A-Za-z]:/.test(s)) return false;
  if (/^[A-Za-z]:[\\/]/.test(s) || /^(?:\.{1,2}|~)[\\/]/.test(s) || /^\/[\w.~-]/.test(s)) return true;
  // a relative path: no spaces, at least one separator between two non-empty parts
  return !/\s/.test(s) && /^[\w.@~-]+(?:[\\/][\w.@~ -]+)+$/.test(s) && !/^(?:and|or)\/or$/i.test(s) && (/[\\]/.test(s) || /\.\w+$/.test(s) || /^[\w.-]+\/[\w.-]+\//.test(s));
}

function isSafeHref(h) {
  return typeof h === 'string' && /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f]+$/i.test(h);
}

const text = (v) => ({ t: 'text', v });

function parseInline(src, depth = 0) {
  const s = typeof src === 'string' ? src : '';
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(text(buf)); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > 0 && s[end + n] !== '`') {
        flush();
        let v = s.slice(i + n, end);
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
        out.push({ t: 'code', v, copy: looksLikeCommand(v) || looksLikePath(v) });
        i = end + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }
    if (c === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > 0 && s[close + 1] === '(') {
        let depthP = 1;
        let j = close + 2;
        while (j < s.length && depthP > 0) { if (s[j] === '(') depthP++; else if (s[j] === ')') depthP--; j++; }
        if (depthP === 0) {
          const raw = s.slice(close + 2, j - 1).trim();
          const href = raw.replace(/\s+".*"$/, '');
          if (isSafeHref(href)) {
            flush();
            out.push({ t: 'link', href, c: depth < 5 ? parseInline(s.slice(i + 1, close), depth + 1) : [text(s.slice(i + 1, close))] });
          } else {
            buf += s.slice(i, j);        // an address that isn't safe: the whole source stays visible text, no link
          }
          i = j;
          continue;
        }
      }
    }
    if ((c === '*' || c === '_') && depth < 5) {
      const dbl = s[i + 1] === c;
      const mark = dbl ? c + c : c;
      const from = i + mark.length;
      const prev = i > 0 ? s[i - 1] : ' ';
      const okOpen = s[from] !== undefined && !/\s/.test(s[from]) && (c === '*' || (prev !== '_' && !/[A-Za-z0-9]/.test(prev)));
      const end = okOpen ? s.indexOf(mark, from + 1) : -1;
      if (end > 0 && !/\s/.test(s[end - 1]) && (c === '*' || (s[end + mark.length] !== '_' && !/[A-Za-z0-9]/.test(s[end + mark.length] || ' ')))) {
        flush();
        out.push({ t: dbl ? 'strong' : 'em', c: parseInline(s.slice(from, end), depth + 1) });
        i = end + mark.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const cells = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(x => x.trim());
};

const startsBlock = (l) => FENCE_OPEN.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST_ITEM.test(l);
const indentOf = (l) => /^ */.exec(l)[0].length;
const expandTabs = (l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length));

/**
 * One list, from its first item. An item owns every following line that is indented past its marker (a loose list's blank lines, a wrapped
 * line, a code fence, a nested list) and a lazy continuation line; those lines, de-indented, are parsed as blocks of their own, so a fence
 * in step 1 does not end the list and step 2 is still 2 (PR #226 Miguel B2, Dexter 8). The next item continues the list across blank
 * lines. `start` is the first marker's number: the others are counted from it, as CommonMark does.
 */
function parseList(lines, from, depth) {
  const first = LIST_ITEM.exec(expandTabs(lines[from]));
  const base = first[1].length;
  const ordered = /\d/.test(first[2][0]);
  const items = [];
  let i = from;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(expandTabs(lines[i]));
    if (!m || m[1].length > base || /\d/.test(m[2][0]) !== ordered) break;
    const offset = m[1].length + m[2].length + 1;
    const content = [m[3]];
    let j = i + 1;
    let blanks = 0;
    let fenced = FENCE_OPEN.test(m[3]);
    while (j < lines.length) {
      const l = expandTabs(lines[j]);
      if (l.trim() === '') { blanks++; j++; continue; }
      const ind = indentOf(l);
      if (ind > m[1].length) {
        for (; blanks > 0; blanks--) content.push('');
        content.push(l.slice(Math.min(ind, offset)));
      } else if (blanks === 0 && !fenced && !startsBlock(l)) {
        content.push(l.trim());                          // a lazy continuation of the item's paragraph
      } else break;
      if (/^ {0,3}(`{3,}|~{3,})/.test(content[content.length - 1])) fenced = !fenced;
      j++;
    }
    const sub = depth >= MAX_DEPTH ? [{ type: 'paragraph', inlines: [text(content.join('\n'))], raw: content.join('\n') }] : parseBlocks(content, depth + 1);
    const head = sub.length > 0 && sub[0].type === 'paragraph' ? sub[0] : null;
    items.push({ inlines: head ? head.inlines : [], blocks: head ? sub.slice(1) : sub });
    i = j;
  }
  const block = { type: 'list', ordered, items };
  if (ordered) block.start = Math.min(parseInt(first[2], 10), 999999999);
  return { block, next: i };
}

function parseBlocks(lines, depth) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const f = FENCE_OPEN.exec(line);
    if (f) {
      const mark = f[1];
      const body = [];
      const indent = /^ */.exec(line)[0].length;          // an indented opener: that much indent is the fence's, not the code's
      i++;
      while (i < lines.length) {
        const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (m && m[1][0] === mark[0] && m[1].length >= mark.length) { i++; break; }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      blocks.push({ type: 'code', lang: f[2] || '', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, inlines: parseInline(h[2]) }); i++; continue; }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(lines[i].replace(/^ {0,3}> ?/, '')); i++; }
      blocks.push({ type: 'quote', text: inner.join('\n'),
        blocks: depth >= MAX_DEPTH ? [{ type: 'paragraph', inlines: [text(inner.join('\n'))] }] : parseBlocks(inner, depth + 1) });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const r = parseList(lines, i, depth);
      blocks.push(r.block);
      i = r.next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line).map(c => parseInline(c));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) { rows.push(cells(lines[i]).map(c => parseInline(c))); i++; }
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
    const prev = blocks[blocks.length - 1];
    const block = { type: 'paragraph', inlines: parseInline(para.join('\n')), raw: para.join('\n') };
    if (prev && prev.type === 'paragraph' && DRAFT_CUE.test(prev.raw.split('\n').pop())) block.draft = true;
    blocks.push(block);
  }
  return blocks;
}

function parseMarkdown(src) {
  if (typeof src !== 'string' || src === '') return [];
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), 0);
}

const plainOf = (inlines) => inlines.map(n => (n.t === 'text' || n.t === 'code' ? n.v : plainOf(n.c || []))).join('');

/** Every Copy button the blocks earn, in reading order. */
function copyTargets(blocks) {
  const out = [];
  const inlines = (list) => { for (const n of list) { if (n.t === 'code' && n.copy) out.push({ kind: 'inline', text: n.v }); if (n.c) inlines(n.c); } };
  const walk = (bs) => {
    for (const b of bs) {
      if (b.type === 'code') out.push({ kind: 'code', text: b.text });
      else if (b.type === 'quote') out.push({ kind: 'quote', text: b.text });
      else if (b.type === 'paragraph') { if (b.draft === true) out.push({ kind: 'draft', text: b.raw }); inlines(b.inlines); }
      else if (b.type === 'heading') inlines(b.inlines);
      else if (b.type === 'list') b.items.forEach(it => { inlines(it.inlines); walk(it.blocks); });
      else if (b.type === 'table') { b.head.forEach(inlines); b.rows.forEach(r => r.forEach(inlines)); }
    }
  };
  walk(blocks);
  return out;
}

const api = { parseMarkdown, parseInline, copyTargets, looksLikeCommand, looksLikePath, isSafeHref, plainOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatBlocks = api;

})(typeof window !== 'undefined' ? window : globalThis);
