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
  assert.deepStrictEqual(plan, { kind: 'type', command: '/checkpoint wrap up', id: 'f2', typeOnly: false });
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

test('a result with no flash text of its own (a type-only favourite, an old caller) says "typed, press Enter", nothing about running it', () => {
  const s = W.typed(loaded(), 'f1', { ok: true });
  assert.doesNotMatch(JSON.stringify(W.view(s)), /sent|ran|running|submitted|queued/i);
});

test('#61 typed(): the flash is the submit gate\'s own words, so "sent" and "queued" are only ever said when Enter went in', () => {
  const sent = W.typed(loaded(), 'f1', { ok: true, flash: 'sent' });
  assert.deepStrictEqual(sent.flash, { id: 'f1', text: 'sent' });
  const queued = W.typed(loaded(), 'f1', { ok: true, flash: "queued: Claude runs it when it's free" });
  assert.match(W.view(queued).status, /queued: Claude runs it when it's free/);
  for (const bad of ['', null, 5, undefined, {}]) {
    assert.strictEqual(W.typed(loaded(), 'f1', { ok: true, flash: bad }).flash.text, 'typed, press Enter', String(bad));
  }
  const refused = W.typed(loaded(), 'f1', { ok: false, flash: 'sent', reason: 'a dialog is open' });
  assert.strictEqual(refused.flash, null, 'a refusal never flashes, whatever flash it carries');
});

// --- #61: type only, and the name under the emoji ---------------------------------------------------------

const TO = [
  { id: 'a', emoji: '🌙', skill: 'bedtime', args: '', typeOnly: true },
  { id: 'b', emoji: '✅', skill: 'checkpoint', args: 'wrap up', typeOnly: false },
  { id: 'c', emoji: '🔀', skill: 'merged', args: '' },
  { id: 'd', emoji: '🚀', skill: 'vercel:deploy', args: '', typeOnly: 'yes' },
];

test('#61 the panel keeps typeOnly as a strict boolean: true stays true; absent and non-boolean are false', () => {
  const s = loaded({ favourites: TO });
  assert.deepStrictEqual(s.favourites.map(f => f.typeOnly), [true, false, false, false]);
  assert.deepStrictEqual(W.view(s).buttons.map(b => b.typeOnly), [true, false, false, false]);
});

test('#61 a click plan carries the favourite\'s typeOnly (the gate is asked with it)', () => {
  const s = loaded({ favourites: TO });
  assert.strictEqual(W.clickPlan(s, 'a').typeOnly, true);
  assert.strictEqual(W.clickPlan(s, 'b').typeOnly, false);
  assert.strictEqual(W.clickPlan(s, 'c').typeOnly, false);
});

test('#61 each button shows the skill name under the emoji; the full /skill args stays in title and accessible name', () => {
  const s = loaded({ favourites: TO });
  const html = W.html(W.view(s));
  assert.match(html, /<span class="wand-emoji">🌙<\/span><span class="wand-name">bedtime<\/span>/);
  assert.match(html, /<span class="wand-emoji">🚀<\/span><span class="wand-name">vercel:deploy<\/span>/);
  const b = W.view(s).buttons[1];
  assert.strictEqual(b.name, 'checkpoint', 'the name is the skill, not the args');
  assert.match(b.title, /\/checkpoint/);
  assert.match(b.title, /pre-fills: wrap up/);
  assert.strictEqual(b.label, '/checkpoint wrap up');
  assert.match(html, /aria-label="\/checkpoint wrap up"/);
});

test('#61 a skill name is escaped where it is drawn under the emoji', () => {
  const s = loaded({ favourites: [{ id: 'x', emoji: '🌙', skill: '<img src=x onerror=1>', args: '' }] });
  const html = W.html(W.view(s));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /wand-name">&lt;img/);
});

test('#61 a type-only favourite says so in its title (so a hover explains why a click does not run it)', () => {
  const v = W.view(loaded({ favourites: TO }));
  assert.match(v.buttons[0].title, /type only/i);
  assert.doesNotMatch(v.buttons[1].title, /type only/i);
});

test('#61 the editor has a "type only" checkbox: unchecked for a new favourite, as saved for an existing one', () => {
  const edit = (id) => W.openEditor(W.toggleEdit(loaded({ favourites: TO })), id);
  assert.strictEqual(W.view(edit(null)).editor.typeOnly, false);
  assert.strictEqual(W.view(edit('a')).editor.typeOnly, true);
  assert.strictEqual(W.view(edit('b')).editor.typeOnly, false);
  assert.match(W.html(W.view(edit('a'))), /<input type="checkbox"[^>]*data-wand-field="typeOnly"[^>]*checked/);
  assert.doesNotMatch(W.html(W.view(edit('b'))), /data-wand-field="typeOnly"[^>]*checked/);
  assert.match(W.html(W.view(edit('b'))), /data-wand-field="typeOnly"/);
});

test('#61 editorSet takes typeOnly as a boolean only, and the other fields as strings only', () => {
  let s = W.openEditor(W.toggleEdit(loaded({ favourites: TO })), 'a');
  assert.strictEqual(s.editor.typeOnly, true);
  for (const bad of ['false', 0, null, undefined, {}]) assert.strictEqual(W.editorSet(s, 'typeOnly', bad).editor.typeOnly, true, String(bad));
  s = W.editorSet(s, 'typeOnly', false);
  assert.strictEqual(s.editor.typeOnly, false);
  assert.strictEqual(W.editorSet(s, 'typeOnly', true).editor.typeOnly, true);
  assert.strictEqual(W.editorSet(s, 'skill', true).editor.skill, 'bedtime', 'a boolean is not a skill name');
});

test('#61 Save sends typeOnly: with a new favourite and in the update patch', () => {
  let s = W.openEditor(W.toggleEdit(loaded({ favourites: TO })), null);
  s = W.editorSet(W.editorSet(W.editorSet(s, 'emoji', '🚀'), 'skill', 'merged'), 'typeOnly', true);
  let r = W.editorSubmit(s);
  assert.strictEqual(r.message.type, 'wand-add');
  assert.strictEqual(r.message.typeOnly, true);
  s = W.editorSet(W.openEditor(W.toggleEdit(loaded({ favourites: TO })), 'a'), 'typeOnly', false);
  r = W.editorSubmit(s);
  assert.deepStrictEqual(r.message.patch, { emoji: '🌙', skill: 'bedtime', args: '', typeOnly: false });
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
  assert.deepStrictEqual(r.message, { type: 'wand-add', emoji: '🚀', skill: 'merged', args: '  now ', typeOnly: false, req: r.message.req }, 'the host cleans the args; the page sends what was typed');
  assert.strictEqual(W.view(r.state).editor.saving, true);

  s = W.openEditor(W.toggleEdit(loaded()), 'f1');
  s = W.editorSet(s, 'emoji', '🚀');
  r = W.editorSubmit(s);
  assert.deepStrictEqual(r.message, { type: 'wand-update', id: 'f1', patch: { emoji: '🚀', skill: 'bedtime', args: '', typeOnly: false }, req: r.message.req });
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
  const sub = W.editorSubmit(s);
  s = sub.state;
  const req = sub.message.req;
  const okFrame = { type: 'wand', ok: true, reason: null, req, ...wandMsg({ favourites: [...FAVS, { id: 'f4', emoji: '🚀', skill: 'merged', args: '' }] }) };
  const closed = W.reduce(s, okFrame);
  assert.strictEqual(W.view(closed).editor, null);
  assert.strictEqual(W.view(closed).buttons.length, 4);

  const bad = W.reduce(s, { type: 'wand', ok: false, req, reason: 'Pick one emoji.', ...wandMsg() });
  assert.ok(W.view(bad).editor, 'the editor stays so the user can fix it');
  assert.strictEqual(W.view(bad).editor.saving, false);
  assert.strictEqual(W.view(bad).error, 'Pick one emoji.');
});

test('a refusal answers ONE window: one that did not ask does not show it (the PR #64 N1 / Dexter F6 trap)', () => {
  const s = loaded();
  const other = W.reduce(s, { type: 'wand', ok: false, reason: 'someone else\'s refusal', ...wandMsg() });
  assert.strictEqual(W.view(other).error, null);
  const b = W.begin(s);
  const asked = W.reduce(b.state, { type: 'wand', ok: false, req: b.req, reason: 'mine', ...wandMsg() });
  assert.strictEqual(W.view(asked).error, 'mine');
});

test('a QUIET frame neither sets nor clears an error, but does bring the favourites up to date', () => {
  const b = W.begin(loaded());
  let s = W.reduce(b.state, { type: 'wand', ok: false, req: b.req, reason: 'mine', ...wandMsg() });
  s = W.reduce(s, { type: 'wand', ok: true, quiet: true, ...wandMsg({ favourites: [FAVS[0]] }) });
  assert.strictEqual(W.view(s).error, 'mine', 'an echo must never wipe a refusal on screen');
  assert.strictEqual(W.view(s).buttons.length, 1);
});

test('a real success clears the error (for the window that asked)', () => {
  const b1 = W.begin(loaded());
  let s = W.reduce(b1.state, { type: 'wand', ok: false, req: b1.req, reason: 'mine', ...wandMsg() });
  const b2 = W.begin(s);
  s = W.reduce(b2.state, { type: 'wand', ok: true, req: b2.req, reason: null, ...wandMsg() });
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
  assert.deepStrictEqual(r.message, { type: 'wand-delete', id: 'f2', req: r.message.req });
  assert.strictEqual(typeof r.message.req, 'string');
  assert.ok(r.state.pending.includes(r.message.req), 'the answer to this request is awaited');
  assert.strictEqual(W.deleteMsg(s, 'nope').message, null);
  r = W.moveMsg(s, 'f1', 'f3');
  assert.deepStrictEqual(r.message, { type: 'wand-move', id: 'f1', target: 'f3', req: r.message.req });
  r = W.moveMsg(s, 'f3', 'f1');
  assert.deepStrictEqual(r.message, { type: 'wand-move', id: 'f3', target: 'f1', req: r.message.req });
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
  const b = W.begin(loaded());
  const s = W.reduce(b.state, { type: 'wand', ok: false, req: b.req, reason: 'Pick one emoji.', ...wandMsg() });
  assert.match(W.html(W.view(s)), /class="wand-error"[^>]*>Pick one emoji\./);
  assert.match(W.html(W.view(W.typed(loaded(), 'f1', { ok: true }))), /class="wand-status"[^>]*>[^<]*typed, press Enter/);
});

test('html: with the editor open the refusal sits at its TOP, once: a reason below a tall editor is out of sight', () => {
  const b = W.begin(W.openEditor(W.toggleEdit(loaded()), null));
  const s = W.reduce(b.state, { type: 'wand', ok: false, req: b.req, reason: 'Pick one emoji.', ...wandMsg() });
  const html = W.html(W.view(s));
  assert.strictEqual((html.match(/class="wand-error"/g) || []).length, 1);
  assert.ok(html.indexOf('class="wand-error"') < html.indexOf('data-wand-field="emoji"'), 'the error comes before the fields');
  assert.ok(html.indexOf('class="wand-error"') > html.indexOf('wand-editor'), 'and inside the editor');
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
  assert.deepStrictEqual(f.pending, []);
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

// --- Dexter D6: a retrying (momentarily unreadable) file never says "fix or delete" ---------------------------

test('D6: an unavailable wand that is only RETRYING says so, with no fix-or-delete advice and no reset', () => {
  const v = W.view(loaded({ status: 'unavailable', favourites: null, unavailable: 'the wand file could not be read (EBUSY)', retrying: true }));
  assert.strictEqual(v.mode, 'unavailable');
  assert.match(v.note, /EBUSY/);
  assert.match(v.note, /retrying/i);
  assert.doesNotMatch(v.note, /fix or delete|delete/i);
  assert.strictEqual(v.canReset, false);
});

// --- Dexter D5: one Save is one favourite ---------------------------------------------------------------------

test('D5: a second submit while the first is in flight sends nothing (a held Enter adds once)', () => {
  let s = W.editorSet(W.editorSet(W.openEditor(W.toggleEdit(loaded()), null), 'emoji', '\u{1F680}'), 'skill', 'merged');
  const first = W.editorSubmit(s);
  assert.ok(first.message);
  const second = W.editorSubmit(first.state);
  assert.strictEqual(second.message, null);
  assert.strictEqual(second.state, first.state, 'and the state is untouched');
});

// --- Dexter D4: an answer is acted on by the window whose request it answers --------------------------------

test('D4: requests carry distinct ids, unique to this window too', () => {
  const a = W.begin(loaded());
  const b = W.begin(a.state);
  assert.notStrictEqual(a.req, b.req);
  const other = W.begin(W.reduce(W.emptyState(), hello()));
  assert.notStrictEqual(other.req, a.req, 'another window mints different ids');
});

test('D4: another window\'s answer (even a non-quiet success) neither closes my editor nor eats my refusal', () => {
  let s = W.editorSet(W.editorSet(W.openEditor(W.toggleEdit(loaded()), 'f1'), 'emoji', 'ab'), 'skill', 'merged');
  const sub = W.editorSubmit(s);
  s = sub.state;
  // someone else's answer arrives first: ok, not quiet, a different request id
  s = W.reduce(s, { type: 'wand', ok: true, reason: null, req: 'another-window-7', ...wandMsg() });
  assert.ok(W.view(s).editor, 'my editor is still open');
  assert.strictEqual(W.view(s).editor.saving, true);
  // then the refusal of MY request
  s = W.reduce(s, { type: 'wand', ok: false, req: sub.message.req, reason: 'Pick one emoji.', ...wandMsg() });
  assert.strictEqual(W.view(s).error, 'Pick one emoji.');
  assert.ok(W.view(s).editor);
  assert.strictEqual(W.view(s).editor.saving, false);
});

test('D4: an answer is acted on once: the same request id arriving twice is not mine the second time', () => {
  const b = W.begin(loaded());
  let s = W.reduce(b.state, { type: 'wand', ok: false, req: b.req, reason: 'x', ...wandMsg() });
  assert.strictEqual(W.view(s).error, 'x');
  s = W.reduce(W.clearError(s), { type: 'wand', ok: false, req: b.req, reason: 'again', ...wandMsg() });
  assert.strictEqual(W.view(s).error, null);
});

test('D4: a frame with no request id is never an answer to my edit', () => {
  const b = W.begin(loaded());
  const s = W.reduce(b.state, { type: 'wand', ok: false, reason: 'orphan', ...wandMsg() });
  assert.strictEqual(W.view(s).error, null);
  assert.deepStrictEqual(s.pending, [b.req], 'still waiting for the real answer');
});

test('D4: a hello (a reattach) forgets in-flight requests and releases a saving editor', () => {
  let s = W.editorSet(W.editorSet(W.openEditor(W.toggleEdit(loaded()), null), 'emoji', '\u{1F680}'), 'skill', 'merged');
  s = W.editorSubmit(s).state;
  assert.strictEqual(W.view(s).editor.saving, true);
  s = W.reduce(s, hello());
  assert.deepStrictEqual(s.pending, []);
  assert.strictEqual(W.view(s).editor.saving, false, 'Save is usable again');
  // and a refusal of somebody else's mistake no longer shows up here
  s = W.reduce(s, { type: 'wand', ok: false, req: 'x', reason: 'not mine', ...wandMsg() });
  assert.strictEqual(W.view(s).error, null);
});

test('D4: the pending list is bounded', () => {
  let s = W.toggleEdit(loaded());
  for (let i = 0; i < 100; i++) s = W.deleteMsg(s, 'f1').state;
  assert.ok(s.pending.length <= 20);
});

// --- Dexter D3: a command wider than the tab's input box is refused up front, with the real reason -------------

test('D3: boxCapacity leaves room for the prompt and the cursor; a missing width is no limit', () => {
  assert.strictEqual(W.boxCapacity(100), 96);
  assert.strictEqual(W.boxCapacity(0), null);
  assert.strictEqual(W.boxCapacity(undefined), null);
  assert.strictEqual(W.boxCapacity(NaN), null);
  assert.strictEqual(W.boxCapacity(3), 0, 'never negative');
});

test('D3: cellWidth counts CJK and emoji as two columns, plain text as one', () => {
  assert.strictEqual(W.cellWidth('/abc'), 4);
  assert.strictEqual(W.cellWidth('\u65e5\u672c'), 4);
  assert.strictEqual(W.cellWidth('\u{1F680}'), 2);
  assert.strictEqual(W.cellWidth(''), 0);
});

test('D3: a 150-character command in a 100-column tab is "too long", names the real cause, and types nothing', () => {
  const s = loaded({ favourites: [{ id: 'long', emoji: '\u{1F680}', skill: 'merged', args: 'x'.repeat(150) }] });
  const plan = W.clickPlan(s, 'long', { cols: 100 });
  assert.strictEqual(plan.kind, 'toolong');
  assert.match(plan.note, /158 columns/);
  assert.match(plan.note, /100-column/);
  assert.match(plan.note, /shorten the argument or widen/i);
  assert.doesNotMatch(plan.note, /input line changed/);
  assert.strictEqual(W.clickPlan(s, 'long', { cols: 400 }).kind, 'type');
  assert.strictEqual(W.clickPlan(s, 'long').kind, 'type', 'no width known: no refusal invented');
});

test('D3: the boundary is exact: capacity fits, one more does not (and wide characters count double)', () => {
  const cols = 60;
  const cap = W.boxCapacity(cols);
  const args = (n) => 'a'.repeat(n);
  const mk = (a) => loaded({ favourites: [{ id: 'f', emoji: '\u{1F680}', skill: 'merged', args: a }] });
  // the command is "/merged " (8 columns) + args
  assert.strictEqual(W.clickPlan(mk(args(cap - 8)), 'f', { cols }).kind, 'type');
  assert.strictEqual(W.clickPlan(mk(args(cap - 7)), 'f', { cols }).kind, 'toolong');
  assert.strictEqual(W.clickPlan(mk('\u65e5'.repeat((cap - 8) / 2)), 'f', { cols }).kind, 'type');
  assert.strictEqual(W.clickPlan(mk('\u65e5'.repeat((cap - 8) / 2 + 1)), 'f', { cols }).kind, 'toolong', 'two cells each');
});

test('D3: a too-long click in edit mode still opens the editor (the fix is to shorten it)', () => {
  const s = W.toggleEdit(loaded({ favourites: [{ id: 'long', emoji: '\u{1F680}', skill: 'merged', args: 'x'.repeat(150) }] }));
  assert.strictEqual(W.clickPlan(s, 'long', { cols: 100 }).kind, 'edit');
});

// --- Miguel I2: the way out of an unavailable wand -------------------------------------------------------------

const BAD = { status: 'unavailable', favourites: null, unavailable: 'the wand file is not valid JSON', file: 'C:/Users/ricar/proj/.harness/state/wand.json' };

test('I2: an unavailable wand shows the ABSOLUTE path and a Reset button that says it never deletes', () => {
  const v = W.view(loaded(BAD));
  assert.strictEqual(v.canReset, true);
  assert.match(v.note, /C:\/Users\/ricar\/proj\/\.harness\/state\/wand\.json/);
  const html = W.html(v);
  assert.match(html, /data-wand-act="reset"/);
  assert.match(html, /never deletes/i);
  assert.doesNotMatch(v.note, /fix or delete/);
});

test('I2: resetMsg asks the host to move the file aside, only when it can', () => {
  const r = W.resetMsg(loaded(BAD));
  assert.deepStrictEqual(r.message, { type: 'wand-reset', req: r.message.req });
  assert.ok(r.state.pending.includes(r.message.req));
  assert.strictEqual(W.resetMsg(loaded()).message, null, 'a healthy wand has nothing to reset');
  assert.strictEqual(W.resetMsg(loaded({ ...BAD, retrying: true })).message, null, 'a busy file is not reset');
  assert.strictEqual(W.resetMsg(W.emptyState()).message, null);
});

test('I2: the answer to MY reset says where the old file went', () => {
  const r = W.resetMsg(loaded(BAD));
  const s = W.reduce(r.state, { type: 'wand', ok: true, req: r.message.req, movedTo: 'C:/x/wand.json.bad-2026', ...wandMsg() });
  assert.strictEqual(W.view(s).mode, 'ok');
  assert.match(W.view(s).status, /C:\/x\/wand\.json\.bad-2026/);
  assert.match(W.view(s).status, /default set/);
});

test('I2: clickAction knows reset', () => {
  assert.deepStrictEqual(W.clickAction({ wandAct: 'reset' }), { kind: 'reset' });
});

// --- Miguel I3: keyboard access ----------------------------------------------------------------------------------

test('I3: moveStepMsg moves a favourite one place left or right, by naming its neighbour (edit mode only)', () => {
  const s = W.toggleEdit(loaded());
  assert.deepStrictEqual(W.moveStepMsg(s, 'f2', -1).message, { type: 'wand-move', id: 'f2', target: 'f1', req: W.moveStepMsg(s, 'f2', -1).message.req });
  assert.strictEqual(W.moveStepMsg(s, 'f2', 1).message.target, 'f3');
  assert.strictEqual(W.moveStepMsg(s, 'f1', -1).message, null, 'already first');
  assert.strictEqual(W.moveStepMsg(s, 'f3', 1).message, null, 'already last');
  assert.strictEqual(W.moveStepMsg(s, 'nope', 1).message, null);
  assert.strictEqual(W.moveStepMsg(s, 'f2', 0).message, null);
  assert.strictEqual(W.moveStepMsg(s, 'f2', 2).message, null, 'one place only');
  assert.strictEqual(W.moveStepMsg(loaded(), 'f2', 1).message, null, 'not in edit mode');
});

test('I3: in edit mode a favourite\'s accessible name says Enter edits it and Alt+arrows move it', () => {
  const normal = W.view(loaded()).buttons[1];
  const edit = W.view(W.toggleEdit(loaded())).buttons[1];
  assert.strictEqual(normal.label, '/checkpoint wrap up');
  assert.match(edit.label, /^\/checkpoint wrap up/);
  assert.match(edit.label, /Enter to edit/);
  assert.match(edit.label, /Alt\+Left or Alt\+Right to move/);
  assert.match(W.html(W.view(W.toggleEdit(loaded()))), /aria-label="\/checkpoint wrap up[^"]*Enter to edit/);
});

test('I3: the live text is the error if there is one, else the status; it is NOT inside the rebuilt markup', () => {
  const t = W.typed(loaded(), 'f1', { ok: true });
  assert.strictEqual(W.view(t).live, 'typed, press Enter');
  const b = W.begin(loaded());
  const e = W.reduce(b.state, { type: 'wand', ok: false, req: b.req, reason: 'Pick one emoji.', ...wandMsg() });
  assert.strictEqual(W.view(e).live, 'Pick one emoji.');
  assert.strictEqual(W.view(loaded()).live, '');
  assert.doesNotMatch(W.html(W.view(t)), /role="(status|alert)"/, 'a node that is replaced each render is not announced');
});

test('I3: clickAction does not know the keyboard-only move: it is not a data-attribute action', () => {
  assert.strictEqual(W.clickAction({ wandAct: 'move-step', wandId: 'f1' }), null);
});
