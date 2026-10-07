'use strict';
/**
 * Skill discovery for the wand (backlog #51): the list of skills comes from the CLI's own skill
 * directories, never from a hand-typed list. Fixture directories, no mocks of fs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { parseFrontmatter, discoverSkills, SKILL_NAME } = require('../host/wand-skills');

function tree(files) {
  const root = tmpDir('wand-skills-');
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}
const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# body\n`;

test('frontmatter: name and description, plain', () => {
  assert.deepStrictEqual(parseFrontmatter(skill('checkpoint', 'End a chunk of work.')),
    { name: 'checkpoint', description: 'End a chunk of work.' });
});

test('frontmatter: quoted values lose their quotes, and a colon inside a quoted value survives', () => {
  const text = '---\nname: "bedtime"\ndescription: \'Overnight: run it.\'\n---\n';
  assert.deepStrictEqual(parseFrontmatter(text), { name: 'bedtime', description: 'Overnight: run it.' });
});

test('frontmatter: a folded or literal block scalar is joined into one line', () => {
  const folded = '---\nname: x\ndescription: >\n  first line\n  second line\n---\n';
  assert.strictEqual(parseFrontmatter(folded).description, 'first line second line');
  const literal = '---\nname: x\ndescription: |\n  first\n  second\n---\n';
  assert.strictEqual(parseFrontmatter(literal).description, 'first second');
});

test('frontmatter: CRLF files parse the same', () => {
  const text = '---\r\nname: crlf\r\ndescription: windows\r\n---\r\nbody';
  assert.deepStrictEqual(parseFrontmatter(text), { name: 'crlf', description: 'windows' });
});

test('frontmatter: no block, or an unclosed one, is null; a missing field is undefined, not ""', () => {
  assert.strictEqual(parseFrontmatter('# just markdown'), null);
  assert.strictEqual(parseFrontmatter('---\nname: x\nno end'), null);
  assert.deepStrictEqual(parseFrontmatter('---\ndescription: d\n---\n'), { name: undefined, description: 'd' });
  assert.strictEqual(parseFrontmatter(undefined), null);
  assert.strictEqual(parseFrontmatter(42), null);
});

test('frontmatter: only the first block counts, and keys after the closing --- are ignored', () => {
  const text = '---\nname: a\n---\nname: b\n---\n';
  assert.strictEqual(parseFrontmatter(text).name, 'a');
});

test('discovery: user, project and plugin skills, each with its source', () => {
  const home = tree({
    'skills/checkpoint/SKILL.md': skill('checkpoint', 'Wrap up.'),
    'skills/merged/SKILL.md': skill('merged', 'After a merge.'),
    'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'vercel@market': [{ scope: 'user', installPath: '__PLUGIN__' }] } }),
  });
  const plugin = tree({ 'skills/deploy/SKILL.md': skill('deploy', 'Ship it.') });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'vercel@market': [{ scope: 'user', installPath: plugin }] } }));
  const project = tree({ '.claude/skills/local-thing/SKILL.md': skill('local-thing', 'Only here.') });

  const { skills, skipped } = discoverSkills({ claudeHome: home, projectDir: project });
  const byName = Object.fromEntries(skills.map(s => [s.name, s]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['checkpoint', 'local-thing', 'merged', 'vercel:deploy']);
  assert.strictEqual(byName.checkpoint.source, 'user');
  assert.strictEqual(byName.checkpoint.description, 'Wrap up.');
  assert.strictEqual(byName['local-thing'].source, 'project');
  assert.strictEqual(byName['vercel:deploy'].source, 'plugin');
  assert.strictEqual(byName['vercel:deploy'].description, 'Ship it.');
  assert.deepStrictEqual(skipped, []);
});

test('discovery: the list is sorted by name, so the picker is stable', () => {
  const home = tree({
    'skills/zeta/SKILL.md': skill('zeta', 'z'),
    'skills/alpha/SKILL.md': skill('alpha', 'a'),
    'skills/mid/SKILL.md': skill('mid', 'm'),
  });
  const { skills } = discoverSkills({ claudeHome: home, projectDir: null });
  assert.deepStrictEqual(skills.map(s => s.name), ['alpha', 'mid', 'zeta']);
});

test('discovery: a SKILL.md without a name is skipped AND logged, never guessed from the folder', () => {
  const home = tree({
    'skills/nameless/SKILL.md': '---\ndescription: no name here\n---\n',
    'skills/plain/SKILL.md': '# no frontmatter at all',
    'skills/good/SKILL.md': skill('good', 'ok'),
  });
  const logged = [];
  const { skills, skipped } = discoverSkills({ claudeHome: home, projectDir: null, log: l => logged.push(l) });
  assert.deepStrictEqual(skills.map(s => s.name), ['good']);
  assert.strictEqual(skipped.length, 2);
  assert.ok(skipped.every(s => /name/i.test(s.reason)), JSON.stringify(skipped));
  assert.strictEqual(logged.length, 2);
  assert.ok(logged.every(l => /wand/.test(l) && /SKILL\.md/.test(l)), logged.join('\n'));
});

test('discovery: a name that can never be typed as a slash command is skipped and logged', () => {
  const home = tree({
    'skills/a/SKILL.md': skill('has space', 'x'),
    'skills/b/SKILL.md': skill('dotted.name', 'x'),
    'skills/c/SKILL.md': skill('fine_name-2', 'x'),
  });
  const logged = [];
  const { skills, skipped } = discoverSkills({ claudeHome: home, projectDir: null, log: l => logged.push(l) });
  assert.deepStrictEqual(skills.map(s => s.name), ['fine_name-2']);
  assert.strictEqual(skipped.length, 2);
  assert.strictEqual(logged.length, 2);
});

test('SKILL_NAME is exactly what the terminal typing path accepts', () => {
  const { planTyping } = require('../app/top-bar-display');
  for (const name of ['a', 'checkpoint', 'plug:skill', 'x_y-z', 'A1']) {
    assert.ok(SKILL_NAME.test(name), name);
    assert.ok(planTyping({ command: `/${name}`, screen: 'ready', connected: true }).ok, name);
  }
  for (const name of ['', ' ', 'a b', 'a.b', '-a', ':a', 'a/b', 'a\nb', '__proto__x'.repeat(20)]) {
    assert.ok(!SKILL_NAME.test(name), JSON.stringify(name));
  }
});

test('discovery: a project skill of the same name beats the user skill; the user one is not listed twice', () => {
  const home = tree({ 'skills/dup/SKILL.md': skill('dup', 'user copy') });
  const project = tree({ '.claude/skills/dup/SKILL.md': skill('dup', 'project copy') });
  const { skills } = discoverSkills({ claudeHome: home, projectDir: project });
  assert.strictEqual(skills.length, 1);
  assert.strictEqual(skills[0].source, 'project');
  assert.strictEqual(skills[0].description, 'project copy');
});

test('discovery: a missing skills folder, plugin file or project is simply empty, not an error', () => {
  const home = tree({ 'unrelated.txt': 'x' });
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: path.join(home, 'nope') }),
    { skills: [], skipped: [], unread: [] });
  assert.deepStrictEqual(discoverSkills({}), { skills: [], skipped: [], unread: [] });
});

test('discovery: a damaged installed_plugins.json is logged once and the other sources still list', () => {
  const home = tree({
    'skills/ok/SKILL.md': skill('ok', 'fine'),
    'plugins/installed_plugins.json': '{ not json',
  });
  const logged = [];
  const { skills } = discoverSkills({ claudeHome: home, projectDir: null, log: l => logged.push(l) });
  assert.deepStrictEqual(skills.map(s => s.name), ['ok']);
  assert.strictEqual(logged.length, 1);
  assert.match(logged[0], /installed_plugins\.json/);
});

test('discovery: a plugin whose install path is gone is skipped quietly', () => {
  const home = tree({
    'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'gone@m': [{ installPath: path.join(os.tmpdir(), 'wand-no-such-plugin-dir') }] } }),
  });
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null }), { skills: [], skipped: [], unread: [] });
});

test('discovery: a plugin install listed twice (two scopes) lists its skills once', () => {
  const plugin = tree({ 'skills/deploy/SKILL.md': skill('deploy', 'Ship it.') });
  const home = tree({ 'x': '' });
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'vercel@m': [{ scope: 'user', installPath: plugin }, { scope: 'project', installPath: plugin }] },
  }));
  const { skills } = discoverSkills({ claudeHome: home, projectDir: null });
  assert.deepStrictEqual(skills.map(s => s.name), ['vercel:deploy']);
});

test('discovery: a folder with no SKILL.md is ignored without a log line', () => {
  const home = tree({ 'skills/empty/README.md': 'hi', 'skills/real/SKILL.md': skill('real', 'r') });
  const logged = [];
  const { skills } = discoverSkills({ claudeHome: home, projectDir: null, log: l => logged.push(l) });
  assert.deepStrictEqual(skills.map(s => s.name), ['real']);
  assert.deepStrictEqual(logged, []);
});

test('discovery: a description is trimmed and capped, and a missing one is "" (shown, not invented)', () => {
  const home = tree({
    'skills/long/SKILL.md': skill('long', 'x'.repeat(2000)),
    'skills/bare/SKILL.md': '---\nname: bare\n---\n',
  });
  const { skills } = discoverSkills({ claudeHome: home, projectDir: null });
  const long = skills.find(s => s.name === 'long');
  const bare = skills.find(s => s.name === 'bare');
  assert.ok(long.description.length <= 400 && long.description.endsWith('…'), String(long.description.length));
  assert.strictEqual(bare.description, '');
});

// --- Dexter D1: "could not look" is not "no such skill" --------------------------------------------

const code = (c) => Object.assign(new Error(c), { code: c });
const realFs = require('fs');
const faulty = (fail) => new Proxy(realFs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { const e = fail(String(k), a); if (e) throw e; return t[k](...a); } : t[k]) });

test('D1: a skills folder that exists but cannot be listed (EPERM) is UNREAD, never just absent', () => {
  const home = tree({ 'skills/bedtime/SKILL.md': skill('bedtime', 'x') });
  const fs2 = faulty((fn, a) => (fn === 'readdirSync' && String(a[0]).endsWith('skills') ? code('EPERM') : null));
  const r = discoverSkills({ claudeHome: home, projectDir: null, fs: fs2 });
  assert.strictEqual(r.unread.length, 1);
  assert.match(r.unread[0].reason, /EPERM/);
  assert.match(r.unread[0].file, /skills/);
});

test('D1: a SKILL.md that cannot be read (EBUSY) is unread, and the others still list', () => {
  const home = tree({ 'skills/a/SKILL.md': skill('a', 'x'), 'skills/b/SKILL.md': skill('b', 'y') });
  const fs2 = faulty((fn, a) => (fn === 'readFileSync' && /[\\/]a[\\/]SKILL\.md$/.test(String(a[0])) ? code('EBUSY') : null));
  const r = discoverSkills({ claudeHome: home, projectDir: null, fs: fs2 });
  assert.deepStrictEqual(r.skills.map(s => s.name), ['b']);
  assert.strictEqual(r.unread.length, 1);
  assert.match(r.unread[0].reason, /EBUSY/);
});

test('D1: a skill folder whose stat fails (not ENOENT) is unread; ENOENT and ENOTDIR are simply absent', () => {
  const home = tree({ 'skills/a/SKILL.md': skill('a', 'x') });
  const bad = faulty((fn, a) => (fn === 'statSync' && /[\\/]a$/.test(String(a[0])) ? code('EACCES') : null));
  assert.strictEqual(discoverSkills({ claudeHome: home, projectDir: null, fs: bad }).unread.length, 1);
  const gone = faulty((fn, a) => (fn === 'readdirSync' && String(a[0]).endsWith('skills') ? code('ENOENT') : null));
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null, fs: gone }).unread, []);
  const notdir = faulty((fn, a) => (fn === 'readdirSync' && String(a[0]).endsWith('skills') ? code('ENOTDIR') : null));
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null, fs: notdir }).unread, []);
});

test('D1: a damaged or unreadable installed_plugins.json is unread, so plugin favourites are not dimmed', () => {
  const damaged = tree({ 'plugins/installed_plugins.json': '{ nope' });
  assert.strictEqual(discoverSkills({ claudeHome: damaged, projectDir: null }).unread.length, 1);
  const home = tree({ 'plugins/installed_plugins.json': '{}' });
  const fs2 = faulty((fn, a) => (fn === 'readFileSync' && String(a[0]).endsWith('installed_plugins.json') ? code('EBUSY') : null));
  const r = discoverSkills({ claudeHome: home, projectDir: null, fs: fs2 });
  assert.match(r.unread[0].reason, /EBUSY/);
  // a missing registry is just "no plugins"
  assert.deepStrictEqual(discoverSkills({ claudeHome: tree({ x: '' }), projectDir: null }).unread, []);
});

// --- Dexter D10: a plugin the CLI will not load is not a skill; long prefixed names are fine ----------------

function pluginHome(plugins, settings, installs) {
  const files = {};
  if (settings !== undefined) files['settings.json'] = JSON.stringify(settings);
  const home = tree(files);
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installs }));
  return home;
}

test('D10: a plugin disabled in settings.json (enabledPlugins: false) lists no skills; an enabled or unlisted one does', () => {
  const off = tree({ 'skills/deploy/SKILL.md': skill('deploy', 'x') });
  const on = tree({ 'skills/review/SKILL.md': skill('review', 'x') });
  const home = pluginHome(null, { enabledPlugins: { 'off@m': false, 'on@m': true } }, { 'off@m': [{ installPath: off }], 'on@m': [{ installPath: on }] });
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null }).skills.map(s => s.name), ['on:review']);
  const unlisted = pluginHome(null, {}, { 'off@m': [{ installPath: off }] });
  assert.deepStrictEqual(discoverSkills({ claudeHome: unlisted, projectDir: null }).skills.map(s => s.name), ['off:deploy']);
});

test('D10: an install scoped to ANOTHER project is not listed here; to this project, or the user, it is', () => {
  const p = tree({ 'skills/s/SKILL.md': skill('s', 'x') });
  const here = tree({ x: '' });
  const other = tree({ x: '' });
  const home = pluginHome(null, undefined, {
    'a@m': [{ scope: 'project', projectPath: other, installPath: p }],
    'b@m': [{ scope: 'project', projectPath: here, installPath: p }],
    'c@m': [{ scope: 'user', installPath: p }],
  });
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: here }).skills.map(s => s.name), ['b:s', 'c:s']);
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null }).skills.map(s => s.name), ['c:s'], 'no project: a project-scoped install cannot apply');
});

test('D10: a long plugin prefix plus a long skill name is listed (the cap is generous, not 64)', () => {
  const longSkill = 'responsive-layout-accessibility-audit-helper';
  const p = tree({ [`skills/${longSkill}/SKILL.md`]: skill(longSkill, 'x') });
  const home = pluginHome(null, undefined, { 'frontend-design-toolkit@m': [{ installPath: p }] });
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null }).skills.map(s => s.name), ['frontend-design-toolkit:' + longSkill]);
  assert.ok(SKILL_NAME.test('a'.repeat(128)) && !SKILL_NAME.test('a'.repeat(129)));
});

test('D10: an unreadable settings.json is unread (so a plugin favourite is not dimmed), a missing one is fine', () => {
  const p = tree({ 'skills/s/SKILL.md': skill('s', 'x') });
  const bad = pluginHome(null, undefined, { 'a@m': [{ installPath: p }] });
  fs.writeFileSync(path.join(bad, 'settings.json'), '{ nope');
  assert.strictEqual(discoverSkills({ claudeHome: bad, projectDir: null }).unread.length, 1);
  const none = pluginHome(null, undefined, { 'a@m': [{ installPath: p }] });
  assert.deepStrictEqual(discoverSkills({ claudeHome: none, projectDir: null }).unread, []);
});

// --- Miguel S1: the CLI's own config dir -------------------------------------------------------------------

test('S1: the claude home is the probe seam, else CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  const { claudeHomeOf } = require('../host/wand-skills');
  const home = path.join(os.tmpdir(), 'h');
  assert.strictEqual(claudeHomeOf({ seam: 'S', env: { CLAUDE_CONFIG_DIR: 'C' }, home }), 'S');
  const abs = path.join(os.tmpdir(), 'cfg-abs');
  assert.strictEqual(claudeHomeOf({ seam: null, env: { CLAUDE_CONFIG_DIR: abs }, home }), abs);
  assert.strictEqual(claudeHomeOf({ seam: null, env: { CLAUDE_CONFIG_DIR: '' }, home }), path.join(home, '.claude'));
  assert.strictEqual(claudeHomeOf({ seam: null, env: {}, home }), path.join(home, '.claude'));
  // no env key at all means NO env, whatever the runner's own CLAUDE_CONFIG_DIR is (hermetic)
  assert.strictEqual(claudeHomeOf({ home }), path.join(home, '.claude'));
});

// --- Miguel S3: only a SKILL.md, or a skill folder appearing, is worth a rescan -------------------------------

test('S3: a rescan is worth it for a SKILL.md or a top-level entry, not for a file a skill wrote', () => {
  const { isSkillEvent } = require('../host/wand-skills');
  for (const yes of ['SKILL.md', 'bedtime/SKILL.md', 'bedtime\\SKILL.md', 'a/b/skill.md', 'bedtime', 'new-skill', 'installed_plugins.json']) assert.ok(isSkillEvent(yes), yes);
  for (const no of ['bedtime/scratch.log', 'bedtime\\notes.txt', 'bedtime/refs/a.md', 'bedtime/out.json']) assert.ok(!isSkillEvent(no), no);
});
