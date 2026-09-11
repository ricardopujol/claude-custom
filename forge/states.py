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

from prompts import STATES, build_prompt, derive_identity, negative_prompt, parse_agent_file
from generate import (
    AGENTS_DIR,
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


def load_img2img(offline: bool = False):
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
    pipe.load_lora_weights(LIGHTNING_REPO, weight_name=LIGHTNING_LORA)
    pipe.fuse_lora()
    pipe.scheduler = EulerDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="trailing"
    )
    pipe.enable_model_cpu_offload()
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
        return feats / feats.norm(dim=-1, keepdim=True)

    def similarity(self, a, b) -> float:
        return float((self.embed(a) @ self.embed(b).T).item())


def post_process(image, out_dir: Path, state: str) -> list[Path]:
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
    for size in EXPORT_SIZES:
        path = out_dir / (f"{state}.png" if size == EXPORT_SIZES[0] else f"{state}@{size}.png")
        square.resize((size, size), Image.LANCZOS).save(path)
        written.append(path)
    return written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--base", required=True, help="chosen candidate PNG")
    ap.add_argument("--out", default="outputs")
    ap.add_argument("--denoise", type=float, default=DEFAULT_DENOISE)
    ap.add_argument("--threshold", type=float, default=IDENTITY_THRESHOLD)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    import torch
    from PIL import Image

    identity = derive_identity(parse_agent_file(AGENTS_DIR / f"{args.agent}.md"))
    base_image = Image.open(args.base).convert("RGB")

    pipe = load_img2img(offline=args.offline)
    gate = IdentityGate(offline=args.offline)

    out_dir = Path(args.out) / args.agent / "states"
    out_dir.mkdir(parents=True, exist_ok=True)
    rejects = out_dir / "rejected"

    report = {}
    for state in STATES:
        prompt = build_prompt(identity, state)
        seed = agent_seed(identity["agent"]) + STATES.index(state) * 1000

        for attempt in range(MAX_RETRIES):
            image = pipe(
                prompt=prompt,
                negative_prompt=negative_prompt(),
                image=base_image,
                strength=args.denoise,
                num_inference_steps=max(8, int(8 / max(args.denoise, 0.1))),
                guidance_scale=LIGHTNING_GUIDANCE,
                generator=torch.Generator(device="cpu").manual_seed(seed + attempt * 77),
            ).images[0]

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
