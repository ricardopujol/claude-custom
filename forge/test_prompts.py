"""Tests for prompt derivation. Pure text work -- no GPU, no model weights."""

import textwrap

import pytest

from prompts import (
    STATES,
    build_prompt,
    derive_identity,
    negative_prompt,
    parse_agent_file,
)


def write(tmp_path, name, body):
    p = tmp_path / f"{name}.md"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


MIGUEL = """\
    ---
    name: code-reviewer
    description: "Elite code reviewer specializing in code quality, security vulnerabilities, performance, and best practices. Invoke proactively whenever the user mentions Miguel in the context of reviewing code, checking changes, or looking at a PR."
    model: opus
    color: yellow
    ---

    You are a code reviewer.
    """


def test_parses_frontmatter(tmp_path):
    agent = parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))
    assert agent["name"] == "code-reviewer"
    assert agent["color"] == "yellow"
    assert "Elite code reviewer" in agent["description"]


def test_extracts_the_human_name(tmp_path):
    # The named agents already carry an identity; that is what makes a portrait
    # of them mean anything.
    agent = parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))
    assert derive_identity(agent)["person"] == "Miguel"


def test_unnamed_agents_have_no_person(tmp_path):
    body = """\
        ---
        name: spring-boot-engineer
        description: "Use this agent when building enterprise Spring Boot 3+ applications."
        ---
        """
    agent = parse_agent_file(write(tmp_path, "spring-boot-engineer", body))
    assert derive_identity(agent)["person"] is None


def test_does_not_mistake_a_sentence_start_for_a_name(tmp_path):
    # "Use this agent when..." starts capitalised; a naive capitalised-word
    # scan turns half the roster into people called "Use".
    body = """\
        ---
        name: api-designer
        description: "Use this agent when designing new APIs. Invoke when you need REST endpoint design."
        ---
        """
    assert derive_identity(parse_agent_file(write(tmp_path, "api-designer", body)))["person"] is None


def test_role_comes_from_the_description_not_the_invocation_blurb(tmp_path):
    # Everything after "Invoke proactively" is trigger phrasing for the router
    # and describes no visual subject at all.
    ident = derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL)))
    assert "Invoke" not in ident["role"]
    assert "Miguel" not in ident["role"]
    assert "code reviewer" in ident["role"].lower()


def test_role_is_short_enough_for_clip(tmp_path):
    # CLIP truncates at 77 tokens; a 600-character description silently drops
    # everything that matters, including the state cue appended after it.
    long = "x " * 500
    body = f"""\
        ---
        name: verbose-agent
        description: "A specialist who {long}"
        ---
        """
    ident = derive_identity(parse_agent_file(write(tmp_path, "verbose-agent", body)))
    assert len(ident["role"]) <= 140


def test_four_states_by_default():
    assert STATES == ["sleeping", "working", "happy", "stressed"]


@pytest.mark.parametrize("state", STATES)
def test_prompt_contains_state_specific_cue(state, tmp_path):
    agent = parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))
    prompts = {s: build_prompt(derive_identity(agent), s) for s in STATES}
    assert len(set(prompts.values())) == len(STATES), "states produced identical prompts"
    assert prompts[state]


def test_prompt_asks_for_an_illustrated_bust(tmp_path):
    # Decision 8: stylized illustrated bust, not pixel art and not flat vector.
    p = build_prompt(derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))), "working")
    lowered = p.lower()
    assert "bust" in lowered
    assert "illustrat" in lowered


def test_prompt_uses_the_agent_colour_as_a_palette_cue(tmp_path):
    p = build_prompt(derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))), "working")
    assert "yellow" in p.lower()


def test_negative_prompt_rejects_photorealism_and_text(tmp_path):
    n = negative_prompt().lower()
    for unwanted in ("photo", "text", "watermark", "full body"):
        assert unwanted in n


def test_prompt_is_deterministic(tmp_path):
    agent = parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))
    ident = derive_identity(agent)
    assert build_prompt(ident, "happy") == build_prompt(ident, "happy")


def test_missing_frontmatter_does_not_crash(tmp_path):
    p = tmp_path / "broken.md"
    p.write_text("no frontmatter here", encoding="utf-8")
    agent = parse_agent_file(p)
    assert agent["name"] == "broken"
    assert derive_identity(agent)["role"]


# --- user-authored appearances ------------------------------------------------

from prompts import load_appearances, appearance_for


APPEARANCE_YAML = """\
code-reviewer:
  appearance: "a stern man in his fifties, short salt-and-pepper beard, round wire glasses, charcoal cardigan"
  palette: "deep teal and brass"
logic-reviewer:
  appearance: "a gaunt young man with sharp features, severe dark undercut, high-collared black coat"
"""


def test_loads_user_authored_appearances(tmp_path):
    f = tmp_path / "appearances.yaml"
    f.write_text(APPEARANCE_YAML, encoding="utf-8")
    looks = load_appearances(f)
    assert "wire glasses" in looks["code-reviewer"]["appearance"]


def test_missing_appearances_file_is_not_an_error(tmp_path):
    # The file is optional and starts empty; every agent falls back to its role.
    assert load_appearances(tmp_path / "nope.yaml") == {}


def test_malformed_appearances_file_does_not_crash(tmp_path):
    f = tmp_path / "appearances.yaml"
    f.write_text("{{{ not yaml", encoding="utf-8")
    assert load_appearances(f) == {}


def test_appearance_becomes_the_subject_of_the_prompt(tmp_path):
    # A hand-written look must win over text scraped from the description.
    f = tmp_path / "appearances.yaml"
    f.write_text(APPEARANCE_YAML, encoding="utf-8")
    ident = derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL)))
    ident = appearance_for(ident, load_appearances(f))
    p = build_prompt(ident, "working")
    assert "wire glasses" in p
    assert "salt-and-pepper" in p


def test_appearance_palette_overrides_the_frontmatter_colour(tmp_path):
    f = tmp_path / "appearances.yaml"
    f.write_text(APPEARANCE_YAML, encoding="utf-8")
    ident = derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL)))
    ident = appearance_for(ident, load_appearances(f))
    p = build_prompt(ident, "working").lower()
    assert "brass" in p


def test_agent_without_an_appearance_still_works(tmp_path):
    f = tmp_path / "appearances.yaml"
    f.write_text(APPEARANCE_YAML, encoding="utf-8")
    ident = derive_identity(parse_agent_file(write(tmp_path, "api-designer", """\
        ---
        name: api-designer
        description: "Use this agent when designing new APIs."
        ---
        """)))
    ident = appearance_for(ident, load_appearances(f))
    assert build_prompt(ident, "working")


def test_state_cue_survives_a_long_appearance(tmp_path):
    # CLIP truncates at 77 tokens. If a long appearance pushes the state cue off
    # the end, all four states render identically and the mood engine has
    # nothing to show.
    f = tmp_path / "appearances.yaml"
    f.write_text("code-reviewer:\n  appearance: \"" + ("very ornate " * 60) + "\"\n", encoding="utf-8")
    ident = derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL)))
    ident = appearance_for(ident, load_appearances(f))
    prompts = {s: build_prompt(ident, s) for s in STATES}
    assert len(set(prompts.values())) == len(STATES), "long appearance collapsed the states"
    assert "eyes closed" in prompts["sleeping"]


def test_no_doubled_article_when_appearance_starts_with_one(tmp_path):
    # Natural phrasing for a look is "a composed man in his fifties...", and the
    # template already supplies the article -> "a a composed man".
    f = tmp_path / "appearances.yaml"
    f.write_text('code-reviewer:\n  appearance: "a composed man with wire glasses"\n', encoding="utf-8")
    ident = appearance_for(
        derive_identity(parse_agent_file(write(tmp_path, "code-reviewer", MIGUEL))),
        load_appearances(f),
    )
    p = build_prompt(ident, "working")
    assert "a a " not in p, p
    assert "an an " not in p
    assert "composed man with wire glasses" in p
