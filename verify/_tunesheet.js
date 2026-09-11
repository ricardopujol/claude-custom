const fs = require('fs');
const path = require('path');

const dir = 'C:/Users/ricar/VibeCode/agent-creator/portraits/_tuning/logic-reviewer';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort((a, b) => {
  const g = s => parseFloat((s.match(/g([\d.]+)/) || [0, 99])[1]);
  return g(a) - g(b);
});

const url = f => 'file:///' + path.join(dir, f).split(path.sep).join('/');
const cells = files.map(f =>
  `<figure><img src="${url(f)}"><figcaption>${f.replace('.png', '')}</figcaption></figure>`
).join('');

const out = 'C:/Users/ricar/VibeCode/claude-custom/.harness/tune.html';
fs.writeFileSync(out, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0b0d12;color:#c7cede;font:12px "Segoe UI",sans-serif;padding:12px}
h2{margin:0 0 2px;font-size:13px;color:#d08c4a}
.p{color:#6d7689;font-size:10.5px;margin-bottom:8px}
.row{display:flex;gap:10px;flex-wrap:wrap}
figure{margin:0;width:330px}
img{width:330px;height:330px;object-fit:cover;border-radius:6px;border:1px solid #262b38}
figcaption{color:#9aa7bd;font-size:11px;padding-top:4px;text-align:center}
</style><h2>logic-reviewer (Dexter) — one seed, guidance swept</h2>
<div class="p">asked for: red hair, big glasses, high-collared white coat, pale skin, palette "cold crimson and slate"</div>
<div class="row">${cells}</div>`);

console.log(out);
