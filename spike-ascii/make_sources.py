"""Render the procedural sources, plus a contact sheet at the sizes that matter."""
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from PIL import Image  # noqa: E402
import sources  # noqa: E402

HERE = pathlib.Path(__file__).parent
paths = sources.generate(HERE / "sources")
for name, path in paths.items():
    print(f"{name:8s} {path}")

# The project's own scar: judge at real size. 34px is the roster size.
sizes = [34, 48, 96, 256]
pad = 8
sheet = Image.new("RGB", (sum(sizes) + pad * (len(sizes) + 1),
                          len(paths) * (max(sizes) + pad) + pad), (0x11, 0x13, 0x1a))
for row, name in enumerate(paths):
    src = Image.open(paths[name]).convert("RGBA")
    x = pad
    y = pad + row * (max(sizes) + pad)
    for size in sizes:
        sheet.paste(src.resize((size, size), Image.LANCZOS), (x, y), src.resize((size, size), Image.LANCZOS))
        x += size + pad
out = HERE / "sources" / "_contact.png"
sheet.save(out)
print("contact sheet", out.resolve())
