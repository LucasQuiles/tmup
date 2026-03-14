#!/bin/bash
# validators.sh — Input validation functions for tmup plugin

if [[ -z "${CFG_TOTAL_PANES:-}" || -z "${CFG_PLUGIN_DIR:-}" ]]; then
  echo "validators.sh: config.sh must be sourced first" >&2
  return 1 2>/dev/null || exit 1
fi

validate_pane_index() {
  local idx="${1:-}"
  if [[ -z "$idx" ]] || ! [[ "$idx" =~ ^[0-9]+$ ]]; then
    echo "validate_pane_index: invalid '$idx' — must be 0..$((CFG_TOTAL_PANES - 1))" >&2
    return 1
  fi
  if [[ "$idx" -ge "$CFG_TOTAL_PANES" ]]; then
    echo "validate_pane_index: $idx out of range (max $((CFG_TOTAL_PANES - 1)))" >&2
    return 1
  fi
  return 0
}

validate_role() {
  local role="${1:-}"
  if [[ -z "$role" ]]; then
    echo "validate_role: role cannot be empty" >&2
    return 1
  fi
  if ! [[ "$role" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "validate_role: invalid '$role'" >&2
    return 1
  fi
  local agent_file="$CFG_PLUGIN_DIR/agents/${role}.md"
  if [[ ! -f "$agent_file" ]]; then
    echo "validate_role: unknown role '$role' (no $agent_file)" >&2
    return 1
  fi
  return 0
}

validate_working_dir() {
  local dir="${1:-}"
  if [[ -z "$dir" ]]; then echo "validate_working_dir: empty" >&2; return 1; fi
  if [[ ! -d "$dir" ]]; then echo "validate_working_dir: not a directory: $dir" >&2; return 1; fi
  if [[ ! -r "$dir" ]]; then echo "validate_working_dir: not readable: $dir" >&2; return 1; fi
  return 0
}
