'use strict';
/**
 * The roster-index wiring in host.js (BACKLOG D #16), source-sliced.
 *
 * Miguel M2, PR #59 review: host.js cannot be `require`d in a unit test
 * without spawning a pty, so this repo has a standing convention for exactly
 * this situation -- test/host-subagent-usage.test.js, test/host-listen.test.js
 * and others assert against the SOURCE TEXT rather than the running process.
 * Nothing in `test/` referenced `rosterIndex`/`refreshRosterIndex` at all
 * before this file, leaving the `Promise.all` combination, the `ok`/`complete`
 * computation, the boot-then-lazy-on-connect dance, and the
 * `tokens: ... has(agent) ? ... : null` line -- this repo's own named
 * `Number(null)` trap -- with no test pinning any of it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = HOST.indexOf(startMarker);
  assert.ok(start !== -1, `host.js must contain ${JSON.stringify(startMarker)} for this check to mean anything`);
  const end = HOST.indexOf(endMarker, start);
  assert.ok(end !== -1, `host.js must contain ${JSON.stringify(endMarker)} after the start marker`);
  return HOST.slice(start, end);
}

function refreshRosterIndexBody() {
  return slice('function refreshRosterIndex()', 'async function seedRosterIndex()');
}

test('host.js requires the roster-index and agent-stats-cache modules', () => {
  assert.match(HOST, /require\(['"]\.\/roster-index['"]\)/);
  assert.match(HOST, /require\(['"]\.\/agent-stats-cache['"]\)/);
});

test('refreshRosterIndex computes ONE shared scan and hands it to both wholeRoster and lifetimeAgentTokens', () => {
  // Dexter F5 (perf) / Miguel M1: a shared `scan` is what stops host.js from
  // reading every project's transcripts twice per launch.
  const body = refreshRosterIndexBody();
  assert.match(body, /const scan = await scanProjects\(\)/);
  assert.match(body, /wholeRoster\(\{[^}]*scan[^}]*\}\)/);
  assert.match(body, /lifetimeAgentTokens\(\{[^}]*scan[^}]*\}\)/);
});

test('the roster payload never coerces a missing token total to zero', () => {
  // CLAUDE.md's own named trap for this whole repo: Number(null) is 0. The
  // strict presence check (`.has`, not `||` or a coercing comparison) is what
  // keeps a never-used agent from reading as "spent zero tokens".
  assert.match(HOST, /lifetime\.agents\.has\(agent\)\s*\?\s*lifetime\.agents\.get\(agent\)\s*:\s*null/);
});

test('a roster row is flagged unresolved rather than drawn as a confirmed peer', () => {
  // Dexter F3 / Miguel L1.
  assert.match(HOST, /resolved:\s*!unresolvedNames\.has\(agent\)\s*&&\s*!lifetime\.unresolvedAgents\.has\(agent\)/);
});

test('rosterIndex.ok and .unreadable fold both halves without double-owning the shared scan errors', () => {
  const body = refreshRosterIndexBody();
  assert.match(body, /ok:\s*roster\.unreadable === 0 && lifetime\.unreadable === 0/);
  assert.match(body, /unreadable:\s*roster\.unreadable \+ lifetime\.unreadable/);
  assert.match(body, /complete:\s*true/);
});

test('seedRosterIndex reads a stat-checked lower bound, not the raw summary (Dexter N1)', () => {
  // Dexter N1, PR #59 R2: the raw per-agent summary alone is not a lower
  // bound once a transcript can be deleted between host launches --
  // `readCacheSeed` stat-checks the files behind each total.
  const body = slice('async function seedRosterIndex()', 'refreshAgentStats');
  assert.match(body, /readCacheSeed\(ROSTER_LIFETIME_CACHE\)/);
  assert.doesNotMatch(body, /readCacheSummary\(/,
    'seedRosterIndex must not seed from the un-stat-checked raw summary');
  assert.match(body, /complete:\s*false/);
  assert.match(body, /ok:\s*false/);
});

test('seedRosterIndex never overwrites an already-completed pass (Dexter N3)', () => {
  const body = slice('async function seedRosterIndex()', 'refreshAgentStats');
  assert.match(body, /if \(lastRosterIndex\.complete\) return;/,
    'a finished pass must never be regressed by a slower-to-resolve seed read');
});

test('a roster row carries whether it ran but could not be read this pass (Dexter N2)', () => {
  assert.match(HOST, /unreadable:\s*lifetime\.unreadableAgents\.has\(agent\)/);
});

test('the boot sequence seeds BEFORE firing the real background scan, exactly once', () => {
  // A CALL, at the start of a line -- excludes both the `function
  // seedRosterIndex()` declaration and the backtick-quoted mention in this
  // block's own comment above it. `\r?` because this checkout may have CRLF
  // line endings.
  const callRe = /^seedRosterIndex\(\)\r?\n/m;
  assert.match(HOST, callRe, 'host.js must call seedRosterIndex() at boot, at the top level');
  const bootStart = HOST.search(callRe);
  const bootRegion = HOST.slice(bootStart, bootStart + 400);
  assert.match(bootRegion, /\.then\(\(\) => refreshRosterIndex\(\)\)/);
  assert.match(bootRegion, /broadcastControl\(\{ type: 'rosterIndex', rosterIndex \}\)/);
  // Exactly one boot-time CALL -- a second one anywhere outside the connection
  // handler would mean the scan fires more than once per launch. Matches only
  // the invocation shape (with the trailing paren-newline), so the function
  // declaration and the prose mention above it don't inflate the count.
  assert.strictEqual((HOST.match(new RegExp(callRe.source, 'gm')) || []).length, 1);
});

test('a connecting client only re-triggers the scan while it has not completed', () => {
  const idx = HOST.indexOf("if (!lastRosterIndex.complete)");
  assert.ok(idx !== -1, 'the connection handler must gate on lastRosterIndex.complete');
  const region = HOST.slice(idx, idx + 300);
  assert.match(region, /refreshRosterIndex\(\)/);
  assert.match(region, /type: 'rosterIndex'/);
});

test('the hello handshake carries the current rosterIndex', () => {
  assert.match(HOST, /rosterIndex:\s*lastRosterIndex/);
});

test('a roster row carries the persona and function from the agent file, null when it has none (#76)', () => {
  assert.match(HOST, /persona:\s*info && info\.persona \? info\.persona : null/);
  assert.match(HOST, /fn:\s*info && info\.fn \? info\.fn : null/);
  assert.match(refreshRosterIndexBody(), /rosterAgentRow\(agent, lifetime, roster\.unresolvedNames, roster\.infos\)/);
});
