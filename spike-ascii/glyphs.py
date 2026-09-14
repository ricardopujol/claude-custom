"""Glyph packers: turn a dot grid into text cells.

Six techniques, one interface. Every function here returns plain strings and
NEVER an escape sequence -- the output is destined for HTML `<pre>` + spans, not
a terminal, so colour is carried separately as hex and never inlined as ANSI.

Every table is built with chr() so this source file stays 7-bit ASCII and
survives any editor, shell or checkout that mangles encodings.
"""

BRAILLE_BLANK = chr(0x2800)

# Dot-bit layout inside one braille cell, indexed [y][x] over a 2-wide 4-tall
# dot grid. Unicode braille numbers dots 1-2-3 down the left column, 4-5-6 down
# the right, then 7 and 8 as the bottom row -- which is why the last row jumps
# to bits 6 and 7 instead of continuing the pattern.
_BRAILLE_BITS = ((0, 3), (1, 4), (2, 5), (6, 7))


def _sextant_table():
    """The 64 sextant patterns, as a list indexed by bit mask (bit = y*2 + x).

    U+1FB00..U+1FB3B holds 60 of them in ascending mask order. The other four
    already had code points before Symbols for Legacy Computing existed -- empty,
    left half, right half, full block -- and were skipped rather than duplicated,
    so the run is not a straight offset and has to be walked.
    """
    preexisting = {
        0b000000: " ",
        0b010101: chr(0x258C),   # bits 1,3,5 -> LEFT HALF BLOCK
        0b101010: chr(0x2590),   # bits 2,4,6 -> RIGHT HALF BLOCK
        0b111111: chr(0x2588),   # FULL BLOCK
    }
    table, cursor = [], 0x1FB00
    for mask in range(64):
        if mask in preexisting:
            table.append(preexisting[mask])
        else:
            table.append(chr(cursor))
            cursor += 1
    assert cursor == 0x1FB3C, hex(cursor)
    return table


# Quadrant: bit = y*2 + x, so 1=top-left, 2=top-right, 4=bottom-left, 8=bottom-right.
_QUADRANT = [
    " ", chr(0x2598), chr(0x259D), chr(0x2580),
    chr(0x2596), chr(0x258C), chr(0x259E), chr(0x259B),
    chr(0x2597), chr(0x259A), chr(0x2590), chr(0x259C),
    chr(0x2584), chr(0x2599), chr(0x259F), chr(0x2588),
]

# Half block: bit 0 = top, bit 1 = bottom. Only four states, because we emit one
# foreground colour per cell -- the usual half-block trick of painting the upper
# half in fg and the lower in bg is unavailable when there is no per-cell bg.
_HALFBLOCK = [" ", chr(0x2580), chr(0x2584), chr(0x2588)]

_SEXTANT = _sextant_table()

# Density ramps for the one-sample-per-cell techniques. Index 0 is empty.
SHADE_RAMP = " " + chr(0x2591) + chr(0x2592) + chr(0x2593) + chr(0x2588)
ASCII_RAMP = " .:-=+*#%@"

# dots = (wide, tall) per character cell; binary techniques get a 1-bit dot grid,
# the others get one coverage sample and pick a ramp character.
TECHNIQUES = {
    "braille":   {"dots": (2, 4), "binary": True},
    "sextant":   {"dots": (2, 3), "binary": True},
    "quadrant":  {"dots": (2, 2), "binary": True},
    "halfblock": {"dots": (1, 2), "binary": True},
    "shade":     {"dots": (1, 1), "binary": False, "ramp": SHADE_RAMP},
    "ascii":     {"dots": (1, 1), "binary": False, "ramp": ASCII_RAMP},
}


def _bit(technique, x, y):
    if technique == "braille":
        return 1 << _BRAILLE_BITS[y][x]
    return 1 << (y * TECHNIQUES[technique]["dots"][0] + x)


def _glyph(technique, mask):
    if technique == "braille":
        return chr(0x2800 + mask)
    if technique == "sextant":
        return _SEXTANT[mask]
    if technique == "quadrant":
        return _QUADRANT[mask]
    if technique == "halfblock":
        return _HALFBLOCK[mask]
    raise KeyError(technique)


def pack(technique, bits):
    """Pack a 2-D grid of 0/1 dots into `rows` strings of `cols` characters.

    `bits` is indexed [y][x] at dot resolution; its dimensions must be an exact
    multiple of the technique's cell size.
    """
    dx, dy = TECHNIQUES[technique]["dots"]
    height, width = len(bits), len(bits[0])
    assert height % dy == 0 and width % dx == 0, (width, height, dx, dy)

    lines = []
    for cell_y in range(height // dy):
        line = []
        for cell_x in range(width // dx):
            mask = 0
            for y in range(dy):
                for x in range(dx):
                    if bits[cell_y * dy + y][cell_x * dx + x]:
                        mask |= _bit(technique, x, y)
            line.append(_glyph(technique, mask))
        lines.append("".join(line))
    return lines


def pack_ramp(technique, levels):
    """Pack a 2-D grid of ramp indices into strings, one character per cell."""
    ramp = TECHNIQUES[technique]["ramp"]
    return ["".join(ramp[v] for v in row) for row in levels]


def charset(technique):
    """Every character a technique can legally emit -- used by the self-check."""
    if technique == "braille":
        return {chr(0x2800 + m) for m in range(256)}
    if technique == "sextant":
        return set(_SEXTANT)
    if technique == "quadrant":
        return set(_QUADRANT)
    if technique == "halfblock":
        return set(_HALFBLOCK)
    return set(TECHNIQUES[technique]["ramp"])
