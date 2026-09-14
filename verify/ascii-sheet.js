'use strict';
/* Comparison sheet for the ASCII/Unicode-glyph icon spike, at the size the
   glyphs would ACTUALLY be displayed.

     node verify/ascii-sheet.js [generated.json] [hand-authored.json] [out.html] [subject,subject]

   Then render it:  npx electron verify/shoot.js <out.html> <out.png> 1500 900

   WHY this looks the way it does, in the order the decisions were forced:

   1. TRUE SIZE FIRST, ZOOM ONLY TO THE RIGHT. verify/actual-size.js is the
      cautionary tale this sheet inherits: six generation experiments went into
      expression detail for an asset that renders at 34x34, because nobody had
      looked at it at 34x34. A 4x zoom of a braille sword is always beautiful
      and never the question. The zoom column exists to diagnose WHY a true-size
      render failed, not to decide whether it passed.

   2. THE EMOJI BASELINE COMES FIRST IN EVERY BLOCK. Per the ART PLACEHOLDER
      RULE, every un-arted thing in this project already has an emoji, and an
      emoji is legible at 16px with no pipeline at all. So glyph art is not
      competing with nothing -- it is competing with that, and a comparison that
      doesn't show what is being given up isn't a comparison.

   3. THE FONT-SIZE MATH IS THE CRUX, SO IT IS MEASURED, NOT ASSUMED. To make a
      cols x rows block occupy exactly targetPx square you need
      font-size ~= targetPx / (cols * advanceRatio) and line-height = targetPx /
      rows. The usual "monospace advance is 0.6em" is folklore, and braille may
      not even resolve to the same face as ASCII in this font stack (the stack is
      the terminal's own, and braille coverage is a known concern in this repo).
      So the page measures the advance ratio per glyph class in-page, corrects
      every block against its own measured bounding box, and then RE-MEASURES and
      prints any block still off target by more than 1px at the top of the sheet.
      A sheet that says "34px" while drawing 41px would push the decision the
      wrong way and leave no trace of having done so.

   4. THE PAGE ENDS IN A VISIBLE MARKER. verify/shoot.js clamps to the display,
      so a tall page silently loses its bottom -- a truncated PNG looks exactly
      like a complete one. If the END OF SHEET line isn't in the PNG, subjects
      are missing. Prefer one PNG per subject via the filter argument.
*/
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');

// --only=a,b is accepted anywhere, so a filter doesn't force you to spell out
// all three paths first.
const argv = process.argv.slice(2);
const flagOnly = argv.filter(a => a.startsWith('--only='));
const pos = argv.filter(a => !a.startsWith('--'));

const genFile = path.resolve(pos[0] || path.join(repo, '.harness', 'ascii', 'generated.json'));
const handFile = path.resolve(pos[1] || path.join(repo, 'spike-ascii', 'hand-authored.json'));
const outFile = path.resolve(pos[2] || path.join(repo, '.harness', 'ascii-sheet.html'));
const only = [...flagOnly.map(f => f.slice(7)), pos[3] || '']
  .join(',').split(',').map(s => s.trim()).filter(Boolean);

// True display sizes. 34 is the roster's face size and the one that decides
// this spike; 16 is the smallest place an icon lands; 48 is the generous case.
const SIZES = [16, 24, 34, 48];
const ZOOM_OF = 34;
// The zoom column is 136px tall and therefore sets the height of every row,
// which is what pushes a single subject past the screenshot fold. --zoom=0
// drops it for a decide-at-true-size pass; the default keeps it, because a
// diagnose pass needs to see why a 34px block failed.
const ZOOM_FACTOR = (() => {
  const f = process.argv.find(a => a.startsWith('--zoom='));
  const n = f ? Number(f.slice(7)) : 4;
  return Number.isFinite(n) && n >= 0 ? n : 4;
})();
const ZOOM = ZOOM_OF * ZOOM_FACTOR;
const showZoom = ZOOM_FACTOR > 0;

const FONT_STACK = '"CaskaydiaCove Nerd Font", "Cascadia Mono", Consolas, monospace';
const EMOJI_STACK = '"Segoe UI Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif';
const BG = '#11131a';        // the app background -- the real backdrop
const PANEL = '#171a23';     // panel chrome
const LIGHT = '#dfe4ee';     // a light surface, to see what mono fg does there

/** Read a manifest, never throwing: a missing or broken one is reported on the
 *  page rather than taking the sheet down, because both files are produced by
 *  other agents and either may not exist yet. */
function loadManifest(file, label) {
  if (!fs.existsSync(file)) {
    return { ok: false, why: `not found at ${file}`, renders: [], subjects: [], sources: {}, label, file };
  }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ok: true, why: '', label, file,
      renders: Array.isArray(j.renders) ? j.renders : [],
      subjects: Array.isArray(j.subjects) ? j.subjects : [],
      sources: j.sources && typeof j.sources === 'object' ? j.sources : {},
    };
  } catch (err) {
    return { ok: false, why: `unreadable (${err.message})`, renders: [], subjects: [], sources: {}, label, file };
  }
}

const gen = loadManifest(genFile, 'generated');
const hand = loadManifest(handFile, 'hand-authored');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const url = p => 'file:///' + String(p).split(path.sep).join('/').replace(/\\/g, '/');

// Colours come from a file another process wrote, and land in a style
// attribute. Anything that isn't a plain hex is dropped rather than trusted.
const safeColor = c => (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(String(c)) ? String(c) : null);

// ---------------------------------------------------------------- merge ----

const subjects = new Map();
for (const m of [gen, hand]) {
  for (const s of m.subjects) {
    if (!s || !s.id) continue;
    const prev = subjects.get(s.id);
    if (prev) {
      prev.label = prev.label || s.label;
      prev.emoji = prev.emoji || s.emoji;
      if (s.note && !String(prev.note).includes(s.note)) prev.note = [prev.note, s.note].filter(Boolean).join(' — ');
    } else {
      subjects.set(s.id, { id: s.id, label: s.label || s.id, emoji: s.emoji || '', note: s.note || '', declared: true });
    }
  }
}

const renders = [];
for (const m of [gen, hand]) {
  m.renders.forEach((r, i) => {
    if (!r || !Array.isArray(r.lines)) return;
    renders.push({ ...r, _origin: m.label, _idx: i, id: r.id || `${m.label}-${i}` });
  });
}

// A render for an undeclared subject must still appear -- silently dropping it
// would hide exactly the kind of manifest mismatch this sheet should surface.
for (const r of renders) {
  const sid = r.subject || '(no subject)';
  if (!subjects.has(sid)) {
    subjects.set(sid, { id: sid, label: sid, emoji: '', note: '', declared: false });
  }
}

const sources = { ...gen.sources, ...hand.sources };

let list = [...subjects.values()];
if (only.length) list = list.filter(s => only.includes(s.id));

// --------------------------------------------------------------- render ----

/** Pad to a rectangle and report anything the manifest got wrong about its own
 *  shape. The math below uses the WIDEST LINE, not the declared cols, because
 *  the widest line is what the browser will actually lay out. */
function shape(r) {
  const lines = r.lines.map(l => String(l));
  const widest = lines.reduce((m, l) => Math.max(m, [...l].length), 0);
  const declaredCols = Number(r.cols) || 0;
  const declaredRows = Number(r.rows) || 0;
  const cols = Math.max(widest, 1);
  const rows = Math.max(lines.length, 1);
  const warn = [];
  if (declaredCols && declaredCols !== widest) warn.push(`cols says ${declaredCols}, widest line is ${widest}`);
  if (declaredRows && declaredRows !== lines.length) warn.push(`rows says ${declaredRows}, got ${lines.length}`);
  if (r.fg) {
    if (!Array.isArray(r.fg)) warn.push('fg is not an array — ignored');
    else if (r.fg.length !== lines.length) warn.push(`fg has ${r.fg.length} rows for ${lines.length} lines`);
  } else if (r.color && r.color !== 'mono' && r.color !== 'accent') {
    warn.push(`color="${r.color}" but fg is null — drawn mono`);
  }
  const padded = lines.map(l => {
    const chars = [...l];
    while (chars.length < cols) chars.push(' ');
    return chars;
  });
  return { cols, rows, padded, warn };
}

/** Mono path stays span-free: one text node per block. Spans only appear where
 *  fg actually supplies per-character colour. */
function glyphHtml(r, sh) {
  const fg = Array.isArray(r.fg) ? r.fg : null;
  if (!fg) return esc(sh.padded.map(chars => chars.join('')).join('\n'));
  return sh.padded.map((chars, y) => chars.map((ch, x) => {
    const c = safeColor((fg[y] || [])[x]);
    return c ? `<span style="color:${c}">${esc(ch)}</span>` : esc(ch);
  }).join('')).join('\n');
}

function pre(r, sh, html, target, cls) {
  const tone = r.color === 'accent' && !r.fg ? ' accent' : '';
  return `<pre class="g${tone}${cls ? ' ' + cls : ''}" data-cols="${sh.cols}" data-rows="${sh.rows}"` +
    ` data-target="${target}" data-tech="${esc(r.technique || '?')}" data-id="${esc(r.id)}">${html}</pre>`;
}

function cell(inner, target, bg, cls) {
  return `<div class="cell ${cls || ''}" style="width:${Math.max(target, 56)}px">` +
    `<div class="frame" style="width:${target}px;height:${target}px;background:${bg}">${inner}</div></div>`;
}

function emojiCell(emoji, target, bg) {
  const p = `<pre class="g emoji" data-cols="1" data-rows="1" data-target="${target}"` +
    ` data-tech="emoji" data-id="emoji">${esc(emoji)}</pre>`;
  return cell(p, target, bg);
}

function zoomPart(inner) {
  return showZoom ? `<div class="gap"></div>${inner}` : '';
}

function sizeHeader(extra) {
  return `<div class="rrow head"><div class="lbl"></div>` +
    SIZES.map(s => `<div class="cell" style="width:${Math.max(s, 56)}px">${s}px${s === 34 ? ' ←' : ''}</div>`).join('') +
    zoomPart(`<div class="cell zoomcap" style="width:${ZOOM}px">` +
      `zoom ${ZOOM_FACTOR}× (the ${ZOOM_OF}px render, magnified — never the deciding view)</div>`) +
    `<div class="lbl">${extra || ''}</div></div>`;
}

function renderRow(r) {
  const sh = shape(r);
  const html = glyphHtml(r, sh);
  const meta = [r.technique, r.source, `${sh.cols}×${sh.rows}`, r.color].filter(Boolean).map(esc).join(' · ');
  const warn = sh.warn.length ? `<div class="warn">${sh.warn.map(esc).join('<br>')}</div>` : '';
  const cells = SIZES.map(s => cell(pre(r, sh, html, s), s, BG)).join('');
  return `<div class="rrow">` +
    `<div class="lbl"><b>${esc(r.id)}</b><div class="meta">${meta}</div>` +
    `<div class="origin ${r._origin === 'hand-authored' ? 'hand' : 'proc'}">${esc(r._origin)}</div>` +
    (r.note ? `<div class="note">${esc(r.note)}</div>` : '') + warn + `</div>` +
    cells + zoomPart(cell(pre(r, sh, html, ZOOM), ZOOM, BG, 'zoom')) +
    `<div class="lbl"></div></div>`;
}

/** One cheap strip per subject: every render at 34px on two other backgrounds.
 *  Mono foregrounds are tuned for #11131a, and this is where that shows. */
function contrastStrip(rs) {
  if (!rs.length) return '';
  const strip = (bg, name) => `<div class="rrow"><div class="lbl"><b>${name}</b><div class="meta">${bg}</div></div>` +
    rs.map(r => { const sh = shape(r); return cell(pre(r, sh, glyphHtml(r, sh), ZOOM_OF), ZOOM_OF, bg); }).join('') +
    `</div>`;
  return `<div class="strip"><div class="sub">contrast at ${ZOOM_OF}px — same renders, different surface</div>` +
    strip(PANEL, 'panel') + strip(LIGHT, 'light chrome') + `</div>`;
}

function sourceRow(subjectId) {
  const p = sources[subjectId];
  if (!p) return '';
  if (!fs.existsSync(p)) {
    return `<div class="rrow"><div class="lbl"><b>source PNG</b><div class="warn">listed but missing:<br>${esc(p)}</div></div></div>`;
  }
  const img = s => `<div class="cell" style="width:${Math.max(s, 56)}px"><img src="${url(p)}" style="width:${s}px;height:${s}px"></div>`;
  return `<div class="rrow"><div class="lbl"><b>source PNG</b>` +
    `<div class="meta">what the converter was given — a bad glyph and a bad source look the same without it</div></div>` +
    SIZES.map(img).join('') + zoomPart(img(ZOOM)) + `</div>`;
}

const sections = list.map(s => {
  const rs = renders.filter(r => (r.subject || '(no subject)') === s.id);
  const emojiRow = s.emoji
    ? `<div class="rrow baseline"><div class="lbl"><b>emoji baseline</b>` +
      `<div class="meta">what this already has today (ART PLACEHOLDER RULE)</div></div>` +
      SIZES.map(sz => emojiCell(s.emoji, sz, BG)).join('') +
      zoomPart(emojiCell(s.emoji, ZOOM, BG)) + `<div class="lbl"></div></div>`
    : `<div class="rrow baseline"><div class="lbl"><b>emoji baseline</b><div class="warn">no emoji declared for this subject — ` +
      `there is nothing to beat, so a "win" here is unmeasured</div></div></div>`;

  return `<section><h2>${esc(s.label)} <span class="sid">${esc(s.id)}</span>` +
    (s.declared ? '' : ` <span class="badge">undeclared subject — renders exist, no subjects[] entry</span>`) +
    `</h2>` +
    (s.note ? `<div class="snote">${esc(s.note)}</div>` : '') +
    sizeHeader() +
    emojiRow +
    sourceRow(s.id) +
    (rs.length ? rs.map(renderRow).join('') : `<div class="rrow"><div class="lbl empty">no renders for this subject</div></div>`) +
    contrastStrip(rs) +
    `</section>`;
}).join('');

const banners = [gen, hand].filter(m => !m.ok).map(m =>
  `<div class="banner">${esc(m.label)} manifest ${esc(m.why)} — this sheet shows only the other source. ` +
  `Any comparison drawn from it is one-sided.</div>`
).join('') + (list.length === 0 ? `<div class="banner">no subjects to show${only.length ? ` for filter: ${esc(only.join(', '))}` : ''}</div>` : '');

// ------------------------------------------------------------- the page ----

const page = `<!doctype html><meta charset="utf-8"><style>
:root{--text:#c7cede;--accent:#d08c4a;--ok:#5fb07a;--bad:#cc5f5f;--dim:#6d7689;--bg:${BG};--panel:${PANEL};--border:#262b38}
body{margin:0;background:var(--bg);color:var(--text);font:12px "Segoe UI",sans-serif;padding:14px}
h2{margin:0 0 3px;font-size:14px;color:var(--accent)}
.sid{color:var(--dim);font-size:11px;font-weight:400}
.badge{color:var(--bad);font-size:10px;font-weight:400}
.snote{color:var(--dim);font-size:10.5px;margin-bottom:6px;max-width:900px;line-height:1.45}
section{margin:0 0 18px;padding-bottom:10px;border-bottom:1px solid var(--border)}
/* Top-aligned, not bottom: the zoom cell is 136px tall and the true-size cells
   are 16-48px, so bottom alignment parks the only thing that matters at the far
   end of a column of empty space, away from its own label and column header. */
.rrow{display:flex;align-items:flex-start;gap:8px;margin-bottom:9px;border-top:1px solid rgba(38,43,56,.7);padding-top:6px}
.rrow.head{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px;border-top:none;padding-top:0}
.rrow.baseline{padding-bottom:6px;border-bottom:1px dashed var(--border)}
.lbl{width:250px;flex:none;font-size:11px;line-height:1.35}
.lbl b{color:var(--text);font-weight:600}
.meta{color:var(--dim);font-size:10px}
.note{color:var(--dim);font-size:10px;font-style:italic}
.origin{font-size:9px;text-transform:uppercase;letter-spacing:.06em}
.origin.proc{color:#5f84cc}.origin.hand{color:var(--ok)}
.warn{color:var(--bad);font-size:10px}
.empty{color:var(--dim)}
.cell{flex:none}
.frame{position:relative;outline:1px solid rgba(109,118,137,.35);outline-offset:0}
.gap{width:26px;flex:none}
.zoomcap{white-space:normal;line-height:1.3;text-transform:none;letter-spacing:0;font-size:10px}
.strip{margin-top:8px;padding-top:6px;border-top:1px dotted var(--border)}
.sub{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
img{display:block;object-fit:contain;image-rendering:auto}
pre.g{margin:0;padding:0;display:inline-block;vertical-align:top;white-space:pre;letter-spacing:0;
  font-variant-ligatures:none;font-kerning:none;font-feature-settings:"liga" 0,"calt" 0;
  font-family:${FONT_STACK};color:var(--text);font-size:10px;line-height:10px}
pre.g.accent{color:var(--accent)}
pre.g.emoji{font-family:${EMOJI_STACK}}
#report{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:9px 11px;margin-bottom:14px;font-size:11px;line-height:1.5}
#report h3{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim)}
#report .pass{color:var(--ok)}#report .fail{color:var(--bad)}
/* Fixed height so filling it in cannot change the page height it reports on. */
#clip{min-height:18px;overflow:hidden}
#report .tables{display:flex;gap:34px;align-items:flex-start;flex-wrap:wrap}
#report table{border-collapse:collapse;margin-top:5px;font-size:10.5px}
#report td,#report th{padding:1px 10px 1px 0;text-align:left;color:var(--dim);font-weight:400}
#report th{color:var(--text)}
.banner{background:#2a1d1d;border:1px solid var(--bad);color:#e8a9a9;border-radius:6px;padding:7px 10px;margin-bottom:10px;font-size:11px}
.tail{margin-top:6px;padding:8px 10px;border:1px dashed var(--accent);color:var(--accent);font-size:11px;border-radius:6px}
#fold{position:absolute;left:0;right:0;height:0;border-top:2px dashed var(--bad);z-index:9}
#fold span{position:absolute;right:4px;top:-15px;color:var(--bad);font-size:10px;background:var(--bg);padding:0 4px}
</style>
<div id="report">measuring…</div>
${banners}
${sections}
<div class="tail">END OF SHEET — if this line is not in your screenshot, shoot.js clamped to the display and subjects below the fold are MISSING. Re-run with a subject filter.</div>
<script>
(function(){
  // ---- 1. Measure the advance ratio in-page, per glyph class. 0.6em is
  // folklore, and braille/blocks may resolve to a different face than ASCII.
  function probe(cls, ch, n){
    const p = document.createElement('pre');
    p.className = 'g' + (cls ? ' ' + cls : '');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;font-size:100px;line-height:100px';
    p.textContent = ch.repeat(n);
    document.body.appendChild(p);
    const r = p.getBoundingClientRect();
    document.body.removeChild(p);
    return { ratio: r.width / (n * 100), height: r.height / 100 };
  }
  const PR = {
    ascii:   probe('', 'M', 50),
    braille: probe('', '\\u28FF', 50),
    blocks:  probe('', '\\u2588', 50),
    half:    probe('', '\\u2584', 50),
    emoji:   probe('emoji', '\\u2694\\uFE0F', 20),
  };

  const pres = Array.from(document.querySelectorAll('pre.g'));
  const ratioFor = p => p.classList.contains('emoji') ? PR.emoji.ratio : PR.ascii.ratio;

  // ---- 2. First guess from the measured ratio, then correct each block
  // against its OWN box: width is driven by font-size, height by line-height,
  // so the two knobs are independent and this converges immediately.
  for (const p of pres){
    const cols = +p.dataset.cols, rows = +p.dataset.rows, t = +p.dataset.target;
    p._fs = t / (cols * (ratioFor(p) || 0.6));
    p._lh = t / rows;
    p.style.fontSize = p._fs + 'px';
    p.style.lineHeight = p._lh + 'px';
  }
  for (let pass = 0; pass < 3; pass++){
    const rects = pres.map(p => p.getBoundingClientRect());   // batch reads
    pres.forEach((p, i) => {
      const t = +p.dataset.target, r = rects[i];
      if (r.width  > 0.01) p._fs *= t / r.width;
      if (r.height > 0.01) p._lh *= t / r.height;
      p.style.fontSize = p._fs + 'px';
      p.style.lineHeight = p._lh + 'px';
    });
  }

  // ---- 3. Re-measure and say so on the artifact. A sheet that claims 34px
  // while drawing 41px would send the decision the wrong way, invisibly.
  const fails = [], byTech = new Map();
  for (const p of pres){
    const r = p.getBoundingClientRect(), t = +p.dataset.target;
    const dw = r.width - t, dh = r.height - t;
    if (Math.abs(dw) > 1 || Math.abs(dh) > 1){
      fails.push(p.dataset.id + ' @' + t + 'px: ' + r.width.toFixed(2) + '\\u00d7' + r.height.toFixed(2) +
                 ' (off by ' + dw.toFixed(2) + ', ' + dh.toFixed(2) + ')');
      p.parentNode.style.outline = '1px solid #cc5f5f';
    }
    const eff = t / (+p.dataset.cols * p._fs);              // the ratio actually in force
    const k = p.dataset.tech;
    const g = byTech.get(k) || { min: Infinity, max: -Infinity, minFs: Infinity, n: 0 };
    g.min = Math.min(g.min, eff); g.max = Math.max(g.max, eff);
    g.minFs = Math.min(g.minFs, p._fs); g.n++;
    byTech.set(k, g);
  }

  const rows = [];
  rows.push('<tr><th>glyph class</th><th>measured advance</th><th>vs 0.6</th><th>glyph box height</th></tr>');
  for (const k of Object.keys(PR)){
    const d = ((PR[k].ratio - 0.6) / 0.6 * 100);
    rows.push('<tr><td>' + k + '</td><td>' + PR[k].ratio.toFixed(4) + 'em</td><td>' +
      (d >= 0 ? '+' : '') + d.toFixed(1) + '%</td><td>' + PR[k].height.toFixed(3) + 'em</td></tr>');
  }
  const tech = [];
  tech.push('<tr><th>technique</th><th>blocks</th><th>effective advance</th><th>smallest font-size drawn</th></tr>');
  for (const [k, g] of byTech){
    tech.push('<tr><td>' + k + '</td><td>' + g.n + '</td><td>' + g.min.toFixed(4) +
      (Math.abs(g.max - g.min) > 0.0005 ? '\\u2013' + g.max.toFixed(4) : '') + 'em</td><td>' +
      g.minFs.toFixed(2) + 'px</td></tr>');
  }

  const dpr = window.devicePixelRatio || 1;
  const vh = window.innerHeight, vw = window.innerWidth;
  const scale = Math.abs(dpr - 1) > 0.001
    ? '<div class="fail">devicePixelRatio is ' + dpr + ': a block labelled 34px occupies ' +
      Math.round(34 * dpr) + ' pixels IN THE PNG. Judge it on this display at 100%, or the icons look ' +
      Math.round((dpr - 1) * 100) + '% bigger than they will ever be.</div>'
    : '<div class="pass">devicePixelRatio 1 \\u2014 one CSS px is one PNG px</div>';
  // The clip verdict is a fixed-height placeholder, filled only AFTER the rest
  // of the report is in the DOM: the report is ~250px tall, so measuring the
  // page before it exists reports a page that fits when it does not. (It did,
  // on the first run of this sheet -- "nothing is cropped" printed above a
  // visibly cropped page.)
  const clip = '<div id="clip"></div>';

  document.getElementById('report').innerHTML =
    '<h3>size assertion \\u2014 measured after layout, not claimed</h3>' +
    (fails.length
      ? '<div class="fail"><b>' + fails.length + ' of ' + pres.length + ' blocks are NOT the size they are labelled</b> ' +
        '(outlined in red below):<br>' + fails.slice(0, 40).join('<br>') +
        (fails.length > 40 ? '<br>\\u2026and ' + (fails.length - 40) + ' more' : '') + '</div>'
      : '<div class="pass">all ' + pres.length + ' blocks measure within 1px of their labelled size</div>') +
    clip + scale +
    '<div class="tables"><table>' + rows.join('') + '</table>' +
    '<table>' + tech.join('') + '</table>' +
    '<div style="color:var(--dim);align-self:flex-end">viewport ' + vw + '\\u00d7' + vh + ' css px</div></div>';

  // ---- 4. The screenshot's own honesty. shoot.js asks for a window height and
  // the compositor gives whatever the display allows, so the PNG can be shorter
  // than the page with nothing anywhere to say so. Draw the fold and name what
  // falls below it, ON the page, where the screenshot will capture it.
  const docH = document.documentElement.scrollHeight;
  const below = Array.from(document.querySelectorAll('section')).filter(
    s => s.getBoundingClientRect().top + window.scrollY + 40 > vh
  ).map(s => (s.querySelector('.sid') ? s.querySelector('.sid').textContent : '?'));
  if (docH > vh + 2){
    const f = document.createElement('div');
    f.id = 'fold';
    f.style.top = vh + 'px';
    f.innerHTML = '<span>screenshot fold \\u2014 nothing below this line is in the PNG</span>';
    document.body.appendChild(f);
  }
  document.getElementById('clip').innerHTML = docH > vh + 2
    ? '<div class="fail"><b>PAGE IS TALLER THAN THE WINDOW</b>: ' + docH + 'px of page in a ' + vh +
      'px viewport. Everything under the red fold line is absent from the screenshot' +
      (below.length ? ', including subject(s): <b>' + below.join(', ') + '</b>' : '') +
      '. Re-run with --only=&lt;subject&gt;, or --zoom=0 to drop the magnified column.</div>'
    : '<div class="pass">page (' + docH + 'px) fits the ' + vh + 'px viewport \\u2014 nothing is cropped</div>';
})();
</script>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, page);

console.log(outFile);
console.log(`  generated:    ${gen.ok ? `${gen.renders.length} renders` : `MISSING (${gen.why})`}`);
console.log(`  hand:         ${hand.ok ? `${hand.renders.length} renders` : `MISSING (${hand.why})`}`);
console.log(`  subjects:     ${list.length}${only.length ? ` (filtered: ${only.join(', ')})` : ''}`);

// Paging. shoot.js clamps to the display, so a long sheet loses its bottom with
// no error -- one PNG per subject is cheaper than discovering that later.
const ROW = (showZoom ? ZOOM : Math.max(...SIZES)) + 15;   // the tallest cell sets the row
const heightOf = s => {
  const n = renders.filter(r => (r.subject || '(no subject)') === s.id).length;
  const rows = 1 + (sources[s.id] ? 1 : 0) + Math.max(n, 1);   // emoji baseline + source + renders
  return 62 + rows * ROW + 2 * (ZOOM_OF + 9) + 22 + 28;        // + contrast strip + heading chrome
};
const total = list.reduce((sum, s) => sum + heightOf(s), 220);
const tallest = list.reduce((m, s) => Math.max(m, heightOf(s)), 0);
console.log(`\n  whole sheet is roughly ${Math.round(total)}px tall; the tallest subject block ~${Math.round(tallest)}px`);
console.log(showZoom
  ? `  (the ${ZOOM}px zoom column sets the row height floor — pass --zoom=0 to drop it and fit ~3x more)`
  : `  (zoom column off: true sizes only)`);
// The window height you ask shoot.js for is NOT what you get: the compositor
// clamps to the display, and on this machine a 1330px request came back as an
// ~864 css-px viewport (1080 device px at a 1.25 scale factor). So size the
// estimate against what a display actually gives, and let the page's own fold
// line be the authority.
console.log(`  a real shot gives ~860 css px of viewport whatever you ask for, so about ` +
  `${Math.max(1, Math.floor(820 / Math.max(tallest, 1)))} subject(s) fit. Shoot them one at a time:`);
const zoomArg = showZoom ? (ZOOM_FACTOR === 4 ? '' : ` --zoom=${ZOOM_FACTOR}`) : ' --zoom=0';
for (const s of list) {
  console.log(`    node verify/ascii-sheet.js "${genFile}" "${handFile}" ".harness/ascii-${s.id}.html" --only=${s.id}${zoomArg}`);
  console.log(`    npx electron verify/shoot.js .harness/ascii-${s.id}.html .harness/ascii-${s.id}.png 1500 900`);
}
console.log(`\n  the page ends in an END OF SHEET marker: if it is not in the PNG, the shot was clamped.`);
console.log(`  the page also draws its own fold line and names the subjects below it, so a`);
console.log(`  clipped PNG says so in the PNG rather than looking complete.`);
