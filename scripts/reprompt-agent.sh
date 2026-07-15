#!/bin/bash
# reprompt-agent.sh — Send follow-up prompt to a running Codex agent
# CLI wrapper around send_reprompt() from tmux-helpers.sh
set -euo pipefail
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH CDPATH
unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
unset PERL5OPT PERL5LIB PYTHONPATH PYTHONHOME RUBYOPT RUBYLIB

_tmup_resolve_script_dir() {
  local source_path="$1" source_dir link_target readlink_bin="" candidate hops=0
  for candidate in /usr/bin/readlink /bin/readlink; do
    [[ -x "$candidate" ]] && { readlink_bin="$candidate"; break; }
  done
  [[ -n "$readlink_bin" ]] || return 1
  while [[ -L "$source_path" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || return 1
    source_dir="${source_path%/*}"
    [[ "$source_dir" != "$source_path" ]] || source_dir="."
    source_dir=$(cd -P -- "$source_dir" && pwd -P) || return 1
    link_target=$("$readlink_bin" "$source_path") || return 1
    [[ "$link_target" == /* ]] && source_path="$link_target" || source_path="$source_dir/$link_target"
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
  echo "reprompt-agent.sh: trusted controller toolchain validation failed" >&2
  exit 1
}
source "$SCRIPT_DIR/lib/common.sh"

# Arity-aware pre-parse avoids treating prompt text as a boundary option.
_TMUP_PREFLIGHT_SESSION=""
_tmup_preparse_boundary_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session)
        [[ $# -ge 2 && -z "$_TMUP_PREFLIGHT_SESSION" ]] || return 1
        _TMUP_PREFLIGHT_SESSION="$2"
        shift 2
        ;;
      --pane|--prompt)
        [[ $# -ge 2 ]] || return 1
        shift 2
        ;;
      --all) shift ;;
      *) return 1 ;;
    esac
  done
}
_tmup_preparse_boundary_args "$@" || die "Invalid, duplicate, or incomplete reprompt arguments"
unset -f _tmup_preparse_boundary_args
if [[ -n "$_TMUP_PREFLIGHT_SESSION" ]]; then
  export TMUP_SESSION_NAME="$_TMUP_PREFLIGHT_SESSION"
fi

source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/portable-system.sh"
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

# --all mode: send same prompt to all verified-idle agent panes
if [[ "$ALL" == "true" ]]; then
  [[ -n "$PROMPT" ]] || die "--prompt required with --all"

  # Enumerate panes from live grid state, not CFG_TOTAL_PANES (which may be
  # stale or degraded). Fall back to config if grid state is missing.
  _GRID_STATE="$CFG_STATE_DIR/grid/grid-state.json"
  if ! _PANE_INDEXES=$(jq -r '.panes[].index' "$_GRID_STATE" 2>/dev/null); then
    _PANE_INDEXES=$(tmup_index_range "$CFG_TOTAL_PANES")
  fi

  sent=0
  failed=0
  skipped=0
  for i in $_PANE_INDEXES; do
    if ! cmd=$(get_pane_command "$SESSION_NAME" "$i" 2>/dev/null); then
      echo "Pane $i: target verification failed"
      failed=$((failed + 1))
      continue
    fi
    if ! is_agent_process "$cmd"; then
      echo "Pane $i: shell (skipped)"
      skipped=$((skipped + 1))
      continue
    fi
    if is_agent_idle "$SESSION_NAME" "$i"; then
      if send_reprompt "$SESSION_NAME" "$i" "$PROMPT" 2>/dev/null; then
        echo "Pane $i: sent"
        sent=$((sent + 1))
      else
        echo "Pane $i: failed"
        failed=$((failed + 1))
      fi
    else
      echo "Pane $i: busy (skipped)"
      skipped=$((skipped + 1))
    fi
  done
  echo "Sent to $sent panes"
  echo "TMUP_REPROMPT_SENT=$sent"
  echo "TMUP_REPROMPT_FAILED=$failed"
  echo "TMUP_REPROMPT_SKIPPED=$skipped"
  if [[ "$sent" -gt 0 && "$failed" -eq 0 ]]; then
    exit 0
  fi
  exit 1
fi

# Single-pane mode
[[ -n "$PANE_INDEX" ]] || die "--pane N required (or use --all)"
[[ -n "$PROMPT" ]] || die "--prompt required"
if send_reprompt "$SESSION_NAME" "$PANE_INDEX" "$PROMPT"; then
  echo "Sent to pane $PANE_INDEX"
  echo "TMUP_REPROMPT_SENT=1"
  echo "TMUP_REPROMPT_FAILED=0"
  echo "TMUP_REPROMPT_SKIPPED=0"
  exit 0
fi
echo "TMUP_REPROMPT_SENT=0"
echo "TMUP_REPROMPT_FAILED=1"
echo "TMUP_REPROMPT_SKIPPED=0"
exit 1
