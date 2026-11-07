'use strict';
/**
 * The roster's agent cards, measured in a real window (heavy: run it through scripts/with-heavy-lock.js).
 *
 * A. BACKLOG #17 F4: "the roster rebuild can drop a click" (pre-existing since PR #68). A card's button (its medal
 *    button) is pressed with REAL input events (webContents.sendInputEvent: mouseDown, then mouseUp at the same point),
 *    and between the two the roster is rebuilt three ways:
 *      1. not at all (the control case: the click must land);
 *      2. renderRoster() with nothing changed (what every 1 s `processes` frame does while an agent runs);
 *      3. a real hook event that changes ANOTHER card's markup (a Bash call starting on a second agent), so the
 *         roster's markup is replaced while the button is held.
 *    Each case records whether a `click` reached the button. Then the repaint rate: how many times the roster's
 *    markup is really replaced in 10 s of an agent working with no new events, and in 10 s of one hook event a second.
 *    Measured 2026-11-07: the click is DROPPED (mousedown lands on the old button, mouseup on its replacement, so no
 *    `click` fires); a rebuild with nothing changed replaces no markup, and neither do 10 s of quiet; 10 s of one event a
 *    second on another agent replaced it 7 times. Recorded here, left for the hub (#17 F4).
 *    After PR #239 A5 (a repaint replaces only the cards whose markup changed), same day: the click LANDS and the clicked
 *    card keeps its node; 10 s of one Bash start or end a second on the other agent = 10 repaints replacing 10 card nodes of
 *    2 (before, every repaint replaced both), the quiet card kept throughout; two instances of one agent busy at once (a read
 *    and a Bash start or end a second) = 10 repaints, 13 card nodes of 4 (a full replace would be 40). A press on a card that
 *    DID change can still be dropped: BACKLOG #184.
 *    Case 4 (BACKLOG #184): the hook event aimed at the CLICKED card itself, 20 presses, each with that card's detail changing
 *    between mousedown and mouseup. Since #184 a changed card is patched in place (app/roster-morph.js), so its node stays and the
 *    click lands; the repaint counter now watches the cards' insides too (a patch swaps no child of #agents), and __removed still
 *    counts swapped card nodes, which a busy card no longer causes.
 * B. BACKLOG #162: a stressed card carries its cause as its hover (the card's title, and the words under its name), and a
 *    picture of it hovered: agent-card-stressed-hover.png. The OS draws a native tooltip outside the page, where capturePage
 *    can't see it, so the probe draws the card's own title text at the hover point, captioned ON the picture as the probe's
 *    drawing (PR #239 Miguel Y3). Then a sibling's repaint while hovered keeps the hovered card's node (Miguel Y5).
 * C. BACKLOG #142 b: two instances of one agent are two cards (data-instance = each spawn's tool_use_id), each its own state,
 *    no ×N badge; one finishing flashes, then leaves. Picture: agent-card-two-instances.png.
 * Pictures go to %TEMP%\cc-try\, through the app's own capturePage (never the screen).
 *
 * `claude` is replaced by cmd.exe (CLAUDE_CUSTOM_BIN) so nothing is billed. Everything goes to temp folders.
 *
 *   node scripts/with-heavy-lock.js node verify/probe-agent-cards.js
 */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const mainSource = (port, helper, pipe, userData) => `
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { probeWindowOptions } = require(path.join(ROOT, 'host', 'probe-window'));
// Inside the run's own temp folder, which cleanup() removes (PR #239 Miguel S9: it used to be left in %TEMP%).
app.setPath('userData', ${JSON.stringify(userData)});
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Hook events go from HERE, through the real native helper into the real hook bridge (an Electron main process is a
// node: no round trip to the parent, whose stdin pipe an Electron main never read on Windows).
const { spawnSync } = require('child_process');
const HELPER = ${JSON.stringify(helper)};
const PIPE = ${JSON.stringify(pipe)};
const send = (event, payload) => {
  const r = spawnSync(HELPER, ['--pipe', PIPE, '--event', event], { input: JSON.stringify(payload), windowsHide: true });
  if (r.status !== 0) throw new Error('helper exited ' + r.status + ' for ' + event);
};
let n = 0;
const by = (name) => ({ agent_id: 'a' + name + '-' + String(4242 + name.length).padStart(16, '0'), agent_type: name });
// One step of churn: probe-churn's Bash call starts (running) or ends (working): its card's markup changes either way.
let flying = null;
const churn = () => {
  // Each step its own command: the same one again and again is a retry loop, which turns the card stuck and re-sorts the roster
  // (a full replace, rightly), and the measurement below is about a card that changes in place.
  if (flying) { send('PostToolUse', { tool_name: 'Bash', tool_use_id: flying, tool_input: { command: 'step ' + flying }, tool_response: { exit_code: 0 }, ...by('probe-churn') }); flying = null; }
  else { flying = 'tu' + (++n); send('PreToolUse', { tool_name: 'Bash', tool_use_id: flying, tool_input: { command: 'step ' + flying }, ...by('probe-churn') }); }
};
// The same step aimed at any agent's card (BACKLOG #184: the clicked card's own churn), each agent with its own call in flight.
const flyingBy = {};
const churnOn = (name) => {
  const id = flyingBy[name];
  if (id) { send('PostToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'step ' + id }, tool_response: { exit_code: 0 }, ...by(name) }); flyingBy[name] = null; }
  else { const t = 'tc' + (++n); flyingBy[name] = t; send('PreToolUse', { tool_name: 'Bash', tool_use_id: t, tool_input: { command: 'step ' + t }, ...by(name) }); }
};
const need = async (what) => {
  if (what === 'churn') churn();
  if (what === 'busy') for (let i = 0; i < 10; i++) { churn(); await sleep(1000); }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow(probeWindowOptions({ width: 1000, height: 800, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } }));
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: {
    port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(ROOT)}, project: 'probe', token: 'probe-token' } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  // Every page call has its own limit: an executeJavaScript that never resolves (a page still loading) must not hang the probe.
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code),
    new Promise((_, reject) => setTimeout(() => reject(new Error('page call timed out: ' + code.slice(0, 60))), 10000))]);
  console.log('[step] window created');
  win.webContents.on('did-finish-load', () => console.log('[step] page loaded'));
  win.webContents.on('render-process-gone', (_e, d) => console.log('[step] renderer gone', JSON.stringify(d)));
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(100); }
    return null;
  };

  try {
    check('the renderer and the host are up', await until('typeof renderRoster === "function" && ws && ws.readyState === 1', 90000));
    for (const name of ['probe-click', 'probe-churn']) {
      send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_' + (++n), tool_input: { subagent_type: name } });
      send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'hi' }, tool_response: { exit_code: 0 }, ...by(name) });
    }
    // A fresh profile keeps the roster in the hidden panel store: put it on screen, selected, through the dock's own path.
    console.log('[dock] ' + await js('(() => { try { commitPlacement(DTm.show(settledLayout(), "agents"), { justThisTab: true, select: "agents" }); selectModule("agents"); } catch (e) { return "show failed: " + e.message; }' +
      ' const p = document.querySelector("[data-panel=agents]"); return JSON.stringify({ inStore: !!p.closest("#panel-store"), parent: p.parentElement && (p.parentElement.id || p.parentElement.className), layout: placementLayout() }); })()'));
    await js('setRosterTab("active")');
    const onScreen = '(() => { const r = document.getElementById("agents").getBoundingClientRect(); return r.width > 100 && r.height > 100; })()';
    if (!await until(onScreen, 5000)) {
      // Still in the store: lift the panel out as it is, fixed on the right. The cards, their CSS and the ONE roster click handler on
      // #agents are untouched; only where the panel sits differs from a docked one.
      console.log('[dock] the dock did not place it; lifting the panel out of the store');
      await js('(() => { const p = document.querySelector("[data-panel=agents]"); document.body.appendChild(p); Object.assign(p.style, { position: "fixed", right: "0", top: "40px", width: "380px", height: "640px", display: "flex", flexDirection: "column", zIndex: 50, background: "var(--bg, #111)" }); p.hidden = false; return true; })()');
    }
    check('the roster is on screen', await until(onScreen, 10000));
    check('both cards are on the roster', await until('document.querySelectorAll("#agents .agent[data-agent^=\\'probe-\\']").length === 2', 30000));
    // What reached the page: every click (capture phase, so nothing in the page can hide it from us), and every time the
    // roster's markup was really changed (paintAgents -> setRosterHtml: a card swapped, or patched in place).
    // __repaints: roster repaints that changed anything (one observer call per paint; the subtree too, since BACKLOG #184 patches a
    // changed card in place); __removed: card nodes they swapped (PR #239 A5: a sibling's change swapped only its own card; #184:
    // a changed card is patched, so none is swapped unless the cards themselves change).
    await js('window.__clicks = []; window.__repaints = 0; window.__removed = 0;' +
      ' document.addEventListener("click", (e) => { const t = e.target; window.__clicks.push({ onButton: !!(t && t.closest && t.closest("[data-medal-open]")), tag: t && t.tagName, id: t && t.id || null, cls: t && String(t.className || "") }); }, true);' +
      ' const agentsRoot = document.getElementById("agents");' +
      ' new MutationObserver((ms) => { window.__repaints++; for (const m of ms) if (m.target === agentsRoot) for (const n of m.removedNodes) if (n.classList && n.classList.contains("agent")) window.__removed++; }).observe(agentsRoot, { childList: true, subtree: true, attributes: true, characterData: true }); true');
    const cardNode = 'document.querySelector("#agents .agent[data-agent=\\'probe-click\\']")';
    const BTN = '#agents .agent[data-agent=\\'probe-click\\'] [data-medal-open]';
    // The point, and what is really under it (a press that lands on something else measures nothing).
    const point = async () => js('(() => { const b = document.querySelector("' + BTN + '"); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect();' +
      ' const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2); const at = document.elementFromPoint(x, y);' +
      ' return { x, y, w: r.width, h: r.height, dpr: window.devicePixelRatio, inner: [window.innerWidth, window.innerHeight], onButton: !!(at && at.closest && at.closest("[data-medal-open]")), at: at ? at.tagName + "." + String(at.className || "") : null }; })()');
    const closeMenu = () => js('(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); if (typeof medalMenuEl !== "undefined" && medalMenuEl) medalMenuEl.hidden = true; return true; })()');
    const press = async (between) => {
      await closeMenu();
      await sleep(300);
      const p = await point();
      console.log('[point] ' + JSON.stringify(p));
      await js('window.__clicks = []; window.__repaints = 0; true');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(80);
      await between();
      await sleep(80);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(300);
      return JSON.parse(await js('JSON.stringify({ clicks: window.__clicks, repaints: window.__repaints })'));
    };

    const plain = await press(async () => {});
    check('1. a plain press and release reaches the button (the control case)', plain.clicks.some(c => c.onButton), plain);

    const same = await press(async () => { await js('renderRoster(); renderRoster(); renderRoster(); true'); });
    check('2. renderRoster() with nothing changed replaces no markup', same.repaints === 0, same.repaints);
    check('2. ...and the click lands', same.clicks.some(c => c.onButton), same);

    await js('window.__clickCard = ' + cardNode + '; true');
    const changed = await press(async () => {
      await need('churn');
      await until('window.__repaints > 0', 5000);
    });
    check('3. a real hook event on ANOTHER agent repainted the roster while the button was held', changed.repaints > 0, changed.repaints);
    const kept = await js('window.__clickCard === ' + cardNode);
    const landed = changed.clicks.some(c => c.onButton);
    console.log('[F4] click with ANOTHER card repainted between mousedown and mouseup: ' + (landed ? 'LANDED' : 'DROPPED') + ', the clicked card node ' + (kept ? 'kept' : 'replaced') + ' ' + JSON.stringify(changed));
    // Before PR #239 A5 every repaint replaced every card, and this click was DROPPED (measured twice on 2026-11-07).
    check('3. A5: the clicked card, unchanged, keeps its node', kept === true);
    check('3. A5: ...and the click lands', landed, changed);

    // 4. BACKLOG #184: the hook event aimed at the CLICKED card itself, 20 presses. Each press: mousedown on its medal button, a
    // Bash call starting or ending on probe-click (its card's detail changes: working <-> running), then mouseup at the same point.
    // Before #184 the changed card's node was swapped and the click dropped; now the card is patched in place and must land.
    const aimed = { presses: 0, changed: 0, landed: 0, dropped: 0, kept: 0, swapped: 0 };
    for (let k = 0; k < 20; k++) {
      await js('window.__clickCard = ' + cardNode + '; window.__detail0 = window.__clickCard.dataset.detail; window.__removed = 0; true');
      const r = await press(async () => {
        churnOn('probe-click');
        await until('(() => { const c = ' + cardNode + '; return !!c && c.dataset.detail !== window.__detail0; })()', 5000);
      });
      const after = JSON.parse(await js('JSON.stringify({ changed: (' + cardNode + ').dataset.detail !== window.__detail0, kept: window.__clickCard === ' + cardNode + ', removed: window.__removed })'));
      aimed.presses++;
      if (after.changed) aimed.changed++;
      if (after.kept) aimed.kept++;
      aimed.swapped += after.removed;
      if (r.clicks.some(c => c.onButton)) aimed.landed++; else aimed.dropped++;
    }
    console.log('[#184] 20 presses, each with the CLICKED card changing between mousedown and mouseup: ' + JSON.stringify(aimed));
    check('4. #184: the clicked card really changed during every press', aimed.changed === 20, aimed);
    check('4. #184: the clicked card kept its node through every press', aimed.kept === 20 && aimed.swapped === 0, aimed);
    check('4. #184: 0 of 20 clicks dropped', aimed.dropped === 0 && aimed.landed === 20, aimed);

    // The repaint rate. Quiet: an agent working, no events, processes frames every second.
    await js('window.__repaints = 0; window.__removed = 0; true');
    await sleep(10000);
    const quiet = await js('window.__repaints');
    console.log('[F4] markup replacements in 10 s of a working agent with no events: ' + quiet);
    check('quiet: the 1 s processes frames replace no markup', quiet === 0, quiet);
    await js('window.__repaints = 0; window.__removed = 0; window.__clickCard = ' + cardNode + '; true');
    await need('busy');
    const busy = JSON.parse(await js('JSON.stringify({ repaints: window.__repaints, removed: window.__removed, kept: window.__clickCard === ' + cardNode + ' })'));
    console.log('[F4] 10 s of one Bash call starting or ending a second on another agent: ' + busy.repaints + ' repaints, ' + busy.removed +
      ' card nodes replaced (2 cards on the roster), the quiet card node ' + (busy.kept ? 'kept throughout' : 'replaced'));
    check('busy: the roster is repainted when a card changes', busy.repaints > 0, busy);
    // A5 kept the quiet card; since #184 the changing card is patched in place too, so no card node is swapped at all.
    check('busy: A5 + #184: the quiet card keeps its node, and the changing card is patched, not swapped', busy.removed === 0 && busy.kept, busy);

    // Pictures, through the app's own capturePage (never the screen): the roster panel's rectangle.
    const SHOTS = path.join(require('os').tmpdir(), 'cc-try');
    const shot = async (name) => {
      fs.mkdirSync(SHOTS, { recursive: true });
      const r = JSON.parse(await js('JSON.stringify((() => { const b = document.querySelector("[data-panel=agents]").getBoundingClientRect();' +
        ' return { x: Math.max(0, Math.floor(b.left)), y: Math.max(0, Math.floor(b.top)), width: Math.ceil(b.width), height: Math.min(Math.ceil(b.height), window.innerHeight - Math.max(0, Math.floor(b.top))) }; })())'));
      const img = await win.webContents.capturePage(r);
      const file = path.join(SHOTS, name);
      fs.writeFileSync(file, img.toPNG());
      console.log('[shot] ' + file);
      return file;
    };

    // B. BACKLOG #162: a stressed card says why on hover (its title, and the words under its name).
    // Case 3's click now lands (A5) and opens the medal menu: close it, so it doesn't cover the cards in the pictures.
    await closeMenu();
    check('the medal menu is closed before the pictures', await until('typeof medalMenuEl === "undefined" || !medalMenuEl || medalMenuEl.hidden', 3000));
    send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 }, ...by('probe-click') });
    const SC = '#agents .agent[data-agent=\\'probe-click\\']';
    const title = await until('(() => { const c = document.querySelector("' + SC + '"); return c && c.dataset.state === "stressed" && c.getAttribute("title"); })()', 10000);
    check('B. the stressed card carries its cause as its hover', title === 'A Bash call failed', title);
    const stateTitle = await js('(() => { const s = document.querySelector("' + SC + ' .state"); return s && s.getAttribute("title"); })()');
    check('B. ...and the words under its name carry the same', stateTitle === title, stateTitle);
    // A native tooltip is drawn by the OS, outside the page, so capturePage can't see it: the probe draws the card's OWN title text
    // at the hover point (id probe-tooltip), with a caption ON the picture saying it's the probe's drawing, not the app's look
    // (PR #239 Miguel Y3), and takes both away after the picture.
    const at = await js('(() => { const c = document.querySelector("' + SC + '"); c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect();' +
      ' const box = document.createElement("div"); box.id = "probe-tooltip";' +
      ' Object.assign(box.style, { position: "fixed", left: Math.round(r.left + 24) + "px", top: Math.round(r.top + r.height / 2 + 16) + "px", zIndex: 9999, pointerEvents: "none", maxWidth: "300px" });' +
      ' const tip = document.createElement("div"); tip.textContent = c.getAttribute("title");' +
      ' Object.assign(tip.style, { background: "#2b2b2b", color: "#fff", border: "1px solid #888", font: "12px Segoe UI, sans-serif", padding: "3px 7px", whiteSpace: "nowrap", display: "inline-block" });' +
      ' const cap = document.createElement("div"); cap.textContent = "Probe\\u2019s drawing of the card\\u2019s hover text. Windows draws the real tooltip outside the page.";' +
      ' Object.assign(cap.style, { marginTop: "3px", background: "#fff3c4", color: "#5a4500", border: "1px dashed #b38f00", font: "italic 10px Segoe UI, sans-serif", padding: "2px 5px", whiteSpace: "normal" });' +
      ' box.append(tip, cap); document.body.appendChild(box); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await sleep(500);
    await shot('agent-card-stressed-hover.png');
    await js('document.getElementById("probe-tooltip").remove(); true');
    // Miguel Y5: with the pointer on the stressed card, another agent's card changes: the hovered card keeps its node (so the OS
    // tooltip it owns isn't torn down by a sibling's repaint).
    await js('window.__repaints = 0; window.__clickCard = ' + cardNode + '; true');
    await need('churn');
    await until('window.__repaints > 0', 5000);
    check('B. Y5: a sibling\\'s repaint keeps the hovered card\\'s node', await js('window.__clickCard === ' + cardNode));
    // #184 (Miguel Y5's rest): the HOVERED card itself changes (a Bash call on probe-click starts and ends well: stressed -> working,
    // its cause title goes; working and probe-churn's working sort the same, by name, so the cards keep their places). Patched in
    // place, the node the pointer is over stays and its title changes on it. The OS tooltip itself is drawn outside the page, so
    // what's measured is the node and its title, not the tooltip's pixels.
    await js('window.__clickCard = ' + cardNode + '; true');
    churnOn('probe-click');
    churnOn('probe-click');
    const hoverAfter = await until('(() => { const c = ' + cardNode + '; return c && c.dataset.state !== "stressed" ? JSON.stringify({ state: c.dataset.state, title: c.getAttribute("title"), kept: c === window.__clickCard, hovered: c.matches(":hover") }) : null; })()', 5000);
    console.log('[#184] the hovered card itself changed: ' + hoverAfter);
    const hv = hoverAfter ? JSON.parse(hoverAfter) : {};
    check('B. #184: the hovered card changing keeps its node, still hovered, its title updated on it', hv.kept === true && hv.hovered === true && hv.title !== title, hoverAfter);

    // C. BACKLOG #142 b: two instances of one agent are two cards, each with its own state; no ×N badge.
    const twin = (k) => ({ agent_id: 'aprobe-twin-' + String(7000 + k).padStart(16, '0'), agent_type: 'probe-twin' });
    for (const k of [1, 2]) {
      send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_twin' + k, tool_input: { subagent_type: 'probe-twin' } });
      send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'hi ' + k }, tool_response: { exit_code: 0 }, ...twin(k) });
    }
    send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 }, ...twin(2) });
    const TW = '#agents .agent[data-agent=\\'probe-twin\\']';
    const twins = await until('(() => { const cs = [...document.querySelectorAll("' + TW + '")]; if (cs.length !== 2 || cs[1].dataset.state !== "stressed") return null;' +
      ' return JSON.stringify(cs.map(c => ({ instance: c.dataset.instance, state: c.dataset.state, title: c.getAttribute("title") }))); })()', 10000);
    check('C. two instances are two cards, each its own state, keyed by the spawn\\'s id', twins === JSON.stringify([
      { instance: 'toolu_twin1', state: 'working', title: null }, { instance: 'toolu_twin2', state: 'stressed', title: 'A Bash call failed' }]), twins);
    check('C. no ×N badge anywhere on the roster', await js('document.querySelectorAll("#agents .agent-count").length === 0'));
    await js('(() => { document.querySelector("' + TW + '").scrollIntoView({ block: "start" }); return true; })()');
    await sleep(300);
    await shot('agent-card-two-instances.png');
    // Dexter 5's rate: two instances of one agent busy at once (one reading every second, the other running a Bash call that
    // starts or ends every second), 10 s. Each instance's detail is its own card now, so this is the per-instance repaint rate.
    await js('window.__repaints = 0; window.__removed = 0; true');
    for (let i = 0; i < 10; i++) {
      send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tr' + (++n), tool_input: { file_path: 'C:/x' + i }, ...twin(1) });
      if (i % 2 === 0) send('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tb' + i, tool_input: { command: 'b' + i }, ...twin(2) });
      else send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tb' + (i - 1), tool_input: { command: 'b' + (i - 1) }, tool_response: { exit_code: 0 }, ...twin(2) });
      await sleep(1000);
    }
    const twinRate = JSON.parse(await js('JSON.stringify({ repaints: window.__repaints, removed: window.__removed, cards: document.querySelectorAll("#agents .agent").length })'));
    console.log('[F4] 10 s of two instances of one agent busy (a read a second, a Bash start or end a second): ' + twinRate.repaints + ' repaints, ' +
      twinRate.removed + ' card nodes replaced, ' + twinRate.cards + ' cards on the roster');
    check('C. Dexter 5: two busy instances repaint only their own cards, never the whole roster each time', twinRate.repaints > 0 && twinRate.removed < twinRate.repaints * twinRate.cards, twinRate);
    // One of them finishing: its card flashes, then leaves, and the name is one card again.
    send('SubagentStop', twin(1));
    const flashing = await until('(() => { const c = document.querySelector("' + TW + '[data-instance=toolu_twin1]"); return c && c.dataset.state === "happy"; })()', 5000);
    check('C. a finished instance flashes happy on its own card', !!flashing);
    const one = await until('document.querySelectorAll("' + TW + '").length === 1', 15000);
    check('C. ...then leaves: one card for the name again', !!one);
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  // app.exit alone left this window running until the parent's timeout (measured twice): destroy it, then leave.
  try { win.destroy(); } catch { /* already gone */ }
  process.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function run() {
  const helper = process.env.CLAUDE_CUSTOM_HELPER || path.join(ROOT, '.harness', 'hook-helper.exe');
  const mainHelper = fs.existsSync(helper) ? helper : path.join(ROOT, '..', 'dev', '.harness', 'hook-helper.exe');
  if (!fs.existsSync(mainHelper)) { check('the native hook helper exists', false, mainHelper); return; }

  const hygiene = createHygieneRegistry();
  hygiene.install();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-cards-'));
  const port = String(await freePort());
  const sessionId = 'agentcards' + process.pid;
  const pipe = `claude-custom-${sessionId}`;
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    CLAUDE_CUSTOM_CWD: tmp, CLAUDE_CUSTOM_PORT: port, CLAUDE_CUSTOM_TOKEN: 'probe-token',
    CLAUDE_CUSTOM_SESSION_ID: sessionId, CLAUDE_CUSTOM_HELPER: mainHelper,
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'forge'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  noteChild(host);
  hygiene.registerChild(host);
  let hostOut = '';
  host.stdout.on('data', d => { hostOut += d; });
  host.stderr.on('data', d => { hostOut += d; });
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (/hook bridge listening on/.test(hostOut) && /listening on ws:/.test(hostOut)) { clearInterval(t); resolve(); }
        else if (/EADDRINUSE|ReferenceError|TypeError|SyntaxError/.test(hostOut)) { clearInterval(t); reject(new Error('host failed:\n' + hostOut)); }
      }, 100);
      setTimeout(() => { clearInterval(t); reject(new Error('host did not listen within 20s:\n' + hostOut)); }, 20000);
    });

    const mainFile = path.join(tmp, 'probe-main.js');
    fs.writeFileSync(mainFile, mainSource(port, mainHelper, pipe, path.join(tmp, 'userdata')));
    const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_SESSION_ID', 'CLAUDE_CUSTOM_HELPER'] });
    hygiene.registerChild(electron);
    electron.stdout.on('data', d => process.stdout.write(d));
    // Only the page's own lines: the main-process IPC noise (no handler for chrome:getSettings ...) is the bare probe main's.
    electron.stderr.on('data', d => { if (/probe|\[page\]|SyntaxError|TypeError|ReferenceError/.test(String(d))) process.stderr.write(d); });
    const killer = setTimeout(() => {
      console.log('FAIL: probe timed out after 240s');
      try { require('../host/kill-tree').killPidTree(electron.pid); } catch { /* the sweep below still runs */ }   // kill-ok(held-handle): our own child
      hygiene._emergencyCleanup('timeout');
    }, 240000);
    const code = await new Promise((resolve) => electron.on('exit', resolve));
    clearTimeout(killer);
    check('the window probe passed', code === 0, `exit ${code}`);
    if (code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  } finally {
    hygiene._emergencyCleanup('done');
    cleanup();
  }
}

run().then(() => {
  console.log(failures ? `\nprobe-agent-cards: ${failures} FAILED` : '\nprobe-agent-cards: every check held');
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.log('FAIL: probe could not run:', err && err.stack || err);
  process.exit(1);
});
