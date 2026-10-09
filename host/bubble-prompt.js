'use strict';
/**
 * What reaches the local model for a speech bubble, and what comes back (BACKLOG #80, rules settled in #55).
 *
 *   buildPrompt({ agent, state, tool, files, task, voice }) -> { system, prompt } | null
 *   cleanLine(reply)                                        -> one short line | null
 *   voiceFromMd(raw)                                        -> { description, signOff } | null
 *   maskSecrets(text), safeFileName(path)
 *
 * INPUT IS TRIMMED BY CONSTRUCTION: buildPrompt READS only the six fields above, so a caller that passes file contents, an
 * environment or a tool's whole input leaks nothing (test/bubble-prompt.test.js plants them). What is read is cut down again:
 * a state from the four moods, a tool name of plain characters, at most three file NAMES (never a folder; secret-looking names
 * like .env, *.pem, id_rsa dropped), and one task line with anything key-shaped masked. It stays on this machine either way
 * (Ollama on 127.0.0.1), but the vault's values never go in a prompt.
 *
 * DECORATION, NEVER INFORMATION: the system prompt asks for a joke that never says anything was done, and the card labels a
 * bubble by its look. The reply is cleaned to one short line; code, links and paths are refused (a joke has none).
 *
 * THE VOICE comes from the agent's own .md: its description, and a sign-off instruction if its body has one (Miguel in
 * Spanish, Mortimer's MUAJAJA). No file, or neither: a neutral voice.
 */

const STATES = new Set(['sleeping', 'working', 'happy', 'stressed']);
const LINE_MAX = 80;
const TASK_MAX = 160;
const NAME_MAX = 60;
const FILES_MAX = 3;
const FILE_NAME_MAX = 80;
const DESCRIPTION_MAX = 240;
const SIGN_OFF_MAX = 220;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const cap = (s, n) => {
  const chars = [...s];
  return chars.length <= n ? s : chars.slice(0, n).join('').trimEnd();
};
const oneLine = (s) => String(s).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();

/** The text with anything key-shaped replaced by [secret]. A heuristic: the cost of a miss is a joke prompt on this machine. */
function maskSecrets(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[secret]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[secret]')
    .replace(/AKIA[0-9A-Z]{12,}/g, '[secret]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [secret]')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[secret]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[secret]')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[secret]');
}

const SECRET_NAME_RES = [
  /^\.env/i, /\.(pem|key|p12|pfx|crt|cer|keystore|jks)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /secret|token|credential|password|passwd|api[_-]?key|apikey/i,
];

/** The file's NAME (no folder), or null when it is long, odd or looks like it holds a secret. */
function safeFileName(p) {
  if (typeof p !== 'string') return null;
  const name = p.split(/[\\/]/).filter(Boolean).pop();
  if (!name || name.length > FILE_NAME_MAX || CONTROL_RE.test(name)) { CONTROL_RE.lastIndex = 0; return null; }
  CONTROL_RE.lastIndex = 0;
  if (SECRET_NAME_RES.some((re) => re.test(name))) return null;
  if (maskSecrets(name) !== name) return null;
  return name;
}

const SYSTEM_BASE =
  'You write ONE short joke line (under 70 characters) that a cartoon character on a dashboard says out loud, in the first person ' +
  '("I", never its own name). The line is decoration: a joke or a mood. ' +
  'Never say or claim that anything was done, fixed, found, passed or finished, never describe the real work, and never state a result. ' +
  'No quotes, no hashtags, no file paths, no links. Reply with one line and nothing else.';

function systemFor(agent, voice) {
  if (!voice || (!voice.description && !voice.signOff)) return `${SYSTEM_BASE}\nUse a neutral, friendly voice in English.`;
  const desc = voice.description ? ` Who it is: ${maskSecrets(oneLine(voice.description))}.` : '';
  const sign = voice.signOff ? ` Its habit: ${maskSecrets(oneLine(voice.signOff))}` : '';
  return `${SYSTEM_BASE}\nThe character is "${agent}".${desc}${sign}\nWrite in its voice and in the language it uses.`;
}

function buildPrompt(input) {
  if (!input || typeof input !== 'object') return null;
  const agent = typeof input.agent === 'string' ? cap(oneLine(input.agent), NAME_MAX) : '';
  if (!agent || !STATES.has(input.state)) return null;
  const lines = [`Character: ${agent}`, `State: ${input.state}`];
  if (typeof input.tool === 'string' && /^[A-Za-z0-9_:.-]{1,40}$/.test(input.tool)) lines.push(`Tool: ${input.tool}`);
  const files = (Array.isArray(input.files) ? input.files : []).map(safeFileName).filter((f) => f !== null).slice(0, FILES_MAX);
  if (files.length) lines.push(`Files: ${files.join(', ')}`);
  const task = typeof input.task === 'string' ? cap(maskSecrets(oneLine(input.task)), TASK_MAX) : '';
  if (task) lines.push(`Task: ${task}`);
  lines.push('Write the joke line now.');
  return { system: systemFor(agent, input.voice), prompt: lines.join('\n') };
}

// A bubble never claims the work went one way or the other. The prompt asks; a 4B model doesn't always listen (measured:
// "I just spotted a null pointer"), so a line that SAYS something was found, fixed or finished is dropped rather than shown.
const CLAIM_RE = /\b(fixed|found|saw|noticed|discovered|detected|admitted|spotted|solved|pass|passed|passes|merged|deployed|shipped|finished|completed|resolved|caught|killed|done|survived|all green)\b/i;

/** One short line from a model's reply, or null when there is nothing usable (empty, code, a link, a path). */
function cleanLine(reply) {
  if (typeof reply !== 'string') return null;
  const text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  if (text.includes('```')) return null;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (!first) return null;
  const line = oneLine(first.replace(/^[-*•]\s+/, '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, ''));
  if (!line) return null;
  if (/https?:\/\//i.test(line) || /[A-Za-z]:\\/.test(line) || /(^|\s)\/[\w.-]+\/[\w.-]/.test(line)) return null;
  if (CLAIM_RE.test(line)) return null;
  const chars = [...line];
  if (chars.length <= LINE_MAX) return line;
  // Cut at a word when there is one in the second half of the allowance, so a joke doesn't end mid-word.
  const head = chars.slice(0, LINE_MAX - 1).join('');
  const space = head.lastIndexOf(' ');
  const out = (space >= LINE_MAX / 2 ? head.slice(0, space) : head).trimEnd() + '…';
  return out.trim() === '…' ? null : out;
}

const SIGN_OFF_RE = /\b(sign(?:s|ed)?[- ]?off|closing line|end (?:every|each|all|your)\b[^.\n]{0,40}\bwith|always end)|l[ií]nea final|despedida/i;

/** { description, signOff } from an agent's .md text, or null when it offers neither. */
function voiceFromMd(raw) {
  if (typeof raw !== 'string') return null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!fm) return null;
  // Lazy: roster-index drags in the transcript readers, which a bubble's tests and a renderer never need.
  const { descriptionFromFrontmatter } = require('./roster-index');
  const description = cap(oneLine(descriptionFromFrontmatter(raw)), DESCRIPTION_MAX);
  const body = raw.slice(fm[0].length).split(/\r?\n/);
  const at = body.findIndex((l) => SIGN_OFF_RE.test(l));
  // A heading ("## Mandatory sign-off") names the section: the instruction is the lines under it, up to the next heading.
  const picked = [];
  if (at >= 0) {
    if (/^\s*#{1,6}\s/.test(body[at])) {
      for (let i = at + 1; i < body.length && picked.length < 2 && !/^\s*#{1,6}\s/.test(body[i]); i++) if (body[i].trim()) picked.push(body[i]);
    } else picked.push(body[at]);
  }
  const signOff = cap(oneLine(picked.join(' ').replace(/^[\s>*#-]+/, '').replace(/\*\*/g, '')), SIGN_OFF_MAX);
  if (!description && !signOff) return null;
  return { description, signOff: signOff || null };
}

module.exports = { buildPrompt, cleanLine, voiceFromMd, maskSecrets, safeFileName, STATES, LINE_MAX, TASK_MAX };
