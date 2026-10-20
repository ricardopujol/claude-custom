// The Markdown reader's bundle, source (BACKLOG #119 A9). Built by build/build-markdown.mjs into
// app/markdown-reader.js and loaded by app/repo-reader.js the FIRST time a Markdown file is shown rendered, never at
// startup. The page reaches it as `window.repoMarkdown`; it leaks no other global.
//
//   render(text, { fromFile, onLink }) -> Promise<{ node, diagrams: { ok, failed } }>
//     node     a <div class="md-page"> to mount; its links are wired to onLink({ kind, target, fragment }) by one
//              delegated click/Enter handler (kind and target from app/markdown-links.js)
//     fromFile the worktree-relative path of the file being read, which relative links resolve against
//
// SECURITY IS THE POINT. A Markdown file is data: it must never run, load or navigate anything.
//   - marked turns the text into HTML, and EVERY byte of that HTML goes through DOMPurify before it touches the DOM
//     (RETURN_DOM_FRAGMENT: the sanitized tree is mounted as it is, never re-parsed from a string). The HTML profile
//     only: no svg, no MathML; no style, form, frame or object tags; no style, id, name or event attributes. `id` and
//     `name` go because an id like `reader` would shadow the app's own elements; headings get a data attribute instead.
//   - then our own pass over the SANITIZED tree: every <a> loses its href (nothing can navigate natively; a click is
//     classified by app/markdown-links.js and handed to onLink), every <img> becomes its alt text (nothing is fetched),
//     inputs are read-only checkboxes or gone, and classes are dropped except `language-*` on <code>.
//   - Mermaid runs with securityLevel 'strict' (a diagram's own %%{init}%% cannot raise it: that key is secure),
//     startOnLoad false, labels as SVG text (no foreignObject), and its SVG goes through DOMPurify again.
//   - a diagram that fails to parse stays as its source block with "diagram didn't render: <reason>" under it.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { classifyHref } from '../app/markdown-links.js';

const MAX_REASON = 160;
const MAX_DIAGRAMS = 30;

const marked = new Marked({ gfm: true, breaks: false });

const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'template', 'audio', 'video', 'source', 'track', 'picture', 'dialog'],
  FORBID_ATTR: ['style', 'id', 'name', 'srcset', 'formaction', 'action', 'ping', 'autofocus', 'contenteditable'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};
const SANITIZE_SVG = { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true };

function slug(text) {
  return String(text).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

// A colour token of the page (the project's look: dark or light) as the rgb() Mermaid's colour maths can read.
function token(name, fallback) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name}, ${fallback})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

function configureMermaid() {
  const text = token('--text', '#c7cede');
  const dim = token('--dim', '#6d7689');
  const accent = token('--accent', '#d08c4a');
  const border = token('--border', '#262b38');
  const bg = token('--bg', '#11131a');
  const panel = token('--panel', '#1f2330');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    logLevel: 'fatal',
    theme: 'base',
    fontFamily: getComputedStyle(document.body).fontFamily,
    flowchart: { htmlLabels: false },
    htmlLabels: false,
    themeVariables: {
      background: bg, primaryColor: panel, primaryTextColor: text, primaryBorderColor: border, secondaryColor: panel,
      tertiaryColor: bg, lineColor: dim, textColor: text, mainBkg: panel, nodeBorder: accent, clusterBkg: bg,
      clusterBorder: border, edgeLabelBackground: bg, titleColor: text, noteBkgColor: panel, noteTextColor: text,
      noteBorderColor: border, actorBkg: panel, actorBorder: accent, actorTextColor: text, actorLineColor: dim,
      signalColor: text, signalTextColor: text, labelBoxBkgColor: panel, labelTextColor: text, loopTextColor: text,
    },
  });
}

// marked: a fence keeps its language as a class on <code>; everything else is marked's own output
function toHtml(text) {
  return marked.parse(String(text), { async: false });
}

function tidy(fragment, fromFile) {
  const doc = fragment.ownerDocument;
  const all = [...fragment.querySelectorAll('*')];
  const slugs = new Map();
  for (const el of all) {
    const tag = el.tagName;
    // classes: only the language of a fenced block survives
    const cls = el.getAttribute('class');
    if (cls !== null) {
      if (tag === 'CODE' && /^language-[\w+#.-]{1,40}$/.test(cls)) el.setAttribute('class', cls); else el.removeAttribute('class');
    }
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    if (tag === 'A') {
      const link = classifyHref(el.getAttribute('href'), { fromFile });
      for (const a of ['href', 'target', 'rel', 'download', 'ping', 'referrerpolicy']) el.removeAttribute(a);
      el.dataset.mdKind = link.kind;
      if (link.kind === 'inert') {
        el.classList.add('md-inert');
        el.title = 'This link isn’t opened from here';
      } else {
        el.dataset.mdTarget = link.target;
        if (link.kind === 'file') el.dataset.mdFragment = link.fragment || '';
        el.title = link.kind === 'file' ? `${link.target} (opens in the reader)` : link.kind === 'anchor' ? `#${link.target}` : link.target;
        el.tabIndex = 0;
        el.setAttribute('role', 'link');
      }
    } else if (tag === 'IMG') {
      // nothing is fetched or shown from a path or a URL: the alt text stands in, dim
      const stand = doc.createElement('span');
      stand.className = 'md-img';
      stand.textContent = `[image${el.getAttribute('alt') ? `: ${el.getAttribute('alt')}` : ''}]`;
      el.replaceWith(stand);
    } else if (tag === 'INPUT') {
      if (String(el.getAttribute('type')).toLowerCase() === 'checkbox') {
        const on = el.hasAttribute('checked');
        for (const a of [...el.attributes]) el.removeAttribute(a.name);
        el.setAttribute('type', 'checkbox');
        el.setAttribute('disabled', '');
        if (on) el.setAttribute('checked', '');
      } else {
        el.remove();
      }
    } else if (/^H[1-6]$/.test(tag)) {
      let s = slug(el.textContent) || 'section';
      const n = slugs.get(s) || 0;
      slugs.set(s, n + 1);
      if (n > 0) s = `${s}-${n}`;
      el.dataset.mdAnchor = s;
    }
  }
  // a table scrolls horizontally inside its own container
  for (const table of [...fragment.querySelectorAll('table')]) {
    const wrap = doc.createElement('div');
    wrap.className = 'md-table';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

const reason = (err) => {
  const msg = String((err && err.message) || err || 'unknown error').split('\n').map((l) => l.trim()).find((l) => l !== '') || 'unknown error';
  return msg.length > MAX_REASON ? `${msg.slice(0, MAX_REASON - 1)}…` : msg;
};

let sequence = 0;
async function diagrams(node) {
  const doc = node.ownerDocument;
  const found = [...node.querySelectorAll('pre > code.language-mermaid')];
  const out = { ok: 0, failed: 0 };
  if (found.length === 0) return out;
  configureMermaid();
  for (const code of found.slice(0, MAX_DIAGRAMS)) {
    const pre = code.parentElement;
    const id = `mmd-${++sequence}`;
    try {
      const { svg } = await mermaid.render(id, code.textContent);
      const clean = DOMPurify.sanitize(svg, SANITIZE_SVG);
      if (!clean.querySelector('svg')) throw new Error('the diagram came out empty');
      const box = doc.createElement('div');
      box.className = 'md-diagram';
      box.append(clean);
      pre.replaceWith(box);
      out.ok += 1;
    } catch (err) {
      const note = doc.createElement('p');
      note.className = 'md-diagram-error';
      note.textContent = `diagram didn’t render: ${reason(err)}`;
      pre.after(note);
      out.failed += 1;
    } finally {
      for (const stray of [id, `d${id}`, `i${id}`]) { const el = doc.getElementById(stray); if (el) el.remove(); }
    }
  }
  for (const code of found.slice(MAX_DIAGRAMS)) {
    const note = doc.createElement('p');
    note.className = 'md-diagram-error';
    note.textContent = `diagram not drawn: only the first ${MAX_DIAGRAMS} diagrams of a page are`;
    code.parentElement.after(note);
  }
  return out;
}

function scrollToAnchor(node, target) {
  const want = slug(target);
  const hit = [...node.querySelectorAll('[data-md-anchor]')].find((h) => h.dataset.mdAnchor === want || h.dataset.mdAnchor === target);
  if (hit) hit.scrollIntoView({ block: 'start' });
  return !!hit;
}

async function render(text, { fromFile = '', onLink } = {}) {
  const doc = document;
  const fragment = DOMPurify.sanitize(toHtml(text), SANITIZE);
  tidy(fragment, fromFile);
  const node = doc.createElement('div');
  node.className = 'md-page';
  node.append(fragment);

  const follow = (a) => {
    const kind = a.dataset.mdKind;
    if (kind === 'anchor') { scrollToAnchor(node, a.dataset.mdTarget); return; }
    if ((kind === 'file' || kind === 'http') && typeof onLink === 'function') {
      onLink({ kind, target: a.dataset.mdTarget, fragment: a.dataset.mdFragment || '' });
    }
  };
  node.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-md-kind]') : null;
    if (!a || !node.contains(a)) return;
    e.preventDefault();
    follow(a);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const a = e.target && e.target.closest ? e.target.closest('a[data-md-kind]') : null;
    if (!a || !node.contains(a)) return;
    e.preventDefault();
    follow(a);
  });

  const counts = await diagrams(node);
  return { node, diagrams: counts, scrollToAnchor: (t) => scrollToAnchor(node, t) };
}

window.repoMarkdown = Object.freeze({ render, slug });
