"""Validate appearances.yaml before spending GPU time on it.

Every problem this catches is invisible in the output: you see an inconsistent
roster or four identical states, not the entry that caused it. Cheap to run,
and it costs nothing to be wrong about.

    python check.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from generate import AGENTS_DIR, APPEARANCES_FILE
from prompts import (
    MAX_APPEARANCE_CHARS,
    STATES,
    appearance_for,
    build_prompt,
    build_style_prompt,
    derive_identity,
    load_appearances,
    load_style,
    parse_agent_file,
    style_conflicts,
)

# Hard limit per text encoder, including the two special tokens.
CLIP_LIMIT = 77


def _tokenizer():
    """Real CLIP tokenizer, not a chars/4 guess.

    The estimate is not merely imprecise, it is misleading: it reported these
    prompts at 57% over budget when the true figure was 29%. Worth the small
    download to stop guessing.
    """
    try:
        from transformers import CLIPTokenizerFast

        return CLIPTokenizerFast.from_pretrained("openai/clip-vit-base-patch32")
    except Exception as exc:  # noqa: BLE001
        print(f"  (CLIP tokenizer unavailable, skipping length checks: {exc})")
        return None


def _tokens(tok, text: str) -> int:
    return len(tok(text)["input_ids"]) if tok else 0


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else APPEARANCES_FILE
    print(f"appearances : {path}")
    if not path.exists():
        print("  (missing -- every agent falls back to its role)")
        return 0

    style = load_style(path)
    looks = load_appearances(path)
    tok = _tokenizer()

    print("\nshared art direction (applies to every agent):")
    for key in ("art", "shot", "lighting", "background"):
        print(f"  {key:11} {style[key]}")

    known = {p.stem for p in AGENTS_DIR.glob("*.md")}
    print(f"\nagents with a hand-written look: {len(looks)} of {len(known)}")

    problems = 0

    unknown = sorted(set(looks) - known)
    if unknown:
        problems += len(unknown)
        print("\nnot real agents (typo? the key is the FILENAME, not the person):")
        for name in unknown:
            print(f"  {name}")

    for name in sorted(set(looks) & known):
        look = str(looks[name].get("appearance") or "")
        notes = []

        conflicts = style_conflicts(look)
        if conflicts:
            notes.append("overrides shared art direction -> " + "; ".join(conflicts))

        if len(look) > MAX_APPEARANCE_CHARS:
            notes.append(f"{len(look)} chars, truncated at {MAX_APPEARANCE_CHARS}")

        ident = appearance_for(derive_identity(parse_agent_file(AGENTS_DIR / f"{name}.md")), looks)
        if tok:
            longest = max(_tokens(tok, build_prompt(ident, s, style=style)) for s in STATES)
            if longest > CLIP_LIMIT:
                notes.append(
                    f"{longest} tokens vs the {CLIP_LIMIT} limit; the state cue "
                    "would be cut, collapsing all four states into one image"
                )

        if notes:
            problems += 1
            print(f"\n  {name}")
            for note in notes:
                print(f"    ! {note}")

    # The art direction goes to the second text encoder, so it has its own
    # budget and is identical by construction -- but measure it rather than
    # trust it, since it is the whole basis of a consistent roster.
    style_prompt = build_style_prompt(style)
    if tok:
        n = _tokens(tok, style_prompt)
        fits = n <= CLIP_LIMIT
        print(f"\nshared style prompt: {n} tokens {'(fits)' if fits else '-- OVER LIMIT'}")
        if not fits:
            problems += 1
            print("  ! the art direction itself would be truncated, so the roster")
            print("    would drift agent to agent. Shorten the _style block.")

    # What the token budget actually costs each agent, in their own words.
    #
    # This check exists because the script said "no problems found" while CLIP
    # was discarding the art direction from four of eight agents. The overflow
    # was reported by the pipeline as a note about sequence length, and here not
    # at all -- the exact "invisible in the output" failure this file is for.
    # build_prompt now trims the SUBJECT instead, which is the right trade, but
    # a clause quietly vanishing from hand-written text still has to be said.
    trimmed_any = False
    for name in sorted(looks):
        entry = looks.get(name) or {}
        look = str(entry.get("appearance") or "").strip()
        md = AGENTS_DIR / (name + ".md")
        if not look or not md.exists():
            continue
        merged = appearance_for(derive_identity(parse_agent_file(md)), looks)
        # The BASE pass only, which is the only place the appearance is ever
        # spoken: generate.py and tune.py both build with "working", and the
        # four states come from img2img via build_state_prompt(), which omits
        # the appearance entirely. Reporting the worst state instead made the
        # loss look far bigger than it is -- "sleeping" has the longest cue, so
        # it showed code-reviewer losing his beard and glasses in a prompt that
        # is never built.
        prompt = build_prompt(merged, "working", style=style)
        dropped = [c.strip() for c in look.split(",")
                   if c.strip() and c.strip() not in prompt]
        if dropped:
            if not trimmed_any:
                print("")
                print("trimmed to fit CLIP's 77 tokens "
                      "(clause order decides what survives):")
                trimmed_any = True
            print("  " + name + ": dropped " + ", ".join(dropped))
    if trimmed_any:
        print("  put face features before clothing -- the tail is what goes.")

    print(f"\n{'no problems found' if problems == 0 else f'{problems} thing(s) to look at'}")
    print("(advisory only -- everything still generates)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
