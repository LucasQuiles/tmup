#!/bin/bash
# grid-registry.sh — Multi-grid registry for tmup (project-to-session mapping)

_GRID_REGISTRY_LIB_DIR="$(cd "$(command -p dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_GRID_REGISTRY_LIB_DIR/portable-system.sh" || return 1 2>/dev/null || exit 1
source "$_GRID_REGISTRY_LIB_DIR/state-root.sh" || return 1 2>/dev/null || exit 1
if ! _tmup_resolve_state_root _REGISTRY_STATE_ROOT; then
  return 1 2>/dev/null || exit 1
fi

_REGISTRY_FILE="$_REGISTRY_STATE_ROOT/registry.json"
_REGISTRY_LOCK_FILE="$_REGISTRY_STATE_ROOT/registry.lock"
_REGISTRY_LOCK_STALE_SECONDS="${TMUP_REGISTRY_LOCK_STALE_SECONDS:-10}"

_registry_lock() {
  command -p mkdir -p "$(command -p dirname "$_REGISTRY_LOCK_FILE")" || return 1
  local _attempts=0
  while ! ( set -o noclobber; printf '%s\n' "$$" > "$_REGISTRY_LOCK_FILE" ) 2>/dev/null; do
    if _registry_lock_is_stale; then
      command -p rm -f "$_REGISTRY_LOCK_FILE" 2>/dev/null || true
      continue
    fi
    _attempts=$((_attempts + 1))
    [[ "$_attempts" -lt 50 ]] || return 1
    command -p sleep 0.1
  done
}

_registry_unlock() {
  local _owner=""
  [[ -f "$_REGISTRY_LOCK_FILE" ]] && _owner=$(command -p cat "$_REGISTRY_LOCK_FILE" 2>/dev/null || true)
  if [[ "$_owner" == "$$" ]]; then
    command -p rm -f "$_REGISTRY_LOCK_FILE" 2>/dev/null || true
  fi
}

_registry_lock_is_stale() {
  [[ -f "$_REGISTRY_LOCK_FILE" ]] || return 1
  local _pid=""
  _pid=$(command -p cat "$_REGISTRY_LOCK_FILE" 2>/dev/null || true)
  if [[ "$_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$_pid" 2>/dev/null; then
    return 0
  fi
  local _age
  _age=$(command -p perl -e 'my $p = shift; my @s = stat($p); exit 2 unless @s; print int(time - $s[9]);' "$_REGISTRY_LOCK_FILE" 2>/dev/null) || return 1
  [[ "$_age" =~ ^[0-9]+$ ]] || return 1
  [[ "$_age" -gt "$_REGISTRY_LOCK_STALE_SECONDS" ]]
}

_registry_init() {
  mkdir -p "$(dirname "$_REGISTRY_FILE")"
  if [[ ! -f "$_REGISTRY_FILE" ]] || ! jq empty "$_REGISTRY_FILE" 2>/dev/null; then
    echo '{"sessions":{}}' > "$_REGISTRY_FILE"
  fi
}

registry_register() {
  local session_name="$1" project_dir="$2" db_path="${3:-}"
  _registry_init
  local _canon
  _canon=$(tmup_realpath_dir "$project_dir") || _canon=""
  if [[ -z "$_canon" ]]; then
    echo "grid-registry: failed to canonicalize project_dir '$project_dir'" >&2
    return 1
  fi
  project_dir="$_canon"
  # Derive db_path if not provided
  if [[ -z "$db_path" ]]; then
    db_path="$_REGISTRY_STATE_ROOT/$session_name/tmup.db"
  fi
  local timestamp
  timestamp=$(tmup_iso_timestamp)
  if ! _registry_lock; then
    echo "grid-registry: failed to acquire lock for register" >&2
    return 1
  fi
  local temp
  temp=$(mktemp "$_REGISTRY_STATE_ROOT/registry.XXXXXX") || {
    echo "grid-registry: failed to create temp file" >&2
    _registry_unlock
    return 1
  }
  if jq --arg sn "$session_name" --arg pd "$project_dir" --arg dp "$db_path" --arg ts "$timestamp" \
    '.sessions[$sn] = {session_id: $sn, project_dir: $pd, db_path: $dp, created_at: $ts}' \
    "$_REGISTRY_FILE" > "$temp" 2>/dev/null && [[ -s "$temp" ]]; then
    mv "$temp" "$_REGISTRY_FILE"
  else
    rm -f "$temp"
    echo "grid-registry: failed to write registry entry for '$session_name'" >&2
    _registry_unlock
    return 1
  fi
  _registry_unlock
}

registry_deregister() {
  local session_name="$1"
  [[ -f "$_REGISTRY_FILE" ]] || return 0
  if ! _registry_lock; then
    echo "grid-registry: failed to acquire lock for deregister" >&2
    return 1
  fi
  local temp
  temp=$(mktemp "$_REGISTRY_STATE_ROOT/registry.XXXXXX") || {
    echo "grid-registry: failed to create temp file" >&2
    _registry_unlock
    return 1
  }
  if jq --arg sn "$session_name" 'del(.sessions[$sn])' \
    "$_REGISTRY_FILE" > "$temp" 2>/dev/null && [[ -s "$temp" ]]; then
    mv "$temp" "$_REGISTRY_FILE"
  else
    rm -f "$temp"
    echo "grid-registry: failed to write registry for deregister '$session_name'" >&2
    _registry_unlock
    return 1
  fi
  _registry_unlock
}

registry_lookup() {
  local search_dir="${1:-$(pwd)}"
  [[ -f "$_REGISTRY_FILE" ]] || return 1
  local _canon
  _canon=$(tmup_realpath_dir "$search_dir") || _canon=""
  if [[ -z "$_canon" ]]; then
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
      if tmux has-session -t "=$match" 2>/dev/null; then
        echo "$match"
        return 0
      fi
    fi
    dir=$(dirname "$dir")
  done
  return 1
}
