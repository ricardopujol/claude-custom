'use strict';
/**
 * verify/probe-shell-guard.js asks a bypassed `claude` to run destructive commands, so what keeps it safe is pinned here as
 * source and case-list assertions (the probe is not run by `npm test`), in the style of test/probe-side-session-hygiene.test.js.
 * Every command must be harmless if the hook fails and it really runs.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-shell-guard.js'), 'utf8');
const PROBE = strip(SRC);
// the machinery after the case list: the cases themselves legitimately spell taskkill, Stop-Process and the like
const CODE = PROBE.slice(PROBE.indexOf('const git = (cwd'));
const { buildCases, attemptCmd, spawnVictim, childEnv, REG_KEY, HOOK, SCRATCH_NAME } = require('../verify/probe-shell-guard.js');

const S = 'C:/Users/ricar/AppData/Local/cc-shell-guard-test';
const CTX = { scratch: S, repo: `${S}/repo`, port: 5555, victimPid: 4242 };
const CASES = buildCases(CTX);

test('the case list covers every deny class, both tools, and has ask and allow cases', () => {
  const denies = CASES.filter((c) => c.want === 'deny');
  assert.deepStrictEqual([...new Set(denies.map((c) => c.cls))].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.ok(denies.length >= 30, `${denies.length} deny cases`);
  assert.ok(CASES.filter((c) => c.want === 'ask').length >= 8);
  assert.ok(CASES.filter((c) => c.want === 'allow').length >= 4);
  assert.deepStrictEqual([...new Set(CASES.map((c) => c.tool))].sort(), ['Bash', 'PowerShell']);
  assert.strictEqual(new Set(CASES.map((c) => c.id)).size, CASES.length, 'ids are unique');
});

test('no case names a real process: kill-by-name uses the canary name only', () => {
  const text = CASES.map((c) => c.cmd).join('\n');
  assert.doesNotMatch(text, /\b(node|claude|electron|explorer|chrome|msedge|powershell|pwsh|svchost|code)\.exe\b/i);
  for (const c of CASES.filter((x) => x.cls === 'b')) assert.match(c.cmd, /cc-probe-canary/, c.id);
  for (const c of CASES.filter((x) => /taskkill/i.test(x.cmd) && x.want !== 'allow')) assert.doesNotMatch(c.cmd, /\/PID\b/i, c.id);
  const allowKill = CASES.find((c) => c.id === 'allow-taskkill-pid');
  assert.strictEqual(allowKill.cmd, `taskkill /PID ${CTX.victimPid} /F`);
});

test('a retry never reuses a stale victim pid: every attempt of the taskkill case gets a fresh, live victim of its own', () => {
  const c = CASES.find((x) => x.id === 'allow-taskkill-pid');
  assert.strictEqual(typeof c.victimCmd, 'function');
  let next = 9000;
  const killed = [];
  const fake = { spawnFn: () => ({ pid: next++, alive: true }), kill: (v) => { killed.push(v.pid); v.alive = false; } };
  const w = { victim: null };
  assert.strictEqual(attemptCmd(w, c, fake), 'taskkill /PID 9000 /F');
  w.victim.alive = false;   // attempt 1 killed it and its result was lost: the retry must not name 9000 again
  assert.strictEqual(attemptCmd(w, c, fake), 'taskkill /PID 9001 /F');
  assert.deepStrictEqual(killed, [], 'a dead victim is never killed again by pid');
  assert.strictEqual(attemptCmd(w, c, fake), 'taskkill /PID 9002 /F');
  assert.deepStrictEqual(killed, [9001], 'a live leftover is ended (it is ours and alive) before its replacement');
  assert.throws(() => attemptCmd({ victim: null }, c, { spawnFn: () => ({ pid: 1, alive: false }), kill() {} }), /did not start/);
  assert.strictEqual(attemptCmd(w, CASES.find((x) => x.id === 'allow-ls'), fake), 'ls');
  // and runCase really sends that per-attempt command, inside the retry loop
  const loop = PROBE.slice(PROBE.indexOf('for (let attempt = 0;'), PROBE.indexOf('return out;'));
  assert.match(loop, /const cmd = attemptCmd\(w, c\);[\s\S]*runClaude\(w, \{ \.\.\.c, cmd \}/);
  assert.match(loop, /norm\(u\.command\) === norm\(cmd\)/);
});

test('kill-ok(guard-case) is used only on deny cases that name the canary process (the class excuses nothing else)', () => {
  const lines = SRC.split(/\r?\n/).filter((l) => /kill-ok\(guard-case\)/.test(l));
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.match(l, /^\s*deny\('b', '\w+', '[\w-]+', '[^']*cc-probe-canary[^']*'\);/, l.trim());
});

test('every URL points at localhost or a name that cannot resolve (.invalid); no real host, repo or token', () => {
  for (const c of CASES) {
    for (const m of c.cmd.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s:'"]+)/gi)) {
      if (m[1] === '') continue;   // file:/// has no host
      assert.match(m[1], /^(127\.0\.0\.1|localhost|cc-probe-canary|[a-z0-9.-]+\.invalid)$/i, `${c.id}: ${m[0]}`);
    }
    assert.doesNotMatch(c.cmd, /github\.com|gitlab|bitbucket|ricardopujol|\.ssh|hosts\.yml|credentials|id_rsa|GH_TOKEN=|GITHUB_TOKEN/i, c.id);
    assert.doesNotMatch(c.cmd.split(S).join('').split(S.replace(/\//g, '\\')).join(''), /Users[\\/]ricar/i, `${c.id}: touches a real path`);
  }
});

test('cloud and gh CLIs only run with a sandbox env prefix pointing at a dead localhost endpoint', () => {
  for (const c of CASES.filter((x) => /\b(gh|docker|kubectl|aws|terraform)\b/.test(x.cmd))) {
    assert.match(c.cmd, /^(GH_HOST=localhost:1 GH_ENTERPRISE_TOKEN=x GH_CONFIG_DIR=\S+ |DOCKER_HOST=tcp:\/\/127\.0\.0\.1:1 |KUBECONFIG=\S+ |AWS_ENDPOINT_URL=http:\/\/127\.0\.0\.1:1 )/, c.id);
  }
});

const DOCKER_ENV = 'DOCKER_HOST=tcp://127.0.0.1:1 ';
const GAP_OPTION = /^docker (-H tcp:\/\/127\.0\.0\.1:1|--context cc-probe-canary-none) /;

test('no prune anywhere in the case list (bare, docker prune wipes Ricardo\'s real stopped containers; no carve-outs)', () => {
  for (const c of CASES) assert.doesNotMatch(c.cmd, /\bprune\b/i, c.id);
});

test('known-gap cases: docker only, a dead endpoint or a missing context under the DOCKER_HOST prefix, deny wanted', () => {
  const gaps = CASES.filter((c) => c.knownGap);
  assert.deepStrictEqual(gaps.map((c) => c.id), ['gap-docker-H-volume-rm', 'gap-docker-context-volume-rm', 'gap-docker-H-rm-f']);
  for (const c of gaps) {
    assert.strictEqual(c.want, 'deny', c.id);
    assert.ok(c.cmd.startsWith(DOCKER_ENV), c.id);
    assert.match(c.cmd.slice(DOCKER_ENV.length), GAP_OPTION, c.id);
    // run bare against the real daemon it still removes nothing: the object it names does not exist
    assert.match(c.cmd, / (volume rm cc-probe-canary-none|rm -f cc-probe-canary)$/, c.id);
  }
});

test('Restart-Computer / Stop-Computer only ever name a -ComputerName that cannot resolve (.invalid)', () => {
  for (const c of CASES.filter((x) => /\b(Restart|Stop)-Computer\b/i.test(x.cmd))) {
    assert.match(c.cmd, /-ComputerName\s+\S+\.invalid(\s|$)/i, c.id);
  }
  for (const c of CASES) assert.doesNotMatch(c.cmd, /\bshutdown\b(?!\s+\/a\s*$)/i, `${c.id}: only shutdown /a`);
});

test('every command is still harmless with its env prefix dropped, and nothing leans on the cwd', () => {
  const ENV = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/;
  for (const c of CASES) {
    const bare = c.cmd.replace(ENV, '');
    if (/^gh\b/.test(bare)) assert.match(bare, /\bcc-probe-canary\.invalid\/cc-probe-canary\/none\b/, `${c.id}: the gh repo names a .invalid host`);
    if (/^docker\b/.test(bare) && !c.knownGap) assert.match(bare, /\bcc-probe-canary(-none)?$/, `${c.id}: docker names a canary that does not exist`);
    if (/^kubectl\b/.test(bare)) assert.match(bare, /--server=http:\/\/127\.0\.0\.1:1\b/, c.id);
    if (/^aws\b/.test(bare)) assert.match(bare, /--endpoint-url http:\/\/127\.0\.0\.1:1\b/, c.id);
    if (/^winget install\b/.test(bare)) assert.match(bare, /--source cc-probe-canary-none\b/, c.id);
    // git that writes (push, clean, reflog, stash, worktree) is pointed at the scratch repo explicitly
    if (/^git\b/.test(bare) && !/^git status$/.test(bare)) assert.ok(bare.startsWith(`git -C ${CTX.repo} `), `${c.id}: git -C <scratch repo>`);
    // a secret read or recursive delete names its target absolutely, inside the scratch folder
    if (c.cls === 'f' || (c.cls === 'a' && /\brm\b|Remove-Item|\brd\b/.test(bare))) assert.ok(bare.includes(CTX.repo) || bare.includes(CTX.repo.replace(/\//g, '\\')), `${c.id}: absolute scratch target`);
  }
  assert.strictEqual(CASES.find((c) => c.id === 'allow-rm-node-modules').cmd, `rm -rf ${CTX.repo}/node_modules`);
});

test('every delete / secret-read / upload target is the probe\'s scratch folder or its fake files', () => {
  for (const c of CASES.filter((x) => x.cls === 'a' && /rm|Remove-Item|rd|find|rmSync/.test(x.cmd))) {
    const targets = c.cmd.match(/[A-Za-z]:[\\/][^\s'"]+/g) || [];
    for (const t of targets) assert.ok(t.replace(/\\/g, '/').startsWith(S), `${c.id}: ${t}`);
  }
  for (const c of CASES.filter((x) => x.cls === 'f')) assert.match(c.cmd, /\.env|cc-probe\.pem/, c.id);
  for (const c of CASES.filter((x) => x.cls === 'g' && !/scp/.test(x.cmd))) assert.match(c.cmd, /127\.0\.0\.1:5555/, c.id);
  for (const c of CASES.filter((x) => x.cls === 'c')) assert.doesNotMatch(c.cmd, /\bhttps?:|git@/, c.id);
  for (const c of CASES.filter((x) => /\breg\b|Set-ItemProperty/.test(x.cmd))) assert.match(c.cmd, /cc-probe-canary/, c.id);
  assert.strictEqual(REG_KEY, 'HKCU\\Software\\cc-probe-canary');
});

test('the child claude gets none of Ricardo\'s credentials or this session\'s plumbing, and keeps what claude needs', () => {
  const STRIPPED = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'AZURE_CLIENT_SECRET',
    'ARM_CLIENT_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'KUBECONFIG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'SSH_AUTH_SOCK',
    'GIT_ASKPASS', 'ELEVENLABS_API_KEY', 'NPM_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'Some_Api_Key',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CUSTOM_PORT', 'claude_custom_token', 'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PROJECT_DIR'];
  const KEPT = ['PATH', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SystemRoot', 'TEMP', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HEAVY_LOCK_HELD'];
  const base = Object.fromEntries([...STRIPPED, ...KEPT].map((k) => [k, 'x']));
  const env = childEnv(base);
  assert.deepStrictEqual(STRIPPED.filter((k) => k in env), [], 'stripped');
  assert.deepStrictEqual(KEPT.filter((k) => !(k in env)), [], 'kept');
  assert.ok('GH_TOKEN' in base, 'the caller\'s env is not mutated');
  assert.match(PROBE, /env: childEnv\(\)/, 'the claude run uses it');
});

test('the scratch folder is NOT under the hook\'s allowed temp root (a canary there could never be refused)', () => {
  assert.match(PROBE, /const SCRATCH_BASE = process\.env\.LOCALAPPDATA/);
  assert.match(PROBE, /mkdtempSync\(path\.join\(SCRATCH_BASE,/);
  assert.doesNotMatch(PROBE, /mkdtempSync\(path\.join\(os\.tmpdir\(\)/);
});

test('safety rules of the run: env stripped, haiku, one claude at a time under the heavy lock, kill by pid, quoted forward-slash hook', () => {
  assert.match(PROBE, /\/\^CLAUDE_CUSTOM_\/i/);
  assert.match(PROBE, /ELECTRON_RUN_AS_NODE/);
  assert.match(PROBE, /'--model', 'haiku'/);
  assert.match(PROBE, /'--dangerously-skip-permissions'/);
  assert.match(PROBE, /with-heavy-lock\.js/);
  assert.match(PROBE, /HEAVY_LOCK_HELD/);
  assert.match(PROBE, /spawnWithTimeout/);
  assert.match(PROBE, /timeoutMs: RUN_TIMEOUT_MS/);
  assert.match(PROBE, /if \(v && v\.alive\) require\('\.\.\/host\/kill-tree'\)\.killPidTree\(v\.pid\)/);
  assert.doesNotMatch(PROBE, /Promise\.all|Promise\.allSettled|\.map\(async/, 'no concurrency: one claude at a time');
  assert.strictEqual(HOOK, 'C:/Users/ricar/.claude/skills/worktree/scripts/shell-guard.js');
  assert.match(PROBE, /command: `node "\$\{HOOK\}"`/);
});

test('it never writes the real settings or anything under ~/.claude, and never stashes the real repo', () => {
  assert.doesNotMatch(PROBE, /writeFileSync\([^)]*\.claude/);
  assert.doesNotMatch(PROBE, /\.claude[\\/]+settings\.json/);
  assert.match(PROBE, /const settingsFile = path\.join\(w\.dir, 'settings\.json'\)/);
  assert.match(PROBE, /'--setting-sources', 'project'/);
  assert.doesNotMatch(CODE, /execSync|taskkill|pkill|killall|Stop-Process|\/IM\b/i);
});

test('the gate case runs first and a failed gate aborts with exit 2 before any other case', () => {
  const gate = PROBE.indexOf('const gev = await runCase(w, gate, settingsFile)');
  const loop = PROBE.indexOf('for (const c of cases)');
  assert.ok(gate > 0 && loop > gate);
  assert.match(PROBE, /GATE FAILED/);
  assert.match(PROBE, /aborted = true/);
  assert.match(PROBE, /if \(!aborted\) \{/);
  assert.match(PROBE, /process\.exit\(aborted \? 2 : failures \? 1 : 0\)/);
});

test('cleanup: the registry canary, the listener, the victim and the scratch folder are removed on the way out', () => {
  assert.match(PROBE, /spawnSync\('reg', \['delete', REG_KEY, '\/f'\]/);
  assert.match(PROBE, /server\.close\(\)/);
  assert.match(PROBE, /fs\.rmSync\(w\.dir, \{ recursive: true/);
  assert.match(PROBE, /process\.on\('exit', cleanup\)/);
});

test('cleanup is armed before anything is made, on exit AND on signals, and leftovers of a killed run are swept under the lock', () => {
  const made = PROBE.indexOf('w = makeWorld();');
  assert.ok(made > 0);
  for (const marker of ["process.on('exit', cleanup)", 'process.on(sig, () => { cleanup(); process.exit(code); })', 'sweepLeftovers();']) {
    const at = PROBE.indexOf(marker);
    assert.ok(at > 0 && at < made, `${marker} comes before makeWorld`);
  }
  assert.ok(PROBE.indexOf('sweepLeftovers();') > PROBE.indexOf("if (!process.env.HEAVY_LOCK_HELD)"), 'the sweep runs only once the lock is held');
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.match(PROBE, new RegExp(`\\['${sig}', \\d+\\]`));
  assert.match(PROBE, /if \(cleaned\) return;/, 'cleanup runs once even when exit follows a signal');
  // the sweep takes only this probe's own mkdtemp folders
  assert.match(PROBE, /mkdtempSync\(path\.join\(SCRATCH_BASE, 'cc-shell-guard-'\)\)/);
  for (const n of ['cc-shell-guard-aq8keV', 'cc-shell-guard-0oDV2q']) assert.match(n, SCRATCH_NAME);
  for (const n of ['cc-shell-guard-', 'cc-shell-guard-aq8keV2', 'cc-shell-guard-aq8ke.', 'Temp', 'claude-cli-nodejs', 'xcc-shell-guard-aq8keV']) assert.doesNotMatch(n, SCRATCH_NAME, n);
});

test('the victim expires on its own (a run killed before cleanup cannot leave it spinning forever)', async () => {
  assert.match(PROBE, /const VICTIM_TTL_MS = 10 \* 60000;/);
  const v = spawnVictim(300);
  try {
    assert.ok(v.alive);
    const deadline = Date.now() + 5000;
    while (v.alive && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(v.alive, false, 'the victim exited by itself');
  } finally {
    if (v.alive) v.proc.kill();   // the held child handle
  }
});

test('every case list entry agrees with the hook itself (skipped when the hook is not installed)', (t) => {
  if (!fs.existsSync(HOOK)) return t.skip('hook not installed on this machine');
  const { decide } = require(HOOK);
  const fakeRepo = `${S}/repo`;
  const wrong = [];
  const exists = (p) => (p.replace(/\\/g, '/').toLowerCase() === `${fakeRepo}/.git`.toLowerCase() ? 'dir' : (fs.existsSync(p) ? 'dir' : null));
  for (const c of CASES.filter((x) => !x.knownGap)) {   // known gaps disagree with the hook by definition
    const r = decide({ tool: c.tool, command: c.cmd, cwd: fakeRepo }, { projectDir: fakeRepo, exists });
    if (r.decision !== c.want) wrong.push(`${c.id}: want ${c.want}, hook says ${r.decision} ${r.reason.slice(0, 80)}`);
  }
  assert.deepStrictEqual(wrong, []);
});

test('a known-gap case with its global option dropped (a model "fixing" it) is denied by the hook', (t) => {
  if (!fs.existsSync(HOOK)) return t.skip('hook not installed on this machine');
  const { decide } = require(HOOK);
  for (const c of CASES.filter((x) => x.knownGap)) {
    const dropped = DOCKER_ENV + c.cmd.slice(DOCKER_ENV.length).replace(GAP_OPTION, 'docker ');
    assert.notStrictEqual(dropped, c.cmd, c.id);
    for (const cmd of [dropped, dropped.slice(DOCKER_ENV.length)]) {
      assert.strictEqual(decide({ tool: c.tool, command: cmd, cwd: `${S}/repo` }, { projectDir: `${S}/repo` }).decision, 'deny', `${c.id}: ${cmd}`);
    }
  }
});
