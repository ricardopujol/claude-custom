'use strict';
/* Chosen base + its four states, one row per character.

   Laid out as a row on purpose: the question is whether a character stays
   RECOGNISABLY THE SAME PERSON across states, and that is only answerable by
   seeing them adjacent. Judging four images one at a time is how drift gets
   missed.

     node verify/state-sheet.js [portraitsRoot] [out.html]
*/
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'C:/Users/ricar/VibeCode/agent-creator/portraits');
const outFile = path.resolve(process.argv[3] || 'C:/Users/ricar/VibeCode/claude-custom/.harness/states.html');

const STATES = ['sleeping', 'working', 'happy', 'stressed'];
const url = p => 'file:///' + p.split(path.sep).join('/');

const agents = fs.readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_'))
  .map(d => d.name)
  .filter(a => fs.existsSync(path.join(root, a, 'states')));

if (!agents.length) {
  console.error('no agents with states under ' + root);
  process.exit(1);
}

const sections = agents.map(agent => {
  const statesDir = path.join(root, agent, 'states');

  let report = {};
  try { report = JSON.parse(fs.readFileSync(path.join(statesDir, 'report.json'), 'utf8')); } catch {}

  const cells = STATES.map(state => {
    const file = path.join(statesDir, `${state}.png`);
    if (!fs.existsSync(file)) {
      return `<figure class="missing"><div class="ph">missing</div><figcaption>${state}</figcaption></figure>`;
    }
    const score = report[state] && report[state].score;
    const tries = report[state] && report[state].attempts;
    return `<figure><img src="${url(file)}">` +
      `<figcaption>${state}` +
      (score ? `<br><span class="s">identity ${score.toFixed(3)}${tries > 1 ? ` · ${tries} tries` : ''}</span>` : '') +
      `</figcaption></figure>`;
  }).join('');

  return `<section><h2>${agent}</h2><div class="row">${cells}</div></section>`;
}).join('');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0b0d12;color:#c7cede;font:12px "Segoe UI",sans-serif;padding:14px}
h2{margin:0 0 6px;font-size:14px;color:#d08c4a}
.row{display:flex;gap:10px;align-items:flex-start}
figure{margin:0;width:240px}
img{width:240px;height:240px;object-fit:cover;border-radius:8px;border:1px solid #262b38;
    background:repeating-conic-gradient(#1a1d26 0% 25%,#11131a 0% 50%) 50%/16px 16px}
.ph{width:240px;height:240px;border-radius:8px;border:1px dashed #3a4152;display:flex;
    align-items:center;justify-content:center;color:#6d7689}
figcaption{color:#c7cede;font-size:11.5px;padding-top:5px;text-align:center;text-transform:capitalize}
.s{color:#6d7689;font-size:10px;text-transform:none}
section{margin-bottom:18px}
</style>
<div style="color:#6d7689;font-size:11px;margin-bottom:10px">
Chequerboard shows through where the background was cut to alpha.
</div>
${sections}`);

console.log(outFile);
