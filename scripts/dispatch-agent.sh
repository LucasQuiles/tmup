#!/bin/bash
# dispatch-agent.sh — Launch a Codex worker in a tmux pane with tmup env vars
# Uses wrapper script pattern (NOT $(cat) in tmux command) for security
set -euo pipefail
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH CDPATH
unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
unset PERL5OPT PERL5LIB PYTHONPATH PYTHONHOME RUBYOPT RUBYLIB

_tmup_resolve_script_dir() {
  local source_path="$1" source_dir link_target readlink_bin="" candidate hops=0
  for candidate in /usr/bin/readlink /bin/readlink; do
    if [[ -x "$candidate" ]]; then
      readlink_bin="$candidate"
      break
    fi
  done
  [[ -n "$readlink_bin" ]] || {
    echo "dispatch-agent.sh: trusted system readlink is unavailable" >&2
    return 1
  }

  while [[ -L "$source_path" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || {
      echo "dispatch-agent.sh: script symlink chain exceeds 40 hops" >&2
      return 1
    }
    source_dir="${source_path%/*}"
    [[ "$source_dir" != "$source_path" ]] || source_dir="."
    source_dir="$(cd -P -- "$source_dir" && pwd -P)" || return 1
    link_target="$("$readlink_bin" "$source_path")" || return 1
    if [[ "$link_target" == /* ]]; then
      source_path="$link_target"
    else
      source_path="$source_dir/$link_target"
    fi
  done

  source_dir="${source_path%/*}"
  [[ "$source_dir" != "$source_path" ]] || source_dir="."
  cd -P -- "$source_dir" && pwd -P
}

SCRIPT_DIR="$(_tmup_resolve_script_dir "${BASH_SOURCE[0]}")" || exit 1
unset -f _tmup_resolve_script_dir
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# Establish the fixed controller toolchain before sourcing any helper that
# executes an external command.
_TMUP_PREFLIGHT_WORKING_DIR=""
_TMUP_PREFLIGHT_SESSION=""
_tmup_preparse_boundary_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --working-dir)
        [[ $# -ge 2 && -z "$_TMUP_PREFLIGHT_WORKING_DIR" ]] || return 1
        _TMUP_PREFLIGHT_WORKING_DIR="$2"
        shift 2
        ;;
      --session)
        [[ $# -ge 2 && -z "$_TMUP_PREFLIGHT_SESSION" ]] || return 1
        _TMUP_PREFLIGHT_SESSION="$2"
        shift 2
        ;;
      --role|--prompt|--pane-index|--agent-id|--task-id|--db-path|--node-bin|--resume-session-id|--worker-type|--trusted-shared-state-receipt|--claude-code-trust-receipt|--model-validation-receipt)
        [[ $# -ge 2 ]] || return 1
        shift 2
        ;;
      --clone-isolation|--trusted-shared-state|--allow-unconfined-claude-code)
        shift
        ;;
      *) return 1 ;;
    esac
  done
}
_tmup_preparse_boundary_args "$@" || {
  echo "dispatch-agent.sh: invalid, duplicate, or incomplete boundary arguments" >&2
  exit 1
}
unset -f _tmup_preparse_boundary_args
[[ -n "$_TMUP_PREFLIGHT_WORKING_DIR" && "$_TMUP_PREFLIGHT_WORKING_DIR" == /* && \
   -d "$_TMUP_PREFLIGHT_WORKING_DIR" ]] || {
  echo "dispatch-agent.sh: --working-dir must be an absolute existing directory before controller startup" >&2
  exit 1
}
_TMUP_PREFLIGHT_WORKING_DIR=$(cd -P -- "$_TMUP_PREFLIGHT_WORKING_DIR" && pwd -P) || exit 1
source "$SCRIPT_DIR/lib/controller-bootstrap.sh"
tmup_controller_establish_toolchain "$_TMUP_PREFLIGHT_WORKING_DIR" "$PLUGIN_DIR" || {
  echo "dispatch-agent.sh: trusted controller toolchain validation failed" >&2
  exit 1
}
source "$SCRIPT_DIR/lib/common.sh"
if [[ -n "$_TMUP_PREFLIGHT_SESSION" ]]; then
  export TMUP_SESSION_NAME="$_TMUP_PREFLIGHT_SESSION"
fi

source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/validators.sh"
source "$SCRIPT_DIR/lib/tmux-helpers.sh"
source "$SCRIPT_DIR/lib/portable-lock.sh"
source "$SCRIPT_DIR/lib/control-boundary.sh"

if [[ "${CFG_CONFIG_DEGRADED:-0}" -eq 1 ]]; then
  die "Cannot dispatch — policy.yaml exists but could not be read (yq missing or broken). Install yq or remove policy.yaml."
fi

CODEX_SHELL_INHERIT="$CFG_CODEX_SHELL_INHERIT"
if [[ -n "${TMUP_CODEX_SHELL_INHERIT_OVERRIDE:-}" ]]; then
  case "$TMUP_CODEX_SHELL_INHERIT_OVERRIDE" in
    all|core|none) CODEX_SHELL_INHERIT="$TMUP_CODEX_SHELL_INHERIT_OVERRIDE" ;;
    *) die "Invalid TMUP_CODEX_SHELL_INHERIT_OVERRIDE '$TMUP_CODEX_SHELL_INHERIT_OVERRIDE' (expected all, core, or none)" ;;
  esac
fi

STATE_DIR="$CFG_STATE_DIR"
GRID_STATE="$STATE_DIR/grid/grid-state.json"
CODEX_BIN="${CODEX_BIN:-}"
CLAUDE_BIN="${CLAUDE_BIN:-}"
NODE_BIN=""
CODEX_NODE_WRAPPED=0
SYSTEM_RM_BIN=""
SYSTEM_SLEEP_BIN=""
CLI_PATH=""

PROMPT_FILE=""
LAUNCHER=""
TASK_TMP_DIR=""
PROMPT_HASH=""
LAUNCHER_HASH=""
LOCK_FILE=""
RESERVATION_ACTIVE=0
DISPATCH_COMMITTED=0
LAUNCH_SENT=0

_validate_session_state_boundary() {
  local root="$1" session_dir="$2" session_name="$3"
  local root_physical session_physical plugin_physical control_physical

  [[ -n "$root" && -n "$session_dir" && -n "$session_name" ]] || {
    echo "empty state boundary component" >&2
    return 1
  }
  root="${root%/}"
  [[ -n "$root" && "$root" == /* && "$root" != "/" ]] || {
    echo "state root must be a non-root absolute path: $root" >&2
    return 1
  }
  [[ "$session_dir" == "$root/$session_name" ]] || {
    echo "session state path escapes the configured root: $session_dir" >&2
    return 1
  }
  [[ -d "$HOME" && -d "$root" && -d "$session_dir" ]] || {
    echo "state root or session directory is missing" >&2
    return 1
  }

  root_physical=$(cd "$root" && pwd -P) || return 1
  session_physical=$(cd "$session_dir" && pwd -P) || return 1
  [[ "$session_physical" == "$root_physical/$session_name" ]] || {
    echo "session state canonical path escaped the state root: $session_physical" >&2
    return 1
  }

  plugin_physical=$(cd "$PLUGIN_DIR" && pwd -P) || return 1
  control_physical=$(cd "$HOME" && pwd -P) || return 1
  control_physical="$control_physical/.local/state/tmup-control"
  if _tmup_controller_paths_overlap "$root_physical" "$plugin_physical" || \
     _tmup_controller_paths_overlap "$root_physical" "$control_physical"; then
    echo "state root overlaps protected plugin or controller state: $root_physical" >&2
    return 1
  fi
}

_resolve_physical_file() {
  local source_path="$1" source_dir link_target readlink_bin="" candidate hops=0
  [[ "$source_path" == /* ]] || return 1
  for candidate in /usr/bin/readlink /bin/readlink; do
    if [[ -x "$candidate" ]]; then
      readlink_bin="$candidate"
      break
    fi
  done
  [[ -n "$readlink_bin" ]] || return 1

  while [[ -L "$source_path" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || return 1
    source_dir="${source_path%/*}"
    source_dir=$(cd -P -- "$source_dir" 2>/dev/null && pwd -P) || return 1
    link_target=$("$readlink_bin" "$source_path") || return 1
    if [[ "$link_target" == /* ]]; then
      source_path="$link_target"
    else
      source_path="$source_dir/$link_target"
    fi
  done

  source_dir="${source_path%/*}"
  source_dir=$(cd -P -- "$source_dir" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$source_dir" "${source_path##*/}"
}

_resolve_executable() {
  local label="$1" candidate="$2" resolved
  resolved=$(_resolve_physical_file "$candidate") || die "$label path could not be resolved safely: $candidate"
  [[ "$resolved" == /* && -f "$resolved" && -x "$resolved" && ! -L "$resolved" ]] || \
    die "$label must resolve to an absolute executable regular file: $resolved"
  printf '%s\n' "$resolved"
}

_resolve_codex_bin() {
  local candidate="${CODEX_BIN:-}" first_line=""

  if [[ -n "$candidate" ]]; then
    [[ "$candidate" == /* ]] || die "Explicit CODEX_BIN must be an absolute Codex executable path: $candidate"
  else
    # type -P ignores shell functions and aliases. The final symlink target is
    # resolved below so containment checks apply to the executable actually run.
    if [[ -f "$HOME/.local/bin/codex" && -x "$HOME/.local/bin/codex" ]]; then
      candidate="$HOME/.local/bin/codex"
    else
      candidate="$(type -P codex 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$HOME/.local/bin/codex"
    fi
  fi

  CODEX_BIN=$(_resolve_executable "Codex executable" "$candidate")
  IFS= read -r first_line < "$CODEX_BIN" || true
  first_line="${first_line%$'\r'}"
  case "$first_line" in
    '#!/usr/bin/env node'*|'#!/usr/bin/env -S node'*) CODEX_NODE_WRAPPED=1 ;;
  esac
}

_resolve_claude_bin() {
  local candidate="${CLAUDE_BIN:-}"

  if [[ -n "$candidate" ]]; then
    [[ "$candidate" == /* ]] || die "Explicit CLAUDE_BIN must be an absolute Claude executable path: $candidate"
  elif [[ -f "$HOME/.local/bin/claude" && -x "$HOME/.local/bin/claude" ]]; then
    candidate="$HOME/.local/bin/claude"
  else
    candidate="$(type -P claude 2>/dev/null || true)"
  fi

  [[ -n "$candidate" ]] || die "Claude executable was not found in \$HOME/.local/bin or the trusted controller PATH"
  CLAUDE_BIN=$(_resolve_executable "Claude executable" "$candidate")
}

_resolve_node_bin() {
  local candidate="${NODE_BIN:-}"
  if [[ -n "$candidate" ]]; then
    [[ "$candidate" == /* ]] || die "--node-bin must be an absolute Node executable path"
  else
    candidate=$(type -P node 2>/dev/null || true)
  fi
  [[ -n "$candidate" ]] || die "Node executable is required for protected worker heartbeats"
  NODE_BIN=$(_resolve_executable "Node executable" "$candidate")
}

_resolve_system_tools() {
  local candidate
  for candidate in /bin/rm /usr/bin/rm; do
    if [[ -x "$candidate" ]]; then
      SYSTEM_RM_BIN=$(_resolve_executable "rm executable" "$candidate")
      break
    fi
  done
  for candidate in /bin/sleep /usr/bin/sleep; do
    if [[ -x "$candidate" ]]; then
      SYSTEM_SLEEP_BIN=$(_resolve_executable "sleep executable" "$candidate")
      break
    fi
  done
  [[ -n "$SYSTEM_RM_BIN" && -n "$SYSTEM_SLEEP_BIN" ]] || \
    die "Trusted system rm and sleep executables are required"
}

_file_link_count() {
  stat -f '%l' "$1" 2>/dev/null || stat -c '%h' "$1" 2>/dev/null
}

_validate_single_link_regular() {
  local file="$1" label="$2" link_count
  [[ -f "$file" && ! -L "$file" ]] || return 1
  link_count=$(_file_link_count "$file") || return 1
  [[ "$link_count" == "1" ]] || {
    echo "$label must be a single-link regular file: $file" >&2
    return 1
  }
}

_validate_grid_directory() {
  local grid_dir="$STATE_DIR/grid" grid_physical state_physical
  [[ -d "$grid_dir" && ! -L "$grid_dir" ]] || return 1
  state_physical=$(cd -P -- "$STATE_DIR" 2>/dev/null && pwd -P) || return 1
  grid_physical=$(cd -P -- "$grid_dir" 2>/dev/null && pwd -P) || return 1
  [[ "$grid_physical" == "$state_physical/grid" ]]
}

_hash_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    die "Need shasum, sha256sum, or openssl for controller artifact integrity"
  fi
}

_file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

_verify_control_artifact() {
  local file="$1" expected_mode="$2" expected_hash="$3"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$(_file_mode "$file")" == "$expected_mode" ]] || return 1
  [[ "$(_hash_file "$file")" == "$expected_hash" ]] || return 1
}


_remove_owned_task_tmp() {
  local owned_tmp="${TASK_TMP_DIR:-}"
  [[ -n "$owned_tmp" ]] || return 0
  if [[ "$owned_tmp" == "${TMUP_CONTROL_TASK_ROOT:-}"/task-tmp-"${PANE_INDEX:-}"-"${AGENT_ID:-}".* && -d "$owned_tmp" && ! -L "$owned_tmp" ]]; then
    rm -rf -- "$owned_tmp"
  fi
  TASK_TMP_DIR=""
}

_dispatch_cleanup() {
  rm -f "${PROMPT_FILE:-}" "${LAUNCHER:-}" 2>/dev/null || true
  _remove_owned_task_tmp
}

_stop_unconfirmed_launch() {
  local attempt occupancy_status
  [[ "${LAUNCH_SENT:-0}" -eq 1 ]] || return 0

  if ! respawn_pane "$PANE_TARGET"; then
    echo "dispatch-agent.sh: failed to respawn the unconfirmed worker pane" >&2
    return 1
  fi

  for attempt in 1 2 3 4 5; do
    sleep 0.2
    if PANE_CMD=$(pane_occupancy_command "$SESSION_NAME" "$PANE_INDEX"); then
      occupancy_status=0
    else
      occupancy_status=$?
    fi
    [[ "$occupancy_status" -eq 1 ]] && return 0
    [[ "$occupancy_status" -eq 2 ]] && break
  done

  echo "dispatch-agent.sh: unconfirmed worker remains or pane occupancy is unknown; retaining pane reservation" >&2
  return 1
}

_release_pane_reservation() {
  [[ "${RESERVATION_ACTIVE:-0}" -eq 1 ]] || return 0
  _validate_grid_directory || return 1
  _validate_single_link_regular "$GRID_STATE" "grid state" || return 1
  [[ -f "${GRID_STATE:-}" ]] || return 1
  [[ -n "${PANE_INDEX:-}" && -n "${AGENT_ID:-}" ]] || return 1

  tmup_lock_acquire "$LOCK_FILE" 2 8 2>/dev/null || return 1
  local temp_file="" release_status=1
  temp_file=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX" 2>/dev/null || true)
  if [[ -n "$temp_file" ]] && jq -e --argjson idx "$PANE_INDEX" --arg aid "$AGENT_ID" '
      [.panes[] | select(.index == $idx and .status == "reserved" and .agent_id == $aid)] | length == 1
    ' "$GRID_STATE" >/dev/null 2>&1 && jq --argjson idx "$PANE_INDEX" --arg aid "$AGENT_ID" '
      (.panes[] | select(.index == $idx and .status == "reserved" and .agent_id == $aid))
        |= {index: .index, pane_id: .pane_id, status: "available"}
    ' "$GRID_STATE" > "$temp_file" 2>/dev/null && [[ -s "$temp_file" ]] &&
    mv "$temp_file" "$GRID_STATE" && jq -e --argjson idx "$PANE_INDEX" '
      [.panes[] | select(.index == $idx and .status == "available" and
        (.role | not) and (.agent_id | not))] | length == 1
    ' "$GRID_STATE" >/dev/null 2>&1; then
    RESERVATION_ACTIVE=0
    release_status=0
  fi
  [[ -z "$temp_file" || ! -e "$temp_file" ]] || rm -f "$temp_file"
  tmup_lock_release "$LOCK_FILE" 8 || release_status=1
  return "$release_status"
}

_dispatch_teardown() {
  local exit_code="${1:-1}"
  trap - EXIT INT TERM
  tmup_lock_release "${LOCK_FILE:-}" 9
  tmup_lock_release "${LOCK_FILE:-}" 8
  if [[ "${DISPATCH_COMMITTED:-0}" -eq 0 ]]; then
    if _stop_unconfirmed_launch; then
      if _release_pane_reservation; then
        _dispatch_cleanup
        echo "TMUP_DISPATCH_ROLLBACK=released"
      else
        echo "dispatch-agent.sh: pane stopped but reservation release could not be positively verified" >&2
        echo "TMUP_DISPATCH_ROLLBACK=retained"
      fi
    else
      echo "TMUP_DISPATCH_ROLLBACK=retained"
    fi
  fi
  exit "$exit_code"
}

trap '_dispatch_teardown "$?"' EXIT
trap '_dispatch_teardown 130' INT
trap '_dispatch_teardown 143' TERM

# Parse arguments
ROLE="" PROMPT="" PANE_INDEX="" WORKING_DIR="" AGENT_ID="" TASK_ID="" DB_PATH="" RESUME_SESSION_ID="" WORKER_TYPE="codex" CLONE_ISOLATION=0
TRUSTED_SHARED_STATE=0 TRUSTED_SHARED_STATE_RECEIPT=""
ALLOW_UNCONFINED_CLAUDE=0 CLAUDE_TRUST_RECEIPT="" MODEL_VALIDATION_RECEIPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --pane-index) PANE_INDEX="$2"; shift 2 ;;
    --working-dir) WORKING_DIR="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --task-id) TASK_ID="$2"; shift 2 ;;
    --db-path) DB_PATH="$2"; shift 2 ;;
    --node-bin) NODE_BIN="$2"; shift 2 ;;
    --session) shift 2 ;;
    --resume-session-id) RESUME_SESSION_ID="$2"; shift 2 ;;
    --worker-type) WORKER_TYPE="$2"; shift 2 ;;
    --clone-isolation) CLONE_ISOLATION=1; shift ;;
    --trusted-shared-state) TRUSTED_SHARED_STATE=1; shift ;;
    --trusted-shared-state-receipt) TRUSTED_SHARED_STATE_RECEIPT="$2"; shift 2 ;;
    --allow-unconfined-claude-code) ALLOW_UNCONFINED_CLAUDE=1; shift ;;
    --claude-code-trust-receipt) CLAUDE_TRUST_RECEIPT="$2"; shift 2 ;;
    --model-validation-receipt) MODEL_VALIDATION_RECEIPT="$2"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$ROLE" ]] || die "--role required"
[[ -n "$PROMPT" ]] || die "--prompt required"
[[ -n "$AGENT_ID" ]] || die "--agent-id required"
[[ -n "$DB_PATH" ]] || die "--db-path required"
[[ "$AGENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ && ${#AGENT_ID} -le 128 ]] || \
  die "Invalid --agent-id: expected 1-128 ASCII letters, digits, underscores, or hyphens"
if [[ -n "$RESUME_SESSION_ID" ]]; then
  [[ "$RESUME_SESSION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$ ]] || \
    die "Invalid --resume-session-id: expected 1-256 ASCII letters, digits, underscores, or hyphens"
fi
case "$WORKER_TYPE" in
  codex)
    CLAUDE_BIN=""
    case "$CFG_CODEX_SANDBOX" in
      workspace-write) ;;
      *) die "Unsafe Codex sandbox mode '$CFG_CODEX_SANDBOX' (safe lanes require workspace-write)" ;;
    esac
    if [[ "$CFG_CODEX_MODEL" != "auto" ]]; then
      [[ "${CFG_CODEX_EXPLICIT_MODEL_PINS_ENABLED:-false}" == "true" ]] || \
        die "Explicit Codex model pins are disabled by policy"
      [[ -n "$MODEL_VALIDATION_RECEIPT" && ${#MODEL_VALIDATION_RECEIPT} -le 256 ]] || \
        die "Explicit Codex model pin '$CFG_CODEX_MODEL' requires a per-dispatch live-validation receipt"
    elif [[ -n "$MODEL_VALIDATION_RECEIPT" ]]; then
      die "Model validation receipt is only valid with an explicit configured model pin"
    fi
    if [[ "$TRUSTED_SHARED_STATE" -eq 1 ]]; then
      [[ "${CFG_CODEX_TRUSTED_SHARED_STATE_ENABLED:-false}" == "true" ]] || \
        die "Trusted shared-state mode is disabled by policy"
      [[ -n "$TRUSTED_SHARED_STATE_RECEIPT" && ${#TRUSTED_SHARED_STATE_RECEIPT} -le 256 ]] || \
        die "Trusted shared-state mode requires an explicit per-dispatch receipt"
    elif [[ -n "$TRUSTED_SHARED_STATE_RECEIPT" ]]; then
      die "Trusted shared-state receipt requires --trusted-shared-state"
    fi
    _resolve_codex_bin
    ;;
  claude_code)
    [[ -z "$RESUME_SESSION_ID" ]] || \
      die "--resume-session-id is not supported for claude_code one-shot workers"
    [[ "$ALLOW_UNCONFINED_CLAUDE" -eq 1 ]] || \
      die "claude_code bypassPermissions requires --allow-unconfined-claude-code and a trust receipt"
    [[ "${CFG_CLAUDE_CODE_TRUSTED_UNSANDBOXED_ENABLED:-false}" == "true" ]] || \
      die "claude_code trusted-unsandboxed mode is disabled by policy"
    [[ -n "$CLAUDE_TRUST_RECEIPT" && ${#CLAUDE_TRUST_RECEIPT} -le 256 ]] || \
      die "claude_code trusted-unsandboxed mode requires an explicit per-dispatch receipt"
    _resolve_claude_bin
    ;;
  *) die "Invalid --worker-type '$WORKER_TYPE' (expected codex or claude_code)" ;;
esac
_resolve_node_bin
_resolve_system_tools

SESSION_NAME="$CFG_SESSION_NAME"
[[ -n "$SESSION_NAME" ]] || die "No active session"
_validate_session_state_boundary "$CFG_STATE_ROOT" "$STATE_DIR" "$SESSION_NAME" || \
  die "Unsafe tmup session-state boundary"
[[ -n "$WORKING_DIR" ]] || die "--working-dir required (will not fall back to pwd)"
validate_working_dir "$WORKING_DIR" || die "Invalid working directory: $WORKING_DIR"
WORKING_DIR="$(cd "$WORKING_DIR" && pwd -P)" || die "Failed to resolve working directory: $WORKING_DIR"
[[ "$DB_PATH" == "$STATE_DIR/tmup.db" ]] || \
  die "DB path must be the canonical tmup session database: $STATE_DIR/tmup.db"
_validate_single_link_regular "$DB_PATH" "tmup session database" || \
  die "tmup session database must exist as a non-symlink single-link regular file: $DB_PATH"
GRID_STATE="$STATE_DIR/grid/grid-state.json"
_validate_grid_directory || \
  die "grid directory must be the canonical non-symlink tmup session grid: $STATE_DIR/grid"
_validate_single_link_regular "$GRID_STATE" "grid state" || \
  die "grid state must exist as a non-symlink single-link regular file: $GRID_STATE"
tmup_control_prepare_session "$SESSION_NAME" || die "Unsafe controller-state boundary"
# Safe-default workers cannot write STATE_DIR. Keep the single established
# grid lock shared with pane-manager; trusted shared-state mode accepts this
# advisory integrity boundary explicitly.
LOCK_FILE="$STATE_DIR/grid/grid-state.lock"

# Clone isolation: create isolated git clone for colony workers (council M4)
if [[ "$CLONE_ISOLATION" -eq 1 ]]; then
  _CLONE_MANAGER="$HOME/.claude/plugins/sdlc-os/colony/clone-manager.sh"
  if [[ -f "$_CLONE_MANAGER" ]]; then
    _CLONE_MANAGER=$(_resolve_physical_file "$_CLONE_MANAGER") || \
      die "Failed to resolve clone-manager.sh through a trusted physical path"
    [[ -f "$_CLONE_MANAGER" && ! -L "$_CLONE_MANAGER" ]] || \
      die "clone-manager.sh must resolve to a non-symlink regular file"
    if tmup_path_contains "$WORKING_DIR" "$_CLONE_MANAGER"; then
      die "clone-manager.sh is inside the worker-writable root: $_CLONE_MANAGER"
    fi
    source "$_CLONE_MANAGER"
    WORKING_DIR="$(colony_clone_create "$WORKING_DIR" "$SESSION_NAME" "$AGENT_ID")" || die "Failed to create isolated clone"
    [[ -n "${WORKING_DIR//[[:space:]]/}" ]] || die "colony_clone_create returned empty or whitespace-only clone path (exit 0 with degenerate stdout)"
    colony_clone_verify "$WORKING_DIR" || die "Clone verification failed"
    # Emit structured line so MCP handler can persist clone_dir on the task row
    echo "CLONE_DIR=$WORKING_DIR"
  else
    die "Clone isolation requested but clone-manager.sh not found at $_CLONE_MANAGER"
  fi
  unset _CLONE_MANAGER
fi

validate_working_dir "$WORKING_DIR" || die "Clone result is not a valid working directory: $WORKING_DIR"
WORKING_DIR="$(cd "$WORKING_DIR" && pwd -P)" || die "Failed to canonicalize final working directory"
tmup_controller_establish_toolchain "$WORKING_DIR" "$PLUGIN_DIR" || \
  die "Trusted controller toolchain failed final worker-root validation"
tmup_control_validate_worker_boundary "$WORKING_DIR" "$STATE_DIR" "$PLUGIN_DIR" "$TRUSTED_SHARED_STATE" || \
  die "Working directory overlaps a controller, session, or plugin boundary"
if [[ "$WORKER_TYPE" == "codex" ]] && tmup_path_contains "$WORKING_DIR" "$CODEX_BIN"; then
  die "Codex executable is inside the worker-writable root: $CODEX_BIN"
fi
if [[ "$WORKER_TYPE" == "claude_code" ]] && tmup_path_contains "$WORKING_DIR" "$CLAUDE_BIN"; then
  die "Claude executable is inside the worker root: $CLAUDE_BIN"
fi
if tmup_path_contains "$WORKING_DIR" "$NODE_BIN"; then
  die "Node executable is inside the worker-writable root: $NODE_BIN"
fi
CLI_PATH=$(_resolve_physical_file "$PLUGIN_DIR/cli/dist/tmup-cli.js") || \
  die "Failed to resolve protected tmup CLI heartbeat target"
[[ -f "$CLI_PATH" && ! -L "$CLI_PATH" ]] || \
  die "Protected tmup CLI heartbeat target must be a non-symlink regular file"
if tmup_path_contains "$WORKING_DIR" "$CLI_PATH"; then
  die "Protected tmup CLI heartbeat target is inside the worker-writable root: $CLI_PATH"
fi

validate_role "$ROLE"

# Read agent instructions
AGENT_FILE="$PLUGIN_DIR/agents/$ROLE.md"
AGENT_INSTRUCTIONS=$(awk '/^---$/ { if (++fm == 2) { skip=0; next } else { skip=1; next } } skip { next } { print }' "$AGENT_FILE")
[[ -n "$AGENT_INSTRUCTIONS" ]] || die "Agent instructions for role '$ROLE' are empty — check $AGENT_FILE for valid YAML frontmatter"

# Auto-select pane if not specified
if [[ -z "$PANE_INDEX" ]]; then
  GRID_STATE="$STATE_DIR/grid/grid-state.json"
  _validate_grid_directory && _validate_single_link_regular "$GRID_STATE" "grid state" || \
    die "Grid state boundary is no longer trusted"
  PANE_INDEX=$(jq -r '[.panes[] | select(.status == "available")] | first | .index // empty' "$GRID_STATE")
  [[ -n "$PANE_INDEX" ]] || die "No available panes"
fi

validate_pane_index "$PANE_INDEX"

# Allocate one task-scoped writable child under the protected controller parent.
# Only this exact child is granted to the safe-default Codex sandbox.
TASK_TMP_DIR=$(mktemp -d "$TMUP_CONTROL_TASK_ROOT/task-tmp-${PANE_INDEX}-${AGENT_ID}.XXXXXX") || die "Failed to allocate worker temp directory"
chmod 700 "$TASK_TMP_DIR" || die "Failed to secure worker temp directory"
[[ ! -L "$TASK_TMP_DIR" ]] || die "Worker temp directory unexpectedly resolved to a symlink"
[[ "$(cd "$TASK_TMP_DIR/.." && pwd -P)" == "$TMUP_CONTROL_TASK_ROOT" ]] || \
  die "Worker temp directory escaped the protected task root"

# Build full prompt
PLAN_FIRST_LINE=""
if [[ "${CFG_CODEX_PLAN_FIRST:-true}" == "true" ]]; then
  PLAN_FIRST_LINE="- Start plan-first. Restate the objective, constraints, risks, and execution plan before making broad changes."
fi

if [[ "$CFG_CODEX_MODEL" == "auto" ]]; then
  MODEL_CONTRACT="- tmup omits -m; the installed Codex CLI resolves its default model. No observed-model claim is available."
else
  MODEL_CONTRACT="- Requested model: $CFG_CODEX_MODEL. The validation receipt is not an observed-model receipt."
fi

if [[ "$TRUSTED_SHARED_STATE" -eq 1 ]]; then
  COORDINATION_CONTRACT=$(cat <<EOF
## Coordination Mode — TRUSTED SHARED STATE
- This direct-dispatch lane received an explicit trusted shared-state receipt.
- TMUP_SESSION_DIR and TMUP_DB are exposed to worker commands; this is an advisory same-UID trust mode, not peer isolation.
- Use node $PLUGIN_DIR/cli/dist/tmup-cli.js for checkpoint, message, complete, fail, inbox, heartbeat, and status operations. Never write raw SQL or edit grid state.
EOF
)
else
  COORDINATION_CONTRACT=$(cat <<'EOF'
## Coordination Mode — SUPERVISOR OWNED
- Direct tmup SQLite, grid, session-state, and tmup-cli lifecycle writes are intentionally unavailable in this sandbox.
- The supervisor owns claim, checkpoint, message, complete, and fail transitions through lead-side tools.
- Report progress, blockers, evidence, and final results clearly in pane output; the supervisor harvests that output and applies task transitions.
- Do not search for or attempt to open tmup session/database paths.
EOF
)
fi

FULL_PROMPT=$(cat <<EOF
You are a $ROLE agent in a tmup-coordinated team.

## Objective
$PROMPT

## Working Directory
$WORKING_DIR

$(if [[ "$WORKER_TYPE" == "claude_code" ]]; then cat <<CLAUDE_CONTRACT
## Runtime Contract — CLAUDE CODE ONE-SHOT
- You are a trusted, unsandboxed Claude Code worker dispatched in one-shot mode — single invocation, stdin → stdout → exit.
- bypassPermissions is enabled by explicit policy plus a per-dispatch receipt. This lane is outside the sandboxed Codex integrity guarantee.
- This is NOT a persistent interactive pane. There is no tmup_reprompt, no tmup_harvest, no queueable follow-up.
- Complete the task end-to-end in this single invocation, including any multi-step planning and verification.
- Model selection and fallback are inherited from Claude Code settings; tmup does not override them with a worker-specific --model.
- The protected controller launcher owns background heartbeat; report lifecycle state through final output.
$PLAN_FIRST_LINE
- Use relevant Claude Code skills when they clearly apply to the task.

## Lane Discipline — ONE-SHOT
- This execution is the entire lane lifetime. Assume you will not be reprompted.
- Deliver a complete, self-contained answer. Do not defer steps to a follow-up turn that will not happen.
- If the task cannot be completed in one shot, emit a clear failure with the reason rather than partial output.
CLAUDE_CONTRACT
else cat <<CODEX_CONTRACT
## Runtime Contract — INTERACTIVE CODEX
- You are running in a persistent interactive Codex worker pane managed by tmup.
- This is not \`codex exec\`, not a one-shot subprocess, and not a shell-only lane.
$MODEL_CONTRACT
- Context and compaction come from the resolved Codex model catalog; tmup does not override them.
- Runtime defaults for this lane: reasoning_effort=$CFG_CODEX_REASONING_EFFORT, reasoning_summary=$CFG_CODEX_REASONING_SUMMARY, verbosity=$CFG_CODEX_VERBOSITY, web_search=$CFG_CODEX_WEB_SEARCH.
- Interactive safeguards and productivity features are enabled through tmup policy: history=$CFG_CODEX_HISTORY, shell_snapshot=$CFG_CODEX_SHELL_SNAPSHOT, request_compression=$CFG_CODEX_REQUEST_COMPRESSION.
$PLAN_FIRST_LINE
- Use relevant Codex skills when they clearly apply to the task.
- Use built-in Codex subagents when the task has parallelizable workstreams.
- One exact task-scoped mode-0700 temp child is granted and exported as TMPDIR, TMP, and TEMP; ambient /tmp and inherited temp roots remain excluded. This is sandbox isolation, not protection from separately authorized same-UID unsandboxed processes.
- Native children inherit the pane model unless the live spawn schema explicitly exposes named-role selection. Task names do not select or pin a role or model.
- When named-role selection is available, use only post-canary profiles activated by the lead and backed by a runtime receipt.
- Without named-role selection, native children are same-model leaves; use a model-explicit Codex/tmup process or lane for a distinct model.
- Never claim model or tier selection without a runtime receipt.
- Current subagent concurrency/depth caps for fresh tmup workers: max_threads=$CFG_CODEX_MAX_THREADS, max_depth=$CFG_CODEX_MAX_DEPTH.
- agents.job_max_runtime_seconds=$CFG_CODEX_JOB_TIMEOUT applies only to spawn_agents_on_csv batch jobs; it is not a general timeout for arbitrary native children.
- Non-batch native-child lifecycle and timeout remain controller-supervised and otherwise unknown.
- Native-child admission is pane-local, not shared; do not treat per-pane caps as an aggregate budget. Performance and fanout remain a pilot pending measured shared admission.

## Lane Discipline — INTERACTIVE
- The lead or appointed grid supervisor manages this pane as a long-lived external subagent lane.
- Preserve lane context between turns. Follow-up prompts are continuations of the same session, not fresh starts.
- Do not ask the lead to spawn a replacement worker if this pane already has the relevant context; expect harvest-and-reprompt instead.
- Keep your scope clean. Do not contaminate this lane with unrelated workstreams.

## tmux Input Model — INTERACTIVE SESSION
- Follow-up instructions arrive through \`tmux send-keys\` via \`tmup_reprompt\`.
- The supervisor may harvest pane output and reprompt you while the session remains alive.
- The supervisor reprompts only after this pane reaches a verified idle prompt; active-pane queue delivery is disabled without a pane-specific receipt.
- Never tell the lead to type shell commands directly into the pane to continue your work.
- Treat reprompts as authoritative updates to objective, priority, or constraints.
CODEX_CONTRACT
fi)

$COORDINATION_CONTRACT

## Process Context
- You are operating inside a supervised SDLC workflow: discover, plan, implement, verify, review, and document.
- Your output will be adversarially reviewed. Every claim should be backed by repo evidence, test output, or cited documentation.
- \`TMUP_WORKING_DIR\` is your working root. Stay inside the assigned scope and surface uncertainty to the supervisor.

## Quality Posture
- Act as a skeptic and adversarial reviewer of your own work.
- Verify assumptions before building on them.
- Evaluate every changed line for correctness, security, conventions, and regression risk.
- Prefer explicit evidence over intuition. If evidence conflicts, stop and resolve the contradiction.
- Run relevant verification as you go; do not leave all checking for the end.
- Escalate blockers, ambiguity, or upstream defects early instead of silently guessing.

## Constraints
$AGENT_INSTRUCTIONS
EOF
)

# Write controller-interpreted artifacts outside every worker-writable root.
PROMPT_FILE="$TMUP_CONTROL_ARTIFACT_DIR/prompt-${PANE_INDEX}-${AGENT_ID}.txt"
[[ ! -e "$PROMPT_FILE" && ! -L "$PROMPT_FILE" ]] || die "Controller prompt path already exists"
echo "$FULL_PROMPT" > "$PROMPT_FILE"
chmod 600 "$PROMPT_FILE"
PROMPT_HASH=$(_hash_file "$PROMPT_FILE")

# Write launcher wrapper script with env vars baked in (security: no shell interpolation in send-keys)
LAUNCHER="$TMUP_CONTROL_ARTIFACT_DIR/launcher-${PANE_INDEX}-${AGENT_ID}.sh"
[[ ! -e "$LAUNCHER" && ! -L "$LAUNCHER" ]] || die "Controller launcher path already exists"

_encode_shell_env_setting() {
  local key="$1" value="$2" toml_value
  toml_value=$(jq -Rn --arg value "$value" '$value') || return 1
  printf '%q' "shell_environment_policy.set.$key=$toml_value"
}

SHELL_ENV_AGENT_ID=$(_encode_shell_env_setting TMUP_AGENT_ID "$AGENT_ID") || die "Failed to encode TMUP_AGENT_ID"
SHELL_ENV_PANE_INDEX=$(_encode_shell_env_setting TMUP_PANE_INDEX "$PANE_INDEX") || die "Failed to encode TMUP_PANE_INDEX"
SHELL_ENV_WORKING_DIR=$(_encode_shell_env_setting TMUP_WORKING_DIR "$WORKING_DIR") || die "Failed to encode TMUP_WORKING_DIR"
SHELL_ENV_TMPDIR=$(_encode_shell_env_setting TMPDIR "$TASK_TMP_DIR") || die "Failed to encode TMPDIR"
SHELL_ENV_TMP=$(_encode_shell_env_setting TMP "$TASK_TMP_DIR") || die "Failed to encode TMP"
SHELL_ENV_TEMP=$(_encode_shell_env_setting TEMP "$TASK_TMP_DIR") || die "Failed to encode TEMP"
SHELL_ENV_TASK_ID_ARG=""
if [[ -n "$TASK_ID" ]]; then
  SHELL_ENV_TASK_ID=$(_encode_shell_env_setting TMUP_TASK_ID "$TASK_ID") || die "Failed to encode TMUP_TASK_ID"
  SHELL_ENV_TASK_ID_ARG="    -c $SHELL_ENV_TASK_ID"
fi
SHELL_ENV_TRUSTED_ARGS=""
TRUSTED_ADD_DIR_ARG=""
if [[ "$TRUSTED_SHARED_STATE" -eq 1 ]]; then
  SHELL_ENV_DB=$(_encode_shell_env_setting TMUP_DB "$DB_PATH") || die "Failed to encode TMUP_DB"
  SHELL_ENV_SESSION_NAME=$(_encode_shell_env_setting TMUP_SESSION_NAME "$SESSION_NAME") || die "Failed to encode TMUP_SESSION_NAME"
  SHELL_ENV_SESSION_DIR=$(_encode_shell_env_setting TMUP_SESSION_DIR "$STATE_DIR") || die "Failed to encode TMUP_SESSION_DIR"
  SHELL_ENV_TRUSTED_ARGS="    -c $SHELL_ENV_DB
    -c $SHELL_ENV_SESSION_NAME
    -c $SHELL_ENV_SESSION_DIR"
  TRUSTED_ADD_DIR_ARG='    --add-dir "$TMUP_SESSION_DIR"'
fi
MODEL_ARG=""
if [[ "$CFG_CODEX_MODEL" != "auto" ]]; then
  MODEL_ARG='    -m "$TMUP_CODEX_MODEL"'
fi

cat > "$LAUNCHER" <<WRAPPER
#!/bin/bash
unset BASH_ENV ENV SDLC_OS_PLUGIN NODE_OPTIONS NODE_PATH
unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
unset PERL5OPT PERL5LIB PYTHONPATH PYTHONHOME RUBYOPT RUBYLIB
export TMUP_AGENT_ID=$(printf '%q' "$AGENT_ID")
TMUP_DB=$(printf '%q' "$DB_PATH")
export TMUP_PANE_INDEX=$(printf '%q' "$PANE_INDEX")
TMUP_SESSION_NAME=$(printf '%q' "$SESSION_NAME")
TMUP_SESSION_DIR=$(printf '%q' "$STATE_DIR")
export CODEX_BIN=$(printf '%q' "$CODEX_BIN")
export CLAUDE_BIN=$(printf '%q' "$CLAUDE_BIN")
export TMUP_NODE_BIN=$(printf '%q' "$NODE_BIN")
export TMUP_CODEX_NODE_WRAPPED=$(printf '%q' "$CODEX_NODE_WRAPPED")
export TMUP_WORKING_DIR=$(printf '%q' "$WORKING_DIR")
export TMUP_TASK_TMPDIR=$(printf '%q' "$TASK_TMP_DIR")
export TMUP_CODEX_MODEL=$(printf '%q' "$CFG_CODEX_MODEL")
export TMUP_CODEX_APPROVAL_POLICY=$(printf '%q' "$CFG_CODEX_APPROVAL_POLICY")
export TMUP_CODEX_SANDBOX=$(printf '%q' "$CFG_CODEX_SANDBOX")
export TMUP_CODEX_NO_ALT_SCREEN=$(printf '%q' "$CFG_CODEX_NO_ALT_SCREEN")
export TMUP_CODEX_REASONING_EFFORT=$(printf '%q' "$CFG_CODEX_REASONING_EFFORT")
export TMUP_CODEX_REASONING_SUMMARY=$(printf '%q' "$CFG_CODEX_REASONING_SUMMARY")
export TMUP_CODEX_PLAN_REASONING=$(printf '%q' "$CFG_CODEX_PLAN_REASONING")
export TMUP_CODEX_VERBOSITY=$(printf '%q' "$CFG_CODEX_VERBOSITY")
export TMUP_CODEX_SERVICE_TIER=$(printf '%q' "$CFG_CODEX_SERVICE_TIER")
export TMUP_CODEX_TOOL_OUTPUT_LIMIT=$(printf '%q' "$CFG_CODEX_TOOL_OUTPUT_LIMIT")
export TMUP_CODEX_WEB_SEARCH=$(printf '%q' "$CFG_CODEX_WEB_SEARCH")
export TMUP_CODEX_HISTORY=$(printf '%q' "$CFG_CODEX_HISTORY")
export TMUP_CODEX_SHELL_INHERIT=$(printf '%q' "$CODEX_SHELL_INHERIT")
unset TMUP_CODEX_SHELL_INHERIT_OVERRIDE
export TMUP_CODEX_SHELL_SNAPSHOT=$(printf '%q' "$CFG_CODEX_SHELL_SNAPSHOT")
export TMUP_CODEX_REQUEST_COMPRESSION=$(printf '%q' "$CFG_CODEX_REQUEST_COMPRESSION")
export TMUP_CODEX_NOTIFICATIONS=$(printf '%q' "$CFG_CODEX_NOTIFICATIONS")
export TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT=$(printf '%q' "$CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT")
export TMUP_CODEX_MAX_THREADS=$(printf '%q' "$CFG_CODEX_MAX_THREADS")
export TMUP_CODEX_MAX_DEPTH=$(printf '%q' "$CFG_CODEX_MAX_DEPTH")
export TMUP_CODEX_JOB_TIMEOUT=$(printf '%q' "$CFG_CODEX_JOB_TIMEOUT")
$(if [[ -n "$TASK_ID" ]]; then printf 'export TMUP_TASK_ID=%q' "$TASK_ID"; fi)
$(if [[ -n "$RESUME_SESSION_ID" ]]; then printf 'export RESUME_SESSION_ID=%q' "$RESUME_SESSION_ID"; fi)
_CLI_PATH=$(printf '%q' "$CLI_PATH")
_HB_INTERVAL=${CFG_HEARTBEAT_INTERVAL:-60}
_WORKER_TYPE=$(printf '%q' "$WORKER_TYPE")
_PROMPT_FILE=$(printf '%q' "$PROMPT_FILE")
_PROMPT_HASH=$(printf '%q' "$PROMPT_HASH")
_CONTROL_TASK_ROOT=$(printf '%q' "$TMUP_CONTROL_TASK_ROOT")
_CLAUDE_OUTPUT=$(printf '%q' "$TMUP_CONTROL_LOG_DIR/session-output-${AGENT_ID}.json")
_SYSTEM_RM_BIN=$(printf '%q' "$SYSTEM_RM_BIN")
_SYSTEM_SLEEP_BIN=$(printf '%q' "$SYSTEM_SLEEP_BIN")

_cleanup_task_tmp() {
  if [[ "\${TMUP_TASK_TMPDIR:-}" == "\$_CONTROL_TASK_ROOT"/task-tmp-"\$TMUP_PANE_INDEX"-"\$TMUP_AGENT_ID".* && \
        -d "\$TMUP_TASK_TMPDIR" && ! -L "\$TMUP_TASK_TMPDIR" ]]; then
    "\$_SYSTEM_RM_BIN" -rf -- "\$TMUP_TASK_TMPDIR"
  fi
}
trap _cleanup_task_tmp EXIT

"\$_SYSTEM_RM_BIN" -f "\$0" 2>/dev/null || true

if [[ "\$_WORKER_TYPE" == "claude_code" ]]; then
  _prompt_hash_now=""
  if command -v shasum >/dev/null 2>&1; then
    _prompt_hash_now=\$(shasum -a 256 "\$_PROMPT_FILE" | awk '{print \$1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    _prompt_hash_now=\$(sha256sum "\$_PROMPT_FILE" | awk '{print \$1}')
  fi
  [[ -f "\$_PROMPT_FILE" && ! -L "\$_PROMPT_FILE" && "\$_prompt_hash_now" == "\$_PROMPT_HASH" ]] || exit 74
  [[ ! -e "\$_CLAUDE_OUTPUT" && ! -L "\$_CLAUDE_OUTPUT" ]] || exit 74
  (umask 077; : > "\$_CLAUDE_OUTPUT") || exit 74
  chmod 600 "\$_CLAUDE_OUTPUT" || exit 74
fi

if [[ "\$_WORKER_TYPE" == "claude_code" ]]; then
  # Claude Code worker — platform-enforced background heartbeat (matches codex).
  # This background loop guarantees liveness so stale-agent recovery doesn't
  # mistakenly reclaim a live one-shot lane.
  (
    _HB_SLEEP_PID=""
    _stop_heartbeat() {
      if [[ -n "\$_HB_SLEEP_PID" ]]; then
        kill "\$_HB_SLEEP_PID" 2>/dev/null || true
        wait "\$_HB_SLEEP_PID" 2>/dev/null || true
      fi
      exit 0
    }
    trap _stop_heartbeat TERM INT
    while true; do
      "\$_SYSTEM_SLEEP_BIN" "\$_HB_INTERVAL" &
      _HB_SLEEP_PID=\$!
      wait "\$_HB_SLEEP_PID" || true
      _HB_SLEEP_PID=""
      TMUP_AGENT_ID="\$TMUP_AGENT_ID" TMUP_DB="\$TMUP_DB" TMUP_PANE_INDEX="\$TMUP_PANE_INDEX" \\
        TMUP_SESSION_NAME="\$TMUP_SESSION_NAME" TMUP_SESSION_DIR="\$TMUP_SESSION_DIR" \\
        "\$TMUP_NODE_BIN" "\$_CLI_PATH" heartbeat 2>/dev/null || true
    done
  ) &
  _HB_PID=\$!

  cd "\$TMUP_WORKING_DIR" && \\
    TMPDIR="\$TMUP_TASK_TMPDIR" TMP="\$TMUP_TASK_TMPDIR" TEMP="\$TMUP_TASK_TMPDIR" "\$CLAUDE_BIN" -p \\
    --permission-mode bypassPermissions \\
    --plugin-dir $(printf '%q' "$PLUGIN_DIR") \\
    --max-budget-usd 3.00 \\
    < "\$_PROMPT_FILE" \\
    > "\$_CLAUDE_OUTPUT" 2>&1
  _EXIT=\$?

  # Kill heartbeat loop when claude exits
  kill "\$_HB_PID" 2>/dev/null
  wait "\$_HB_PID" 2>/dev/null
  "\$_SYSTEM_RM_BIN" -f "\$_PROMPT_FILE" 2>/dev/null || true
  exit "\$_EXIT"
else
  # Codex worker — runtime contract pinned from policy.yaml-sourced env vars
  if [[ "\$TMUP_CODEX_NODE_WRAPPED" == "1" ]]; then
    _CODEX_COMMAND=("\$TMUP_NODE_BIN" "\$CODEX_BIN")
  else
    _CODEX_COMMAND=("\$CODEX_BIN")
  fi
  _INLINE_ARGS=()
  if [[ "\${TMUP_CODEX_NO_ALT_SCREEN}" == "true" ]]; then
    _INLINE_ARGS+=(--no-alt-screen)
  fi

  _COMMON_ARGS=(
$MODEL_ARG
    -a "\$TMUP_CODEX_APPROVAL_POLICY"
    -s "\$TMUP_CODEX_SANDBOX"
    --add-dir "\$TMUP_TASK_TMPDIR"
$TRUSTED_ADD_DIR_ARG
    -c "sandbox_workspace_write.exclude_slash_tmp=true"
    -c "sandbox_workspace_write.exclude_tmpdir_env_var=true"
    -c "sandbox_workspace_write.network_access=false"
    -c "model_reasoning_effort=\$TMUP_CODEX_REASONING_EFFORT"
    -c "model_reasoning_summary=\$TMUP_CODEX_REASONING_SUMMARY"
    -c "plan_mode_reasoning_effort=\$TMUP_CODEX_PLAN_REASONING"
    -c "model_verbosity=\$TMUP_CODEX_VERBOSITY"
    -c "service_tier=\$TMUP_CODEX_SERVICE_TIER"
    -c "tool_output_token_limit=\$TMUP_CODEX_TOOL_OUTPUT_LIMIT"
    -c "web_search=\$TMUP_CODEX_WEB_SEARCH"
    -c "history.persistence=\$TMUP_CODEX_HISTORY"
    -c "shell_environment_policy.inherit=\$TMUP_CODEX_SHELL_INHERIT"
    -c $SHELL_ENV_AGENT_ID
    -c $SHELL_ENV_PANE_INDEX
    -c $SHELL_ENV_WORKING_DIR
    -c $SHELL_ENV_TMPDIR
    -c $SHELL_ENV_TMP
    -c $SHELL_ENV_TEMP
$SHELL_ENV_TASK_ID_ARG
$SHELL_ENV_TRUSTED_ARGS
    -c "features.shell_snapshot=\$TMUP_CODEX_SHELL_SNAPSHOT"
    -c "features.enable_request_compression=\$TMUP_CODEX_REQUEST_COMPRESSION"
    -c "tui.notifications=\$TMUP_CODEX_NOTIFICATIONS"
    -c "background_terminal_max_timeout=\$TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT"
    -c "agents.max_threads=\$TMUP_CODEX_MAX_THREADS"
    -c "agents.max_depth=\$TMUP_CODEX_MAX_DEPTH"
    -c "agents.job_max_runtime_seconds=\$TMUP_CODEX_JOB_TIMEOUT"
    -C "\$TMUP_WORKING_DIR"
  )
  _COMMON_ARGS+=("\${_INLINE_ARGS[@]}")

  # Background heartbeat — child of launcher, dies with codex
  (
    _HB_SLEEP_PID=""
    _stop_heartbeat() {
      if [[ -n "\$_HB_SLEEP_PID" ]]; then
        kill "\$_HB_SLEEP_PID" 2>/dev/null || true
        wait "\$_HB_SLEEP_PID" 2>/dev/null || true
      fi
      exit 0
    }
    trap _stop_heartbeat TERM INT
    while true; do
      "\$_SYSTEM_SLEEP_BIN" "\$_HB_INTERVAL" &
      _HB_SLEEP_PID=\$!
      wait "\$_HB_SLEEP_PID" || true
      _HB_SLEEP_PID=""
      TMUP_AGENT_ID="\$TMUP_AGENT_ID" TMUP_DB="\$TMUP_DB" TMUP_PANE_INDEX="\$TMUP_PANE_INDEX" \\
        TMUP_SESSION_NAME="\$TMUP_SESSION_NAME" TMUP_SESSION_DIR="\$TMUP_SESSION_DIR" \\
        "\$TMUP_NODE_BIN" "\$_CLI_PATH" heartbeat 2>/dev/null || true
    done
  ) &
  _HB_PID=\$!

  # Run codex as foreground child — interactive session, no prompt arg.
  # Outer dispatch-agent.sh waits for codex to be ready, then sends the
  # initial prompt via send_codex_prompt_with_retry (interactive session model).
  if [[ -n "\${RESUME_SESSION_ID:-}" ]]; then
    # Reapply the current runtime contract on resume so recovered panes stay pinned
    # to the configured model, approval, sandbox, and subagent caps.
    "\${_CODEX_COMMAND[@]}" "\${_COMMON_ARGS[@]}" resume "\$RESUME_SESSION_ID"
  else
    "\${_CODEX_COMMAND[@]}" "\${_COMMON_ARGS[@]}"
  fi
  _EXIT=\$?

  # Kill heartbeat loop when codex exits
  kill "\$_HB_PID" 2>/dev/null
  wait "\$_HB_PID" 2>/dev/null
  exit "\$_EXIT"
fi
WRAPPER
chmod 700 "$LAUNCHER"
LAUNCHER_HASH=$(_hash_file "$LAUNCHER")
_verify_control_artifact "$PROMPT_FILE" 600 "$PROMPT_HASH" || {
  _dispatch_cleanup
  die "Controller prompt integrity check failed before pane reservation"
}
_verify_control_artifact "$LAUNCHER" 700 "$LAUNCHER_HASH" || {
  _dispatch_cleanup
  die "Controller launcher integrity check failed before pane reservation"
}

# Resolve the grid-state pane ID against the exact live session before any
# mutation. Pane IDs remain exact regardless of tmux window/pane base indexes.
if ! PANE_TARGET=$(tmup_exact_pane_target "$SESSION_NAME" "$PANE_INDEX"); then
  _dispatch_cleanup
  die "Could not verify exact live pane target for session $SESSION_NAME pane $PANE_INDEX"
fi

# Reserve pane BEFORE launch — fail closed on lock failure
GRID_STATE="$STATE_DIR/grid/grid-state.json"

if [[ -f "$GRID_STATE" ]]; then
  _validate_grid_directory && _validate_single_link_regular "$GRID_STATE" "grid state" || {
    _dispatch_cleanup
    die "Grid state boundary changed before pane reservation"
  }
  if ! tmup_lock_acquire "$LOCK_FILE" 5 9; then
    _dispatch_cleanup
    die "Failed to acquire grid state lock — another operation in progress"
  fi

  # Pull pane status from the grid state under the held cross-platform lock. A single jq
  # pass returns empty EITHER when the pane index is missing from .panes[]
  # OR when a matched pane carries no .status field. Both are fatal here,
  # so one non-empty check covers both. tmup authors grid-state.json itself
  # and always sets .status on every pane (see grid-setup.sh), so the
  # "found but no status" branch is not a reachable runtime state.
  _pane_status=$(jq -r --argjson idx "$PANE_INDEX" '.panes[] | select(.index == $idx) | .status // ""' "$GRID_STATE")
  [[ -n "$_pane_status" ]] || {
    tmup_lock_release "$LOCK_FILE" 9
    _dispatch_cleanup
    die "Pane $PANE_INDEX not found in grid state"
  }
  if [[ "$_pane_status" != "available" ]]; then
    tmup_lock_release "$LOCK_FILE" 9
    _dispatch_cleanup
    die "Pane $PANE_INDEX is not available (status '$_pane_status')"
  fi

  # Verify pane occupancy while holding the grid lock. A shell launcher can
  # hide foreground descendants, so an uncertain process-tree inspection is
  # fatal rather than permission to clear or reuse the pane.
  if PANE_CMD=$(pane_occupancy_command "$SESSION_NAME" "$PANE_INDEX"); then
    tmup_lock_release "$LOCK_FILE" 9
    _dispatch_cleanup
    die "Pane $PANE_INDEX is marked available but occupied by $PANE_CMD; refusing to dispatch"
  else
    _occupancy_status=$?
    if [[ "$_occupancy_status" -ne 1 ]]; then
      tmup_lock_release "$LOCK_FILE" 9
      _dispatch_cleanup
      die "Could not verify occupancy for pane $PANE_INDEX"
    fi
  fi

  _temp=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX") || {
    tmup_lock_release "$LOCK_FILE" 9
    _dispatch_cleanup
    die "Failed to create temp file for grid state"
  }
  if jq --argjson idx "$PANE_INDEX" --arg role "$ROLE" --arg aid "$AGENT_ID" \
    '(.panes[] | select(.index == $idx)) |= . + {status: "reserved", role: $role, agent_id: $aid}' \
    "$GRID_STATE" > "$_temp" && [[ -s "$_temp" ]]; then
    # The replace is the reservation commit point. Mark conservative intent
    # first so an asynchronous signal cannot expose a reserved pane as free.
    RESERVATION_ACTIVE=1
    mv "$_temp" "$GRID_STATE" || {
      tmup_lock_release "$LOCK_FILE" 9
      _dispatch_cleanup
      die "Failed to commit pane $PANE_INDEX reservation"
    }
  else
    rm -f "$_temp"
    tmup_lock_release "$LOCK_FILE" 9
    _dispatch_cleanup
    die "Failed to reserve pane $PANE_INDEX in grid state"
  fi
  tmup_lock_release "$LOCK_FILE" 9
else
  # No grid state — still check pane occupancy
  if PANE_CMD=$(pane_occupancy_command "$SESSION_NAME" "$PANE_INDEX"); then
    _dispatch_cleanup
    die "Pane $PANE_INDEX has a running agent ($PANE_CMD)"
  else
    _occupancy_status=$?
    if [[ "$_occupancy_status" -ne 1 ]]; then
      _dispatch_cleanup
      die "Could not verify occupancy for pane $PANE_INDEX"
    fi
  fi
fi

# Launch — all env vars are in the launcher script, no interpolation in send-keys
tmux send-keys -t "$PANE_TARGET" C-c 2>/dev/null || true
sleep 0.1
tmux send-keys -t "$PANE_TARGET" C-u 2>/dev/null || true
sleep 0.1

printf -v _launch_command '/bin/bash -p %q' "$LAUNCHER"
# send-keys is an asynchronous launch boundary. From this point onward,
# failure or interruption is treated as possibly delivered until respawn and
# occupancy checks prove the pane stopped.
LAUNCH_SENT=1
if ! tmux send-keys -t "$PANE_TARGET" "$_launch_command" Enter 2>/dev/null; then
  die "Failed to send launch command to pane $PANE_INDEX — delivery is ambiguous and rollback requires a verified pane stop"
fi
if [[ -n "${_TMUP_CONTROLLER_TEST_DIR_PHYSICAL:-}" && \
      "${TMUP_TEST_SIGNAL_AFTER_LAUNCH_SEND:-0}" == "1" ]]; then
  kill -TERM "$$"
fi
echo "TMUP_DISPATCH_LAUNCH_SENT=1"

# --- Post-launch monitoring (codex workers only) ---
# Trust prompt acceptance, readiness polling, initial prompt sending,
# and session ID capture. A Codex dispatch is not committed until the initial
# prompt is confirmed. For claude_code workers, the launcher handles the
# one-shot stdin contract directly.

_persist_receipted_resume_id() {
  local codex_sid="$1" temp_file="" cli_path="$CLI_PATH"
  _validate_grid_directory && _validate_single_link_regular "$GRID_STATE" "grid state" || return 1
  tmup_lock_acquire "$LOCK_FILE" 5 9 2>/dev/null || return 1
  temp_file=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX" 2>/dev/null) || temp_file=""
  if [[ -z "$temp_file" ]] || ! jq --argjson idx "$PANE_INDEX" --arg csid "$codex_sid" \
    '(.panes[] | select(.index == $idx)).codex_session_id = $csid' \
    "$GRID_STATE" > "$temp_file" 2>/dev/null || [[ ! -s "$temp_file" ]]; then
    [[ -z "$temp_file" ]] || rm -f "$temp_file"
    tmup_lock_release "$LOCK_FILE" 9
    return 1
  fi
  mv "$temp_file" "$GRID_STATE" || {
    rm -f "$temp_file"
    tmup_lock_release "$LOCK_FILE" 9
    return 1
  }
  tmup_lock_release "$LOCK_FILE" 9

  TMUP_AGENT_ID="$AGENT_ID" TMUP_DB="$DB_PATH" TMUP_PANE_INDEX="$PANE_INDEX" \
    TMUP_SESSION_NAME="$SESSION_NAME" TMUP_SESSION_DIR="$STATE_DIR" \
    "$NODE_BIN" "$cli_path" heartbeat --codex-session-id "$codex_sid" 2>/dev/null || true
}

_run_post_launch() {
  # Trust prompt auto-accept — narrow check to exact pane only
  local attempts=$((CFG_TRUST_SECONDS / 2))
  [[ $attempts -lt 1 ]] && attempts=1
  local _attempt
  for ((_attempt = 1; _attempt <= attempts; _attempt++)); do
    sleep 2
    local trust_check
    trust_check=$(tmux capture-pane -t "$PANE_TARGET" -p -S -10 2>/dev/null || true)
    # Narrow pattern: only accept the specific codex trust prompt ("Do you trust ...?")
    # Anchored to start-of-line to avoid matching agent output paragraphs
    if echo "$trust_check" | grep -qiE "^[[:space:]]*Do you trust([[:space:]]|$)"; then
      tmux send-keys -t "$PANE_TARGET" Enter
      echo "Trust prompt accepted (attempt $_attempt)"
      break
    fi
    echo "$trust_check" | grep -qF "Working (" && break
  done

  # Wait for codex to be ready for input (idle at its prompt)
  echo "Waiting for codex to become ready..."
  local _ready_attempt
  for ((_ready_attempt = 1; _ready_attempt <= 20; _ready_attempt++)); do
    sleep 1
    local ready_check
    ready_check=$(tmux capture-pane -t "$PANE_TARGET" -p -S -5 2>/dev/null || true)
    if echo "$ready_check" | grep -qE '❯|›'; then
      echo "Codex ready in pane $PANE_INDEX (attempt $_ready_attempt)"
      break
    fi
  done

  # Send the initial prompt via tmux send-keys
  if [[ -f "$PROMPT_FILE" ]]; then
    local prompt_text
    if ! _verify_control_artifact "$PROMPT_FILE" 600 "$PROMPT_HASH"; then
      rm -f "$PROMPT_FILE" 2>/dev/null || true
      echo "ERROR: controller prompt integrity check failed before delivery" >&2
      return 1
    fi
    prompt_text=$(cat "$PROMPT_FILE")
    if send_codex_prompt_with_retry "$SESSION_NAME" "$PANE_INDEX" "$prompt_text" "dispatch"; then
      rm -f "$PROMPT_FILE" 2>/dev/null || true
      echo "Initial prompt confirmed in pane $PANE_INDEX"
    else
      rm -f "$PROMPT_FILE" 2>/dev/null || true
      echo "ERROR: failed to confirm Codex accepted initial prompt for pane $PANE_INDEX" >&2
      return 1
    fi
  fi

  # Do not infer this pane's session ID from the process-global history tail.
  # Concurrent panes commonly share a cwd, so history cwd is not an identity
  # receipt. Resume metadata remains absent unless a future runtime exposes a
  # pane-specific session receipt.
  if [[ -n "$RESUME_SESSION_ID" ]]; then
    if _persist_receipted_resume_id "$RESUME_SESSION_ID"; then
      echo "Codex session ID: $RESUME_SESSION_ID"
      echo "Resume through tmup_dispatch with resume_session_id: $RESUME_SESSION_ID"
    else
      echo "WARNING: resumed session ID could not be persisted to controller state" >&2
    fi
  fi
}

if [[ "$WORKER_TYPE" == "claude_code" ]]; then
  # claude_code workers are self-contained — prompt piped via stdin in the
  # launcher. No trust prompt, readiness check, or session ID to capture.
  # PROMPT_FILE is consumed by the launcher (stdin redirect + rm after claude
  # exits). We cannot delete it here — tmux send-keys is async, so the
  # launcher may not have opened the fd yet. Bounded by session lifecycle.
  DISPATCH_COMMITTED=1
  echo "Dispatched $ROLE to pane $PANE_INDEX (agent $AGENT_ID)"
  exit 0
fi

if ! _run_post_launch; then
  exit 1
fi
DISPATCH_COMMITTED=1
echo "Dispatched $ROLE to pane $PANE_INDEX (agent $AGENT_ID)"
