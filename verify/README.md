# verify/ — executed evidence for the design's assumption checklist

The design doc is explicit that its verification items "must be **executed**,
never assumed". These are those executions. Each probe drives a **real** `claude`
process and reports measured output, so any of them can be re-run when Claude
Code updates and the assumptions need re-confirming.

All probes render the pty stream into `@xterm/headless` with `Unicode11Addon`
active, which is the same terminal state the host will serialize for
detach/reattach — so the probes exercise the real component, not a mock.

| Probe | Question | Result (2026-09-11, v2.1.268) |
|---|---|---|
| `probe-render.js` | Does the Ink TUI render faithfully through the host? | Yes — banner, box rules, prompt all correct |
| `probe-keys.js` | Shift+Tab modes, Shift+Enter newline, rule alignment | All pass; rules exactly `cols` wide |
| `probe-detach.js` | Does the session survive with no viewer? Full mode cycle | Survives; state intact on reattach |
| `probe-settings.js` | Does `--settings` merge or shadow? | Top-level merge, **wholesale replace within a key** |
| `probe-hook-layers.js` | Do `--settings` hooks replace the project layer's? | No — they **accumulate** |
| `probe-hook-e2e.js` | Does a helper invocation reach the running host? | Yes, `subagent_type` round-trips |
| `measure-hook-latency.js` | What does a hook actually cost? | 23.3ms mean; only 2.2ms is the pipe |
| `probe-protocol.js` | Full attach protocol: hello, theme, replay, mood | All pass |
| `probe-paste.js` | What does Ctrl+V put on the pty? Does `claude` take an image on Alt+V? | 2026-09-27: before #12 Ctrl+V sent `\x16` and pasted nothing; `\x1bv` attaches a clipboard image (`[Image #1]`), `\x16` does not. After: one bracketed frame per press |
| `probe-choice-menu.js` | Do choice menus take clicks already? (BACKLOG #11) | 2026-09-29: yes. The CLI enables `?1000/1002/1003/1006h` and acts on SGR clicks itself (`/model` measured; permission prompts not measurable for free). Arrows via the input frame also work. The click step commits a `/model` choice to the real settings, so it is opt-in (`PROBE_MOUSE_COMMIT=1`) |
| `probe-canvas-sandbox.js` | Does anything get out of Claude's panel? (BACKLOG #71) | 2026-10-05, Electron 33.4.11 / Chromium 130: a sandboxed iframe + strict CSP + navigation guard + WebRTC policy still leaked WebRTC TURN over TCP (a raw connection to any host:port, loopback included) and `<link rel=dns-prefetch>` (a DNS query naming whatever the page likes); the `x-dns-prefetch-control` meta and a dead proxy did NOT stop the latter. So the panel is a sealed WebContentsView (own session, dead proxy taking loopback too, process-wide `host-resolver-rules`, a brokered `fetch`). The sealed run reports 0 hits on all ~50 paths (65 checks); a naive control run in the same probe SEES the leaks (self-navigation, STUN, TURN, DNS) |
| `probe-canvas-panel.js` | Does Claude's panel work end to end in the real app? (BACKLOG #71) | 2026-10-05: hidden until a page is written, docks itself, native view over its slot at the slot's rectangle and live, destroyed when hidden and rebuilt from the file, a page over 1 MB refused, the host question covers it and nothing reaches the server until Allow, Deny sticks, Remove asks again, a new CLI session is an empty panel |
| `probe-canvas-mcp.js` | Does Claude's panel's MCP server work through the REAL CLI, next to the user's own servers? (BACKLOG #71, PR 2) | 2026-10-05, claude 2.1.289, fake endpoint + throwaway config (zero spend): `--mcp-config` (built by the real `buildClaudeArgs`) ADDS to a user server already in `.claude.json` (both tool sets listed), the CLI shows the model the description saying the panel changes only when the user asks, a model's `canvas_render` call is run by the CLI through the server and lands in `<state>/canvas/<session-id>/index.html` (session id from the pointer file), `canvas_list_artifacts` answers from the shelf on disk, nothing about the panel is written to `.claude.json`, and with the setting off no canvas tool is offered. The `Artifact` tool's success payload could not be captured offline (needs a signed-in session); its structured result was read from a real transcript and the shelf parser accepts the structured, text and content-array forms |
| `probe-gui.js` | Does the real Electron GUI render correctly? | Writes a PNG to `.harness/` |
| `probe-memory-footprint.js` | What does the app cost in memory? (BACKLOG #20 baseline) | 2026-09-26, 4 runs: harness 280–408 MB private (idle / 24 agents / long session; three runs sat at 280–292, one at 337–408, so compare medians of several runs, not one); `claude` + its MCP servers ≈ 800–970 MB on top. No video-avatar scenario yet (#13/#18 unbuilt). Samples in `.harness/memory-footprint.json` |
| `probe-lean.js` | Does lean mode work in a real window, and what does it save? (BACKLOG #62) | Behaviour checks 1-7 (button, bedtime, button-wins, still portraits, GIF/webm stills) and the normal-vs-lean memory/CPU table per process type, one busy tab and three. Heavy: take heavy-lock.ps1. Numbers in the PR body; samples in `.harness/lean-footprint.json` |
| `probe-anim-cost.js` | Does an animated background cost CPU/GPU, GIF vs MP4 vs WebM? (BACKLOG #62, the video switch) | Same 10 s clip as GIF, H.264 MP4, VP9 WebM and a still behind a busy terminal, 2 min each, plus animated portraits; CPU % and private MB per process type and GPU engine %. Heavy: take heavy-lock.ps1. Samples in `.harness/anim-cost.json` |
| `probe-shell-guard.js` | Does the shell-guard hook refuse each destructive class in a REAL `--dangerously-skip-permissions` session, and is a hook `ask` honoured there? (safety net lane 3) | 2026-10-26, haiku, hook only through a generated `--settings`: an `ask` IS honoured in bypass `-p` (9/9 refused with the hook's reason, 0 ran). Gate PASS; deny 46/47 refused with the hook's reason (a-subst inconclusive: haiku declined to call the tool, offline `decide()` says deny); allow 4/4 ran. 3 KNOWN-GAP docker cases (`-H`/`--context` before the subcommand) were allowed and really ran into dead endpoints, harmless by design; reported, not counted. Every case is harmless if it runs (pinned by `test/probe-shell-guard-hygiene.test.js`). Heavy: takes the lock itself (`HEAVY_LOCK_WAIT_MINUTES` to queue longer); `PROBE_ONLY=id,id` re-runs named cases. Rows in `.harness/shell-guard-probe.json` |

## Seeing the GUI

The GUI is the one surface these headless probes cannot reach, so `app/main.js`
carries two env-gated verification paths rather than leaving it to eyeballing:

```sh
node verify/probe-gui.js        # populated agent roster in every mood state -> .harness/gui-roster.png

CLAUDE_CUSTOM_SCREENSHOT=out.png \
CLAUDE_CUSTOM_INPUT_TEST=1 \
CLAUDE_CUSTOM_SCREENSHOT_DELAY=13000 npx electron .
```

`CLAUDE_CUSTOM_INPUT_TEST` types `LINE-ONE`, presses **Shift+Enter**, then types
`LINE-TWO`. This is the only check that covers the renderer's custom key
handler: Shift+Enter is hardcoded browser-side, so no wire-level probe reaches
it, and a regression would *submit* rather than insert a newline — which the
screenshot shows unmistakably.

Note that `npx electron .` spawns a **detached** host that outlives the window
by design. It exits with its pty, but if you kill Electron oddly, check for
leftovers by port rather than by process age — this machine runs several
unrelated claude sessions, and matching on "recently started" would kill one.

Instruments that could **not** answer the user-layer hook question, kept so they
are not retried: `probe-user-layer.js` (relocating the config dir disables hooks
entirely), `probe-hooks-command.js` (the `/hooks` menu is blind to the CLI
layer), `probe-hook-debug.js` (`--debug` doesn't name hook commands).
`diagnose-pipe-loss.js`, `diagnose-pipe-variants.js` and `diagnose-client.js`
are the trail that found the benchmark bug described below.

```sh
node verify/probe-render.js     # SETTLE_MS=12000 to wait longer
node verify/probe-keys.js
node verify/probe-detach.js
node verify/probe-settings.js   # ~40s: runs claude four times
```

Each probe uses its own port (7701–7703) so they don't collide with the dev host
on 7681, and each kills the `claude` process it spawned before exiting.

## Reading the results

`probe-settings.js` is the one worth understanding properly. It runs a
**control** (Run B) that proves the `--settings` file is actually being read —
without it, "the user's config survived" is indistinguishable from "the file was
silently ignored", and the two have opposite implications for the host.

Run C is the load-bearing one: it supplies a *partial* object for a key the user
has configured, and shows that the sibling fields are destroyed. That is why the
host must write the **union** of the user's hooks and its own, not just its own.

## A note on the smoke test

`host/smoke-test.js` originally passed once 400 bytes had arrived and ANSI was
present. Claude Code emits several hundred bytes of **colour-coded warning text**
before Ink draws anything, so that threshold passed while proving nothing about
terminal fidelity — it was green on a startup warning. It now waits for the
prompt glyph and a box-drawing character together.

Worth remembering when adding checks here: *presence of bytes is not evidence of
rendering.* Assert on the thing you actually care about.

## Two ways these probes have already lied

Both were caught by a check *about the instrument*, not about the subject. Add
that check whenever a probe's reassuring answer would be indistinguishable from
the instrument not working.

**A benchmark that measured itself.** The first latency run reported 4/35
delivery and ~158ms native timings. Neither was real: the bridge ran inline with
the `spawnSync` loop, so the event loop was blocked and the server could not
accept. The four that succeeded were libuv's pre-created pipe instances, and the
"latency" was mostly the helper's own connect timeout. Three diagnostics
narrowed it — an in-process client scored 12/12 where both *spawned* clients
scored 4/12, which pointed at the harness rather than the helper or the server.
The bridge now runs in its own process, matching production, and delivery is
35/35. **A performance number that is also a correctness signal is worth more
than either alone: the delivery count is what exposed the bad measurement.**

**A menu that answered confidently about something it cannot see.** The `/hooks`
probe reported `H1 CONFIRMED` because the user's hook events were still listed
with `--settings` applied. They are listed either way — the menu never reflects
the CLI layer at all. The probe now first checks whether its own marker hook
changes the menu, and reports INCONCLUSIVE when it doesn't.
