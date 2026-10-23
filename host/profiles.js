'use strict';
/**
 * Account profiles (BACKLOG #119 A1): run any tab under a chosen Claude account.
 *
 * A profile is `{ id, name, configDir, colour }`. For a wrapper that is all it takes: the CLI keeps credentials, transcripts, settings,
 * agents and sessions per CLAUDE_CONFIG_DIR (host/claude-config-dir.js), so a tab started with another dir IS another account. Nothing is
 * ever copied between accounts, and this file never deletes a folder.
 *
 *   ~/.claude-custom/profiles.json        { version: 1, profiles: [{ id, name, configDir, colour }] }   machine-wide
 *   ~/.claude-custom/profile-choices.json { version: 1, byWorktree: { <normPath>: id }, byProject: { <normPath>: id } }
 *
 * The built-in profile `default` is never stored: it has no configDir, meaning "leave CLAUDE_CONFIG_DIR as the launching shell had it".
 * `configDirFor` answers null for it (and for an id that no longer exists), so a removed profile degrades to the default, never to a
 * dangling folder.
 *
 * Reads say `missing`, `bad` or `ok`, and a `bad` file is never read as empty: the caller must not write over what it could not read
 * (the same rule as host/tab-marks). Entries are strict (`typeof`, never coercing); a hand-edited entry that fails validation is dropped
 * on its own, the others survive. Writes are temp file + rename (host/atomic-write.js).
 *
 * KNOWN LIMIT (same as host/store.js): an edit is read, changed, written. Two windows editing within the same few milliseconds can lose
 * one of the two edits; the file is never torn, and an edit that could not read the file is refused rather than written over it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { claudeConfigDir } = require('./claude-config-dir');

const DEFAULT_ID = 'default';
const NAME_MAX = 40;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const VERSION = 1;

const isString = (v) => typeof v === 'string';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * A folder's canonical identity for comparing accounts: the REAL path of its deepest existing ancestor (junctions, symlinks and 8.3 short names
 * resolve to the same thing) plus the not-yet-existing rest, case-folded where the OS is. Two spellings of one folder must compare equal (Dexter r2 N4).
 */
function dirKey(d) {
  const full = path.resolve(d);
  let head = full;
  const rest = [];
  for (;;) {
    try { head = fs.realpathSync.native(head); break; } catch { /* not there yet: try its parent */ }
    const parent = path.dirname(head);
    if (parent === head) break;
    rest.unshift(path.basename(head));
    head = parent;
  }
  const joined = path.join(head, ...rest);
  return process.platform === 'win32' ? joined.toLowerCase() : joined;
}
/** Is `child` strictly inside `parent`? Compared by path SEGMENTS, not string prefixes (a folder called "..w" is not "up"). */
const inside = (child, parent) => {
  const c = dirKey(child).split(path.sep).filter(Boolean);
  const p = dirKey(parent).split(path.sep).filter(Boolean);
  return c.length > p.length && p.every((seg, i) => c[i] === seg);
};

function defaultDir() { return path.join(os.homedir(), '.claude-custom'); }
const profilesFile = (dir = defaultDir()) => path.join(dir, 'profiles.json');
const choicesFile = (dir = defaultDir()) => path.join(dir, 'profile-choices.json');

/** The built-in profile. `colour` is null: the header draws it in the theme's own colour. */
const DEFAULT_PROFILE = Object.freeze({ id: DEFAULT_ID, name: 'Default', configDir: null, colour: null });

/**
 * Why `dir` can't be a profile folder, or null. It is made (mkdir) and opened by main, so what it names must be a plain local folder:
 * never UNC (\\server\share: touching it sends the person's credentials to that server, the class app/file-link.js refuses), never a
 * device path (\\?\ and \\.\), never a drive's root, never an alternate data stream, never a name ending in a dot or space. On Windows
 * it needs a drive letter: \claude-work resolves against whatever drive the process happens to be on. `platform` is a seam for tests.
 */
function folderProblem(dir, platform = process.platform) {
  if (!isString(dir) || dir === '' || dir.includes('\0')) return 'folder must be an absolute path';
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(dir)) return 'a network (UNC) or device path can\'t be a profile folder';
    if (!/^[A-Za-z]:[\\/]/.test(dir)) return 'folder must start with a drive letter, like C:\\';
    const rest = dir.slice(2);
    if (rest.includes(':')) return 'folder must not contain a colon after the drive';
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return 'a drive\'s root can\'t be a profile folder';
    if (parts.some(s => /[. ]$/.test(s))) return 'folder names must not end in a dot or a space';
    return null;
  }
  if (!path.isAbsolute(dir)) return 'folder must be an absolute path';
  if (path.resolve(dir) === path.parse(path.resolve(dir)).root) return 'the root folder can\'t be a profile folder';
  return null;
}

/** null when the profile is fine, else a sentence saying what is wrong. */
function validateProfile(p) {
  if (!isPlainObject(p)) return 'a profile must be an object';
  if (!isString(p.id) || p.id === DEFAULT_ID || !ID_RE.test(p.id)) return 'bad id (lowercase letters, digits and dashes; "default" is reserved)';
  if (!isString(p.name) || p.name.trim() === '' || p.name.trim().length > NAME_MAX) return `name must be 1-${NAME_MAX} characters`;
  const bad = folderProblem(p.configDir);
  if (bad) return bad;
  if (!isString(p.colour) || !HEX_RE.test(p.colour)) return 'colour must be #rgb or #rrggbb';
  return null;
}

function cleanProfile(p) {
  const c = p.colour.toLowerCase();
  const colour = c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
  return { id: p.id, name: p.name.trim(), configDir: p.configDir, colour };
}

/** `{ state: 'missing' }` | `{ state: 'bad' }` | `{ state: 'ok', store }`; never throws. */
function parseStore(text) {
  if (text === null || text === undefined) return { state: 'missing' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { state: 'bad' }; }
  if (!isPlainObject(doc) || doc.version !== VERSION || !Array.isArray(doc.profiles)) return { state: 'bad' };
  const seenIds = new Set();
  const seenDirs = new Set();
  const profiles = [];
  for (const raw of doc.profiles) {
    if (validateProfile(raw) !== null) continue;
    const p = cleanProfile(raw);
    const dk = dirKey(p.configDir);
    if (seenIds.has(p.id) || seenDirs.has(dk)) continue;
    seenIds.add(p.id);
    seenDirs.add(dk);
    profiles.push(p);
  }
  return { state: 'ok', store: { version: VERSION, profiles } };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return undefined;          // unreadable right now: not "missing"
  }
}

function readProfiles(file = profilesFile()) {
  const text = readText(file);
  if (text === undefined) return { state: 'bad' };
  return parseStore(text);
}

/** Throws on an invalid store (nothing written) or a failed write; the caller reports it. */
function writeProfiles(file, store) {
  if (!isPlainObject(store) || !Array.isArray(store.profiles)) throw new Error('profiles: not a store');
  for (const p of store.profiles) {
    const why = validateProfile(p);
    if (why) throw new Error(`profiles: ${why} (${isPlainObject(p) ? String(p.id) : typeof p})`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ version: VERSION, profiles: store.profiles.map(cleanProfile) }, null, 2)}\n`);
}

/** The default first, then the stored profiles. A missing store is just the default. */
function listProfiles(store) {
  const stored = store && Array.isArray(store.profiles) ? store.profiles : [];
  return [DEFAULT_PROFILE, ...stored];
}

function findProfile(store, id) {
  if (!isString(id)) return null;
  return listProfiles(store).find(p => p.id === id) || null;
}

/** The profile's folder, or null: the default, an unknown id and a non-string all leave CLAUDE_CONFIG_DIR alone. */
function configDirFor(store, id) {
  const p = findProfile(store, id);
  return p && isString(p.configDir) ? p.configDir : null;
}

function slugOf(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
  return s === '' || s === DEFAULT_ID ? 'profile' : s;
}

/**
 * An id is the name's slug plus 6 random hex digits and is NEVER recycled: the default folder is named after the id, so a removed "Work"
 * (its folder kept, still holding its credentials) and a new "Work" must not share one. `random` is a seam for tests.
 */
function uniqueId(store, name, random = () => require('crypto').randomBytes(3).toString('hex')) {
  const base = slugOf(name).slice(0, 20).replace(/-+$/g, '') || 'profile';
  const taken = new Set(listProfiles(store).map(p => p.id));
  for (;;) {
    const id = `${base}-${random()}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Add a profile. `spec` is `{ name, colour, configDir? }`; the folder defaults to `<home>/.claude-profiles/<id>`.
 * -> `{ store, profile }` or `{ error }`. The folder is not created here: the CLI makes it on its first `/login`.
 */
function addProfile(store, spec, { home = os.homedir(), defaultDirs = [], random } = {}) {
  const base = store && Array.isArray(store.profiles) ? store : { version: VERSION, profiles: [] };
  const name = spec && isString(spec.name) ? spec.name.trim() : '';
  if (name === '' || name.length > NAME_MAX) return { error: `name must be 1-${NAME_MAX} characters` };
  if (!spec || !isString(spec.colour) || !HEX_RE.test(spec.colour)) return { error: 'colour must be #rgb or #rrggbb' };
  const id = uniqueId(base, name, random);
  const wantsDir = spec.configDir !== undefined && spec.configDir !== null && spec.configDir !== '';
  const configDir = wantsDir ? spec.configDir : path.join(home, '.claude-profiles', id);
  const problem = folderProblem(configDir);
  if (problem) return { error: problem };
  // The default account's folder is ~/.claude (the resolver's own answer for "unset") AND whatever CLAUDE_CONFIG_DIR the app was launched
  // with (`defaultDirs`, captured once at startup): both are "the default account". The home folder itself holds the default's
  // global .claude.json, so it is refused too, as is any folder inside or around another account's.
  const defaults = [claudeConfigDir({ env: {}, home }), ...defaultDirs.filter(isString).filter(d => d !== '')];
  if (defaults.some(d => dirKey(configDir) === dirKey(d))) return { error: 'that folder is the default account\'s' };
  if (dirKey(configDir) === dirKey(home)) return { error: 'the home folder can\'t be a profile folder' };
  const others = [...defaults, ...base.profiles.map(p => p.configDir)];
  if (base.profiles.some(p => dirKey(p.configDir) === dirKey(configDir))) return { error: 'another profile already uses that folder' };
  if (others.some(d => inside(configDir, d) || inside(d, configDir))) return { error: 'that folder is inside, or around, another account\'s folder' };
  const profile = cleanProfile({ id, name, configDir, colour: spec.colour });
  const why = validateProfile(profile);
  if (why) return { error: why };
  return { store: { version: VERSION, profiles: [...base.profiles, profile] }, profile };
}

function renameProfile(store, id, name) {
  const p = id === DEFAULT_ID ? null : (store.profiles || []).find(x => x.id === id);
  if (!p) return { error: id === DEFAULT_ID ? 'the default account can\'t be renamed' : 'no such profile' };
  const clean = isString(name) ? name.trim() : '';
  if (clean === '' || clean.length > NAME_MAX) return { error: `name must be 1-${NAME_MAX} characters` };
  return { store: { version: VERSION, profiles: store.profiles.map(x => (x.id === id ? { ...x, name: clean } : x)) } };
}

/** `inUse`: a Set of the ids some tab uses. Removing forgets the entry only; the folder is never touched. */
function removeProfile(store, id, inUse = new Set()) {
  if (id === DEFAULT_ID) return { error: 'the default account can\'t be removed' };
  const p = (store.profiles || []).find(x => x.id === id);
  if (!p) return { error: 'no such profile' };
  if (inUse.has(id)) return { error: `a tab is using ${p.name}; switch it first` };
  return { store: { version: VERSION, profiles: store.profiles.filter(x => x.id !== id) }, removed: p };
}

// --- which profile a tab opens with ----------------------------------------------------------------------------------------

function emptyChoices() { return { version: VERSION, byWorktree: {}, byProject: {} }; }

function onlyStrings(o) {
  const out = {};
  if (!isPlainObject(o)) return out;
  for (const [k, v] of Object.entries(o)) if (isString(v) && v !== '') out[k] = v;
  return out;
}

function parseChoices(text) {
  if (text === null || text === undefined) return { state: 'missing' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { state: 'bad' }; }
  if (!isPlainObject(doc) || doc.version !== VERSION) return { state: 'bad' };
  return { state: 'ok', choices: { version: VERSION, byWorktree: onlyStrings(doc.byWorktree), byProject: onlyStrings(doc.byProject) } };
}

function readChoices(file = choicesFile()) {
  const text = readText(file);
  if (text === undefined) return { state: 'bad' };
  return parseChoices(text);
}

function writeChoices(file, choices) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ version: VERSION, byWorktree: onlyStrings(choices.byWorktree), byProject: onlyStrings(choices.byProject) }, null, 2)}\n`);
}

/**
 * The profile a tab opens with: its own remembered one, else its project's last used, else the default. An id the store no
 * longer has counts as not remembered. `worktree` and `project` are normalised paths (host/project-layout normPath).
 */
function chooseFor(choices, store, { worktree, project } = {}) {
  // A remembered 'default' is a CHOICE (the person picked it), not an absence: it must beat the project's last used. Absence is a missing key.
  const known = (id) => (isString(id) && findProfile(store, id) ? id : null);
  const c = choices && isPlainObject(choices) ? choices : emptyChoices();
  const own = isString(worktree) && c.byWorktree ? known(c.byWorktree[worktree]) : null;
  if (own) return own;
  const last = isString(project) && c.byProject ? known(c.byProject[project]) : null;
  return last || DEFAULT_ID;
}

/** Remember `id` for the worktree and as the project's last used. Returns a new choices object. */
function remember(choices, { worktree, project } = {}, id) {
  const c = choices && isPlainObject(choices) ? choices : emptyChoices();
  const byWorktree = { ...onlyStrings(c.byWorktree) };
  const byProject = { ...onlyStrings(c.byProject) };
  if (isString(id) && id !== '') {
    if (isString(worktree) && worktree !== '') byWorktree[worktree] = id;
    if (isString(project) && project !== '') byProject[project] = id;
  }
  return { version: VERSION, byWorktree, byProject };
}

module.exports = {
  folderProblem, DEFAULT_ID, DEFAULT_PROFILE, NAME_MAX, profilesFile, choicesFile,
  validateProfile, parseStore, readProfiles, writeProfiles, listProfiles, findProfile, configDirFor,
  addProfile, renameProfile, removeProfile,
  emptyChoices, parseChoices, readChoices, writeChoices, chooseFor, remember,
};
