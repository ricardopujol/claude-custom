"""States via IP-Adapter + ControlNet depth — the approach the design specified.

Separate from states.py on purpose. That script does img2img, which entangles
identity, framing and expression in a single `strength` dial: turn it down and
nothing changes, turn it up and you lose the person. Measured at 0.45 and 0.62,
both gave four identical neutral faces while identity scored 0.947-0.972. The
high score IS the problem, not evidence against it.

This splits the three concerns onto three different mechanisms:

    identity    <- IP-Adapter, from the chosen base bust
    framing     <- ControlNet depth map, locked from that same base
    expression  <- the text prompt, now competing with nothing

The face model (ip-adapter-plus-face) is used rather than the general one: it is
trained on faces and holds identity markedly better, which is the whole job.

    python states_ip.py --agent code-reviewer --base <chosen.png>
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from prompts import (
    STATES,
    appearance_for,
    build_state_prompt,
    build_style_prompt,
    derive_identity,
    load_appearances,
    load_style,
    negative_prompt,
    parse_agent_file,
    resolve_palette,
)
from generate import AGENTS_DIR, APPEARANCES_FILE, BASE_MODEL, PORTRAITS_ROOT, agent_seed
from states import IdentityGate, post_process

CONTROLNET = "diffusers/controlnet-depth-sdxl-1.0-small"
DEPTH_MODEL = "Intel/dpt-hybrid-midas"
IP_REPO = "h94/IP-Adapter"
IP_SUBFOLDER = "sdxl_models"
IP_WEIGHTS = "ip-adapter-plus-face_sdxl_vit-h.safetensors"

# How hard IP-Adapter pins the face. Too high and it reimposes the original
# expression along with the identity, which is the exact failure this is meant
# to avoid; too low and it stops being the same character.
DEFAULT_IP_SCALE = 0.65
# How hard the depth map pins framing. Lower than IP scale on purpose -- it only
# needs head size and angle, not fine structure.
DEFAULT_CONTROL_SCALE = 0.5


def depth_map(image, offline: bool = False):
    """Depth from the chosen base, so every state shares its framing."""
    import torch
    from transformers import DPTForDepthEstimation, DPTImageProcessor
    from PIL import Image

    processor = DPTImageProcessor.from_pretrained(DEPTH_MODEL, local_files_only=offline)
    model = DPTForDepthEstimation.from_pretrained(DEPTH_MODEL, local_files_only=offline).eval()

    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        predicted = model(**inputs).predicted_depth

    depth = torch.nn.functional.interpolate(
        predicted.unsqueeze(1), size=image.size[::-1], mode="bicubic", align_corners=False
    )
    depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-8)
    array = (depth.squeeze().cpu().numpy() * 255).astype("uint8")
    return Image.fromarray(array).convert("RGB")


def load_pipeline(offline: bool = False):
    import torch
    from diffusers import ControlNetModel, StableDiffusionXLControlNetPipeline

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is not available; the forge needs the GPU.")

    from transformers import CLIPVisionModelWithProjection

    controlnet = ControlNetModel.from_pretrained(
        CONTROLNET, torch_dtype=torch.float16, local_files_only=offline
    )

    # The _vit-h weights need the ViT-H encoder (1664-dim), not the bigG one
    # (1280-dim) that sits beside them in sdxl_models/. Loaded explicitly and
    # handed to the pipeline: passing image_encoder_folder="../models/..." is
    # the documented shortcut but transformers rejects any path containing
    # '..'. Getting this wrong fails deep in the forward pass with
    #   mat1 and mat2 shapes cannot be multiplied (514x1664 and 1280x1280)
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        IP_REPO,
        subfolder="models/image_encoder",
        torch_dtype=torch.float16,
        local_files_only=offline,
    )

    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        BASE_MODEL,
        controlnet=controlnet,
        image_encoder=image_encoder,
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        local_files_only=offline,
    )
    # image_encoder_folder is REQUIRED for the _vit-h weights. Without it
    # diffusers loads the bigG encoder sitting next to them in sdxl_models/ and
    # fails deep inside the forward pass with
    #   mat1 and mat2 shapes cannot be multiplied (514x1664 and 1280x1280)
    # -- 1664 is ViT-H, 1280 is bigG. The path is relative to `subfolder`.
    # Encoder already supplied above, so tell load_ip_adapter not to look for one.
    pipe.load_ip_adapter(
        IP_REPO, subfolder=IP_SUBFOLDER, weight_name=IP_WEIGHTS, image_encoder_folder=None
    )

    pipe.enable_model_cpu_offload()
    if hasattr(pipe.vae, "enable_slicing"):
        pipe.vae.enable_slicing()
    pipe.set_progress_bar_config(disable=True)
    return pipe


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", default=str(PORTRAITS_ROOT / "_ipadapter"))
    ap.add_argument("--ip-scale", type=float, default=DEFAULT_IP_SCALE)
    ap.add_argument("--control-scale", type=float, default=DEFAULT_CONTROL_SCALE)
    ap.add_argument("--threshold", type=float, default=0.80)
    ap.add_argument("--guidance", type=float, default=6.0)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    import torch
    from PIL import Image

    looks = load_appearances(APPEARANCES_FILE)
    style = load_style(APPEARANCES_FILE)
    identity = appearance_for(
        derive_identity(parse_agent_file(AGENTS_DIR / f"{args.agent}.md")), looks
    )
    base_image = Image.open(args.base).convert("RGB")

    print("computing depth map from the chosen base ...", flush=True)
    control = depth_map(base_image, offline=args.offline)

    pipe = load_pipeline(offline=args.offline)
    pipe.set_ip_adapter_scale(args.ip_scale)
    gate = IdentityGate(offline=args.offline)

    out_dir = Path(args.out) / args.agent / "states"
    out_dir.mkdir(parents=True, exist_ok=True)
    control.save(out_dir / "_depth.png")

    style_prompt = build_style_prompt(style, resolve_palette(identity))
    report = {}

    for state in STATES:
        # Expression ONLY. Identity is IP-Adapter's job and framing is
        # ControlNet's; restating the appearance here would put the description
        # back in competition with the expression cue.
        prompt = build_state_prompt(identity, state)
        seed = agent_seed(identity["agent"]) + STATES.index(state) * 1000

        for attempt in range(4):
            image = pipe(
                prompt=prompt,
                prompt_2=style_prompt,
                negative_prompt=negative_prompt(),
                negative_prompt_2=negative_prompt(),
                image=control,
                ip_adapter_image=base_image,
                controlnet_conditioning_scale=args.control_scale,
                num_inference_steps=args.steps,
                guidance_scale=args.guidance,
                generator=torch.Generator(device="cpu").manual_seed(seed + attempt * 77),
            ).images[0]

            score = gate.similarity(base_image, image)
            if score >= args.threshold:
                post_process(image, out_dir, state)
                report[state] = {"score": round(score, 4), "attempts": attempt + 1}
                print(f"  {state:9} kept   similarity={score:.3f} (attempt {attempt + 1})", flush=True)
                break

            rejects = out_dir / "rejected"
            rejects.mkdir(parents=True, exist_ok=True)
            image.save(rejects / f"{state}-try{attempt}-{score:.3f}.png")
            print(f"  {state:9} reject similarity={score:.3f} (attempt {attempt + 1})", flush=True)
        else:
            report[state] = {"score": None, "attempts": 4}
            print(f"  {state:9} FAILED", flush=True)

    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nstates written to {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
