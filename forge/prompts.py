"""Derive portrait prompts from agent definition files.

Reads the agent's own `.md` frontmatter -- name, description, colour -- and
turns it into an SDXL prompt. Nothing is written back: editing an agent file
triggers the mandatory /align-agents sync, so the forge stays strictly a reader.

The named agents (Miguel, Dexter, Naomi, Paris, Atlas, Cedar, Vera, Otto,
Mortimer, Lukas...) already carry an identity, which is what makes a portrait
of them mean anything. Unnamed ones like `spring-boot-engineer` get a portrait
of the ROLE instead.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

STATES = ["sleeping", "working", "happy", "stressed"]

# CLIP truncates at 77 tokens. A 600-character description silently drops
# everything after it -- including the state cue, which is the whole point of
# generating four images instead of one.
MAX_ROLE_CHARS = 140

# Same reasoning as MAX_ROLE_CHARS: a long hand-written look would push the
# state cue past CLIP's 77-token limit and collapse all four states into one
# image. Slightly more generous, since this text is deliberate rather than
# scraped.
MAX_APPEARANCE_CHARS = 200

# Everything from these markers onward is routing/trigger phrasing aimed at the
# agent dispatcher. It describes no visual subject whatsoever.
_TRIGGER_MARKERS = (
    "Invoke proactively",
    "Invoke this agent",
    "Invoke when",
    "Invoke it",
    "Invoke ",
    "Use this agent when",
    "Use when",
    "Use for",
    " -- e.g.",
    " — e.g.",
    "e.g. '",
)

_LEAD_INS = (
    "Use this agent when ",
    "Use this agent for ",
    "Use when ",
    "Use for ",
)

# Anchored on the literal word "mentions" rather than scanning for capitalised
# words: descriptions routinely begin "Use this agent when...", and a naive
# capitalised-word scan turns half the roster into people called "Use".
_PERSON_RE = re.compile(
    r"mentions\s+((?:[A-Z][\w'À-ſ-]*)(?:\s+[A-Z][\w'À-ſ-]*)?)"
)

_STATE_CUES = {
    "sleeping": "eyes closed, calm and at rest, softly lit, peaceful expression",
    "working": "focused and alert, concentrating intently, eyes forward, determined",
    "happy": "warm genuine smile, pleased and satisfied, bright confident eyes",
    "stressed": "furrowed brow, tense and worried, strained concentration",
}

# Frontmatter colours map to a palette cue the model can actually act on.
_COLOUR_CUES = {
    "red": "deep red and ember tones",
    "yellow": "warm amber and gold tones",
    "green": "muted green and sage tones",
    "blue": "cool blue and steel tones",
    "purple": "violet and plum tones",
    "orange": "burnt orange and copper tones",
    "cyan": "teal and seafoam tones",
    "pink": "dusty rose tones",
}


def parse_agent_file(path: str | Path) -> dict:
    """Read an agent .md into a plain dict. Never raises on malformed input."""
    path = Path(path)
    text = path.read_text(encoding="utf-8", errors="replace")
    data: dict = {}

    if text.lstrip().startswith("---"):
        stripped = text.lstrip()
        end = stripped.find("\n---", 3)
        if end != -1:
            try:
                loaded = yaml.safe_load(stripped[3:end])
                if isinstance(loaded, dict):
                    data = loaded
            except yaml.YAMLError:
                data = {}

    return {
        "name": str(data.get("name") or path.stem),
        "description": str(data.get("description") or ""),
        "color": str(data.get("color") or ""),
    }


def _role_from_description(description: str, fallback: str) -> str:
    text = (description or "").strip()

    cut = len(text)
    for marker in _TRIGGER_MARKERS:
        found = text.find(marker)
        if found != -1:
            cut = min(cut, found)
    text = text[:cut].strip()

    for lead in _LEAD_INS:
        if text.startswith(lead):
            text = text[len(lead):]
            break

    # First sentence only; the rest is qualification, not subject.
    sentence = re.split(r"(?<=[.!?])\s+", text)[0].strip() if text else ""
    sentence = sentence.rstrip(".").strip()

    if not sentence:
        sentence = fallback.replace("-", " ")

    if len(sentence) > MAX_ROLE_CHARS:
        sentence = sentence[:MAX_ROLE_CHARS].rsplit(" ", 1)[0].rstrip(",;:")

    return sentence


def derive_identity(agent: dict) -> dict:
    description = agent.get("description", "")
    name = agent.get("name", "agent")

    match = _PERSON_RE.search(description)
    person = match.group(1).strip() if match else None

    role = _role_from_description(description, name)
    # The person's name is an identity, not a visual attribute; leaving it in
    # the role duplicates it and eats scarce CLIP tokens.
    if person:
        role = role.replace(person, "").replace("  ", " ").strip(" ,")

    return {
        "agent": name,
        "person": person,
        "role": role,
        "color": agent.get("color", ""),
    }


def load_appearances(path: str | Path) -> dict:
    """Load hand-written looks. Optional, and never fatal.

    Lives in its own file rather than in agent frontmatter on purpose: editing
    any agent `.md` triggers the mandatory /align-agents sync across 161 files,
    and the design requires zero edits there.
    """
    path = Path(path)
    if not path.exists():
        return {}
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8", errors="replace"))
    except yaml.YAMLError:
        return {}
    if not isinstance(loaded, dict):
        return {}

    out = {}
    for agent, value in loaded.items():
        if isinstance(value, str):
            out[str(agent)] = {"appearance": value}
        elif isinstance(value, dict):
            out[str(agent)] = value
    return out


def appearance_for(identity: dict, appearances: dict) -> dict:
    """Fold a hand-written look into an identity. Unlisted agents pass through."""
    entry = (appearances or {}).get(identity.get("agent")) or {}
    merged = dict(identity)

    look = str(entry.get("appearance") or "").strip()
    if look:
        # Capped for the same reason roles are: CLIP truncates at 77 tokens, and
        # an over-long look would push the state cue off the end -- collapsing
        # all four states into the same image.
        if len(look) > MAX_APPEARANCE_CHARS:
            look = look[:MAX_APPEARANCE_CHARS].rsplit(" ", 1)[0].rstrip(",;:")
        merged["appearance"] = look

    palette = str(entry.get("palette") or "").strip()
    if palette:
        merged["palette"] = palette

    return merged


def build_prompt(identity: dict, state: str) -> str:
    cue = _STATE_CUES.get(state, _STATE_CUES["working"])
    # A hand-written palette wins over the frontmatter colour: it was chosen for
    # how the portrait should look, not for how the agent is tagged.
    if identity.get("palette"):
        palette = identity["palette"]
    else:
        colour = (identity.get("color") or "").lower()
        # Keep the literal colour word alongside the descriptive cue: it is a
        # far stronger and more reliable token for the model than "amber" alone.
        colour_cue = _COLOUR_CUES.get(colour)
        palette = f"{colour}, {colour_cue}" if colour_cue else "muted desaturated tones"

    # A hand-written appearance is the whole point of the file: it beats text
    # scraped out of a description written for an agent router, not an artist.
    subject = (
        identity.get("appearance")
        or identity.get("role")
        or identity.get("agent", "specialist")
    )

    # Hand-written looks naturally start "a composed man..."; the template also
    # supplies the article, giving "a a composed man".
    if not re.match(r"(?i)^(a|an|the)\s", subject):
        subject = f"a {subject}"

    return ", ".join(
        [
            "stylized illustrated character bust portrait",
            subject,
            cue,
            palette,
            "painterly digital illustration, expressive stylised features",
            "head and shoulders only, centered, facing viewer",
            "plain dark background, soft rim lighting, consistent character design",
        ]
    )


def negative_prompt() -> str:
    return (
        "photo, photorealistic, 3d render, text, letters, watermark, signature, "
        "full body, hands, multiple people, crowd, blurry, lowres, deformed, "
        "extra limbs, busy background, frame, border"
    )
