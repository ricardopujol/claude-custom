'use strict';
/** app/ask-profile.js (BACKLOG #33): who the explainer is (name, portrait), who it explains for (level, About me) and which model it uses. */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/ask-profile');

const mem = (seed) => {
  const m = new Map(seed ? [[P.KEY, seed]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
};

test('a first-time person has no name yet, starts at Comfortable, on the local model', () => {
  const p = P.load(mem());
  assert.strictEqual(p.named, false);
  assert.strictEqual(p.level, 'comfortable');
  assert.strictEqual(p.model, 'local');
  assert.strictEqual(p.aboutMe, '');
  assert.strictEqual(p.name, '');
});

test('the naming card suggests five names and a pre-filled one', () => {
  assert.deepStrictEqual(P.NAME_SUGGESTIONS, ['Professor Byte', 'Ada', 'Echo', 'Sage', 'Tutor']);
  assert.strictEqual(P.DEFAULT_NAME, 'Professor Byte');
});

test('naming: the name is trimmed, kept on one line and capped; an empty one is refused', () => {
  const p0 = P.load(mem());
  const ok = P.name(p0, '  Ada\nLovelace  ', { kind: 'upload' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.profile.name, 'Ada Lovelace');
  assert.strictEqual(ok.profile.named, true);
  assert.strictEqual(P.name(p0, '   ', null).ok, false);
  assert.strictEqual(P.name(p0, 'x'.repeat(100), null).profile.name.length, P.NAME_MAX);
});

test('the portrait is the agents\' picker\'s: one of the agents\' pictures, or the explainer\'s own upload; nothing else, and no image is kept in the profile', () => {
  const p0 = P.load(mem());
  assert.deepStrictEqual(p0.portrait, { kind: 'upload' }, 'the default is the explainer\'s own picture (an upload, or the agents\' fallback)');
  assert.deepStrictEqual(P.name(p0, 'Ada', { kind: 'agent', agent: 'naomi' }).profile.portrait, { kind: 'agent', agent: 'naomi' });
  assert.deepStrictEqual(P.name(p0, 'Ada', { kind: 'agent', agent: 'code-reviewer.v2_x' }).profile.portrait, { kind: 'agent', agent: 'code-reviewer.v2_x' });
  for (const bad of [{ kind: 'agent', agent: '../x' }, { kind: 'agent', agent: 'a/b' }, { kind: 'agent', agent: 'a\\b' }, { kind: 'agent', agent: '' }, { kind: 'agent', agent: 'x'.repeat(65) },
    { kind: 'agent', agent: 5 }, { kind: 'agent' }, { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }, { kind: 'emoji', value: '🦉' }, 'naomi', null]) {
    assert.deepStrictEqual(P.name(p0, 'Ada', bad).profile.portrait, { kind: 'upload' }, JSON.stringify(bad));
  }
  assert.strictEqual(P.PORTRAITS, undefined, 'the panel has no picker of its own any more');
  assert.strictEqual(P.IMAGE_MAX_CHARS, undefined);
});

test('level, About me and model are set strictly', () => {
  let p = P.load(mem());
  p = P.setLevel(p, 'new');
  assert.strictEqual(p.level, 'new');
  assert.strictEqual(P.setLevel(p, 'wizard').level, 'new', 'an unknown level changes nothing');
  p = P.setAboutMe(p, ' Learning Python, background in C# audio. ');
  assert.strictEqual(p.aboutMe, 'Learning Python, background in C# audio.');
  assert.strictEqual(P.setAboutMe(p, 'z'.repeat(5000)).aboutMe.length, P.ABOUT_ME_MAX);
  assert.strictEqual(P.setModel(p, 'sonnet').model, 'sonnet');
  assert.strictEqual(P.setModel(p, 'opus').model, 'local');
});

test('save then load round-trips; a broken or hostile stored value falls back to the defaults', () => {
  const s = mem();
  const p = P.name(P.setLevel(P.load(s), 'expert'), 'Echo', null).profile;
  P.save(s, p);
  assert.deepStrictEqual(P.load(s), p);
  for (const raw of ['not json', '[]', 'null', '{"level":"wizard","model":"gpt","name":5,"named":true,"portrait":{"kind":"image","dataUrl":"javascript:1"}}']) {
    const q = P.load(mem(raw));
    assert.strictEqual(q.level, 'comfortable');
    assert.strictEqual(q.model, 'local');
    assert.strictEqual(q.portrait.kind, 'upload');
    assert.strictEqual(q.named, false, 'a name that is not a string is no name');
  }
});

test('storage that throws never takes the panel down', () => {
  const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.strictEqual(P.load(bad).named, false);
  assert.strictEqual(P.save(bad, P.load(mem())), false);
  assert.strictEqual(P.load(null).named, false);
  assert.strictEqual(P.save(null, P.load(mem())), false);
});

test('opening the panel writes nothing: a first-run profile is not saved by load', () => {
  const s = mem();
  P.load(s);
  assert.strictEqual(s.m.size, 0);
});
