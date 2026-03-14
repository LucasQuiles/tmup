#!/bin/bash
# pane-manager.sh — Manage pane reservations in grid-state.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"

STATE_DIR="$CFG_STATE_DIR"
GRID_STATE="$STATE_DIR/grid/grid-state.json"
LOCK_FILE="$STATE_DIR/grid/grid-state.lock"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$GRID_STATE" ]] || die "Grid state not found: $GRID_STATE"

ACTION="${1:-}"
shift || true

case "$ACTION" in
  list)
    jq -r '.panes[] | "\(.index) \(.status) \(.role // "-") \(.agent_id // "-")"' "$GRID_STATE"
    ;;
  available)
    jq -r '[.panes[] | select(.status == "available")] | length' "$GRID_STATE"
    ;;
  release)
    PANE_INDEX=""
    AGENT_ID="${TMUP_AGENT_ID:-}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --pane-index) PANE_INDEX="$2"; shift 2 ;;
        --agent-id) AGENT_ID="$2"; shift 2 ;;
        --force) shift ;;
        *) die "Unknown option for release: $1" ;;
      esac
    done
    [[ -n "$PANE_INDEX" ]] || die "--pane-index required"
    [[ -n "$AGENT_ID" ]] || die "--agent-id required (or set TMUP_AGENT_ID)"
    [[ "$PANE_INDEX" =~ ^[0-9]+$ ]] || die "pane-index must be a non-negative integer"
    exec 9>"$LOCK_FILE"
    flock -w 5 9 || die "Failed to acquire grid state lock"
    _pane_state=$(jq -c --argjson idx "$PANE_INDEX" '.panes[] | select(.index == $idx)' "$GRID_STATE")
    [[ -n "$_pane_state" ]] || { exec 9>&-; die "Pane $PANE_INDEX not found in grid state"; }
    _pane_status=$(jq -r '.status // empty' <<< "$_pane_state")
    _pane_owner=$(jq -r '.agent_id // empty' <<< "$_pane_state")
    [[ "$_pane_status" == "reserved" ]] || { exec 9>&-; die "Pane $PANE_INDEX is not reserved (status: ${_pane_status:-unknown})"; }
    [[ "$_pane_owner" == "$AGENT_ID" ]] || {
      exec 9>&-
      die "Pane $PANE_INDEX is owned by ${_pane_owner:-no agent}; refusing release for $AGENT_ID"
    }
    _temp=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX") || { exec 9>&-; die "Failed to create temp file"; }
    if jq --argjson idx "$PANE_INDEX" --arg aid "$AGENT_ID" \
      '(.panes[] | select(.index == $idx and .status == "reserved" and .agent_id == $aid)) |= (.status = "available" | del(.role, .agent_id))' \
      "$GRID_STATE" > "$_temp" && [[ -s "$_temp" ]]; then
      mv "$_temp" "$GRID_STATE"
    else
      rm -f "$_temp"
      exec 9>&-
      die "Failed to update grid state for pane $PANE_INDEX release"
    fi
    exec 9>&-
    echo "Released pane $PANE_INDEX"
    ;;
  *)
    echo "Usage: pane-manager.sh <list|available|release> [options]" >&2
    exit 1
    ;;
esac
