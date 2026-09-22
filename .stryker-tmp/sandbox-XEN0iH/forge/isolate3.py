"""Rewrite the style block in painting vocabulary and measure the recovery.

isolate2.py showed three components each crush saturation on their own, against
a bare-subject baseline of 82.7:

    art only        77.2   fine
    shot only       18.0   "head and shoulders BUST" -- bust is sculpture
    lighting only   10.9   "soft RIM LIGHTING" -- studio photography
    background only  9.7   "dark CHARCOAL background" -- a drawing medium

Every one of those is photographic or sculptural vocabulary, and each drags the
image toward stone, studio lighting and graphite. The art clause, written in
painting terms, costs almost nothing.

So the fix is not deleting the art direction -- it is saying the same thing in
the register that produces colour.

    python isolate3.py
"""

from __future__ import annotations

from generate import PORTRAITS_ROOT, load_pipeline

OUT = PORTRAITS_ROOT / "_isolate3"
SUBJECT = "portrait of a young man with vivid bright red hair"
SEED = 12345

ART = "painterly digital illustration, visible brush texture, stylised features"

CANDIDATES = [
    # The current block, for reference.
    ("20-current",
     f"{ART}, head and shoulders bust, centered, facing viewer, eye level, "
     "soft rim lighting from the upper left, plain dark charcoal background, no scenery, "
     "consistent character design"),

    # Same instructions, painting vocabulary: portrait not bust, light not rim
    # lighting, muted not charcoal.
    ("21-painterly-words",
     f"{ART}, head and shoulders portrait, centered, facing viewer, "
     "soft warm light from the upper left, plain deep muted background, no scenery, "
     "consistent character design"),

    # As above plus an explicit colour instruction, since the block is what was
    # suppressing colour in the first place.
    ("22-painterly-plus-colour",
     f"{ART}, rich saturated colour, head and shoulders portrait, centered, facing viewer, "
     "soft warm light from the upper left, plain deep muted background, no scenery, "
     "consistent character design"),

    # Minimal: does dropping framing and lighting entirely buy more than the
    # rewrite does? If not, keep them -- they are doing real compositional work.
    ("23-art-plus-colour-only",
     f"{ART}, rich saturated colour, head and shoulders portrait, facing viewer"),
]


def main() -> int:
    import torch

    OUT.mkdir(parents=True, exist_ok=True)
    pipe = load_pipeline(lightning=False)

    for name, style_text in CANDIDATES:
        image = pipe(
            prompt=SUBJECT,
            prompt_2=style_text,
            num_inference_steps=28,
            guidance_scale=6.0,
            width=1024,
            height=1024,
            generator=torch.Generator(device="cpu").manual_seed(SEED),
        ).images[0]
        image.save(OUT / f"{name}.png")

        hsv = image.convert("HSV")
        sat = sum(hsv.getdata(1)) / (image.width * image.height)
        print(f"  {name:26} saturation {sat:5.1f}", flush=True)

    print("\nreference: bare subject 82.7, current block 4.3")
    print(f"written to {OUT.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
