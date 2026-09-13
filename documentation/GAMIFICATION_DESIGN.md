# Gamification layer — design

**Status:** Designed, not started. Decisions taken 2026-09-11.
**Depends on:** the existing hook bridge, mood machine, theme registry and usage reader.

Ten ideas were proposed; **eight accepted**, two rejected (agent reputation — not
interesting; quest log — don't care). Two more were added afterwards: provider
switching and a model council.

---

## Shared foundation — build this first

Every accepted feature needs the same two things, so they are step one rather
than a per-feature concern.

### 1. A state store

```
.harness/state/
  loadout.json     items equipped per agent
  vault.json       bug bestiary
  map.json         files seen, per project
  stats.json       counters, cooldowns, streaks
```

The **host owns all writes**; the GUI reads through the existing `hello` /
control-message protocol and never writes directly. The hook helper reads
`loadout.json` *itself*, which is what lets items keep working when the GUI is
closed — the harness must not become a requirement for a terminal session.

One file per concern rather than a single blob: a corrupt write then costs one
feature instead of all of them, and the diffs stay readable.

### 2. Wider hook coverage — measure before widening

Today the harness hooks `Task`, `Bash`, `SubagentStop` and `SessionStart`. That
narrowness was a deliberate, measured decision: hooks cost **~23ms in the
critical path of every matched tool call**, of which only ~2ms is the pipe — the
rest is Windows process creation, which no implementation can avoid.

Fog of war (#3) and the bug vault (#4) want `Read` / `Edit` / `Write` too, which
is exactly the wildcard the design warned against. **Re-measure before
committing**, and if the cost is ugly, read the transcript instead of hooking —
the transcripts already contain every tool call, and `usage.js` already parses
them.

---

## The features

### 1 · Item inventory
Drag items onto agents; they really change how the agent runs.

- **Mechanism:** verified. `updatedInput` exists in the `claude` binary, so a
  `PreToolUse` hook on `Task` can rewrite the Task's input — including `model`
  and `prompt`.
- **Lifecycle:** permanent loadout, free slots.
- **Conflicts:** refused at drop time, and **derived from which fields an item
  writes** rather than a hand-kept matrix — two items that both set `model`
  conflict automatically, so new items cannot drift out of sync with a table.
- **Honesty rule:** an item may only claim an effect the harness can enforce.
  "Work faster" (swap model) and "review twice" (inject a verification pass) are
  real; "never make mistakes" is not, and will not be offered.

### 2 · Token counter — gamified, never a limit
Explicitly **not** a budget cap. A counter with milestones and a per-run
flourish.

Data already exists in `host/usage.js`. Note the measured reality: this project
sits at ~119M tokens of which ~97M are cache reads, so the headline number must
show the breakdown or it badly misrepresents spend.

**Changes with provider (#11):** on a Max subscription the marginal cost inside
quota is zero, so a playful counter is honest. On OpenRouter every token is real
money, and the same widget should show actual spend. Same data, different
framing, because the underlying truth differs.

### 3 · Fog of war
The file tree as a dark map. Three tiers: **never touched** (black), **read**
(dim), **edited** (bright), with brightness decaying over time so stale
knowledge dims.

The value is the dark regions. They are blind spots — and this project's own
history records a fix landing inside the single largest zero-coverage region in
scope, invisible twice over. This makes that visible by default.

### 4 · Bug vault
The richest feature, and the one most likely to pay for itself.

- Each distinct bug **class** gets a generated creature portrait — the same
  forge pipeline, a monster art direction instead of the portrait one.
- Recorded when spotted, with **fixed / unfixed** status.
- Structured so patterns surface: category, where found, **how it was detected**,
  how long it survived, and what would have caught it sooner.
- The vault groups by category, so "six bugs found by measurement, none by
  reading" becomes a visible fact rather than a feeling.

Seed data already earned in this session: `exit 0` masking a failure; WebGL
breaking terminal transparency; `spawnSync` blocking the event loop and
corrupting a benchmark; a transformers 5.x API change silently discarding every
generated state; CLIP truncation collapsing four states into one; and
photographic vocabulary desaturating thirteen consecutive images.

### 6 · Cooldowns on expensive agents
Per-agent timer in `stats.json`, shown on the roster card. Encodes the existing
rule that Mortimer runs **last, once, against a stable tree** — a rule currently
enforced only by memory, and already broken once.

### 7 · Party view
Nearly free: the mood machine already maintains the nested agent stack in order
to attribute a Bash failure to the innermost running agent. Render that stack as
a party instead of a flat list, so a subagent quietly spawning six more is
visible.

### 8 · Project HP
Test pass rate, coverage and lint as one bar. Needs a small per-project command
config, since every repo reports differently.

### 10 · Difficulty dial
The five permission modes — bypass, auto, manual, accept edits, plan — surfaced
in the header. Pure display over data already parsed from the TUI. Makes
"running with permissions bypassed" impossible to forget.

### 11 · Provider switch — Claude Max ↔ OpenRouter
**Verified feasible.** The `claude` binary honours `ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and
`ANTHROPIC_SMALL_FAST_MODEL`. The host already builds a clean environment before
spawning the pty, so switching provider is environment variables plus a picker.

**The constraint:** Claude Code speaks the Anthropic Messages API; OpenRouter is
OpenAI-compatible. They are not wire-compatible, so a translating proxy
(`claude-code-router`, LiteLLM) sits between, with `ANTHROPIC_BASE_URL` pointed
at it.

**The real risk is tool-use fidelity, not plumbing.** The whole harness depends
on `Task`, hooks and structured tool output, and non-Claude models vary from
fine to unusable — failing by silent degradation rather than by error. Do not
promise this works until measured. It *is* measurable: the hook bridge already
counts tool calls and errors per session, so a provider can be scored on tool
success rate over a fixed task.

### 12 · Model council
Karpathy-style: several models answer, cross-review, a chairman synthesises.

**Deliberately NOT routed through the pty.** A host-side panel with its own HTTP
client to OpenRouter. This is the most experimental feature here and it must not
be able to destabilise a real coding session — the core bet is that the genuine
CLI runs untouched, and the council is the one feature that would otherwise
compromise it.

---

## Build order

```
state store + protocol      foundation, everything depends on it
  └─ 7  party view          nearly free; proves the store end to end
  └─ 10 difficulty dial     display only, data already parsed
  └─ 2  token counter       data already exists
  └─ 11 provider switch     small, and makes #2 honest
  └─ 6  cooldowns           needs stats.json only
  └─ 1  item inventory      needs the helper to emit updatedInput
  └─ 3  fog of war          needs the hook-cost decision first
  └─ 8  project HP          needs per-project command config
  └─ 12 council             self-contained, needs credentials
  └─ 4  bug vault           last: wants the forge AND a monster art direction
```

Cheap-and-proving first, so the store is exercised before anything expensive is
built on it.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | File-op hooks tax every Read/Grep/Edit | Measure first; fall back to transcript tailing |
| 2 | Items claim effects they cannot enforce | Honesty rule — an item may only do what the harness can verify |
| 3 | OpenRouter models degrade tool use silently | Score providers on tool success rate before trusting |
| 4 | State store corrupts and takes features down | One file per concern; every read defaults rather than throws |
| 5 | Gamification becomes noise | Each feature must change a decision, not just decorate |

---

## Added 2026-09-13

### 14 · Recent projects on launch

Opening the harness shows the projects most recently worked on, so a session can
be resumed without navigating. Ordered by last use.

Data already exists and needs no new tracking: `~/.claude/projects/` holds one
folder per project (encoded cwd), and `usage.js` already decodes that naming.
Last-used is the newest transcript mtime in each folder; token totals per project
come from the same reader. So the launcher can show each project with its real
spend and last-touched time on day one.

Worth showing per row: project name, last used, lifetime tokens, and its
generated background art as the card — the art exists precisely so a project is
recognisable before you have read a word.

### Items apply to the MAIN CHAT, not only to agents

Confirmed as a requirement, and it changes the mechanism rather than the design:
the main session is not a `Task` call, so there is nothing to rewrite.

| target | Pace (model) | Method (instructions) |
|---|---|---|
| agent | `PreToolUse(Task)` → `updatedInput.model` | `updatedInput.prompt` |
| main chat | `ANTHROPIC_MODEL` at spawn — **requires a restart** | `UserPromptSubmit` → `additionalContext` |

Verified present in the binary: `UserPromptSubmit` (44 occurrences),
`additionalContext` (48), `updatedInput` (103).

The asymmetry must be visible in the UI: a Pace item on an agent applies to the
next run, but on the main chat it cannot apply until the session restarts.
Silently not applying is the same failure the provider switch explicitly refuses.

### Equipping is drag-and-drop, AT THE MOMENT IT MATTERS

Not a settings screen visited once. Drag an item onto an agent right before
invoking it, or onto the chat mid-session.

The architecture already supports this: the hook helper re-reads `loadout.json`
on every invocation, so a change lands on the very next tool call with no
restart and no reload.

**One honest limit.** Dragging onto an agent that is ALREADY running does not
affect that run — its `Task` input was sent when it started. It applies to the
next invocation. The UI should say so rather than appear to have done something.

### Guard is GLOBAL, not an item

Ricardo's call, and correct: a deny rule for `rm -rf` should not depend on which
agent happens to be running. It is session policy, not equipment.

It leaves the inventory entirely and becomes a setting. That also removes the
only purely defensive category from a system otherwise about capability.
