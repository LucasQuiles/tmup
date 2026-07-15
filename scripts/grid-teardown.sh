#!/bin/bash
# grid-teardown.sh — Tear down a tmup tmux grid
set -euo pipefail
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH CDPATH
unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
unset PERL5OPT PERL5LIB PYTHONPATH PYTHONHOME RUBYOPT RUBYLIB

_tmup_resolve_script_dir() {
  local source_path="$1" source_dir link_target readlink_bin="" candidate hops=0
  for candidate in /usr/bin/readlink /bin/readlink; do
    if [[ -x "$candidate" ]]; then
      readlink_bin="$candidate"
      break
    fi
  done
  [[ -n "$readlink_bin" ]] || {
    echo "grid-teardown.sh: trusted system readlink is unavailable" >&2
    return 1
  }

  while [[ -L "$source_path" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || {
      echo "grid-teardown.sh: script symlink chain exceeds 40 hops" >&2
      return 1
    }
    source_dir="${source_path%/*}"
    [[ "$source_dir" != "$source_path" ]] || source_dir="."
    source_dir="$(cd -P -- "$source_dir" && pwd -P)" || return 1
    link_target="$("$readlink_bin" "$source_path")" || return 1
    if [[ "$link_target" == /* ]]; then
      source_path="$link_target"
    else
      source_path="$source_dir/$link_target"
    fi
  done

  source_dir="${source_path%/*}"
  [[ "$source_dir" != "$source_path" ]] || source_dir="."
  cd -P -- "$source_dir" && pwd -P
}

SCRIPT_DIR="$(_tmup_resolve_script_dir "${BASH_SOURCE[0]}")" || exit 1
unset -f _tmup_resolve_script_dir
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
source "$SCRIPT_DIR/lib/controller-bootstrap.sh"
tmup_controller_establish_toolchain "" "$PLUGIN_DIR" || {
  echo "grid-teardown.sh: trusted controller toolchain validation failed" >&2
  exit 1
}
source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/grid-identity.sh"
source "$SCRIPT_DIR/lib/grid-registry.sh"
source "$SCRIPT_DIR/lib/tmux-helpers.sh"
source "$SCRIPT_DIR/lib/control-boundary.sh"

SESSION_NAME="${CFG_SESSION_NAME:-}"
[[ -n "$SESSION_NAME" ]] || { echo "No active session" >&2; exit 1; }
SESSION_TARGET="=$SESSION_NAME"

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true
DESTRUCTIVE_SESSION_TARGET="$SESSION_TARGET"

if [[ "$FORCE" == "false" ]]; then
  if ! verify_complete_grid_receipt \
      "$SESSION_NAME" "$SESSION_TARGET" "$CFG_STATE_DIR" "$_REGISTRY_FILE"; then
    echo "ERROR: Refusing teardown without a complete matching live grid receipt. Inspect the exact session and use --force only for confirmed recovery." >&2
    exit 1
  fi
  DESTRUCTIVE_SESSION_TARGET="$TMUP_VERIFIED_SESSION_TARGET"
  echo "Verified live grid receipt for $SESSION_NAME ($DESTRUCTIVE_SESSION_TARGET)"
fi

# Both kill and deregister are attempted independently so partial failures
# don't leave the system in an inconsistent state
_teardown_errors=0
_control_cleanup_safe=0

cleanup_running_panes() {
  local pane_target pane_cmd

  while IFS=$'\t' read -r pane_target pane_cmd; do
    [[ -n "$pane_target" ]] || continue
    if is_agent_process "$pane_cmd"; then
      if respawn_pane "$pane_target"; then
        echo "Respawned pane to clear lingering $pane_cmd: $pane_target"
      else
        echo "ERROR: Failed to respawn pane $pane_target ($pane_cmd)" >&2
        _teardown_errors=$((_teardown_errors + 1))
      fi
    fi
  done < <(
    tmux list-panes -s -t "$DESTRUCTIVE_SESSION_TARGET" \
      -F '#{pane_id}\t#{pane_current_command}' 2>/dev/null || true
  )
}

verify_session_absent() {
  local listed_sessions status
  # has-session alone cannot distinguish "absent" from a tmux socket or
  # control-plane failure. A successful inventory must omit the exact name.
  # When the killed session was the server's last one, tmux exits 1 instead;
  # under the C locale, accept only its two documented absent-server forms.
  if listed_sessions=$(LC_ALL=C tmux list-sessions -F '#{session_name}' 2>&1); then
    ! printf '%s\n' "$listed_sessions" | grep -Fxq -- "$SESSION_NAME"
    return
  else
    status=$?
  fi

  [[ "$status" -eq 1 ]] || return 1
  case "$listed_sessions" in
    "no server running on "*|"failed to connect to server"*) return 0 ;;
    *) return 1 ;;
  esac
}

if tmux has-session -t "$DESTRUCTIVE_SESSION_TARGET" 2>/dev/null; then
  cleanup_running_panes
  if [[ "$FORCE" == "false" ]]; then
    if ! verify_complete_grid_receipt \
        "$SESSION_NAME" "$SESSION_TARGET" "$CFG_STATE_DIR" "$_REGISTRY_FILE"; then
      echo "ERROR: Grid receipt changed before destructive teardown; retaining all state" >&2
      exit 1
    fi
    DESTRUCTIVE_SESSION_TARGET="$TMUP_VERIFIED_SESSION_TARGET"
  fi
  if tmux kill-session -t "$DESTRUCTIVE_SESSION_TARGET" 2>/dev/null; then
    if ! verify_session_absent; then
      echo "ERROR: tmux session remains live after kill: $SESSION_NAME" >&2
      _teardown_errors=$((_teardown_errors + 1))
    else
      echo "Killed tmux session: $SESSION_NAME"
      _control_cleanup_safe=1
    fi
  else
    echo "ERROR: Failed to kill tmux session $SESSION_NAME" >&2
    _teardown_errors=$((_teardown_errors + 1))
  fi
else
  if verify_session_absent; then
    echo "Session $SESSION_NAME not found (absence verified)"
    _control_cleanup_safe=1
  else
    echo "ERROR: Could not positively verify tmux session absence: $SESSION_NAME" >&2
    _teardown_errors=$((_teardown_errors + 1))
  fi
fi

if [[ "$_control_cleanup_safe" -eq 1 ]]; then
  if registry_deregister "$SESSION_NAME"; then
    echo "Deregistered $SESSION_NAME from registry"
  else
    echo "ERROR: Failed to deregister $SESSION_NAME from registry" >&2
    _teardown_errors=$((_teardown_errors + 1))
  fi

  # Clean up current-session pointer only after exact session death is proven.
  _pointer_file="$CFG_STATE_ROOT/current-session"
  if [[ -f "$_pointer_file" ]]; then
    _current=$(cat "$_pointer_file" 2>/dev/null) || _current=""
    if [[ "$_current" == "$SESSION_NAME" ]]; then
      rm -f "$_pointer_file"
      echo "Cleared current-session pointer"
    fi
  fi

  if tmup_control_remove_session "$SESSION_NAME"; then
    echo "Removed protected controller state for $SESSION_NAME"
  else
    echo "ERROR: Refused unsafe protected controller-state cleanup for $SESSION_NAME" >&2
    _teardown_errors=$((_teardown_errors + 1))
  fi
else
  echo "ERROR: Retaining registry, current-session pointer, and protected controller state because exact session death was not verified: $SESSION_NAME" >&2
  _teardown_errors=$((_teardown_errors + 1))
fi

if [[ "$_teardown_errors" -gt 0 ]]; then
  echo "WARNING: Teardown completed with $_teardown_errors errors" >&2
  exit 1
fi
