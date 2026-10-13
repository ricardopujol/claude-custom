'use strict';
/**
 * app/main.js keeps its pages out of Chromium's renderer backgrounding: source assertions, because main.js needs Electron.
 *
 * MEASURED 2026-10-13 on the Katana (i7-13620H, 6 P-cores + 4 E-cores): Chromium starts every renderer as a background
 * process (Idle priority, EcoQoS), and Windows runs EcoQoS threads on the E-cores. With the E-cores at 100% (Defender,
 * WMI, telemetry, and every open window's resource sampler) a new window's strip and tab pages stayed `loading: true`
 * with an empty URL for over 60 s while the P-cores sat idle: blank window, the tab never connected to its host. With
 * this switch the same launch connected in ~8 s. verify/probe-renderer-backgrounding.js repeats the measurement. This
 * header is the one full copy of that story; app/main.js and the probe point here.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const CODE = strip(MAIN);

test('renderer backgrounding is switched off unconditionally, before the app is ready (a switch set later does nothing)', () => {
  // A top-level statement (column 0), unlike the occlusion switch, which only the screenshot and probe paths get.
  const m = /^app\.commandLine\.appendSwitch\('disable-renderer-backgrounding'\);\r?$/m.exec(CODE);
  assert.ok(m, 'main.js must append disable-renderer-backgrounding as a top-level statement');
  const ready = CODE.indexOf('app.whenReady()');
  assert.ok(ready !== -1, 'main.js no longer calls app.whenReady(): re-check where the switch must go');
  assert.ok(m.index < ready);
});
