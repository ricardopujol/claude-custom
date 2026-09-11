'use strict';
/* Every approach tried, one row each, same character, same chosen base.
   node verify/compare.js  ->  .harness/compare.png                          */
const fs = require('fs');
const path = require('path');

const P = 'C:/Users/ricar/VibeCode/agent-creator/portraits';
const AGENT = 'code-reviewer';
const STATES = ['sleeping', 'working', 'happy', 'stressed'];

const ROWS = [
  ['1. img2img denoise 0.45', `${P}/${AGENT}/states`],
  ['2. img2img denoise 0.62', `${P}/_states2/${AGENT}/states`],
  ['3. img2img, expression-only prompt', `${P}/_states3/${AGENT}/states`],
  ['4. txt2img, same seed', `${P}/_txt2img/${AGENT}/states`],
  ['5. txt2img + facial-geometry cues', `${P}/_geom/${AGENT}/states`],
  ['6. IP-Adapter + ControlNet depth', `${P}/_ipadapter/${AGENT}/states`],
];

const url = p => 'file:///' + p.replace(/\\/g, '/');

const sections = ROWS.map(([label, dir]) => {
  let report = {};
  try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch {}

  const cells = STATES.map(s => {
    const f = path.join(dir, `${s}.png`);
    if (!fs.existsSync(f)) return `<div class="miss">not run</div>`;
    const sc = report[s] && report[s].score;
    return `<figure><img src="${url(f)}">` +
           `<figcaption>${s}${sc ? ` <span>${sc.toFixed(3)}</span>` : ''}</figcaption></figure>`;
  }).join('');

  return `<section><h2>${label}</h2><div class="row">${cells}</div></section>`;
}).join('');

const out = 'C:/Users/ricar/VibeCode/claude-custom/.harness/compare.html';
fs.writeFileSync(out, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#11131a;color:#c7cede;font:12px "Segoe UI",sans-serif;padding:12px}
h2{margin:0 0 4px;font-size:12px;color:#d08c4a;font-weight:600}
.row{display:flex;gap:8px}
figure{margin:0}
img{width:150px;height:150px;object-fit:cover;border-radius:6px;
    background:repeating-conic-gradient(#1a1d26 0% 25%,#11131a 0% 50%) 50%/12px 12px}
figcaption{color:#8b96aa;font-size:10px;padding-top:2px;text-transform:capitalize}
figcaption span{color:#5f7fb0}
.miss{width:150px;height:150px;border:1px dashed #3a4152;border-radius:6px;
      display:flex;align-items:center;justify-content:center;color:#4d566b;font-size:10px}
section{margin-bottom:10px}
</style>${sections}`);
console.log(out);
