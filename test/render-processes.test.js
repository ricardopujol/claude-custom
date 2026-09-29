'use strict';
/**
 * The Running panel's markup, RUN rather than grepped.
 *
 * renderer.js needs a real window, so its functions cannot be required. These
 * two are pure apart from one element, so they are lifted out of the source
 * and run in a sandbox against a fake list element -- the actual code path.
 *
 * Dexter F5 on the process-tracker branch: the label is a Bash command, and it
 * went into innerHTML raw. `sort <in.txt >out.txt` rendered as `sort out.txt`,
 * and a `"` cut the title attribute short. A command is untrusted text.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

// A top-level function's full text, found by brace matching from its header.
function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `renderer.js must still define ${name}`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function render(list) {
  const sandbox = { procListEl: { innerHTML: '' } };
  vm.createContext(sandbox);
  vm.runInContext(`${lift('humanElapsed')}\n${lift('renderProcesses')}`, sandbox);
  sandbox.renderProcesses(list);
  return sandbox.procListEl.innerHTML;
}

const proc = (over) => ({ tool: 'Bash', label: 'npm test', state: 'running', startedAt: 0, elapsedMs: 5000, ...over });

test('a command with angle brackets is shown as text, not parsed as markup', () => {
  const html = render([proc({ label: 'sort <in.txt >out.txt' })]);
  assert.ok(html.includes('sort &lt;in.txt &gt;out.txt'), html);
  assert.ok(!html.includes('<in.txt'), html);
});

test('a quote in a command cannot end the title attribute early', () => {
  const html = render([proc({ label: 'echo "a" onmouseover="x()' })]);
  assert.ok(!/onmouseover="x/.test(html), html);
  assert.ok(html.includes('&quot;'), html);
});

test('an ampersand is escaped, so an entity in a command shows literally', () => {
  const html = render([proc({ label: 'echo &lt; && ls' })]);
  assert.ok(html.includes('echo &amp;lt; &amp;&amp; ls'), html);
});

test('a stale entry says it ended, and a running one shows its elapsed time', () => {
  const html = render([proc({ state: 'stale', label: 'ls x' }), proc({ label: 'npm test', elapsedMs: 65_000 })]);
  assert.match(html, /class="proc stale"[\s\S]*ended \(stale\)/);
  assert.match(html, /class="proc slow"[\s\S]*1m 05s/);
});

test('an empty list says nothing is running', () => {
  assert.match(render([]), /nothing running/);
});
