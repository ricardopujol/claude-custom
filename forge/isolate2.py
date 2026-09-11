"""Which word in the style block kills colour?

isolate.py narrowed it to the style block: adding it dropped mean saturation
from 82.7 to 4.3 while the negative prompt was innocent at 76.8. This splits the
block apart to name the token.

Prime suspect: "plain dark CHARCOAL background". Charcoal was intended as a
shade of grey and is also a DRAWING MEDIUM -- next to "visible brush texture"
that reads as "charcoal sketch", which would explain the monochrome, the
pencil-sketch rendering, and the light grey "paper" backgrounds all at once.

    python isolate2.py
"""

from __future__ import annotations

from generate import PORTRAITS_ROOT, load_pipeline

OUT = PORTRAITS_ROOT / "_isolate2"
SUBJECT = "portrait of a young man with vivid bright red hair"
SEED = 12345

ART = "painterly digital illustration, visible brush texture, stylised features"
SHOT = "head and shoulders bust, centered, facing viewer, eye level"
LIGHT = "soft rim lighting from the upper left"
BG_CHARCOAL = "plain dark charcoal background, no scenery"
BG_NEUTRAL = "plain dark background, no scenery"
BG_COLOURED = "plain deep indigo background, no scenery"

VARIANTS = [
    ("10-art-only", ART),
    ("11-shot-only", SHOT),
    ("12-light-only", LIGHT),
    ("13-bg-charcoal-only", BG_CHARCOAL),
    ("14-full-minus-charcoal", f"{ART}, {SHOT}, {LIGHT}, {BG_NEUTRAL}"),
    ("15-full-coloured-bg", f"{ART}, {SHOT}, {LIGHT}, {BG_COLOURED}"),
]


def main() -> int:
    import torch

    OUT.mkdir(parents=True, exist_ok=True)
    pipe = load_pipeline(lightning=False)

    for name, style_text in VARIANTS:
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
        print(f"  {name:26} saturation {sat:5.1f}   [{style_text[:52]}...]", flush=True)

    print(f"\nbaseline for reference: bare subject was 82.7")
    print(f"written to {OUT.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
