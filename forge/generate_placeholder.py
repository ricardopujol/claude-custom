"""The universal fallback portrait -- not tied to any agent name.

Used for anything with no designed face: a roster agent before its portrait is
generated, and any dynamically-invented agent name that will never have one
(there is no way to pre-generate a portrait for a name that doesn't exist yet).

Written to portraits/_default/working.png -- the leading underscore keeps it
out of missing_agents()'s scan in generate_default.py, same convention as the
existing _isolate/_tuning/etc. debug folders.

    python generate_placeholder.py
"""
from __future__ import annotations

from generate import (
    APPEARANCES_FILE,
    PORTRAITS_ROOT,
    LIGHTNING_GUIDANCE,
    LIGHTNING_STEPS,
    agent_seed,
    load_pipeline,
)
from prompts import build_style_prompt, load_style, negative_prompt
from generate_default import NEUTRAL_CUE, save_all_states

# Deliberately not an "identity" derived from any agent file -- this is a
# fixed, hand-specified character per Ricardo's request.
APPEARANCE = (
    "a spy in a black fedora, black trench coat, black sunglasses"
)


def main() -> int:
    style = load_style(APPEARANCES_FILE)
    palette = "black and charcoal tones, noir"
    prompt = f"{APPEARANCE}, {NEUTRAL_CUE}, {palette}, {style['core']}"
    style_prompt = build_style_prompt(style, palette)
    negative = negative_prompt()

    print(f"prompt: {prompt}", flush=True)
    pipe = load_pipeline(lightning=True)

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
        generator=torch.Generator(device="cpu").manual_seed(agent_seed("_default")),
    ).images[0]

    out_dir = PORTRAITS_ROOT / "_default"
    save_all_states(image, out_dir)
    print(f"written to {out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
