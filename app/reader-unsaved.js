'use strict';
/**
 * Which tab has unsaved text in its code reader (#50 edit mode), so ending that tab can say so.
 *
 *   createUnsaved() -> { report(key, path), pathFor(key), clear(key) }
 *   closeDetail({ reason, unsaved }) -> string     the "End session" dialog's detail line(s)
 *
 * The reader (app/repo-reader.js) lives in the tab's page; closing the tab is main's. The page reports the file
 * with unsaved edits (or null) over IPC and main keeps one entry per tab. A tab close always asks "End the session
 * in X?"; with an entry it also says the reader's edits would be lost, so that question is never the only thing
 * between the person and their unsaved text. Ending the session is the only way out of that tab the shell
 * offers, so this is the whole tab-close guard; nothing blocks the page's own unload (a vetoed beforeunload pins a
 * tab view with no way to close it).
 */
const MAX_PATH = 300;

function createUnsaved() {
  const byTab = new Map();
  return {
    // `path` is a file name to remember, or anything else (null) to forget the tab's entry
    report(key, path) {
      if (typeof key !== 'string' || key === '') return;
      // stored ESCAPED (newlines, quotes and control characters spelled out): every dialog and reason that shows the name reads it from here
      if (typeof path === 'string' && path !== '') byTab.set(key, JSON.stringify(path.slice(0, MAX_PATH)).slice(1, -1));
      else byTab.delete(key);
    },
    pathFor: (key) => (byTab.has(key) ? byTab.get(key) : null),
    clear: (key) => { byTab.delete(key); },
    all: () => [...byTab].map(([key, path]) => ({ key, path })),
  };
}

function closeDetail({ reason = '', unsaved = null } = {}) {
  const lines = [reason ? reason : null, 'The folder stays.'];
  // a Ctrl+click close already says it in its reason (host/close-safety.js): once is enough
  if (typeof unsaved === 'string' && unsaved !== '' && !/unsaved edits/.test(reason)) lines.push(`You have unsaved edits to ${unsaved} in the file reader; they will be lost.`);
  return lines.filter(l => l !== null).join('\n');
}

/**
 * May the WINDOW close (X, Alt+F4, app quit)? Resolves true to close, false to stay. With no unsaved reader text,
 * true at once. Otherwise `ask(files)` answers 'save' | 'discard' | 'cancel'; Save has every page save
 * (`saveAll`) and closes only if all the entries clear within `waitCleared` (a save that hits a conflict or an
 * error keeps the window open, where the banner is). Anything else, a throw included, is a Cancel.
 */
async function guardWindowClose({ list, ask, saveAll, waitCleared, notify = () => {} }) {
  const entries = list();
  if (entries.length === 0) return true;
  let choice;
  try { choice = await ask(entries.map(e => e.path)); } catch { return false; }
  if (choice === 'discard') return true;
  if (choice !== 'save') return false;
  saveAll();
  if ((await waitCleared()) === true) return true;
  // say why the window is still there: a save that hit a conflict or an error is waiting in its page
  try { notify('Some changes could not be saved, so the window stays open. Check the file reader.'); } catch { /* the note is best effort */ }
  return false;
}

module.exports = { createUnsaved, closeDetail, guardWindowClose };
