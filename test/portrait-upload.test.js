'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planPortraitUpload, applyPortraitUpload, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } =
  require('../host/portrait-upload');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- planPortraitUpload: pure decision, no filesystem access of its own ----

test('a plain upload plans a destination inside <uploadsDir>/<agent>/<state>.<ext>', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const plan = planPortraitUpload({
    source: 'C:\\Users\\ricar\\Desktop\\photo.png',
    agent: 'code-reviewer', state: 'working',
    uploadsDir, size: 1024,
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.dest, path.join(uploadsDir, 'code-reviewer', 'working.png'));
});

test('the extension check is case-insensitive: .PNG is accepted and normalised to lowercase', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const plan = planPortraitUpload({
    source: 'C:\\photo.PNG', agent: 'a', state: 'happy', uploadsDir, size: 10,
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.dest, path.join(uploadsDir, 'a', 'happy.png'));
});

for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4']) {
  test(`.${ext} is an accepted upload extension`, () => {
    const uploadsDir = tmpdir('cc-plan-');
    const plan = planPortraitUpload({
      source: `C:\\f.${ext}`, agent: 'a', state: 'happy', uploadsDir, size: 10,
    });
    assert.strictEqual(plan.ok, true, `.${ext} was refused: ${plan.reason}`);
  });
}

test('an unsupported extension is refused with a visible reason', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const plan = planPortraitUpload({
    source: 'C:\\Users\\ricar\\Desktop\\resume.pdf',
    agent: 'code-reviewer', state: 'working', uploadsDir, size: 10,
  });
  assert.strictEqual(plan.ok, false);
  assert.match(plan.reason, /pdf/i);
});

test('a file with no extension at all is refused, not silently coerced to something', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const plan = planPortraitUpload({
    source: 'C:\\Users\\ricar\\Desktop\\noext',
    agent: 'code-reviewer', state: 'working', uploadsDir, size: 10,
  });
  assert.strictEqual(plan.ok, false);
});

test('exactly the size limit is accepted; one byte over is refused with a visible reason', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const atLimit = planPortraitUpload({
    source: 'C:\\f.png', agent: 'a', state: 'happy', uploadsDir, size: MAX_UPLOAD_BYTES,
  });
  assert.strictEqual(atLimit.ok, true, atLimit.reason);

  const overLimit = planPortraitUpload({
    source: 'C:\\f.png', agent: 'a', state: 'happy', uploadsDir, size: MAX_UPLOAD_BYTES + 1,
  });
  assert.strictEqual(overLimit.ok, false);
  assert.match(overLimit.reason, /25 ?MB|limit/i);
});

test('a missing or non-finite size is refused rather than treated as zero', () => {
  // Number(null) is 0 -- the absence-reported-as-zero bug this project keeps
  // catching. A size of undefined/NaN must never plan a destination as though
  // the file were empty and fine.
  const uploadsDir = tmpdir('cc-plan-');
  for (const size of [undefined, null, NaN, -1, 0]) {
    const plan = planPortraitUpload({ source: 'C:\\f.png', agent: 'a', state: 'happy', uploadsDir, size });
    assert.strictEqual(plan.ok, false, `size ${size} should have been refused`);
  }
});

test('agent and state are path segments and go through the same guard as portraitFor', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const plan = planPortraitUpload({
    source: 'C:\\f.png', agent: '../../secrets', state: 'happy', uploadsDir, size: 10,
  });
  assert.strictEqual(plan.ok, false);
});

test('a traversal attempt in the state name is also refused', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const plan = planPortraitUpload({
    source: 'C:\\f.png', agent: 'a', state: '..\\..\\windows', uploadsDir, size: 10,
  });
  assert.strictEqual(plan.ok, false);
});

test('no uploads directory configured is refused, not resolved against cwd', () => {
  const plan = planPortraitUpload({ source: 'C:\\f.png', agent: 'a', state: 'happy', size: 10 });
  assert.strictEqual(plan.ok, false);
});

test('PROPERTY: an accepted plan\'s destination is always inside <uploadsDir>/<agent>/', () => {
  const uploadsDir = tmpdir('cc-plan-');
  const agents = ['a', 'code-reviewer', 'zzz-agent'];
  const states = ['sleeping', 'working', 'happy', 'stressed', 'thinking'];
  for (const agent of agents) {
    for (const state of states) {
      for (const ext of UPLOAD_EXTENSIONS) {
        const plan = planPortraitUpload({ source: `C:\\f.${ext}`, agent, state, uploadsDir, size: 10 });
        assert.strictEqual(plan.ok, true);
        const rel = path.relative(path.join(uploadsDir, agent), plan.dest);
        assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel),
          `${plan.dest} escapes ${path.join(uploadsDir, agent)}`);
      }
    }
  }
});

// --- applyPortraitUpload: the actual copy, temp + rename --------------------

test('applyPortraitUpload copies the source to the destination, creating the agent folder', () => {
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  const sourceFile = path.join(src, 'photo.png');
  fs.writeFileSync(sourceFile, 'the actual bytes');

  const dest = path.join(uploadsDir, 'code-reviewer', 'working.png');
  applyPortraitUpload({ source: sourceFile, dest });

  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'the actual bytes');
});

test('applyPortraitUpload never leaves a .tmp file behind on success', () => {
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  const sourceFile = path.join(src, 'photo.png');
  fs.writeFileSync(sourceFile, 'x');
  const dest = path.join(uploadsDir, 'a', 'happy.png');

  applyPortraitUpload({ source: sourceFile, dest });

  const leftovers = fs.readdirSync(path.join(uploadsDir, 'a')).filter(f => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('applyPortraitUpload NEVER opens the destination with a bare write -- it writes to a temp path first', () => {
  // Mirrors CLAUDE.md's own scar: "a failed encode truncated app/renderer.js
  // to zero bytes" from opening the real destination with 'w' before the
  // write was known to succeed. Proven here by making the copy fail midway
  // and asserting the destination was never created at all.
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  const sourceFile = path.join(src, 'photo.png');
  fs.writeFileSync(sourceFile, 'x');
  const dest = path.join(uploadsDir, 'a', 'happy.png');

  assert.throws(() => {
    applyPortraitUpload({ source: sourceFile, dest }, {
      copyFile: () => { throw new Error('disk full, simulated'); },
    });
  });
  assert.strictEqual(fs.existsSync(dest), false);
});

test('applyPortraitUpload cleans up its temp file when the rename fails', () => {
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  const sourceFile = path.join(src, 'photo.png');
  fs.writeFileSync(sourceFile, 'x');
  const dest = path.join(uploadsDir, 'a', 'happy.png');

  assert.throws(() => {
    applyPortraitUpload({ source: sourceFile, dest }, {
      rename: () => { throw new Error('EPERM, simulated, exhausted retries'); },
    });
  });

  const leftovers = fs.readdirSync(path.join(uploadsDir, 'a'));
  assert.deepStrictEqual(leftovers, [], 'a failed rename left its temp file behind');
});

test('applyPortraitUpload overwrites an existing portrait for the same agent and state', () => {
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  const sourceFile = path.join(src, 'photo.png');
  const dest = path.join(uploadsDir, 'a', 'happy.png');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'old portrait');
  fs.writeFileSync(sourceFile, 'new portrait');

  applyPortraitUpload({ source: sourceFile, dest });

  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'new portrait');
});
