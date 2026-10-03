// Builds the code reader's CodeMirror 6 bundle (#32): build/codemirror-entry.mjs -> app/vendor/codemirror-reader.js.
//
//   npm run build:reader
//
// The OUTPUT IS COMMITTED, so the app runs from a checkout with no build step (the renderer loads it from
// disk on the first file open). Rebuild after changing the entry or the CodeMirror versions. Chromium 130
// is Electron 33's, so no down-levelling is needed; the result is minified, one IIFE, exposed as
// `window.repoCodeMirror`. Nothing is fetched at runtime: it is all from node_modules.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [path.join(root, 'build', 'codemirror-entry.mjs')],
  outfile: path.join(root, 'app', 'vendor', 'codemirror-reader.js'),
  bundle: true,
  format: 'iife',
  globalName: 'repoCodeMirror',
  minify: true,
  target: 'chrome130',
  legalComments: 'none',
  charset: 'ascii',            // no raw non-ASCII bytes: a stray control character can't hide in the blob
  banner: { js: '/* claude-custom code reader: CodeMirror 6, bundled from npm by build/build-reader.mjs. Do not edit. */' },
  metafile: true,
  logLevel: 'info',
});
const out = Object.values(result.metafile.outputs)[0];
console.log(`built app/vendor/codemirror-reader.js: ${(out.bytes / 1024).toFixed(0)} KB`);
