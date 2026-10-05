'use strict';
/**
 * The name a child row shows (BACKLOG #63, Ricardo 2026-10-05, PR #113): what the process RUNS, not its image. Fifteen
 * `node.exe` rows say nothing; `burn.js`, `stryker run` and `npm run build` do. Pure, and it never throws: a command line
 * can be empty, unterminated-quoted, a path with spaces, or not a string at all.
 *
 *   interpreters and shells (node, python, bash, sh, cmd, powershell, pwsh, ...)  the script's FILE NAME when the first
 *                          argument is a script (`burn.js`), a shell's `-c` / `/c` / `-Command` payload judged the same way,
 *                          otherwise the image and its first words (`node --test`)
 *   npx / npm / yarn / pnpm  the subcommand: `stryker run`, `npm run build`
 *   anything else          its image name without `.exe` (`git`, `docker`)
 * The full command line stays in the row's hover text; this is only the label.
 */

const MAX = 40;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'pythonw', 'py', 'ruby', 'deno', 'bun', ...SHELLS]);
const WRAPPERS = new Set(['npx', 'npm', 'yarn', 'pnpm']);
const RUN_FLAGS = new Set(['-c', '/c', '/k', '-command', '/command', '-encodedcommand']);
const SCRIPT_EXT = /\.(?:[cm]?js|ts|tsx|jsx|py|pyw|sh|ps1|bat|cmd|rb)$/i;

const isStr = s => typeof s === 'string';
const baseOf = tok => String(tok).split(/[\\/]+/).filter(Boolean).pop() || String(tok);
const stripExe = s => s.replace(/\.(?:exe|cmd|bat|com)$/i, '');
const clip = s => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/** Split a command line the way Windows does, near enough: "quoted paths with spaces" are one token; an open quote runs to the end. */
function tokens(cmd) {
  const out = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null && out.length < 64) {
    const t = m[1] !== undefined ? m[1] : m[2];
    if (t !== '') out.push(t);
  }
  return out;
}

const looksLikeScript = tok => SCRIPT_EXT.test(tok) || (/[\\/]/.test(tok) && !tok.startsWith('-'));

function labelOf(toks, imageName, depth) {
  const first = toks.length ? toks[0] : imageName;
  const image = stripExe(baseOf(first || '')).toLowerCase();
  const shown = stripExe(baseOf(first || '')) || '?';
  const args = toks.slice(1);

  if (WRAPPERS.has(image)) {
    const words = args.filter(a => !a.startsWith('-'));
    if (image === 'npx') return words.length ? words.slice(0, 2).join(' ') : shown;
    return words.length ? `${shown} ${words.slice(0, 2).join(' ')}` : shown;
  }
  if (!INTERPRETERS.has(image)) return shown;

  if (SHELLS.has(image) && depth < 2) {
    const i = args.findIndex(a => RUN_FLAGS.has(a.toLowerCase()));
    if (i >= 0 && i + 1 < args.length) {
      const rest = args.slice(i + 1);
      // `-c "npm test"` is one token holding a whole command; `/c npm test` is several.
      const inner = rest.length === 1 ? tokens(rest[0]) : rest;
      if (inner.length) return labelOf(inner, '', depth + 1);
    }
  }
  const si = args.findIndex(a => !a.startsWith('-') && !(SHELLS.has(image) && a.startsWith('/')));
  if (si >= 0 && looksLikeScript(args[si])) {
    const file = baseOf(args[si]);
    // `node node_modules/.bin/stryker run`: a script with no extension is a tool; its first words tell runs apart.
    if (SCRIPT_EXT.test(file)) {
      if (/^(?:npm|npx)-cli\.js$/i.test(file)) return labelOf([file.startsWith('npx') ? 'npx' : 'npm', ...args.slice(si + 1)], '', depth + 1);
      return file;
    }
    const more = args.slice(si + 1).filter(a => !a.startsWith('-')).slice(0, 1);
    return [file, ...more].join(' ');
  }
  return [shown, ...args.slice(0, 2)].join(' ');
}

/** displayName(cmd, imageName) -> a short, non-empty string. Never throws. */
function displayName(cmd, imageName) {
  try {
    const fallback = isStr(imageName) && imageName !== '' ? stripExe(baseOf(imageName)) || '?' : '?';
    const toks = isStr(cmd) ? tokens(cmd) : [];
    if (toks.length === 0) return clip(fallback);
    const out = labelOf(toks, isStr(imageName) ? imageName : '', 0).trim();
    return clip(out === '' ? fallback : out);
  } catch {
    return isStr(imageName) && imageName !== '' ? clip(imageName) : '?';
  }
}

module.exports = { displayName, tokens, MAX };
