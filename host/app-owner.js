'use strict';
/**
 * The app lock's owner file (single-instance PR 3): `<dir>\app.json` = { pid, start, at }, the Electron main that is THE Jiandu process of
 * this install. The proof is host/owner-file.js (the same one host/window-owner.js uses); this only says where the file is. Same signatures
 * as host/window-owner.js (stateRoot is the lock's folder), so host/window-claim.js runs it unchanged (host/app-claim.js).
 */

const fs = require('fs');
const path = require('path');
const core = require('./owner-file');

const APP_FILE = 'app.json';

const fileOf = (dir) => path.join(dir, APP_FILE);
const placeOf = (dir) => ({ file: fileOf(dir), usable: () => true, prepare: () => fs.mkdirSync(dir, { recursive: true }) });

function claim({ stateRoot, self, startTimes, ask, resolveStart, now = Date.now, link, hooks = {} } = {}) {
  return core.claimFile({ ...placeOf(stateRoot), self, startTimes, ask, resolveStart, now, link, hooks });
}

function takeOver({ stateRoot, self, judgedText = null, now = Date.now, link } = {}) {
  return core.takeOverFile({ ...placeOf(stateRoot), self, judgedText, now, link });
}

function release({ stateRoot, selfPid, selfStart, hooks = {} } = {}) {
  return core.releaseFile({ file: fileOf(stateRoot), selfPid, selfStart, hooks });
}

/** The record on file, or null (none, or not a proof). For the probe driver's appLock command. */
function read(dir) {
  const text = core.readRaw(fileOf(dir));
  return text === null ? null : core.parseOwner(text);
}

module.exports = { APP_FILE, fileOf, claim, takeOver, release, read };
