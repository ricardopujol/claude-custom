# forge — agent portrait generation

Entirely offline. Never talks to the host or the GUI; it writes PNGs into
`portraits/<agent-name>/<state>.png` and the harness picks them up by
convention, with a generated placeholder for anything missing.

## Hardware reality

**RTX 4070 Laptop, 8188 MiB, driver 610.62** (verified, matches the design).

8 GB rules out comfortable Flux. The pipeline is SDXL fp16 with
`enable_model_cpu_offload()`, driven by a distilled **SDXL-Lightning 8-step
LoRA** — chosen because 3-second iterations change how much exploration
actually happens. At 40 s/image nobody explores, they accept the first
tolerable result.

## Setup

Python **3.12**, not 3.14 — this is CUDA work.

```sh
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
.venv/Scripts/python -m pip install -r requirements.txt
```

Install torch first and from the CUDA index. From PyPI you silently get a
CPU-only build, and it surfaces much later as `cuda is not available` rather
than as a bad install.

Roughly 10–12 GB downloads on first run: torch ~2.5 GB, SDXL base ~6.9 GB,
Lightning LoRA ~0.4 GB, CLIP ~0.6 GB.

## Pipeline

| Step | Script | Notes |
|---|---|---|
| 1. Prompt derivation | `prompts.py` | Reads agent `.md` frontmatter. **Read-only** — editing agent files triggers the mandatory `/align-agents` sync |
| 2. Base bust | `generate.py` | ~8 candidates per agent; **pick one by hand** |
| 3. Four states | `states.py` | img2img at ~0.45 denoise, fixed per-agent seed |
| 4. Identity gate | `states.py` | CLIP embeddings, auto-retry below threshold |
| 5. Post | `states.py` | square crop, `rembg` to alpha, 256 px and 128 px |

```sh
.venv/Scripts/python generate.py --agents code-reviewer logic-reviewer --candidates 8
# look at outputs/<agent>/candidates/, choose one, then:
.venv/Scripts/python states.py --agent code-reviewer --base outputs/code-reviewer/candidates/cand-03-seed....png
```

Step 2 is the only mandatory human step and the real time cost. Everything
downstream is conditioned on that choice.

## Art direction vs. per-agent looks

`appearances.yaml` holds two separate things, and keeping them apart is what
makes 161 portraits look like one set:

- `_style` — how everything is drawn. Shared, sent to SDXL's **second** text
  encoder, identical for every agent.
- per-agent entries — **only the person**. No framing, no art style, no
  expression.

**Why two encoders.** Measured with the real CLIP tokenizer: subject + state +
palette + style in one string came to **99 tokens against a hard limit of 77**.
The style sat last, so truncation ate *the art direction* — by a different
amount per agent, which is exactly how a roster stops looking like a set.
Tightening cannot rescue it (the style block alone is ~44 tokens, leaving ~15
for a description). SDXL has two text encoders with independent 77-token
budgets, so `prompt` carries the subject and `prompt_2` the style, and neither
can truncate the other. After the split: style prompt 48 tokens, all agents fit.

Run `python check.py` after editing. It measures with the real tokenizer and
flags unknown agent keys, over-long entries, and text that fights the shared
direction. Every one of those is invisible in the output — you see an
inconsistent roster, not the entry that caused it.

## Three traps worth keeping

**`enable_vae_slicing()` moved.** diffusers 0.40 removed it from the pipeline;
it is `pipe.vae.enable_slicing()` now. The old call raises `AttributeError`
*after* the 11 GB model has finished loading, so the run dies at the most
expensive possible moment. Both call sites are guarded in either direction.

**The identity gate must NOT use ArcFace or InsightFace.** Face-recognition
models are trained on photographs and are unreliable on illustration: they
reject good frames and pass bad ones. That is worse than having no gate,
because it still looks like it is working. CLIP or DINOv2 embeddings only.

**Lightning needs `timestep_spacing="trailing"` and low guidance (~1.5).** With
the default spacing the few-step schedule is simply wrong, and at the usual
guidance of 7.5 the image burns out. Both produce bad output that reads as "the
model is bad" rather than "the scheduler is misconfigured".

## Scope

~21 of the 161 agents carry a human name (Miguel, Dexter, Naomi, Paris, Atlas,
Cedar, Vera, Otto, Mortimer, Lukas…) — those first, since a portrait of a named
identity means something. v1 is roughly 15 agents × 4 states ≈ 60 images, not
320. The state list is read from config and is never hardcoded to four;
"thinking" and "waiting on you" are expected to follow.

Agents without portraits render as stable generated placeholders, so the roster
works today for all 161.
