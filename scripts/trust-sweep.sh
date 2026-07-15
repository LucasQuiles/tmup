#!/bin/bash
# trust-sweep.sh — Auto-accept trust prompts across all panes
# DEPRECATED: Global trust sweep is disabled by default.
# Per-pane trust acceptance is handled by dispatch-agent.sh.
# Use --force to run anyway.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/portable-system.sh"
source "$SCRIPT_DIR/lib/tmux-helpers.sh"

if [[ "${1:-}" != "--force" ]]; then
  echo "WARNING: Global trust sweep is deprecated. Per-pane trust handling is in dispatch-agent.sh." >&2
  echo "Use --force to run anyway." >&2
  exit 0
fi

SESSION_NAME="${CFG_SESSION_NAME:-}"
[[ -n "$SESSION_NAME" ]] || { echo "No active session" >&2; exit 1; }

ACCEPTED=0
# Prefer live grid-state.json over CFG_TOTAL_PANES — the live grid may have
# non-contiguous indexes or differ from current config.
_GRID_STATE="$CFG_STATE_DIR/grid/grid-state.json"
if ! _PANE_INDEXES=$(jq -r '.panes[].index' "$_GRID_STATE" 2>/dev/null); then
  _PANE_INDEXES=$(tmup_index_range "$CFG_TOTAL_PANES")
fi

for pane_idx in $_PANE_INDEXES; do
  if ! PANE_TARGET=$(tmup_exact_pane_target "$SESSION_NAME" "$pane_idx"); then
    echo "WARNING: Could not verify exact pane target for index $pane_idx" >&2
    continue
  fi
  CAPTURE=$(tmux capture-pane -t "$PANE_TARGET" -p -S -10 2>/dev/null || true)
  # Narrow pattern: only match the specific codex trust prompt ("Do you trust ...?")
  if echo "$CAPTURE" | grep -qiE "^[[:space:]]*Do you trust([[:space:]]|$)"; then
    tmux send-keys -t "$PANE_TARGET" Enter
    ACCEPTED=$((ACCEPTED + 1))
    echo "Accepted trust prompt in pane $pane_idx"
  fi
done

echo "Trust sweep complete: $ACCEPTED prompts accepted"
