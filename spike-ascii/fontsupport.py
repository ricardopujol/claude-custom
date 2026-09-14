"""Does a font actually HAVE the code points a technique emits?

This turned out to be the constraint that decides the whole spike, and no image
metric can see it: a technique can win every fidelity score and still render as
a row of tofu boxes because the monospace font on the machine has never heard of
U+1FB00. Measured, not assumed -- and measured empirically, because fontTools is
not installed and adding a dependency to find out would be silly.

The test: render the character, render a code point no font defines, compare the
bitmaps. Identical means the renderer fell back to .notdef.
"""

import pathlib

from PIL import Image, ImageDraw, ImageFont

import glyphs

# A plane-16 private-use slot. Nothing defines it, so its bitmap IS .notdef.
_ABSENT = 0x10FFFD
_PROBE_SIZE = 32

# Monospace fonts a Windows Electron app might plausibly resolve to.
CANDIDATE_FONTS = {
    "Cascadia Code": r"C:\Windows\Fonts\CascadiaCode.ttf",
    "Cascadia Mono": r"C:\Windows\Fonts\CascadiaMono.ttf",
    "Consolas": r"C:\Windows\Fonts\consola.ttf",
    "DejaVu Sans Mono": r"C:\Windows\Fonts\DejaVuSansMono.ttf",
    "Segoe UI Symbol": r"C:\Windows\Fonts\seguisym.ttf",
}


def _bitmap(font, cp):
    img = Image.new("L", (_PROBE_SIZE * 2, _PROBE_SIZE * 2), 0)
    ImageDraw.Draw(img).text((4, 4), chr(cp), font=font, fill=255)
    return img.tobytes()


# The Unicode block that DEFINES each technique. Reported separately because a
# technique's charset can include borrowed characters that every font already
# has: the sextant set contains space, the two half blocks and the full block,
# so a font with zero real sextants still scores 4/64 and looks survivable.
_DEFINING_BLOCK = {
    "braille": (0x2800, 0x28FF),
    "sextant": (0x1FB00, 0x1FB3B),
    "quadrant": (0x2596, 0x259F),
}


def probe(font_path):
    """Per-technique coverage for one font: {technique: (have, total, block)}.

    `block` is (have, total) restricted to the technique's defining Unicode
    block, or None when the technique has no block of its own.
    """
    font = ImageFont.truetype(font_path, _PROBE_SIZE)
    notdef = _bitmap(font, _ABSENT)
    out = {}
    for technique in glyphs.TECHNIQUES:
        points = sorted({ord(c) for c in glyphs.charset(technique)})
        covered = {cp for cp in points if _bitmap(font, cp) != notdef}
        block = None
        if technique in _DEFINING_BLOCK:
            lo, hi = _DEFINING_BLOCK[technique]
            inside = [cp for cp in points if lo <= cp <= hi]
            block = (sum(1 for cp in inside if cp in covered), len(inside))
        out[technique] = (len(covered), len(points), block)
    return out


def survey(fonts=None):
    """Coverage for every candidate font that exists on this machine."""
    results = {}
    for name, path in (fonts or CANDIDATE_FONTS).items():
        if pathlib.Path(path).exists():
            results[name] = probe(path)
    return results


def report(results):
    techniques = list(glyphs.TECHNIQUES)
    print("\n--- FONT COVERAGE: can the machine even DRAW these code points? ---")
    print(f"{'font':18s} " + " ".join(f"{t:>11s}" for t in techniques))
    for name, cov in results.items():
        cells = []
        for t in techniques:
            have, total, block = cov[t]
            # Show the defining block's number where there is one -- it is the
            # honest figure, the whole-charset one flatters borrowed characters.
            shown = f"{block[0]}/{block[1]}" if block else f"{have}/{total}"
            bad = (block[0] != block[1]) if block else (have != total)
            cells.append(shown + ("  X" if bad else ""))
        print(f"{name:18s} " + " ".join(f"{c:>11s}" for c in cells))
    print("   (braille/sextant/quadrant show their DEFINING block; the rest show "
          "the whole charset. X = incomplete = tofu.)")

    print("\n  verdict per technique (across every font found):")
    out = {}
    for t in techniques:
        score = {n: (c[t][2] or (c[t][0], c[t][1])) for n, c in results.items()}
        full = [n for n, (h, tot) in score.items() if h == tot]
        # PARTIAL IS A FAILURE, not a pass. A font with 6 of the 16 quadrants
        # renders ten cells of tofu and nobody notices until a screenshot.
        broken = {n: f"{h}/{tot}" for n, (h, tot) in score.items() if h != tot}
        if not full:
            best = max(score.values())
            print(f"    {t:10s} UNUSABLE HERE -- best installed font covers only "
                  f"{best[0]}/{best[1]} of the block")
        elif broken:
            detail = ", ".join(f"{n} {v}" for n, v in broken.items())
            print(f"    {t:10s} font-dependent -- incomplete in: {detail}")
        else:
            print(f"    {t:10s} safe -- every font tested covers all of it")
        out[t] = {"fullCoverage": full, "incomplete": broken}
    return out
