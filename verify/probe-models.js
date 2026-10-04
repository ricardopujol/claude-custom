'use strict';
/* Does the model catalogue actually reach a client, and do the seat rules hold
   across the wire?

   The pure logic is well covered by tests, and that is exactly why this exists:
   those tests cannot tell you whether the panel receives anything. The usage
   counter on this project shipped with a defect of precisely that shape -- the
   figure was computed correctly, carried correctly, and never reached a client
   that attached at the wrong moment.

   This drives the real host over the real control channel, through the
   gatekeeper, and checks the answers. It makes ONE network call, to a PUBLIC
   endpoint, and spends nothing. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..');
const PORT = 7813;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sessionToken() {
  try {
    return fs.readFileSync(path.join(REPO, '.harness', 'session-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  // A clean state dir for the seats, so a previous run cannot make this one
  // pass. The catalogue cache is deliberately LEFT, so a repeat run is offline.
  const seatFile = path.join(REPO, '.harness', 'state', 'council.json');
  try { fs.unlinkSync(seatFile); } catch { /* first run */ }

  const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
    cwd: REPO, env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT) }, stdio: 'ignore',
  });

  await sleep(6000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(sessionToken())}`);
  const seen = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { seen.push(JSON.parse(data.toString())); } catch { /* not ours */ }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await sleep(1500);

  const hello = seen.find(m => m.type === 'hello');
  check('hello carries the council seats', !!hello && Array.isArray(hello.seats),
    hello ? `${(hello.seats || []).length} seated, max ${hello.maxSeats}` : 'no hello');
  check('hello does NOT carry the catalogue', !!hello && hello.models === undefined,
    'a network call must not be made for a panel nobody opened');

  // --- the catalogue -----------------------------------------------------------
  ws.send(JSON.stringify({ type: 'models' }));
  await sleep(12000);
  const cat = seen.find(m => m.type === 'models');
  check('the catalogue reaches the client', !!cat && Array.isArray(cat.models),
    cat ? `${cat.models.length} models from ${cat.source}` : 'nothing arrived');

  if (cat && cat.models.length) {
    const tooled = cat.models.filter(m => m.tools).length;
    check('models are normalised, not raw', typeof cat.models[0].promptPerM !== 'undefined',
      `keys: ${Object.keys(cat.models[0]).join(', ')}`);
    check('tool support is present and not universal', tooled > 0 && tooled < cat.models.length,
      `${tooled} of ${cat.models.length} support tools`);

    // The defect this panel exists to avoid: a real price rendering as zero.
    const priced = cat.models.filter(m => m.priced && m.promptPerM > 0);
    const subCent = priced.filter(m => m.promptPerM < 1);
    check('prices are per MILLION, not per token', priced.every(m => m.promptPerM > 0.0001),
      `cheapest paid: $${Math.min(...priced.map(m => m.promptPerM)).toPrecision(2)}/M` +
      ` · ${subCent.length} models under $1/M`);

    const unpriced = cat.models.filter(m => !m.priced);
    check('unpriced models are distinguishable from free ones',
      cat.models.some(m => m.free) && unpriced.every(m => m.promptPerM === null),
      `${cat.models.filter(m => m.free).length} free, ${unpriced.length} unpriced`);

    check('the catalogue says where it came from',
      ['network', 'cache'].includes(cat.source) && typeof cat.stale === 'boolean',
      `source=${cat.source} stale=${cat.stale}`);
  }

  // --- the seat rules over the wire --------------------------------------------
  const pick = (cat && cat.models || []).filter(m => !/^anthropic\//.test(m.id));
  const claude = (cat && cat.models || []).find(m => /^anthropic\//.test(m.id));

  if (pick.length >= 4) {
    for (const m of pick.slice(0, 3)) {
      ws.send(JSON.stringify({ type: 'seat', action: 'add', model: m }));
      await sleep(250);
    }
    let seats = [...seen].reverse().find(m => m.type === 'seats');
    check('three seats can be taken', !!seats && seats.seats.length === 3,
      seats ? seats.seats.map(s => s.id).join(', ') : 'no reply');

    ws.send(JSON.stringify({ type: 'seat', action: 'add', model: pick[3] }));
    await sleep(400);
    seats = [...seen].reverse().find(m => m.type === 'seats');
    check('a fourth seat is REFUSED, not rotated in',
      !!seats && seats.seats.length === 3 && !!seats.error,
      seats ? (seats.error || 'no error given') : 'no reply');

    ws.send(JSON.stringify({ type: 'seat', action: 'remove', id: pick[0].id }));
    await sleep(400);
    seats = [...seen].reverse().find(m => m.type === 'seats');
    check('a seat can be removed', !!seats && seats.seats.length === 2,
      seats ? `${seats.seats.length} seated` : 'no reply');
  } else {
    check('enough non-Claude models to seat a council', false, `only ${pick.length}`);
  }

  if (claude) {
    ws.send(JSON.stringify({ type: 'seat', action: 'add', model: claude }));
    await sleep(400);
    const seats = [...seen].reverse().find(m => m.type === 'seats');
    const refused = !!seats && !seats.seats.some(s => s.id === claude.id) && !!seats.error;
    // THE rule that makes the council worth running: the layer orchestrating it
    // is already Claude, so a Claude seat re-correlates the ensemble and the
    // answers quietly stop being independent.
    check('CLAUDE is refused a council seat', refused,
      seats ? (seats.error || 'seated without complaint') : 'no reply');
  } else {
    check('an Anthropic model exists in the catalogue to test the refusal', false,
      'could not find one — the refusal is untested on this run');
  }

  // --- persistence --------------------------------------------------------------
  const onDisk = (() => {
    try { return JSON.parse(fs.readFileSync(seatFile, 'utf8')); } catch { return null; }
  })();
  check('seats are persisted to disk', !!onDisk && Array.isArray(onDisk.seats),
    onDisk ? `${onDisk.seats.length} seats in council.json` : 'nothing written');
  check('a persisted seat stores no pricing',
    !!onDisk && onDisk.seats.every(s => Object.keys(s).sort().join(',') === 'id,name,provider'),
    onDisk && onDisk.seats[0] ? Object.keys(onDisk.seats[0]).join(', ') : '');

  ws.close();
  host.kill();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('probe failed:', err && err.message);
  process.exit(1);
});
