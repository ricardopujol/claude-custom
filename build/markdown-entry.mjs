// The Markdown reader's bundle, source (BACKLOG #119 A9). Built by build/build-markdown.mjs into
// app/markdown-reader.js and loaded by app/repo-reader.js the FIRST time a Markdown file is shown rendered, never at
// startup. The page reaches it as `window.repoMarkdown`; it leaks no other global.
//
//   render(text, { fromFile, onLink }) -> Promise<{ node, diagrams: { ok, failed }, scrollToAnchor }>
//     node     a <div class="md-page"> to mount; its links (the page's and a diagram's) are wired to
//              onLink({ kind, target, fragment }) by one delegated click/Enter handler (kind and target from
//              app/markdown-links.js)
//     fromFile the worktree-relative path of the file being read, which relative links resolve against
//
// SECURITY IS THE POINT, and it lives in build/markdown-render.mjs (the sanitizing pipeline, tested under jsdom by
// test/markdown-render.test.js): every byte of HTML goes through DOMPurify (its own instance), every <a> loses its
// href, an image is its alt text. What this file adds is Mermaid:
//   - securityLevel 'strict' (a diagram's own %%{init}%% cannot raise it: that key is secure), startOnLoad false, SVG
//     text labels (no foreignObject), layout dagre (elkjs is not in the bundle). `themeCSS`, `theme` and `fontFamily`
//     in a fence's init stay fence-controllable; the CSP blocks remote url() and the probe checks the app chrome is
//     unchanged (PR #204 Miguel S1).
//   - the diagram's SVG goes through the same sanitizer again (`diagramFragment`), which also takes the href off a
//     Mermaid `click A "https://..."` link (Miguel B1) and routes it like a page link.
//   - a diagram that fails to parse stays as its source block with "diagram didn't render: <reason>" under it.
import mermaid from 'mermaid';
import { createRenderer, slug } from './markdown-render.mjs';

const MAX_REASON = 160;
const MAX_DIAGRAMS = 30;

let renderer = null;
const sanitizer = () => (renderer = renderer || createRenderer(window));

// A token can be a color-mix() (--panel is), which the browser computes to `color(srgb ...)`, a form Mermaid's colour
// library does not read; one pixel on a canvas turns any colour the browser knows into plain rgba().
function token(name, fallback) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name}, ${fallback})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.canvas.width = 1;
  ctx.canvas.height = 1;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

const TOKENS = [['--text', '#c7cede'], ['--dim', '#6d7689'], ['--accent', '#d08c4a'], ['--border', '#262b38'], ['--bg', '#11131a'], ['--panel', '#1f2330']];
let configuredFor = null;

// Mermaid is configured once per look: the key is the tokens' raw values plus the font, so a theme change reconfigures
// and an ordinary render does not (PR #204 Miguel S2: this used to build six canvases on every render).
function configureMermaid() {
  const css = getComputedStyle(document.documentElement);
  const font = getComputedStyle(document.body).fontFamily;
  const key = `${TOKENS.map(([n]) => css.getPropertyValue(n)).join('|')}|${font}`;
  if (key === configuredFor) return;
  const [text, dim, accent, border, bg, panel] = TOKENS.map(([n, f]) => token(n, f));
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    logLevel: 'fatal',
    layout: 'dagre',                               // this Mermaid's default is elk; elkjs is not in the bundle (build/markdown-elk-stub.mjs)
    theme: 'base',
    fontFamily: font,
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
  configuredFor = key;
}

const reason = (err) => {
  const msg = String((err && err.message) || err || 'unknown error').split('\n').map((l) => l.trim()).find((l) => l !== '') || 'unknown error';
  return msg.length > MAX_REASON ? `${msg.slice(0, MAX_REASON - 1)}…` : msg;
};

let sequence = 0;
async function diagrams(node, fromFile) {
  const doc = node.ownerDocument;
  const found = [...node.querySelectorAll('pre > code.language-mermaid')];
  const out = { ok: 0, failed: 0 };
  if (found.length === 0) return out;
  let configError = null;
  try { configureMermaid(); } catch (err) { configError = err; }     // a failure here costs the diagrams, never the page
  for (const code of found.slice(0, MAX_DIAGRAMS)) {
    const pre = code.parentElement;
    const id = `mmd-${++sequence}`;
    try {
      if (configError) throw configError;
      const { svg } = await mermaid.render(id, code.textContent);
      const clean = sanitizer().diagramFragment(svg, { fromFile });
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
  const hit = [...node.querySelectorAll('[data-md-anchor]')].find((h) => h.getAttribute('data-md-anchor') === want || h.getAttribute('data-md-anchor') === target);
  if (hit) hit.scrollIntoView({ block: 'start' });
  return !!hit;
}

async function render(text, { fromFile = '', onLink } = {}) {
  const node = document.createElement('div');
  node.className = 'md-page';
  node.append(sanitizer().pageFragment(text, { fromFile }));

  const follow = (a) => {
    const kind = a.getAttribute('data-md-kind');
    if (kind === 'anchor') { scrollToAnchor(node, a.getAttribute('data-md-target')); return; }
    if ((kind === 'file' || kind === 'http') && typeof onLink === 'function') {
      onLink({ kind, target: a.getAttribute('data-md-target'), fragment: a.getAttribute('data-md-fragment') || '' });
    }
  };
  const linkOf = (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-md-kind]') : null;
    return a && node.contains(a) ? a : null;
  };
  // ANY click on a link is ours: preventDefault first, so even an anchor that somehow kept an href cannot navigate
  node.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && node.contains(a)) e.preventDefault();
    const link = linkOf(e);
    if (link) follow(link);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const link = linkOf(e);
    if (!link) return;
    e.preventDefault();
    follow(link);
  });

  const counts = await diagrams(node, fromFile);
  return { node, diagrams: counts, scrollToAnchor: (t) => scrollToAnchor(node, t) };
}

window.repoMarkdown = Object.freeze({ render, slug });
