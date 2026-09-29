'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { planPortraitUpload, applyPortraitUpload, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } =
  require('../host/portrait-upload');

// Through test/tmp-dir.js, which cleans up after the run: a bare mkdtempSync
// leaks a directory per call (test/tmp-dir-hygiene.test.js).
function tmpdir(prefix) {
  return tmpDir(prefix);
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

// --- replacing an upload in a DIFFERENT format (Dexter F1 / Miguel B1, PR #35) --
//
// findAsset picks by a fixed extension order, so a leftover working.png beat
// a freshly uploaded working.webm: "portrait set" was reported while the old
// still kept showing, labelled "your upload". The new file must be the one
// that resolves, for every (old, new) pair.

const { portraitFor } = require('../host/portraits');

function uploadFile(src, uploadsDir, agent, state, ext, body) {
  const sourceFile = path.join(src, `drop-${ext}.${ext}`);
  fs.writeFileSync(sourceFile, body);
  const plan = planPortraitUpload({
    source: sourceFile, agent, state, uploadsDir, size: fs.statSync(sourceFile).size,
  });
  assert.ok(plan.ok, plan.reason);
  applyPortraitUpload({ source: sourceFile, dest: plan.dest });
  return plan.dest;
}

test('a new upload in ANY other format is the one that resolves, for every (old, new) pair', () => {
  for (const oldExt of UPLOAD_EXTENSIONS) {
    for (const newExt of UPLOAD_EXTENSIONS) {
      if (oldExt === newExt) continue;
      const src = tmpdir('cc-src-');
      const uploadsDir = tmpdir('cc-uploads-');
      uploadFile(src, uploadsDir, 'a', 'working', oldExt, 'old');
      const dest = uploadFile(src, uploadsDir, 'a', 'working', newExt, 'new');

      const p = portraitFor('a', 'working', { uploadsDir });
      assert.strictEqual(p.path, dest, `${oldExt} -> ${newExt}: the old upload still resolves`);
      assert.deepStrictEqual(fs.readdirSync(path.join(uploadsDir, 'a')), [`working.${newExt}`],
        `${oldExt} -> ${newExt}: the replaced file was left behind`);
    }
  }
});

test('replacing one state\'s upload leaves every OTHER state\'s files alone', () => {
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  uploadFile(src, uploadsDir, 'a', 'working', 'png', 'w');
  uploadFile(src, uploadsDir, 'a', 'default', 'gif', 'd');
  uploadFile(src, uploadsDir, 'a', 'happy', 'png', 'old');
  uploadFile(src, uploadsDir, 'a', 'happy', 'webm', 'new');

  assert.deepStrictEqual(fs.readdirSync(path.join(uploadsDir, 'a')).sort(),
    ['default.gif', 'happy.webm', 'working.png']);
});

test('an old format that cannot be removed fails the upload, never reports it as set', () => {
  // If the stale file survives, it still wins the lookup -- so "portrait set"
  // would be a lie. The failure must surface as a throw (host.js turns it into
  // ok:false with this message as the reason).
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  uploadFile(src, uploadsDir, 'a', 'working', 'png', 'old');
  const sourceFile = path.join(src, 'new.webm');
  fs.writeFileSync(sourceFile, 'new');
  const dest = path.join(uploadsDir, 'a', 'working.webm');

  assert.throws(() => applyPortraitUpload({ source: sourceFile, dest }, {
    unlinkSync: (p) => {
      if (p.endsWith('working.png')) throw Object.assign(new Error('EPERM, simulated'), { code: 'EPERM' });
      fs.unlinkSync(p);
    },
  }), /working\.png/);
});

test('applyPortraitUpload cleans up a PARTIAL temp file when the copy itself fails (Dexter F4)', () => {
  // The old stub threw before creating anything, so a copy that dies midway
  // (ENOSPC on a 24 MB video) leaving its temp file behind went unseen.
  const src = tmpdir('cc-src-');
  const uploadsDir = tmpdir('cc-uploads-');
  const sourceFile = path.join(src, 'photo.mp4');
  fs.writeFileSync(sourceFile, 'x');
  const dest = path.join(uploadsDir, 'a', 'working.mp4');

  assert.throws(() => applyPortraitUpload({ source: sourceFile, dest }, {
    copyFile: (from, to) => { fs.writeFileSync(to, 'half'); throw new Error('ENOSPC, simulated'); },
  }), /ENOSPC/);
  assert.deepStrictEqual(fs.readdirSync(path.join(uploadsDir, 'a')), [],
    'a copy that failed partway left its temp file behind');
});

test('"." is not an agent or state segment -- it would land in the shared uploads root (Dexter F5)', () => {
  const { safeSegment } = require('../host/portraits');
  assert.strictEqual(safeSegment('.'), null);
  const plan = planPortraitUpload({ source: path.join(os.tmpdir(), 'p.png'), agent: '.', state: 'working', uploadsDir: path.join(os.tmpdir(), 'u'), size: 1 });
  assert.strictEqual(plan.ok, false);
});
