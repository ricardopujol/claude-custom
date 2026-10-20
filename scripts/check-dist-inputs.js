'use strict';
/**
 * `npm run dist` runs this first (the `predist` script). The installer is useless without the hook helper (no helper, no hooks:
 * agents never go Active), and electron-builder's file patterns don't fail when a re-included file is missing, so a build with no
 * helper would quietly produce an 87 MB installer that breaks the one thing this packaging exists to prevent.
 *
 * Exits 1, naming the fix, when `.harness/hook-helper.exe` is missing or won't run (it returns 0 at once when given no arguments).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, '..', '.harness', 'hook-helper.exe');

function checkDistInputs({ helper = HELPER, exists = fs.existsSync, run = (f) => spawnSync(f, [], { timeout: 5000, windowsHide: true }) } = {}) {
  if (!exists(helper)) return { ok: false, message: `dist: ${helper} is missing. Run \`npm run build:helper\` first (or copy a built hook-helper.exe there).` };
  const r = run(helper);
  if (!r || r.error || r.status !== 0) {
    return { ok: false, message: `dist: ${helper} is there but won't run (${r && r.error ? r.error.message : `exit ${r && r.status}`}). Rebuild it with \`npm run build:helper\`.` };
  }
  return { ok: true, message: `dist: hook helper found and runs (${helper})` };
}

if (require.main === module) {
  const r = checkDistInputs();
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}

module.exports = { checkDistInputs };
