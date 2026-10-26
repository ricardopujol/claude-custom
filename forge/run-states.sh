#!/bin/sh
# CLAUDE_CUSTOM_PORTRAITS, then the agent-creator dev layout, then the old flat path.
if [ -n "$CLAUDE_CUSTOM_PORTRAITS" ]; then P="$CLAUDE_CUSTOM_PORTRAITS"
elif [ -d "C:/Users/ricar/VibeCode/agent-creator/dev/portraits" ]; then P="C:/Users/ricar/VibeCode/agent-creator/dev/portraits"
else P="C:/Users/ricar/VibeCode/agent-creator/portraits"; fi
set -- \
  "mutation-tester:cand-02-seed1453702384.png" \
  "ui-ux-tester:cand-01-seed522764162.png" \
  "agent-organizer:cand-03-seed707192849.png" \
  "spec-partner:cand-02-seed1316820223.png" \
  "security-auditor:cand-01-seed3724674429.png" \
  "media-pipeline-engineer:cand-02-seed2269337240.png"
for pair in "$@"; do
  agent="${pair%%:*}"; base="${pair#*:}"
  echo "=== STATES $agent from $base"
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv/Scripts/python.exe states.py \
    --agent "$agent" --base "$P/$agent/candidates/$base" --offline || echo "=== FAILED $agent"
done
echo "=== ALL STATES DONE"
