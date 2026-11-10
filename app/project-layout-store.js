'use strict';
/**
 * The store the dock layout bridge reads and writes (BACKLOG #211): each project keeps its OWN layout, in its own
 * `<project>\.claude-custom\` beside `tab-strip.json`, so moving a panel in one project's window no longer moves it
 * in every other project's.
 *
 *   reads    the project's own file first. Only when the project has none yet (`missing`) does the install-wide
 *            file answer, as the first-open default. An unreadable or corrupt project file is said so as it is:
 *            the default never papers over a file the person's layout may still be in.
 *   writes   always the project's own file. The install-wide file is never written by this store.
 *
 * Shaped like host/store.js for the four calls the layout bridge makes (read, readState, update, write) plus
 * pathOf, which names the file the bridge's watcher follows: the project's own, so another project's change is
 * never pushed here. Presets stay install-wide on purpose (a saved preset is meant to be reused), so they keep
 * the plain store and never come through this one.
 *
 * `prepare()` runs before every write: main passes the look folder's guard (a `.claude-custom` that is a link
 * elsewhere is never written through; a fresh one gets its .gitignore). If it throws, nothing is saved.
 */
function createProjectLayoutStore({ project, fallback, prepare, usable, log = () => {} }) {
  // `usable()` is the read side of `prepare` (PR #251 Miguel G5): a `.claude-custom` that is a link elsewhere is refused on every
  // write, so it is not read through either; the page is told "unreadable" (and saves nothing) rather than shown a layout it can't keep.
  function readState(name) {
    if (typeof usable === 'function' && !usable()) {
      log(`[layout] ${name}: the project's .claude-custom is a link to somewhere else; its layout is not read`);
      return { status: 'unreadable', value: null, error: new Error('.claude-custom is a link to somewhere else') };
    }
    const own = project.readState(name);
    if (own.status !== 'missing') return own;
    return fallback.readState(name);
  }
  function read(name, dflt) {
    const st = readState(name);
    return st.status === 'ok' ? st.value : dflt;
  }
  function write(name, value) {
    if (typeof prepare === 'function') prepare();
    return project.write(name, value);
  }
  function update(name, dflt, fn) {
    return write(name, fn(read(name, dflt)));
  }
  return { read, readState, write, update, pathOf: (name) => project.pathOf(name), dir: project.dir };
}

module.exports = { createProjectLayoutStore };
