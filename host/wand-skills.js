'use strict';
/**
 * Skill discovery for the wand (BACKLOG #51): which skills exist, read from the CLI's OWN skill
 * directories -- never from a list somebody typed, which would rot the day a skill is renamed.
 *
 *   <claudeHome>/skills/<dir>/SKILL.md           user skills             /name
 *   <projectDir>/.claude/skills/<dir>/SKILL.md   this project's skills   /name
 *   <installPath>/skills/<dir>/SKILL.md          an installed plugin's   /plugin:name
 *       (installPath comes from <claudeHome>/plugins/installed_plugins.json)
 *
 * The name and description are the SKILL.md frontmatter's. A SKILL.md with no `name` is SKIPPED AND
 * LOGGED, not given its folder's name: a guessed name is a button that types a command the CLI may
 * not know (DESIGN_WAND.md, Tests). The same goes for a name that can never be typed as a one-line
 * slash command (app/top-bar-display.js SLASH_COMMAND is the typing path's own rule, and SKILL_NAME
 * is pinned to it by a test).
 *
 * A project skill of the same name beats the user one (nearest wins), so the picker never lists one
 * invocation twice. Missing folders and a missing plugin file are simply empty; a DAMAGED plugin file
 * is logged once and the other sources still list.
 *
 * Synchronous and small (a few dozen files): the host calls it on a module open and on a debounced
 * watch, never on a hot path. `fs` is injectable for the same reason as everywhere in host/.
 */

const nodeFs = require('fs');
const path = require('path');

// The terminal typing path accepts /[A-Za-z0-9:_-]+ (app/top-bar-display.js). A leading letter or
// digit keeps `-x` (an option) and `:x` out; 64 is the same ceiling host/loadout.js puts on names.
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const DESCRIPTION_CAP = 400;

const isStr = (x) => typeof x === 'string';
const unquote = (v) => {
  const m = /^(["'])([\s\S]*)\1$/.exec(v);
  return m ? m[2] : v;
};

/**
 * `{ name, description }` from a SKILL.md's leading `---` block, or null when there is no (closed)
 * block. A field that is absent is `undefined`, never ''. Plain, quoted, folded (`>`) and literal
 * (`|`) values are all joined into one line; nothing else of YAML is understood, on purpose.
 */
function parseFrontmatter(text) {
  if (!isStr(text)) return null;
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end === -1) return null;

  const fields = {};
  let key = null;
  for (const raw of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(raw);
    if (m) {
      key = m[1];
      const v = m[2].trim();
      fields[key] = /^[>|][+-]?$/.test(v) ? [] : [unquote(v)];
    } else if (key && /^\s+\S/.test(raw)) {
      fields[key].push(raw.trim());
    } else if (raw.trim() !== '' && !/^\s/.test(raw)) {
      key = null;
    }
  }
  const field = (k) => {
    if (!fields[k]) return undefined;
    const v = fields[k].filter(s => s !== '').join(' ').replace(/\s+/g, ' ').trim();
    return v === '' ? undefined : v;
  };
  return { name: field('name'), description: field('description') };
}

const capDescription = (d) => {
  if (!isStr(d)) return '';
  const t = d.trim();
  return t.length <= DESCRIPTION_CAP ? t : `${t.slice(0, DESCRIPTION_CAP - 1)}…`;
};

function discoverSkills({ claudeHome, projectDir, fs = nodeFs, log = () => {} } = {}) {
  const skipped = [];
  // Places that EXIST but could not be looked at (EPERM, EBUSY, a damaged plugin list). Absent is not unread:
  // ENOENT / ENOTDIR mean there is nothing there. The caller must never read an unread place as "no such
  // skill" (Dexter D1): wand-control turns any of these into skillsError, and the panel dims nothing.
  const unread = [];
  const gone = (err) => !!err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
  const noteUnread = (file, err) => {
    if (gone(err)) return;
    unread.push({ file, reason: `could not read (${(err && (err.code || err.message)) || 'unknown'})` });
  };
  const found = new Map();      // invocation name -> skill; later sources replace earlier

  const skip = (file, reason) => {
    skipped.push({ file, reason });
    log(`[wand] skipped ${file}: ${reason}`);
  };

  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (err) { noteUnread(p, err); return false; } };

  function scan(skillsDir, source, prefix) {
    let entries;
    try { entries = fs.readdirSync(skillsDir); } catch (err) { noteUnread(skillsDir, err); return; }   // no folder: nothing to list
    for (const entry of entries) {
      const dir = path.join(skillsDir, entry);
      const file = path.join(dir, 'SKILL.md');
      if (!isDir(dir)) continue;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
        noteUnread(file, err);
        continue;
      }
      const fm = parseFrontmatter(text);
      if (!fm || fm.name === undefined) { skip(file, 'SKILL.md has no name in its frontmatter'); continue; }
      const name = prefix ? `${prefix}:${fm.name}` : fm.name;
      if (!SKILL_NAME.test(name)) { skip(file, `SKILL.md name "${fm.name}" can't be typed as a slash command`); continue; }
      found.set(name, { name, description: capDescription(fm.description), source });
    }
  }

  if (isStr(claudeHome) && claudeHome) {
    scan(path.join(claudeHome, 'skills'), 'user', null);

    const registry = path.join(claudeHome, 'plugins', 'installed_plugins.json');
    let text = null;
    try { text = fs.readFileSync(registry, 'utf8'); } catch (err) { noteUnread(registry, err); /* ENOENT: no plugins installed */ }
    if (text !== null) {
      let plugins = null;
      try { plugins = JSON.parse(text).plugins; } catch { /* reported below */ }
      if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
        log(`[wand] could not read ${registry}: not a plugin list; plugin skills are not listed`);
        unread.push({ file: registry, reason: 'could not read (not a plugin list)' });
      } else {
        const seen = new Set();
        for (const key of Object.keys(plugins)) {
          const plugin = key.split('@')[0];
          const installs = Array.isArray(plugins[key]) ? plugins[key] : [plugins[key]];
          for (const inst of installs) {
            const where = inst && isStr(inst.installPath) ? inst.installPath : null;
            if (!where || seen.has(`${plugin}|${where}`)) continue;
            seen.add(`${plugin}|${where}`);
            scan(path.join(where, 'skills'), 'plugin', plugin);
          }
        }
      }
    }
  }
  if (isStr(projectDir) && projectDir) scan(path.join(projectDir, '.claude', 'skills'), 'project', null);

  const skills = [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, skipped, unread };
}

module.exports = { parseFrontmatter, discoverSkills, SKILL_NAME, DESCRIPTION_CAP };
