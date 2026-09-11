'use strict';
/* Minimal Electron screenshotter: renders an HTML file and writes a PNG.
     npx electron verify/shoot.js <input.html> <output.png> [width] [height]

   Exists because SVG cannot be inspected by reading it -- the only honest check
   on generated art is to look at it. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const [input, output, w, h] = process.argv.slice(2);
const width = Number(w) || 1400;
const height = Number(h) || 900;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.resolve(input));
  await new Promise(r => setTimeout(r, 1200));   // let gradients and filters settle

  try {
    const png = (await win.webContents.capturePage()).toPNG();
    if (!png || !png.length) throw new Error('capturePage returned an empty image');
    fs.writeFileSync(output, png);
    const size = fs.statSync(output).size;
    if (size !== png.length) throw new Error(`wrote ${png.length}B but file is ${size}B`);
    console.log(`wrote ${output} (${size} bytes)`);
  } catch (err) {
    console.error('shoot failed:', err.message);
    process.exitCode = 1;
  }
  setTimeout(() => app.exit(process.exitCode || 0), 300);
});
