'use strict';
/* BACKLOG #90, in the REAL header: a used-up window reads "Claude back in ...", the reset shows "Claude is back" once, then the
 * meters return to normal. A fake quota payload is handed to renderQuota; no host, no `claude`, no network.
 *
 *     node verify/probe-quota-countdown.js [outDir]          PROBE_WIDTH=700 sets the window width (default 1400)
 *
 * What it exercises that a unit test can't: the REAL tick (the countdown moves and the reset is found by the clock, with no call
 * from the probe and the payload still saying 100%), lean mode (the toast is held while the header is hidden and shows when it
 * is back), the "not clipped" check at the chosen width, a scoped window's own wording, and the settled bar after the toast.
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
const WIDTH = Number(process.env.PROBE_WIDTH) || 1400;
const bail = setTimeout(() => { console.error('TIMED OUT'); process.exit(2); }, 120000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log('ok  ', what); };

const used = (resetsAt, extra = []) => ({ ok: true, state: 'fresh', windows: [
  { key: 'session', label: '5h', percent: 100, severity: 'critical', resetsAt, isActive: true, lockedReason: 'limit_reached' },
  { key: 'weekly_all', label: 'week', percent: 61, severity: 'normal',
    resetsAt: new Date(Date.now() + 3 * 86400000).toISOString(), isActive: false, lockedReason: null },
  ...extra,
] });
const back = (resetsAt) => ({ ok: true, state: 'fresh', windows: [
  { key: 'session', label: '5h', percent: 2, severity: 'normal', resetsAt, isActive: true, lockedReason: null },
] });
const scopedOut = (resetsAt) => ({ ok: true, state: 'fresh', windows: [
  { key: 'session', label: '5h', percent: 20, severity: 'normal', resetsAt: new Date(Date.now() + 3 * 3600000).toISOString(), isActive: true, lockedReason: null },
  { key: 'weekly_scoped:Fable', label: 'Fable', percent: 100, severity: 'critical', resetsAt, isActive: false, lockedReason: null },
] });
const inMs = (ms) => new Date(Date.now() + ms).toISOString();

// A window another app covers is 'hidden' to the page (rightly: the toast waits for it). The probe's window may be covered by the
// terminal it was launched from, so Chromium's occlusion tracking is off here.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

app.on('ready', async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = new BrowserWindow({ width: WIDTH, height: 120, show: true, frame: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'app', 'renderer.html'));
    await sleep(1200);
    const js = (code) => win.webContents.executeJavaScript(code);
    // No host here, so the page's socket fails and retries every second -- and a dropped socket now (rightly) stops a running
    // countdown. Swap in a socket that never opens or closes, so the rest of the probe is about the countdown itself.
    await js(`window.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} }; true;`);
    await sleep(1600);
    const text = () => js(`document.getElementById('quota').textContent.replace(/\\s+/g, ' ').trim()`);
    const render = (payload) => js(`renderQuota(${JSON.stringify(payload)}); true;`);
    // capturePage can hand back the frame before the last paint (Miguel P1): let it settle, take one and throw it away.
    const shot = async (name) => {
      await sleep(250);
      await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: 32 });
      await sleep(100);
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: 32 });
      const file = path.join(OUT_DIR, `quota-countdown-${name}-${WIDTH}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log('wrote', file);
    };
    const until = async (pred, ms, what) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await pred()) return; await sleep(100); }
      throw new Error(`FAILED: timed out waiting for ${what} (header: ${JSON.stringify(await text())}, visible: ${await js("quotaHeaderVisible() + \" \" + document.visibilityState + \" \" + leanOn + \" \" + document.querySelector(\"header\").getBoundingClientRect().height")})`);
    };
    const fits = (what) => js(`(() => { const q = document.getElementById('quota'); const p = q.querySelector('.meter.back .pct');
      const qr = q.getBoundingClientRect(), pr = p.getBoundingClientRect();
      return { qScroll: q.scrollWidth, qClient: q.clientWidth, pScroll: p.scrollWidth, pClient: p.clientWidth, pRight: pr.right, qRight: qr.right, win: innerWidth }; })()`)
      .then((f) => {
        console.log('fit', what, JSON.stringify(f));
        check(f.qScroll <= f.qClient + 1 && f.pScroll <= f.pClient + 1 && f.pRight <= f.qRight + 1 && f.qRight <= f.win, `${what} not clipped at ${WIDTH}px`);
      });

    // 1. used up, 2h 14m to go
    await render(used(inMs(134 * 60000 - 20000)));
    await sleep(350);
    let t = await text();
    check(/Claude back in 2h 14m/.test(t), `used up reads "Claude back in 2h 14m" (header: ${JSON.stringify(t)})`);
    check(await js(`document.querySelectorAll('#quota .meter.back').length`) === 1, 'only the binding meter carries the countdown');
    await fits('countdown');
    await shot('used-up');

    // 1b. the longest wording
    await render(used(inMs(3 * 86400000)));
    await sleep(350);
    check(/Claude back [A-Z][a-z]{2} \d\d:\d\d/.test(await text()), 'beyond a day it names the weekday and the time');
    await fits('weekday wording');
    await shot('used-up-weekday');

    // 1c. a model-scoped window is not Claude being out
    await render(scopedOut(inMs(2 * 86400000)));
    await sleep(350);
    t = await text();
    check(/Fable back [A-Z][a-z]{2} \d\d:\d\d/.test(t) && !/Claude back/.test(t), `a scoped window says its model, never Claude (${JSON.stringify(t)})`);
    await shot('scoped');

    // 2. absence is not a countdown
    await render({ ok: false, state: 'absent', windows: [], error: 'stale: last good read 5 min ago' });
    await sleep(200);
    t = await text();
    check(!/Claude back/.test(t) && /stale/.test(t), `a stale file shows the unknown state, no countdown (${JSON.stringify(t)})`);

    // 3. the REAL tick: the probe renders once, then only waits. The seconds move and the reset is found by the clock while the
    //    payload still says 100%.
    await render(used(inMs(5000)));
    await sleep(300);
    const first = await text();
    check(/Claude back in \d+s/.test(first), `under a minute it counts seconds (${JSON.stringify(first)})`);
    await sleep(2200);
    const later = await text();
    check(/Claude back in \d+s/.test(later) && later !== first, `the real tick moved the countdown with no call from the probe (${JSON.stringify(first)} -> ${JSON.stringify(later)})`);
    await until(async () => (await text()) === 'Claude is back', 8000, '"Claude is back" from the clock alone');
    console.log('ok   the reset was found by the clock, the payload still said 100%');
    check(await js(`document.getElementById('quota-announce').textContent`) === 'Claude is back', 'the toast is announced through the persistent live region');
    await shot('back-toast');
    check((await text()) === 'Claude is back', 'the screenshot was taken with the toast showing');
    for (let i = 0; i < 3; i++) { await js(`renderQuota(); true;`); await sleep(150); }
    check((await js(`document.querySelectorAll('#quota .back-toast').length`)) === 1, 'repeated renders keep ONE toast, not several');
    await until(async () => !/Claude is back/.test(await text()), 12000, 'the toast to leave');
    t = await text();
    check(!/100%/.test(t), `after the toast the old 100% is not drawn while the next poll is awaited (${JSON.stringify(t)})`);
    await render(back(inMs(5 * 3600000)));
    await sleep(300);
    check(!/Claude is back/.test(await text()) && /5h/.test(await text()), 'a later poll shows the bar normal and never brings the toast back');
    await shot('normal');

    // 4. lean: the reset happens while the header is hidden; the toast waits and shows when the header is back.
    await js(`leanOn = true; document.body.classList.add('lean'); true;`);
    await render(used(inMs(2500)));
    await sleep(3500);
    await render(back(inMs(5 * 3600000)));
    await sleep(300);
    check(!/Claude is back/.test(await text()), 'while lean the toast is not spent on a hidden header');
    await js(`leanOn = false; document.body.classList.remove('lean'); renderQuota(); true;`);
    await sleep(300);
    check((await text()) === 'Claude is back', 'leaving lean shows the toast that was held');
    await shot('after-lean');
    await until(async () => !/Claude is back/.test(await text()), 12000, 'the held toast to leave');
    await js(`renderQuota(); true;`);
    await sleep(200);
    check(!/Claude is back/.test(await text()), 'and it is not shown a second time');

    console.log('\nwrote', path.resolve(OUT_DIR));
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(bail);
    app.quit();
  }
});
