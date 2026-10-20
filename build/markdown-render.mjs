// The Markdown reader's sanitizing pipeline (BACKLOG #119 A9): text -> HTML -> a sanitized, tidied DocumentFragment.
// Bundled into app/markdown-reader.js by build/markdown-entry.mjs, and driven by test/markdown-render.test.js with a
// jsdom window, so the security claim is checked by `npm test` and not only by the Electron probe.
//
//   createRenderer(win) -> { pageFragment(text, { fromFile }), diagramFragment(svgText, { fromFile }) }
//
// A Markdown file is data: it must never run, load or navigate anything.
//   - marked turns the text into HTML, and EVERY byte of that HTML goes through DOMPurify before it touches the DOM
//     (RETURN_DOM_FRAGMENT: the sanitized tree is mounted as it is, never re-parsed from a string). HTML profile only:
//     no svg, no MathML; no style, form, frame or object tags; no style, id, name or event attributes. `id` and `name`
//     go because an id like `reader` would shadow the app's own elements; headings get a data attribute instead.
//   - then our own pass over the SANITIZED tree: every <a> loses its href (nothing can navigate natively; a click is
//     classified by app/markdown-links.js and handed to the page), every <img> becomes its alt text, inputs are
//     read-only checkboxes or gone, classes are dropped except `language-*` on <code>.
//   - a diagram's SVG gets the same rule: Mermaid turns `click A "https://..."` into an <a xlink:href>, which DOMPurify
//     allows and which would NAVIGATE THE TAB (PR #204 Miguel B1). Every <a> in it loses its href too, and is wired like
//     a page link; any other element keeps only a same-document `#ref`.
//   - OWN DOMPurify INSTANCE. Mermaid installs hooks on the shared default instance and never removes them (PR #204
//     Miguel Y2); this one is made here, so what a page is sanitized by never depends on a diagram having rendered.
//   - the visible text of a link can name one site while its address (shown on hover) names another. Accepted, as for
//     the terminal's links (PR #81): the address is always shown before the click.
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { classifyHref } from '../app/markdown-links.js';

export const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'template', 'audio', 'video', 'source', 'track', 'picture', 'dialog'],
  FORBID_ATTR: ['style', 'id', 'name', 'srcset', 'formaction', 'action', 'ping', 'autofocus', 'contenteditable'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};
export const SANITIZE_SVG = { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true };

export function slug(text) {
  return String(text).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

// An <a> (HTML or SVG) becomes a classified, inert-by-default link: no href, no target, the kind and target as data.
function linkify(el, href, fromFile) {
  const link = classifyHref(href, { fromFile });
  el.setAttribute('data-md-kind', link.kind);
  if (link.kind === 'inert') {
    el.setAttribute('class', 'md-inert');
    el.setAttribute('title', 'This link isn’t opened from here');
    return;
  }
  el.setAttribute('data-md-target', link.target);
  if (link.kind === 'file') el.setAttribute('data-md-fragment', link.fragment || '');
  el.setAttribute('title', link.kind === 'file' ? `${link.target} (opens in the reader)` : link.kind === 'anchor' ? `#${link.target}` : link.target);
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'link');
}

// Takes every link-ish attribute off `el` and returns the href it had (any namespace: href, xlink:href), or null.
function takeHref(el) {
  let href = null;
  for (const at of [...el.attributes]) {
    const name = at.localName.toLowerCase();
    if (name === 'href' && href === null) href = at.value;
    if (['href', 'target', 'rel', 'download', 'ping', 'referrerpolicy', 'xlink:href'].includes(name) || at.name.toLowerCase() === 'xlink:href') el.removeAttributeNode(at);
  }
  return href;
}

function tidyPage(fragment, fromFile) {
  const doc = fragment.ownerDocument;
  const slugs = new Map();
  for (const el of [...fragment.querySelectorAll('*')]) {
    const tag = el.tagName;
    const cls = el.getAttribute('class');
    if (cls !== null) {
      if (tag === 'CODE' && /^language-[\w+#.-]{1,40}$/.test(cls)) el.setAttribute('class', cls); else el.removeAttribute('class');
    }
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    if (tag === 'A') {
      linkify(el, takeHref(el), fromFile);
    } else if (tag === 'IMG') {
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
      el.setAttribute('data-md-anchor', s);
    }
  }
  for (const table of [...fragment.querySelectorAll('table')]) {
    const wrap = doc.createElement('div');
    wrap.className = 'md-table';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function tidyDiagram(fragment, fromFile) {
  for (const el of [...fragment.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    if (el.localName.toLowerCase() === 'a') {
      linkify(el, takeHref(el), fromFile);
    } else {
      // <use href="#marker"> and the like may point inside the document, never out of it
      const href = takeHref(el);
      if (typeof href === 'string' && /^#[\w:.-]+$/.test(href)) el.setAttribute('href', href);
    }
  }
}

export function createRenderer(win) {
  const purify = createDOMPurify(win);
  const marked = new Marked({ gfm: true, breaks: false });
  return {
    purify,
    pageFragment(text, { fromFile = '' } = {}) {
      const fragment = purify.sanitize(marked.parse(String(text), { async: false }), SANITIZE);
      tidyPage(fragment, fromFile);
      return fragment;
    },
    diagramFragment(svgText, { fromFile = '' } = {}) {
      const fragment = purify.sanitize(String(svgText), SANITIZE_SVG);
      tidyDiagram(fragment, fromFile);
      return fragment;
    },
  };
}
