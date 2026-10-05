'use strict';
/**
 * The name a child row shows (BACKLOG #63, Ricardo 2026-10-05, PR #113): what the process RUNS, not its image. Fifteen
 * `node.exe` rows say nothing; `burn.js`, `stryker run` and `npm run build` do. Pure, and it never throws: a command line
 * can be empty, unterminated-quoted, a path with spaces, or not a string at all.
 *
 * It is a small, explicit argv GRAMMAR per program (Dexter, PR #113 review: "the first word that does not start with a dash"
 * names a flag's VALUE as the script):
 *   node / bun / deno / ruby   `-r X`, `--require X`, `--import X`, `--loader X` take a value; `-e/--eval/-p/--print` run code,
 *                              shown as `node -e` and never as a fragment of the code; else the first argument is the script
 *   python                     `-m mod` shows the module, `-c` shows `python -c`; `-W X` / `-X X` take a value
 *   bash / sh / zsh            combined short flags (`-lc`), options between `-c` and the command string (`-c -l "..."`), and
 *                              Claude Code's `source <snapshot> && eval '<cmd>' < /dev/null && pwd -P >| <file>` payload
 *   cmd                        `/d /s /c "..."`, including the outer-quote form `/c ""C:\\x y\\npm.cmd" run build"`
 *   powershell / pwsh          `-File x.ps1`, `-Command ...`, and the options that take a value (`-ExecutionPolicy X`)
 *   npm / npx / yarn / pnpm    the subcommand, also through their node entry scripts (`pnpm.cjs run build`)
 *   anything else              its image name without `.exe` (`git`, `docker`)
 * A script shows as its FILE NAME. The program is the `imageName` the OS reports when argv0 disagrees with it (an unquoted
 * path with spaces). The result never contains a quote, never starts with `-` or `/`, and is never blank. The full
 * command line stays in the row's hover text; this is only the label.
 */

const MAX = 40;
const DEPTH = 4;
const SCRIPT_EXT = /\.(?:[cm]?js|ts|tsx|jsx|py|pyw|sh|ps1|bat|cmd|rb)$/i;
const WRAPPER_ENTRY = /^(npm|npx|yarn|pnpm|pnpx)(?:-cli)?\.(?:[cm]?js)$/i;
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const NODELIKE = new Set(['node', 'nodejs', 'bun', 'deno', 'ruby']);
const WRAPPERS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'pnpx']);

const NODE_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-C', '--conditions', '--input-type', '--title']);
const NODE_EVAL = new Set(['-e', '--eval', '-p', '--print', '-pe', '--test']);   // `node --test` runs files: shown as `node --test`
const PY_VALUE = new Set(['-W', '-X', '--check-hash-based-pycs']);
const BASH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const PS_VALUE = /^-(?:executionpolicy|ep|windowstyle|w|workingdirectory|wd|version|v|inputformat|outputformat|configurationname|custompipename)$/i;
const SHELL_SKIP_FIRST = new Set(['source', '.', 'cd', 'export', 'set', 'shopt', 'unset', 'true', 'pwd', 'exit', 'umask', 'alias', 'eval-setup']);

const isStr = s => typeof s === 'string';
const baseOf = tok => String(tok).split(/[\\/]+/).filter(Boolean).pop() || '';
const stripExe = s => s.replace(/\.(?:exe|cmd|bat|com)$/i, '');
const clean = s => String(s).replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
const clip = s => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/**
 * Split an argument string. Windows rules (the C runtime's): whitespace separates, `"` toggles, and 2n backslashes then a
 * quote is n backslashes plus a toggle, 2n+1 is n backslashes plus a literal quote. `posix` adds single quotes (a shell
 * payload). An open quote runs to the end. Capped, so a huge line is cheap.
 */
function tokens(str, { posix = false } = {}) {
  const text = isStr(str) ? str.slice(0, 8192) : '';
  const out = [];
  let cur = '';
  let has = false;
  let inQ = false;
  let inS = false;
  for (let i = 0; i < text.length && out.length < 64; i++) {
    const c = text[i];
    if (inS) { if (c === "'") inS = false; else cur += c; continue; }
    if (c === '\\') {
      let n = 0;
      while (text[i + n] === '\\') n++;
      if (text[i + n] === '"') {
        cur += '\\'.repeat(n >> 1);
        has = true;
        if (n & 1) { cur += '"'; i += n; } else { inQ = !inQ; i += n; }
      } else { cur += '\\'.repeat(n); has = true; i += n - 1; }
      continue;
    }
    if (c === '"') { inQ = !inQ; has = true; continue; }
    if (posix && !inQ && c === "'") { inS = true; has = true; continue; }
    if (!inQ && /\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has && out.length < 64) out.push(cur);
  return out;
}

/** The program and the argument string after it. argv0 is quoted, or runs to the first space; `imageName` wins when they disagree. */
function splitProgram(cmd, imageName) {
  const text = isStr(cmd) ? cmd.trim() : '';
  let argv0;
  let rest;
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    argv0 = close < 0 ? text.slice(1) : text.slice(1, close);
    rest = close < 0 ? '' : text.slice(close + 1);
  } else {
    const m = /^(\S*)([\s\S]*)$/.exec(text);
    argv0 = m[1];
    rest = m[2];
  }
  const image = isStr(imageName) ? stripExe(baseOf(imageName)).toLowerCase() : '';
  if (image && argv0 && stripExe(baseOf(argv0)).toLowerCase() !== image) {
    // An unquoted path with spaces ("C:\Program Files\nodejs\node.exe C:\x\burn.js"): the arguments start after the image's name.
    const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = new RegExp(`(?:^|[\\\\/"])${escaped}(?:\\.(?:exe|cmd|bat|com))?(?=["\\s]|$)`, 'i').exec(text);
    if (hit) {
      const after = text.slice(hit.index + hit[0].length).replace(/^"/, '');
      return { program: image, shown: stripExe(baseOf(imageName)), rest: after };
    }
    return { program: image, shown: stripExe(baseOf(imageName)), rest };
  }
  const shown = stripExe(baseOf(argv0));
  return { program: shown.toLowerCase().replace(/^(python)[\d.]*$/, '$1').replace(/^pythonw$/, 'python'), shown, rest };
}

function wrapperLabel(name, args) {
  const words = [];
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('-')) continue;
    words.push(a);
    if (words.length >= 2) break;
  }
  const n = name.toLowerCase();
  if (n === 'npx' || n === 'pnpx') return words.length ? words.join(' ') : n;
  return [n, ...words].join(' ');
}

function scriptLabel(tok, after) {
  const file = baseOf(tok);
  if (WRAPPER_ENTRY.test(file)) return wrapperLabel(file.replace(/(?:-cli)?\.[cm]?js$/i, ''), after);
  if (SCRIPT_EXT.test(file)) return file;
  // `node node_modules/.bin/stryker run`: an extensionless tool; its first word tells runs apart.
  const more = after.filter(a => !a.startsWith('-')).slice(0, 1);
  return [file, ...more].join(' ');
}

/** Interpreter grammar: the first argument that is not an option or an option's value is the script. */
function interpreterLabel(shown, args, { value, evals, pyModule = false }) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return i + 1 < args.length ? scriptLabel(args[i + 1], args.slice(i + 2)) : shown;
    const flag = a.includes('=') && a.startsWith('--') ? a.slice(0, a.indexOf('=')) : a;
    if (evals.has(flag)) return `${shown} ${flag}`;
    if (pyModule && flag === '-m') return args[i + 1] ? baseOf(args[i + 1]) : shown;
    if (a.startsWith('--') && a.includes('=')) continue;
    if (value.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return scriptLabel(a, args.slice(i + 1));
  }
  return [shown, ...args.filter(a => a.startsWith('-')).slice(0, 2)].join(' ');
}

/** A shell payload (what `-c` runs): Claude Code's `source <snapshot> && eval '<cmd>' < /dev/null && pwd -P >| <file>`, or a plain command. */
function payloadLabel(payload, depth) {
  const text = isStr(payload) ? payload : '';
  const ev = /(?:^|[\s;&|])eval\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(text);
  if (ev) return labelOfCommand((ev[1] !== undefined ? ev[1] : ev[2]).replace(/\\(["\\$`])/g, '$1'), '', depth + 1, true);
  const segs = text.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  const pick = segs.find((s) => {
    const w = s.split(/\s+/)[0];
    return !SHELL_SKIP_FIRST.has(w);
  }) || segs[0] || '';
  const stripped = tokens(pick, { posix: true }).filter(t => !/^\d*[<>]/.test(t));
  while (stripped.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped[0])) stripped.shift();
  if (stripped[0] === 'exec' || stripped[0] === 'command' || stripped[0] === 'sudo') stripped.shift();
  return labelOfCommand(stripped.map(t => (/\s/.test(t) ? `"${t}"` : t)).join(' '), '', depth + 1, true);
}

function posixShellLabel(shown, rest, depth) {
  const args = tokens(rest);
  let wantsCommand = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { if (!wantsCommand && args[i + 1]) return scriptLabel(args[i + 1], args.slice(i + 2)); break; }
    if (BASH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(a)) { if (a.startsWith('-') && a.includes('c')) wantsCommand = true; continue; }
    if (wantsCommand) return payloadLabel(a, depth);
    return scriptLabel(a, args.slice(i + 1));
  }
  return shown;
}

function cmdLabel(shown, rest, depth) {
  const m = /(?:^|\s)\/[ck](?=[\s"]|$)/i.exec(rest);
  if (!m) return shown;
  let payload = rest.slice(m.index + m[0].length).trim();
  // cmd drops one outer pair of quotes under /s (and Node's `shell: true` adds one): `""C:\\x y\\npm.cmd" run build"`.
  if (payload.length >= 2 && payload.startsWith('"') && payload.endsWith('"')) {
    const inner = payload.slice(1, -1);
    const slashS = /(?:^|\s)\/s(?=\s|$)/i.test(rest.slice(0, m.index + 1));
    if (slashS || !inner.includes('"') || inner.startsWith('"')) payload = inner;
  }
  return payload === '' ? shown : labelOfCommand(payload, '', depth + 1, false);
}

function powershellLabel(shown, rest, depth) {
  const args = tokens(rest);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-f(?:ile)?$/i.test(a)) return args[i + 1] ? baseOf(args[i + 1]) : shown;
    if (/^-(?:c|command)$/i.test(a)) {
      const tail = args.slice(i + 1);
      if (tail.length === 0) return shown;
      return labelOfCommand(tail.length === 1 ? tail[0] : tail.map(t => (/\s/.test(t) ? `"${t}"` : t)).join(' '), '', depth + 1, false);
    }
    if (/^-(?:e|ec|encodedcommand)$/i.test(a)) return shown;
    if (PS_VALUE.test(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (SCRIPT_EXT.test(a)) return baseOf(a);
    return labelOfCommand(args.slice(i).map(t => (/\s/.test(t) ? `"${t}"` : t)).join(' '), '', depth + 1, false);
  }
  return shown;
}

function labelOfCommand(cmd, imageName, depth, posix) {
  if (depth > DEPTH) return '';
  const { program, shown, rest } = splitProgram(cmd, imageName);
  if (shown === '') return '';
  if (WRAPPERS.has(program)) return wrapperLabel(program, tokens(rest, { posix }));
  if (NODELIKE.has(program)) return interpreterLabel(shown, tokens(rest, { posix }), { value: NODE_VALUE, evals: NODE_EVAL });
  if (program === 'python') return interpreterLabel(shown, tokens(rest, { posix }), { value: PY_VALUE, evals: new Set(['-c']), pyModule: true });
  if (program === 'py') return interpreterLabel(shown, tokens(rest, { posix }), { value: PY_VALUE, evals: new Set(['-c']), pyModule: true });
  if (POSIX_SHELLS.has(program)) return posixShellLabel(shown, rest, depth);
  if (program === 'cmd') return cmdLabel(shown, rest, depth);
  if (POWERSHELLS.has(program)) return powershellLabel(shown, rest, depth);
  return shown;
}

/** displayName(cmd, imageName) -> a short, non-empty string with no quote in it. Never throws. */
function displayName(cmd, imageName) {
  const image = isStr(imageName) ? stripExe(baseOf(imageName)) : '';
  const fallback = clean(image).replace(/^[-/\s]+/, '') || '?';
  try {
    if (!isStr(cmd) || cmd.trim() === '') return clip(fallback);
    const out = clean(labelOfCommand(cmd, imageName, 0, false));
    if (out === '' || /^[-/]/.test(out)) return clip(fallback);
    return clip(out);
  } catch {
    return clip(fallback);
  }
}

module.exports = { displayName, tokens, splitProgram, MAX };
