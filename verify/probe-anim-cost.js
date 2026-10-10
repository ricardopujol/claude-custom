'use strict';
/**
 * PROBE: BACKLOG #62, what an animated background costs. (re-runnable; HEAVY: take heavy-lock.ps1 first)
 *
 *   node verify/probe-anim-cost.js [--ms=120000] [--only=gif,mp4]
 *
 * Ricardo's question (DESIGN_LEAN_MODE.md "Open"): "does a gif cost gpu?" This plays the SAME 10 s clip as a GIF, an
 * H.264 MP4 and a VP9 WebM as the background behind a busy terminal, plus a still image as the baseline, one window at a
 * time (verify/anim-cost-window), each for --ms (default 2 min), and prints CPU % (of one core) and private MB per
 * Electron process type (main, renderer, gpu, utility) plus GPU engine utilisation summed over those processes
 * (Get-Counter '\GPU Engine(*)\Utilization Percentage'). It also measures six animated agent portraits (GIF) over the
 * still background for a shorter run. The clip is generated locally with ffmpeg; nothing is downloaded.
 *
 * Electron is started ONLY through verify/lib/launch-electron.js and always stopped in a finally, by its own PID.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchElectron, installSweep, sleep } = require('./lib/launch-electron');

const ROOT = path.join(__dirname, '..');
const WINDOW = path.join(__dirname, 'anim-cost-window', 'main.js');
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

// ---- pure helpers (unit-tested in test/probe-anim-cost.test.js) ----

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Per process type: median CPU % (of one core) and median private MB over the samples. */
function summariseSamples(samples) {
  const types = new Set();
  for (const s of samples) for (const t of Object.keys(s.byType)) types.add(t);
  const out = {};
  for (const t of types) {
    const rows = samples.map((s) => s.byType[t]).filter(Boolean);
    out[t] = {
      count: median(rows.map((r) => r.count)),
      cpu: median(rows.map((r) => r.cpu)),
      privateMB: median(rows.map((r) => r.privateKB / 1024)),
    };
  }
  return out;
}

/** GPU engine counter samples -> the median over time of the summed utilisation of the given pids. */
function gpuPercent(counterSamples, pids) {
  const want = new Set(pids);
  const byTime = new Map();
  for (const c of counterSamples) {
    const m = /^pid_(\d+)_/.exec(c.name || '');
    if (!m || !want.has(Number(m[1])) || typeof c.value !== 'number') continue;
    byTime.set(c.at, (byTime.get(c.at) || 0) + c.value);
  }
  return median([...byTime.values()]);
}

// ---- the probe ----

function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr || r.error}`);
}

function makeClips(dir) {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20:duration=10'];
  const clips = {
    gif: path.join(dir, 'clip.gif'),
    mp4: path.join(dir, 'clip.mp4'),
    webm: path.join(dir, 'clip.webm'),
    still: path.join(dir, 'still.png'),
    portrait: path.join(dir, 'portrait.gif'),
  };
  ffmpeg([...src, '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', clips.gif]);
  ffmpeg([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clips.mp4]);
  ffmpeg([...src, '-c:v', 'libvpx-vp9', '-b:v', '1M', '-an', clips.webm]);
  ffmpeg([...src, '-frames:v', '1', clips.still]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x96:rate=12:duration=4', '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', clips.portrait]);
  return clips;
}

// Get-Counter for the GPU engines over the run's tail; resolves [{ at, name, value }].
function sampleGpu(seconds) {
  const script = `$s = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 5 -MaxSamples ${Math.max(1, Math.floor(seconds / 5))} -ErrorAction SilentlyContinue; ` +
    `$s | ForEach-Object { $t = $_.Timestamp.Ticks; $_.CounterSamples | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { [pscustomobject]@{ at = $t; name = $_.InstanceName; value = $_.CookedValue } } } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let text = '';
    ps.stdout.on('data', (d) => { text += d; });
    ps.on('error', () => resolve(null));
    ps.on('exit', () => {
      try { const j = JSON.parse(text.trim() || '[]'); resolve(Array.isArray(j) ? j : [j]); } catch { resolve(null); }
    });
  });
}

async function runVariant(variant, clips, ms) {
  const outFile = path.join(os.tmpdir(), `anim-cost-${variant}-${process.pid}.json`);
  try { fs.unlinkSync(outFile); } catch { /* none yet */ }
  const file = variant === 'portrait-gif' ? clips.still : clips[variant === 'still' ? 'still' : variant];
  const handle = await launchElectron({
    electronPath: require('electron'),
    args: [WINDOW, `--variant=${variant}`, `--file=${file}`, `--portrait=${clips.portrait}`, `--ms=${ms}`, `--out=${outFile}`],
    label: `anim-cost ${variant}`, cwd: ROOT, stdio: 'ignore',
  });
  let gpu = null;
  try {
    // the GPU counter over the last stretch of the run, while the window's own sampler runs
    await sleep(Math.max(0, ms - 45000));
    gpu = await sampleGpu(30);
    const deadline = Date.now() + ms + 30000;
    while (handle.child.exitCode === null && Date.now() < deadline) await sleep(1000);
  } finally {
    await handle.stop({});     // already gone: a no-op; still up: killed by pid
  }
  const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.unlinkSync(outFile);
  const seen = res.samples.filter((x) => x.pageVisible === 'visible').length;
  return { variant, done: res.done === true, byType: summariseSamples(res.samples), n: res.samples.length, visible: `${seen}/${res.samples.length}`,
    gpuPercent: gpu === null ? null : gpuPercent(gpu, res.pids) };
}

function table(results) {
  const f = (x, d = 1) => (typeof x === 'number' ? x.toFixed(d) : 'n/a');
  const lines = ['| clip | renderer CPU % | GPU proc CPU % | main CPU % | total CPU % | renderer MB | GPU proc MB | main MB | GPU engine % | page visible (samples) |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    const t = r.byType;
    const total = Object.values(t).reduce((a, x) => a + (x.cpu || 0), 0);
    lines.push(`| ${r.variant} | ${f(t.renderer && t.renderer.cpu)} | ${f(t.gpu && t.gpu.cpu)} | ${f(t.main && t.main.cpu)} | ${f(total)} | ${f(t.renderer && t.renderer.privateMB, 0)} | ${f(t.gpu && t.gpu.privateMB, 0)} | ${f(t.main && t.main.privateMB, 0)} | ${f(r.gpuPercent)} | ${r.visible || 'n/a'} |`);
  }
  return lines.join('\n');
}

async function main() {
  installSweep();      // a Ctrl-C or a crash mid-run still stops the window by its own pid (PR #140 Miguel S7)
  const ms = Number(arg('ms', '120000'));
  const only = arg('only', '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-cost-'));
  const clips = makeClips(dir);
  const order = ['still', 'gif', 'mp4', 'webm', 'portrait-gif'].filter((v) => !only || only.split(',').includes(v));
  const results = [];
  try {
    for (const v of order) {
      console.log(`running ${v} for ${ms / 1000}s ...`);
      results.push(await runVariant(v, clips, v === 'portrait-gif' ? Math.min(ms, 60000) : ms));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('\n' + table(results));
  const out = path.join(ROOT, '.harness', 'anim-cost.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), ms, results }, null, 2));
  console.log('\nfull numbers ->', out);
  return results.every((r) => r.done) ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}

module.exports = { median, summariseSamples, gpuPercent, table };
