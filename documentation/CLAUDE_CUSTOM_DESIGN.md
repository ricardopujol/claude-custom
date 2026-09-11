# claude-custom — Design Document

**Status:** Step 0 walking skeleton executed — terminal fidelity verified, risk #1 retired
**Date:** 2026-09-11
**Location:** `C:\Users\ricar\VibeCode\claude-custom`

---

## Goal

A visually customizable desktop harness for Claude Code: per-agent portraits with emotional states, per-project colors and fonts, permissions bypassed — while keeping 100% of CLI functionality, including Remote Control from a phone.

---

## Core bet

**Wrap the real CLI; never reimplement it.**

Claude Code is an Ink (React-for-TTY) app rendering to a terminal. Anything that is a property of the `claude` *process* — Remote Control, MCP servers, hooks, `--resume`, skills, plugins, background tasks — is preserved automatically, because we run the genuine binary in a pty. Only the *display surface* is replaced.

This is what the from-scratch Agent SDK approach would have broken, and it's why that approach was rejected.

---

## Validated decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| 1 | Surface | GUI shell wrapping real CLI (Electron + xterm.js + node-pty) | Terminal-only customization; full SDK rebuild |
| 2 | Agent imagery | Reactive roster — portraits light up when agent runs | Static gallery; full activity cockpit |
| 3 | App shape | Single session, one window per project | Tabs; tabs + split panes |
| 4 | Theming | Central registry in `claude-custom/` keyed by project path | Project-local `.claude/` files; auto-derived hues |
| 5 | Event bridge | Local IPC (named pipe) + isolated merged settings file | Transcript tailing; both |
| 6 | Portraits | Locally generated, 4 emotional states per agent | Procedural; lazy curation |
| 7 | Mood engine | Mechanical signals only, from hook stream | Model-judged; hybrid |
| 8 | Art style | Stylized illustrated bust | Pixel art; flat vector |
| 9 | Lifecycle | Detachable session — GUI attaches/detaches from host | Window owns process; window owns + warn |
| 10 | Execution | Direct build, steps 0–3; reconsider Paris at step 4 | Paris from start; spike-then-decide |

---

## Architecture — three processes

### 1. Host (headless Node)

Owns everything stateful. Runs with or without a GUI attached.

- `node-pty` running `claude --settings <merged.json>`, cwd = project
- Named-pipe listener receiving hook events
- Mood state machine
- `@xterm/headless` maintaining true terminal state, serialized to the client on attach (the VS Code terminal-reconnect pattern)
- Local socket server for GUI attach/detach

This is effectively a tiny tmux. On Windows it must be written — `tmux`/`dtach` are unavailable and ConPTY has no detach primitive.

### 2. GUI (Electron)

A pure view. Holds no session state. Closing it detaches rather than kills.

- `xterm.js` + `@xterm/addon-unicode11` + WebGL addon
- Agent sidebar with portraits
- Project header, status strip
- Theme applied to both terminal palette and chrome

### 3. Forge (Python 3.12 + CUDA)

Entirely offline. Never talks to the other two. Writes to `portraits/<agent-name>/{sleeping,working,happy,stressed}.png`.

---

## Data flow

```
host
 ├─ spawn: claude --settings <merged.json>
 │    env: CLAUDE_CUSTOM_PIPE=\\.\pipe\claude-custom-<session>
 │
 ├─ hooks ──> native helper (~5ms) ──> named pipe ──> mood state machine
 │
 └─ local socket ──> GUI (terminal stream + mood messages)
                 <── keystrokes, resize
```

### Hook matchers (deliberately scoped)

- `PreToolUse` on `Task` only → agent started, payload carries `subagent_type`
- `PostToolUse` on `Task` and `Bash` only → error signals
- `SubagentStop` → agent finished

**Why scoped:** hooks run synchronously in the critical path of tool execution. Matching `*` with a Node hook adds ~80ms to every Read, Grep and edit. The mood engine's appetite for signal is taxed directly against agent speed.

**Native helper required:** a ~50-line Go or Rust binary that writes one line to the pipe and exits (~5ms). A Node script costs 60–100ms of startup; PowerShell ~200ms.

### Settings must be MERGED, not replaced

The generated settings file is built by reading the real user settings and merging harness hooks in. Writing it from scratch risks shadowing config that Remote Control or MCP depend on.

> **Measured 2026-09-11 — and the conclusion is the opposite of the obvious one.**
> `--settings` merges with the user layer at the **top level only**; any
> single-valued key it supplies replaces its counterpart **wholesale** (a partial
> `statusLine: {padding: 1}` destroyed the sibling `command`). **But `hooks`
> accumulates across layers rather than replacing** — so the host must supply
> only its own matchers and must **NOT** union the user's, which would run every
> user hook twice. The generated file therefore contains exactly one key:
> `hooks`. Harness variables travel via the pty environment, never via settings,
> precisely because an `env` key *would* clobber the user's. See *Verification
> items* for the controlled runs and the residual uncertainty.

---

## Mood state machine (mechanical, deterministic)

```
PreToolUse(Task)          → working
PostToolUse ok            → working
PostToolUse error         → stressed   (err++)
Bash exit != 0            → stressed
same tool ×3 retry        → stressed
SubagentStop, err == 0    → happy   (8s) → sleeping
SubagentStop, err > 0     → stressed(8s) → sleeping
idle > 90s                → sleeping
```

No model calls. Free, instant, explainable — which matters when a face is wrong and you need to know why.

---

## Theming

Central registry, zero repo pollution (important: `claude-custom` is not a git repo, and several target folders aren't either).

```
claude-custom/
  themes/
    amber-warm.json
    cold-blue.json
  projects.json     // { "C:/.../komodo-agency": "amber-warm", "*": "default" }
```

One theme file covers: terminal 16-ANSI palette + bg/fg/cursor, terminal font, GUI chrome colors, agent card styling.

**Font constraint:** Claude Code's TUI uses box-drawing characters and braille spinners. Any per-project font needs that glyph coverage — practically a Nerd Font or a deliberate fallback chain — or the UI renders as tofu.

---

## Terminal fidelity — the narrow risk surface

Rendering is safe: whatever Claude Code emits, xterm.js draws, so upstream UI changes cost nothing. The risk is **input and character width**.

### Keys needing deliberate handling

- **Shift+Tab** — cycles permission modes (plan, auto-accept). Core workflow.
- **Shift+Enter** — newline without submit. xterm.js sends the same byte as Enter by default. Normally configured by `/terminal-setup`, which won't recognize this terminal, so it must be hardcoded.
- **Esc** (interrupt), **double-Esc** (history), **Ctrl+C / R / L / D**
- **Bracketed paste** — without it, a multi-line paste submits on the first newline

### Unicode width

Ink positions box-drawing by computed character width. xterm.js defaults to a Unicode 6 width table; emoji measure differently under Unicode 11. Wrong table means a subtly shredded TUI. Load and activate `@xterm/addon-unicode11`.

### Environment

`TERM=xterm-256color`, `COLORTERM=truecolor`, resize propagated on both window resize **and** font change.

### Wins a plain terminal can't give you

- Intercept emitted `file:line` references → open VS Code at that exact line
- Completion bell → native Windows notification
- Drag file onto window → insert path; paste clipboard image → temp file

---

## Forge — constrained by 8 GB VRAM

**Hardware:** NVIDIA RTX 4070 Laptop, 8188 MiB, driver 610.62

8 GB rules out comfortable Flux (needs Q4 quantization, 40–90s/image on this GPU).

**Target:** SDXL fp16 with model CPU offload, using a distilled checkpoint (Lightning or DMD2, 4–8 steps) — 3-second iterations materially change how much exploration happens.

**Tooling:** ComfyUI for exploration (IP-Adapter, ControlNet and inpainting nodes are already wired), then freeze the winning graph and drive it via ComfyUI's API from a Python 3.12 script for batch runs.

### Pipeline

1. **Prompt derivation** — read agent `.md` frontmatter for name + description. Named agents (Miguel, Dexter, Naomi, Paris, Atlas, Cedar, Vera, Otto, Mortimer, Lukas…) already carry identities; `spring-boot-engineer` does not. Named first.
2. **Base bust** — ~8 candidates per agent, hand-pick one. The only mandatory human step, and the real time cost.
3. **States** — 4 variants via img2img from base at denoise ~0.35–0.5, with IP-Adapter face conditioning and a ControlNet depth map locked from the base so pose and framing don't wander. Fixed per-agent seed.
4. **Automated identity gate** — embed base + each state, reject below a similarity threshold, auto-retry with a new seed. **Use CLIP or DINOv2 embeddings, NOT ArcFace/InsightFace** — face-recognition models are trained on photographs and are unreliable on illustration; they'd reject good frames and pass bad ones. This is what turns 60+ images from hand-review into a threshold plus a reject pile.
5. **Post** — square crop, `rembg` to alpha (so portraits sit on the project theme color), export 256px and 128px.

**Scope v1:** ~15 named agents × 4 states ≈ 60 images, not 320.

**State list read from config — never hardcoded to four.** ("thinking", "waiting on you" will follow.)

---

## Portrait lookup — convention over configuration

```
portraits/<agent-name>/<state>.png   exists? → use it
else                                         → generated placeholder
```

Keyed on agent filename. **Zero edits to agent `.md` files** — which matters because every edit there triggers the mandatory `/align-agents` sync.

---

## Risks, ranked

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | ~~Terminal fidelity fails~~ | ~~**Binary — kills project**~~ | **RETIRED 2026-09-11** — measured; render, alignment, Shift+Tab and Shift+Enter all correct |
| 2 | ~~Detach correctness unknown~~ | ~~Load-bearing for phone use~~ | **RETIRED 2026-09-11** — pty survives detach, state intact on reattach |
| 3 | Forge reject rate unknown | Weekend vs. month | `spike/` branch, 2 agents |
| 4 | Hook latency | Degrades daily use | Native helper; measure, don't trust estimates |
| 5 | Upstream drift | Low, ongoing | Nothing reimplements CLI behavior — drift costs adjustments, not rewrites |

---

## Build order — riskiest first

0. **Walking skeleton** — pty + xterm.js + real `claude` in a bare window. Nothing else. Prove or kill fidelity. *(1–2 days)*
1. Host + detach/reattach
2. Hook bridge + native helper + mood machine
3. Theming
4. Forge spike, 2 agents
5. Chrome + portraits
6. Forge batch

**Honest effort:** several weeks of evenings, not a weekend.

**Staffing:** direct build for steps 0–3 (tightly coupled, exploratory, one hard surface). Reconsider Paris at step 4, when forge (Python/CUDA) and GUI chrome diverge into genuinely parallel tracks.

---

## Verification items — assumptions, not facts

These must be **executed**, never assumed.

**Executed 2026-09-11.** Probes live in `verify/` and are re-runnable; every result
below is measured output, not reasoning. Claude Code v2.1.268, Node v24.14.0.

- [x] **Does `--settings` merge with, or shadow, existing settings layers?**
      **Merges at the top level, replaces wholesale within a key.** See the
      dedicated section below — this is the most consequential result.
- [x] **Does `claude` behave cleanly while detached with no viewer attached?**
      Yes. Host and pty survive client disconnect; on reattach the session is
      intact — a marker typed before detach was still in the input buffer and
      accepted further keystrokes. (`verify/probe-detach.js`)
- [ ] Real round-trip latency of the native hook helper on a live session —
      **still open**, the helper doesn't exist yet (step 2).
- [x] **Does Shift+Tab cycle permission modes through xterm.js?** Yes. `\x1b[Z`
      (CSI Z) cycles **five** modes, not the assumed three:
      `bypass permissions → auto → manual → accept edits → plan`.
- [x] **Does Shift+Enter insert a newline rather than submitting?** Yes, and the
      risk is smaller than feared: **both** `\x1b\r` (ESC+CR) and `\x1b[13;2u`
      (CSI-u) insert a newline without submitting. The GUI needs a key handler
      mapping Shift+Enter to `\x1b\r` — no terminal-side negotiation required.
- [x] **Is box-drawing correctly aligned with `addon-unicode11` active?** Yes.
      `Unicode11Addon` loads against `@xterm/headless` and reports
      `activeVersion = 11`; both horizontal rules measured **exactly 100 cells**
      at `cols=100`. Banner blocks, `❯`, `⏵⏵`, `▌` and `│` all render correctly.
- [ ] Does Remote Control connect and stay connected from inside the harness? —
      **still open.** Soft positive: `/rc` renders in the harness-hosted status
      line, and the session is now a proper top-level session (see env leak
      below), which is a precondition. Genuine confirmation needs a real device
      pairing and cannot be settled headlessly.

### Verdict on step 0

**Terminal fidelity — risk #1, the binary one — is retired.** Rendering, box
alignment, Unicode width, and both of the input sequences singled out as
dangerous all behave correctly through the real host path. Nothing found here
threatens the core bet.

### `--settings` precedence — measured, and sharper than the original note

The original guidance ("build the file by merging, don't write from scratch")
is right, but it under-states the hazard. Measured behaviour, with a control run
proving the file was actually read:

| Case | Result |
|---|---|
| Key **absent** from the `--settings` file | User layer applies — `statusLine` from user settings still rendered |
| Key **present** in the `--settings` file | CLI file wins entirely |
| Key present but **partial** (`statusLine: {padding: 1}`, no `command`) | Sibling keys **destroyed** — warpaint's status line vanished |

So the merge is **top-level only; there is no deep merge within a key.**

**This holds for single-valued keys. It does NOT hold for `hooks`.**

> **CORRECTION, same day.** An earlier revision of this section concluded that
> the host "must write the union" of the user's hooks and its own. That was an
> **inference from `statusLine`, not a measurement of `hooks`**, and three
> subsequent probes contradict it. Generalising one key's precedence to another
> key was the mistake; `hooks` is a collection, `statusLine` is a single value,
> and they do not behave alike.

Measured for `hooks` specifically:

| Observation | Probe | Implication |
|---|---|---|
| A `--settings` file omitting `statusLine` left the **user's** `statusLine` applied | `probe-settings.js` Run A | `--settings` is an **additional layer**, not a substitute for the user file |
| CLI hooks **and** project-layer hooks both fired | `probe-hook-layers.js` | For `hooks`, the CLI layer **accumulates** rather than replaces |
| `/hooks` reports `SessionStart (4)` while user settings defines exactly **1** | `probe-hooks-command.js` | Hooks already accumulate across sources in the live config |

**Conclusion: the host must supply only its own hook matchers, and must NOT
union the user's.** Unioning would run every user hook **twice** — including
`hook-sync-agent.ps1` and `sync-docs-trigger.ps1`, which do real work.

**Residual uncertainty, stated honestly.** No probe directly observed a *user*
layer hook executing alongside a `--settings` hook. Four instruments were tried;
all failed for reasons now recorded in `verify/` so they aren't retried:

- **Alternate home** — relocating the config dir stops hooks running entirely,
  including the `--settings` ones. Cannot tell shadowing from a disabled layer.
- **`/hooks` menu** — byte-identical with and without `--settings`. It is blind
  to the CLI layer, so surviving user events prove nothing. The probe now carries
  an instrument check; without it, it reported a confident **false** "confirmed".
- **`--debug`** — does not name hook commands in interactive output.

The conclusion rests on three consistent indirect measurements rather than one
direct one. Worth one more attempt if a better instrument appears — but the
asymmetry favours it: under this reading a wrong call costs *nothing*, whereas
unioning on a wrong call silently double-fires every hook the user owns.

### The shallow-merge hazard still applies — just not to `hooks`

The wholesale-replacement finding remains load-bearing for **every other key**.
Concretely: if the host ever writes an `env` key to pass the pipe name, it would
destroy the user's `env` — which carries `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

The host therefore passes harness variables through the **pty environment**, not
through settings, and the generated file contains **exactly one key: `hooks`**.
Every other setting falls through the normal layers untouched. That is the whole
design, and it is smaller than the original note assumed.

### Incidental finding — inherited session env leaked into the hosted session

`host.js` spread `...process.env` into the pty. Launching the host from inside an
existing Claude Code session leaked `CLAUDE_CODE_CHILD_SESSION`, and the hosted
session responded by **silently disabling transcript saving** — which would have
taken `--resume` with it, one of the capabilities the core bet promises to
preserve for free.

Fixed with an explicit denylist of session-identity variables. Deliberately *not*
a `CLAUDE_CODE_*` wildcard: that namespace also carries legitimate user
configuration (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) that the harness has no
business dropping.

**Generalisable lesson:** the core bet — "run the genuine binary, inherit
everything" — silently assumes the *process environment* is clean. Inheritance
cuts both ways, and this failure was invisible in the TUI apart from one dim
warning line.

---

## Explicitly out of scope (v1)

Tabs · split panes · multi-project windows · multiple simultaneous attachers · per-agent activity streams · token/cost display · model-judged moods · reimplementing any CLI UI · portraits for all ~80 agents

---

## Open idea (not decided)

With permissions bypassed, `PreToolUse` hooks become the only remaining gate — and they can still *deny*. The bridge already exists, so a short denylist (`rm -rf` outside the project, force-push to `main`) would cost almost nothing while keeping zero friction everywhere else. Not part of v1 scope; noted because the architecture hands it over free.
