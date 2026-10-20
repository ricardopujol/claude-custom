'use strict';
/**
 * Main's side of account profiles (BACKLOG #119 A1): the store on disk, the per-tab choice, the spawn environment, the switch with its
 * confirm, and the Accounts section's edits. Every effect is injected (the shell, the confirm dialog, "open this folder", the broadcast
 * to the pages) so the decisions are testable; the files are read fresh on every call, so another window's change shows here.
 *
 * Rules kept here, not in the pages:
 *   - a profiles file that can't be READ is never written over (the same rule as the tab marks);
 *   - a folder is only ever made (empty, for the CLI's own /login to fill) or opened: removing a profile forgets the entry and leaves
 *     the folder alone, always;
 *   - a session is never ended without a yes (`confirm`), and a no changes nothing.
 */
const fs = require('fs');
const os = require('os');
const P = require('../host/profiles');
const profileDisplay = require('./profile-display');

function createProfileService({
  dir = undefined, home = os.homedir(), shell, confirm, openPath, broadcast = () => {}, projectKeyOf,
  mkdir = (p) => fs.mkdirSync(p, { recursive: true }), log = () => {},
} = {}) {
  const pfile = () => P.profilesFile(dir);
  const cfile = () => P.choicesFile(dir);
  const theShell = () => (typeof shell === 'function' ? shell() : shell) || null;

  /** { state: 'ok' | 'missing', store } or { state: 'bad' }: a missing file is just no profiles yet. */
  function loadStore() {
    const r = P.readProfiles(pfile());
    if (r.state === 'ok') return r;
    if (r.state === 'missing') return { state: 'missing', store: { version: 1, profiles: [] } };
    return { state: 'bad', store: { version: 1, profiles: [] } };
  }

  function loadChoices() {
    const r = P.readChoices(cfile());
    return r.state === 'ok' ? r.choices : P.emptyChoices();
  }

  const listOf = (store) => P.listProfiles(store).map(p => ({ id: p.id, name: p.name, colour: p.colour, configDir: p.configDir }));
  const shortList = (store) => listOf(store).map(({ id, name, colour }) => ({ id, name, colour }));

  function inUse() {
    const s = theShell();
    try { return s ? [...s.profilesInUse()] : []; } catch { return []; }
  }

  /** What a page needs: the list, which are in use, and the asking tab's own profile (null for a sender that isn't a tab). */
  function stateFor(sender) {
    const { store } = loadStore();
    const s = theShell();
    let tab = null;
    try { tab = s && sender ? s.tabForSender(sender) : null; } catch { tab = null; }
    return { profiles: listOf(store), inUse: inUse(), current: tab && typeof tab.profileId === 'string' ? tab.profileId : null };
  }

  function changed(extra) {
    const s = theShell();
    try { broadcast(); } catch (err) { log('[profiles] broadcast failed:', err && err.message); }
    try { if (s && typeof s.refresh === 'function') s.refresh(); } catch { /* the strip redraws on its next poll */ }
    return { ok: true, ...extra, profiles: listOf(loadStore().store), inUse: inUse() };
  }

  /** Apply `edit(store)` -> { store } | { error } and write the result; never over a file that couldn't be read. */
  function edit(fn) {
    const loaded = loadStore();
    if (loaded.state === 'bad') return { ok: false, error: "couldn't read your profiles file, so it was left as it is" };
    const r = fn(loaded.store);
    if (!r || r.error) return { ok: false, error: (r && r.error) || 'nothing changed' };
    try { P.writeProfiles(pfile(), r.store); } catch (err) {
      log('[profiles] could not save:', err && err.message);
      return { ok: false, error: `couldn't save: ${(err && err.message) || err}` };
    }
    return changed({ profile: r.profile || null, removed: r.removed || null });
  }

  const add = (spec) => edit((store) => P.addProfile(store, spec, { home }));
  const rename = ({ id, name } = {}) => edit((store) => P.renameProfile(store, id, name));
  const remove = ({ id } = {}) => edit((store) => P.removeProfile(store, id, new Set(inUse())));

  // --- what the shell and the spawn ask for ----------------------------------------------------------------------------------

  function choose(tab) {
    const { store } = loadStore();
    return P.chooseFor(loadChoices(), store, { worktree: tab && tab.key, project: projectKeyOf ? projectKeyOf(tab) : undefined });
  }

  function resolve(id) {
    if (typeof id !== 'string') return null;
    const p = P.findProfile(loadStore().store, id);
    return p ? { id: p.id, name: p.name, colour: p.colour } : null;
  }

  /** A hand pick, remembered for the tab and as its project's last used. A choices file that can't be read is replaced only if it's absent. */
  function remember(tab, id) {
    const cur = P.readChoices(cfile());
    if (cur.state === 'bad') { log('[profiles] choices file unreadable; not remembering'); return; }
    const next = P.remember(cur.state === 'ok' ? cur.choices : P.emptyChoices(), { worktree: tab && tab.key, project: projectKeyOf ? projectKeyOf(tab) : undefined }, id);
    try { P.writeChoices(cfile(), next); } catch (err) { log('[profiles] could not remember the choice:', err && err.message); }
  }

  /**
   * The environment a tab's host is started with: `{ configDir, profileId }` for host/tab-env.js hostEnv. An id the store no longer has
   * degrades to the default (nothing set), never to a dangling folder. The folder is made empty if it isn't there, for the CLI to fill.
   */
  function spawnEnvFor(tab) {
    const id = tab && typeof tab.profileId === 'string' ? tab.profileId : null;
    if (id === null) return { configDir: null, profileId: null };
    const configDir = P.configDirFor(loadStore().store, id);
    if (configDir === null) return { configDir: null, profileId: 'default' };
    try { mkdir(configDir); } catch (err) { log('[profiles] could not make', configDir, err && err.message); }
    return { configDir, profileId: id };
  }

  // --- the switch ------------------------------------------------------------------------------------------------------------

  async function switchTo(sender, pickedId) {
    const s = theShell();
    const tab = s && sender ? s.tabForSender(sender) : null;
    if (!tab) return { ok: false, error: 'not a tab' };
    const { store } = loadStore();
    const plan = profileDisplay.planSwitch({ profiles: shortList(store), currentId: tab.profileId, pickedId, sessionLive: tab.started === true && tab.ended !== true });
    if (plan.action === 'refuse') return { ok: false, error: plan.reason };
    if (plan.action === 'none') return { ok: true, restarted: false };
    if (plan.action === 'confirm') {
      let yes = false;
      try { yes = (await confirm(plan.text)) === true; } catch { yes = false; }
      if (!yes) return { ok: false, cancelled: true };
    }
    return s.changeProfile(tab.key, plan.id);
  }

  async function openFolder({ id } = {}) {
    const p = id === 'default' ? null : P.findProfile(loadStore().store, id);
    if (!p || typeof p.configDir !== 'string') return { ok: false, error: id === 'default' ? "the default account's folder is Claude's own" : 'no such profile' };
    try { mkdir(p.configDir); } catch (err) { return { ok: false, error: `couldn't make the folder: ${(err && err.message) || err}` }; }
    const failed = await openPath(p.configDir);
    return failed ? { ok: false, error: String(failed) } : { ok: true };
  }

  return { stateFor, add, rename, remove, choose, resolve, remember, spawnEnvFor, switchTo, openFolder };
}

module.exports = { createProfileService };
