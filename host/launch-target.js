'use strict';
/**
 * Which folder did the user ask to open?
 *
 * Small, but it is the first thing anyone runs, so its failures are the first
 * ones they see. A typo must produce one clear line here rather than a window
 * opening on a folder that does not exist -- where `claude` fails inside the
 * pty and the message is buried in a TUI the user has not learned yet.
 */

const fs = require('fs');
const path = require('path');

function resolveLaunchTarget(arg, { cwd = process.cwd(), stat = fs.statSync } = {}) {
  const target = path.resolve(cwd, arg || '.');
  let info;
  try {
    info = stat(target);
  } catch {
    throw new Error(`no such folder: ${target}`);
  }
  if (!info.isDirectory()) throw new Error(`not a folder: ${target}`);
  return target;
}

module.exports = { resolveLaunchTarget };
