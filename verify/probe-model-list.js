'use strict';
/* Does the installed `claude` CLI expose its model list in any drivable form?
   BACKLOG E #5, step 1 -- this GATES the Claude-source design; nothing about
   picking a model is built until this probe says what is safe to build on.

   Four surfaces, all measured on the REAL CLI, spending nothing (no prompt is
   ever submitted -- `/model` and reading `--help` are both local):

     (a) `claude --help` / `--version` -- documented flags and subcommands.
     (b) the bare `/model` picker, driven in a pty exactly like
         verify/probe-top-bar-truth.js drives `/model <alias>` -- what it
         PRINTS, paged with the down arrow, then cancelled with one Esc so
         nothing changes.
     (c) settings/cache files under ~/.claude that might name model ids:
         settings.json, and anything under ~/.claude/cache/.
     (d) a `claude config` surface -- there is no such subcommand (confirmed
         below); `claude config --help` degrades to the top-level help because
         "config" is parsed as the free-text prompt argument, not a command.

   Safety, same as probe-top-bar-truth.js: ANTHROPIC_API_KEY and
   ELECTRON_RUN_AS_NODE are deleted from the child env (Max login, and nothing
   can bill a key; Claude Code is itself Electron, so an inherited
   ELECTRON_RUN_AS_NODE would start the child as plain Node with an error that
   names anything but the cause). Every settings file `/model` could touch is
   snapshotted first and restored after, byte for byte.

     node verify/probe-model-list.js

   MEASURED 2026-09-27, this machine, claude 2.1.283:

   (a) `--help`'s `--model` flag documents THREE alias examples in prose --
       "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')" --
       and a full-id example ('claude-fable-5'). This is illustrative ("e.g."),
       not an enumerable list: 'haiku' is not named here even though it is a
       real, working alias (see (b)/(d) below and the app's existing
       MODEL_CHOICES). No `models` subcommand, no `--list-models` flag, no
       `claude config` command exists -- `Commands:` in --help lists agents,
       attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp,
       plugin(s), project, respawn, rm, setup-token, ultrareview,
       update/upgrade. Nothing names or lists models.

   (b) bare `/model` (no argument) opens an interactive picker that DOES
       enumerate the live catalogue as on-screen text: a numbered list of
       FRIENDLY NAMES with one-line descriptions and a "current" checkmark,
       e.g. "2. Opus 5.5 ✔  Most capable for ambitious work",
       "3. Fable 5.1  For your toughest challenges", 10 of them fitting the
       default viewport plus a trailing "... +1 model" once there are more,
       revealed by paging with the down arrow. This is real, current,
       versioned CLI output -- but it carries NO id and NO typeable alias per
       row, only a friendly display name and its screen POSITION, and that
       position shifts as the catalogue changes (yesterday's item 6 need not
       be today's). Selecting a row for real requires arrow-key navigation to
       a matching label, not typed text -- a different driving mechanism than
       every existing picker in this codebase (which types `/model <alias>`
       or a full id as one line, e.g. top-bar-display.js's planSwitch).
       MEASURED further: the viewport does not page on its own -- one down
       arrow moves the CURSOR one row and only scrolls once the cursor reaches
       the last visible row, so reading the 11th (hidden) entry costs 9 real
       keypresses from the boot position, not one. Reading N models costs
       O(N) keypresses against a live pty, confirming this is a navigation
       exercise rather than a catalogue read.

   (c) `~/.claude/settings.json`'s `modelSettings` block names only whichever
       model the USER has personally tuned (`{"claude-opus-5-5":
       {"effortLevel":"medium"}}` on this machine) -- one entry, not a
       catalogue. `~/.claude/cache/model-catalog/<uuid>-<hash>-cc.json` DOES
       hold the full structured catalogue (id, name, short_name, section,
       quick_select, etc. -- more entries than the picker showed on one
       screen) but its path embeds two hashes that look session/install
       specific, its schema is entirely undocumented, and nothing in `--help`
       or the CLI's own docs promises it will keep existing or keep this
       shape. This is exactly the internal-cache case the decision rule
       excludes.

   (d) no `config` subcommand: `claude config --help` prints the generic
       top-level help (the same text `claude --help` prints), which is what
       happens when "config" is consumed as the free-text `prompt` argument
       and `--help` short-circuits before a prompt would ever be sent --
       confirming there is no model-list surface hiding behind it.

   DECISION (Ricardo's rule applied): (a) is prose illustration, not a
   documented enumerable list. (c)'s catalogue is real but is the internal-
   cache case the rule excludes outright. (b) is genuine CLI-native output,
   named as an acceptable source by the rule itself -- but turning it into a
   background, non-disruptive freshness source is a DIFFERENT and much larger
   build than "read some text": it means either (i) spawning a whole separate
   `claude` process through boot (~seconds, not an HTTP round trip) every
   refresh purely to screen-scrape a menu, or (ii) hijacking the user's live
   session pty to do the same thing in front of them, and either way SELECTING
   a remembered favourite later means re-opening that picker and arrow-walking
   to whichever row now matches its label, because the id behind each row is
   never shown. That is a new interactive-picker-driving subsystem, not a
   catalogue read, and it is exactly the kind of thing this probe exists to
   flag rather than build on the spot. Verdict: STOP the Claude-source part.
   The three hardcoded aliases in app/top-bar-display.js:34 and
   app/renderer.html:791-793 are UNCHANGED by this PR. Findings above are for
   Ricardo's call on whether (b) is worth the picker-driving subsystem, or
   whether 'fable' simply joins the hardcoded three as a fourth documented
   alias next time that file is touched. */

const fs = require('fs');

// --- statusLine mode, same as probe-top-bar-truth.js. MUST run before the
// exploration IIFE below: this file is re-invoked as the statusLine command
// itself (see settingsTmp), and a bare top-level `return` only works because
// Node wraps a CommonJS entry file in a function -- that wrapper is why this
// has to sit ahead of any other top-level code that would otherwise run too.
if (process.argv[2] === '--status') {
  const logFile = process.argv[3];
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => {
    fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), raw: buf }) + '\n');
    process.stdout.write('probe-status');
  });
  return;
}

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const REPO = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runClaude(args) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    // Windows: the global install is a .cmd shim, which execFileSync cannot
    // exec directly without a shell (ENOENT otherwise -- MEASURED here). Node
    // warns that shell:true args are unescaped -- safe here because every
    // caller below passes static literals ('--version', '--help', 'config'),
    // never anything derived from user input.
    return execFileSync('claude', args, {
      cwd: REPO, env, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    });
  } catch (err) {
    // A non-zero exit still carries useful stdout (e.g. --help via a bad flag).
    return (err && err.stdout) || '';
  }
}

(async () => {
  // --- (a) --help / --version --------------------------------------------
  const version = runClaude(['--version']).trim();
  check('claude --version answers', /^\d+\.\d+\.\d+/.test(version), version || 'no output');

  const help = runClaude(['--help']);
  const modelFlagBlock = (help.match(/--model <model>[\s\S]{0,400}/) || [''])[0];
  check('the --model flag is documented', /--model <model>/.test(help), '');
  check('the --model flag names example aliases (illustrative, not exhaustive)',
    /alias for the latest model/.test(modelFlagBlock), modelFlagBlock.replace(/\s+/g, ' ').trim().slice(0, 160));
  check('no "models" or "config" subcommand is listed', !/^\s*(models|config)\s/m.test(help.split('Commands:')[1] || ''),
    'Commands: block has no models/config entry');

  // --- (d) `claude config` is not a real command ---------------------------
  const configHelp = runClaude(['config', '--help']);
  check('`claude config --help` degrades to the generic top-level help (no config command exists)',
    configHelp.trim() === help.trim(), configHelp === help ? 'byte-identical' : 'DIFFERS -- investigate');

  // --- (c) settings / cache files ------------------------------------------
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  let modelSettingsKeys = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    modelSettingsKeys = Object.keys((parsed && parsed.modelSettings) || {});
  } catch { /* no settings file, or unreadable -- both fine to report as empty */ }
  check('settings.json modelSettings names only tuned models, not a catalogue',
    true, `keys: ${modelSettingsKeys.join(', ') || '(none)'}`);

  const cacheDir = path.join(os.homedir(), '.claude', 'cache', 'model-catalog');
  let cacheFiles = [];
  try { cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')); } catch { /* absent */ }
  let cacheModelCount = null;
  if (cacheFiles.length) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheFiles[0]), 'utf8'));
      const models = parsed && parsed.catalog && parsed.catalog.config && parsed.catalog.config.models;
      cacheModelCount = Array.isArray(models) ? models.length : null;
    } catch { /* unreadable -- reported as null below */ }
  }
  check('an internal model-catalog cache exists (undocumented -- excluded by the decision rule)',
    cacheFiles.length > 0, cacheFiles.length
      ? `${cacheFiles.length} file(s), first names ${cacheModelCount === null ? 'unreadable' : cacheModelCount + ' models'}`
      : 'not present on this machine');

  // --- (b) the bare /model picker, driven in a pty -------------------------
  let pty, Terminal;
  try {
    pty = require('node-pty');
    ({ Terminal } = require('@xterm/headless'));
  } catch (err) {
    check('node-pty / @xterm/headless available to drive the picker', false, err.message);
    finish();
    return;
  }

  const COLS = 120;
  const ROWS = 40;
  const stamp = Date.now();
  const statusLog = path.join(os.tmpdir(), `cc-probe-modellist-status-${stamp}.jsonl`);
  const settingsTmp = path.join(os.tmpdir(), `cc-probe-modellist-settings-${stamp}.json`);
  const node = process.execPath.replace(/\\/g, '/');
  const self = __filename.replace(/\\/g, '/');
  fs.writeFileSync(settingsTmp, JSON.stringify({
    statusLine: { type: 'command', command: `"${node}" "${self}" --status "${statusLog.replace(/\\/g, '/')}"`, padding: 0 },
  }));

  const guarded = [
    settingsFile,
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(REPO, '.claude', 'settings.json'),
    path.join(REPO, '.claude', 'settings.local.json'),
  ];
  const snapshot = new Map(guarded.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
  function restore() {
    const changed = [];
    for (const [f, before] of snapshot) {
      const now = fs.existsSync(f) ? fs.readFileSync(f) : null;
      const same = before === null ? now === null : (now !== null && before.equals(now));
      if (same) continue;
      changed.push(f);
      if (before === null) fs.rmSync(f, { force: true });
      else fs.writeFileSync(f, before);
    }
    return changed;
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;

  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const args = process.platform === 'win32'
    ? ['/c', 'claude', '--settings', settingsTmp]
    : ['--settings', settingsTmp];
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'claude';
  const child = pty.spawn(shell, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env });
  child.onData((d) => term.write(d));

  const screen = () => {
    const b = term.buffer.active;
    const out = [];
    for (let y = 0; y < ROWS; y++) {
      const l = b.getLine(b.viewportY + y);
      out.push(l ? l.translateToString(true).replace(/\s+$/, '') : '');
    }
    return out;
  };
  const type = async (text, ms = 600) => { child.write(text); await sleep(ms); };
  const enter = async (ms = 3000) => { child.write('\r'); await sleep(ms); };
  async function waitFor(pred, ms) {
    for (let t = 0; t < ms; t += 250) { if (pred()) return true; await sleep(250); }
    return false;
  }
  // A row's line has an optional one-glyph cursor/scroll marker (❯ current
  // selection, ↓ more below) BEFORE the number -- MEASURED to vary between
  // "❯ 2.  Opus 5.5 ✔  ..." and "  10. Opus 4.6  ...", so any single
  // non-digit lead-in is absorbed rather than requiring a specific glyph.
  const NUMBERED = /^\s*\S?\s*(\d+)\.\s+(.+?)(?:\s{2,}(.*))?$/;
  const DEBUG_SCREENS = process.env.CLAUDE_CUSTOM_PROBE_DEBUG
    ? fs.createWriteStream(path.join(os.tmpdir(), `cc-probe-modellist-screens-${Date.now()}.log`))
    : null;

  let pickerRows = [];
  let pageCount = 0;
  let sawMore = false;
  let boot = false;
  let listedAliasesWork = {};

  try {
    boot = await waitFor(() => screen().some((l) => /[❯>]\s*$|[❯>] /.test(l)), 30000);
    await sleep(1500);

    // Open the picker.
    await type('/model');
    await enter(2500);

    const seen = new Map(); // label -> description, keyed to dedupe across pages
    for (let page = 0; page < 6; page++) {
      pageCount++;
      const lines = screen();
      if (DEBUG_SCREENS) DEBUG_SCREENS.write(`\n--- page ${page} ---\n${lines.filter(Boolean).join('\n')}\n`);
      for (const line of lines) {
        const m = NUMBERED.exec(line);
        // Trailing markers seen: "(current)" and a checkmark glyph next to the
        // running model's name.
        if (m) seen.set(m[2].replace(/\s*(\(current\)|[✔✓])\s*$/i, '').trim(), (m[3] || '').trim());
        // MEASURED text is "+N model" / "+N models", not "+N more" as guessed
        // on the first pass -- fixed after the debug screen dump showed it.
        if (/\+\s*\d+\s+models?\b/i.test(line)) sawMore = true;
      }
      if (!sawMore) break;
      sawMore = false;
      await type('\x1b[B', 500); // one down-arrow
    }
    pickerRows = [...seen.entries()];
    // Cancel without changing anything -- ONE Esc, never two (a second Esc can
    // fall through to a different dialog layer).
    await type('\x1b', 1200);

    // Free-text aliases: does the CLI accept 'fable' the same way it accepts
    // the three already hardcoded, or does it need the picker's arrow nav?
    for (const alias of ['fable', 'haiku']) {
      const before = fs.existsSync(statusLog) ? fs.readFileSync(statusLog, 'utf8').split('\n').filter(Boolean).length : 0;
      await type(`/model ${alias}`);
      await enter(3500);
      const lines = (fs.existsSync(statusLog) ? fs.readFileSync(statusLog, 'utf8') : '')
        .split('\n').filter(Boolean).slice(before);
      let matched = false;
      for (const l of lines) {
        try {
          const doc = JSON.parse(JSON.parse(l).raw);
          if (doc && doc.model && typeof doc.model.id === 'string'
            && doc.model.id.toLowerCase().includes(alias)) matched = true;
        } catch { /* not JSON, ignore */ }
      }
      listedAliasesWork[alias] = matched;
    }
  } catch (err) {
    check('the picker probe ran without throwing', false, err && err.message);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(1000);
    const changed = restore();
    fs.rmSync(settingsTmp, { force: true });
    fs.rmSync(statusLog, { force: true });
    check('settings files were restored byte-for-byte', true,
      changed.length ? `touched and restored: ${changed.join(', ')}` : 'nothing needed restoring');
  }

  check('the CLI booted to a ready prompt', boot, '');
  check('the bare /model picker enumerates named, described rows', pickerRows.length > 0,
    `${pickerRows.length} distinct rows over ${pageCount} page(s): ` +
    pickerRows.slice(0, 5).map(([label]) => label).join(' | ') + (pickerRows.length > 5 ? ' | …' : ''));
  check('the picker rows carry NO typeable id, only a friendly name + position',
    pickerRows.every(([label]) => !/^[a-z0-9._/:-]+$/i.test(label) || / /.test(label)),
    'every row is a display name like "Opus 5.5", never an id');
  for (const [alias, ok] of Object.entries(listedAliasesWork)) {
    check(`typed free text "/model ${alias}" is accepted as a real alias (confirmed by statusLine)`, ok, '');
  }

  finish();

  function finish() {
    console.log(failures ? `\n${failures} check(s) reported false (see MEASURED notes above for context, not all are failures of the CLI)` : '\nALL PASS');
    process.exit(0); // this is exploration, not a pass/fail gate
  }
})();
