"""Score candidate busts against the appearance someone actually wrote.

Picking a base is the pipeline's one mandatory human step, and it should stay
that way -- a person looking at four faces makes a better call than a number.
This exists for the case where nobody has looked yet and the roster is sitting
empty: it puts a defensible base in place so portraits EXIST, and prints what
it chose so it can be overridden with one command.

The score is CLIP text-image similarity against the hand-written appearance
only -- not the art direction, which is identical for every candidate and would
just add a constant.

    python pick.py --agents mutation-tester ui-ux-tester
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from PIL import Image

from generate import AGENTS_DIR, APPEARANCES_FILE, PORTRAITS_ROOT
from prompts import (appearance_for, derive_identity, load_appearances,
                     parse_agent_file)

CLIP_MODEL = "openai/clip-vit-base-patch32"


def score_candidates(agent: str, portraits_root: Path, appearances: dict):
    md = AGENTS_DIR / f"{agent}.md"
    if not md.exists():
        return []
    merged = appearance_for(derive_identity(parse_agent_file(md)), appearances)
    text = merged.get("appearance") or merged.get("role") or agent
    cand_dir = portraits_root / agent / "candidates"
    pngs = sorted(p for p in cand_dir.glob("*.png") if "@" not in p.name)
    if not pngs:
        return []

    from transformers import CLIPModel, CLIPProcessor
    model = CLIPModel.from_pretrained(CLIP_MODEL)
    proc = CLIPProcessor.from_pretrained(CLIP_MODEL)
    images = [Image.open(p).convert("RGB") for p in pngs]
    inputs = proc(text=[text], images=images, return_tensors="pt",
                  padding=True, truncation=True)
    with torch.no_grad():
        out = model(**inputs)
    # logits_per_image is (n_images, n_texts); one text, so take column 0.
    scores = out.logits_per_image[:, 0].tolist()
    return sorted(zip(pngs, scores), key=lambda t: t[1], reverse=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", nargs="+", required=True)
    ap.add_argument("--out", default=str(PORTRAITS_ROOT))
    args = ap.parse_args()

    appearances = load_appearances(Path(APPEARANCES_FILE))
    root = Path(args.out)
    for agent in args.agents:
        ranked = score_candidates(agent, root, appearances)
        if not ranked:
            print(f"{agent}: no candidates")
            continue
        best, best_score = ranked[0]
        for p, s in ranked:
            mark = "<-" if p == best else "  "
            print(f"  {s:6.2f} {p.name} {mark}")
        print(f"{agent}: {best.name}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
