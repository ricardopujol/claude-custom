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

### 10 · Hazard Level
The HAZARD LEVEL. Ricardo's name for it, 2026-09-13, and the right one: these
are not degrees of difficulty, they are degrees of how much can go wrong
unsupervised.

The five permission modes — bypass, auto, manual, accept edits, plan — surfaced
in the header as skulls. Pure display over data already parsed from the TUI. Makes
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

**The design is already written, elsewhere, and locked:**
`C:\Users\ricar\VibeCode\council-mcp\HANDOFF.md` — a `/brainstorming` session
from 2026-07-09, greenfield and unimplemented. Mirror what is usable from it
rather than redesigning it; it inherits from Karpathy's `llm-council`.

The lesson it rests on: an ensemble only helps if the models **fail
differently**. All ~161 agents here run on the same Claude model, so three of
them agreeing is shared blind spots rather than confirmation.

**The constraint that shapes everything:** Claude Code's `Agent` tool only ever
spawns CLAUDE subagents. A non-Claude seat therefore cannot be an agent — it
must be a callable primitive returning the answer as DATA. Hence an MCP server
with a deliberately thin surface (`ask_model`, `list_models`), leaving fan-out,
ranking and the Chairman in the calling layer.

**Ricardo, 2026-09-13:** the user picks **up to three models** for the council,
from ANY provider OpenRouter offers. So the seat picker belongs to this
harness, while the primitive that answers belongs to the MCP server.

Non-negotiables carried over: a hard fail-closed budget cap (never silently
downgrade to a cheaper model — that corrupts the diversity guarantee AND hides
spend), a persistent spend ledger, a model allowlist, and the key from env
only, never logged.

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

### 15 · Model browser across every OpenRouter provider

Once the OpenRouter key exists for the council (#12), the same key opens every
model it offers — OpenAI, Google, Meta, Mistral, DeepSeek, Qwen and the rest.
Switching between them should be a picker, not a config edit.

`GET https://openrouter.ai/api/v1/models` returns the live catalogue with
pricing, context length and capabilities, so the list never has to be
hand-maintained and prices stay current.

**The catalogue must be filtered by target, because the two uses have different
requirements:**

| target | needs | if the model lacks it |
|---|---|---|
| main session | tool use, and good tool use | the harness breaks — Task, hooks and structured output all depend on it |
| council (#12) | nothing beyond chat | fine; a model that cannot call tools can still give an opinion |

The models endpoint reports `supported_parameters`, which indicates tool
support, so the picker can hide or flag models that cannot drive a session
rather than letting one be selected and fail confusingly.

Worth showing per row: name, provider, context window, price per million in/out,
and whether tools are supported. Sort by price or by context.

Two constraints already established elsewhere apply here:
- A main-session model change takes effect at **spawn**, so it needs a restart.
  A council model change is immediate, since the council does not go through the
  pty.
- Declared tool support is not the same as tool *fidelity*. The hook bridge
  already counts tool calls and errors, so a model can be scored on real tool
  success rate rather than trusted on its advertised capability.

### 16 · Local secret clipboard

A local store for passwords, keys and tokens, so they are one click away rather
than hunted for in a text file.

**Encrypted at rest via Electron `safeStorage`** (verified available, Electron
33.4.11). On Windows that is DPAPI: encrypted with the logged-in user's
credentials, so the file is unreadable by another user or on another machine.
Stored at `.harness/secrets.enc`, which is already gitignored — and it must
never go through `store.js`, which writes plain JSON.

**Copy to the OS clipboard; never type into the terminal.** The two are not
equivalent, and the difference is the whole security story:

| | |
|---|---|
| copy to clipboard | the secret goes to the OS clipboard and nowhere near the session |
| insert into terminal | the secret is now in the conversation |

---

#### THE CONSTRAINT THAT MATTERS

**Anything pasted into a session is in the transcript, permanently.**

Claude Code writes every prompt to `~/.claude/projects/<project>/<session>.jsonl`
in plaintext. Those files are what `usage.js` and `recent.js` already read, they
are not encrypted, they are not deleted when the session ends, and the model
sees the content.

So this feature makes a secret **easy to reach**. It cannot make pasting one
into a session **safe**, and nothing in the harness can. That is a property of
the transcript, not of the clipboard.

Practical consequences:

- The UI should say this at the point of copying, not bury it in a setting.
- Prefer secrets that never need pasting at all: an env var the host sets on the
  pty is strictly better, since the process gets it and the conversation does
  not. The provider switch already works exactly this way — the OpenRouter key
  reaches `claude` through the environment and never appears in a prompt.
- The store is therefore most useful for things pasted into *other* applications
  — a browser login, an SSH passphrase — and least useful for anything that
  belongs in the session.

#### Design

- Entries: label, secret, optional note. Secret masked by default, revealed on
  an explicit click.
- Copy clears the OS clipboard after a timeout, so a key does not sit there
  until the next copy.
- No search over secret values, only labels: a search box that matches secret
  text puts it on screen for a typo.
- Never logged, never broadcast over the control protocol, never included in
  `hello`. The renderer asks for one value at a time, on demand.

---

### ART PLACEHOLDER RULE (applies to everything below and after)

**Until a thing has real art, it gets an EMOJI.** Ricardo, 2026-09-13. Items,
skills, bug types, status icons — all of it. The only exception is agent
portraits, which are generated by the forge and are the whole point of that
pipeline.

This is not a stopgap to apologise for. An emoji is legible at 16px, needs no
pipeline, no VRAM, no identity gate, and no human picking a base bust. It lets
every feature ship with a visual identity ALREADY IN PLACE, so the art pass
later is a swap rather than a redesign. The portrait work is the cautionary
tale: six experiments on expression for an asset that renders at 34x34.

Store the emoji as data next to the thing it marks, never hardcoded in markup,
so replacing it with a generated image later touches one field.

---

### 17 · Skill tab — the wand

**Status: recorded, not built.** Ricardo, 2026-09-13.

A tab beside Agents and Vault holding the skills you actually use, each one
triggerable in a click. Gamified framing: **the tab is a wand and each skill is
a spell.** The user adds skills to it themselves — it is a loadout, not a
directory listing.

**Why a curated list rather than all of them.** There are ~60 skills available
and a directory of sixty buttons is a menu, not a wand. The tab holds the ones
this project casts often; everything else stays a `/name` away in the session.
Same reasoning as the roster showing agents that have RUN rather than all 161.

**Mechanism — the easy part, and worth stating because it differs from the
vault.** Triggering a skill means writing `/skill-name` into the pty, exactly as
typing it would. That IS the conversation, and that is correct here: a skill
invocation is meant to be part of the transcript. Contrast the vault, which
must never touch the pty. Two panels, opposite rules, for the same reason in
both cases — where the data belongs.

**Where the list comes from.** Skills live on disk (`~/.claude/skills/`, plus
plugin skills), the same shape of read that portraits.js and recent.js already
do. The harness can enumerate them without asking Claude Code anything.

**Design notes:**

- Each entry: skill name, an emoji (per the rule above), an optional one-line
  description read from the skill's own frontmatter.
- The loadout is per project, stored through `store.js`. What you cast in a
  Python repo is not what you cast here.
- Arguments: some skills take them. A skill that needs an argument should
  prefill the prompt rather than submit it, so the click sets up the cast and
  the human finishes it.
- **Honesty rule, inherited from the item inventory:** an entry may only claim
  what the harness can actually do. It types a slash command. It cannot promise
  the skill succeeds.
- Adding a skill to the tab is drag-and-drop at the moment it is relevant, per
  the inventory decision — most naturally, dragging from a list of all skills.

**DECIDED (Ricardo, 2026-09-13): a running spell SHOWS STATE**, the way an
agent portrait does. Casting is not fire-and-forget; the wand reports.

That decision has a dependency nobody should discover late:

- The mood machine is driven by `PreToolUse` / `PostToolUse`, and the settings
  matcher is currently `Agent|Task|Bash`. A skill invocation will not fire a
  hook at all until whatever tool name it uses is added to that matcher.
- **We do not know that tool name.** It is plausibly `Skill`, and plausibly
  not. Guessing it is precisely the mistake that cost three sessions on
  `Agent` vs `Task`, where the host read a name Claude Code does not send and
  every fixture agreed with the host.
- So: **measure it, do not assume it.** `CLAUDE_CUSTOM_HOOK_DEBUG=1` prints
  every payload, and `verify/probe-payloads.js` checks real shapes against
  `host/payload-contract.js`. Invoke one harmless skill through the real CLI,
  read the `tool_name`, then widen the matcher and add it to the contract.
- Some skills run in a subagent, which arrives as an `Agent` PreToolUse and is
  already handled. A skill that runs INLINE is the case that needs the new
  matcher, and the two will look different on the wire.

State to show, mirroring the roster: idle, casting, done, failed. The emoji is
the spell's face, so it needs the same four-state treatment the portraits get
-- which the emoji rule makes trivial (a ring or a tint around the glyph,
rather than four generated images).

---

## Added 2026-09-14

### 18 · Per-agent career stats — tokens spent and time worked, IN THIS PROJECT

Ricardo: *"Next to the agents it should say how many tokens they have spent IN
THAT PROJECT, and it should say also how much time they have worked IN THAT
PROJECT. Not in that context window or session, in the project."*

So this is a **career record**, not a session gauge. It is the roster equivalent
of the project token counter: the same "this folder, all of its history" scope,
the same counter-never-a-limit framing.

**The data exists and was measured, not assumed.** Subagent transcripts live at
`~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/*.jsonl`, each with a
`.meta.json` sibling. Measured on this project: 15 session dirs, 30 subagent
transcripts, 30 metas. The meta carries the agent identity:

```json
{"agentType":"code-reviewer","description":"Say OK","toolUseId":"toolu_…",
 "spawnDepth":1,"requestShape":"background","requestNonInteractive":true}
```

and the transcript carries `message.usage` per line and an ISO `timestamp`, so
both figures fall straight out. A throwaway aggregation over this project's real
transcripts already produces the display:

```
code-reviewer           14 runs    31.0M tokens    19.2 min
logic-reviewer           4 runs     7.1M tokens    12.7 min
agent-organizer          1 runs    13.4M tokens     9.6 min
```

**The one thing that is NOT settled, and would be a silent wrongness if
guessed.** When an agent is spawned with an explicit `name`, the meta records
THAT NAME in `agentType` — the name replaces the type rather than sitting beside
it. So this project's 14 `code-reviewer` runs are also filed under
`miguel-usage`, `miguel-review`, `miguel-merged-settings`… and one agent's
career is split across several keys, none of which match the roster's key.

This is the `Agent` vs `Task` shape of mistake again: the aggregate looks
perfectly reasonable while attributing one agent's work to four strangers. Two
honest options, and the choice needs measuring first:

1. Group by `agentType` verbatim, and accept that named spawns appear as
   separate "agents". Wrong, but visibly wrong.
2. Recover the real type — `SubagentStop` carries `agent_type`, and
   `toolUseId` links the meta back to the `Agent` tool_use block in the parent
   transcript, whose `subagent_type` input IS the type. Costs a parent-transcript
   join; gives the right answer.

(2) is almost certainly right, but **confirm the `subagent_type` input is
actually present on a named spawn before building on it** — `verify/probe-payloads.js`
and `host/payload-contract.js` are where that gets pinned.

**Time worked** is `last timestamp − first timestamp` within one transcript,
summed over runs. Deliberately NOT wall-clock from spawn to `SubagentStop`: that
would count time an agent spent queued. Two agents running in parallel therefore
both count their own minutes, which is correct — it is time *worked*, not
elapsed.

**Cost shape.** Same trap as `readUsage` before it was fixed: 30 transcripts and
growing, on a roster that redraws often. It reuses `host/usage.js`'s incremental
reader rather than growing a second one — a per-agent copy of that logic is
exactly the duplication that lets the two drift.

---

## ASCII exploration — CLOSED, with one survivor (2026-09-14)

Judged by Naomi against captures verified at DPR 1, fonts resolved, subpixel AA
off, and an end-of-sheet sentinel asserted to be inside the image. All 80 `ascii`
renders and all 16 braille 16×8 renders, at 16 / 24 / 34 / 48px.

### The correction that reaches everything before it

**Every legibility judgement in the first ASCII report was made against images
~1.24× larger than their labels.** Verified: the 48px box occupied 62 image px
in the old capture and exactly 50 in the new one. The old screenshotter returned
1127px wide for a 900px request, because this display runs at DPR 1.25.

The error is uniform and it *flatters every candidate*. Concretely: the "24px
cliff" was 30px of pixels called 24, and "sextant 12×6 survives at 34px" — the
single finding that kept a glyph path alive — was a judgement at 42px, which
does not hold at a true 34.

**So every block-technique finding from that first pass is optimistic and has
not been re-measured.** Sextant, quadrant, halfblock, shade and braille 8×4 are
all still at 1.24×. Re-shoot before trusting any of them.

### ASCII: closed

The structural prediction held — a letterform at 2.83px is a smudge whose
darkness is its only signal — but the mechanism is worse than predicted, because
it fails at BOTH ends:

| variant | 34px | 48px |
|---|---|---|
| `ascii 16x8 accent` | 31.6 | **26.8** |
| `ascii 12x6 truecolor` | 31.6 | **26.7** |

**Separation DROPS as the icon grows.** The only technique on either sheet that
does this: all four subjects draw from the same ten-level character ramp, so
extra pixels render *shared characters* more crisply. More size buys more
legible sameness.

And it flips the viewer's mode. At 48px `potion_ascii_4x2_mono` is unambiguously
the characters `++` over `:%%:` — the eye stops looking and starts *reading*,
gets punctuation, and gets nothing. A smudge is ignorable; text demands parsing
and pays out zero.

At the 16px label, `ascii 4x2 mono` renders potion and bug as **pixel-identical
images** — separation 0.0. `ascii mono` never works at any grid or size.

Below 24px nothing carries identity, and that is arithmetic rather than tuning:
the smallest font-size drawn is **1.71px** (16×8 at a 16px target). No
rasterizer produces distinct letterforms there, so no threshold, ramp or
downsample setting can move it.

### Braille 16×8: NOT closed — the one survivor

32×32 addressable dots (16×8 cells × 2×4), more resolution than anything else
tested, and **the first technique to render all four subjects recognisably.**

Most importantly it **fixes the spell**, which is the failure flagged hardest in
the first pass: at every lower grid the 4-point star collapsed into a `+` and
meant *add* — an icon that confidently means the wrong thing, which is worse
than one that means nothing. At 32×32 dots the concave taper survives and it
reads as a burst.

Separation at 34px, same 1:1 capture: emoji **48.6**, braille 16×8 accent 26.5,
duotone 15.3, mono 11.9. It still loses to the emoji by about half — but it is
the first candidate in the same conversation.

**Do not let the metric pick.** It ranks best-ascii (31.6) above best-braille
(26.5) at 34px and is WRONG there: ASCII's separation comes from *texture*,
which pixel distance rewards and humans do not use to identify things; braille's
comes from *silhouette*, which is what recognition actually uses.

### The contrast defect, which is an app problem and not a spike problem

WCAG 1.4.11 requires **3:1** for non-text graphical objects. Measured as the
strongest ink pixel against its surface:

| render | on panel `#171a23` | on light chrome `#dfe4ee` |
|---|---|---|
| ascii mono / duotone | 10.9–11.0:1 | **1.24:1** |
| braille 16×8 mono / duotone | 5.01:1 | **1.14:1** |
| **braille 16×8 accent** | **2.26:1 FAILS** | 1.43:1 |
| **braille 16×8 truecolor** | **2.68:1 FAILS** | — |

**The two best braille colour modes fail contrast on this app's own panel
colour.** Braille dots are small and antialiased so they never reach full ink
coverage — the technique buys shape at the cost of effective contrast. ASCII has
the contrast and no shape; braille has the shape and not enough contrast.

And it lands exactly on the mode otherwise worth recommending: `accent` roughly
doubles distinguishability over `mono`, and `accent` is the one at 2.26:1.

On any light surface every candidate is 1.14–1.24:1 — these icons would not
degrade, they would **disappear**.

### The decision — RICARDO, 2026-09-14: ship emoji, close all of it

**Closed. Emoji everywhere, at every size. No second icon system.**

That includes braille 16x8, which survived the judging. It is closed as a
DECISION rather than as a finding, and the difference matters if anyone reopens
this: it was the best glyph result in the exploration and it still lost.

The reasoning, in the order it decides:

1. It loses to a single emoji character by roughly 2:1 on measured
   distinguishability (48.6 vs 26.5) -- and that is its BEST colour mode.
2. That best mode fails WCAG non-text contrast on this app's own panel colour
   (2.26:1 against a 3:1 minimum). The mode that passes contrast scores 15.3,
   which is a third of the emoji.
3. The price of taking it anyway is a whole second icon system, gated to >=34px
   because it is dead at 16, plus a palette fix, plus a light-surface ink fix --
   to still lose.

Naomi's conditions for pursuing it are left in place above, unaltered, so that
reopening this is a matter of satisfying them rather than re-running the work.

**Not re-measured, and deliberately so:** sextant, quadrant, halfblock, shade
and braille 8x4 are all still judged at 1.24x their labels. Re-shooting them is
one command each now (`verify/shoot-full.js`), but there is no point: the
technique that beat all of them at a verified 1:1 is the one just declined.
Anyone reopening this must re-shoot before quoting a single number from the
first report.

**What survives into the product:** the ART PLACEHOLDER RULE stands, and the
emoji stay as data beside the thing they mark rather than baked into markup, so
replacing them with generated art later is still one field.


### One thing worth keeping regardless

The audit measures the emoji advance at **1.3730em** against mono's 0.5859em, so
an emoji occupies **2.34 character cells** of width. Irrelevant to a
CSS-laid-out roster; it matters the moment anything is drawn into a fixed
character grid.
