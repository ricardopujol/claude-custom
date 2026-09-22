// @ts-nocheck
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { backgroundFor, DIM_OPACITY } = require('../host/background');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bg-'));

test('generates a background for a project', () => {
  const dir = tmp();
  const bg = backgroundFor('C:/w/alpha', { dir });
  assert.ok(fs.existsSync(bg.path), 'file not written');
  assert.strictEqual(bg.created, true);
});

test('the same project always gets the same image', () => {
  // "generated once when the project is created" -- every context window on the
  // same folder must look identical, including after the host restarts.
  const dir = tmp();
  const first = fs.readFileSync(backgroundFor('C:/w/alpha', { dir }).path, 'utf8');
  const second = fs.readFileSync(backgroundFor('C:/w/alpha', { dir }).path, 'utf8');
  assert.strictEqual(first, second);
});

test('an existing background is reused, not regenerated', () => {
  const dir = tmp();
  const a = backgroundFor('C:/w/alpha', { dir });
  const b = backgroundFor('C:/w/alpha', { dir });
  assert.strictEqual(a.created, true);
  assert.strictEqual(b.created, false, 'second call regenerated the image');
  assert.strictEqual(a.path, b.path);
});

test('a hand-edited background is left alone', () => {
  // The file is a plain SVG; if someone tweaks it, regenerating would silently
  // discard their edit on the next launch.
  const dir = tmp();
  const bg = backgroundFor('C:/w/alpha', { dir });
  fs.writeFileSync(bg.path, '<svg id="mine"></svg>');
  backgroundFor('C:/w/alpha', { dir });
  assert.strictEqual(fs.readFileSync(bg.path, 'utf8'), '<svg id="mine"></svg>');
});

test('different projects get visibly different images', () => {
  const dir = tmp();
  const a = fs.readFileSync(backgroundFor('C:/w/alpha', { dir }).path, 'utf8');
  const b = fs.readFileSync(backgroundFor('C:/w/beta', { dir }).path, 'utf8');
  assert.notStrictEqual(a, b);
});

test('path matching ignores slash direction and case', () => {
  // Otherwise the same folder gets two different images depending on how the
  // cwd happened to be spelled.
  const dir = tmp();
  const a = backgroundFor('C:/Work/Alpha', { dir });
  const b = backgroundFor('c:\\work\\alpha', { dir });
  assert.strictEqual(a.path, b.path);
  assert.strictEqual(b.created, false);
});

test('the image is dimmed so light text stays readable on top', () => {
  const dir = tmp();
  const svg = fs.readFileSync(backgroundFor('C:/w/alpha', { dir }).path, 'utf8');
  assert.ok(svg.includes(`opacity="${DIM_OPACITY}"`), 'no dimming overlay found');
  // Dim enough that light text reads, light enough that the art is visible at
  // all. At 0.9 it was invisible in practice, which defeated the feature.
  assert.ok(DIM_OPACITY >= 0.6 && DIM_OPACITY <= 0.85, `dim ${DIM_OPACITY} out of range`);
});

test('the dimming overlay is the LAST element, so nothing draws over it', () => {
  // SVG paints in document order. An overlay that is not last dims only part of
  // the artwork, and the bright remainder is exactly where text becomes
  // unreadable.
  const dir = tmp();
  const svg = fs.readFileSync(backgroundFor('C:/w/alpha', { dir }).path, 'utf8');
  const overlayAt = svg.lastIndexOf(`opacity="${DIM_OPACITY}"`);
  const lastShape = Math.max(
    svg.lastIndexOf('<circle'), svg.lastIndexOf('<ellipse'),
    svg.lastIndexOf('<path'), svg.lastIndexOf('<polygon')
  );
  assert.ok(overlayAt > lastShape, 'dimming overlay is painted before some artwork');
});

test('is valid standalone SVG with a viewBox so it scales to any window', () => {
  const dir = tmp();
  const svg = fs.readFileSync(backgroundFor('C:/w/alpha', { dir }).path, 'utf8');
  assert.ok(svg.trimStart().startsWith('<svg'), 'not an svg root');
  assert.ok(/viewBox="0 0 \d+ \d+"/.test(svg), 'no viewBox');
  assert.ok(svg.trimEnd().endsWith('</svg>'));
});

test('creates the directory if it does not exist', () => {
  const dir = path.join(tmp(), 'nested', 'deep');
  assert.ok(fs.existsSync(backgroundFor('C:/w/alpha', { dir }).path));
});

test('a project path with odd characters still yields one safe filename', () => {
  // The filename is derived from the path; traversal or separators in it would
  // write outside the backgrounds directory.
  const dir = tmp();
  const bg = backgroundFor('C:/w/../../weird name (2)/x', { dir });
  assert.strictEqual(path.dirname(path.resolve(bg.path)), path.resolve(dir));
  assert.ok(/^[A-Za-z0-9._-]+\.svg$/.test(path.basename(bg.path)), path.basename(bg.path));
});

test('picks among several styles rather than one template', () => {
  // 80 projects sharing one look defeats the point of per-project identity.
  const dir = tmp();
  const styles = new Set();
  for (let i = 0; i < 40; i++) {
    const svg = fs.readFileSync(backgroundFor('C:/w/p' + i, { dir }).path, 'utf8');
    styles.add((svg.match(/data-style="([a-z-]+)"/) || [])[1]);
  }
  assert.ok(styles.size >= 3, `only ${styles.size} style(s) across 40 projects`);
});
