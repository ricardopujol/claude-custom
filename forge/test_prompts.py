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
