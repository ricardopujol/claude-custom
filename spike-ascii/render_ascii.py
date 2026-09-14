"""ASCII / Unicode-glyph icon pipeline for the claude-custom spike.

Runs end to end:
  1. draw four procedural source PNGs (silhouette-first, deterministic)
  2. MEASURE the two knobs that decide quality at this size -- downsample filter
     and threshold rule -- instead of picking them by feel
  3. render the full technique x grid x colour matrix with the winners
  4. self-verify the grid is rigid and escape-free
  5. write .harness/ascii/generated.json

Output is HTML-bound: strings and hex, never ANSI. Nothing here emits \\x1b, and
step 4 asserts that rather than trusting it.

    py -3.14 spike-ascii/render_ascii.py
"""

import json
import pathlib
import sys
import time
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import numpy as np           # noqa: E402
from PIL import Image        # noqa: E402

import convert               # noqa: E402
import fontsupport           # noqa: E402
import glyphs                # noqa: E402
import sources               # noqa: E402

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
OUT = ROOT / ".harness" / "ascii" / "generated.json"

GRIDS = [(4, 2), (6, 3), (8, 4), (12, 6), (16, 8)]
COLORS = ["mono", "accent", "duotone", "truecolor"]
BINARY = [t for t, s in glyphs.TECHNIQUES.items() if s["binary"]]
RAMPED = [t for t, s in glyphs.TECHNIQUES.items() if not s["binary"]]

# Candidates for the two knobs. NEAREST is in the filter list precisely because
# it is expected to lose -- an expected loser that wins is the only way to find
# out the metric is wrong.
FILTER_CANDIDATES = ["lanczos", "box", "bilinear", "nearest"]
THRESHOLD_CANDIDATES = list(convert.THRESHOLDS)


def dot_dims(technique, cols, rows):
    dx, dy = glyphs.TECHNIQUES[technique]["dots"]
    return cols * dx, rows * dy


# ------------------------------------------------------------- experiment ---

def run_experiment(images):
    """Every (filter, threshold) pair over every binary technique and grid.

    Two scores, deliberately not combined into one:
      iou     -- silhouette agreement with the source. What you read at 34px.
      cov_err -- tonal error against an exact area average. What a dither optimises.
    They disagree, and the disagreement is the finding.
    """
    results = {}
    for filt in FILTER_CANDIDATES:
        for thr in THRESHOLD_CANDIDATES:
            ious, errs, tones, per_grid = [], [], [], {}
            for subject, img in images.items():
                for technique in BINARY:
                    for cols, rows in GRIDS:
                        w, h = dot_dims(technique, cols, rows)
                        cov = convert.coverage(img, w, h, filt)
                        bits = convert.binarize(cov, thr)
                        ious.append(convert.silhouette_iou(bits, img))
                        errs.append(convert.coverage_error(bits, img))
                        tones.append(convert.tone_error(bits, img))
                        per_grid.setdefault((cols, rows), []).append(ious[-1])
            results[(filt, thr)] = {
                "iou": float(np.mean(ious)),
                "cov_err": float(np.mean(errs)),
                "tone_err": float(np.mean(tones)),
                "per_grid": {g: float(np.mean(v)) for g, v in per_grid.items()},
            }
    return results


def report_experiment(results):
    print("\n=== KNOB EXPERIMENT: downsample filter x threshold rule ===")
    print("   (mean over 4 subjects x 4 binary techniques x 5 grids = 80 renders each)")
    print("   IoU higher is better; both errors lower is better.")
    print(f"{'filter':10s} {'threshold':10s} {'IoU':>8s} {'cov_err':>9s} {'tone_err':>9s}   "
          + "  ".join(f"{c}x{r:<2d}" for c, r in GRIDS))
    ordered = sorted(results.items(), key=lambda kv: -kv[1]["iou"])
    for (filt, thr), r in ordered:
        grids = "  ".join(f"{r['per_grid'][g]:.3f}" for g in GRIDS)
        print(f"{filt:10s} {thr:10s} {r['iou']:8.4f} {r['cov_err']:9.4f} "
              f"{r['tone_err']:9.4f}   {grids}")

    best_iou = ordered[0][0]
    best_err = min(results.items(), key=lambda kv: kv[1]["cov_err"])[0]
    best_tone = min(results.items(), key=lambda kv: kv[1]["tone_err"])[0]
    for name, key in (("IoU (silhouette)", best_iou), ("cov_err (per dot)", best_err),
                      ("tone_err (local mean)", best_tone)):
        r = results[key]
        print(f"best by {name:22s}: {key[0]:9s} + {key[1]:9s}  "
              f"IoU {r['iou']:.4f}  cov {r['cov_err']:.4f}  tone {r['tone_err']:.4f}")

    spread = max(r["iou"] for r in results.values()) - min(r["iou"] for r in results.values())
    print(f"\ntotal IoU spread across all 16 knob settings: {spread:.4f} "
          f"({spread / results[best_iou]['iou'] * 100:.1f}% of the best score)")

    print("\n--- per-grid winner by IoU (does the right knob change with size?) ---")
    for g in GRIDS:
        win = max(results.items(), key=lambda kv: kv[1]["per_grid"][g])
        print(f"  {g[0]:2d}x{g[1]:<2d}  {win[0][0]:9s} + {win[0][1]:9s}  "
              f"IoU {win[1]['per_grid'][g]:.4f}")
    return best_iou


def report_per_technique(images, filt, thr):
    print(f"\n--- IoU by technique and grid, using {filt} + {thr} ---")
    print(f"{'technique':10s} " + "  ".join(f"{c:2d}x{r:<3d}" for c, r in GRIDS))
    for technique in BINARY:
        cells = []
        for cols, rows in GRIDS:
            vals = []
            for img in images.values():
                w, h = dot_dims(technique, cols, rows)
                bits = convert.binarize(convert.coverage(img, w, h, filt), thr)
                vals.append(convert.silhouette_iou(bits, img))
            cells.append(f"{np.mean(vals):.3f}")
        print(f"{technique:10s} " + "  ".join(f"{c:>6s}" for c in cells))


def report_confusion(images, filt, thr):
    """The measurement that says where the technique dies.

    IoU against the source only asks "is this a faithful shrink of the sword".
    An icon has a harder job: it must not look like the OTHER icons. So this
    compares each subject's dot pattern against every other subject's, and a
    high number is a failure -- two different items rendering as one smudge.
    """
    print(f"\n--- SUBJECT CONFUSION: mean pairwise dot overlap between DIFFERENT "
          f"subjects\n    ({filt} + {thr}; HIGH IS BAD -- 1.00 means two icons are "
          f"identical) ---")
    names = list(images)
    print(f"{'technique':10s} " + "  ".join(f"{c:2d}x{r:<3d}" for c, r in GRIDS))
    for technique in BINARY:
        cells = []
        for cols, rows in GRIDS:
            w, h = dot_dims(technique, cols, rows)
            maps = {n: convert.binarize(convert.coverage(images[n], w, h, filt), thr)
                    for n in names}
            sims = [convert.dot_similarity(maps[names[i]], maps[names[j]])
                    for i in range(len(names)) for j in range(i + 1, len(names))]
            cells.append(f"{np.mean(sims):.3f}")
        print(f"{technique:10s} " + "  ".join(f"{c:>6s}" for c in cells))

    print("\n  worst confused pair per grid (braille):")
    for cols, rows in GRIDS:
        w, h = dot_dims("braille", cols, rows)
        maps = {n: convert.binarize(convert.coverage(images[n], w, h, filt), thr)
                for n in names}
        pairs = [((names[i], names[j]),
                  convert.dot_similarity(maps[names[i]], maps[names[j]]))
                 for i in range(len(names)) for j in range(i + 1, len(names))]
        (a, b), v = max(pairs, key=lambda kv: kv[1])
        print(f"    {cols:2d}x{rows:<2d}  {a} vs {b}: {v:.3f}")


def report_ramp_filters(images):
    """For the one-sample-per-cell techniques there is no threshold, and BOX is
    provably optimal -- it IS the area mean the ramp is trying to encode. Shown
    rather than argued, so the number is on record."""
    print("\n--- ramp techniques: tonal error vs exact area average (lower better) ---")
    print(f"{'filter':10s} {'shade':>9s} {'ascii':>9s}")
    for filt in FILTER_CANDIDATES:
        row = []
        for technique in RAMPED:
            levels = len(glyphs.TECHNIQUES[technique]["ramp"])
            errs = []
            for img in images.values():
                for cols, rows in GRIDS:
                    cov = convert.coverage(img, cols, rows, filt)
                    ref = convert.coverage(img, cols, rows, "box")
                    q = convert.quantize(cov, levels) / (levels - 1)
                    errs.append(float(np.abs(q - ref).mean()))
            row.append(f"{np.mean(errs):9.4f}")
        print(f"{filt:10s} " + " ".join(row))


# ----------------------------------------------------------------- render ---

def render(img, subject, technique, cols, rows, color, filt, thr):
    spec = glyphs.TECHNIQUES[technique]
    if spec["binary"]:
        w, h = dot_dims(technique, cols, rows)
        cov = convert.coverage(img, w, h, filt)
        bits = convert.binarize(cov, thr)
        lines = glyphs.pack(technique, bits.astype(int).tolist())
        note = f"{filt} downsample, {thr} threshold, {w}x{h} dots"
    else:
        levels = len(spec["ramp"])
        cov = convert.coverage(img, cols, rows, "box")
        lines = glyphs.pack_ramp(technique, convert.quantize(cov, levels).tolist())
        note = f"box downsample (exact area mean), {levels}-level ramp"

    fg = convert.foreground(img, cols, rows, color)
    if color == "truecolor":
        note += f"; per-cell colour lifted to luma >= {convert.MIN_LUMA}"
    elif color == "duotone":
        note += "; cells snapped to --text / --accent by luminance"
    elif color == "accent":
        note += "; glyphs identical to the mono render, constant --accent fg"

    return {
        "id": f"{subject}__{technique}__{cols}x{rows}__{color}",
        "subject": subject,
        "technique": technique,
        "source": "procedural",
        "cols": cols,
        "rows": rows,
        "color": color,
        "lines": lines,
        "fg": fg,
        "note": note,
    }


# ------------------------------------------------------------ self-verify ---

def verify(renders):
    """Executed, not claimed. A ragged grid or a stray escape silently ruins the
    comparison sheet, and both are cheap to rule out here."""
    checked = 0
    for r in renders:
        rid = r["id"]
        assert len(r["lines"]) == r["rows"], f"{rid}: {len(r['lines'])} lines != {r['rows']} rows"
        for i, line in enumerate(r["lines"]):
            # len() on a str counts CODE POINTS in Python 3, which is the unit
            # the contract specifies -- not UTF-16 units.
            assert len(line) == r["cols"], f"{rid}: line {i} is {len(line)} cps != {r['cols']}"
            assert "\x1b" not in line, f"{rid}: line {i} contains an ANSI escape"
            assert set(line) <= glyphs.charset(r["technique"]), \
                f"{rid}: line {i} has characters outside the {r['technique']} charset"
            if r["technique"] == "braille":
                assert " " not in line, f"{rid}: line {i} uses U+0020 instead of U+2800"
            checked += 1
        if r["color"] == "mono":
            assert r["fg"] is None, f"{rid}: mono render carries a colour grid"
        else:
            assert r["fg"] is not None and len(r["fg"]) == r["rows"], f"{rid}: fg rows"
            for row in r["fg"]:
                assert len(row) == r["cols"], f"{rid}: fg row width"
                for hexv in row:
                    assert len(hexv) == 7 and hexv[0] == "#", f"{rid}: bad hex {hexv!r}"
                    int(hexv[1:], 16)
                    assert "\x1b" not in hexv
        assert "\x1b" not in r["note"] and "\x1b" not in r["id"]
    return checked


def preview(renders, wanted):
    print("\n=== PREVIEW (read these at arm's length -- that is the 34px test) ===")
    by_id = {r["id"]: r for r in renders}
    for rid in wanted:
        r = by_id[rid]
        print(f"\n{rid}  [{r['note']}]")
        for line in r["lines"]:
            print("    " + line)


# ------------------------------------------------------------------- main ---

def main():
    t0 = time.perf_counter()
    src_paths = sources.generate(HERE / "sources")
    images = {name: Image.open(p).convert("RGBA") for name, p in src_paths.items()}
    t_sources = time.perf_counter() - t0
    print(f"sources: {len(images)} PNGs in {t_sources * 1000:.0f} ms")
    for name, path in src_paths.items():
        print(f"  {name:8s} {path}")

    results = run_experiment(images)
    filt, thr = report_experiment(results)
    report_per_technique(images, filt, thr)
    report_confusion(images, filt, thr)
    report_ramp_filters(images)
    font_support = fontsupport.report(fontsupport.survey())

    print(f"\n=== RENDERING with {filt} + {thr} ===")
    renders, timings = [], []
    for subject, img in images.items():
        for technique in glyphs.TECHNIQUES:
            for cols, rows in GRIDS:
                for color in COLORS:
                    t = time.perf_counter()
                    renders.append(render(img, subject, technique, cols, rows,
                                          color, filt, thr))
                    timings.append(time.perf_counter() - t)
    total = sum(timings)
    print(f"{len(renders)} renders in {total * 1000:.0f} ms "
          f"(mean {total / len(renders) * 1000:.2f} ms, "
          f"max {max(timings) * 1000:.2f} ms, min {min(timings) * 1000:.3f} ms)")

    slow = sorted(zip(timings, (r["id"] for r in renders)), reverse=True)[:5]
    print("slowest:")
    for dt, rid in slow:
        print(f"  {dt * 1000:6.2f} ms  {rid}")

    print("\n=== SELF-VERIFY ===")
    lines_checked = verify(renders)
    print(f"PASS  {len(renders)} renders, {lines_checked} lines")
    print("      every line count == rows; every line length == cols (code points)")
    print("      no \\x1b anywhere in lines, notes, ids or hex values")
    print("      braille cells use U+2800 for empty, never U+0020")
    print("      every character inside its technique's declared charset")
    print("      fg is null iff color == 'mono', else rows x cols of #rrggbb")

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": src_paths,
        "subjects": [
            {"id": k, "label": v["label"], "emoji": v["emoji"], "note": v["note"]}
            for k, v in sources.SUBJECTS.items()
        ],
        "renders": renders,
        "settings": {
            "downsampleFilter": filt,
            "threshold": thr,
            "grids": [f"{c}x{r}" for c, r in GRIDS],
            "colors": COLORS,
            "palette": {"text": convert.TEXT, "dim": convert.DIM,
                        "accent": convert.ACCENT, "bg": convert.BG},
            # Which techniques the machine can actually draw. A sheet that shows
            # sextants without saying no installed font has them is comparing
            # tofu against art.
            "fontSupport": font_support,
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nmanifest: {OUT.resolve()}  ({OUT.stat().st_size / 1024:.0f} KB)")

    preview(renders, [
        "sword__braille__4x2__mono", "sword__braille__8x4__mono",
        "sword__braille__16x8__mono", "sword__sextant__8x4__mono",
        "sword__quadrant__8x4__mono", "sword__halfblock__8x4__mono",
        "sword__shade__8x4__mono", "sword__ascii__8x4__mono",
        "potion__braille__4x2__mono", "potion__braille__8x4__mono",
        "potion__braille__16x8__mono",
        "spell__braille__4x2__mono", "spell__braille__8x4__mono",
        "spell__braille__16x8__mono",
        "bug__braille__4x2__mono", "bug__braille__8x4__mono",
        "bug__braille__12x6__mono", "bug__braille__16x8__mono",
        "bug__sextant__16x8__mono", "bug__ascii__16x8__mono",
    ])
    print(f"\ntotal wall clock: {(time.perf_counter() - t0) * 1000:.0f} ms")


if __name__ == "__main__":
    main()
