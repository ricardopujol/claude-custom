// The code reader's CodeMirror 6 bundle, source (#32). Built by build/build-reader.mjs into
// app/vendor/codemirror-reader.js and loaded by app/repo-reader.js on the FIRST file open, never at startup.
//
// READ-ONLY by construction: EditorState.readOnly is on (a selection and the caret still work, which is
// what "@ in prompt" for a line range needs) and nothing here imports an editing command or keymap.
// No network: everything is bundled from node_modules. The page reaches it as `window.repoCodeMirror`.
//
//   create(parent, { onSelection }) -> { show({ text, name, mode, language }), selection(), focus(), destroy() }
//     mode 'file' draws the file with its language; mode 'diff' draws unified-style text with +/-/@@ lines
//     coloured. `language` is app/repo-language.js's id.
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap, Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxHighlighting, HighlightStyle, StreamLanguage } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { toml } from '@codemirror/legacy-modes/mode/toml';

const LANGUAGES = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  markdown: () => markdown(),
  python: () => python(),
  yaml: () => yaml(),
  xml: () => xml(),
  shell: () => StreamLanguage.define(shell),
  powershell: () => StreamLanguage.define(powerShell),
  toml: () => StreamLanguage.define(toml),
};

// The app's own colours, through its CSS variables, so a re-skinned harness re-skins the reader.
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Consolas, monospace', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--chrome)', color: 'var(--dim)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 32%, transparent)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 55%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--chrome)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { font: 'inherit', fontSize: '11px' },
  '.cm-panels input': { backgroundColor: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' },
  '.cm-diff-add': { backgroundColor: 'color-mix(in srgb, var(--ok) 16%, transparent)' },
  '.cm-diff-del': { backgroundColor: 'color-mix(in srgb, var(--bad) 16%, transparent)' },
  '.cm-diff-hunk': { backgroundColor: 'var(--chrome)', color: 'var(--accent)' },
}, { dark: true });

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--accent)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--ok)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'color-mix(in srgb, var(--accent) 70%, var(--text))' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--dim)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: 'color-mix(in srgb, var(--ok) 55%, var(--text))' },
  { tag: [t.typeName, t.className, t.namespace], color: 'color-mix(in srgb, var(--accent) 55%, var(--text))' },
  { tag: [t.propertyName, t.attributeName], color: 'color-mix(in srgb, var(--text) 82%, var(--accent))' },
  { tag: [t.tagName, t.heading], color: 'var(--accent)', fontWeight: 'bold' },
  { tag: [t.punctuation, t.bracket, t.operator], color: 'color-mix(in srgb, var(--text) 70%, var(--dim))' },
  { tag: [t.link, t.url], color: 'var(--ok)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--bad)' },
]));

// Unified-style text from app/repo-*.js: `+` / `-` / `@@` first characters colour the whole line.
const addLine = Decoration.line({ class: 'cm-diff-add' });
const delLine = Decoration.line({ class: 'cm-diff-del' });
const hunkLine = Decoration.line({ class: 'cm-diff-hunk' });
function diffDecorations(view) {
  const out = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      if (text.startsWith('@@')) out.push(hunkLine.range(line.from));
      else if (text.startsWith('+') && !text.startsWith('+++')) out.push(addLine.range(line.from));
      else if (text.startsWith('-') && !text.startsWith('---')) out.push(delLine.range(line.from));
      pos = line.to + 1;
    }
  }
  return Decoration.set(out);
}
const diffPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = diffDecorations(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = diffDecorations(u.view); }
}, { decorations: (v) => v.decorations });

function create(parent, { onSelection } = {}) {
  const lang = new Compartment();
  const diff = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        EditorState.readOnly.of(true),
        lineNumbers(), drawSelection(), highlightActiveLine(), highlightSelectionMatches(),
        search({ top: true }), keymap.of(searchKeymap),
        theme, highlight,
        lang.of([]), diff.of([]),
        EditorView.updateListener.of((u) => { if (u.selectionSet && typeof onSelection === 'function') onSelection(); }),
      ],
    }),
  });

  function selection() {
    const { from, to, empty } = view.state.selection.main;
    const a = view.state.doc.lineAt(from);
    const b = view.state.doc.lineAt(to);
    return { fromLine: a.number, toLine: b.number, empty, toCol0: !empty && to === b.from };
  }

  return {
    show({ text, name, mode, language }) {
      const make = mode === 'diff' ? null : LANGUAGES[language];
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: String(text) },
        selection: { anchor: 0 },
        effects: [lang.reconfigure(make ? make() : []), diff.reconfigure(mode === 'diff' ? diffPlugin : [])],
        scrollIntoView: true,
      });
      view.scrollDOM.scrollTop = 0;
      view.scrollDOM.scrollLeft = 0;
      view.dom.dataset.name = String(name || '');
      view.dom.dataset.mode = mode === 'diff' ? 'diff' : 'file';
    },
    selection,
    lines: () => view.state.doc.lines,
    text: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export { create };
export const languages = Object.keys(LANGUAGES);
