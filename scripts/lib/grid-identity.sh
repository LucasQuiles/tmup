#!/bin/bash
# grid-identity.sh — Grid ownership tracking

generate_grid_id() {
  local base="${1:-tmup}"
  local hex
  hex=$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "${base}-${hex}"
}

register_grid() {
  local grid_id="$1"
  local identity_file="${CFG_STATE_DIR}/grid-identity.json"
  mkdir -p "$CFG_STATE_DIR"
  jq -n \
    --arg gid "$grid_id" \
    --argjson pid "$$" \
    --arg cs "${CLAUDE_SESSION_ID:-unknown}" \
    --arg ca "$(date -Iseconds)" \
    --arg hn "$(hostname -s 2>/dev/null || echo unknown)" \
    '{grid_id:$gid,creator_pid:$pid,creator_session:$cs,created_at:$ca,hostname:$hn}' \
    > "$identity_file"
  chmod 600 "$identity_file"
}

validate_ownership() {
  [[ "${1:-}" == "--force" ]] && return 0
  local identity_file="${CFG_STATE_DIR}/grid-identity.json"
  [[ -f "$identity_file" ]] || return 0  # No identity file = unclaimed grid
  local creator_pid
  creator_pid=$(jq -r '.creator_pid // 0' "$identity_file" 2>/dev/null)
  if [[ $? -ne 0 || -z "$creator_pid" || "$creator_pid" == "null" || "$creator_pid" == "0" ]]; then
    echo "grid-identity: failed to read creator_pid from $identity_file — refusing ownership" >&2
    return 1  # Fail closed on corruption
  fi
  if ! [[ "$creator_pid" =~ ^[0-9]+$ ]]; then
    echo "grid-identity: invalid creator_pid '$creator_pid' in $identity_file — refusing ownership" >&2
    return 1
  fi
  if ! kill -0 "$creator_pid" 2>/dev/null; then return 0; fi  # Creator process dead = safe to take over
  if [[ "$creator_pid" == "$$" ]]; then return 0; fi  # We are the creator
  return 1
}
