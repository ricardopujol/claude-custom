"""One image per agent, no per-state expression pipeline.

For agents whose look comes from appearances.yaml (see build_appearances.py in
the scratchpad -- one random, non-role-derived character each, with a single
uncommon attribute). Generates ONE txt2img frame with a neutral expression,
crops + removes background ONCE, then saves that same image under all four
state filenames the harness already looks up (portraitFor reads a specific
state file per current mood; without this, three of the four moods would fall
back to the placeholder even though a real portrait exists).

Resumable: an agent with an existing working.png is skipped, so a killed run
can just be re-launched.

    python generate_default.py                 # all agents missing a portrait
    python generate_default.py --agents foo bar # just these
    python generate_default.py --limit 5        # smoke test
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from PIL import Image

from generate import (
    AGENTS_DIR,
    APPEARANCES_FILE,
    PORTRAITS_ROOT,
    LIGHTNING_GUIDANCE,
    LIGHTNING_STEPS,
    agent_seed,
    load_pipeline,
)
from prompts import (
    CLIP_TOKEN_LIMIT,
    appearance_for,
    build_style_prompt,
    count_tokens,
    derive_identity,
    fit_subject,
    load_appearances,
    load_style,
    negative_prompt,
    parse_agent_file,
    resolve_palette,
)

STATES = ("working", "sleeping", "happy", "stressed")
EXPORT_SIZES = (256, 128)

# One calm expression for every agent -- the whole point is skipping the four
# mood-specific cues (see prompts.py _STATE_CUES), not reusing one of them.
NEUTRAL_CUE = "calm composed expression, relaxed features"


def build_neutral_prompt(identity: dict, style: dict) -> str:
    """Same shape as prompts.build_prompt, but with a neutral cue and the
    agent's own palette instead of a mood-state palette (there is no mood
    here)."""
    palette = resolve_palette(identity)
    tail = ", ".join([NEUTRAL_CUE, palette, style["core"]])
    reserved = count_tokens(tail)

    subject = (
        identity.get("appearance")
        or identity.get("role")
        or identity.get("agent", "specialist")
    )
    import re
    if not re.match(r"(?i)^(a|an|the)\s", subject):
        subject = f"a {subject}"
    subject = fit_subject(subject, CLIP_TOKEN_LIMIT - reserved)
    return ", ".join([subject, tail])


def save_all_states(image: Image.Image, agent_dir: Path) -> list[Path]:
    """Crop + alpha ONCE, then export the same frame under every state name."""
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    square = image.crop((left, top, left + side, top + side))

    try:
        from rembg import remove
        square = remove(square)
    except Exception as exc:  # noqa: BLE001 - optional dependency
        print(f"    (rembg unavailable, keeping background: {exc})")
        square = square.convert("RGBA")

    agent_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for state in STATES:
        for size in EXPORT_SIZES:
            path = agent_dir / (f"{state}.png" if size == EXPORT_SIZES[0] else f"{state}@{size}.png")
            square.resize((size, size), Image.LANCZOS).save(path)
            written.append(path)
    return written


def missing_agents() -> list[str]:
    have = {p.name for p in PORTRAITS_ROOT.iterdir() if p.is_dir() and not p.name.startswith("_")} \
        if PORTRAITS_ROOT.exists() else set()
    all_agents = sorted(p.stem for p in AGENTS_DIR.glob("*.md"))
    return [a for a in all_agents if a not in have]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", nargs="*", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    appearances = load_appearances(APPEARANCES_FILE)
    style = load_style(APPEARANCES_FILE)
    print(f"hand-written appearances: {len(appearances)}", flush=True)

    agents = args.agents if args.agents else missing_agents()
    if args.limit:
        agents = agents[: args.limit]
    print(f"agents to generate: {len(agents)}", flush=True)

    pipe = load_pipeline(offline=args.offline, lightning=True)
    negative = negative_prompt()

    done, skipped, failed = 0, 0, 0
    for i, name in enumerate(agents, 1):
        agent_dir = PORTRAITS_ROOT / name
        if (agent_dir / "working.png").exists():
            print(f"[{i}/{len(agents)}] {name}: already has working.png, skipping", flush=True)
            skipped += 1
            continue

        path = AGENTS_DIR / f"{name}.md"
        if not path.exists():
            print(f"[{i}/{len(agents)}] {name}: no such agent file, skipping", flush=True)
            continue

        t0 = time.time()
        try:
            identity = appearance_for(derive_identity(parse_agent_file(path)), appearances)
            prompt = build_neutral_prompt(identity, style)
            style_prompt = build_style_prompt(style, resolve_palette(identity))

            import torch
            image = pipe(
                prompt=prompt,
                prompt_2=style_prompt,
                negative_prompt=negative,
                negative_prompt_2=negative,
                num_inference_steps=LIGHTNING_STEPS,
                guidance_scale=LIGHTNING_GUIDANCE,
                width=1024,
                height=1024,
                generator=torch.Generator(device="cpu").manual_seed(agent_seed(name)),
            ).images[0]

            save_all_states(image, agent_dir)
            done += 1
            print(f"[{i}/{len(agents)}] {name}: done in {time.time() - t0:.1f}s -- {prompt[:90]}", flush=True)
        except Exception as exc:  # noqa: BLE001 - one bad agent must not kill the batch
            failed += 1
            print(f"[{i}/{len(agents)}] {name}: FAILED -- {exc}", flush=True)

    print(f"\ndone={done} skipped={skipped} failed={failed} total={len(agents)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
