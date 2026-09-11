"""Base bust generation for agent portraits.

Constrained by 8 GB of VRAM (RTX 4070 Laptop), which rules out comfortable Flux
and makes SDXL viable only with fp16 plus model CPU offload. A distilled
checkpoint (SDXL-Lightning, 4-8 steps) is used because 3-second iterations
change how much exploration actually happens -- at 40s/image nobody explores.

This produces CANDIDATES. Picking one base bust per agent is the single
mandatory human step in the pipeline and the real time cost; everything
downstream (the four states) is conditioned on that choice.

    python generate.py --agents code-reviewer logic-reviewer --candidates 8
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from prompts import (
    appearance_for,
    build_prompt,
    derive_identity,
    load_appearances,
    build_style_prompt,
    load_style,
    negative_prompt,
    parse_agent_file,
)

AGENTS_DIR = Path(r"C:\Users\ricar\.claude\agents")

# Portraits and their hand-written appearances live WITH the agents, in the
# agent-creator repo -- not in claude-custom. They are a property of the agent
# roster, which more than one project consumes.
PORTRAITS_ROOT = Path(r"C:\Users\ricar\VibeCode\agent-creator\portraits")
APPEARANCES_FILE = PORTRAITS_ROOT / "appearances.yaml"
BASE_MODEL = "stabilityai/stable-diffusion-xl-base-1.0"
LIGHTNING_REPO = "ByteDance/SDXL-Lightning"
LIGHTNING_LORA = "sdxl_lightning_8step_lora.safetensors"
LIGHTNING_STEPS = 8
# Lightning is distilled for near-1.0 guidance; the usual 7.5 burns the image.
LIGHTNING_GUIDANCE = 1.5


def load_pipeline(offline: bool = False):
    import torch
    from diffusers import StableDiffusionXLPipeline, EulerDiscreteScheduler

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is not available; the forge needs the GPU.")

    pipe = StableDiffusionXLPipeline.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        local_files_only=offline,
    )

    pipe.load_lora_weights(LIGHTNING_REPO, weight_name=LIGHTNING_LORA)
    pipe.fuse_lora()

    # Lightning requires the trailing-timestep spacing; without it the few-step
    # schedule is wrong and output is mush.
    pipe.scheduler = EulerDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="trailing"
    )

    # 8 GB will not hold the whole pipeline resident alongside activations.
    # Offload moves each submodule to the GPU only while it runs.
    pipe.enable_model_cpu_offload()
    # diffusers 0.40 removed pipe.enable_vae_slicing(); it lives on the VAE now.
    # Guarded both ways so a version bump in either direction does not take the
    # whole run down after the model has already loaded.
    if hasattr(pipe.vae, "enable_slicing"):
        pipe.vae.enable_slicing()
    elif hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    pipe.set_progress_bar_config(disable=True)
    return pipe


def agent_seed(agent: str) -> int:
    """Stable per-agent seed, so a rerun reproduces the same candidate set."""
    h = 2166136261
    for ch in agent:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def generate_candidates(pipe, identity: dict, count: int, out_dir: Path, steps: int, style: dict | None = None) -> list[Path]:
    import torch

    prompt = build_prompt(identity, "working", style=style)
    style_prompt = build_style_prompt(style)
    negative = negative_prompt()
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "prompt.json").write_text(
        json.dumps({"identity": identity, "prompt": prompt, "prompt_2": style_prompt,
                    "negative": negative}, indent=2),
        encoding="utf-8",
    )

    base = agent_seed(identity["agent"])
    written = []
    for i in range(count):
        seed = base + i
        image = pipe(
            prompt=prompt,
            # Second text encoder carries the shared art direction, so a long
            # appearance can never truncate it.
            prompt_2=style_prompt,
            negative_prompt=negative,
            negative_prompt_2=negative,
            num_inference_steps=steps,
            guidance_scale=LIGHTNING_GUIDANCE,
            width=1024,
            height=1024,
            generator=torch.Generator(device="cpu").manual_seed(seed),
        ).images[0]

        path = out_dir / f"cand-{i:02d}-seed{seed}.png"
        image.save(path)
        written.append(path)
        print(f"    {path.name}", flush=True)

    return written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", nargs="+", required=True)
    ap.add_argument("--candidates", type=int, default=8)
    ap.add_argument("--steps", type=int, default=LIGHTNING_STEPS)
    ap.add_argument("--out", default=str(PORTRAITS_ROOT))
    ap.add_argument("--offline", action="store_true", help="fail rather than download")
    args = ap.parse_args()

    appearances = load_appearances(APPEARANCES_FILE)
    style = load_style(APPEARANCES_FILE)
    print(f"hand-written appearances: {len(appearances)}", flush=True)
    print(f"art direction: {style['art']}", flush=True)

    identities = []
    for name in args.agents:
        path = AGENTS_DIR / f"{name}.md"
        if not path.exists():
            print(f"no such agent: {path}", file=sys.stderr)
            return 2
        identities.append(appearance_for(derive_identity(parse_agent_file(path)), appearances))

    print("loading pipeline (first run downloads ~7 GB)...", flush=True)
    pipe = load_pipeline(offline=args.offline)

    out_root = Path(args.out)
    for identity in identities:
        source = "hand-written" if identity.get("appearance") else "derived from role"
        print(f"\n{identity['agent']} ({identity['person'] or 'unnamed'}) [{source}]", flush=True)
        print(f"  {build_prompt(identity, 'working', style=style)[:120]}...", flush=True)
        generate_candidates(
            pipe, identity, args.candidates, out_root / identity["agent"] / "candidates", args.steps, style
        )

    print(f"\ncandidates written under {out_root.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
