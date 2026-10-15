'use strict';
// Repo-scanning (reads module SOURCE), so deliberately NOT in Stryker's command: see test/stryker-config.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the service and its readers never write to a project document (source check)', () => {
  for (const f of ['drift-service.js', 'drift-text.js', 'drift-git.js', 'drift-docs-fs.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'host', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rename|renameSync|createWriteStream|mkdirSync|copyFile)\b/, f);
    assert.doesNotMatch(src, /\bgit['"],?\s*\[?['"]?(commit|add|checkout|reset|merge|push|stash)\b/, f);
  }
});
