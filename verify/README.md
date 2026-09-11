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
