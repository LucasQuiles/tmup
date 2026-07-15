#!/bin/bash
# validators.sh — Input validation functions for tmup plugin

if [[ -z "${CFG_TOTAL_PANES:-}" || -z "${CFG_PLUGIN_DIR:-}" ]]; then
  echo "validators.sh: config.sh must be sourced first" >&2
  return 1 2>/dev/null || exit 1
fi

validate_pane_index() {
  local idx="${1:-}"
  if [[ -z "$idx" ]] || ! [[ "$idx" =~ ^[0-9]+$ ]]; then
    echo "validate_pane_index: invalid '$idx' — must be a non-negative integer" >&2
    return 1
  fi
  # Prefer live grid-state.json as the source of truth — check whether the
  # specific index exists in the pane array (indexes need not be contiguous).
  # Fall back to CFG_TOTAL_PANES range check only when grid state is absent.
  if [[ -n "${CFG_STATE_DIR:-}" && -f "$CFG_STATE_DIR/grid/grid-state.json" ]]; then
    local _found
    _found=$(jq -r --argjson idx "$idx" '[.panes[] | select(.index == $idx)] | length' "$CFG_STATE_DIR/grid/grid-state.json" 2>/dev/null)
    if [[ "$_found" =~ ^[0-9]+$ ]]; then
      if [[ "$_found" -eq 0 ]]; then
        local _valid_indexes
        _valid_indexes=$(jq -r '[.panes[].index] | join(",")' "$CFG_STATE_DIR/grid/grid-state.json" 2>/dev/null)
        echo "validate_pane_index: $idx not in live grid (valid indexes: $_valid_indexes)" >&2
        return 1
      fi
      return 0
    fi
  fi
  # No live grid state — fall back to config-based range check
  if [[ "$idx" -ge "$CFG_TOTAL_PANES" ]]; then
    echo "validate_pane_index: $idx out of range (max $((CFG_TOTAL_PANES - 1)), source: config)" >&2
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
