#!/bin/bash
# prerequisites.sh — Verify required tools are installed

check_prerequisites() {
  local missing=()

  command -v tmux &>/dev/null || missing+=("tmux")
  command -v node &>/dev/null || missing+=("node")
  command -v jq &>/dev/null || missing+=("jq")

  # yq is required when shipped config/policy.yaml exists.
  # Preflight should reject both missing and non-functional yq so the user
  # fails before runtime falls back to degraded config handling.
  local _prereq_plugin_dir
  local _prereq_policy_file
  _prereq_plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  _prereq_policy_file="${CFG_CONFIG_DIR:-$_prereq_plugin_dir/config}/policy.yaml"
  if [[ -f "$_prereq_policy_file" ]]; then
    if ! command -v yq &>/dev/null; then
      missing+=("yq")
    elif ! yq -r '.grid.rows // empty' "$_prereq_policy_file" &>/dev/null; then
      missing+=("yq")
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required tools: ${missing[*]}" >&2
    return 1
  fi

  # Check tmux version >= 3.0 (needed for split-window with command)
  local tmux_ver
  tmux_ver=$(tmux -V 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+)?' | head -1) || tmux_ver="0.0"
  local major="${tmux_ver%%.*}"
  if [[ "$major" -lt 3 ]]; then
    echo "ERROR: tmux >= 3.0 required (found $tmux_ver)" >&2
    return 1
  fi

  return 0
}
