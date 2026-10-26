"""The prompt must fit CLIP's 77-token window without losing art direction.

Encoder 1 carries the subject AND the short `core` art direction. When the two
together overflow, CLIP truncates the TAIL -- which is the core. Measured
before this was fixed: code-reviewer lost "illustration, rich colour, facing
viewer" entirely, mutation-tester lost "colour, facing viewer", logic-reviewer
lost "viewer", and ui-ux-tester lost nothing.

That is the worst possible failure mode for a roster: the shared direction
survives by a DIFFERENT amount per agent, so the set stops looking like a set,
and the amount is decided by how long someone's description happened to be.
"""

import pytest

from prompts import (
    CLIP_TOKEN_LIMIT,
    DEFAULT_STYLE,
    build_prompt,
    count_tokens,
    fit_subject,
)

SHORT = "a lean man with a shaved head, wire-rimmed glasses"
LONG = ("a composed man in his fifties, bald, close-cropped salt-and-pepper beard, "
        "round wire glasses, charcoal cardigan over a collared shirt, holding a "
        "worn notebook and a chipped enamel mug of cold coffee")


def ident(appearance):
    return {"agent": "someone", "appearance": appearance}


@pytest.mark.parametrize("state", ["sleeping", "working", "happy", "stressed"])
@pytest.mark.parametrize("appearance", [SHORT, LONG])
def test_prompt_fits_the_window(state, appearance):
    assert count_tokens(build_prompt(ident(appearance), state)) <= CLIP_TOKEN_LIMIT


@pytest.mark.parametrize("state", ["sleeping", "working", "happy", "stressed"])
def test_art_direction_survives_a_long_appearance(state):
    # The whole point: the shared words must be intact no matter whose portrait
    # this is, because they are what makes the roster one set.
    prompt = build_prompt(ident(LONG), state)
    for word in DEFAULT_STYLE["core"].split(", "):
        assert word in prompt, f"{word!r} lost from: {prompt}"


def test_a_short_appearance_is_not_trimmed():
    # Trimming when there is room would silently discard detail the author
    # wrote on purpose.
    assert SHORT in build_prompt(ident(SHORT), "working")


def test_the_subject_absorbs_the_trim_not_the_style():
    prompt = build_prompt(ident(LONG), "working")
    assert "painterly illustration" in prompt
    assert "cold coffee" not in prompt          # the tail of the subject went


def test_trimming_stops_at_a_word_boundary():
    # A half-word is a typo to the model, not a shorter description.
    trimmed = fit_subject(LONG, budget=20)
    assert not LONG.startswith(trimmed + "x"), trimmed
    assert trimmed == trimmed.strip()
    assert not trimmed.endswith(",")


def test_trimming_never_returns_nothing():
    # A budget too small to hold anything must still name a subject, or the
    # prompt describes a style with no person in it.
    assert fit_subject(LONG, budget=1).strip()


def test_fit_subject_is_idempotent():
    once = fit_subject(LONG, budget=25)
    assert fit_subject(once, budget=25) == once


def test_count_tokens_matches_the_real_clip_tokenizer():
    # If this drifts from the tokenizer the pipeline uses, every budget computed
    # from it is fiction.
    from transformers import CLIPTokenizer
    tok = CLIPTokenizer.from_pretrained("openai/clip-vit-base-patch32")
    for text in [SHORT, LONG, "a", ""]:
        assert count_tokens(text) == len(tok(text)["input_ids"])


def test_every_described_agent_fits():
    """The real appearances file, every agent, every state."""
    from pathlib import Path
    from portraits_dir import MARKER, resolve_portraits_dir
    from prompts import (appearance_for, derive_identity, load_appearances,
                         load_style, parse_agent_file)

    yaml_path = resolve_portraits_dir() / MARKER
    agents_dir = Path(r"C:\Users\ricar\.claude\agents")
    if not yaml_path.exists() or not agents_dir.exists():
        pytest.skip("appearances or agents not present on this machine")

    appearances = load_appearances(yaml_path)
    style = load_style(yaml_path)
    checked = 0
    for name in appearances:
        md = agents_dir / f"{name}.md"
        if not md.exists():
            continue
        merged = appearance_for(derive_identity(parse_agent_file(md)), appearances)
        for state in ["sleeping", "working", "happy", "stressed"]:
            prompt = build_prompt(merged, state, style=style)
            n = count_tokens(prompt)
            assert n <= CLIP_TOKEN_LIMIT, f"{name}/{state}: {n} tokens"
            for word in style["core"].split(", "):
                assert word in prompt, f"{name}/{state} lost {word!r}"
            checked += 1
    assert checked > 0


def test_trimming_cuts_at_clause_boundaries_not_mid_phrase():
    """A word-boundary trim leaves fragments that mean something else.

    Measured on the real file: code-reviewer kept "round wire" and lost
    "glasses"; media-pipeline-engineer kept "faded band" and lost "t-shirt".
    The model happily draws a band.
    """
    trimmed = fit_subject(LONG, budget=30)
    assert "round wire glasses" in trimmed or "round wire" not in trimmed, trimmed
    # Whatever survives is a whole number of clauses.
    assert all(c.strip() for c in trimmed.split(","))


def test_a_clause_is_kept_whole_or_dropped_whole():
    subject = "a man, round wire glasses, a charcoal cardigan over a collared shirt"
    for budget in range(4, 40):
        trimmed = fit_subject(subject, budget=budget)
        for clause in trimmed.split(","):
            clause = clause.strip()
            if not clause:
                continue
            # Every surviving clause must appear verbatim in the original.
            assert clause in subject, f"budget {budget} produced {clause!r}"
