#!/usr/bin/env bash
# portable-system.sh — small Linux/macOS shell compatibility helpers.

tmup_iso_timestamp() {
  command -p date -u '+%Y-%m-%dT%H:%M:%SZ'
}

tmup_hostname_short() {
  local host
  host=$(command -p hostname -s 2>/dev/null) || host=""
  if [[ -z "$host" ]]; then
    host=$(command -p hostname 2>/dev/null) || host=""
  fi
  printf '%s\n' "${host:-unknown}"
}

tmup_realpath_dir() {
  local dir="${1:-}"
  [[ -n "$dir" ]] || return 1

  local resolved=""
  if command -v realpath >/dev/null 2>&1; then
    resolved=$(realpath "$dir" 2>/dev/null) || resolved=""
  fi
  if [[ -z "$resolved" ]]; then
    resolved=$(cd "$dir" 2>/dev/null && pwd -P) || resolved=""
  fi

  [[ -n "$resolved" && -d "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

tmup_index_range() {
  local count="${1:-0}"
  [[ "$count" =~ ^[0-9]+$ ]] || return 1

  local i
  for ((i = 0; i < count; i++)); do
    printf '%s\n' "$i"
  done
}
