'use strict';
/* Contact sheet of generated portraits, so candidates can actually be LOOKED at.
   Picking a base bust is the pipeline's one mandatory human step, and it cannot
   be done by reading file sizes.

     node verify/portrait-sheet.js [forge/outputs] [out.html]

   Then render it:  npx electron verify/shoot.js <out.html> <out.png> 1500 900
*/
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'forge', 'outputs'));
const outFile = path.resolve(process.argv[3] || path.join(__dirname, '..', '.harness', 'portraits.html'));

if (!fs.existsSync(root)) {
  console.error(`no outputs at ${root}`);
  process.exit(1);
}

const agents = fs.readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

const sections = agents.map(agent => {
  const agentDir = path.join(root, agent);
  const groups = [];

  for (const sub of ['candidates', 'states']) {
    const dir = path.join(agentDir, sub);
    if (!fs.existsSync(dir)) continue;
    const pngs = fs.readdirSync(dir)
      .filter(f => f.endsWith('.png') && !f.includes('@'))
      .sort();
    if (pngs.length) groups.push({ sub, dir, pngs });
  }

  // The prompt is shown with the images: judging a candidate without seeing
  // what was asked for makes it impossible to tell a bad prompt from a bad model.
  let promptText = '';
  const promptFile = path.join(agentDir, 'candidates', 'prompt.json');
  if (fs.existsSync(promptFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
      promptText = j.prompt || '';
    } catch { /* shown as empty */ }
  }

  const blocks = groups.map(g =>
    `<div class="grp"><div class="sub">${g.sub} (${g.pngs.length})</div><div class="row">` +
    g.pngs.map(f =>
      `<figure><img src="file:///${path.join(g.dir, f).replace(/\\/g, '/')}">` +
      `<figcaption>${f.replace(/\.png$/, '')}</figcaption></figure>`
    ).join('') +
    `</div></div>`
  ).join('');

  return `<section><h2>${agent}</h2>` +
    (promptText ? `<div class="prompt">${promptText}</div>` : '') +
    (blocks || '<div class="empty">no images yet</div>') +
    `</section>`;
}).join('');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0b0d12;color:#c7cede;font:12px "Segoe UI",sans-serif;padding:14px}
h2{margin:0 0 4px;font-size:14px;color:#d08c4a}
.prompt{color:#6d7689;font-size:10.5px;margin-bottom:8px;line-height:1.45}
.sub{color:#6d7689;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin:6px 0 4px}
.row{display:flex;gap:8px;flex-wrap:wrap}
figure{margin:0;width:190px}
img{width:190px;height:190px;object-fit:cover;border-radius:6px;border:1px solid #262b38;background:#11131a}
figcaption{color:#6d7689;font-size:9.5px;padding-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
section{margin-bottom:16px}
.empty{color:#6d7689}
</style>${sections}`);

console.log(outFile);
