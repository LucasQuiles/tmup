#!/usr/bin/env bash
# portable-lock.sh — grid-state lock helpers for Linux and macOS.
#
# Prefer flock when available. macOS does not ship flock by default, so fall
# back to an atomic mkdir lock directory with bounded wait and stale recovery.

_PORTABLE_LOCK_LIB_DIR="$(cd "$(command -p dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_PORTABLE_LOCK_LIB_DIR/portable-system.sh"

tmup_lock_acquire() {
  local lock_file="${1:-}"
  local timeout="${2:-5}"
  local fd="${3:-9}"

  [[ -n "$lock_file" ]] || return 1
  command -p mkdir -p "$(command -p dirname "$lock_file")" || return 1

  if command -v flock >/dev/null 2>&1; then
    eval "exec ${fd}>\"\$lock_file\"" || return 1
    local flock_status
    flock -w "$timeout" "$fd"
    flock_status=$?
    if [[ "$flock_status" -ne 0 ]]; then
      eval "exec ${fd}>&-" 2>/dev/null || true
    fi
    return "$flock_status"
  fi

  local lock_dir="${lock_file}.d"
  local timeout_int="${timeout%.*}"
  [[ "$timeout_int" =~ ^[0-9]+$ ]] || timeout_int=5
  local max_attempts=$((timeout_int * 10))
  [[ "$max_attempts" -lt 1 ]] && max_attempts=1

  local attempts=0
  while ! command -p mkdir "$lock_dir" 2>/dev/null; do
    if tmup_lock_is_stale "$lock_dir"; then
      command -p rm -f "$lock_dir/owner" 2>/dev/null || true
      if command -p rmdir "$lock_dir" 2>/dev/null; then
        continue
      fi
    fi
    attempts=$((attempts + 1))
    [[ "$attempts" -lt "$max_attempts" ]] || return 1
    command -p sleep 0.1
  done

  if ! {
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "$(tmup_hostname_short)"
    printf 'created_at=%s\n' "$(tmup_iso_timestamp)"
  } > "$lock_dir/owner" 2>/dev/null; then
    command -p rm -f "$lock_dir/owner" 2>/dev/null || true
    command -p rmdir "$lock_dir" 2>/dev/null || true
    return 1
  fi
}

tmup_lock_release() {
  local lock_file="${1:-}"
  local fd="${2:-9}"

  [[ -n "$lock_file" ]] || return 0

  if command -v flock >/dev/null 2>&1; then
    eval "exec ${fd}>&-" 2>/dev/null || true
    return 0
  fi

  local lock_dir="${lock_file}.d"
  local owner_file="$lock_dir/owner"
  local owner_pid=""
  if [[ -f "$owner_file" ]]; then
    owner_pid=$(command -p awk -F= '$1 == "pid" {print $2; exit}' "$owner_file" 2>/dev/null) || owner_pid=""
    [[ "$owner_pid" == "$$" ]] || return 0
  else
    return 0
  fi

  command -p rm -f "$owner_file" 2>/dev/null || true
  command -p rmdir "$lock_dir" 2>/dev/null || true
}

tmup_lock_is_stale() {
  local lock_dir="${1:-}"
  local stale_after="${TMUP_LOCK_STALE_SECONDS:-30}"

  [[ -d "$lock_dir" ]] || return 1
  local age
  age=$(command -p perl -e 'my $p = shift; my @s = stat($p); exit 2 unless @s; print int(time - $s[9]);' "$lock_dir" 2>/dev/null) || return 1
  [[ "$age" =~ ^[0-9]+$ ]] || return 1
  [[ "$age" -gt "$stale_after" ]]
}
