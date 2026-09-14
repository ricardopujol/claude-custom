"""Smoke test for the glyph tables -- run directly, prints what it packed."""
import sys
import pathlib

sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import glyphs  # noqa: E402

print("braille ", glyphs.pack("braille", [[1, 0], [0, 1], [1, 1], [0, 0]]))
print("sextant ", glyphs.pack("sextant", [[1, 0], [0, 1], [1, 1]]))
print("quadrant", glyphs.pack("quadrant", [[1, 0], [0, 1]]))
print("halfblk ", glyphs.pack("halfblock", [[1], [1]]))
print("sextant charset size", len(glyphs.charset("sextant")))
print("shade ramp", [hex(ord(c)) for c in glyphs.SHADE_RAMP])
# A few known sextant identities, as a table check rather than a vibe check.
assert glyphs.pack("sextant", [[1, 0], [0, 0], [0, 0]])[0] == chr(0x1FB00)
assert glyphs.pack("sextant", [[1, 0], [1, 0], [1, 0]])[0] == chr(0x258C)
assert glyphs.pack("sextant", [[0, 1], [0, 1], [0, 1]])[0] == chr(0x2590)
assert glyphs.pack("sextant", [[1, 1], [1, 1], [1, 1]])[0] == chr(0x2588)
assert glyphs.pack("braille", [[1, 0], [0, 0], [0, 0], [0, 0]])[0] == chr(0x2801)
assert glyphs.pack("braille", [[0, 0], [0, 0], [0, 0], [0, 1]])[0] == chr(0x2880)
assert glyphs.pack("quadrant", [[1, 1], [0, 0]])[0] == chr(0x2580)
print("OK")
