"""Order of the portraits folder: env override, dev layout, flat fallback."""

from pathlib import Path

from portraits_dir import DEV_DIR, FLAT_DIR, resolve_portraits_dir


def test_env_override_wins():
    assert resolve_portraits_dir({"CLAUDE_CUSTOM_PORTRAITS": "X:/p"}, lambda p: True) == Path("X:/p")


def test_dev_path_wins_when_present():
    assert resolve_portraits_dir({}, lambda p: p == DEV_DIR) == DEV_DIR


def test_flat_fallback():
    assert resolve_portraits_dir({}, lambda p: False) == FLAT_DIR


def test_empty_env_ignored():
    assert resolve_portraits_dir({"CLAUDE_CUSTOM_PORTRAITS": ""}, lambda p: False) == FLAT_DIR
