"""Procedural source art for the ASCII spike -- deterministic, CPU-only, Pillow.

There is no real art for these icons yet, and there deliberately isn't going to
be any for this spike. What matters at 34px is the SILHOUETTE, so every shape
here is drawn silhouette-first: thick limbs, no interior detail finer than the
smallest dot a 4x2 braille cell can represent, and a transparent background so
the alpha channel IS the coverage map the converter reads.

Drawn at 4x supersample and downsampled once with LANCZOS, then auto-cropped to
the alpha bounding box and re-padded square -- cropping matters more than it
sounds, because at an 8x8 dot budget a 10% margin throws away a fifth of the
information.
"""

from PIL import Image, ImageDraw

SIZE = 256
SS = 4                      # supersample factor for clean antialiased edges
MARGIN = 0.02               # re-pad margin after autocrop, as a fraction of side

# The harness palette, so the truecolor renders land in-theme rather than
# needing a correction pass later.
STEEL = (199, 206, 222, 255)      # --text  #c7cede
DIM = (109, 118, 137, 255)        # --dim   #6d7689
ACCENT = (208, 140, 74, 255)      # --accent #d08c4a
OK = (95, 176, 122, 255)          # --ok    #5fb07a
BAD = (204, 95, 95, 255)          # --bad   #cc5f5f
GLASS = (95, 176, 176, 255)       # cyan
ARCANE = (167, 124, 204, 255)     # magenta
DARK = (58, 63, 77, 255)


def _canvas():
    side = SIZE * SS
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img), side


def _finish(img):
    """Downsample, crop to the silhouette, re-pad square with a hair of margin."""
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    box = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if box:
        img = img.crop(box)
    side = max(img.size)
    pad = int(side * MARGIN)
    out = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    out.paste(img, ((out.width - img.width) // 2, (out.height - img.height) // 2))
    return out.resize((SIZE, SIZE), Image.LANCZOS)


def sword():
    img, d, s = _canvas()
    px = lambda f: int(f * s)

    # Blade: a tapered quad, tip at the top. Kept wide (17% of the side at the
    # shoulder) because a realistic blade width is sub-dot at every grid here.
    d.polygon([(px(0.50), px(0.03)),
               (px(0.585), px(0.22)),
               (px(0.585), px(0.615)),
               (px(0.415), px(0.615)),
               (px(0.415), px(0.22))], fill=STEEL)
    # Fuller: a darker stripe down the blade. Pure truecolor bait -- it is far
    # too fine to survive any of these grids, and saying so is part of the point.
    d.rectangle([px(0.483), px(0.14), px(0.517), px(0.60)], fill=DIM)
    # Crossguard, grip, pommel.
    d.rectangle([px(0.17), px(0.615), px(0.83), px(0.695)], fill=ACCENT)
    d.rectangle([px(0.448), px(0.695), px(0.552), px(0.875)], fill=DARK)
    d.ellipse([px(0.415), px(0.855), px(0.585), px(0.995)], fill=ACCENT)
    return _finish(img)


def potion():
    img, d, s = _canvas()
    px = lambda f: int(f * s)

    body = [px(0.155), px(0.395), px(0.845), px(0.985)]
    # Glass first, then the liquid painted through a mask so the fill line is
    # flat and the flask keeps its round bottom.
    d.polygon([(px(0.375), px(0.30)), (px(0.625), px(0.30)),
               (px(0.80), px(0.60)), (px(0.20), px(0.60))], fill=GLASS)
    d.ellipse(body, fill=GLASS)
    d.rectangle([px(0.375), px(0.135), px(0.625), px(0.34)], fill=GLASS)

    liquid = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(liquid)
    ld.ellipse(body, fill=BAD)
    ld.polygon([(px(0.375), px(0.42)), (px(0.625), px(0.42)),
                (px(0.80), px(0.62)), (px(0.20), px(0.62))], fill=BAD)
    ld.rectangle([0, 0, s, px(0.60)], fill=(0, 0, 0, 0))
    img.alpha_composite(liquid)

    d.rectangle([px(0.335), px(0.015), px(0.665), px(0.15)], fill=ACCENT)
    return _finish(img)


def _sparkle(d, cx, cy, r, waist, fill):
    """A four-point concave star -- the most legible 'magic' mark at 8 dots."""
    w = r * waist
    d.polygon([(cx, cy - r), (cx + w, cy - w), (cx + r, cy),
               (cx + w, cy + w), (cx, cy + r), (cx - w, cy + w),
               (cx - r, cy), (cx - w, cy - w)], fill=fill)


def spell():
    img, d, s = _canvas()
    px = lambda f: int(f * s)

    _sparkle(d, px(0.44), px(0.50), px(0.46), 0.30, ARCANE)
    _sparkle(d, px(0.44), px(0.50), px(0.30), 0.42, ACCENT)
    _sparkle(d, px(0.855), px(0.165), px(0.145), 0.30, ARCANE)
    return _finish(img)


def bug():
    img, d, s = _canvas()
    px = lambda f: int(f * s)
    leg = int(0.045 * s)

    # Legs before the body so the joints hide under the shell.
    for y0, y1, dx in ((0.44, 0.36, 0.34), (0.56, 0.60, 0.38), (0.68, 0.84, 0.34)):
        for sign in (-1, 1):
            d.line([(px(0.5), px(y0)),
                    (px(0.5 + sign * dx), px(y1))], fill=DIM, width=leg)
    for sign in (-1, 1):
        d.line([(px(0.5 + sign * 0.06), px(0.24)),
                (px(0.5 + sign * 0.26), px(0.045))], fill=DIM, width=leg)

    d.ellipse([px(0.235), px(0.315), px(0.765), px(0.965)], fill=OK)
    d.ellipse([px(0.365), px(0.115), px(0.635), px(0.385)], fill=DARK)
    # A centre seam splitting the shell into two wing cases: the one interior
    # detail chunky enough to have a chance of reading.
    d.rectangle([px(0.483), px(0.40), px(0.517), px(0.94)], fill=DARK)
    return _finish(img)


SUBJECTS = {
    "sword": {
        "draw": sword,
        "label": "Sword — item",
        "emoji": "\U0001F5E1️",
        "note": "Vertical tapered blade, wide crossguard, round pommel. The "
                "one subject whose silhouette is genuinely axis-aligned.",
    },
    "potion": {
        "draw": potion,
        "label": "Potion — item",
        "emoji": "\U0001F9EA",
        "note": "Round flask, narrow neck, cork. Tests whether a curve and a "
                "thin neck survive the dot budget.",
    },
    "spell": {
        "draw": spell,
        "label": "Spell — arcane spark",
        "emoji": "✨",
        "note": "Four-point sparkle with a smaller companion. Diagonal, "
                "concave, no flat edges to snap to the dot lattice.",
    },
    "bug": {
        "draw": bug,
        "label": "Bug — creature",
        "emoji": "\U0001F41B",
        "note": "Oval shell, head, six legs, two antennae. The hardest case: "
                "the legs are near-dot-width appendages at every grid.",
    },
}


def generate(out_dir):
    """Render every subject to `<out_dir>/<id>.png`, returning absolute paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, spec in SUBJECTS.items():
        path = out_dir / f"{name}.png"
        spec["draw"]().save(path)
        paths[name] = str(path.resolve())
    return paths
