#!/bin/bash
# grid-identity.sh — Grid ownership tracking

_GRID_IDENTITY_LIB_DIR="$(cd "$(command -p dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_GRID_IDENTITY_LIB_DIR/portable-system.sh"

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
    --arg ca "$(tmup_iso_timestamp)" \
    --arg hn "$(tmup_hostname_short)" \
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

# Verify that protected state still describes the exact live tmux session.
# Args: session_name session_target state_dir registry_file
#       [expected_project] [expected_rows] [expected_cols] [expected_count]
# On success TMUP_VERIFIED_SESSION_TARGET is the immutable tmux session ID
# (for example, $3), which callers should prefer over the mutable name.
verify_complete_grid_receipt() {
  local session_name="$1" session_target="$2" state_dir="$3" registry_file="$4"
  local expected_project="${5:-}" expected_rows="${6:-}" expected_cols="${7:-}" expected_count="${8:-}"
  local grid_state="$state_dir/grid/grid-state.json"
  local identity_file="$state_dir/grid-identity.json"
  local recorded_project recorded_rows recorded_cols recorded_count
  local recorded_session_id recorded_session_created live_session_id live_session_created live_session_name
  local live_panes recorded_panes registry_entry

  TMUP_VERIFIED_SESSION_TARGET=""
  [[ -n "$session_name" && "$session_target" == "=$session_name" ]] || return 1
  [[ -f "$grid_state" && ! -L "$grid_state" ]] || return 1
  [[ -f "$identity_file" && ! -L "$identity_file" ]] || return 1
  [[ -f "$registry_file" && ! -L "$registry_file" ]] || return 1

  jq -e --arg sn "$session_name" '
      .schema_version == 2 and
      .session_name == $sn and
      (.project_dir | type == "string" and startswith("/") and length > 1) and
      (.tmux_session_id | type == "string" and test("^\\$[0-9]+$")) and
      (.tmux_session_created | type == "number" and floor == . and . > 0) and
      (.grid.rows | type == "number" and floor == . and . > 0) and
      (.grid.cols | type == "number" and floor == . and . > 0) and
      (.panes | type == "array") and
      (.panes | length) == (.grid.rows * .grid.cols) and
      ([.panes[].index] | length == (unique | length)) and
      ([.panes[].pane_id] | length == (unique | length)) and
      all(.panes[];
        (.index | type == "number" and floor == . and . >= 0) and
        (.pane_id | type == "string" and test("^%[0-9]+$")) and
        (.status | type == "string" and length > 0))
    ' "$grid_state" >/dev/null 2>&1 || return 1

  recorded_project=$(jq -er '.project_dir' "$grid_state" 2>/dev/null) || return 1
  recorded_rows=$(jq -er '.grid.rows' "$grid_state" 2>/dev/null) || return 1
  recorded_cols=$(jq -er '.grid.cols' "$grid_state" 2>/dev/null) || return 1
  recorded_count=$(jq -er '.panes | length' "$grid_state" 2>/dev/null) || return 1
  recorded_session_id=$(jq -er '.tmux_session_id' "$grid_state" 2>/dev/null) || return 1
  recorded_session_created=$(jq -er '.tmux_session_created' "$grid_state" 2>/dev/null) || return 1
  [[ -z "$expected_project" || "$recorded_project" == "$expected_project" ]] || return 1
  [[ -z "$expected_rows" || "$recorded_rows" == "$expected_rows" ]] || return 1
  [[ -z "$expected_cols" || "$recorded_cols" == "$expected_cols" ]] || return 1
  [[ -z "$expected_count" || "$recorded_count" == "$expected_count" ]] || return 1

  jq -e --arg sn "$session_name" '
      .grid_id == $sn and
      (.creator_pid | type == "number" and floor == . and . > 0) and
      (.creator_session | type == "string" and length > 0) and
      (.created_at | type == "string" and length > 0) and
      (.hostname | type == "string" and length > 0)
    ' "$identity_file" >/dev/null 2>&1 || return 1
  validate_ownership || return 1

  registry_entry=$(jq -cer --arg sn "$session_name" '.sessions[$sn]' "$registry_file" 2>/dev/null) || return 1
  jq -e --arg sn "$session_name" --arg pd "$recorded_project" --arg dp "$state_dir/tmup.db" '
      .session_id == $sn and .project_dir == $pd and .db_path == $dp
    ' <<<"$registry_entry" >/dev/null 2>&1 || return 1

  live_session_id=$(tmux display-message -t "$session_target" -p '#{session_id}' 2>/dev/null) || return 1
  [[ "$live_session_id" =~ ^\$[0-9]+$ && "$live_session_id" == "$recorded_session_id" ]] || return 1
  live_session_name=$(tmux display-message -t "$live_session_id" -p '#{session_name}' 2>/dev/null) || return 1
  [[ "$live_session_name" == "$session_name" ]] || return 1
  live_session_created=$(tmux display-message -t "$live_session_id" -p '#{session_created}' 2>/dev/null) || return 1
  [[ "$live_session_created" =~ ^[0-9]+$ && "$live_session_created" == "$recorded_session_created" ]] || return 1

  live_panes=$(tmux list-panes -s -t "$live_session_id" -F '#{pane_index} #{pane_id}' 2>/dev/null) || return 1
  recorded_panes=$(jq -r '.panes[] | "\(.index) \(.pane_id)"' "$grid_state" 2>/dev/null) || return 1
  [[ "$(printf '%s\n' "$live_panes" | LC_ALL=C sort)" == "$(printf '%s\n' "$recorded_panes" | LC_ALL=C sort)" ]] || return 1

  TMUP_VERIFIED_SESSION_TARGET="$live_session_id"
}
