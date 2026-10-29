'use strict';
/**
 * The chat view's DOM (BACKLOG #157 + #149, documentation/DESIGN_CHAT_VIEW.md): the conversation as bubbles, a Copy
 * button on every code block, command or path, quote and draft plus "Copy reply" on each of Claude's messages, a
 * "Claude is working..." line, the one-line flip note, and the type box.
 *
 *   create({ doc, els, copy, openLink, send, later }) -> { update(state), focusInput(), submit() }
 *
 * `els` are the elements app/renderer.html already holds: { root, log, working, flip, form, input }.
 * `update({ messages, working, view: { show, note } })` repaints; `copy(text)` goes through the clipboard bridge,
 * `openLink(href)` opens a link in the person's browser, `send(text)` types the message into the CLI (the caller
 * puts it on the pty exactly like typing) and answers { ok }.
 *
 * MODEL TEXT IS UNTRUSTED: every node here is built with createElement and textContent from app/chat-blocks.js's
 * blocks. There is no innerHTML, no insertAdjacentHTML, no outerHTML anywhere in this file (test/chat-display.test.js
 * scans for them), a link only exists if chat-blocks vouched for its address, and it opens through `openLink`,
 * never by navigating this page.
 *
 * Loaded as a plain <script> in renderer.html, so it is wrapped: every file there shares ONE global scope (CLAUDE.md).
 */

(function (root) {

const markdown = () => (typeof module !== 'undefined' && module.exports ? require('./chat-blocks') : root.chatBlocks);
const COPIED_MS = 1500;
const STICK_PX = 40;           // within this of the bottom, new messages keep the view at the bottom

function create({ doc, els, copy, openLink, send, later = (fn, ms) => setTimeout(fn, ms) }) {
  const md = markdown();
  let shown = null;            // the message signature last painted: ids and text lengths (null: nothing painted yet)

  const el = (tag, cls, txt) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };

  function copyButton(label, getText, cls = '', idle = 'Copy') {
    const b = el('button', `chat-copy ${cls}`.trim(), idle);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', async (ev) => {
      ev.preventDefault();
      let ok = false;
      try { const r = await copy(getText()); ok = !r || r.ok !== false; } catch { ok = false; }
      b.textContent = ok ? 'Copied' : 'Couldn\'t copy';
      b.classList.toggle('chat-copy-ok', ok);
      later(() => { b.textContent = idle; b.classList.remove('chat-copy-ok'); }, COPIED_MS);
    });
    return b;
  }

  function inlines(list, parent) {
    for (const n of list) {
      if (n.t === 'text') parent.append(doc.createTextNode(n.v));
      else if (n.t === 'code') {
        const wrap = el('span', 'chat-inline');
        wrap.append(el('code', 'chat-code', n.v));
        if (n.copy) wrap.append(copyButton('Copy this command or path', () => n.v, 'chat-copy-inline'));
        parent.append(wrap);
      } else if (n.t === 'strong' || n.t === 'em') {
        const e = el(n.t === 'strong' ? 'strong' : 'em');
        inlines(n.c, e);
        parent.append(e);
      } else if (n.t === 'link') {
        const a = el('a', 'chat-link');
        a.setAttribute('href', n.href);
        a.setAttribute('rel', 'noopener noreferrer');
        a.title = n.href;
        inlines(n.c, a);
        a.addEventListener('click', (ev) => { ev.preventDefault(); openLink(n.href); });
        parent.append(a);
      }
    }
  }

  function blocks(list, parent) {
    for (const b of list) {
      if (b.type === 'heading') {
        const h = el('div', `chat-h chat-h${Math.min(b.level, 4)}`);
        h.setAttribute('role', 'heading');
        h.setAttribute('aria-level', String(Math.min(b.level + 1, 6)));
        inlines(b.inlines, h);
        parent.append(h);
      } else if (b.type === 'paragraph') {
        const p = el('p', 'chat-p');
        inlines(b.inlines, p);
        if (b.draft === true) {
          const wrap = el('div', 'chat-draft');
          wrap.append(p, copyButton('Copy this draft', () => b.raw));
          parent.append(wrap);
        } else parent.append(p);
      } else if (b.type === 'code') {
        const box = el('div', 'chat-codeblock');
        const bar = el('div', 'chat-codebar');
        bar.append(el('span', 'chat-lang', b.lang), copyButton('Copy this code', () => b.text));
        const pre = el('pre', 'chat-pre');
        pre.append(el('code', '', b.text));
        box.append(bar, pre);
        parent.append(box);
      } else if (b.type === 'quote') {
        const box = el('div', 'chat-quotebox');
        const q = el('blockquote', 'chat-quote');
        blocks(b.blocks, q);
        box.append(q, copyButton('Copy this quote', () => b.text));
        parent.append(box);
      } else if (b.type === 'list') {
        const l = el(b.ordered ? 'ol' : 'ul', 'chat-list');
        for (const it of b.items) {
          const li = el('li', 'chat-li');
          if (it.depth > 0) li.style.marginLeft = `${it.depth * 16}px`;
          inlines(it.inlines, li);
          l.append(li);
        }
        parent.append(l);
      } else if (b.type === 'table') {
        const t = el('table', 'chat-table');
        const head = el('tr');
        for (const c of b.head) { const th = el('th'); inlines(c, th); head.append(th); }
        t.append(head);
        for (const r of b.rows) { const tr = el('tr'); for (const c of r) { const td = el('td'); inlines(c, td); tr.append(td); } t.append(tr); }
        parent.append(t);
      } else if (b.type === 'hr') parent.append(el('hr', 'chat-hr'));
    }
  }

  function message(m) {
    if (m.role === 'note') return el('div', 'chat-msg chat-note', m.text);
    const box = el('div', `chat-msg ${m.role === 'user' ? 'chat-user' : 'chat-claude'}`);
    box.dataset.id = String(m.id);
    box.append(el('div', 'chat-who', m.role === 'user' ? 'You' : 'Claude'));
    if (m.role === 'user') box.append(el('div', 'chat-text', m.text));
    else {
      const body = el('div', 'chat-body');
      blocks(md.parseMarkdown(m.text), body);
      box.append(body);
    }
    if (m.truncated === true) box.append(el('div', 'chat-cut', 'This message was cut here. The whole of it is in the terminal.'));
    if (m.role === 'assistant') {
      const actions = el('div', 'chat-actions');
      actions.append(copyButton('Copy the whole reply', () => m.text, 'chat-copy-reply', 'Copy reply'));
      box.append(actions);
    }
    return box;
  }

  const signature = (messages) => messages.map(m => `${m.id}:${m.text.length}`);
  const same = (a, b) => b !== null && a.length === b.length && a.every((x, i) => x === b[i]);

  function update(state) {
    const view = state && state.view ? state.view : { show: 'terminal', note: null };
    const messages = state && Array.isArray(state.messages) ? state.messages : [];
    const becameVisible = view.show === 'chat' && els.root.hidden;
    els.root.hidden = view.show !== 'chat';
    els.flip.hidden = !view.note;
    els.flip.textContent = view.note || '';
    els.working.hidden = !(view.show === 'chat' && state && state.working === true);
    const log = els.log;
    const sig = signature(messages);
    if (same(sig, shown)) {
      // A hidden element has no scroll height: coming into view starts at the newest message, not the top.
      if (becameVisible) log.scrollTop = log.scrollHeight;
      return;
    }
    shown = sig;
    const atBottom = becameVisible || log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_PX;
    while (log.firstChild) log.removeChild(log.firstChild);
    if (messages.length === 0) log.append(el('div', 'chat-empty', 'Nothing to show yet. Your prompts and Claude\'s replies will appear here, without the tool lines.'));
    for (const m of messages) log.append(message(m));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async function submit() {
    const text = els.input.value;
    if (text.trim() === '') return;
    let r;
    try { r = await send(text); } catch { r = { ok: false }; }
    if (!r || r.ok !== false) { els.input.value = ''; els.input.style.height = ''; }
  }

  els.form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
  els.input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    submit();
  });

  return { update, submit, focusInput: () => els.input.focus() };
}

const api = { create, COPIED_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatDisplay = api;

})(typeof window !== 'undefined' ? window : globalThis);
