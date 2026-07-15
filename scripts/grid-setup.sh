#!/bin/bash
# grid-setup.sh — Create or verify a tmux NxM grid for tmup (default 2x4)
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
    echo "grid-setup.sh: trusted system readlink is unavailable" >&2
    return 1
  }
  while [[ -L "$source_path" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || return 1
    source_dir="${source_path%/*}"
    [[ "$source_dir" != "$source_path" ]] || source_dir="."
    source_dir=$(cd -P -- "$source_dir" && pwd -P) || return 1
    link_target=$("$readlink_bin" "$source_path") || return 1
    [[ "$link_target" == /* ]] && source_path="$link_target" || source_path="$source_dir/$link_target"
  done
  source_dir="${source_path%/*}"
  [[ "$source_dir" != "$source_path" ]] || source_dir="."
  cd -P -- "$source_dir" && pwd -P
}

SCRIPT_DIR="$(_tmup_resolve_script_dir "${BASH_SOURCE[0]}")" || exit 1
unset -f _tmup_resolve_script_dir
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

usage() {
  printf '%s\n' 'Usage: grid-setup.sh --project-dir <path> [--session <name>]

Create or verify the tmup tmux grid for a project directory.

Options:
  --project-dir <path>  Project directory used for registry lookup.
  --session <name>      Explicit tmup session name.
  -h, --help            Show this help.'
}

PROJECT_DIR=""
_TMUP_PREFLIGHT_SESSION=""
_TMUP_SHOW_HELP=0
_tmup_preparse_setup_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-dir)
        [[ $# -ge 2 && -z "$PROJECT_DIR" ]] || return 1
        PROJECT_DIR="$2"
        shift 2
        ;;
      --session)
        [[ $# -ge 2 && -z "$_TMUP_PREFLIGHT_SESSION" ]] || return 1
        _TMUP_PREFLIGHT_SESSION="$2"
        shift 2
        ;;
      -h|--help)
        _TMUP_SHOW_HELP=1
        shift
        ;;
      *) return 1 ;;
    esac
  done
}
_tmup_preparse_setup_args "$@" || {
  echo "grid-setup.sh: invalid, duplicate, or incomplete arguments" >&2
  exit 1
}
unset -f _tmup_preparse_setup_args

_TMUP_PREFLIGHT_PROJECT=""
if [[ "$_TMUP_SHOW_HELP" -eq 0 ]]; then
  [[ -n "$PROJECT_DIR" && "$PROJECT_DIR" == /* && -d "$PROJECT_DIR" ]] || {
    echo "ERROR: --project-dir must be an absolute existing directory" >&2
    exit 1
  }
  _TMUP_PREFLIGHT_PROJECT=$(cd -P -- "$PROJECT_DIR" && pwd -P) || exit 1
fi

source "$SCRIPT_DIR/lib/controller-bootstrap.sh"
tmup_controller_establish_toolchain "$_TMUP_PREFLIGHT_PROJECT" "$PLUGIN_DIR" create-state-root || {
  echo "grid-setup.sh: trusted controller toolchain validation failed" >&2
  exit 1
}

if [[ "$_TMUP_SHOW_HELP" -eq 1 ]]; then
  usage
  exit 0
fi
PROJECT_DIR="$_TMUP_PREFLIGHT_PROJECT"
if [[ -n "$_TMUP_PREFLIGHT_SESSION" ]]; then
  export TMUP_SESSION_NAME="$_TMUP_PREFLIGHT_SESSION"
fi

source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/prerequisites.sh"
source "$SCRIPT_DIR/lib/portable-system.sh"
source "$SCRIPT_DIR/lib/grid-identity.sh"
source "$SCRIPT_DIR/lib/grid-registry.sh"

# Check for existing grid
_existing=$(registry_lookup "$PROJECT_DIR" 2>/dev/null) || _existing=""
if [[ -n "$_existing" && -z "${TMUP_SESSION_NAME:-}" ]]; then
  echo "Grid already registered for $PROJECT_DIR: $_existing"
  export TMUP_SESSION_NAME="$_existing"
  CFG_SESSION_NAME="$_existing"
  CFG_STATE_DIR="$CFG_STATE_ROOT/$CFG_SESSION_NAME"
fi
unset _existing

# Generate session name if needed
if [[ -z "${CFG_SESSION_NAME:-}" ]]; then
  CFG_SESSION_NAME=$(generate_grid_id "$CFG_SESSION_PREFIX")
  export TMUP_SESSION_NAME="$CFG_SESSION_NAME"
  CFG_STATE_DIR="$CFG_STATE_ROOT/$CFG_SESSION_NAME"
fi

SESSION_NAME="$CFG_SESSION_NAME"
SESSION_TARGET="=$SESSION_NAME"
STATE_DIR="$CFG_STATE_DIR"
GRID_ROWS="$CFG_ROWS"
GRID_COLS="$CFG_COLS"
EXPECTED_PANES="$CFG_TOTAL_PANES"

check_prerequisites || exit 1

# Fail closed: refuse to create grid if config could not be read from policy.yaml
# (e.g., yq missing or broken while policy.yaml exists). This prevents silent fallback
# to default 2x4 when the user has configured a different grid.
if [[ "${CFG_CONFIG_DEGRADED:-0}" -eq 1 ]]; then
  echo "ERROR: Cannot create grid — policy.yaml exists but could not be read (yq missing or broken)." >&2
  echo "Install yq (https://github.com/mikefarah/yq) or remove policy.yaml to use defaults." >&2
  exit 1
fi

verify_existing_grid_receipt() {
  verify_complete_grid_receipt \
    "$SESSION_NAME" "$SESSION_TARGET" "$STATE_DIR" "$_REGISTRY_FILE" \
    "$PROJECT_DIR" "$GRID_ROWS" "$GRID_COLS" "$EXPECTED_PANES"
}

# Idempotency is receipted, not inferred from a matching name or pane count.
if tmux has-session -t "$SESSION_TARGET" 2>/dev/null; then
  if verify_existing_grid_receipt; then
    install -m 600 /dev/stdin "$CFG_STATE_ROOT/current-session" <<< "$SESSION_NAME"
    echo "Grid already exists with a verified receipt: $SESSION_NAME ($EXPECTED_PANES panes)"
    exit 0
  fi
  echo "ERROR: Exact session $SESSION_NAME exists but its grid receipt, registry, project identity, or pane IDs do not match." >&2
  echo "Inspect the exact session and run grid-teardown.sh --force only after confirming ownership, then rerun setup." >&2
  exit 1
fi

if [[ -e "$STATE_DIR/grid/grid-state.json" || -e "$STATE_DIR/grid-identity.json" ]]; then
  echo "ERROR: Refusing to overwrite stale grid receipts for absent session $SESSION_NAME." >&2
  echo "Inspect and remove them through the verified teardown/recovery path before rerunning setup." >&2
  exit 1
fi

umask 0077
mkdir -p "$STATE_DIR/grid" "$STATE_DIR/logs"
/bin/bash -p "$SCRIPT_DIR/sync-codex-agents.sh"

_SETUP_CREATED=0
_SETUP_REGISTERED=0
_SETUP_COMMITTED=0
_setup_verify_session_absent() {
  local listed_sessions status
  if listed_sessions=$(LC_ALL=C tmux list-sessions -F '#{session_name}' 2>&1); then
    ! printf '%s\n' "$listed_sessions" | grep -Fxq -- "$SESSION_NAME"
    return
  else
    status=$?
  fi
  [[ "$status" -eq 1 ]] || return 1
  case "$listed_sessions" in
    "no server running on "*|"failed to connect to server"*) return 0 ;;
    *) return 1 ;;
  esac
}

_cleanup_partial_setup() {
  local status=$? _pointer_file _current_pointer
  if [[ "$_SETUP_CREATED" -eq 1 && "$_SETUP_COMMITTED" -eq 0 ]]; then
    tmux kill-session -t "$SESSION_TARGET" 2>/dev/null || true
    if _setup_verify_session_absent; then
      if [[ "$_SETUP_REGISTERED" -eq 1 ]]; then
        registry_deregister "$SESSION_NAME" 2>/dev/null || status=1
      fi
      _pointer_file="$CFG_STATE_ROOT/current-session"
      if [[ -f "$_pointer_file" && ! -L "$_pointer_file" ]]; then
        _current_pointer=$(cat "$_pointer_file" 2>/dev/null) || _current_pointer=""
        if [[ "$_current_pointer" == "$SESSION_NAME" ]]; then
          rm -f "$_pointer_file" 2>/dev/null || status=1
        fi
      fi
      rm -f "$STATE_DIR/grid/grid-state.json" "$STATE_DIR/grid-identity.json" 2>/dev/null || status=1
    else
      echo "ERROR: Partial setup could not prove exact session death; retaining registry, pointer, and receipts for recovery: $SESSION_NAME" >&2
      status=1
    fi
  fi
  return "$status"
}
trap _cleanup_partial_setup EXIT

# Create NxM grid (dimensions from policy.yaml, default 2x4)
tmux new-session -d -s "$SESSION_NAME" -x "$CFG_WIDTH" -y "$CFG_HEIGHT"
_SETUP_CREATED=1

# Track first pane of each row for horizontal splitting
declare -a ROW_PANES
ROW_PANES[0]=$(tmux list-panes -s -t "$SESSION_TARGET" -F '#{pane_id}')
[[ "${ROW_PANES[0]}" =~ ^%[0-9]+$ ]] || { echo "ERROR: Failed to resolve initial pane ID" >&2; exit 1; }

# Create rows by splitting vertically (N-1 splits for N rows)
_bottom_pane="${ROW_PANES[0]}"
for ((_r = 1; _r < GRID_ROWS; _r++)); do
  _remaining=$((GRID_ROWS - _r))
  _total=$((_remaining + 1))
  _pct=$(( (_remaining * 100) / _total ))
  _bottom_pane=$(tmux split-window -t "$_bottom_pane" -v -l "${_pct}%" -P -F '#{pane_id}')
  ROW_PANES[$_r]="$_bottom_pane"
done

# For each row, create columns by splitting horizontally (M-1 splits per row)
for ((_r = 0; _r < GRID_ROWS; _r++)); do
  _right_pane="${ROW_PANES[$_r]}"
  for ((_c = 1; _c < GRID_COLS; _c++)); do
    _remaining=$((GRID_COLS - _c))
    _total=$((_remaining + 1))
    _pct=$(( (_remaining * 100) / _total ))
    _right_pane=$(tmux split-window -t "$_right_pane" -h -l "${_pct}%" -P -F '#{pane_id}')
  done
done

# Set a clean minimal prompt in each pane (hides user shell customizations like starship/p10k)
for _pane_id in $(tmux list-panes -s -t "$SESSION_TARGET" -F '#{pane_id}'); do
  tmux send-keys -t "$_pane_id" "unset PROMPT_COMMAND; unset -f starship_precmd 2>/dev/null; PS1='tmup \$ '; clear" Enter
done
sleep 0.5

# Write grid-state.json
PANE_INFO=$(tmux list-panes -s -t "$SESSION_TARGET" -F '#{pane_index} #{pane_id}')
TMUX_SESSION_ID=$(tmux display-message -t "$SESSION_TARGET" -p '#{session_id}') || {
  echo "ERROR: Could not receipt tmux session ID" >&2
  exit 1
}
TMUX_SESSION_CREATED=$(tmux display-message -t "$TMUX_SESSION_ID" -p '#{session_created}') || {
  echo "ERROR: Could not receipt tmux session creation time" >&2
  exit 1
}
[[ "$TMUX_SESSION_ID" =~ ^\$[0-9]+$ && "$TMUX_SESSION_CREATED" =~ ^[0-9]+$ && \
   "$TMUX_SESSION_CREATED" -gt 0 ]] || {
  echo "ERROR: tmux returned an invalid session identity receipt" >&2
  exit 1
}
TIMESTAMP=$(tmup_iso_timestamp)

# Build panes array safely with jq
PANES_JSON=$(echo "$PANE_INFO" | while IFS=' ' read -r pane_index pane_id; do
  jq -n --argjson idx "$pane_index" --arg pid "$pane_id" \
    '{index:$idx,pane_id:$pid,status:"available"}'
done | jq -s '.')

# Validate pane count matches expected grid layout
ACTUAL_COUNT=$(echo "$PANES_JSON" | jq 'length')
if [[ "$ACTUAL_COUNT" -ne "$EXPECTED_PANES" ]]; then
  echo "ERROR: Grid has $ACTUAL_COUNT panes but expected $EXPECTED_PANES — partial creation failure" >&2
  tmux kill-session -t "$SESSION_TARGET" 2>/dev/null || true
  exit 1
fi

# Write grid-state.json with proper JSON escaping
jq -n \
  --arg sn "$SESSION_NAME" \
  --arg pd "$PROJECT_DIR" \
  --arg tsi "$TMUX_SESSION_ID" \
  --argjson tsc "$TMUX_SESSION_CREATED" \
  --arg ts "$TIMESTAMP" \
  --argjson rows "$GRID_ROWS" \
  --argjson cols "$GRID_COLS" \
  --argjson panes "$PANES_JSON" \
  '{schema_version:2,session_name:$sn,project_dir:$pd,tmux_session_id:$tsi,tmux_session_created:$tsc,created_at:$ts,grid:{rows:$rows,cols:$cols},panes:$panes}' \
  > "$STATE_DIR/grid/grid-state.json"

register_grid "$SESSION_NAME"
registry_register "$SESSION_NAME" "$PROJECT_DIR"
_SETUP_REGISTERED=1
# Write current-session with restrictive permissions (matches shared/src/session-ops.ts mode 0o600)
install -m 600 /dev/stdin "$CFG_STATE_ROOT/current-session" <<< "$SESSION_NAME"
_SETUP_COMMITTED=1

# Apply grid styling if available
STYLE_SCRIPT="$HOME/.local/bin/tmux-grid-style.sh"
if [[ -x "$STYLE_SCRIPT" ]]; then
  _STYLE_SCRIPT_LOCATION=$(cd -P -- "${STYLE_SCRIPT%/*}" 2>/dev/null && \
    printf '%s/%s\n' "$PWD" "${STYLE_SCRIPT##*/}") || _STYLE_SCRIPT_LOCATION=""
  _STYLE_SCRIPT_PHYSICAL=$(_tmup_controller_resolve_file "$STYLE_SCRIPT" 2>/dev/null) || \
    _STYLE_SCRIPT_PHYSICAL=""
  if [[ -z "$_STYLE_SCRIPT_LOCATION" || -z "$_STYLE_SCRIPT_PHYSICAL" || \
        ! -f "$_STYLE_SCRIPT_PHYSICAL" || ! -x "$_STYLE_SCRIPT_PHYSICAL" || \
        -L "$_STYLE_SCRIPT_PHYSICAL" ]]; then
    echo "WARNING: Grid styling script could not be resolved through a trusted physical path; skipping" >&2
  elif _tmup_controller_path_contains "$PROJECT_DIR" "$_STYLE_SCRIPT_LOCATION" || \
       _tmup_controller_path_contains "$PROJECT_DIR" "$_STYLE_SCRIPT_PHYSICAL"; then
    echo "WARNING: Grid styling script is inside the project worker root; skipping" >&2
  elif ! /bin/bash -p "$_STYLE_SCRIPT_PHYSICAL" "$SESSION_NAME" 2>&1; then
    echo "WARNING: Grid styling script failed (non-fatal)" >&2
  fi
  unset _STYLE_SCRIPT_LOCATION _STYLE_SCRIPT_PHYSICAL
fi

# Auto-launch terminal
ATTACHED=$(tmux display-message -t "$SESSION_TARGET" -p '#{session_attached}' 2>/dev/null || echo "0")
if [[ "${TMUP_NO_TERMINAL:-}" == "1" ]]; then ATTACHED=1; fi

if [[ "$ATTACHED" -eq 0 ]]; then
  if command -v gnome-terminal &>/dev/null; then
    LAUNCH_DISPLAY=""
    [[ -S "/run/user/$(id -u)/wayland-0" ]] && LAUNCH_DISPLAY="wayland-0"
    LAUNCH_X=""
    [[ -e "/tmp/.X11-unix/X0" ]] && LAUNCH_X=":0"

    if [[ -n "$LAUNCH_DISPLAY" || -n "$LAUNCH_X" ]]; then
      WAYLAND_DISPLAY="${LAUNCH_DISPLAY:-}" DISPLAY="${LAUNCH_X:-}" \
        gnome-terminal --maximize --title="tmup Grid: $SESSION_NAME" \
        -- bash -c "tmux attach -t '=$SESSION_NAME'; exec bash" &
      disown
      sleep 1
      echo "Launched terminal attached to $SESSION_NAME"
    fi
  fi
fi

echo "Grid initialized: $EXPECTED_PANES panes"
echo "Session: $SESSION_NAME"
echo "State: $STATE_DIR"
trap - EXIT
