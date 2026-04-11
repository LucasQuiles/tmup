#!/bin/bash
# reprompt-agent.sh — Send follow-up prompt to a running Codex agent
# CLI wrapper around send_reprompt() from tmux-helpers.sh
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pre-parse --session before sourcing config (which reads TMUP_SESSION_NAME)
_prev_arg=""
for _arg in "$@"; do
  if [[ "$_prev_arg" == "--session" ]]; then
    export TMUP_SESSION_NAME="$_arg"
    break
  fi
  _prev_arg="$_arg"
done
unset _arg _prev_arg

source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/tmux-helpers.sh"
if [[ "${CFG_CONFIG_DEGRADED:-0}" -eq 1 ]]; then
  die "Cannot reprompt — policy.yaml exists but could not be read (yq missing or broken)."
fi



SESSION_NAME="$CFG_SESSION_NAME"
[[ -n "$SESSION_NAME" ]] || die "No active session (set TMUP_SESSION_NAME or create current-session pointer)"
PANE_INDEX=""
PROMPT=""
ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pane) PANE_INDEX="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --all) ALL=true; shift ;;
    --session) shift 2 ;; # already consumed above
    *) die "Unknown argument: $1" ;;
  esac
done

# --all mode: send same prompt to ALL idle/queueable agent panes
if [[ "$ALL" == "true" ]]; then
  [[ -n "$PROMPT" ]] || die "--prompt required with --all"

  # Enumerate panes from live grid state, not CFG_TOTAL_PANES (which may be
  # stale or degraded). Fall back to config if grid state is missing.
  _GRID_STATE="$CFG_STATE_DIR/grid/grid-state.json"
  _PANE_INDEXES=$(jq -r '.panes[].index' "$_GRID_STATE" 2>/dev/null) || _PANE_INDEXES=$(seq 0 $((CFG_TOTAL_PANES - 1)))

  sent=0
  for i in $_PANE_INDEXES; do
    cmd=$(get_pane_command "$SESSION_NAME" "$i" 2>/dev/null) || continue
    if ! is_agent_process "$cmd"; then echo "Pane $i: shell (skipped)"; continue; fi
    if is_agent_idle "$SESSION_NAME" "$i" || is_agent_queueable "$SESSION_NAME" "$i"; then
      if send_reprompt "$SESSION_NAME" "$i" "$PROMPT" 2>/dev/null; then
        echo "Pane $i: sent"
        sent=$((sent + 1))
      else
        echo "Pane $i: failed"
      fi
    else
      echo "Pane $i: busy (skipped)"
    fi
  done
  echo "Sent to $sent panes"
  exit 0
fi

# Single-pane mode
[[ -n "$PANE_INDEX" ]] || die "--pane N required (or use --all)"
[[ -n "$PROMPT" ]] || die "--prompt required"
send_reprompt "$SESSION_NAME" "$PANE_INDEX" "$PROMPT"
echo "Sent to pane $PANE_INDEX"
