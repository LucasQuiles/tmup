#!/bin/bash
# trust-sweep.sh — Auto-accept trust prompts across all panes
# DEPRECATED: Global trust sweep is disabled by default.
# Per-pane trust acceptance is handled by dispatch-agent.sh.
# Use --force to run anyway.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"

if [[ "${1:-}" != "--force" ]]; then
  echo "WARNING: Global trust sweep is deprecated. Per-pane trust handling is in dispatch-agent.sh." >&2
  echo "Use --force to run anyway." >&2
  exit 0
fi

SESSION_NAME="${CFG_SESSION_NAME:-}"
[[ -n "$SESSION_NAME" ]] || { echo "No active session" >&2; exit 1; }

ACCEPTED=0
for pane_idx in $(seq 0 $((CFG_TOTAL_PANES - 1))); do
  CAPTURE=$(tmux capture-pane -t "$SESSION_NAME:0.$pane_idx" -p -S -10 2>/dev/null || true)
  # Narrow pattern: only match the specific codex trust prompt ("Do you trust ...?")
  if echo "$CAPTURE" | grep -qiE "^\s*Do you trust\b"; then
    tmux send-keys -t "$SESSION_NAME:0.$pane_idx" Enter
    ACCEPTED=$((ACCEPTED + 1))
    echo "Accepted trust prompt in pane $pane_idx"
  fi
done

echo "Trust sweep complete: $ACCEPTED prompts accepted"
