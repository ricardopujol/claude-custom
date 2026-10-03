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
  for (const name of ['', ' ', 'a b', 'a.b', '-a', ':a', 'a/b', 'a\nb', '__proto__x'.repeat(10)]) {
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
    { skills: [], skipped: [] });
  assert.deepStrictEqual(discoverSkills({}), { skills: [], skipped: [] });
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
  assert.deepStrictEqual(discoverSkills({ claudeHome: home, projectDir: null }), { skills: [], skipped: [] });
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
