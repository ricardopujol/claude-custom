"""Order of the portraits folder: env override, dev layout (when it holds the portraits), flat fallback."""

from pathlib import Path

from portraits_dir import DEV_DIR, FLAT_DIR, MARKER, resolve_portraits_dir


def dev_holds(p):
    return p == DEV_DIR / MARKER


def test_constants_hang_off_the_home_folder():
    assert FLAT_DIR == Path.home() / "VibeCode" / "agent-creator" / "portraits"
    assert DEV_DIR == Path.home() / "VibeCode" / "agent-creator" / "dev" / "portraits"
    assert MARKER == "appearances.yaml"


def test_env_override_wins():
    assert resolve_portraits_dir({"CLAUDE_CUSTOM_PORTRAITS": "X:/p"}, lambda p: True) == Path("X:/p")


def test_empty_env_ignored():
    assert resolve_portraits_dir({"CLAUDE_CUSTOM_PORTRAITS": ""}, lambda p: False) == FLAT_DIR


def test_dev_path_wins_when_it_holds_the_portraits():
    assert resolve_portraits_dir({}, dev_holds) == DEV_DIR


def test_both_present_dev_wins():
    assert resolve_portraits_dir({}, lambda p: True) == DEV_DIR


def test_flat_fallback():
    assert resolve_portraits_dir({}, lambda p: False) == FLAT_DIR


def test_dev_folder_without_the_marker_never_wins():
    assert resolve_portraits_dir({}, lambda p: p == DEV_DIR) == FLAT_DIR


def test_resolves_on_every_call():
    there = {"v": False}
    exists = lambda p: there["v"] and dev_holds(p)
    assert resolve_portraits_dir({}, exists) == FLAT_DIR
    there["v"] = True
    assert resolve_portraits_dir({}, exists) == DEV_DIR


def test_generate_reads_the_root_lazily():
    import generate
    assert generate.PORTRAITS_ROOT == resolve_portraits_dir()
    assert generate.APPEARANCES_FILE == resolve_portraits_dir() / MARKER
