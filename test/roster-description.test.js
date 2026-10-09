'use strict';
/**
 * BACKLOG #76: the persona name and the function line, both read from an agent
 * file's `description:`. Pure parsing, so the shapes seen on a real install are
 * pinned here (quoted, plain, block scalar, "mentions X", "Peter —") and a
 * property test pins "never throws, fn is never empty when the description isn't".
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const {
  descriptionFromFrontmatter, personaFromDescription, functionFromDescription, agentInfo, agentDefinitions,
} = require('../host/roster-index');
const { tmpDir } = require('./tmp-dir');

const fm = (desc) => `---\nname: x\ndescription: ${desc}\n---\nbody`;

test('descriptionFromFrontmatter reads a double-quoted, single-quoted and plain scalar', () => {
  assert.strictEqual(descriptionFromFrontmatter(fm('"Elite reviewer. Say \\"hi\\"."')), 'Elite reviewer. Say "hi".');
  assert.strictEqual(descriptionFromFrontmatter(fm("'It''s a reviewer.'")), "It's a reviewer.");
  assert.strictEqual(descriptionFromFrontmatter(fm('Onboards a repository. More.')), 'Onboards a repository. More.');
});

test('descriptionFromFrontmatter reads a block scalar and a plain multi-line value', () => {
  const folded = '---\nname: x\ndescription: >\n  First line\n  second line.\nmodel: opus\n---\n';
  assert.strictEqual(descriptionFromFrontmatter(folded), 'First line second line.');
  const plain = '---\nname: x\ndescription: First\n  continues here.\ntools: a\n---\n';
  assert.strictEqual(descriptionFromFrontmatter(plain), 'First continues here.');
});

test('descriptionFromFrontmatter answers empty (never null) with no frontmatter, no key, or a non-string', () => {
  assert.strictEqual(descriptionFromFrontmatter('just a body'), '');
  assert.strictEqual(descriptionFromFrontmatter('---\nname: x\n---\n'), '');
  assert.strictEqual(descriptionFromFrontmatter(undefined), '');
  assert.strictEqual(descriptionFromFrontmatter(null), '');
  assert.strictEqual(descriptionFromFrontmatter(42), '');
});

test('personaFromDescription takes the name after "mentions"', () => {
  assert.strictEqual(personaFromDescription('Elite code reviewer. Invoke whenever the user mentions Miguel in the context of PRs.'), 'Miguel');
  assert.strictEqual(personaFromDescription('Sweeper. Invoke whenever the user mentions Murray Bones (or Murray, or Bones) in the context of dead code'), 'Murray Bones');
  assert.strictEqual(personaFromDescription('Auditor. whenever the user mentions James or Barnes in the context'), 'James');
  assert.strictEqual(personaFromDescription('Gate auditor. whenever the user mentions Esther, or whenever a plan has a gate'), 'Esther');
});

test('personaFromDescription takes a leading "Name —" form', () => {
  assert.strictEqual(personaFromDescription("Peter — Ricardo's ongoing Founder's Playbook coach."), 'Peter');
});

test('personaFromDescription is null when there is none', () => {
  assert.strictEqual(personaFromDescription('Use this agent when you need to build CLIs.'), null);
  assert.strictEqual(personaFromDescription('Mutation-testing specialist — measures tests.'), null);
  assert.strictEqual(personaFromDescription('Invoke when the user mentions it in passing.'), null);
  assert.strictEqual(personaFromDescription(''), null);
  assert.strictEqual(personaFromDescription(undefined), null);
});

test('functionFromDescription trims the "Use this agent" lead-ins and capitalises', () => {
  assert.strictEqual(functionFromDescription('Use this agent when you need to build command-line tools. Invoke often.'), 'Build command-line tools.');
  assert.strictEqual(functionFromDescription('Use this agent when building Electron apps.'), 'Building Electron apps.');
  assert.strictEqual(functionFromDescription('Use when automating Microsoft 365 tasks.'), 'Automating Microsoft 365 tasks.');
});

test('functionFromDescription is the first sentence only, and does not split on e.g.', () => {
  assert.strictEqual(functionFromDescription('Senior architecture reviewer. Invoke proactively.'), 'Senior architecture reviewer.');
  assert.strictEqual(functionFromDescription('Reviews things, e.g. code and docs, quickly. Then more.'), 'Reviews things, e.g. code and docs, quickly.');
});

test('functionFromDescription drops a leading persona "Name — "', () => {
  assert.strictEqual(functionFromDescription("Peter — Ricardo's ongoing coach. More."), "Ricardo's ongoing coach.");
});

test('functionFromDescription caps a very long sentence with an ellipsis', () => {
  const out = functionFromDescription('A' + 'b'.repeat(900));
  assert.ok(out.length <= 300);
  assert.ok(out.endsWith('…'));
});

test('functionFromDescription is empty only for an empty description', () => {
  assert.strictEqual(functionFromDescription(''), '');
  assert.strictEqual(functionFromDescription('   '), '');
  assert.strictEqual(functionFromDescription(undefined), '');
  assert.strictEqual(functionFromDescription('Use this agent when you need to'), 'Use this agent when you need to');
});

test('agentInfo is { persona, fn } with nulls for nothing', () => {
  assert.deepStrictEqual(agentInfo(fm('"Reviewer. Invoke whenever the user mentions Miguel in PRs."')),
    { persona: 'Miguel', fn: 'Reviewer.' });
  assert.deepStrictEqual(agentInfo('no frontmatter'), { persona: null, fn: null });
});

test('property: no description makes the parsers throw, and fn is never empty when the description has text', () => {
  fc.assert(fc.property(fc.string({ maxLength: 400 }), (d) => {
    const persona = personaFromDescription(d);
    assert.ok(persona === null || (typeof persona === 'string' && persona.length > 0));
    const fn = functionFromDescription(d);
    assert.strictEqual(typeof fn, 'string');
    if (d.trim() !== '') assert.ok(fn.length > 0, JSON.stringify(d));
    descriptionFromFrontmatter(`---\ndescription: ${d}\n---\n`);
    agentInfo(d);
  }), { numRuns: 500 });
});

test('property: the whole file never throws for arbitrary text', () => {
  fc.assert(fc.property(fc.string({ maxLength: 400 }), (raw) => {
    const info = agentInfo(raw);
    assert.ok(info.persona === null || typeof info.persona === 'string');
    assert.ok(info.fn === null || (typeof info.fn === 'string' && info.fn.length > 0));
  }), { numRuns: 500 });
});

test('agentDefinitions carries persona and fn per agent name', async () => {
  const cfg = tmpDir('roster-desc-');
  const dir = path.join(cfg, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'code-reviewer.md'),
    '---\nname: code-reviewer\ndescription: "Elite reviewer. Invoke whenever the user mentions Miguel in PRs."\n---\n');
  fs.writeFileSync(path.join(dir, 'bare.md'), 'no frontmatter');
  const r = await agentDefinitions({ configDir: cfg });
  assert.deepStrictEqual(r.infos.get('code-reviewer'), { persona: 'Miguel', fn: 'Elite reviewer.' });
  assert.deepStrictEqual(r.infos.get('bare'), { persona: null, fn: null });
});
