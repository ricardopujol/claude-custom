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
      if (typeof path === 'string' && path !== '') byTab.set(key, path.slice(0, MAX_PATH));
      else byTab.delete(key);
    },
    pathFor: (key) => (byTab.has(key) ? byTab.get(key) : null),
    clear: (key) => { byTab.delete(key); },
  };
}

function closeDetail({ reason = '', unsaved = null } = {}) {
  const lines = [reason ? `Not closed without asking: ${reason}.` : null, 'The folder stays.'];
  if (typeof unsaved === 'string' && unsaved !== '') lines.push(`You have unsaved edits to ${JSON.stringify(unsaved).slice(1, -1)} in the file reader; they will be lost.`);
  return lines.filter(l => l !== null).join('\n');
}

module.exports = { createUnsaved, closeDetail };
