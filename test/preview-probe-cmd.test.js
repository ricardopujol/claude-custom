'use strict';
/**
 * The probe driver's door to the Preview panel (BACKLOG #119 A4): verify/probe-preview-panel.js reads the native view through a `preview`
 * command (inspect only, never a string of code) and the page's controls through two named view actions.
 */
const test = require('node:test');
const assert = require('node:assert');
const { handleProbeCommand, VIEW_PROBE_ACTIONS } = require('../app/tab-shell');

const PT = 'probe-token-0123456789abcdef';
const line = (o) => JSON.stringify({ ...o, token: PT });
const probeCmd = (l, api) => handleProbeCommand(l, api, PT);

test('preview: inspect is the only action, and it is passed through', async () => {
  const seen = [];
  const api = { preview: async (action) => { seen.push(action); return { ok: true, action }; } };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'preview', action: 'inspect' }), api), { ok: true, action: 'inspect' });
  for (const bad of [{ action: 'eval', code: '1' }, { action: 'click' }, { action: undefined }, { action: 7 }, {}]) {
    const r = await probeCmd(line({ cmd: 'preview', ...bad }), api);
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
  }
  assert.deepStrictEqual(seen, ['inspect']);
});

test('preview: shot is a picture to a .png file and nothing else', async () => {
  const seen = [];
  const api = { preview: async (action, file) => { seen.push([action, file]); return { ok: true }; } };
  assert.strictEqual((await probeCmd(line({ cmd: 'preview', action: 'shot', file: 'C:/x/panel.png' }), api)).ok, true);
  for (const file of ['C:/x/panel.txt', 'C:/x/panel.png.exe', undefined, 5, '']) {
    assert.strictEqual((await probeCmd(line({ cmd: 'preview', action: 'shot', file }), api)).ok, false, String(file));
  }
  assert.deepStrictEqual(seen, [['shot', 'C:/x/panel.png']]);
});

test('the two named view actions the probe uses are known', () => {
  for (const a of ['previewState', 'previewDo']) assert.ok(VIEW_PROBE_ACTIONS.has(a), a);
});
