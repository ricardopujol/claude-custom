"""Independent check of .harness/ascii/generated.json, read back off disk.

Separate from the in-pipeline self-check on purpose. That one validates objects
the pipeline is still holding; this one validates the FILE, which is the thing
another agent's script will actually read -- including its raw bytes, its
encoding, and the JS-side length trap that Python's len() cannot see.

    py -3.14 spike-ascii/verify_manifest.py
"""

import json
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import glyphs  # noqa: E402

MANIFEST = pathlib.Path(__file__).parent.parent / ".harness" / "ascii" / "generated.json"

REQUIRED_TOP = {"generatedAt", "sources", "subjects", "renders"}
REQUIRED_RENDER = {"id", "subject", "technique", "source", "cols", "rows",
                   "color", "lines", "fg", "note"}
REQUIRED_SUBJECT = {"id", "label", "emoji", "note"}


def main():
    raw = MANIFEST.read_bytes()
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    check(b"\x1b" not in raw, "raw file bytes contain an ANSI escape (0x1b)")
    check(b"\\u001b" not in raw, "raw file contains a JSON-escaped \\u001b")
    text = raw.decode("utf-8")   # raises if the file is not valid UTF-8
    check(text == raw.decode("utf-8"), "file is not valid UTF-8")
    # ensure_ascii=False means real glyphs, not \uXXXX escapes, must be present.
    check("⠀" in text, "no literal U+2800 in the file -- ensure_ascii leaked")

    data = json.loads(text)
    check(REQUIRED_TOP <= set(data), f"missing top-level keys: {REQUIRED_TOP - set(data)}")

    for name, path in data["sources"].items():
        p = pathlib.Path(path)
        check(p.is_absolute(), f"source {name} path is not absolute: {path}")
        check(p.exists(), f"source {name} does not exist: {path}")

    subject_ids = set()
    for s in data["subjects"]:
        check(REQUIRED_SUBJECT <= set(s), f"subject missing keys: {s.get('id')}")
        subject_ids.add(s["id"])
        check(bool(s["emoji"]), f"subject {s['id']} has no emoji "
                                "(the ART PLACEHOLDER RULE wants one per thing)")
    check(subject_ids == set(data["sources"]),
          f"subjects {subject_ids} != sources {set(data['sources'])}")

    astral = 0
    seen_ids = set()
    for r in data["renders"]:
        rid = r.get("id", "<no id>")
        check(REQUIRED_RENDER <= set(r), f"{rid}: missing keys {REQUIRED_RENDER - set(r)}")
        check(rid not in seen_ids, f"{rid}: duplicate render id")
        seen_ids.add(rid)
        check(rid == f"{r['subject']}__{r['technique']}__{r['cols']}x{r['rows']}__{r['color']}",
              f"{rid}: id does not match its own fields")
        check(r["subject"] in subject_ids, f"{rid}: unknown subject")

        check(len(r["lines"]) == r["rows"],
              f"{rid}: {len(r['lines'])} lines but rows={r['rows']}")
        allowed = glyphs.charset(r["technique"])
        for i, line in enumerate(r["lines"]):
            check(len(line) == r["cols"],
                  f"{rid}: line {i} is {len(line)} code points, cols={r['cols']}")
            check("\x1b" not in line, f"{rid}: line {i} has an escape")
            check(set(line) <= allowed, f"{rid}: line {i} has out-of-charset chars")
            if r["technique"] == "braille":
                check(" " not in line, f"{rid}: line {i} uses U+0020, not U+2800")
            # Counted, not failed: astral code points are correct output, but a
            # JS consumer using String.length will see two units per character.
            astral += sum(1 for c in line if ord(c) > 0xFFFF)

        if r["color"] == "mono":
            check(r["fg"] is None, f"{rid}: mono but fg is not null")
        else:
            check(isinstance(r["fg"], list) and len(r["fg"]) == r["rows"],
                  f"{rid}: fg is not {r['rows']} rows")
            for row in r["fg"]:
                check(len(row) == r["cols"], f"{rid}: fg row is not {r['cols']} wide")
                for h in row:
                    check(isinstance(h, str) and len(h) == 7 and h[0] == "#"
                          and all(c in "0123456789abcdefABCDEF" for c in h[1:]),
                          f"{rid}: bad hex {h!r}")

    print(f"file      : {MANIFEST.resolve()}")
    print(f"size      : {len(raw) / 1024:.0f} KB, valid UTF-8, no 0x1b anywhere")
    print(f"renders   : {len(data['renders'])} unique ids")
    print(f"subjects  : {len(data['subjects'])}  sources: {len(data['sources'])} (all exist)")
    print(f"astral    : {astral} code points above U+FFFF (all sextants)")
    if astral:
        print("            NOTE FOR A JS CONSUMER: these are surrogate pairs, so")
        print("            line.length !== cols for sextant renders. Use")
        print("            [...line].length or Array.from(line) to count cells.")

    if failures:
        print(f"\nFAIL: {len(failures)} problems")
        for f in failures[:40]:
            print("  -", f)
        sys.exit(1)
    print("\nPASS: every contract assertion held.")


if __name__ == "__main__":
    main()
