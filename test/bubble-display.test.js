'use strict';
/**
 * BACKLOG #80 / #55: the renderer's side of the speech bubbles (app/bubble-display.js): which bubbles are alive, when the window
 * may show any at all, and the markup. Pure; the DOM touch is behind a duck-typed root.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const bd = require('../app/bubble-display');

const frame = (o = {}) => ({ type: 'bubble', agent: 'miguel', state: 'working', text: 'Back to the grind!', ttlMs: 8000, ...o });

test('a bubble lives for the time the host said, then is gone', () => {
  let t = 1000;
  const b = bd.createBoard({ now: () => t });
  assert.strictEqual(b.show(frame()), true);
  assert.deepStrictEqual(b.live('miguel'), { text: 'Back to the grind!', remainingMs: 8000, ageMs: 0 });
  t += 7999;
  assert.strictEqual(b.live('miguel').remainingMs, 1);
  t += 1;
  assert.strictEqual(b.live('miguel'), null);
});

test('a newer bubble replaces the older one for the same agent', () => {
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame({ text: 'One' })); b.show(frame({ text: 'Two' }));
  assert.strictEqual(b.live('miguel').text, 'Two');
});

test('frames that are not bubbles are refused: no agent, no text, odd types', () => {
  const b = bd.createBoard({ now: () => 0 });
  for (const bad of [null, 'x', {}, frame({ agent: '' }), frame({ agent: 5 }), frame({ text: '' }), frame({ text: '   ' }), frame({ text: 9 }), frame({ agent: 'a'.repeat(300) })]) {
    assert.strictEqual(b.show(bad), false, JSON.stringify(bad));
  }
  assert.strictEqual(b.size(), 0);
});

test('the lifetime is clamped to a sane range and defaults to 8 seconds', () => {
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame({ ttlMs: 10 * 60_000 })); assert.strictEqual(b.live('miguel').remainingMs, bd.TTL_MAX_MS);
  b.show(frame({ ttlMs: 1 })); assert.strictEqual(b.live('miguel').remainingMs, bd.TTL_MIN_MS);
  b.show(frame({ ttlMs: 'long' })); assert.strictEqual(b.live('miguel').remainingMs, bd.TTL_DEFAULT_MS);
  assert.strictEqual(bd.TTL_DEFAULT_MS, 8000);
});

test('the text is one trimmed line capped at the line limit', () => {
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame({ text: '  hello\nthere  ' + 'x'.repeat(500) }));
  const t = b.live('miguel').text;
  assert.ok(!t.includes('\n'));
  assert.ok([...t].length <= bd.TEXT_MAX);
});

test('an agent called __proto__ is an ordinary agent, and the board is bounded', () => {
  const b = bd.createBoard({ now: () => 0 });
  assert.strictEqual(b.show(frame({ agent: '__proto__' })), true);
  assert.strictEqual(b.live('__proto__').text, 'Back to the grind!');
  assert.strictEqual(b.live('constructor'), null);
  for (let i = 0; i < 1000; i++) b.show(frame({ agent: 'a' + i }));
  assert.ok(b.size() <= bd.BOARD_MAX);
});

test('expired bubbles are swept, and nextExpiryIn says when to look again', () => {
  let t = 0;
  const b = bd.createBoard({ now: () => t });
  assert.strictEqual(b.nextExpiryIn(), null);
  b.show(frame({ agent: 'a', ttlMs: 3000 })); b.show(frame({ agent: 'b', ttlMs: 9000 }));
  assert.strictEqual(b.nextExpiryIn(), 3000);
  t = 3000;
  assert.strictEqual(b.nextExpiryIn(), 6000);
  assert.strictEqual(b.size(), 1);
});

test('canShow: only when the switch is on, agent images are not off and the window is not lean', () => {
  assert.strictEqual(bd.canShow({ enabled: true, imagesEnabled: true, lean: false }), true);
  assert.strictEqual(bd.canShow({ enabled: true, imagesEnabled: null, lean: false }), true);     // unknown images setting: not "off"
  assert.strictEqual(bd.canShow({ enabled: false, imagesEnabled: true, lean: false }), false);
  assert.strictEqual(bd.canShow({ enabled: true, imagesEnabled: false, lean: false }), false);
  assert.strictEqual(bd.canShow({ enabled: true, imagesEnabled: true, lean: true }), false);
  assert.strictEqual(bd.canShow({ enabled: null, imagesEnabled: true, lean: false }), false);    // switch unknown: nothing shown
  assert.strictEqual(bd.canShow(undefined), false);
});

test('the markup escapes the text, says it is a bubble, and fades near the end', () => {
  const html = bd.bubbleHtml('<img src=x onerror=alert(1)> & "q"', 8000);
  assert.ok(!html.includes('<img'));
  assert.match(html, /class="agent-bubble"/);
  assert.match(html, /role="note"/);
  assert.match(html, /--bubble-fade-delay:7400ms/);
  assert.match(html, /--bubble-life:8000ms/);
  assert.match(bd.bubbleHtml('x', 200), /--bubble-fade-delay:0ms/);
});

test('attach puts a live bubble on its card, replaces a stale one, and removes it when not shown', () => {
  const cards = [mkCard('miguel'), mkCard('dexter')];
  const root = { querySelectorAll: (sel) => (sel === '.agent' ? cards : []) };
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame({ agent: 'miguel' }));
  bd.attach(root, b, true);
  assert.strictEqual(cards[0].html.length, 1);
  assert.strictEqual(cards[1].html.length, 0);
  bd.attach(root, b, true);                              // again: still one, not two
  assert.strictEqual(cards[0].html.length, 1);
  bd.attach(root, b, false);                             // switched off: gone
  assert.strictEqual(cards[0].html.length, 0);
});

function mkCard(agent) {
  const card = { dataset: { agent }, html: [], inserts: 0, removes: 0 };
  card.querySelector = (sel) => {
    if (sel !== ':scope > .agent-bubble' || !card.html.length) return null;
    const text = new RegExp(">([^<]*)<" + String.fromCharCode(47) + "div>$").exec(card.html[0])[1];
    return { textContent: text, remove: () => { card.html = []; card.removes++; } };
  };
  card.insertAdjacentHTML = (where, h) => { assert.strictEqual(where, 'afterbegin'); card.html.push(h); card.inserts++; };
  return card;
}

test('attach keeps the same node while the line is unchanged (a repaint every second must not restart its fade-in), and swaps it when the line changes', () => {
  const card = mkCard('miguel');
  const root = { querySelectorAll: () => [card] };
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame({ text: 'One' }));
  bd.attach(root, b, true);
  bd.attach(root, b, true);
  bd.attach(root, b, true);
  assert.strictEqual(card.inserts, 1);
  assert.strictEqual(card.removes, 0);
  b.show(frame({ text: 'Two' }));
  bd.attach(root, b, true);
  assert.strictEqual(card.inserts, 2);
  assert.strictEqual(card.removes, 1);
});

test('a bubble rebuilt after it has played its fade-in is marked settled, so it does not blink again', () => {
  let t = 0;
  const b = bd.createBoard({ now: () => t });
  b.show(frame());
  assert.strictEqual(b.live('miguel').ageMs, 0);
  assert.ok(!/data-settled/.test(bd.bubbleHtml('x', 8000, 0)));
  t = 3000;
  assert.strictEqual(b.live('miguel').ageMs, 3000);
  assert.match(bd.bubbleHtml('x', 5000, 3000), /data-settled/);
});

test('the default clock is monotonic: a wall-clock step back neither stretches nor cuts a bubble', () => {
  const realNow = performance.now; const realDate = Date.now;
  let mono = 1000; let wall = 5_000_000;
  performance.now = () => mono; Date.now = () => wall;
  try {
    const b = bd.createBoard();
    b.show(frame());
    wall -= 3_600_000;           // the wall clock steps back an hour
    mono += 1000;
    assert.strictEqual(b.live('miguel').remainingMs, 7000);
    wall += 7_200_000;           // and forward two
    mono += 7000;
    assert.strictEqual(b.live('miguel'), null);
  } finally { performance.now = realNow; Date.now = realDate; }
});

test('PROPERTY: live() is never a bubble older than its lifetime, over any sequence of shows and clock moves', () => {
  const ev = fc.oneof(
    fc.record({ t: fc.constant('show'), a: fc.constantFrom('a', 'b', 'c'), ttl: fc.integer({ min: 1000, max: 15000 }) }),
    fc.record({ t: fc.constant('tick'), dt: fc.integer({ min: 0, max: 20000 }) }),
  );
  fc.assert(fc.property(fc.array(ev, { maxLength: 60 }), (events) => {
    let now = 0;
    const b = bd.createBoard({ now: () => now });
    const until = new Map();
    for (const e of events) {
      if (e.t === 'tick') now += e.dt;
      else { b.show(frame({ agent: e.a, ttlMs: e.ttl })); until.set(e.a, now + e.ttl); }
      for (const a of ['a', 'b', 'c']) {
        const live = b.live(a);
        if (live) { assert.ok(until.get(a) > now); assert.strictEqual(live.remainingMs, until.get(a) - now); }
        else if (until.has(a)) assert.ok(until.get(a) <= now);
      }
    }
  }), { numRuns: 100 });
});

test('clear() empties the board (switching bubbles off drops the live ones)', () => {
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame()); b.clear();
  assert.strictEqual(b.live('miguel'), null);
  assert.strictEqual(b.size(), 0);
});

test('attach leaves the Inactive tab alone: no bubbles on its rows', () => {
  const card = mkCard('miguel');
  card.dataset.state = 'inactive';
  const root = { querySelectorAll: () => [card] };
  const b = bd.createBoard({ now: () => 0 });
  b.show(frame({ agent: 'miguel' }));
  bd.attach(root, b, true);
  assert.strictEqual(card.html.length, 0);
});
