'use strict';
/* BACKLOG #90, in the REAL header: a used-up window reads "Claude back in ...", the reset shows "Claude is back" once, then the
 * meters return to normal. A fake quota payload drives renderQuota; no host, no `claude`, no network.
 *
 *     node verify/probe-quota-countdown.js [outDir]
 *
 * Same two traps as verify/probe-quota-header.js: ELECTRON_RUN_AS_NODE is stripped when spawning Electron, and the window is a
 * normal visible one (offscreen hangs capturePage).
 */

const { spawnElectron } = require('./lib/launch-electron');
const path = require('path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
  const child = spawnElectron(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', '.harness', 'quota-countdown-shots');
const bail = setTimeout(() => { console.error('TIMED OUT'); process.exit(2); }, 90000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log('ok  ', what); };

const used = (resetsAt) => ({ ok: true, state: 'fresh', windows: [
  { key: 'session', label: '5h', percent: 100, severity: 'critical', resetsAt, isActive: true, lockedReason: 'limit_reached' },
  { key: 'weekly_all', label: 'week', percent: 61, severity: 'normal',
    resetsAt: new Date(Date.now() + 3 * 86400000).toISOString(), isActive: false, lockedReason: null },
] });
const back = (resetsAt) => ({ ok: true, state: 'fresh', windows: [
  { key: 'session', label: '5h', percent: 2, severity: 'normal', resetsAt, isActive: true, lockedReason: null },
] });

app.on('ready', async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = new BrowserWindow({ width: 1400, height: 120, show: true, frame: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'app', 'renderer.html'));
    await sleep(1200);
    const js = (code) => win.webContents.executeJavaScript(code);
    const text = () => js(`document.getElementById('quota').textContent.replace(/\\s+/g, ' ').trim()`);
    const shot = async (name) => {
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1400, height: 32 });
      const file = path.join(OUT_DIR, `quota-countdown-${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log('wrote', file);
    };

    // 1. used up, 2h 14m to go
    await js(`renderQuota(${JSON.stringify(used(new Date(Date.now() + 134 * 60000 - 20000).toISOString()))}); true;`);
    await sleep(350);
    let t = await text();
    check(/Claude back in 2h 14m/.test(t), `used up reads "Claude back in 2h 14m" (header: ${JSON.stringify(t)})`);
    check(await js(`document.querySelectorAll('#quota .meter.back').length`) === 1, 'only the binding meter carries the countdown');
    await shot('used-up');

    // 2. absence is not a countdown
    await js(`renderQuota(${JSON.stringify({ ok: false, state: 'absent', windows: [], error: 'stale: last good read 5 min ago' })}); true;`);
    await sleep(200);
    t = await text();
    check(!/Claude back/.test(t) && /stale/.test(t), `a stale file shows the unknown state, no countdown (${JSON.stringify(t)})`);

    // 3. seconds under a minute, then the reset passes: toast once, then normal
    const resetsAt = new Date(Date.now() + 3000).toISOString();
    await js(`renderQuota(${JSON.stringify(used(resetsAt))}); true;`);
    await sleep(300);
    t = await text();
    check(/Claude back in \d+s/.test(t), `under a minute it counts seconds (${JSON.stringify(t)})`);
    await sleep(3200);
    await js(`renderQuota(${JSON.stringify(back(new Date(Date.now() + 5 * 3600000).toISOString()))}); true;`);
    await sleep(300);
    t = await text();
    check(t === 'Claude is back', `the reset shows "Claude is back" (${JSON.stringify(t)})`);
    await shot('back-toast');
    for (let i = 0; i < 3; i++) { await js(`renderQuota(); true;`); await sleep(150); }
    check((await js(`document.querySelectorAll('#quota .back-toast').length`)) === 1, 'repeated renders keep ONE toast, not several');
    await sleep(8300);
    t = await text();
    check(!/Claude is back|Claude back/.test(t) && /5h/.test(t), `the toast leaves and the bar is normal (${JSON.stringify(t)})`);
    await js(`renderQuota(${JSON.stringify(back(new Date(Date.now() + 5 * 3600000).toISOString()))}); true;`);
    await sleep(300);
    check(!/Claude is back/.test(await text()), 'later polls never bring the toast back');
    await shot('normal');
    console.log('\nwrote', path.resolve(OUT_DIR));
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(bail);
    app.quit();
  }
});
