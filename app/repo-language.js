'use strict';
/**
 * Which highlighting language the reader uses for a file (#32), from its NAME alone.
 *
 *   languageFor('src/App.tsx') -> 'tsx'        (null for plain text)
 *
 * Only an id: the CodeMirror extensions for these ids live in the bundle (build/codemirror-entry.mjs), which
 * loads on the first file open. Only the last extension counts, in any case; a dotfile, a name with no
 * extension and an unknown extension are plain text, which is always a safe answer.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoLanguage`.
 */
(function (root) {

const BY_EXT = new Map(Object.entries({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown', py: 'python', pyw: 'python',
  yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', props: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', toml: 'toml',
}));

function languageFor(name) {
  if (typeof name !== 'string' || name === '') return null;
  const base = name.split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;       // none, a dotfile, or a trailing dot
  return BY_EXT.get(base.slice(dot + 1).toLowerCase()) || null;
}

const API = { languageFor };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoLanguage = API;

})(typeof window !== 'undefined' ? window : globalThis);
