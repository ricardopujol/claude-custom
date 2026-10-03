'use strict';
/**
 * app/wand-display.js: what the wand panel shows and what each click means (BACKLOG #51). Pure: state in,
 * view / message out. renderer.js only wires the DOM and the socket, the split app/loadout-display.js uses.
 */
const test = require('node:test');
const assert = require('node:assert');

const W = require('../app/wand-display');

const SKILLS = [
  { name: 'bedtime', description: 'Overnight run.', source: 'user' },
  { name: 'checkpoint', description: 'Wrap up a chunk of work.', source: 'user' },
  { name: 'merged', description: 'After a merge.', source: 'user' },
  { name: 'vercel:deploy', description: 'Ship it.', source: 'plugin' },
];
const FAVS = [
  { id: 'f1', emoji: '🌙', skill: 'bedtime', args: '' },
  { id: 'f2', emoji: '✅', skill: 'checkpoint', args: 'wrap up' },
  { id: 'f3', emoji: '🔀', skill: 'gone', args: '' },
];
const wandMsg = (over = {}) => ({ status: 'ok', favourites: FAVS, unavailable: null, dropped: 0, skills: SKILLS, skillsError: null, ...over });
const hello = (over) => ({ type: 'hello', wand: wandMsg(over) });
const loaded = (over) => W.reduce(W.emptyState(), hello(over));

// --- reduce ----------------------------------------------------------------------------------------

test('before the hello the panel is loading, not empty', () => {
  const v = W.view(W.emptyState());
  assert.strictEqual(v.mode, 'loading');
  assert.deepStrictEqual(v.buttons, []);
  assert.match(v.note, /reading/i);
});

test('hello with a wand shows the favourites; a hello without one (an older host) is "not available", not an empty grid', () => {
  assert.strictEqual(W.view(loaded()).mode, 'ok');
  const old = W.reduce(W.emptyState(), { type: 'hello' });
  assert.strictEqual(W.view(old).mode, 'loading', 'nothing to show yet: say so, never draw zero buttons');
});

test('an UNAVAILABLE wand shows the reason and no grid and no way to add; never a grid of nothing', () => {
  const s = loaded({ status: 'unavailable', favourites: null, unavailable: 'the wand file is not valid JSON' });
  const v = W.view(s);
  assert.strictEqual(v.mode, 'unavailable');
  assert.deepStrictEqual(v.buttons, []);
  assert.match(v.note, /not valid JSON/);
  assert.strictEqual(v.canEdit, false);
  assert.match(W.html(v), /Wand unavailable/);
  assert.doesNotMatch(W.html(v), /data-wand-act="add"/);
});

test('a deliberately empty wand is OK and says it is empty, and (in edit mode) offers +', () => {
  const s = loaded({ favourites: [] });
  const v = W.view(s);
  assert.strictEqual(v.mode, 'ok');
  assert.match(v.note, /no favourites/i);
  assert.strictEqual(v.canEdit, true);
});

test('a frame from the host replaces the favourites wholesale, and a malformed one changes nothing', () => {
  let s = loaded();
  s = W.reduce(s, { type: 'wand', ok: true, quiet: true, ...wandMsg({ favourites: [FAVS[0]] }) });
  assert.strictEqual(W.view(s).buttons.length, 1);
  const before = JSON.stringify(s);
  for (const junk of [undefined, null, 5, 'x', {}, { type: 'wand' }, { type: 'wand', status: 'weird' }, { type: 'wand', status: 'ok', favourites: 'no' }]) {
    assert.strictEqual(JSON.stringify(W.reduce(s, junk)), before, JSON.stringify(junk));
  }
});

test('favourites with a bad shape are skipped, never drawn as a broken button', () => {
  const s = loaded({ favourites: [FAVS[0], null, 5, { id: 'x' }, { id: 'y', emoji: '🌙' }, { emoji: '🌙', skill: 'a' }, { id: 'ok', emoji: '🌙', skill: 'merged', args: 5 }] });
  assert.deepStrictEqual(W.view(s).buttons.map(b => b.id), ['f1', 'ok']);
  assert.strictEqual(W.view(s).buttons[1].args, '', 'a non-string args is "", not "5"');
});

test('the dropped count is said, so favourites that did not load are not silently gone', () => {
  const v = W.view(loaded({ dropped: 2 }));
  assert.match(v.warning, /2 favourites/);
  assert.strictEqual(W.view(loaded({ dropped: 1 })).warning.includes('1 favourite '), true);
  assert.strictEqual(W.view(loaded({ dropped: 0 })).warning, null);
});

// --- buttons ---------------------------------------------------------------------------------------

test('a button: the emoji, the command it types, and a hover with name, description and the pre-filled argument', () => {
  const [b1, b2] = W.view(loaded()).buttons;
  assert.strictEqual(b1.emoji, '🌙');
  assert.strictEqual(b1.command, '/bedtime');
  assert.match(b1.title, /\/bedtime/);
  assert.match(b1.title, /Overnight run\./);
  assert.doesNotMatch(b1.title, /pre-fills/i, 'no argument, no pre-fill line');
  assert.strictEqual(b2.command, '/checkpoint wrap up');
  assert.match(b2.title, /Wrap up a chunk of work\./);
  assert.match(b2.title, /pre-fills: wrap up/i);
});

test('a favourite whose skill no longer exists is DIMMED and says "skill not found"; clicking it types nothing', () => {
  const s = loaded();
  const gone = W.view(s).buttons[2];
  assert.strictEqual(gone.missing, true);
  assert.match(gone.title, /skill not found/i);
  const plan = W.clickPlan(s, 'f3');
  assert.strictEqual(plan.kind, 'missing');
  assert.match(plan.note, /\/gone/);
  assert.match(plan.note, /not found/i);
  assert.match(W.html(W.view(s)), /class="wand-btn dim"[^>]*data-wand-id="f3"|data-wand-id="f3"[^>]*class="wand-btn dim"|class="wand-btn dim"/);
});

test('when the skill list could NOT be read, nothing is dimmed: "could not look" is not "no such skill"', () => {
  const s = loaded({ skills: [], skillsError: 'EACCES' });
  const v = W.view(s);
  assert.ok(v.buttons.every(b => b.missing === false));
  assert.match(v.skillsNote, /EACCES/);
  assert.strictEqual(W.clickPlan(s, 'f3').kind, 'type');
});

test('a plugin skill is found under its plugin:name', () => {
  const s = loaded({ favourites: [{ id: 'p', emoji: '🚀', skill: 'vercel:deploy', args: '' }] });
  assert.strictEqual(W.view(s).buttons[0].missing, false);
  assert.match(W.view(s).buttons[0].title, /Ship it\./);
});

// --- click ------------------------------------------------------------------------------------------

test('a click (outside edit mode) plans typing the command, and NOTHING that submits it', () => {
  const plan = W.clickPlan(loaded(), 'f2');
  assert.deepStrictEqual(plan, { kind: 'type', command: '/checkpoint wrap up', id: 'f2' });
  assert.ok(!('enter' in plan) && !('submit' in plan), 'the plan has no Enter in it');
});

test('a click on an unknown id plans nothing', () => {
  for (const id of ['nope', undefined, null, 5, '__proto__']) assert.strictEqual(W.clickPlan(loaded(), id), null, String(id));
});

test('in edit mode a click on a button opens its editor, it does not type', () => {
  const s = W.toggleEdit(loaded());
  const plan = W.clickPlan(s, 'f2');
  assert.deepStrictEqual(plan, { kind: 'edit', id: 'f2' });
});

test('typed(): success flashes "typed, press Enter" on that button; a refusal says why, and clears no one else\'s note', () => {
  let s = W.typed(loaded(), 'f2', { ok: true });
  assert.deepStrictEqual(s.flash, { id: 'f2', text: 'typed, press Enter' });
  assert.strictEqual(W.view(s).buttons[1].flash, true);
  assert.strictEqual(W.view(s).buttons[0].flash, false);
  assert.match(W.view(s).status, /typed, press Enter/);
  s = W.typed(loaded(), 'f2', { ok: false, reason: 'a dialog is open in the terminal' });
  assert.strictEqual(s.flash, null);
  assert.match(W.view(s).status, /didn't type \/checkpoint wrap up: a dialog is open in the terminal/);
  assert.strictEqual(W.typed(loaded(), 'nope', { ok: true }).flash, null);
  assert.strictEqual(W.clearFlash(W.typed(loaded(), 'f2', { ok: true })).flash, null);
});

test('a flash never claims the CLI took it: the words are "typed, press Enter", nothing about running it', () => {
  const s = W.typed(loaded(), 'f1', { ok: true });
  assert.doesNotMatch(JSON.stringify(W.view(s)), /sent|ran|running|submitted/i);
});

// --- edit mode and the editor -------------------------------------------------------------------------

test('toggleEdit flips edit mode, and leaving it closes an open editor and clears an error', () => {
  let s = W.toggleEdit(loaded());
  assert.strictEqual(W.view(s).edit, true);
  s = W.openEditor(s, 'f1');
  assert.ok(W.view(s).editor);
  s = W.toggleEdit(s);
  assert.strictEqual(W.view(s).edit, false);
  assert.strictEqual(W.view(s).editor, null);
});

test('openEditor only works in edit mode, and for an existing id (or null for a new one)', () => {
  assert.strictEqual(W.view(W.openEditor(loaded(), 'f1')).editor, null, 'not in edit mode');
  const s = W.toggleEdit(loaded());
  assert.strictEqual(W.view(W.openEditor(s, 'nope')).editor, null);
  const e = W.view(W.openEditor(s, 'f2')).editor;
  assert.deepStrictEqual([e.id, e.emoji, e.skill, e.args], ['f2', '✅', 'checkpoint', 'wrap up']);
  const n = W.view(W.openEditor(s, null)).editor;
  assert.deepStrictEqual([n.id, n.emoji, n.skill, n.args], [null, '', '', '']);
  assert.strictEqual(n.isNew, true);
});

test('the editor offers a small emoji picker, and free entry', () => {
  const e = W.view(W.openEditor(W.toggleEdit(loaded()), null)).editor;
  assert.ok(e.emojiChoices.length >= 24);
  assert.ok(e.emojiChoices.every(x => typeof x === 'string' && x.length > 0));
  assert.strictEqual(new Set(e.emojiChoices).size, e.emojiChoices.length, 'no repeats');
  assert.ok(e.emojiChoices.includes('🌙') && e.emojiChoices.includes('✅'));
});

test('editorSet takes only the editor\'s four fields, and ignores anything else', () => {
  let s = W.openEditor(W.toggleEdit(loaded()), null);
  s = W.editorSet(s, 'emoji', '🚀');
  s = W.editorSet(s, 'skill', 'merged');
  s = W.editorSet(s, 'args', 'now');
  s = W.editorSet(s, 'query', 'mer');
  s = W.editorSet(s, '__proto__', 'x');
  s = W.editorSet(s, 'id', 'hacked');
  const e = W.view(s).editor;
  assert.deepStrictEqual([e.emoji, e.skill, e.args, e.query, e.id], ['🚀', 'merged', 'now', 'mer', null]);
  assert.strictEqual(W.editorSet(loaded(), 'emoji', 'x').editor, null, 'no editor open: nothing to set');
});

test('the skill list filters by name or description, case-insensitive, name matches first, capped and counted', () => {
  assert.deepStrictEqual(W.filterSkills(SKILLS, '').map(s => s.name), ['bedtime', 'checkpoint', 'merged', 'vercel:deploy']);
  assert.deepStrictEqual(W.filterSkills(SKILLS, 'MER').map(s => s.name), ['merged']);
  assert.deepStrictEqual(W.filterSkills(SKILLS, 'merge').map(s => s.name), ['merged']);
  assert.deepStrictEqual(W.filterSkills(SKILLS, 'wrap').map(s => s.name), ['checkpoint'], 'matches the description too');
  assert.deepStrictEqual(W.filterSkills(SKILLS, 'deploy').map(s => s.name), ['vercel:deploy']);
  assert.deepStrictEqual(W.filterSkills(SKILLS, 'zzz'), []);
  const ranked = W.filterSkills([{ name: 'x', description: 'about check', source: 'user' }, { name: 'check', description: '', source: 'user' }], 'check');
  assert.deepStrictEqual(ranked.map(s => s.name), ['check', 'x'], 'a name match beats a description match');
  assert.deepStrictEqual(W.filterSkills(null, 'a'), []);
  assert.deepStrictEqual(W.filterSkills(SKILLS, '  mer  ').map(s => s.name), ['merged'], 'the query is trimmed');
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, description: '', source: 'user' }));
  assert.strictEqual(W.filterSkills(many, '').length, W.SKILL_LIST_CAP);
  assert.strictEqual(W.view(W.editorSet(W.openEditor(W.toggleEdit(loaded({ skills: many })), null), 'query', 's')).editor.moreSkills, 200 - W.SKILL_LIST_CAP);
});

test('an editor for a favourite whose skill is gone keeps that skill selected and says it is not found', () => {
  const e = W.view(W.openEditor(W.toggleEdit(loaded()), 'f3')).editor;
  assert.strictEqual(e.skill, 'gone');
  assert.strictEqual(e.skillMissing, true);
  assert.match(W.html(W.view(W.openEditor(W.toggleEdit(loaded()), 'f3'))), /skill not found/i);
});

test('editorSubmit: a NEW favourite becomes wand-add; an existing one becomes wand-update with a patch', () => {
  let s = W.openEditor(W.toggleEdit(loaded()), null);
  s = W.editorSet(W.editorSet(W.editorSet(s, 'emoji', '🚀'), 'skill', 'merged'), 'args', '  now ');
  let r = W.editorSubmit(s);
  assert.deepStrictEqual(r.message, { type: 'wand-add', emoji: '🚀', skill: 'merged', args: '  now ' }, 'the host cleans the args; the page sends what was typed');
  assert.strictEqual(W.view(r.state).editor.saving, true);

  s = W.openEditor(W.toggleEdit(loaded()), 'f1');
  s = W.editorSet(s, 'emoji', '🚀');
  r = W.editorSubmit(s);
  assert.deepStrictEqual(r.message, { type: 'wand-update', id: 'f1', patch: { emoji: '🚀', skill: 'bedtime', args: '' } });
});

test('editorSubmit with nothing to send (no emoji, no skill) says what is missing and sends nothing', () => {
  let r = W.editorSubmit(W.openEditor(W.toggleEdit(loaded()), null));
  assert.strictEqual(r.message, null);
  assert.match(W.view(r.state).error, /emoji/i);
  let s = W.editorSet(W.openEditor(W.toggleEdit(loaded()), null), 'emoji', '🚀');
  r = W.editorSubmit(s);
  assert.strictEqual(r.message, null);
  assert.match(W.view(r.state).error, /skill/i);
  assert.strictEqual(W.editorSubmit(loaded()).message, null, 'no editor open');
});

test('an answer to MY save closes the editor; a refusal keeps it open with the host\'s reason', () => {
  let s = W.openEditor(W.toggleEdit(loaded()), null);
  s = W.editorSet(W.editorSet(s, 'emoji', '🚀'), 'skill', 'merged');
  s = W.editorSubmit(s).state;
  const okFrame = { type: 'wand', ok: true, reason: null, ...wandMsg({ favourites: [...FAVS, { id: 'f4', emoji: '🚀', skill: 'merged', args: '' }] }) };
  const closed = W.reduce(s, okFrame);
  assert.strictEqual(W.view(closed).editor, null);
  assert.strictEqual(W.view(closed).buttons.length, 4);

  const bad = W.reduce(s, { type: 'wand', ok: false, reason: 'Pick one emoji.', ...wandMsg() });
  assert.ok(W.view(bad).editor, 'the editor stays so the user can fix it');
  assert.strictEqual(W.view(bad).editor.saving, false);
  assert.strictEqual(W.view(bad).error, 'Pick one emoji.');
});

test('a refusal answers ONE window: one that did not ask does not show it (the PR #64 N1 / Dexter F6 trap)', () => {
  const s = loaded();
  const other = W.reduce(s, { type: 'wand', ok: false, reason: 'someone else\'s refusal', ...wandMsg() });
  assert.strictEqual(W.view(other).error, null);
  const asked = W.reduce(W.ask(s), { type: 'wand', ok: false, reason: 'mine', ...wandMsg() });
  assert.strictEqual(W.view(asked).error, 'mine');
});

test('a QUIET frame neither sets nor clears an error, but does bring the favourites up to date', () => {
  let s = W.reduce(W.ask(loaded()), { type: 'wand', ok: false, reason: 'mine', ...wandMsg() });
  s = W.reduce(s, { type: 'wand', ok: true, quiet: true, ...wandMsg({ favourites: [FAVS[0]] }) });
  assert.strictEqual(W.view(s).error, 'mine', 'an echo must never wipe a refusal on screen');
  assert.strictEqual(W.view(s).buttons.length, 1);
});

test('a real success clears the error (for the window that asked)', () => {
  let s = W.reduce(W.ask(loaded()), { type: 'wand', ok: false, reason: 'mine', ...wandMsg() });
  s = W.reduce(W.ask(s), { type: 'wand', ok: true, reason: null, ...wandMsg() });
  assert.strictEqual(W.view(s).error, null);
});

test('an open editor survives a quiet refresh (another host edited): the user\'s typing is not thrown away', () => {
  let s = W.editorSet(W.openEditor(W.toggleEdit(loaded()), 'f1'), 'args', 'half typed');
  s = W.reduce(s, { type: 'wand', ok: true, quiet: true, ...wandMsg({ favourites: [FAVS[0], FAVS[1]] }) });
  assert.strictEqual(W.view(s).editor.args, 'half typed');
});

test('an editor whose favourite was deleted by another host closes itself rather than saving into nothing', () => {
  let s = W.openEditor(W.toggleEdit(loaded()), 'f2');
  s = W.reduce(s, { type: 'wand', ok: true, quiet: true, ...wandMsg({ favourites: [FAVS[0]] }) });
  assert.strictEqual(W.view(s).editor, null);
});

test('an unavailable frame closes the editor and leaves edit mode', () => {
  let s = W.openEditor(W.toggleEdit(loaded()), 'f2');
  s = W.reduce(s, { type: 'wand', ok: true, quiet: true, ...wandMsg({ status: 'unavailable', favourites: null, unavailable: 'x' }) });
  const v = W.view(s);
  assert.strictEqual(v.editor, null);
  assert.strictEqual(v.edit, false);
});

test('delete and move build the messages the host answers, and ask for the answer', () => {
  let s = W.toggleEdit(loaded());
  let r = W.deleteMsg(s, 'f2');
  assert.deepStrictEqual(r.message, { type: 'wand-delete', id: 'f2' });
  assert.strictEqual(r.state.asked, true);
  assert.strictEqual(W.deleteMsg(s, 'nope').message, null);
  r = W.moveMsg(s, 'f1', 'f3');
  assert.deepStrictEqual(r.message, { type: 'wand-move', id: 'f1', to: 2 });
  r = W.moveMsg(s, 'f3', 'f1');
  assert.deepStrictEqual(r.message, { type: 'wand-move', id: 'f3', to: 0 });
  assert.strictEqual(W.moveMsg(s, 'f1', 'f1').message, null, 'dropped on itself: nothing to say');
  assert.strictEqual(W.moveMsg(s, 'f1', 'nope').message, null);
  assert.strictEqual(W.moveMsg(s, 'nope', 'f1').message, null);
});

test('edits are only offered in edit mode', () => {
  const s = loaded();
  assert.strictEqual(W.deleteMsg(s, 'f1').message, null);
  assert.strictEqual(W.moveMsg(s, 'f1', 'f2').message, null);
});

test('skillsRequest is what opening the module sends', () => {
  assert.deepStrictEqual(W.skillsRequest(), { type: 'wand-skills' });
});

// --- html -----------------------------------------------------------------------------------------------

test('html: every control is a <button>, tagged with what it does; hostile text is escaped', () => {
  const evil = loaded({ favourites: [{ id: 'f1', emoji: '🌙', skill: 'bedtime', args: '"><img src=x onerror=alert(1)>' }], skills: [{ name: 'bedtime', description: '<script>x</script>', source: 'user' }] });
  const html = W.html(W.view(evil));
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<button type="button" class="wand-btn"[^>]*data-wand-act="press"[^>]*data-wand-id="f1"/);
  assert.match(html, /data-wand-act="toggle-edit"/);
});

test('html: edit mode shows ✕ on each button, draggable, and + ; normal mode shows none of them', () => {
  const normal = W.html(W.view(loaded()));
  assert.doesNotMatch(normal, /data-wand-act="delete"/);
  assert.doesNotMatch(normal, /draggable/);
  assert.doesNotMatch(normal, /data-wand-act="add"/);
  const edit = W.html(W.view(W.toggleEdit(loaded())));
  assert.strictEqual((edit.match(/data-wand-act="delete"/g) || []).length, 3);
  assert.strictEqual((edit.match(/draggable="true"/g) || []).length, 3);
  assert.match(edit, /data-wand-act="add"/);
});

test('html: the editor has the emoji picker, a free-entry field, a search field, the skill list, args and Save / Cancel', () => {
  const html = W.html(W.view(W.openEditor(W.toggleEdit(loaded()), null)));
  assert.match(html, /data-wand-field="emoji"/);
  assert.match(html, /data-wand-field="query"/);
  assert.match(html, /data-wand-field="args"/);
  assert.match(html, /data-wand-act="pick-emoji" data-wand-emoji="🌙"/);
  assert.match(html, /data-wand-act="pick-skill" data-wand-skill="checkpoint"/);
  assert.match(html, /data-wand-act="save"/);
  assert.match(html, /data-wand-act="cancel"/);
  assert.match(W.skillListHtml(W.view(W.openEditor(W.toggleEdit(loaded()), null))), /data-wand-skill="merged"/);
});

test('html: the picked skill is marked, and the free-entry emoji is the editor\'s value', () => {
  const html = W.html(W.view(W.openEditor(W.toggleEdit(loaded()), 'f2')));
  assert.match(html, /class="wand-skill on"[^>]*data-wand-skill="checkpoint"|data-wand-skill="checkpoint"[^>]*class="wand-skill on"/);
  assert.match(html, /data-wand-field="emoji"[^>]*value="✅"|value="✅"[^>]*data-wand-field="emoji"/);
});

test('html: the error and the status line are drawn in their own roles', () => {
  const s = W.reduce(W.ask(loaded()), { type: 'wand', ok: false, reason: 'Pick one emoji.', ...wandMsg() });
  assert.match(W.html(W.view(s)), /role="alert"[^>]*>Pick one emoji\./);
  assert.match(W.html(W.view(W.typed(loaded(), 'f1', { ok: true }))), /role="status"[^>]*>[^<]*typed, press Enter/);
});

test('html: with the editor open the refusal sits at its TOP, once: a reason below a tall editor is out of sight', () => {
  const s = W.reduce(W.ask(W.openEditor(W.toggleEdit(loaded()), null)), { type: 'wand', ok: false, reason: 'Pick one emoji.', ...wandMsg() });
  const html = W.html(W.view(s));
  assert.strictEqual((html.match(/role="alert"/g) || []).length, 1);
  assert.ok(html.indexOf('role="alert"') < html.indexOf('data-wand-field="emoji"'), 'the alert comes before the fields');
  assert.ok(html.indexOf('role="alert"') > html.indexOf('wand-editor'), 'and inside the editor');
});

test('clickAction: a dataset becomes an action; junk becomes null', () => {
  assert.deepStrictEqual(W.clickAction({ wandAct: 'toggle-edit' }), { kind: 'toggle-edit' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'press', wandId: 'f1' }), { kind: 'press', id: 'f1' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'delete', wandId: 'f1' }), { kind: 'delete', id: 'f1' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'add' }), { kind: 'add' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'save' }), { kind: 'save' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'cancel' }), { kind: 'cancel' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'pick-skill', wandSkill: 'merged' }), { kind: 'pick-skill', skill: 'merged' });
  assert.deepStrictEqual(W.clickAction({ wandAct: 'pick-emoji', wandEmoji: '🚀' }), { kind: 'pick-emoji', emoji: '🚀' });
  for (const junk of [undefined, null, {}, { wandAct: 'nope' }, { wandAct: 'press' }, { wandAct: 'delete' }, { wandAct: 'pick-skill' }, { wandAct: 'pick-emoji', wandEmoji: '' }, { wandAct: '__proto__' }]) {
    assert.strictEqual(W.clickAction(junk), null, JSON.stringify(junk));
  }
});

test('failed(): an edit that never left the window is shown now, and a save in flight is released', () => {
  let s = W.openEditor(W.toggleEdit(loaded()), null);
  s = W.editorSet(W.editorSet(s, 'emoji', '🚀'), 'skill', 'merged');
  s = W.editorSubmit(s).state;
  assert.strictEqual(W.view(s).editor.saving, true);
  const f = W.failed(s, 'not connected to the host');
  assert.strictEqual(W.view(f).error, 'not connected to the host');
  assert.strictEqual(W.view(f).editor.saving, false);
  assert.strictEqual(f.asked, false);
  assert.strictEqual(W.view(W.failed(loaded(), '')).error, 'the wand was not changed');
});

// --- Dexter D2 / Miguel I1: invalid favourites turn editing off, and the warning says so ---------------------

test('D2/I1: while favourites in the file did not load, editing is OFF and the warning says why and where', () => {
  const s = W.toggleEdit(loaded({ dropped: 2, file: 'C:/x/.harness/state/wand.json' }));
  const v = W.view(s);
  assert.strictEqual(v.canEdit, false);
  assert.strictEqual(v.edit, false);
  assert.match(v.warning, /2 favourites/);
  assert.match(v.warning, /editing is off/i);
  assert.match(v.warning, /C:\/x\/\.harness\/state\/wand\.json/);
  const html = W.html(v);
  assert.doesNotMatch(html, /data-wand-act="toggle-edit"/);
  assert.doesNotMatch(html, /data-wand-act="add"/);
  assert.strictEqual(W.openEditor(s, 'f1').editor, null);
  assert.strictEqual(W.deleteMsg(s, 'f1').message, null);
});
