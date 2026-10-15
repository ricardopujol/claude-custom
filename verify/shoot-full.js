'use strict';
/* Full-page screenshotter, with the capture VERIFIED rather than assumed.

     npx electron verify/shoot-full.js <input.html> <out.png> [--width=1500]
                                       [--sentinel=<css selector>] [--font="Cascadia Mono"]

   WHY THIS EXISTS. verify/shoot.js takes a viewport screenshot, and a viewport
   in offscreen Electron is ~860 CSS px however large a window you ask for. The
   ASCII comparison sheets are 2,000-20,000px tall, so every PNG of them stopped
   mid-row -- and the judgement made from those PNGs covered 9 of 24 candidates,
   including none at all of the technique the whole exploration was named after.

   Nothing in the artifact said so. The page's own self-audit reported "all
   within 1px of target" and went green, because it measured box geometry, which
   was fine. A check that can only see its own subject matter cannot report that
   62% of the subject matter is missing.

   So this asserts the things a screenshot can be silently wrong about, and
   fails loudly on each:

     device pixel ratio   a shot taken at DPR 2 and downscaled voids the whole
                          "true display size" premise the sheets rest on.
     fonts loaded         the stack falls back silently. A sheet rendered in the
                          wrong font is a measurement of the wrong font, and
                          box-geometry audits pass either way.
     nothing clipped      captured height against the document's own
                          scrollHeight.
     sentinel visible     an element that must be in the image. Absence is the
                          failure mode that survives every check keyed on the
                          artifact's own contents.

   Before capturing it sets `data-full-capture="1"` on <html> and calls
   `window.onFullCapture()` if the page defines one, so a page that draws a
   viewport-based "screenshot fold" warning can retract it. Without that the
   sheet warns about the very clipping this tool prevents, and draws its fold
   line through the content being judged.

   Subpixel antialiasing is disabled, because glyph candidates labelled "mono"
   were being rendered with cyan and orange fringing on every vertical stroke --
   so the noise being judged was partly the compositor's, not the technique's. */

const { app, BrowserWindow } = require('electron');
const { probeWindowOptions } = require('../host/probe-window');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const [input, output] = positional;
const width = Number(flag('width', 1500)) || 1500;
const sentinel = flag('sentinel', null);
const wantFont = flag('font', null);
const maxHeight = Number(flag('max-height', 30000)) || 30000;

if (!input || !output) {
  console.error('usage: electron verify/shoot-full.js <input.html> <out.png> [--width=] [--sentinel=] [--font=]');
  process.exit(2);
}

// DPR 1 and no LCD text, set before the app is ready so they reach the
// compositor. A shot taken at 1.25 (this display's real value) and measured as
// though it were 1 overstates every glyph by 25%.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '0');
app.commandLine.appendSwitch('disable-lcd-text');
app.commandLine.appendSwitch('disable-font-subpixel-positioning');
app.disableHardwareAcceleration();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

app.whenReady().then(async () => {
  const win = new BrowserWindow(probeWindowOptions({
    width, height: 900, show: false,
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  }));

  await win.loadFile(path.resolve(input));

  // Fonts BEFORE any measurement. The stack falls back silently, and a sheet
  // laid out in the fallback is a measurement of the fallback.
  await win.webContents.executeJavaScript(
    'document.fonts.ready.then(() => true)').catch(() => false);
  // Tell the page it is being captured WHOLE. A page that draws its own
  // "screenshot fold" warning computes it from the viewport height, and
  // captureBeyondViewport makes that arithmetic wrong -- so without this the
  // sheet cries wolf about the exact failure this tool just fixed, and its
  // fold line is drawn straight through a row of the content being judged.
  //
  // Generic on purpose: the flag and the hook are the contract, and this tool
  // knows nothing about any particular page.
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.setAttribute('data-full-capture', '1');
    if (typeof window.onFullCapture === 'function') window.onFullCapture();
    return true;
  })()`).catch(() => false);

  await new Promise(r => setTimeout(r, 400));   // gradients and filters

  const page = await win.webContents.executeJavaScript(`(() => ({
    dpr: window.devicePixelRatio,
    zoom: window.outerWidth ? window.innerWidth / window.outerWidth : 1,
    scrollHeight: Math.max(
      document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    scrollWidth: Math.max(
      document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    fontsStatus: document.fonts.status,
    fontOk: ${JSON.stringify(wantFont)} ? document.fonts.check('16px "' + ${JSON.stringify(wantFont)} + '"') : null,
    sentinelBottom: ${JSON.stringify(sentinel)}
      ? (() => { const el = document.querySelector(${JSON.stringify(sentinel)});
                 return el ? el.getBoundingClientRect().bottom + window.scrollY : null; })()
      : null,
  }))()`);

  check('device pixel ratio is 1', page.dpr === 1, `dpr=${page.dpr}`);
  check('fonts finished loading', page.fontsStatus === 'loaded', page.fontsStatus);
  if (wantFont) {
    check(`the intended font is actually available: ${wantFont}`, page.fontOk === true,
      page.fontOk === true ? '' : 'the page rendered in a FALLBACK face');
  }
  if (sentinel) {
    check(`the end sentinel exists: ${sentinel}`, page.sentinelBottom !== null,
      page.sentinelBottom === null ? 'not found in the document' : `at y=${Math.round(page.sentinelBottom)}`);
  }

  const height = Math.min(Math.ceil(page.scrollHeight), maxHeight);
  check('the page fits the capture limit', page.scrollHeight <= maxHeight,
    `document is ${Math.ceil(page.scrollHeight)}px, limit ${maxHeight}px`);

  // capturePage() clamps to the window, which is the defect this file exists
  // for. CDP captures beyond the viewport.
  let png;
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    png = Buffer.from(shot.data, 'base64');
  } catch (err) {
    console.error('capture failed:', err && err.message);
    process.exit(1);
  }

  fs.writeFileSync(output, png);

  // The PNG's own IHDR, read back from the file -- not the number we asked for.
  // "I requested a tall capture" and "a tall image exists on disk" are different
  // claims, and only the second one is evidence.
  const buf = fs.readFileSync(output);
  const pngWidth = buf.readUInt32BE(16);
  const pngHeight = buf.readUInt32BE(20);
  check('the PNG is as tall as the document', pngHeight >= Math.floor(page.scrollHeight) - 2,
    `png ${pngWidth}x${pngHeight}, document ${Math.ceil(page.scrollHeight)}px tall`);
  if (sentinel && page.sentinelBottom !== null) {
    check('the sentinel is INSIDE the image', page.sentinelBottom <= pngHeight,
      `sentinel at y=${Math.round(page.sentinelBottom)}, image is ${pngHeight}px`);
  }

  console.log(`\nwrote ${output} (${buf.length} bytes, ${pngWidth}x${pngHeight})`);
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  setTimeout(() => app.exit(failures ? 1 : 0), 200);
});
