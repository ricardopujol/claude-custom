'use strict';
/**
 * The quit's timeline, to a file, only when CLAUDE_CUSTOM_QUIT_LOG names one (BACKLOG #74 A, verify/probe-quit-linger.js).
 *
 * Every step of the way out gets a line `<ms since epoch> <step>`: the window's close and closed, before-quit, window-all-closed,
 * will-quit (first and last listener), quit, each page's webContents destroyed and any render process gone, and the process's own
 * exit. Synchronous appends: the last lines before a hard exit are the ones that matter. Off (every function a no-op) without the
 * variable, so a person's window writes nothing.
 */
const fs = require('fs');

function createQuitLog(file, { append = fs.appendFileSync, now = Date.now } = {}) {
  if (typeof file !== 'string' || file === '') return () => {};
  return (step) => { try { append(file, `${now()} ${step}\n`); } catch { /* a log must never break a quit */ } };
}

function wireQuitLog(app, mark, proc = process) {
  if (typeof mark !== 'function') return;
  app.prependListener('before-quit', () => mark('before-quit'));
  app.prependListener('window-all-closed', () => mark('window-all-closed'));
  app.prependListener('will-quit', (e) => mark(`will-quit first${e && e.defaultPrevented ? ' (prevented)' : ''}`));
  app.on('quit', () => mark('quit'));
  app.on('browser-window-created', (_e, w) => {
    const id = w.id;
    w.on('close', (e) => mark(`window ${id} close${e && e.defaultPrevented ? ' (prevented)' : ''}`));
    w.once('closed', () => mark(`window ${id} closed`));
  });
  app.on('web-contents-created', (_e, wc) => {
    const id = wc.id;
    const type = typeof wc.getType === 'function' ? wc.getType() : '?';
    wc.once('destroyed', () => mark(`webContents ${id} (${type}) destroyed`));
    wc.on('render-process-gone', (_ev, d) => mark(`webContents ${id} render-process-gone ${d && d.reason}`));
  });
  proc.on('exit', (code) => mark(`process exit ${code}`));
}

/** The last will-quit listener: registered after every other one, so it marks the end of them. */
function markWillQuitEnd(app, mark) {
  if (typeof mark !== 'function') return;
  app.on('will-quit', (e) => mark(`will-quit last${e && e.defaultPrevented ? ' (prevented)' : ''}`));
}

module.exports = { createQuitLog, wireQuitLog, markWillQuitEnd };
