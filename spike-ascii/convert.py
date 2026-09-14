"""Image -> dot grid. The part of the pipeline where the quality actually lives.

The converter library question turns out to be the least interesting one at this
size. What decides whether a 4x2 braille icon reads as a sword or as lint is two
knobs -- the downsample filter and the threshold rule -- so both are implemented
as swappable options here and measured rather than assumed.

Coverage is taken from the ALPHA channel, not from luminance. The sources are
silhouettes on transparency, so alpha is the exact area a shape occupies, and
BOX resampling of alpha is an exact area average -- which gives the experiment a
ground truth that does not depend on any of the choices being compared.
"""

import numpy as np
from PIL import Image

FILTERS = {
    "lanczos": Image.LANCZOS,
    "box": Image.BOX,
    "bilinear": Image.BILINEAR,
    "nearest": Image.NEAREST,
}

THRESHOLDS = ("fixed50", "fixed35", "otsu", "floyd")

# Palette, duplicated from host/themes.js rather than imported -- this is a
# spike and a JS import would be the wrong kind of coupling for throwaway code.
TEXT = "#c7cede"
DIM = "#6d7689"
ACCENT = "#d08c4a"
BG = "#11131a"

# Anything dimmer than this on a #11131a background is not an icon, it is a
# smudge. Truecolor renders get lifted to it; see the note on each render.
MIN_LUMA = 0.30


def coverage(img, cols_px, rows_px, filt):
    """Alpha coverage resampled to a dot grid, as floats in [0, 1]."""
    small = img.getchannel("A").resize((cols_px, rows_px), FILTERS[filt])
    return np.asarray(small, dtype=np.float64) / 255.0


def _otsu(cov):
    """Otsu's between-class variance threshold, on the coverage histogram."""
    if cov.max() - cov.min() < 1e-9:
        return 0.5
    q = np.clip(np.rint(cov * 255), 0, 255).astype(np.int64).ravel()
    hist = np.bincount(q, minlength=256).astype(np.float64)
    p = hist / hist.sum()
    omega = np.cumsum(p)
    mu = np.cumsum(p * np.arange(256))
    mu_t = mu[-1]
    denom = omega * (1.0 - omega)
    with np.errstate(divide="ignore", invalid="ignore"):
        sigma_b = np.where(denom > 1e-12, (mu_t * omega - mu) ** 2 / denom, 0.0)
    return float(np.argmax(sigma_b)) / 255.0


def _floyd_steinberg(cov):
    """Error-diffusion dither. Minimises LOCAL MEAN error, which is a different
    objective from reproducing a silhouette -- the experiment measures both."""
    work = cov.astype(np.float64).copy()
    height, width = work.shape
    out = np.zeros((height, width), dtype=bool)
    for y in range(height):
        for x in range(width):
            old = work[y, x]
            new = 1.0 if old >= 0.5 else 0.0
            out[y, x] = new > 0.5
            err = old - new
            if x + 1 < width:
                work[y, x + 1] += err * 7 / 16
            if y + 1 < height:
                if x > 0:
                    work[y + 1, x - 1] += err * 3 / 16
                work[y + 1, x] += err * 5 / 16
                if x + 1 < width:
                    work[y + 1, x + 1] += err * 1 / 16
    return out


def binarize(cov, method):
    if method == "fixed50":
        return cov >= 0.5
    if method == "fixed35":
        return cov >= 0.35
    if method == "otsu":
        return cov > _otsu(cov)
    if method == "floyd":
        return _floyd_steinberg(cov)
    raise KeyError(method)


def quantize(cov, levels):
    """Coverage -> ramp index, for the one-sample-per-cell techniques."""
    return np.clip(np.rint(cov * (levels - 1)), 0, levels - 1).astype(int)


# ---------------------------------------------------------------- metrics ---

def silhouette_iou(bits, img, ref=256):
    """Jaccard overlap between the dot pattern, blown back up, and the source.

    Independent of any threshold rule, which matters: a metric derived from the
    50%-coverage rule would hand the contest to the 50% threshold by definition.
    """
    truth = np.asarray(img.getchannel("A"), dtype=np.float64) / 255.0 >= 0.5
    grown = Image.fromarray((bits.astype(np.uint8) * 255)).resize(
        (ref, ref), Image.NEAREST)
    got = np.asarray(grown) > 127
    union = np.logical_or(truth, got).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(truth, got).sum()) / float(union)


def coverage_error(bits, img):
    """Mean |dot - true area coverage|, against an exact BOX area average.

    Per-dot, so it is minimised by rounding each dot independently -- i.e. by the
    0.5 threshold, by construction. Quoting it against a dither would be rigging
    the contest, which is why tone_error exists below.
    """
    rows_px, cols_px = bits.shape
    ref = coverage(img, cols_px, rows_px, "box")
    return float(np.abs(bits.astype(np.float64) - ref).mean())


def _box_blur3(a):
    p = np.pad(a.astype(np.float64), 1, mode="edge")
    h, w = a.shape
    out = np.zeros((h, w), dtype=np.float64)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            out += p[dy:dy + h, dx:dx + w]
    return out / 9.0


def tone_error(bits, img):
    """Error in LOCAL mean coverage over a 3x3 dot neighbourhood.

    This is the objective error diffusion actually minimises, so it is the metric
    that gives Floyd-Steinberg a fair hearing.
    """
    rows_px, cols_px = bits.shape
    ref = coverage(img, cols_px, rows_px, "box")
    return float(np.abs(_box_blur3(bits.astype(np.float64)) - _box_blur3(ref)).mean())


def dot_similarity(bits_a, bits_b):
    """Jaccard overlap between two subjects' dot patterns at the same grid.

    High means two DIFFERENT icons are drawing nearly the same picture, which is
    the failure that matters here -- a legible smudge is still a smudge.
    """
    union = np.logical_or(bits_a, bits_b).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(bits_a, bits_b).sum()) / float(union)


# ----------------------------------------------------------------- colour ---

def _hex(rgb):
    r, g, b = (int(round(float(v) * 255)) for v in rgb)
    return "#%02x%02x%02x" % (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))


def _luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def sample_cell_colors(img, cols, rows):
    """Alpha-weighted mean RGB per character cell, plus the cell's alpha.

    Premultiplying before the resize is the whole trick: averaging straight RGB
    pulls the transparent background's colour into every edge cell, which on a
    silhouette means every outline turns black.
    """
    arr = np.asarray(img, dtype=np.float64) / 255.0
    alpha = arr[..., 3]
    prem = Image.fromarray((arr[..., :3] * alpha[..., None] * 255).astype(np.uint8))
    small_rgb = np.asarray(prem.resize((cols, rows), Image.BOX), dtype=np.float64) / 255.0
    small_a = np.asarray(img.getchannel("A").resize((cols, rows), Image.BOX),
                         dtype=np.float64) / 255.0
    safe = np.maximum(small_a, 1e-6)[..., None]
    return np.clip(small_rgb / safe, 0.0, 1.0), small_a


def _lift(rgb):
    """Raise a cell to MIN_LUMA so dark source regions do not vanish into #11131a."""
    lum = _luma(rgb)
    if lum >= MIN_LUMA:
        return rgb
    if lum < 1e-4:
        return np.array([0.78, 0.81, 0.87])   # near TEXT, for a fully black cell
    return np.clip(rgb * (MIN_LUMA / lum), 0.0, 1.0)


def foreground(img, cols, rows, mode):
    """Per-cell hex colours, or None for mono."""
    if mode == "mono":
        return None
    if mode == "accent":
        return [[ACCENT] * cols for _ in range(rows)]

    rgb, alpha = sample_cell_colors(img, cols, rows)
    if mode == "duotone":
        lum = _luma(rgb)
        # Snap each cell to whichever of the two palette colours it is closer to
        # in luminance. Bright steel lands on --text, warm metal on --accent.
        text_l, accent_l = 0.788, 0.616
        out = []
        for y in range(rows):
            row = []
            for x in range(cols):
                if alpha[y, x] < 0.02:
                    row.append(TEXT)
                else:
                    row.append(TEXT if abs(lum[y, x] - text_l) <= abs(lum[y, x] - accent_l)
                               else ACCENT)
            out.append(row)
        return out
    if mode == "truecolor":
        return [[TEXT if alpha[y, x] < 0.02 else _hex(_lift(rgb[y, x]))
                 for x in range(cols)] for y in range(rows)]
    raise KeyError(mode)
