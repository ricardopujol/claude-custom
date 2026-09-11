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

# DESCRIBE THE FACE, NOT THE FEELING.
#
# The first version of these named emotions -- "pleased and satisfied",
# "concentrating intently". None of that is drawable, and it showed: across
# img2img at two denoise levels AND txt2img, all four states rendered the same
# neutral face while identity scored 0.947-0.996. The cue was being ignored
# because it described an internal state rather than a configuration of muscles.
#
# Same lesson as the art direction, one level down: say it in the register that
# renders. Mouths, brows, eyelids, cheeks -- things an illustrator would draw.
_STATE_CUES = {
    "sleeping": "eyes fully closed, eyelids down, head tilted slightly down, "
                "mouth relaxed and slightly open, face slack and soft",
    "working": "brows drawn together, eyes narrowed and fixed straight ahead, "
               "lips pressed into a thin line, jaw set",
    "happy": "broad open smile, teeth visible, corners of the mouth pulled up, "
             "cheeks raised, eyes crinkled at the outer corners",
    "stressed": "deep vertical frown line between the brows, brows pulled low, "
                "mouth turned down at the corners, jaw clenched, neck tendons taut",
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


# ONE art direction for all 161 agents. Per-agent entries describe the SUBJECT;
# everything about how it is drawn, framed and lit lives here so it cannot drift
# between agents. Tunable once, in the `_style:` block of appearances.yaml.
#
# WRITE THIS IN PAINTING VOCABULARY, NOT PHOTOGRAPHIC OR SCULPTURAL.
#
# Measured, plain SDXL, fixed seed, mean HSV saturation (bare subject = 82.7):
#
#   art only ("painterly ... brush texture")     77.2   fine
#   shot only ("head and shoulders BUST")        18.0
#   lighting only ("soft RIM LIGHTING")          10.9
#   background only ("dark CHARCOAL background")  9.7
#   all three together                            4.3   <- 95% collapse
#   same instructions in painting words          88.1
#   ... plus "rich saturated colour"            108.0
#
# "bust" is sculpture, "rim lighting" is studio photography, "charcoal" is a
# drawing medium. Each drags the image toward stone, studio light and graphite,
# and together they produced thirteen consecutive monochrome portraits that
# looked like a model problem. Saying the SAME things as a painter does costs
# nothing and gains everything.
#
# Dropping framing and lighting entirely scored 103.6 -- WORSE than keeping
# them at 108.0 -- so they earn their place; only the register was wrong.
DEFAULT_STYLE = {
    "art": "painterly digital illustration, visible brush texture, stylised features",
    "colour": "rich saturated colour",
    "shot": "head and shoulders portrait, centered, facing viewer",
    "lighting": "soft warm light from the upper left",
    "background": "plain deep muted background, no scenery",
    # The few load-bearing words repeated into the FIRST text encoder.
    #
    # Measured from real output: with the art direction only in encoder 2, SDXL
    # ignored framing, background and palette -- the first portrait came back in
    # three-quarter profile on a light grey ground, against "facing viewer" and
    # "plain dark charcoal background". Encoder 1 (CLIP-L) carries much of the
    # compositional signal, so these must appear there too. Kept deliberately
    # short: it shares encoder 1's 77-token budget with the whole description.
    "core": "painterly illustration, rich colour, facing viewer",
}

STYLE_KEY = "_style"

# Words that belong to the SHARED art direction, not to one agent. An entry
# containing them silently fights the global block, and the result reads as
# "the model is inconsistent" rather than "this one entry overrode it".
_CONFLICT_TERMS = {
    "framing": ("full body", "full-body", "close-up", "closeup", "wide shot",
                "from behind", "profile view", "background", "landscape"),
    "art style": ("watercolor", "watercolour", "oil painting", "pixel art",
                  "3d render", "photorealistic", "photograph", "anime", "sketch",
                  "vector", "line art"),
    "expression": ("smiling", "smile", "grinning", "frowning", "angry", "sad",
                   "laughing", "crying", "cheerful", "worried", "asleep",
                   "eyes closed"),
}


def load_style(path: str | Path) -> dict:
    """Read the shared `_style:` block, filling any missing key from defaults."""
    style = dict(DEFAULT_STYLE)
    path = Path(path)
    if not path.exists():
        return style
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8", errors="replace"))
    except yaml.YAMLError:
        return style
    if isinstance(loaded, dict) and isinstance(loaded.get(STYLE_KEY), dict):
        for key, value in loaded[STYLE_KEY].items():
            if key in style and str(value).strip():
                style[key] = str(value).strip()
    return style


def style_conflicts(appearance: str) -> list[str]:
    """Terms in a per-agent look that belong to the global art direction.

    A lint, not an error: the text still generates. It exists because these
    conflicts are invisible in the output -- you see an inconsistent roster, not
    the one entry that caused it.
    """
    lowered = f" {str(appearance or '').lower()} "
    found = []
    for category, terms in _CONFLICT_TERMS.items():
        for term in terms:
            if term in lowered:
                found.append(f"{category}: '{term}'")
    return found


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
        # `_style` shares the file with agent entries; leaking it into the
        # roster would try to generate a portrait of an agent called "_style".
        if str(agent) == STYLE_KEY:
            continue
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


def resolve_palette(identity: dict) -> str:
    """The agent's palette, hand-written if given, else from frontmatter colour.

    A standalone function rather than a side effect of build_prompt: both
    encoders need it, and deriving it in one and reading it from the other makes
    call order load-bearing -- get it wrong and the palette vanishes silently,
    which is the failure mode this whole session keeps tripping over.
    """
    if identity.get("palette"):
        return identity["palette"]
    colour = (identity.get("color") or "").lower()
    cue = _COLOUR_CUES.get(colour)
    # Keep the literal colour word alongside the descriptive cue: it is a far
    # stronger and more reliable token for the model than "amber" alone.
    return f"{colour}, {cue}" if cue else "muted desaturated tones"


def build_prompt(identity: dict, state: str, style: dict | None = None) -> str:
    style = {**DEFAULT_STYLE, **(style or {})}
    cue = _STATE_CUES.get(state, _STATE_CUES["working"])
    palette = resolve_palette(identity)

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

    # SUBJECT ONLY. The shared art direction goes to SDXL's second text encoder
    # via build_style_prompt().
    #
    # Measured with the real CLIP tokenizer: subject + state + palette + style
    # in one string came to 99 tokens against a hard limit of 77. Because the
    # style sat last, truncation ate THE ART DIRECTION -- by a different amount
    # for each agent, which is precisely how a roster stops looking like a set.
    # Tightening cannot rescue it: the style block alone is ~44 tokens, leaving
    # ~15 for a description. SDXL has two text encoders, each with its own 77
    # budget, so the two concerns get one each and neither can truncate the
    # other.
    return ", ".join([subject, cue, palette, style["core"]])


def build_state_prompt(identity: dict, state: str) -> str:
    """Prompt for an img2img STATE pass -- expression only.

    Deliberately omits the appearance. The base image already carries the face;
    restating it puts ~50 tokens of neutral description in competition with one
    expression clause, and the expression loses. Measured: at denoise 0.45 and
    again at 0.62, all four states came back with the same neutral face.
    """
    cue = _STATE_CUES.get(state, _STATE_CUES["working"])
    return f"{cue}, same character, same framing"


def build_style_prompt(style: dict | None = None, palette: str | None = None) -> str:
    """The shared art direction, plus the agent's palette.

    Fed to SDXL's second text encoder (`prompt_2`) so a long appearance can
    never push it out of the context window.

    The palette belongs here as well as in the subject prompt. `prompt_2` drives
    SDXL's POOLED embedding, which governs global tone -- and with the palette
    only in encoder 1, every one of the first 13 test images came out
    monochrome while the pooled text said "charcoal", "dark" and "soft
    lighting". Telling the pooled embedding grey and the other encoder crimson
    gets grey.

    The art direction itself stays byte-identical for every agent; only the
    palette varies, which is per-agent by design.
    """
    style = {**DEFAULT_STYLE, **(style or {})}
    parts = [style["art"], style["colour"], style["shot"], style["lighting"],
             style["background"], "consistent character design"]
    if palette:
        parts.insert(1, palette)
    return ", ".join(parts)


def negative_prompt() -> str:
    return (
        "photo, photorealistic, 3d render, text, letters, watermark, signature, "
        "full body, hands, multiple people, crowd, blurry, lowres, deformed, "
        "extra limbs, busy background, frame, border"
    )
