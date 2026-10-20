// Builds the Markdown reader's bundle (BACKLOG #119 A9): build/markdown-entry.mjs -> app/markdown-reader.js.
//
//   npm run build:markdown
//
// Same pattern as build/build-reader.mjs: the OUTPUT IS COMMITTED, so the app runs from a checkout with no build
// step; one minified IIFE for Chromium 130 (Electron 33); nothing is fetched at runtime. It is large (Mermaid), which
// is why the page loads it lazily, on the first Markdown file shown rendered. The header carries a hash of the
// inputs (the entry, the link rule it bundles, this script, the lockfile's versions of the three libraries and
// everything they pull in): test/bundle-fresh.test.js recomputes it, so a stale bundle fails a test.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { inputsHash, MARKDOWN_ROOTS } = createRequire(import.meta.url)('./inputs-hash.js');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const hash = inputsHash({
  entry: `${read('build', 'markdown-entry.mjs')}\n--\n${read('app', 'markdown-links.js')}\n--\n${read('app', 'external-link.js')}`,
  builder: read('build', 'build-markdown.mjs'),
  lock: JSON.parse(read('package-lock.json')),
  roots: MARKDOWN_ROOTS,
});

const result = await build({
  entryPoints: [path.join(root, 'build', 'markdown-entry.mjs')],
  outfile: path.join(root, 'app', 'markdown-reader.js'),
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'chrome130',
  legalComments: 'none',
  charset: 'ascii',            // no raw non-ASCII bytes: a stray control character can't hide in the blob
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `/* claude-custom Markdown reader: marked + DOMPurify + Mermaid, bundled from npm by build/build-markdown.mjs. Do not edit. inputs sha256:${hash} */` },
  metafile: true,
  logLevel: 'info',
});
const out = Object.values(result.metafile.outputs)[0];
console.log(`built app/markdown-reader.js: ${(out.bytes / 1024).toFixed(0)} KB`);
