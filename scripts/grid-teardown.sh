#!/bin/bash
# grid-teardown.sh — Tear down a tmup tmux grid
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/grid-identity.sh"
source "$SCRIPT_DIR/lib/grid-registry.sh"

SESSION_NAME="${CFG_SESSION_NAME:-}"
[[ -n "$SESSION_NAME" ]] || { echo "No active session" >&2; exit 1; }

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

if [[ "$FORCE" == "false" ]]; then
  validate_ownership || { echo "ERROR: Grid owned by another session. Use --force." >&2; exit 1; }
fi

# Both kill and deregister are attempted independently so partial failures
# don't leave the system in an inconsistent state
_teardown_errors=0

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if tmux kill-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Killed tmux session: $SESSION_NAME"
  else
    echo "ERROR: Failed to kill tmux session $SESSION_NAME" >&2
    _teardown_errors=$((_teardown_errors + 1))
  fi
else
  echo "Session $SESSION_NAME not found (already dead)"
fi

if registry_deregister "$SESSION_NAME"; then
  echo "Deregistered $SESSION_NAME from registry"
else
  echo "ERROR: Failed to deregister $SESSION_NAME from registry" >&2
  _teardown_errors=$((_teardown_errors + 1))
fi

# Clean up current-session pointer if it references the torn-down session
_pointer_file="$CFG_STATE_ROOT/current-session"
if [[ -f "$_pointer_file" ]]; then
  _current=$(cat "$_pointer_file" 2>/dev/null) || _current=""
  if [[ "$_current" == "$SESSION_NAME" ]]; then
    rm -f "$_pointer_file"
    echo "Cleared current-session pointer"
  fi
fi

if [[ "$_teardown_errors" -gt 0 ]]; then
  echo "WARNING: Teardown completed with $_teardown_errors errors" >&2
  exit 1
fi
