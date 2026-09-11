"""Pre-fetch IP-Adapter + ControlNet so downloads overlap with other work.

Left to diffusers these download lazily on first use, which serialises a ~4 GB
fetch in front of the run you are waiting on.

Face variant of IP-Adapter on purpose: ip-adapter-plus-face is trained on faces
and holds identity far better than the general model, which is the entire job
here. It needs the ViT-H image encoder, which is the bulk of the download.

ControlNet depth is the SMALL variant: ~700 MB rather than ~2.5 GB, and it only
has to pin head size and angle, not reproduce fine structure.
"""

from __future__ import annotations

from huggingface_hub import hf_hub_download, snapshot_download

JOBS = [
    ("IP-Adapter face weights", lambda: hf_hub_download(
        "h94/IP-Adapter", "sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors")),
    ("IP-Adapter image encoder (ViT-H)", lambda: snapshot_download(
        "h94/IP-Adapter", allow_patterns=["models/image_encoder/*"])),
    ("ControlNet depth (small)", lambda: snapshot_download(
        "diffusers/controlnet-depth-sdxl-1.0-small")),
    ("depth estimator (DPT hybrid)", lambda: snapshot_download(
        "Intel/dpt-hybrid-midas", allow_patterns=["*.json", "*.safetensors", "*.bin", "*.txt"])),
]


def main() -> int:
    for label, job in JOBS:
        print(f"fetching {label} ...", flush=True)
        try:
            path = job()
            print(f"  ok  {path}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED {label}: {type(exc).__name__}: {exc}", flush=True)
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
