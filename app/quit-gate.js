'use strict';
/**
 * The quit gate (single-instance PR 3, step 11): a quit asks ONCE for the unsaved code-reader text of every window, instead of one
 * question per window as each closes. It runs in before-quit, BEFORE any claim stops, so Cancel has nothing to undo. No Electron.
 *
 *   createQuitGate(deps) -> { onBeforeQuit(event) -> held?, reset() }
 *
 *   no unsaved text anywhere        not held: the quit goes on
 *   unsaved text                    held (event.preventDefault()); ONE question (a second quit while it is up stacks nothing):
 *     Discard                       allowClose() on each dirty window (its own close prompt will not ask again), then quit() once
 *     Save                          saveAll() on each dirty window; every one cleared -> as Discard; one not cleared -> notify, no quit,
 *                                   nothing allowed
 *     Cancel                        nothing; the next quit asks again
 *   approved                        the quit() that follows passes the gate (until reset())
 *   probe                           nobody to click: the answer is discard, and one { label: 'quit', reason, unsaved } entry is recorded
 *
 * reset() is the window's own fallback prompt answering Cancel (main's quitCancelled): the next quit asks again.
 *
 * deps: windows() -> [{ label, unsaved() -> files, saveAll(), allowClose() }], ask(dirty) -> Promise<'save'|'discard'|'cancel'>
 *       (dirty: [{ label, files }]), notify(detail), waitCleared(window) -> Promise<bool>, quit(), probe, record(entry), log.
 */

const QUESTION = {
  message: 'Quit Jiandu with unsaved changes?',
  buttons: ['Save all and quit', 'Discard and quit', 'Cancel'],
};

/** The question's words (§5 Q3 default): one line per window, `<project>: <files>`. */
function questionText(dirty) {
  return {
    message: QUESTION.message,
    detail: dirty.map((d) => `${d.label}: ${d.files.join(', ')}`).join('\n'),
    buttons: [...QUESTION.buttons],
  };
}

function createQuitGate({ windows, ask, notify, waitCleared, quit, probe = false, record = () => {}, log = () => {} }) {
  let asking = false;
  let approved = false;

  const dirtyNow = () => {
    const out = [];
    for (const w of windows()) {
      let files = [];
      try { files = w.unsaved(); } catch { files = []; }
      if (Array.isArray(files) && files.length) out.push({ w, label: w.label, files: [...files] });
    }
    return out;
  };

  async function settle(dirty) {
    let answer;
    if (probe) {
      record({ label: 'quit', reason: '', unsaved: dirty.map((d) => ({ window: d.label, files: d.files })) });
      answer = 'discard';
    } else {
      try { answer = await ask(dirty.map(({ label, files }) => ({ label, files }))); } catch (err) { log(`[main] the quit question failed: ${err && err.message}`); answer = 'cancel'; }
    }
    if (answer === 'save') {
      for (const d of dirty) { try { d.w.saveAll(); } catch { /* counted as not cleared below */ } }
      const cleared = await Promise.all(dirty.map((d) => Promise.resolve(waitCleared(d.w)).catch(() => false)));
      if (!cleared.every((c) => c === true)) {
        notify('Some files could not be saved, so Jiandu did not quit.');
        return;
      }
    } else if (answer !== 'discard') {
      return;                               // Cancel (or anything else): nothing allowed, nothing quit
    }
    for (const d of dirty) { try { d.w.allowClose(); } catch { /* the window is already gone */ } }
    approved = true;
    quit();
  }

  function onBeforeQuit(event) {
    if (approved) return false;
    if (asking) { event.preventDefault(); return true; }
    const dirty = dirtyNow();
    if (!dirty.length) return false;
    event.preventDefault();
    asking = true;
    Promise.resolve().then(() => settle(dirty)).catch((err) => log(`[main] quit gate: ${err && err.message}`)).finally(() => { asking = false; });
    return true;
  }

  function reset() { approved = false; }

  return { onBeforeQuit, reset };
}

module.exports = { createQuitGate, questionText };
