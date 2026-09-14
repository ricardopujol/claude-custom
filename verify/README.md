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
| `probe-gui.js` | Does the real Electron GUI render correctly? | Writes a PNG to `.harness/` |

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
