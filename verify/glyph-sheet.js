'use strict';
/* Contact sheet for the ASCII/glyph icon spike, AT TRUE DISPLAY SIZE.

     node verify/glyph-sheet.js <manifest[,manifest...]> [outDir] [subject]

   Then shoot each page:
     npx electron verify/shoot.js <page.html> <page.png> 1200 1000

   Why this exists, and why it is not portrait-sheet.js: the icons this spike is
   judging render at 16-48px. portrait-sheet.js shows art at 190px, which is the
   exact mistake actual-size.js was written to stop -- six generation runs spent
   on expression for an asset displayed at 34x34. So every candidate here appears
   first at 16/24/34/48, and the 4x blow-up sits to the RIGHT, clearly labelled,
   for diagnosing WHY something failed after you have already seen that it did.

   Two honesty mechanisms, because a comparison sheet that lies is worse than no
   sheet at all:

   1. The monospace advance ratio is MEASURED in the page, not assumed to be
      0.6em. Font fallback changes it, and this repo's stack falls back through
      three fonts.
   2. After layout, every block's real bounding box is compared to its target and
      any deviation over 1px is reported ON THE PAGE. A sheet claiming 34px while
      painting 41px would send the decision the wrong way with nothing visible to
      catch it.

   Pages are chunked because shoot.js clamps the window to the display, so a tall
   page silently loses its bottom -- and the lost rows would be the large grids,
   which is precisely where the interesting failures are.
*/
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 34, 48];
const ZOOM = 4;
const ROWS_PER_PAGE = Number(process.env.GLYPH_ROWS || 13);
const FONT = '"CaskaydiaCove Nerd Font", "Cascadia Mono", Consolas, monospace';
const BG = '#11131a';
const TEXT = '#c7cede';
const DIM = '#6d7689';
const ACCENT = '#d08c4a';
const BAD = '#cc5f5f';

const manifests = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const outDir = path.resolve(process.argv[3] || path.join(__dirname, '..', '.harness', 'ascii', 'sheet'));
const onlySubject = (process.argv[4] || '').trim();

if (!manifests.length) {
  console.error('usage: node verify/glyph-sheet.js <manifest[,manifest]> [outDir] [subject]');
  process.exit(1);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const url = p => 'file:///' + String(p).replace(/\\/g, '/');

// ---- load + merge -----------------------------------------------------------
const subjects = new Map();
const sources = {};
const renders = [];
const loaded = [];
const missing = [];

for (const m of manifests) {
  const p = path.resolve(m);
  if (!fs.existsSync(p)) { missing.push(p); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) { missing.push(`${p} (unparseable: ${err.message})`); continue; }
  loaded.push(p);
  for (const s of j.subjects || []) if (!subjects.has(s.id)) subjects.set(s.id, s);
  Object.assign(sources, j.sources || {});
  for (const r of j.renders || []) renders.push(r);
}

if (!renders.length) {
  console.error('no renders found in: ' + manifests.join(', '));
  process.exit(1);
}

// Grid integrity is checked HERE too, not only in the producer: this sheet merges
// manifests from different authors, and one ragged grid would misrepresent every
// candidate beside it.
const ragged = [];
for (const r of renders) {
  const cps = s => Array.from(s).length;
  if (r.lines.length !== r.rows) ragged.push(`${r.id}: ${r.lines.length} lines != rows ${r.rows}`);
  for (const l of r.lines) if (cps(l) !== r.cols) ragged.push(`${r.id}: line ${cps(l)} != cols ${r.cols}`);
  if (r.lines.some(l => l.includes(''))) ragged.push(`${r.id}: contains an ANSI escape`);
}

// ---- rendering helpers ------------------------------------------------------
function block(r, px, zoom) {
  const target = px * (zoom || 1);
  const body = r.fg
    ? r.lines.map((line, y) =>
        Array.from(line).map((ch, x) =>
          `<span style="color:${r.fg[y] && r.fg[y][x] ? r.fg[y][x] : TEXT}">${esc(ch)}</span>`).join('')
      ).join('\n')
    : esc(r.lines.join('\n'));
  return `<pre class="g" data-cols="${r.cols}" data-rows="${r.rows}" data-target="${target}"
    style="color:${r.fg ? 'inherit' : TEXT}">${body}</pre>`;
}

function sizeRow(r) {
  const cells = SIZES.map(px =>
    `<div class="cell"><div class="box" style="width:${px}px;height:${px}px">${block(r, px)}</div>` +
    `<div class="px">${px}</div></div>`).join('');
  return `<div class="row">
      <div class="lbl"><b>${esc(r.technique)}</b> ${r.cols}×${r.rows}
        <span class="tag">${esc(r.color)}${r.source === 'hand' ? ' · hand' : ''}</span>
        <div class="note">${esc(r.note || '')}</div></div>
      <div class="sizes">${cells}</div>
      <div class="zoom"><div class="box zoombox" style="width:${34 * ZOOM}px;height:${34 * ZOOM}px">${block(r, 34, ZOOM)}</div>
        <div class="px">${ZOOM}× of the 34px cell — diagnosis only</div></div>
    </div>`;
}

function emojiRow(s) {
  const cells = SIZES.map(px =>
    `<div class="cell"><div class="box" style="width:${px}px;height:${px}px">` +
    `<span style="font-size:${px}px;line-height:${px}px">${s.emoji || ''}</span></div>` +
    `<div class="px">${px}</div></div>`).join('');
  const src = sources[s.id]
    ? `<div class="zoom"><img src="${url(sources[s.id])}" style="width:48px;height:48px">
       <div class="px">procedural source (48px)</div></div>`
    : '<div class="zoom"></div>';
  return `<div class="row baseline">
      <div class="lbl"><b>EMOJI BASELINE</b> <span class="tag">what ASCII must beat</span>
        <div class="note">${esc(s.note || '')}</div></div>
      <div class="sizes">${cells}</div>${src}</div>`;
}

const STYLE = `
body{margin:0;background:${BG};color:${TEXT};font:12px "Segoe UI",sans-serif;padding:12px}
h1{font-size:14px;color:${ACCENT};margin:0 0 2px}
.meta{color:${DIM};font-size:10.5px;margin-bottom:8px;line-height:1.5}
.row{display:flex;align-items:flex-start;gap:12px;padding:5px 0;border-top:1px solid #1d2230}
.row.baseline{border-top:2px solid ${ACCENT};background:#161923}
.lbl{width:205px;flex:none;font-size:11px;padding-top:2px}
.lbl b{color:${TEXT}}
.tag{color:${DIM};font-size:9.5px}
.note{color:${DIM};font-size:9.5px;line-height:1.35;padding-top:2px}
.sizes{display:flex;gap:10px;align-items:flex-end;flex:none}
.cell{text-align:center}
.box{display:flex;align-items:center;justify-content:center;background:${BG};
     outline:1px solid #232a38;overflow:hidden}
.zoombox{outline:1px dashed #2c3446}
.px{color:${DIM};font-size:9px;padding-top:3px}
.zoom{margin-left:14px;text-align:center}
pre.g{margin:0;white-space:pre;letter-spacing:0;font-family:${FONT};
      font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}
#audit{position:sticky;top:0;background:#161923;border:1px solid #2c3446;padding:6px 8px;
       margin-bottom:8px;font-size:10.5px;line-height:1.5;color:${DIM}}
#audit b{color:${ACCENT}} .bad{color:${BAD}} .ok{color:#5fb07a}
`;

// The measurement + assertion script. Runs in the page because the advance ratio
// is a property of the font as actually resolved, which nothing outside the
// renderer can know.
const SCRIPT = `
(function(){
  var probe=document.createElement('pre');
  probe.style.cssText='position:absolute;visibility:hidden;margin:0;white-space:pre;font-family:${FONT};font-size:100px';
  probe.textContent='MMMMMMMMMM';
  document.body.appendChild(probe);
  var ratio=probe.getBoundingClientRect().width/10/100;
  document.body.removeChild(probe);

  var blocks=document.querySelectorAll('pre.g'), off=[];
  blocks.forEach(function(el){
    var cols=+el.dataset.cols, rows=+el.dataset.rows, target=+el.dataset.target;
    el.style.fontSize=(target/cols/ratio)+'px';
    el.style.lineHeight=(target/rows)+'px';
  });
  blocks.forEach(function(el){
    var target=+el.dataset.target, r=el.getBoundingClientRect();
    if(Math.abs(r.width-target)>1||Math.abs(r.height-target)>1){
      off.push(target+'px block measured '+r.width.toFixed(1)+'x'+r.height.toFixed(1));
      el.style.outline='1px solid ${BAD}';
    }
  });
  var a=document.getElementById('audit');
  a.innerHTML+='<div>measured monospace advance ratio: <b>'+ratio.toFixed(4)+
    '</b>em (0.6 assumed \\u2192 '+(Math.abs(ratio-0.6)<0.005?'held':'DID NOT HOLD')+')</div>'+
    '<div>blocks: '+blocks.length+' \\u00b7 size assertion: '+
    (off.length?'<span class="bad">'+off.length+' OFF TARGET \\u2014 '+off.slice(0,3).join('; ')+'</span>'
               :'<span class="ok">all within 1px of target</span>')+'</div>';
})();
`;

// ---- emit -------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const ids = [...subjects.keys()].filter(id => !onlySubject || id === onlySubject);
const pages = [];

for (const id of ids) {
  const s = subjects.get(id);
  const mine = renders.filter(r => r.subject === id);
  // Braille first and widest-grid last: the reading order matches the question
  // being asked -- "does the headline technique work, and where does it break?"
  const order = ['braille', 'hand-braille', 'sextant', 'quadrant', 'halfblock', 'shade', 'ascii',
    'hand-ascii', 'hand-block'];
  mine.sort((a, b) => (order.indexOf(a.technique) - order.indexOf(b.technique))
    || (a.cols - b.cols) || String(a.id).localeCompare(String(b.id)));

  for (let i = 0, page = 1; i < mine.length; i += ROWS_PER_PAGE, page++) {
    const chunk = mine.slice(i, i + ROWS_PER_PAGE);
    const total = Math.ceil(mine.length / ROWS_PER_PAGE);
    const html = `<!doctype html><meta charset="utf-8"><style>${STYLE}</style>
<h1>${esc(s.label || id)} — glyph candidates at true display size (page ${page}/${total})</h1>
<div class="meta">Judge the 16/24/34/48 columns. The 4× column exists to explain a failure, never to sell a candidate.</div>
<div id="audit"><div><b>sheet self-audit</b></div>
  <div>manifests: ${loaded.map(p => esc(path.basename(p))).join(', ') || 'none'}${missing.length ? ` <span class="bad">missing: ${missing.map(p => esc(path.basename(p))).join(', ')}</span>` : ''}</div>
  <div>grid integrity: ${ragged.length ? `<span class="bad">${ragged.length} problem(s): ${esc(ragged.slice(0, 2).join(' | '))}</span>` : '<span class="ok">all grids rigid, no ANSI</span>'}</div>
</div>
${page === 1 ? emojiRow(s) : ''}
${chunk.map(sizeRow).join('')}
<script>${SCRIPT}</script>`;
    const file = path.join(outDir, `${id}-p${page}.html`);
    fs.writeFileSync(file, html, 'utf8');
    pages.push(file);
  }
}

for (const p of pages) console.log(p);
console.error(`${pages.length} page(s) · ${renders.length} render(s) · ` +
  `${ragged.length ? ragged.length + ' GRID PROBLEM(S)' : 'grids clean'}` +
  (missing.length ? ` · missing manifests: ${missing.length}` : ''));
