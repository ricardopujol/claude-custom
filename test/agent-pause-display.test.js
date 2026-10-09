'use strict';
/**
 * app/agent-pause-display.js (BACKLOG #19): an agent's Pause stops it and keeps its conversation, Resume wakes it with the same
 * context, through the CLI's own mechanism (the model is asked, in the session, to TaskStop it and later to SendMessage it: nothing
 * of the CLI is reimplemented). This is the page-side state machine and the card's controls. Pure; the typing goes through the
 * page's existing submit gate (typeCommand).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const D = require('../app/agent-pause-display');

const counts = (o) => new Map(Object.entries(o));

test('the commands name the agent, ask for the CLI\'s own stop / SendMessage, and are one line', () => {
  const p = D.commandFor('pause', 'code-reviewer');
  const r = D.commandFor('resume', 'code-reviewer');
  assert.match(p, /code-reviewer/);
  assert.match(p, /TaskStop/);
  assert.match(r, /code-reviewer/);
  assert.match(r, /SendMessage/);
  for (const c of [p, r]) assert.doesNotMatch(c, /[\r\n]/);
});

test('an agent name that is not plain is refused, never typed into the session', () => {
  for (const bad of ['', 'a\nb', 'x"; rm -rf', 'a`b`', '$(calc)', 'a\u0000b', 'x'.repeat(201), null, undefined, 5, {}]) {
    assert.strictEqual(D.commandFor('pause', bad), null, JSON.stringify(bad));
  }
  assert.ok(D.commandFor('pause', 'code-reviewer-miguel'));
  assert.ok(D.commandFor('pause', 'Agent_2.v1:x'));
  assert.ok(D.commandFor('pause', 'x'.repeat(200)));
  assert.strictEqual(D.commandFor('freeze', 'x'), null);
});

test('clickAction: only pause and resume, with a plain agent name', () => {
  assert.deepStrictEqual(D.clickAction({ agentPauseAct: 'pause', agent: 'rev' }), { act: 'pause', agent: 'rev' });
  assert.deepStrictEqual(D.clickAction({ agentPauseAct: 'resume', agent: 'rev' }), { act: 'resume', agent: 'rev' });
  for (const bad of [null, {}, { agentPauseAct: 'kill', agent: 'rev' }, { agentPauseAct: 'pause' }, { agentPauseAct: 'pause', agent: '' }, { agentPauseAct: 'pause', agent: 'a\nb' }]) {
    assert.strictEqual(D.clickAction(bad), null, JSON.stringify(bad));
  }
});

test('a running agent (one instance) offers Pause; several instances, or none running, offer nothing', () => {
  const s = D.createAgentPauses();
  assert.strictEqual(s.view('rev', 1).kind, 'pause');
  assert.strictEqual(s.view('rev', 2).kind, 'none', 'which of two would "the agent" be?');
  assert.strictEqual(s.view('rev', 0).kind, 'none');
});

test('Pause: pausing until the agent is seen not running, then paused with the time; Resume then waits for it to run again', () => {
  const s = D.createAgentPauses();
  assert.strictEqual(s.begin('rev', 'pause', 1000), true);
  assert.strictEqual(s.view('rev', 1).kind, 'pausing');
  s.seen(counts({ rev: 1 }), 5000);
  assert.strictEqual(s.view('rev', 1).kind, 'pausing', 'still running: not paused yet');
  s.seen(counts({}), 8000);
  assert.deepStrictEqual(s.view('rev', 0), { kind: 'paused', since: 8000 });
  assert.strictEqual(s.begin('rev', 'resume', 9000), true);
  assert.strictEqual(s.view('rev', 0).kind, 'resuming');
  s.seen(counts({ rev: 1 }), 12000);
  assert.strictEqual(s.view('rev', 1).kind, 'pause', 'running again: back to the start');
});

test('a Pause that did not stop the agent within the time is not a pause: back to running, nothing claimed', () => {
  const s = D.createAgentPauses();
  s.begin('rev', 'pause', 0);
  s.seen(counts({ rev: 1 }), D.PAUSE_TIMEOUT_MS - 1);
  assert.strictEqual(s.view('rev', 1).kind, 'pausing');
  s.seen(counts({ rev: 1 }), D.PAUSE_TIMEOUT_MS);
  assert.strictEqual(s.view('rev', 1).kind, 'pause');
});

test('a Resume that did not wake the agent within the time leaves it paused', () => {
  const s = D.createAgentPauses();
  s.begin('rev', 'pause', 0);
  s.seen(counts({}), 10);
  s.begin('rev', 'resume', 20);
  s.seen(counts({}), 20 + D.PAUSE_TIMEOUT_MS - 1);
  assert.strictEqual(s.view('rev', 0).kind, 'resuming');
  s.seen(counts({}), 20 + D.PAUSE_TIMEOUT_MS);
  assert.deepStrictEqual(s.view('rev', 0), { kind: 'paused', since: 10 });
});

test('a refused typing (the gate said no, the box was not empty) puts the phase back', () => {
  const s = D.createAgentPauses();
  s.begin('rev', 'pause', 0);
  s.refused('rev');
  assert.strictEqual(s.view('rev', 1).kind, 'pause');
  s.begin('rev', 'pause', 0);
  s.seen(counts({}), 5);
  s.begin('rev', 'resume', 6);
  s.refused('rev');
  assert.deepStrictEqual(s.view('rev', 0), { kind: 'paused', since: 5 });
});

test('begin only works from the right phase: no Resume of what is not paused, no second Pause, no Pause of what is not running', () => {
  const s = D.createAgentPauses();
  assert.strictEqual(s.begin('rev', 'resume', 0), false);
  assert.strictEqual(s.begin('rev', 'pause', 0), true);
  assert.strictEqual(s.begin('rev', 'pause', 1), false);
  assert.strictEqual(s.begin('rev', 'resume', 1), false, 'still pausing');
  assert.strictEqual(s.begin('rev', 'freeze', 1), false);
});

test('a session end (/clear kills background agents) forgets every pause: nothing is "paused" in a session that is gone', () => {
  const s = D.createAgentPauses();
  s.begin('a', 'pause', 0); s.seen(counts({}), 1);
  s.begin('b', 'pause', 0);
  s.reset();
  assert.strictEqual(s.view('a', 0).kind, 'none');
  assert.strictEqual(s.view('b', 1).kind, 'pause');
});

test('the card control: Pause is a button naming the agent; paused says paused with the time and offers Resume; busy phases offer none', () => {
  const s = D.createAgentPauses();
  const h1 = D.html(s.view('code-reviewer', 1), 'code-reviewer');
  assert.match(h1, /<button type="button" class="agent-pause-btn" data-agent-pause-act="pause" data-agent="code-reviewer"/);
  assert.doesNotMatch(D.html(s.view('x', 0), 'x'), /./, 'nothing at all for a sleeping agent that is not paused');
  s.begin('code-reviewer', 'pause', 0);
  assert.doesNotMatch(D.html(s.view('code-reviewer', 1), 'code-reviewer'), /<button/);
  assert.match(D.html(s.view('code-reviewer', 1), 'code-reviewer'), /pausing/);
  s.seen(counts({}), 3600000);
  const h2 = D.html(s.view('code-reviewer', 0), 'code-reviewer');
  assert.match(h2, /data-agent-pause-act="resume" data-agent="code-reviewer"/);
  assert.match(h2, /paused \d\d:\d\d/);
});

test('the card control escapes the agent name', () => {
  const h = D.html({ kind: 'pause' }, 'a<b>&"');
  assert.doesNotMatch(h, /a<b>/);
  assert.match(h, /a&lt;b&gt;&amp;&quot;/);
});

// ---- the property ----------------------------------------------------------------------------------------------------

const evArb = fc.oneof(
  fc.record({ e: fc.constant('begin'), agent: fc.constantFrom('a', 'b'), verb: fc.constantFrom('pause', 'resume') }),
  fc.record({ e: fc.constant('seen'), a: fc.boolean(), b: fc.boolean(), dt: fc.integer({ min: 0, max: 60000 }) }),
  fc.record({ e: fc.constant('refused'), agent: fc.constantFrom('a', 'b') }),
  fc.record({ e: fc.constant('reset') }),
);

test('property: "paused" is only ever claimed for an agent not running that a Pause was typed for; "pause" only for a running one', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 80 }), (events) => {
    const s = D.createAgentPauses();
    let t = 0;
    const running = { a: 1, b: 1 };
    const pauseTyped = { a: false, b: false };       // a Pause was accepted for this agent since the last reset
    for (const ev of events) {
      if (ev.e === 'begin') { if (s.begin(ev.agent, ev.verb, t) && ev.verb === 'pause') pauseTyped[ev.agent] = true; }
      else if (ev.e === 'refused') s.refused(ev.agent);
      else if (ev.e === 'reset') { s.reset(); pauseTyped.a = pauseTyped.b = false; }
      else { t += ev.dt; running.a = ev.a ? 1 : 0; running.b = ev.b ? 1 : 0; s.seen(new Map([...(ev.a ? [['a', 1]] : []), ...(ev.b ? [['b', 1]] : [])]), t); }
      for (const agent of ['a', 'b']) {
        const v = s.view(agent, running[agent]);
        assert.ok(['none', 'pause', 'pausing', 'paused', 'resuming'].includes(v.kind));
        if (v.kind === 'paused') {
          assert.strictEqual(running[agent], 0, 'a paused agent is not running');
          assert.strictEqual(typeof v.since, 'number');
          assert.ok(pauseTyped[agent], 'only after a Pause was typed for it');
        }
        if (v.kind === 'pause') assert.strictEqual(running[agent], 1);
        if (v.kind === 'pausing' || v.kind === 'resuming') assert.ok(pauseTyped[agent]);
      }
    }
  }), { numRuns: 300 });
});
