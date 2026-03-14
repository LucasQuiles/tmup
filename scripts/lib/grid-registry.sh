#!/bin/bash
# grid-registry.sh — Multi-grid registry for tmup (project-to-session mapping)

_REGISTRY_FILE="$HOME/.local/state/tmup/registry.json"
_REGISTRY_LOCK="$HOME/.local/state/tmup/registry.lock"

_registry_init() {
  mkdir -p "$(dirname "$_REGISTRY_FILE")"
  if [[ ! -f "$_REGISTRY_FILE" ]] || ! jq empty "$_REGISTRY_FILE" 2>/dev/null; then
    echo '{"sessions":{}}' > "$_REGISTRY_FILE"
  fi
}

registry_register() {
  local session_name="$1" project_dir="$2" db_path="${3:-}"
  _registry_init
  # Canonicalize project_dir via realpath — fail closed if directory is invalid
  local _canon
  _canon=$(realpath "$project_dir" 2>/dev/null) || _canon=""
  if [[ -z "$_canon" ]]; then
    _canon=$(cd "$project_dir" 2>/dev/null && pwd -P) || _canon=""
  fi
  if [[ -z "$_canon" || ! -d "$_canon" ]]; then
    echo "grid-registry: failed to canonicalize project_dir '$project_dir'" >&2
    return 1
  fi
  project_dir="$_canon"
  # Derive db_path if not provided
  if [[ -z "$db_path" ]]; then
    db_path="$HOME/.local/state/tmup/$session_name/tmup.db"
  fi
  local timestamp
  timestamp=$(date -Iseconds)
  exec 7>"$_REGISTRY_LOCK"
  if ! flock -w 5 7 2>/dev/null; then
    echo "grid-registry: failed to acquire lock for register" >&2
    exec 7>&- 2>/dev/null
    return 1
  fi
  local temp
  temp=$(mktemp "$HOME/.local/state/tmup/registry.XXXXXX") || {
    echo "grid-registry: failed to create temp file" >&2
    exec 7>&- 2>/dev/null
    return 1
  }
  if jq --arg sn "$session_name" --arg pd "$project_dir" --arg dp "$db_path" --arg ts "$timestamp" \
    '.sessions[$sn] = {session_id: $sn, project_dir: $pd, db_path: $dp, created_at: $ts}' \
    "$_REGISTRY_FILE" > "$temp" 2>/dev/null && [[ -s "$temp" ]]; then
    mv "$temp" "$_REGISTRY_FILE"
  else
    rm -f "$temp"
    echo "grid-registry: failed to write registry entry for '$session_name'" >&2
    exec 7>&- 2>/dev/null
    return 1
  fi
  exec 7>&- 2>/dev/null || true
}

registry_deregister() {
  local session_name="$1"
  [[ -f "$_REGISTRY_FILE" ]] || return 0
  exec 7>"$_REGISTRY_LOCK"
  if ! flock -w 5 7 2>/dev/null; then
    echo "grid-registry: failed to acquire lock for deregister" >&2
    exec 7>&- 2>/dev/null
    return 1
  fi
  local temp
  temp=$(mktemp "$HOME/.local/state/tmup/registry.XXXXXX") || {
    echo "grid-registry: failed to create temp file" >&2
    exec 7>&- 2>/dev/null
    return 1
  }
  if jq --arg sn "$session_name" 'del(.sessions[$sn])' \
    "$_REGISTRY_FILE" > "$temp" 2>/dev/null && [[ -s "$temp" ]]; then
    mv "$temp" "$_REGISTRY_FILE"
  else
    rm -f "$temp"
    echo "grid-registry: failed to write registry for deregister '$session_name'" >&2
    exec 7>&- 2>/dev/null
    return 1
  fi
  exec 7>&- 2>/dev/null || true
}

registry_lookup() {
  local search_dir="${1:-$(pwd)}"
  [[ -f "$_REGISTRY_FILE" ]] || return 1
  # Canonicalize search directory — fail closed if unresolvable
  local _canon
  _canon=$(realpath "$search_dir" 2>/dev/null) || _canon=""
  if [[ -z "$_canon" ]]; then
    _canon=$(cd "$search_dir" 2>/dev/null && pwd -P) || _canon=""
  fi
  if [[ -z "$_canon" || ! -d "$_canon" ]]; then
    echo "grid-registry: failed to canonicalize search directory '$search_dir'" >&2
    return 1
  fi
  local dir="$_canon"
  while [[ "$dir" != "/" ]]; do
    local match
    match=$(jq -r --arg pd "$dir" \
      '[.sessions[] | select(.project_dir == $pd)] | first | .session_id // empty' \
      "$_REGISTRY_FILE" 2>/dev/null) || match=""
    if [[ -n "$match" ]]; then
      if tmux has-session -t "$match" 2>/dev/null; then
        echo "$match"
        return 0
      fi
    fi
    dir=$(dirname "$dir")
  done
  return 1
}
