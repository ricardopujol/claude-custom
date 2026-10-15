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

// Ricardo, 2026-10-09: cedar.md names "Cedar", the role cedar again ignoring case -- the persona is kept, as written.
test('agentDefinitions keeps a persona that equals the role ignoring case (cedar -> Cedar)', async () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-descriptions.fixture.json'), 'utf8'));
  const cfg = tmpDir('roster-cedar-');
  const dir = path.join(cfg, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cedar.md'), corpus['cedar.md']);
  const r = await agentDefinitions({ configDir: cfg });
  assert.strictEqual(r.infos.get('cedar').persona, 'Cedar');
  assert.strictEqual(r.infos.get('cedar').fn, JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-descriptions.expected.fixture.json'), 'utf8'))['cedar.md'].fn);
});

// --- PR #141 review fixes ------------------------------------------------------

test('F1: persona names are Unicode, not ASCII-only', () => {
  assert.strictEqual(personaFromDescription('Interviewer. Invoke whenever the user mentions José Tomás, or needs interviews.'), 'José Tomás');
  assert.strictEqual(personaFromDescription('X. whenever the user mentions Álvaro in the context of y'), 'Álvaro');
  assert.strictEqual(personaFromDescription('X. whenever the user mentions Begoña, or z'), 'Begoña');
  assert.strictEqual(personaFromDescription('X. whenever the user mentions Zoë in the context'), 'Zoë');
  assert.strictEqual(personaFromDescription('José — does things.'), 'José');
});

test('F5: acronyms, products and a multi-word lead-in are not personas', () => {
  assert.strictEqual(personaFromDescription('Containers. Invoke whenever the user mentions Docker or Kubernetes.'), null);
  assert.strictEqual(personaFromDescription('Tools. whenever the user mentions MCP in passing'), null);
  assert.strictEqual(personaFromDescription('Tools. whenever the user mentions MCP Servers in passing'), null);
  assert.strictEqual(personaFromDescription('Elite Reviewer — reviews code.'), null);
  assert.strictEqual(functionFromDescription('Elite Reviewer — reviews code. More.'), 'Elite Reviewer — reviews code.');
  // and the real shapes still parse
  assert.strictEqual(personaFromDescription('X. whenever the user mentions James or Barnes in the context'), 'James');
});

test('F6: the first sentence does not end at an abbreviation', () => {
  assert.strictEqual(functionFromDescription('Compares Django vs. Flask projects. Invoke often.'), 'Compares Django vs. Flask projects.');
  assert.strictEqual(functionFromDescription('Works with e.g. React and Vue. More.'), 'Works with e.g. React and Vue.');
  assert.strictEqual(functionFromDescription('Writes letters for Mr. Smith daily. More.'), 'Writes letters for Mr. Smith daily.');
  assert.strictEqual(functionFromDescription('Writes for Dr. Who, i.e. Alice Smith. More.'), 'Writes for Dr. Who, i.e. Alice Smith.');
  assert.strictEqual(functionFromDescription('Tools, tests, etc. Invoke often. More.'), 'Tools, tests, etc. Invoke often.');
});

test('F7: a block scalar keeps going across blank lines and ignores its indicators', () => {
  const blank = '---\nname: x\ndescription: >\n  Reviews code.\n\n  Invoke whenever the user mentions Miguel.\nmodel: opus\n---\n';
  assert.strictEqual(descriptionFromFrontmatter(blank), 'Reviews code. Invoke whenever the user mentions Miguel.');
  assert.strictEqual(agentInfo(blank).persona, 'Miguel');
  for (const ind of ['>2-', '>-2', '|+', '> # folded', '>  ', '|2']) {
    const raw = `---\nname: x\ndescription: ${ind}\n  Reviews code.\n---\n`;
    assert.strictEqual(descriptionFromFrontmatter(raw), 'Reviews code.', ind);
  }
  const dq = '---\nname: x\ndescription: "Reviews\n\n  code."\nmodel: opus\n---\n';
  assert.strictEqual(descriptionFromFrontmatter(dq), 'Reviews code.');
});

test('F9: the cap never leaves half of a surrogate pair', () => {
  const out = functionFromDescription('A' + 'b'.repeat(297) + '😀 tail');
  assert.doesNotThrow(() => encodeURIComponent(out));
  assert.ok(out.endsWith('…'));
});

test('the first letter is capitalised by code point, not code unit', () => {
  const out = functionFromDescription('𐐨 lower deseret letter.');
  assert.doesNotThrow(() => encodeURIComponent(out));
  assert.strictEqual(out.codePointAt(0), 0x10400);
});

// The corpus: the real description lines of every global agent file, copied into a fixture so this doesn't depend on
// the live folder. The expected map was read by eye (persona and function line per agent) when it was written.
test('corpus: every real agent file parses to its pinned persona and function line', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-descriptions.fixture.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-descriptions.expected.fixture.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(expected).sort(), Object.keys(corpus).sort());
  for (const [file, raw] of Object.entries(corpus)) {
    assert.deepStrictEqual(agentInfo(raw), expected[file], file);
  }
  // the named cases from the review
  assert.strictEqual(expected['ux-researcher-cl.md'].persona, 'José Tomás');
  assert.strictEqual(expected['founder-playbook-coach.md'].persona, 'Peter');
  assert.strictEqual(expected['dead-code-hunter.md'].persona, 'Murray Bones');
  assert.strictEqual(expected['node-specialist.md'].persona, null);
});

test('#3: an excluded first "mentions" does not hide a leading name or a later "mentions"', () => {
  assert.strictEqual(personaFromDescription('Otto — browser automation. Invoke whenever the user mentions AWS or Otto.'), 'Otto');
  assert.strictEqual(personaFromDescription('Containers. Invoke whenever the user mentions Docker, or whenever the user mentions Paul.'), 'Paul');
  assert.strictEqual(personaFromDescription('Containers. Invoke whenever the user mentions Docker or Kubernetes.'), null);
});

test('#5: "Use this agent when you need an/a/comprehensive ..." trims to the function phrase', () => {
  assert.strictEqual(functionFromDescription('Use this agent when you need an idea pressure-tested with honesty. More.'), 'An idea pressure-tested with honesty.');
  assert.strictEqual(functionFromDescription('Use this agent when you need comprehensive research across sources. More.'), 'Comprehensive research across sources.');
  assert.strictEqual(functionFromDescription('Use this agent when you need to build CLIs.'), 'Build CLIs.');
});
