'use strict';
/**
 * BACKLOG #80 / #55: what reaches the local model for a bubble, and what comes back. The input is trimmed to the agent's name,
 * its state, the tool, file NAMES and the task line; never file contents, never a secret. The output is one short line, or
 * nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { buildPrompt, cleanLine, voiceFromMd, maskSecrets, safeFileName, LINE_MAX, TASK_MAX } = require('../host/bubble-prompt');

const both = (o) => o.system + '\n' + o.prompt;

// --- the prompt ----------------------------------------------------------------------------------

test('the prompt carries the name, the state, the tool, the file names and the task line', () => {
  const o = buildPrompt({ agent: 'miguel', state: 'working', tool: 'Edit', files: ['C:\\proj\\src\\app.js'], task: 'review the diff', voice: null });
  const text = both(o);
  for (const want of ['miguel', 'working', 'Edit', 'app.js', 'review the diff']) assert.ok(text.includes(want), want);
  assert.ok(!text.includes('C:\\proj'), 'only the file NAME, not its folder');
});

test('the system prompt makes the line a joke that never claims anything happened', () => {
  const { system } = buildPrompt({ agent: 'a', state: 'happy' });
  assert.match(system, /joke/i);
  assert.match(system, /never (say|claim)/i);
  assert.match(system, /one (short )?line/i);
  assert.match(system, /first person/i);
});

test('an unknown state is refused (null), not passed on', () => {
  assert.strictEqual(buildPrompt({ agent: 'a', state: 'plotting' }), null);
  assert.strictEqual(buildPrompt({ agent: '', state: 'working' }), null);
  assert.strictEqual(buildPrompt(null), null);
});

test('extra fields (file contents, env, anything else) never reach the prompt', () => {
  const o = buildPrompt({
    agent: 'a', state: 'working', tool: 'Read', files: ['x.js'],
    content: 'TOP_SECRET_BODY', fileContents: 'MORE_SECRET', env: { KEY: 'ENVVALUE' }, toolInput: { command: 'echo LEAK' },
  });
  for (const leak of ['TOP_SECRET_BODY', 'MORE_SECRET', 'ENVVALUE', 'LEAK']) assert.ok(!both(o).includes(leak), leak);
});

test('secret-looking file names are dropped, ordinary ones kept, at most three', () => {
  assert.strictEqual(safeFileName('C:\\p\\.env'), null);
  assert.strictEqual(safeFileName('/a/.env.local'), null);
  assert.strictEqual(safeFileName('server.pem'), null);
  assert.strictEqual(safeFileName('id_rsa'), null);
  assert.strictEqual(safeFileName('my-api-secret.json'), null);
  assert.strictEqual(safeFileName('credentials.json'), null);
  assert.strictEqual(safeFileName('token.txt'), null);
  assert.strictEqual(safeFileName('app.js'), 'app.js');
  const o = buildPrompt({ agent: 'a', state: 'working', files: ['.env', 'a.js', 'b.js', 'c.js', 'd.js', 'secrets.yml'] });
  assert.match(o.prompt, /a\.js/);
  assert.match(o.prompt, /c\.js/);
  assert.ok(!o.prompt.includes('d.js'));
  assert.ok(!o.prompt.includes('.env'));
  assert.ok(!o.prompt.includes('secrets.yml'));
});

test('secrets in the task line are masked', () => {
  const samples = [
    'deploy with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'use ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP is the id',
    'send Authorization: Bearer abcdef1234567890abcdef1234567890',
    'set password=hunter2 and go',
    'token: abc123def456',
    'api_key = "zzzzzzzzzzzzzz"',
    'blob 0123456789abcdef0123456789abcdef01234567 here',
  ];
  for (const s of samples) {
    const out = maskSecrets(s);
    for (const bad of ['sk-ant', 'ghp_', 'AKIAABC', 'abcdef1234567890abcdef', 'hunter2', 'abc123def456', 'zzzzzzzz', '0123456789abcdef0123456789abcdef']) {
      assert.ok(!out.includes(bad), `${bad} survived in: ${out}`);
    }
  }
  assert.strictEqual(maskSecrets('review the parser'), 'review the parser');
});

test('the task line is one trimmed line capped at TASK_MAX', () => {
  const o = buildPrompt({ agent: 'a', state: 'working', task: 'line one\nline two\t' + 'x'.repeat(500) });
  const task = /Task: (.*)/.exec(o.prompt)[1];
  assert.ok(!task.includes('\n'));
  assert.ok([...task].length <= TASK_MAX);
});

test('the agent name and tool are length- and shape-limited', () => {
  const o = buildPrompt({ agent: 'a'.repeat(300), state: 'working', tool: 'rm -rf /; echo hi' });
  assert.ok(!o.prompt.includes('rm -rf'));
  assert.ok(!o.prompt.includes('a'.repeat(100)));
});

test('the voice (description and sign-off) shapes the system prompt; no voice is neutral', () => {
  const v = buildPrompt({ agent: 'miguel', state: 'working', voice: { description: 'Code reviewer who writes in Spanish', signOff: 'Sign off with Hasta luego.' } });
  assert.match(v.system, /Code reviewer who writes in Spanish/);
  assert.match(v.system, /Hasta luego/);
  const n = buildPrompt({ agent: 'x', state: 'working', voice: null });
  assert.match(n.system, /neutral/i);
});

test('PROPERTY: a secret planted in any trimmed field never appears in the prompt', () => {
  const SECRET = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
  fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (pre, post) => {
    const o = buildPrompt({ agent: 'a', state: 'working', task: `${pre} ${SECRET} ${post}`, files: [`${SECRET}.txt`] });
    assert.ok(!both(o).includes('ZZZZZZZZ'));
  }), { numRuns: 100 });
});

// --- the reply -----------------------------------------------------------------------------------

test('cleanLine takes the first usable line, strips quotes and thinking, and caps it', () => {
  assert.strictEqual(cleanLine('"Back to the grind!"'), 'Back to the grind!');
  assert.strictEqual(cleanLine('<think>hmm</think>\nSnack break.'), 'Snack break.');
  assert.strictEqual(cleanLine('\n\n  Line one\nLine two'), 'Line one');
  assert.ok([...cleanLine('y'.repeat(400))].length <= LINE_MAX);
});

test('cleanLine returns null for nothing, code, links or paths', () => {
  assert.strictEqual(cleanLine(''), null);
  assert.strictEqual(cleanLine('   \n  '), null);
  assert.strictEqual(cleanLine(null), null);
  assert.strictEqual(cleanLine('```js\nfoo()\n```'), null);
  assert.strictEqual(cleanLine('see https://example.com now'), null);
  assert.strictEqual(cleanLine('edited C:\\proj\\a.js'), null);
});

test('cleanLine refuses a line that claims something was found, fixed or finished (a bubble is a joke, never information)', () => {
  for (const claim of ['I just spotted a null pointer where I expected nothing', 'All tests pass, you are welcome!', 'Bug fixed, no need to thank me',
    'I found the leak', 'Merged and deployed, easy', 'Done! That was quick', 'I caught three bugs today', 'I just saw an off-by-one error']) {
    assert.strictEqual(cleanLine(claim), null, claim);
  }
  for (const joke of ['Back to the grind!', 'MUAJAJA', 'Otra vez a revisar, ¡qué vida!', 'Dry as ever.', 'Send coffee, then send more coffee']) {
    assert.strictEqual(cleanLine(joke), joke, joke);
  }
});

test('cleanLine refuses claims in Spanish too, accents or not, and broader English (a best-effort filter, never a rewrite)', () => {
  for (const claim of ['¡Encontré el bug, olé!', 'Encontre el bug', 'Arreglado, de nada', 'Lo arreglé yo solito', 'Todo pasa, listo', 'Ya terminé, chaval',
    'Todo en verde, tío', 'He cazado un bug', 'Despliegue hecho', 'Squashed that bug flat!', 'Tests are green, I am a genius', 'Nailed it, ship it',
    'It works now', 'Bug fix incoming', 'Finding bugs all day', 'Resolved, you are welcome']) {
    assert.strictEqual(cleanLine(claim), null, claim);
  }
  for (const joke of ['Back to work, sigh', 'Más café, por favor', '¡Qué vida esta!', 'Mutants everywhere, my favourite']) {
    assert.strictEqual(cleanLine(joke), joke, joke);
  }
});

test('the task line is scrubbed of paths: no drive letters, no folder chains', () => {
  const o = buildPrompt({ agent: 'a', state: 'working', task: 'Read C:\\Users\\ricar\\.ssh\\config and /home/ricar/notes/todo.txt then ~/docs/plan.md' });
  const task = /Task: (.*)/.exec(o.prompt)[1];
  assert.ok(!/[A-Za-z]:\\/.test(task), task);
  assert.ok(!task.includes('\\'), task);
  assert.ok(!/\/[\w.-]+\/[\w.-]/.test(task), task);
  assert.ok(!/ricar/.test(task), task);
  assert.match(task, /Read/);
});

test('cleanLine cuts a long line at a word, not in the middle of one', () => {
  const out = cleanLine('wobble '.repeat(30));
  assert.ok(out.endsWith('…'));
  assert.ok([...out].length <= LINE_MAX);
  assert.ok(out.slice(0, -1).trim().split(' ').every(w => w === 'wobble'), out);
});

test('cleanLine never cuts a surrogate pair', () => {
  const out = cleanLine('😀'.repeat(LINE_MAX + 10));
  assert.ok(!/[\uD800-\uDBFF]$/.test(out));
});

test('PROPERTY: cleanLine is null or a single short line with no markup fences', () => {
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
    const out = cleanLine(s);
    if (out === null) return;
    assert.ok(!out.includes('\n'));
    assert.ok([...out].length <= LINE_MAX);
    assert.ok(out.trim() === out && out !== '');
    assert.ok(!out.includes('```'));
  }), { numRuns: 200 });
});

// --- the voice -----------------------------------------------------------------------------------

test('voiceFromMd reads the description and a sign-off instruction from the body', () => {
  const raw = '---\nname: mortimer\ndescription: Mutation tester who loves breaking things.\n---\n\n# Mortimer\n\nBe thorough.\n- Always sign off with "MUAJAJA".\nOther text.\n';
  const v = voiceFromMd(raw);
  assert.match(v.description, /Mutation tester/);
  assert.match(v.signOff, /MUAJAJA/);
});

test('voiceFromMd is neutral (null) when there is neither', () => {
  assert.strictEqual(voiceFromMd('no frontmatter at all'), null);
  assert.strictEqual(voiceFromMd(undefined), null);
  const v = voiceFromMd('---\nname: x\ndescription: Does a thing.\n---\nbody');
  assert.strictEqual(v.signOff, null);
  assert.strictEqual(v.description, 'Does a thing.');
});

test('voiceFromMd caps what it keeps', () => {
  const raw = '---\ndescription: ' + 'd'.repeat(2000) + '\n---\nsign off with ' + 'z'.repeat(2000);
  const v = voiceFromMd(raw);
  assert.ok(v.description.length <= 240);
  assert.ok(v.signOff.length <= 220);
});

test('voiceFromMd follows a sign-off HEADING to the lines under it (the real agent files put the instruction there)', () => {
  const raw = '---\ndescription: Gleeful mutation tester.\n---\n\n## Mandatory sign-off\n\nAlways close with the voice of a gleeful villain who delights in survivors.\nFormat: "[what you found] - Mortimer, MUAJAJA"\n\n## Next section\nunrelated';
  const v = voiceFromMd(raw);
  assert.match(v.signOff, /gleeful villain/);
  assert.match(v.signOff, /MUAJAJA/);
  assert.ok(!/unrelated/.test(v.signOff));
});

test('voiceFromMd finds a Spanish closing-line instruction', () => {
  const raw = '---\ndescription: Elite code reviewer.\n---\nAl terminar SIEMPRE incluyes una línea final escrita en español de España con humor castizo.\n';
  assert.match(voiceFromMd(raw).signOff, /español de España/);
});

test('cleanLine drops verdict and sign-off words in both languages (the agents\' own sign-off is the voice the model is given)', () => {
  for (const line of ['DEFECTIVE — and I haven\'t had coffee', 'Verdict: CORRECT, as usual', 'Approved, olé', '¡Aprobado!', 'Aprobado, chaval', 'LGTM, next',
    'Ya está, chaval', 'Todo bien, sin errores', 'All good here', 'Correcto, tío', 'APPROVED!!!']) {
    assert.strictEqual(cleanLine(line), null, line);
  }
  assert.strictEqual(cleanLine('Coffee first, verdicts never'), null);        // "verdict" itself is out, even in a joke
  assert.strictEqual(cleanLine('Back to the grind!'), 'Back to the grind!');
});

test('scrubPaths-in-the-task: a Windows path with spaces and a relative slash path each become one [path], no folder names left', () => {
  const win = buildPrompt({ agent: 'a', state: 'working', task: 'Read C:\\Users\\ricar\\Ricardo-Pujol-Obsidian-Vault\\Personal Notes\\diary.md now' });
  const wt = /Task: (.*)/.exec(win.prompt)[1];
  assert.ok(!wt.includes('\\'), wt);
  assert.ok(!/Notes|Personal|Obsidian|diary/.test(wt), wt);
  assert.match(wt, /^Read \[path\] now$/);
  const rel = buildPrompt({ agent: 'a', state: 'working', task: 'Edit documentation/handoffs/CURRENT-x.md please' });
  const rt = /Task: (.*)/.exec(rel.prompt)[1];
  assert.ok(!/documentation|handoffs|CURRENT/.test(rt), rt);
  assert.match(rt, /^Edit \[path\] please$/);
});
