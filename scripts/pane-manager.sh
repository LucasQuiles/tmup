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
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --pane-index) PANE_INDEX="$2"; shift 2 ;;
        --force) shift ;;
        *) die "Unknown option for release: $1" ;;
      esac
    done
    [[ -n "$PANE_INDEX" ]] || die "--pane-index required"
    [[ "$PANE_INDEX" =~ ^[0-9]+$ ]] || die "pane-index must be a non-negative integer"
    exec 9>"$LOCK_FILE"
    flock -w 5 9 || die "Failed to acquire grid state lock"
    _temp=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX") || { exec 9>&-; die "Failed to create temp file"; }
    if jq --argjson idx "$PANE_INDEX" \
      '(.panes[] | select(.index == $idx)) |= {index: .index, pane_id: .pane_id, status: "available"}' \
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
