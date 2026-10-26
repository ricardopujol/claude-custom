"""Where the agent portraits live (agent-creator moved to a dev\ worktree layout)."""

import os
from pathlib import Path

FLAT_DIR = Path(r"C:\Users\ricar\VibeCode\agent-creator\portraits")
DEV_DIR = Path(r"C:\Users\ricar\VibeCode\agent-creator\dev\portraits")


def resolve_portraits_dir(env=None, exists=Path.exists) -> Path:
    """CLAUDE_CUSTOM_PORTRAITS, then the dev path if it exists, then the flat path."""
    env = os.environ if env is None else env
    if env.get("CLAUDE_CUSTOM_PORTRAITS"):
        return Path(env["CLAUDE_CUSTOM_PORTRAITS"])
    return DEV_DIR if exists(DEV_DIR) else FLAT_DIR
