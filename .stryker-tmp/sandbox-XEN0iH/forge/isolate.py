"""Minimal reproduction for the monochrome problem.

Two hypotheses have now been disproved by experiment -- guidance was not the
cause (raising it made adherence worse), and neither was the palette being
absent from the pooled embedding (adding it changed nothing). Thirteen-plus
images across two samplers and four guidance values have all come back grey,
and the background has stayed light despite BOTH encoders asking for a dark one.

So stop reasoning about the full prompt and strip it to nothing, adding one
thing back at a time. Each variant is a single change against a fixed seed.

    python isolate.py
"""

from __future__ import annotations

from pathlib import Path

from generate import PORTRAITS_ROOT, load_pipeline

OUT = PORTRAITS_ROOT / "_isolate"

# Each entry is (name, prompt, prompt_2, negative). Ordered from "nothing at
# all" upward, so the first variant that goes grey names the culprit.
VARIANTS = [
    ("01-bare-red",
     "portrait of a young man with vivid bright red hair", None, None),

    ("02-red-plus-colourful",
     "portrait of a young man with vivid bright red hair, vibrant saturated colour illustration",
     None, None),

    ("03-red-plus-our-style",
     "portrait of a young man with vivid bright red hair",
     "painterly digital illustration, visible brush texture, stylised features, "
     "head and shoulders bust, centered, facing viewer, eye level, "
     "soft rim lighting from the upper left, plain dark charcoal background, no scenery, "
     "consistent character design",
     None),

    ("04-red-plus-our-negative",
     "portrait of a young man with vivid bright red hair", None,
     "photo, photorealistic, 3d render, text, letters, watermark, signature, "
     "full body, hands, multiple people, crowd, blurry, lowres, deformed, "
     "extra limbs, busy background, frame, border"),

    ("05-full-current",
     "a gaunt young man with sharp angular features, red hair, big glasses, "
     "high-collared white coat, pale skin, focused and alert, cold crimson and slate, "
     "painterly illustration, facing viewer, plain dark background",
     "painterly digital illustration, visible brush texture, stylised features, "
     "cold crimson and slate, head and shoulders bust, centered, facing viewer, eye level, "
     "soft rim lighting from the upper left, plain dark charcoal background, no scenery, "
     "consistent character design",
     "photo, photorealistic, 3d render, text, letters, watermark, signature, "
     "full body, hands, multiple people, crowd, blurry, lowres, deformed, "
     "extra limbs, busy background, frame, border"),
]

SEED = 12345


def main() -> int:
    import torch

    OUT.mkdir(parents=True, exist_ok=True)
    # Plain SDXL: Lightning is already known to cost adherence, and mixing that
    # in would confound the one thing being tested.
    pipe = load_pipeline(lightning=False)

    for name, prompt, prompt_2, negative in VARIANTS:
        kwargs = dict(
            prompt=prompt,
            num_inference_steps=28,
            guidance_scale=6.0,
            width=1024,
            height=1024,
            generator=torch.Generator(device="cpu").manual_seed(SEED),
        )
        if prompt_2:
            kwargs["prompt_2"] = prompt_2
        if negative:
            kwargs["negative_prompt"] = negative
            kwargs["negative_prompt_2"] = negative

        image = pipe(**kwargs).images[0]
        path = OUT / f"{name}.png"
        image.save(path)

        # Saturation, measured rather than eyeballed: mean HSV S over the image.
        # "Looks grey" is exactly the kind of judgement that drifts between
        # glances, and the whole point here is to compare five variants.
        hsv = image.convert("HSV")
        sat = sum(hsv.getdata(1)) / (image.width * image.height)
        print(f"  {name:26} mean saturation {sat:5.1f} / 255", flush=True)

    print(f"\nwritten to {OUT.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
