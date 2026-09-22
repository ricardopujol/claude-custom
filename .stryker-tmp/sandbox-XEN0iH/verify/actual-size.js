// @ts-nocheck
'use strict';
/* The states at the size they are ACTUALLY displayed.

   The roster renders .agent .face at 34x34 px. Six attempts have gone into
   subtle expression fidelity for an asset smaller than a favicon, which is a
   question that should have been asked first: at 34px a mouth is about five
   pixels wide, so "a warm genuine smile" has nowhere to happen.

   Shown at 34, 64 and 256 side by side, with the roster's own state styling
   (ring colour and opacity) applied at 34px -- because that styling already
   encodes the state, and it may be doing all the work that matters.
*/
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || 'C:/Users/ricar/VibeCode/agent-creator/portraits/_geom';
const outFile = process.argv[3] || 'C:/Users/ricar/VibeCode/claude-custom/.harness/actual-size.html';

const STATES = ['sleeping', 'working', 'happy', 'stressed'];
const RING = { sleeping: 'none', working: '#d08c4a', happy: '#5fb07a', stressed: '#cc5f5f' };
const OPACITY = { sleeping: 0.42, working: 1, happy: 1, stressed: 1 };

const agents = fs.readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'states')))
  .map(d => d.name);

const url = p => 'file:///' + p.split(path.sep).join('/');

const rows = agents.map(agent => {
  const dir = path.join(root, agent, 'states');
  const sizes = [34, 64, 256].map(size => {
    const cells = STATES.map(s => {
      const f = path.join(dir, `${s}.png`);
      if (!fs.existsSync(f)) return `<div class="miss" style="width:${size}px;height:${size}px"></div>`;
      const ring = size === 34 && RING[s] !== 'none' ? `box-shadow:0 0 0 2px ${RING[s]};` : '';
      const op = size === 34 ? `opacity:${OPACITY[s]};` : '';
      return `<div class="cell"><img src="${url(f)}" style="width:${size}px;height:${size}px;${ring}${op}">` +
             (size === 256 ? `<div class="lbl">${s}</div>` : '') + `</div>`;
    }).join('');
    return `<div class="grp"><div class="sz">${size}px${size === 34 ? '  \u2190 the roster' : ''}</div>` +
           `<div class="row">${cells}</div></div>`;
  }).join('');
  return `<section><h2>${agent}</h2>${sizes}</section>`;
}).join('');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#11131a;color:#c7cede;font:12px "Segoe UI",sans-serif;padding:14px}
h2{margin:0 0 8px;font-size:13px;color:#d08c4a}
.grp{margin-bottom:14px}
.sz{color:#6d7689;font-size:10.5px;margin-bottom:5px;text-transform:uppercase;letter-spacing:.07em}
.row{display:flex;gap:14px;align-items:flex-end}
.cell{text-align:center}
img{border-radius:7px;object-fit:cover;display:block}
.lbl{color:#9aa7bd;font-size:11px;padding-top:4px;text-transform:capitalize}
.miss{border:1px dashed #3a4152;border-radius:7px}
section{margin-bottom:16px}
</style>${rows}`);

console.log(outFile);
