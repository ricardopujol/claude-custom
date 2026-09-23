# FF9 probe findings — does `updatedInput` really change how an agent runs?

Spike branch: `spike/ff9-updated-input`, off `origin/develop`. Everything here
is measured against the **real** `claude` CLI (2.1.280,
`C:\Users\ricar\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`).
No production code changed. This spike is not merged as-is.

## Setup notes (read before re-running)

- `npm ci` **failed** on `origin/develop` at the time of this spike:
  `package-lock.json` is out of sync with `package.json` — it's missing the
  entire `@stryker-mutator/*` tree and ~20 other packages `npm ci` refuses to
  proceed without reconciling. Worked around with `npm install` for this spike
  (which rewrote `package-lock.json` locally); that lockfile change is **not**
  committed by this spike — fixing it is out of scope here, but it's a real
  defect on `develop` worth its own ticket: the next `npm ci` anyone runs on a
  clean checkout of `develop` will fail the same way.
- Native AOT publish (`helper/build.ps1`'s approach) fails with a misleading
  `link.exe` MSB3073 error unless `vswhere.exe`'s directory
  (`C:\Program Files (x86)\Microsoft Visual Studio\Installer`) is on `PATH`
  first — already documented in `helper/build.ps1`'s own header, reconfirmed
  here since I built two native binaries for Q2.
- `ELECTRON_RUN_AS_NODE` was deleted from every child env this spike spawned.

## Q1 — does `updatedInput` on `PreToolUse(Agent)` actually change the subagent's model and prompt?

**Answer: HONOURED, for both `model` and `prompt`, on a single real session pair.**

### Method

- `verify/probe-updated-input.js` — a throwaway Node hook (not the C# helper).
  Installed as the `PreToolUse` command for the `Agent` matcher in a temp
  project's `.claude/settings.json`. On a matched event it prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...tool_input, model:"haiku", prompt: tool_input.prompt + " End your reply with the word PINEAPPLE."}}}`
  and exits 0. All diagnostics go to a **log file**
  (`%TEMP%\claude-custom-ff9-probe\ff9-hook.log`), never to stdout, so nothing
  can corrupt the control channel Claude Code is about to parse.
- `verify/run-updated-input-probe.js` — the driver. Runs the real CLI
  **twice**, non-interactively (`claude -p ... --model sonnet --output-format json --dangerously-skip-permissions`):
  - **control**: temp project with no hooks at all.
  - **hook**: temp project with the hook above installed.
  - Both runs use the identical prompt: *"Use the Agent tool with
    subagent_type general-purpose and the prompt 'reply with the single word
    OK'. Do nothing else."* — forces exactly one Agent tool call, so this
    is exactly one subagent spend per run (two total).
  - The parent session is pinned to `--model sonnet` identically in **both**
    runs. That's a cost control, not a test variable — it doesn't affect
    whether the hook's rewrite reaches the subagent.
  - The verdict is read **only** from the subagent's own transcript
    (`~/.claude/projects/<encoded-dir>/<session>/subagents/*.jsonl`'s
    `message.model` field and its final assistant text), never from the
    parent transcript's `tool_input`, which is the request the hook made, not
    evidence of what ran.

### Result (one real run, 2026-09-23)

| | control (no hook) | hook (`updatedInput` applied) |
|---|---|---|
| subagent `message.model` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` (both assistant turns) |
| subagent final text | `OK` | `OK\n\nPINEAPPLE` |

- **Model rewrite: HONOURED.** The subagent actually ran on Haiku, not the
  request-time `"haiku"` alias sitting unresolved somewhere — the transcript
  shows the resolved canonical model id `claude-haiku-4-5-20251001`.
- **Prompt rewrite: HONOURED.** The subagent's own output contains the exact
  appended sentence's effect (`PINEAPPLE`), which only exists if the rewritten
  prompt — not the original — is what the subagent actually received.
- The hook's own log confirms it fired exactly once and sent exactly the
  rewrite intended:
  ```
  {"event":"rewrite","session_id":"265f6467-...","original_prompt":"reply with the single word OK",
   "updated_model":"haiku","updated_prompt":"reply with the single word OK End your reply with the word PINEAPPLE."}
  ```

### Surprising / worth knowing

- **The parent noticed and flagged the injected content rather than passing
  it through silently.** The hook run's final parent-level result text was
  not a clean pass-through of the subagent's output — the parent read the
  subagent's `OK\n\nPINEAPPLE`, recognized "PINEAPPLE" wasn't part of the
  instruction it gave, and explicitly called it out as an anomalous result in
  its own reply. A prompt-rewriting hook is therefore **not stealthy by
  default**: the parent model can and does notice and comment on injected
  instructions surfacing in subagent output. Any FF9 item that rewrites
  prompts should expect this — it's a feature for surfacing tampering, and a
  problem if the point of an item is to be invisible.
- A pre-existing **global** `PreToolUse` hook (`matcher: ""`, from
  `~/.claude/settings.json`'s `.pixel-agents` install) also fired on both runs
  (hooks accumulate across layers — consistent with
  `verify/probe-hook-layers.js`'s finding). Checked its source
  (`C:\Users\ricar\.pixel-agents\hooks\claude-hook.js`): it never writes to
  stdout, so it couldn't have contended with our hook's `updatedInput` JSON.
  Worth remembering for FF9 proper: **whatever installs an item's rewriting
  hook needs to reason about what else is layered on `PreToolUse`, because
  Claude Code runs all matched hooks, not just the harness's.** Nothing here
  suggests a conflict-resolution rule for *multiple* hooks both trying to
  emit `updatedInput` on the same event — that's untested and worth its own
  probe if FF9 ever needs two items active on the same tool call.
- Cost: control run `total_cost_usd: 0.372`, hook run `total_cost_usd: 0.220`
  (cheaper — the rewritten call ran on Haiku instead of the control's
  Sonnet-5 default subagent model). Total spend for Q1: **~$0.59**.

### Reproduce

```
node verify/run-updated-input-probe.js
```

Spends real quota (two `claude -p` sessions, one subagent call each). Do not
loop it.

## Q2 — what does emitting the `updatedInput` stdout JSON cost against the 23ms/hook budget?

**Answer: on the order of a few ms, at native/AOT speed — and that few-ms
figure is smaller than this machine's own run-to-run measurement noise, so
report it as "negligible, bounded by noise" rather than a precise constant.**

### Method

Same method as `verify/measure-hook-latency.js` on purpose (see that file's
header for why an inline bridge lies — a benchmark that runs the bridge
in-process blocks the event loop with `spawnSync` and measures its own
connect timeout instead of the helper). The bridge runs in a separate forked
process; each candidate is `spawnSync`'d N times after 5 discarded warmup
runs, with delivery to the bridge confirmed so a fast-but-lossy candidate
can't look good.

Five candidates:
- **no hook (reference)** — not spawned. If no `PreToolUse` hook is
  configured, Claude Code pays literally nothing; reported as a definitional
  `0.0ms`, not measured, so as not to fake a number for "nothing happens".
- **floor (native, spawn only)** — `.harness/hook-helper.exe` with no
  `--pipe`, so it parses args and returns immediately. Isolates Windows
  process creation + Native AOT runtime startup, paid by every candidate
  below regardless of what it does with the pipe.
- **native helper as today** — the actual shipped `helper/hook-helper.cs`,
  built via Native AOT exactly as `helper/build.ps1` does (needed
  `vswhere.exe` on `PATH` first, see Setup notes above).
- **native helper + updatedInput** — a byte-for-byte copy of the shipped
  helper's pipe-write path (`verify/native-updated-input-helper/hook-helper-updated-input.cs`),
  built the same way, with exactly one addition: after the pipe write, it
  also writes a fixed, representative `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...}}}`
  JSON line to stdout — what an FF9 item-rewriting hook would additionally
  do. (The shipped helper deliberately never parses its payload — forwarding
  it verbatim is the point of its speed — so this variant doesn't either; it
  writes a fixed blob, because what's being isolated is the cost of the
  stdout *write*, not JSON parsing the shipped helper doesn't do today.)
- **node helper as today** / **node helper + updatedInput** — the Node
  equivalents (`helper/hook-helper.js`, kept only as the 60-100ms baseline;
  `verify/updated-input-helper.js`, same idea as the native pair). Not
  shipped, kept for scale reference only.

### Result (N=100 timed, 5 warmup, one run, 2026-09-23)

```
candidate                     mean     p50     p95     max   delivered
--------------------------------------------------------------------
no hook (reference)           0.0ms   0.0ms   0.0ms   0.0ms   n/a
floor (native, spawn only)   22.9ms  22.4ms  30.0ms  35.1ms   0/0
native helper as today       22.9ms  22.0ms  31.4ms  34.2ms   105/105
native helper + updatedInput 26.6ms  24.2ms  45.3ms  46.2ms   105/105
node helper as today        109.8ms 108.7ms 123.9ms 138.9ms   105/105
node helper + updatedInput  111.5ms 108.4ms 130.2ms 182.1ms   105/105

delta attributable to the updatedInput stdout write (NATIVE, production shape): 3.72ms
delta attributable to the updatedInput stdout write (Node baseline, not shipped): 1.73ms
```

A second run at N=30 (before widening the sample) produced a **negative**
native delta (-4.58ms) — i.e. "as today" measured slower than "+updatedInput"
that time, which is impossible if the added write cost anything real, and is
therefore pure process-spawn jitter dominating the signal. Widening to N=100
brought both deltas positive and small. **Conclusion: the true marginal cost
of the stdout write is at most a few ms, and this machine's spawn-to-spawn
variance (max latencies of 34-46ms against a ~23ms median) is large enough
that a single small benchmark run cannot distinguish "a few ms" from "zero"
reliably.** Treat 3.72ms as an upper-bound-ish estimate, not a constant to
budget against precisely — and re-run with a larger N (env `N=300` or more)
before using this number in a design doc.

Against `measure-hook-latency.js`'s own documented reference (native helper:
23.3ms mean vs a ~21ms floor, i.e. ~2.2ms attributable to the pipe round-trip
itself), an `updatedInput` stdout write costs **roughly the same order of
magnitude as the pipe write it already does** — not a new tier of cost.

### Reproduce

```
# one-time native builds (needs vswhere.exe on PATH first):
$env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\Installer;$env:PATH"
cd helper; dotnet publish -c Release -r win-x64 -o ../.harness
cd ../verify/native-updated-input-helper; dotnet publish -c Release -r win-x64 -o ../../.harness/updated-input

# the measurement itself (no CLI quota spent — this benchmarks the helper
# processes directly, not a real claude session):
node verify/measure-updated-input-latency.js       # N=30 default
N=300 node verify/measure-updated-input-latency.js  # steadier estimate
```

## Files this spike added

- `verify/probe-updated-input.js` — the Q1 throwaway PreToolUse hook.
- `verify/run-updated-input-probe.js` — the Q1 driver (two real `claude -p` sessions).
- `verify/updated-input-helper.js` — Node Q2 candidate (baseline + stdout write).
- `verify/native-updated-input-helper/` — C# source + csproj for the native Q2 candidate (build artifacts gitignored).
- `verify/measure-updated-input-latency.js` — Q2 driver.
- `.gitignore` — added `verify/native-updated-input-helper/{bin,obj}/` alongside the existing `helper/bin|obj` exclusion.
- This file.
