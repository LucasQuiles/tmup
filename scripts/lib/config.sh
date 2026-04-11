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

_cfg_validate_bool() {
  local name="$1" val="$2" default="$3"
  case "$val" in
    true|false) echo "$val" ;;
    *)
      if [[ "$val" != "$default" ]]; then
        echo "config.sh: invalid value for $name: '$val' — using default '$default'" >&2
      fi
      echo "$default"
      ;;
  esac
}

_cfg_validate_enum() {
  local name="$1" val="$2" default="$3"
  shift 3
  local allowed
  for allowed in "$@"; do
    if [[ "$val" == "$allowed" ]]; then
      echo "$val"
      return
    fi
  done
  if [[ "$val" != "$default" ]]; then
    echo "config.sh: invalid value for $name: '$val' — using default '$default'" >&2
  fi
  echo "$default"
}

_cfg_validate_nonempty() {
  local name="$1" val="$2" default="$3"
  if [[ -n "$val" && "$val" != "null" ]]; then
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
_raw_heartbeat_interval=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.dag.heartbeat_interval_seconds // 60' "60")
_raw_claimed_warning=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.dag.claimed_duration_warning_seconds // 1800' "1800")
_raw_reprompt_timeout=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.timeouts.send_reprompt_seconds // 10' "10")
_raw_codex_model=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.model // "gpt-5.4"' "gpt-5.4")
_raw_codex_context_window=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.context_window // 1050000' "1050000")
_raw_codex_auto_compact=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.auto_compact_token_limit // 750000' "750000")
_raw_codex_approval_policy=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.approval_policy // "never"' "never")
_raw_codex_sandbox=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.sandbox // "danger-full-access"' "danger-full-access")
_raw_codex_no_alt_screen=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.no_alt_screen // true' "true")
_raw_codex_plan_first=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.plan_first // true' "true")
_raw_codex_reasoning_effort=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.reasoning_effort // "high"' "high")
_raw_codex_reasoning_summary=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.reasoning_summary // "low"' "low")
_raw_codex_plan_reasoning=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.plan_mode_reasoning_effort // "xhigh"' "xhigh")
_raw_codex_verbosity=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.verbosity // "low"' "low")
_raw_codex_service_tier=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.service_tier // "fast"' "fast")
_raw_codex_tool_output_limit=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.tool_output_token_limit // 50000' "50000")
_raw_codex_web_search=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.web_search // "live"' "live")
_raw_codex_history=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.history_persistence // "save-all"' "save-all")
_raw_codex_undo=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.enable_undo // true' "true")
_raw_codex_shell_inherit=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.shell_env_inherit // "all"' "all")
_raw_codex_shell_snapshot=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.shell_snapshot // true' "true")
_raw_codex_request_compression=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.enable_request_compression // true' "true")
_raw_codex_notifications=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.notifications // true' "true")
_raw_codex_background_terminal_timeout=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.background_terminal_max_timeout // 600000' "600000")
_raw_codex_max_threads=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.subagents.max_threads // 6' "6")
_raw_codex_max_depth=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.subagents.max_depth // 2' "2")
_raw_codex_job_timeout=$(_cfg_read_yaml "$CFG_CONFIG_DIR/policy.yaml" '.codex.subagents.job_max_runtime_seconds // 3600' "3600")

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
CFG_HEARTBEAT_INTERVAL=$(_cfg_validate_int "CFG_HEARTBEAT_INTERVAL" "$_raw_heartbeat_interval" "60")
CFG_CLAIMED_WARNING=$(_cfg_validate_int "CFG_CLAIMED_WARNING" "$_raw_claimed_warning" "1800")
CFG_REPROMPT_TIMEOUT=$(_cfg_validate_int "CFG_REPROMPT_TIMEOUT" "$_raw_reprompt_timeout" "10")
CFG_CODEX_MODEL=$(_cfg_validate_nonempty "CFG_CODEX_MODEL" "$_raw_codex_model" "gpt-5.4")
CFG_CODEX_CONTEXT_WINDOW=$(_cfg_validate_int "CFG_CODEX_CONTEXT_WINDOW" "$_raw_codex_context_window" "1050000")
CFG_CODEX_AUTO_COMPACT=$(_cfg_validate_int "CFG_CODEX_AUTO_COMPACT" "$_raw_codex_auto_compact" "750000")
CFG_CODEX_APPROVAL_POLICY=$(_cfg_validate_enum "CFG_CODEX_APPROVAL_POLICY" "$_raw_codex_approval_policy" "never" "untrusted" "on-failure" "on-request" "never")
CFG_CODEX_SANDBOX=$(_cfg_validate_enum "CFG_CODEX_SANDBOX" "$_raw_codex_sandbox" "danger-full-access" "read-only" "workspace-write" "danger-full-access")
CFG_CODEX_NO_ALT_SCREEN=$(_cfg_validate_bool "CFG_CODEX_NO_ALT_SCREEN" "$_raw_codex_no_alt_screen" "true")
CFG_CODEX_PLAN_FIRST=$(_cfg_validate_bool "CFG_CODEX_PLAN_FIRST" "$_raw_codex_plan_first" "true")
CFG_CODEX_REASONING_EFFORT=$(_cfg_validate_enum "CFG_CODEX_REASONING_EFFORT" "$_raw_codex_reasoning_effort" "high" "none" "minimal" "low" "medium" "high" "xhigh")
CFG_CODEX_REASONING_SUMMARY=$(_cfg_validate_enum "CFG_CODEX_REASONING_SUMMARY" "$_raw_codex_reasoning_summary" "low" "low" "medium" "high")
CFG_CODEX_PLAN_REASONING=$(_cfg_validate_enum "CFG_CODEX_PLAN_REASONING" "$_raw_codex_plan_reasoning" "xhigh" "none" "minimal" "low" "medium" "high" "xhigh")
CFG_CODEX_VERBOSITY=$(_cfg_validate_enum "CFG_CODEX_VERBOSITY" "$_raw_codex_verbosity" "low" "low" "medium" "high")
CFG_CODEX_SERVICE_TIER=$(_cfg_validate_enum "CFG_CODEX_SERVICE_TIER" "$_raw_codex_service_tier" "fast" "flex" "fast")
CFG_CODEX_TOOL_OUTPUT_LIMIT=$(_cfg_validate_int "CFG_CODEX_TOOL_OUTPUT_LIMIT" "$_raw_codex_tool_output_limit" "50000")
CFG_CODEX_WEB_SEARCH=$(_cfg_validate_enum "CFG_CODEX_WEB_SEARCH" "$_raw_codex_web_search" "live" "disabled" "cached" "live")
CFG_CODEX_HISTORY=$(_cfg_validate_enum "CFG_CODEX_HISTORY" "$_raw_codex_history" "save-all" "save-all" "none")
CFG_CODEX_UNDO=$(_cfg_validate_bool "CFG_CODEX_UNDO" "$_raw_codex_undo" "true")
CFG_CODEX_SHELL_INHERIT=$(_cfg_validate_enum "CFG_CODEX_SHELL_INHERIT" "$_raw_codex_shell_inherit" "all" "all" "core" "none")
CFG_CODEX_SHELL_SNAPSHOT=$(_cfg_validate_bool "CFG_CODEX_SHELL_SNAPSHOT" "$_raw_codex_shell_snapshot" "true")
CFG_CODEX_REQUEST_COMPRESSION=$(_cfg_validate_bool "CFG_CODEX_REQUEST_COMPRESSION" "$_raw_codex_request_compression" "true")
CFG_CODEX_NOTIFICATIONS=$(_cfg_validate_bool "CFG_CODEX_NOTIFICATIONS" "$_raw_codex_notifications" "true")
CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT=$(_cfg_validate_int "CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT" "$_raw_codex_background_terminal_timeout" "600000")
CFG_CODEX_MAX_THREADS=$(_cfg_validate_int "CFG_CODEX_MAX_THREADS" "$_raw_codex_max_threads" "6")
CFG_CODEX_MAX_DEPTH=$(_cfg_validate_int "CFG_CODEX_MAX_DEPTH" "$_raw_codex_max_depth" "2")
CFG_CODEX_JOB_TIMEOUT=$(_cfg_validate_int "CFG_CODEX_JOB_TIMEOUT" "$_raw_codex_job_timeout" "3600")

if [[ "$CFG_CODEX_CONTEXT_WINDOW" -le 1 ]]; then
  echo "config.sh: CFG_CODEX_CONTEXT_WINDOW '$CFG_CODEX_CONTEXT_WINDOW' must be greater than 1 — using default '1050000'" >&2
  CFG_CODEX_CONTEXT_WINDOW="1050000"
fi

if [[ "$CFG_CODEX_AUTO_COMPACT" -ge "$CFG_CODEX_CONTEXT_WINDOW" ]]; then
  _cfg_auto_compact_safe="750000"
  if [[ "$_cfg_auto_compact_safe" -ge "$CFG_CODEX_CONTEXT_WINDOW" ]]; then
    _cfg_auto_compact_safe=$((CFG_CODEX_CONTEXT_WINDOW - 1))
  fi
  if [[ "$_cfg_auto_compact_safe" -lt 1 ]]; then
    _cfg_auto_compact_safe=1
  fi
  echo "config.sh: CFG_CODEX_AUTO_COMPACT '$CFG_CODEX_AUTO_COMPACT' must be lower than CFG_CODEX_CONTEXT_WINDOW '$CFG_CODEX_CONTEXT_WINDOW' — using '$_cfg_auto_compact_safe'" >&2
  CFG_CODEX_AUTO_COMPACT="$_cfg_auto_compact_safe"
fi

if [[ "$CFG_CODEX_MAX_THREADS" -gt 12 ]]; then
  echo "config.sh: CFG_CODEX_MAX_THREADS '$CFG_CODEX_MAX_THREADS' exceeds hard cap '12' — using '12'" >&2
  CFG_CODEX_MAX_THREADS="12"
fi

if [[ "$CFG_CODEX_MAX_DEPTH" -gt 3 ]]; then
  echo "config.sh: CFG_CODEX_MAX_DEPTH '$CFG_CODEX_MAX_DEPTH' exceeds hard cap '3' — using '3'" >&2
  CFG_CODEX_MAX_DEPTH="3"
fi

if [[ "$CFG_CODEX_TOOL_OUTPUT_LIMIT" -gt 200000 ]]; then
  echo "config.sh: CFG_CODEX_TOOL_OUTPUT_LIMIT '$CFG_CODEX_TOOL_OUTPUT_LIMIT' exceeds hard cap '200000' — using '200000'" >&2
  CFG_CODEX_TOOL_OUTPUT_LIMIT="200000"
fi

if [[ "$CFG_CODEX_JOB_TIMEOUT" -gt 7200 ]]; then
  echo "config.sh: CFG_CODEX_JOB_TIMEOUT '$CFG_CODEX_JOB_TIMEOUT' exceeds hard cap '7200' — using '7200'" >&2
  CFG_CODEX_JOB_TIMEOUT="7200"
fi

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
export CFG_HEARTBEAT_INTERVAL CFG_CLAIMED_WARNING CFG_REPROMPT_TIMEOUT
export CFG_CODEX_MODEL CFG_CODEX_CONTEXT_WINDOW CFG_CODEX_AUTO_COMPACT CFG_CODEX_APPROVAL_POLICY
export CFG_CODEX_SANDBOX CFG_CODEX_NO_ALT_SCREEN CFG_CODEX_PLAN_FIRST
export CFG_CODEX_REASONING_EFFORT CFG_CODEX_REASONING_SUMMARY CFG_CODEX_PLAN_REASONING
export CFG_CODEX_VERBOSITY CFG_CODEX_SERVICE_TIER CFG_CODEX_TOOL_OUTPUT_LIMIT
export CFG_CODEX_WEB_SEARCH CFG_CODEX_HISTORY CFG_CODEX_UNDO CFG_CODEX_SHELL_INHERIT
export CFG_CODEX_SHELL_SNAPSHOT CFG_CODEX_REQUEST_COMPRESSION CFG_CODEX_NOTIFICATIONS
export CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT CFG_CODEX_MAX_THREADS CFG_CODEX_MAX_DEPTH
export CFG_CODEX_JOB_TIMEOUT
export CFG_TOTAL_PANES CFG_PLUGIN_DIR CFG_CONFIG_DIR CFG_STATE_DIR CFG_STATE_ROOT
export CFG_CONFIG_DEGRADED

unset _cfg_this_dir _cfg_scripts_dir _cfg_plugin_dir
unset _raw_rows _raw_cols _raw_width _raw_height _raw_prefix
unset _raw_stale _raw_harvest _raw_trust_seconds _raw_teardown_grace
unset _raw_heartbeat_interval _raw_claimed_warning _raw_reprompt_timeout
unset _raw_codex_model _raw_codex_context_window _raw_codex_auto_compact _raw_codex_approval_policy
unset _raw_codex_sandbox _raw_codex_no_alt_screen _raw_codex_plan_first
unset _raw_codex_reasoning_effort _raw_codex_reasoning_summary _raw_codex_plan_reasoning
unset _raw_codex_verbosity _raw_codex_service_tier _raw_codex_tool_output_limit _raw_codex_web_search
unset _raw_codex_history _raw_codex_undo _raw_codex_shell_inherit _raw_codex_shell_snapshot
unset _raw_codex_request_compression _raw_codex_notifications _raw_codex_background_terminal_timeout
unset _raw_codex_max_threads _raw_codex_max_depth _raw_codex_job_timeout
unset _cfg_auto_compact_safe
unset _cfg_yq_warned
unset -f _cfg_read_yaml _cfg_validate_int _cfg_validate_bool _cfg_validate_enum _cfg_validate_nonempty
unset -f _cfg_validate_session_name _cfg_validate_session_id
