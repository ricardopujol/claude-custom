"""A/B a single knob against a fixed seed, so adherence can be judged by eye.

Written because the first real batch dropped most of the description: Dexter's
"red hair, big glasses, high-collared white coat" and the whole "cold crimson
and slate" palette all vanished, and both agents came back near-monochrome.
That is the signature of too little classifier-free guidance, but guessing at a
number and regenerating 60 images is the expensive way to find out.

    python tune.py --agent logic-reviewer --guidance 1.5 3.0 5.0
    python tune.py --agent logic-reviewer --steps 8 12 16
"""

from __future__ import annotations

import argparse
from pathlib import Path

from prompts import (
    appearance_for,
    build_prompt,
    build_style_prompt,
    derive_identity,
    load_appearances,
    load_style,
    resolve_palette,
    negative_prompt,
    parse_agent_file,
)
from generate import (
    AGENTS_DIR,
    APPEARANCES_FILE,
    LIGHTNING_GUIDANCE,
    LIGHTNING_STEPS,
    PORTRAITS_ROOT,
    agent_seed,
    load_pipeline,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--guidance", type=float, nargs="+", default=[LIGHTNING_GUIDANCE])
    ap.add_argument("--steps", type=int, nargs="+", default=[LIGHTNING_STEPS])
    ap.add_argument("--out", default=str(PORTRAITS_ROOT / "_tuning"))
    ap.add_argument("--no-lightning", action="store_true",
                    help="plain SDXL instead of the few-step LoRA (slower, far better adherence)")
    args = ap.parse_args()

    import torch

    looks = load_appearances(APPEARANCES_FILE)
    style = load_style(APPEARANCES_FILE)
    identity = appearance_for(
        derive_identity(parse_agent_file(AGENTS_DIR / f"{args.agent}.md")), looks
    )

    prompt = build_prompt(identity, "working", style=style)
    style_prompt = build_style_prompt(style, resolve_palette(identity))
    print(f"prompt  : {prompt}")
    print(f"prompt_2: {style_prompt}\n")

    out = Path(args.out) / args.agent
    out.mkdir(parents=True, exist_ok=True)

    pipe = load_pipeline(lightning=not args.no_lightning)
    # ONE seed across the whole sweep: any difference is then the knob, not the
    # noise. Varying both at once proves nothing.
    seed = agent_seed(identity["agent"])

    for steps in args.steps:
        for guidance in args.guidance:
            image = pipe(
                prompt=prompt,
                prompt_2=style_prompt,
                negative_prompt=negative_prompt(),
                negative_prompt_2=negative_prompt(),
                num_inference_steps=steps,
                guidance_scale=guidance,
                width=1024,
                height=1024,
                generator=torch.Generator(device="cpu").manual_seed(seed),
            ).images[0]

            tag = "base" if args.no_lightning else "lightning"
            path = out / f"{tag}-g{guidance:g}-s{steps}.png"
            image.save(path)
            print(f"  {path.name}", flush=True)

    print(f"\nwritten to {out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
