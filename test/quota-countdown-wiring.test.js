'use strict';
/**
 * BACKLOG #90, review fixes: the decisions are tested in test/quota-countdown.test.js; these pin that the browser script and the
 * host USE them (source assertions, in the style of test/renderer-shortcuts-wiring.test.js). The window-level behaviour is
 * verify/probe-quota-countdown.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const renderer = read('app/renderer.js');
const html = read('app/renderer.html');
const host = read('host/host.js');

const fnBody = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  return src.slice(i, src.indexOf('\n}\n', i) + 3);
};

test('the tick arms its next run BEFORE it renders, so a throw cannot end the chain (Miguel G1)', () => {
  const body = fnBody(renderer, 'quotaTick');
  assert.ok(body.indexOf('armQuotaTick()') >= 0 && body.indexOf('armQuotaTick()') < body.indexOf('renderQuota()'));
});

test('the tick rate comes from the payload, not from a flag a render left behind (Miguel G2)', () => {
  assert.match(fnBody(renderer, 'armQuotaTick'), /quotaTickDelayMs\(lastQuotaPayload/);
  assert.doesNotMatch(renderer, /nextQuotaTickMs/);
  assert.match(fnBody(renderer, 'renderQuota'), /^function renderQuota\(quota\) \{\n  if \(quota !== undefined\) lastQuotaPayload = quota;\n  armQuotaTick\(\);/);
});

test('the toast goes through the visibility gate and a persistent live region (Dexter 3, Miguel Y3)', () => {
  const body = fnBody(renderer, 'renderQuota');
  assert.match(body, /quotaToastGate\.step\(\{ toast: cs\.toast, usedUp: cs\.state === 'usedUp', visible: quotaHeaderVisible\(\) \}\)/);
  assert.match(body, /quotaAnnounceEl\.textContent = 'Claude is back'/);
  assert.match(body, /class="back-toast" aria-hidden="true"/);
  assert.match(html, /<div id="quota-announce" role="status" aria-live="polite"><\/div>/);
  assert.match(fnBody(renderer, 'quotaHeaderVisible'), /visibilityState === 'visible' && !leanOn/);
  assert.match(renderer, /addEventListener\('visibilitychange'/);
});

test('a used-up window whose reset passed is settled before drawing (Miguel Y5)', () => {
  assert.match(fnBody(renderer, 'renderQuota'), /quotaDisplay\(quotaSettlePastResets\(lastQuotaPayload, nowMs\)\)/);
});

test('only the countdown text is patched while the markup is unchanged (Miguel G3)', () => {
  assert.match(fnBody(renderer, 'renderQuota'), /skeleton === quotaSkeleton/);
});

test('a dropped socket stops a running countdown (Dexter 7)', () => {
  const i = renderer.indexOf('ws.onclose = () => {');
  const body = renderer.slice(i, renderer.indexOf('ws.onerror', i));
  assert.match(body, /quotaCountdownState\(lastQuotaPayload/);
  assert.match(body, /renderQuota\(\{ ok: false, state: 'absent'/);
});

test('the host re-sends a used-up payload every poll, so its readAt never ages on the page (Dexter 7)', () => {
  const i = host.indexOf('const quotaTimer = setInterval');
  const body = host.slice(i, host.indexOf('quotaTimer.unref()', i));
  assert.match(body, /usedUp \|\| JSON\.stringify\(quota && quota\.windows\) !== before/);
  assert.match(body, /w\.percent >= 100/);
  assert.match(body, /w\.lockedReason/);
});
