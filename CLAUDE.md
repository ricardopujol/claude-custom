# claude-custom

A visually customizable desktop harness for Claude Code: it wraps the **real** `claude` CLI in a pty
(Electron + xterm.js + node-pty) and replaces only the display surface, so everything that is a
property of the `claude` *process* — Remote Control, MCP servers, hooks, `--resume`, skills, plugins,
background tasks — keeps working untouched.

**The founding bet: wrap the real CLI, never reimplement it.** When a feature needs something the CLI
already does (granting a directory, reporting usage), drive the CLI's own mechanism rather than
editing its state behind its back.

<!-- sync-docs:begin -->
## Documentation (Source of Truth)
This project's living source of truth is `documentation/CLAUDECUSTOM_BUILD_LOG.md` — it tracks how the project is actually built: build state, changes from the plan, problems, solutions, and learnings. **Every change to any other aspect of the system must be reconciled into the build log, and any change to another doc must be referenced there.** `documentation/CLAUDE_CUSTOM_DESIGN.md` is the **frozen original plan** (the starting idea) and is never edited — divergences from it are recorded in the build log. Whenever the plan, design, or implementation changes, invoke `/sync-docs` to reconcile the build log (and the satellite docs that roll up to it) and mirror the latest version into the Obsidian vault. The build log is canonical and wins any disagreement with another doc or the code; handoffs accumulate in `documentation/handoffs/`. The `documentation/` folder is **gitignored by default** — the docs are mirrored to the Obsidian vault, so only `documentation/README.md` is tracked in GitHub (delete the `sync-docs (gitignore)` block in `.gitignore` to push them). A PostToolUse hook also auto-prompts `/sync-docs` whenever a file under `documentation/` changes.
<!-- sync-docs:end -->

## Traps this codebase has already paid for

These cost real time. Do not rediscover them.

- **Anything loaded as a plain `<script>` shares ONE global scope.** `app/usage-display.js`,
  `app/career-display.js` and `app/quota-display.js` are each wrapped in an IIFE because two of them
  declared `const UNKNOWN` and the second silently aborted the whole file. **No unit test can see
  this** — each test `require`s the module into its own scope. Render it in a real window.
- **`Number(null)` is `0`.** A coercing finite-check turns "no value" into a confident zero. This is
  the absence-reported-as-zero bug this project keeps catching; use a strict `typeof` helper.
- **`ELECTRON_RUN_AS_NODE` is inherited.** Claude Code is itself an Electron app, so any probe that
  spawns Electron from a session must delete that variable or the child starts as plain Node — with
  errors that name anything but the cause.
- **`offscreen: true` hangs `capturePage`** on this machine. Use a normal window.
- **`File.path` was removed in Electron 32** (this app is on 33). Drag-and-drop paths come from
  `webUtils.getPathForFile` across the preload bridge.
- **Never open a file with `'w'` before you are sure the write succeeds.** A failed encode truncated
  `app/renderer.js` to zero bytes. Write to a temp file and `os.replace` it.

## Verification

Probes live in `verify/` and are re-runnable. They exist because this project's rule is that a claim
is measured, not assumed — `verify/probe-renderer-origin.js` and `verify/probe-quota-header.js` both
record the traps above in their own headers.

## Environment switches

- `CLAUDE_CUSTOM_CONPTY=builtin` runs the session's pty on the OS's ConPTY instead of node-pty's bundled one (`host/conpty-choice.js`).
  The bundled one is what lets the CLI's OSC 7501 status protocol work (conhost answers DA1 itself and drops the host's reply); the OS's
  keeps every session as it was before and turns the status dots back into hook-driven ones. A missing bundled install falls back to
  the OS's on its own, with a line in host.log and the diagnostics pane.
