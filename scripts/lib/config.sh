#!/bin/bash
# config.sh — Shared configuration loader for tmup plugin
# Reads config/policy.yaml via yq, falls back to defaults.

_cfg_this_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_cfg_scripts_dir="$(dirname "$_cfg_this_dir")"
_cfg_plugin_dir="$(dirname "$_cfg_scripts_dir")"

if [[ -z "${CFG_CONFIG_DIR:-}" ]]; then
  CFG_CONFIG_DIR="$_cfg_plugin_dir/config"
fi

_cfg_yq_warned=0
_cfg_read_yaml() {
  local file="$1" query="$2" default="$3"
  if ! command -v yq &>/dev/null; then
    if [[ $_cfg_yq_warned -eq 0 ]]; then
      echo "config.sh: yq not found — using built-in defaults for all config values" >&2
      _cfg_yq_warned=1
    fi
    echo "$default"
    return
  fi
  if [[ ! -f "$file" ]]; then
    echo "$default"
    return
  fi
  local val
  if ! val=$(yq -r "$query" "$file" 2>&1); then
    echo "config.sh: yq failed reading '$query' from $file: $val — using default '$default'" >&2
    echo "$default"
    return
  fi
  if [[ -n "$val" && "$val" != "null" ]]; then
    echo "$val"
    return
  fi
  echo "$default"
}

_cfg_validate_int() {
  local name="$1" val="$2" default="$3"
  if [[ "$val" =~ ^[0-9]+$ ]] && [[ "$val" -gt 0 ]]; then
    echo "$val"
  else
    if [[ "$val" != "$default" ]]; then
      echo "config.sh: invalid value for $name: '$val' — using default '$default'" >&2
    fi
    echo "$default"
  fi
}

# Grid config
_raw_rows=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.grid.rows // 2' "2")
_raw_cols=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.grid.cols // 4' "4")
_raw_width=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.grid.width // 240' "240")
_raw_height=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.grid.height // 55' "55")
_raw_prefix=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.grid.session_prefix // "tmup"' "tmup")
_raw_stale=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.dag.stale_max_age_seconds // 300' "300")
_raw_harvest=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.harvesting.capture_scrollback_lines // 500' "500")
_raw_trust_seconds=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.timeouts.dispatch_trust_prompt_seconds // 6' "6")
_raw_teardown_grace=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.timeouts.teardown_grace_seconds // 60' "60")

# Session name validation: alphanumeric, hyphens, underscores only. No path separators.
# Name = user-provided prefix (max 64 chars, matches TS SESSION_NAME_RE)
_cfg_validate_session_name() {
  local name="$1"
  if [[ -z "$name" ]]; then return 1; fi
  if [[ "$name" =~ [/\\] ]]; then return 1; fi
  if [[ ! "$name" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then return 1; fi
  return 0
}
# Session ID = generated identifier (max 71 chars, matches TS SESSION_ID_RE)
_cfg_validate_session_id() {
  local id="$1"
  if [[ -z "$id" ]]; then return 1; fi
  if [[ "$id" =~ [/\\] ]]; then return 1; fi
  if [[ ! "$id" =~ ^[a-zA-Z0-9_-]{1,71}$ ]]; then return 1; fi
  return 0
}

# Session name resolution — always initialize to prevent stale inheritance
CFG_SESSION_PREFIX="$_raw_prefix"
CFG_SESSION_NAME=""
if [[ -n "${TMUP_SESSION_NAME:-}" ]]; then
  if _cfg_validate_session_name "$TMUP_SESSION_NAME"; then
    CFG_SESSION_NAME="$TMUP_SESSION_NAME"
  else
    echo "config.sh: invalid TMUP_SESSION_NAME '${TMUP_SESSION_NAME}', ignoring" >&2
  fi
else
  _pointer_file="$HOME/.local/state/tmup/current-session"
  if [[ -f "$_pointer_file" ]]; then
    _raw_session=$(cat "$_pointer_file" 2>/dev/null) || _raw_session=""
    if [[ -n "$_raw_session" ]]; then
      if _cfg_validate_session_id "$_raw_session"; then
        CFG_SESSION_NAME="$_raw_session"
      else
        echo "config.sh: invalid session id in current-session pointer: '${_raw_session}', ignoring" >&2
      fi
    fi
    unset _raw_session
  fi
  unset _pointer_file
fi

CFG_ROWS=$(_cfg_validate_int "CFG_ROWS" "$_raw_rows" "2")
CFG_COLS=$(_cfg_validate_int "CFG_COLS" "$_raw_cols" "4")
CFG_WIDTH=$(_cfg_validate_int "CFG_WIDTH" "$_raw_width" "240")
CFG_HEIGHT=$(_cfg_validate_int "CFG_HEIGHT" "$_raw_height" "55")
CFG_STALE_MAX_AGE=$(_cfg_validate_int "CFG_STALE_MAX_AGE" "$_raw_stale" "300")
CFG_HARVEST_LINES=$(_cfg_validate_int "CFG_HARVEST_LINES" "$_raw_harvest" "500")
CFG_TRUST_SECONDS=$(_cfg_validate_int "CFG_TRUST_SECONDS" "$_raw_trust_seconds" "6")
CFG_TEARDOWN_GRACE=$(_cfg_validate_int "CFG_TEARDOWN_GRACE" "$_raw_teardown_grace" "60")

CFG_TOTAL_PANES=$((CFG_ROWS * CFG_COLS))
CFG_PLUGIN_DIR="$_cfg_plugin_dir"
CFG_STATE_ROOT="$HOME/.local/state/tmup"

# Detect config degradation: policy.yaml exists but yq is missing or broken.
# This probe runs in the current shell (not a subshell) so the flag persists.
CFG_CONFIG_DEGRADED=0
if [[ -f "$CFG_CONFIG_DIR/policy.yaml" ]]; then
  if ! command -v yq &>/dev/null; then
    CFG_CONFIG_DEGRADED=1
  elif ! yq -r '.grid.rows // empty' "$CFG_CONFIG_DIR/policy.yaml" &>/dev/null; then
    CFG_CONFIG_DEGRADED=1
  fi
fi

if [[ -n "${CFG_SESSION_NAME:-}" ]]; then
  CFG_STATE_DIR="$CFG_STATE_ROOT/$CFG_SESSION_NAME"
else
  CFG_STATE_DIR=""
fi

export CFG_SESSION_NAME CFG_SESSION_PREFIX CFG_ROWS CFG_COLS CFG_WIDTH CFG_HEIGHT
export CFG_STALE_MAX_AGE CFG_HARVEST_LINES CFG_TRUST_SECONDS CFG_TEARDOWN_GRACE
export CFG_TOTAL_PANES CFG_PLUGIN_DIR CFG_CONFIG_DIR CFG_STATE_DIR CFG_STATE_ROOT
export CFG_CONFIG_DEGRADED

unset _cfg_this_dir _cfg_scripts_dir _cfg_plugin_dir
unset _raw_rows _raw_cols _raw_width _raw_height _raw_prefix
unset _raw_stale _raw_harvest _raw_trust_seconds _raw_teardown_grace
unset _cfg_yq_warned
unset -f _cfg_read_yaml _cfg_validate_int _cfg_validate_session_name _cfg_validate_session_id
