'use strict';
/**
 * The Ask panel's glue in the renderer (BACKLOG #33), pinned the way test/games-wiring.test.js pins the Games panel's: the panel is an
 * ordinary module, its scripts load in dependency order before renderer.js, the page asks nothing of a host that doesn't list `ask`,
 * every dropped socket fails the pending asks, and the panel reads the index only while it is on screen. The rendered proof is
 * verify/probe-ask-panel.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const JS = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8').replace(/\r\n/g, '\n');
const { TABS } = require('../app/side-tabs');

test('the Ask panel is an ordinary module: one TABS entry, one panel, the scripts in dependency order before renderer.js', () => {
  assert.strictEqual(TABS.filter(t => t.id === 'ask').length, 1);
  assert.strictEqual((HTML.match(/data-panel="ask"/g) || []).length, 1);
  assert.match(HTML, /<div id="ask-root" tabindex="-1"><\/div>/);
  const order = ['ask-panel-state', 'ask-profile', 'ask-requester', 'ask-controller', 'ask-display', 'renderer'].map(n => HTML.indexOf(`<script src="./${n}.js">`));
  assert.ok(order.every(i => i !== -1), 'every script is listed');
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'state, profile and requester before the controller, the controller before the display, all before renderer.js');
});

test('the host\'s hello decides whether the page may ask: nothing is sent to a host that doesn\'t list ask', () => {
  assert.match(JS, /askRequester\.setControls\(Array\.isArray\(msg\.controls\) \? msg\.controls : \[\]\);/);
});

test('an ask frame from the host reaches the requester, and a dropped socket fails the pending asks', () => {
  assert.match(JS, /if \(msg\.type === 'ask'\) \{\n\s+askRequester\.onMessage\(msg\);\n\s+return;\n\s+\}/);
  assert.match(JS, /askRequester\.failAll\('the connection to the session dropped'\);/);
});

test('the panel is told whether it is on screen after every layout, and only a CHANGE acts (so the index status is read on opening, not on every layout)', () => {
  assert.match(JS, /gamesView\(\);[^\n]*\n\s+askView\(\);/);
  const at = JS.indexOf('function askView() {');
  const body = JS.slice(at, JS.indexOf('\n}', at));
  assert.match(body, /const now = shownModules\.has\('ask'\);/);
  assert.match(body, /if \(now !== askWasShown\) \{\n\s+askWasShown = now;/);
});

test('What\'s this? on the reader brings the panel on screen (un-hiding it) before asking, and the reader is told how to ask', () => {
  assert.match(JS, /onAsk: \(sel\) => \{ askExplain\(sel\); \},/);
  const at = JS.indexOf('function askExplain(sel) {');
  const body = JS.slice(at, JS.indexOf('\n}', at));
  assert.match(body, /revealModule\('ask'\);/, "#168's helper: a hidden panel returns on the rail, a railed one opens held");
  assert.doesNotMatch(body, /DTm\./, 'no operation site of its own');
  assert.match(body, /askPanel\.explainSelection\(sel\)/);
});

test('a card or a citation opens the reader at the line through the browser, which keeps the Files tab\'s highlight in step', () => {
  assert.match(JS, /openAt: \(file, line, endLine\) => repoBrowser\.openAt\(file, line, endLine\)\.catch\(\(\) => false\),/, 'the whole range; a failed open is not an unhandled rejection (PR #169 Miguel G1) and reads as "did not open", so it is not counted (PR #178 Miguel S1)');
  const browser = fs.readFileSync(path.join(APP, 'repo-browser.js'), 'utf8');
  assert.match(browser, /openAt: async \(path, line, endLine\) => \{ const r = await reader\.openAt\(path, line, endLine\); panel\.setSelected\(reader\.path\(\)\); return r; \},/);
});

test('the profile lives in the page\'s localStorage, which every tab shares: one explainer per person', () => {
  assert.match(JS, /const askPanel = askRoot \? window\.askDisplay\.mount\(\{[\s\S]*?storage: \(\(\) => \{ try \{ return localStorage; \} catch \{ return null; \} \}\)\(\),/);
});

test('the probe actions the view may be driven with are on the allow-list', () => {
  const shell = fs.readFileSync(path.join(APP, 'tab-shell.js'), 'utf8');
  assert.match(shell, /'askState', 'askDo',/);
  assert.match(JS, /case 'askState':/);
  assert.match(JS, /case 'askDo':/);
});

test('every class the panel builds has a rule in renderer.html', () => {
  const display = fs.readFileSync(path.join(APP, 'ask-display.js'), 'utf8');
  const classes = new Set();
  for (const m of display.matchAll(/class="([^"$]*)/g)) m[1].split(/\s+/).filter(c => c.startsWith('ask-')).forEach(c => classes.add(c));
  // structural hooks the markup carries for grouping and for the probe: styled through their parent, or not at all
  const STRUCTURAL = new Set(['ask-upload', 'ask-empty', 'ask-wait', 'ask-answer-wrap', 'ask-note-wrap', 'ask-hl-text']);
  const missing = [...classes].filter(c => !STRUCTURAL.has(c) && !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}\\b`).test(HTML));
  assert.deepStrictEqual(missing, []);
});

test('the explainer\'s face follows the roster\'s agent-images switch, which is declared further down renderer.js: read inside a try (a temporal-dead-zone read killed the whole page once), and repainted when it changes', () => {
  assert.match(JS, /imagesEnabled: \(\) => \{ try \{ return agentImagesEnabled === true; \} catch \{ return false; \} \},/);
  const at = JS.indexOf('function applyAgentImages(enabled) {');
  const body = JS.slice(at, JS.indexOf('\n}', at));
  assert.match(body, /if \(changed && askPanel\) askPanel\.repaint\(\);/);
  assert.ok(JS.indexOf('const askPanel = ') < JS.indexOf('let agentImagesEnabled'), 'the panel is mounted before the switch exists: that is why the read is guarded');
});

test('the explainer\'s picture goes through the agents\' own picker and upload message, and a new picture is re-read from the host', () => {
  // ONE helper sends it, for the roster's pencil and the Ask panel alike (PR #169 El Gordo 2), and the agent's name is one constant
  assert.match(JS, /function pickAndSetPortrait\(agent, state\) \{[\s\S]*?window\.harness\.avatar\.pick\(\)\.then\(\(path\) => \{[\s\S]*?\{ type: 'portrait', action: 'set', agent, state, path \}/);
  assert.strictEqual((JS.match(/\{ type: 'portrait', action: 'set', agent, state, path \}/g) || []).length, 1, 'one send for every portrait pick');
  assert.match(JS, /function askPickPortrait\(\) \{ return pickAndSetPortrait\(ASK_AGENT, 'sleeping'\); \}/);
  assert.match(JS, /pickAndSetPortrait\(agent, state\);\n\}\);/, 'the roster\'s pencil uses it too');
  assert.strictEqual((JS.match(/'ask-explainer'/g) || []).length, 0, 'the id is not typed here at all: it is the display module\'s AGENT');
  assert.match(JS, /const ASK_AGENT = window\.askExplainerDisplay\.AGENT;/);
  assert.match(JS, /if \(msg\.agent === ASK_AGENT && askPanel\) askPanel\.refresh\(\);/);
  assert.doesNotMatch(JS, /askShrinkImage|toDataURL/, 'no picker of the panel\'s own');
});

// --- gamification (BACKLOG #33): the explainer joins the roster ----------------------------------------------------------------------

test('the explainer\'s display module loads after the profile and before the panel that uses it (and after the agents\' state display it builds on)', () => {
  const at = (n) => HTML.indexOf(`<script src="./${n}.js">`);
  assert.ok(at('agent-state-display') !== -1 && at('roster-search-display') !== -1);
  assert.ok(at('agent-state-display') < at('ask-explainer-display') && at('roster-search-display') < at('ask-explainer-display'));
  assert.ok(at('ask-profile') < at('ask-explainer-display') && at('ask-explainer-display') < at('ask-display'));
});

test('the host\'s explainer frame, in the handshake and on its own, is what the roster draws from; a frame that isn\'t one is no frame', () => {
  assert.match(JS, /explainerFrame = window\.askExplainerDisplay\.frameOf\(msg\.explainer\);/);
  assert.match(JS, /if \(msg\.type === 'explainer'\) \{\n\s+applyExplainer\(msg\);\n\s+return;\n\s+\}/);
  assert.match(JS, /function applyExplainer\(raw\) \{\n\s+explainerFrame = window\.askExplainerDisplay\.frameOf\(raw\);\n\s+renderRoster\(\);/);
});

test('the frame\'s variable exists before the panel is mounted: mounting paints once, and the paint asks for it', () => {
  assert.ok(JS.indexOf('let explainerFrame = null;') !== -1 && JS.indexOf('let explainerFrame = null;') < JS.indexOf('const askPanel = '));
  assert.strictEqual((JS.match(/let explainerFrame\b/g) || []).length, 1);
});

test('the host is told when this window\'s Ask panel DOCKED anywhere (not hidden), on every change and again on a reattach', () => {
  assert.match(JS, /function sendAskPanel\(open\) \{ return askRequester\.notify\('panel', \{ open \}\); \}/);
  assert.doesNotMatch(JS, /sendJson\(\{ type: 'ask'/, 'no raw send of an ask frame: an older host would type it into the session (PR #178 Miguel B1)');
  const at = JS.indexOf('function askView() {');
  const body = JS.slice(at, JS.indexOf('\n}', at));
  assert.match(body, /const docked = askDockedNow\(\);/);
  assert.match(body, /if \(docked !== null && docked !== askWasDocked\) \{ askWasDocked = docked; sendAskPanel\(docked\); \}/);
  assert.doesNotMatch(body, /sendAskPanel\(now\)/, 'on screen is for the index polling only; Active follows docked (Ricardo)');
  assert.match(JS, /function askDockedNow\(\) \{ try \{ return window\.askExplainerDisplay\.docked\(placementLayout\(\)\); \} catch \{ return null; \} \}/);
  assert.match(JS, /askWasDocked = null;[^\n]*\n\s+if \(askPanel\) askView\(\);/, 'a reattach says it again');
});

test('opening a place from the panel tells the host (it counts the place and the explainer is happy), and its 🏅 opens the same give menu as the card, keyed by the fixed id', () => {
  assert.match(JS, /onOpenPlace: \(\) => askRequester\.notify\('opened'\)/);
  assert.match(JS, /onMedal: \(btn\) => \{ const r = btn\.getBoundingClientRect\(\); openMedalMenu\(ASK_AGENT, r\.left, r\.bottom \+ 2\); \}/);
  assert.match(JS, /gamify: \(\) => \(explainerFrame \? \{ state: explainerFrame\.state, detail: explainerFrame\.detail \} : null\)/);
});

test('the roster: the explainer is placed by its own rules (Active while a panel is open, else Inactive), sorted with the agents, and is never listed twice', () => {
  assert.match(JS, /window\.askExplainerDisplay\.tabFor\(explainerFrame, explainerProfile\(\)\)/);
  assert.match(JS, /const inactive = inactiveAll\.filter\(a => a !== ASK_AGENT\);/);
  assert.match(JS, /window\.agentStateDisplay\.sortRows\(\[\.\.\.roster\.values\(\), \.\.\.\(exRow \? \[exRow\] : \[\]\)\]\)/);
  assert.match(JS, /if \(roster\.size === 0 && !exRow\) \{/, 'an empty roster with the explainer on it is not "no agents yet"');
  assert.match(JS, /if \(r\.explainer\) return explainerCardHtml\(false\);/);
});

test('the explainer\'s card is keyed by the fixed id for medals, and wears its name only as a label (a rename keeps its medals)', () => {
  const at = JS.indexOf('function explainerCardHtml(inactive) {');
  const card = JS.slice(at, JS.indexOf('\nfunction explainerLogPage', at));
  assert.match(card, /cardButtonHtml\(ASK_AGENT, explainerLabel\(\)\)/);
  assert.match(card, /countOf\(medalList, ASK_AGENT\)/);
  assert.match(card, /data-agent="\$\{ASK_AGENT\}"/);
  assert.match(card, /badgeHtml\(f\.state, f\.detail\)/, 'the agents\' own corner badge');
  assert.match(card, /X\.countsHtml\(f\.counts\)/);
  assert.match(JS, /closest\('\.agent:not\(\[data-state="inactive"\]\), \.agent\[data-explainer\]'\)/, 'right-click gives a medal on its inactive card too');
});

test('its log page is its counts (no transcript is asked of the host), and closing it tells the host nothing', () => {
  const at = JS.indexOf('function openAgentLog(agent) {');
  const open = JS.slice(at, JS.indexOf('\n}\n', at));
  assert.ok(open.indexOf('if (agent === ASK_AGENT)') < open.indexOf("sendAgentLog('open', agent)"));
  assert.match(open, /page: explainerLogPage\(\)/);
  assert.match(JS, /if \(agentLog\.open && agentLog\.agent !== ASK_AGENT\) sendAgentLog\('close', agentLog\.agent\);/);
});

test('a new name or picture on the naming card moves the roster card too', () => {
  assert.match(JS, /onChange: \(\) => explainerProfileChanged\(\),/);
  assert.match(JS, /JSON\.stringify\(\[p\.named, p\.name, p\.portrait\]\)/);
});
