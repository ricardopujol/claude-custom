"""Where the agent portraits live (agent-creator moved to a dev\ worktree layout).

Keep in step with host/portraits-dir.js and run-states.sh
(test/portraits-dir.test.js cross-checks the three).
"""

import os
from pathlib import Path

_ROOT = Path.home() / "VibeCode" / "agent-creator"
FLAT_DIR = _ROOT / "portraits"
DEV_DIR = _ROOT / "dev" / "portraits"
# A dev folder only counts once it holds the file the forge reads from it.
MARKER = "appearances.yaml"


def resolve_portraits_dir(env=None, exists=Path.exists) -> Path:
    """CLAUDE_CUSTOM_PORTRAITS, then the dev path if it holds the portraits, then the flat path."""
    env = os.environ if env is None else env
    if env.get("CLAUDE_CUSTOM_PORTRAITS"):
        return Path(env["CLAUDE_CUSTOM_PORTRAITS"])
    return DEV_DIR if exists(DEV_DIR / MARKER) else FLAT_DIR
