"""Turn one chosen base bust into the four emotional states.

img2img at moderate denoise, seeded per agent, so pose and framing stay put
while expression changes. Each result passes an automated identity gate before
it is kept -- that gate is what turns 60+ images from a hand-review job into a
threshold plus a reject pile.

IMPORTANT: the gate uses CLIP image embeddings, NOT ArcFace/InsightFace.
Face-recognition models are trained on photographs and behave unreliably on
illustration -- they reject good frames and pass bad ones, which is worse than
no gate at all because it looks like it is working.

    python states.py --agent code-reviewer --base outputs/code-reviewer/candidates/cand-03-seed123.png
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from prompts import (
    STATES,
    appearance_for,
    build_prompt,
    build_state_prompt,
    derive_identity,
    load_appearances,
    build_style_prompt,
    load_style,
    resolve_palette,
    negative_prompt,
    parse_agent_file,
)
from generate import (
    AGENTS_DIR,
    APPEARANCES_FILE,
    PORTRAITS_ROOT,
    BASE_MODEL,
    LIGHTNING_GUIDANCE,
    LIGHTNING_LORA,
    LIGHTNING_REPO,
    agent_seed,
)

CLIP_MODEL = "openai/clip-vit-base-patch32"

# Low enough to keep the face, high enough to change the expression. Below ~0.3
# the state barely reads; above ~0.55 it drifts into a different character.
DEFAULT_DENOISE = 0.45
IDENTITY_THRESHOLD = 0.86
MAX_RETRIES = 4
EXPORT_SIZES = (256, 128)


def load_img2img(offline: bool = False, lightning: bool = False):
    """Default is PLAIN SDXL, not Lightning.

    Measured on the base busts: Lightning dropped most of the description --
    'red hair' 0/4, 'big glasses' 1/4 -- while plain SDXL landed 3/4 and 4/4 on
    the same prompts and seeds. The states have to hold the same face, so
    adherence matters here more than anywhere.
    """
    import torch
    from diffusers import StableDiffusionXLImg2ImgPipeline, EulerDiscreteScheduler

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is not available; the forge needs the GPU.")

    pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        local_files_only=offline,
    )
    if lightning:
        pipe.load_lora_weights(LIGHTNING_REPO, weight_name=LIGHTNING_LORA)
        pipe.fuse_lora()
        pipe.scheduler = EulerDiscreteScheduler.from_config(
            pipe.scheduler.config, timestep_spacing="trailing"
        )
    pipe.enable_model_cpu_offload()
    # See generate.py: diffusers 0.40 moved this onto the VAE.
    if hasattr(pipe.vae, "enable_slicing"):
        pipe.vae.enable_slicing()
    elif hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    pipe.set_progress_bar_config(disable=True)
    return pipe


class IdentityGate:
    """Cosine similarity of CLIP image embeddings against the chosen base."""

    def __init__(self, offline: bool = False):
        import torch
        from transformers import CLIPModel, CLIPProcessor

        self.torch = torch
        self.model = CLIPModel.from_pretrained(CLIP_MODEL, local_files_only=offline).eval()
        self.processor = CLIPProcessor.from_pretrained(CLIP_MODEL, local_files_only=offline)

    def embed(self, image):
        inputs = self.processor(images=image, return_tensors="pt")
        with self.torch.no_grad():
            feats = self.model.get_image_features(**inputs)

        # transformers 5.x returns BaseModelOutputWithPooling here where 4.x
        # returned the tensor directly. Handle both rather than pinning: the
        # 4.x form raised AttributeError immediately, which is the good case --
        # silently embedding the wrong thing would give a gate that returns
        # plausible numbers and discriminates nothing.
        if not hasattr(feats, "norm"):
            for attr in ("image_embeds", "pooler_output"):
                if hasattr(feats, attr):
                    feats = getattr(feats, attr)
                    break
            else:
                raise TypeError(f"cannot get an embedding tensor from {type(feats).__name__}")

        return feats / feats.norm(dim=-1, keepdim=True)

    def similarity(self, a, b) -> float:
        return float((self.embed(a) @ self.embed(b).T).item())


def post_process(image, out_dir: Path, state: str) -> list[Path]:
    """NOTE: writes the final asset FLAT as <agent>/<state>.png.

    The harness looks it up at portraits/<agent>/<state>.png, per the design's
    convention-over-configuration rule. An earlier version wrote
    <agent>/states/<state>.png, so every generated portrait was invisible to the
    GUI and every agent silently fell back to a placeholder -- while the unit
    tests passed, because their fixtures built the layout the reader expected
    rather than the one the writer produced.
    """
    """Square crop, background removed to alpha, exported at display sizes.

    Alpha matters: portraits sit on the project's theme colour, so a baked-in
    background would fight every theme but the one it was generated against.
    """
    from PIL import Image

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

    written = []
    # Final assets go one level up, beside the agent folder, not inside states/.
    asset_dir = out_dir.parent if out_dir.name == "states" else out_dir
    asset_dir.mkdir(parents=True, exist_ok=True)
    for size in EXPORT_SIZES:
        path = asset_dir / (f"{state}.png" if size == EXPORT_SIZES[0] else f"{state}@{size}.png")
        square.resize((size, size), Image.LANCZOS).save(path)
        written.append(path)
    return written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--base", required=True, help="chosen candidate PNG")
    ap.add_argument("--out", default=str(PORTRAITS_ROOT))
    ap.add_argument("--denoise", type=float, default=DEFAULT_DENOISE)
    ap.add_argument("--threshold", type=float, default=IDENTITY_THRESHOLD)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--lightning", action="store_true", help="few-step LoRA (worse adherence)")
    ap.add_argument("--guidance", type=float, default=6.0)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--mode", choices=["img2img", "txt2img"], default="img2img",
                    help="img2img edits the base (holds identity, but also holds the MOUTH: "
                         "measured neutral at denoise 0.45 and 0.62). txt2img regenerates each "
                         "state from the same seed + description, so expression is unconstrained "
                         "and identity rests on seed and wording instead.")
    ap.add_argument("--describe-appearance", action="store_true",
                    help="restate the full appearance in the state prompt (measured WORSE: "
                         "the description drowns the expression cue and every state comes "
                         "out neutral)")
    args = ap.parse_args()

    import torch
    from PIL import Image

    appearances = load_appearances(APPEARANCES_FILE)
    style = load_style(APPEARANCES_FILE)
    identity = appearance_for(
        derive_identity(parse_agent_file(AGENTS_DIR / f"{args.agent}.md")), appearances
    )
    base_image = Image.open(args.base).convert("RGB")

    if args.mode == "txt2img":
        from generate import load_pipeline
        pipe = load_pipeline(offline=args.offline, lightning=args.lightning)
    else:
        pipe = load_img2img(offline=args.offline, lightning=args.lightning)
    gate = IdentityGate(offline=args.offline)

    out_dir = Path(args.out) / args.agent / "states"
    out_dir.mkdir(parents=True, exist_ok=True)
    rejects = out_dir / "rejected"

    report = {}
    for state in STATES:
        # txt2img has no base image to carry identity, so the full appearance
        # is required there; img2img already has the face and only needs the
        # expression.
        prompt = (build_prompt(identity, state, style=style)
                  if (args.describe_appearance or args.mode == "txt2img")
                  else build_state_prompt(identity, state))
        style_prompt = build_style_prompt(style, resolve_palette(identity))
        seed = agent_seed(identity["agent"]) + STATES.index(state) * 1000

        for attempt in range(MAX_RETRIES):
            shared = dict(
                prompt=prompt,
                prompt_2=style_prompt,
                negative_prompt=negative_prompt(),
                negative_prompt_2=negative_prompt(),
                num_inference_steps=args.steps,
                guidance_scale=args.guidance,
                generator=torch.Generator(device="cpu").manual_seed(seed + attempt * 77),
            )
            if args.mode == "txt2img":
                # PER-STATE seed. An earlier run shared one seed across all four
                # states, reasoning that a common noise field would hold the
                # character together. It did -- so completely that all four came
                # out as the same image (identity 0.982-0.996) and no expression
                # could get through. Identity comes from the written appearance,
                # which reproduces reliably on its own; the seed only needs to
                # stop the four being identical.
                shared["generator"] = torch.Generator(device="cpu").manual_seed(
                    seed + attempt * 77)
                shared["width"] = 1024
                shared["height"] = 1024
            else:
                shared["image"] = base_image
                shared["strength"] = args.denoise

            image = pipe(**shared).images[0]
            score = gate.similarity(base_image, image)
            if score >= args.threshold:
                written = post_process(image, out_dir, state)
                report[state] = {"score": round(score, 4), "attempts": attempt + 1,
                                 "files": [p.name for p in written]}
                print(f"  {state:9} kept   similarity={score:.3f} (attempt {attempt + 1})")
                break

            rejects.mkdir(parents=True, exist_ok=True)
            image.save(rejects / f"{state}-try{attempt}-{score:.3f}.png")
            print(f"  {state:9} reject similarity={score:.3f} (attempt {attempt + 1})")
        else:
            report[state] = {"score": None, "attempts": MAX_RETRIES, "files": []}
            print(f"  {state:9} FAILED after {MAX_RETRIES} attempts")

    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nstates written to {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
