#!/bin/bash
# grid-setup.sh — Create or verify a tmux NxM grid for tmup (default 2x4)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pre-parse --project-dir
PROJECT_DIR=""
_prev_arg=""
for _arg in "$@"; do
  if [[ "$_prev_arg" == "--project-dir" ]]; then
    PROJECT_DIR="$_arg"
    break
  fi
  _prev_arg="$_arg"
done
unset _arg _prev_arg

# Pre-parse --session
_prev_arg=""
for _arg in "$@"; do
  if [[ "$_prev_arg" == "--session" ]]; then
    export TMUP_SESSION_NAME="$_arg"
    break
  fi
  _prev_arg="$_arg"
done
unset _arg _prev_arg

source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/prerequisites.sh"
source "$SCRIPT_DIR/lib/grid-identity.sh"
source "$SCRIPT_DIR/lib/grid-registry.sh"

[[ -n "$PROJECT_DIR" ]] || { echo "ERROR: --project-dir required" >&2; exit 1; }
PROJECT_DIR=$(cd "$PROJECT_DIR" 2>/dev/null && pwd -P) || { echo "ERROR: --project-dir '$PROJECT_DIR' is not accessible" >&2; exit 1; }

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

umask 0077
mkdir -p "$STATE_DIR/grid" "$STATE_DIR/logs"
bash "$SCRIPT_DIR/sync-codex-agents.sh"

# Idempotency check
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  CURRENT_PANES=$(tmux list-panes -t "$SESSION_NAME" -F '#{pane_id}' | wc -l)
  if [[ "$CURRENT_PANES" -eq "$EXPECTED_PANES" ]]; then
    echo "Grid already exists: $SESSION_NAME with $CURRENT_PANES panes"
    exit 0
  fi
  echo "WARNING: Session $SESSION_NAME has $CURRENT_PANES panes (expected $EXPECTED_PANES)" >&2
  exit 1
fi

# Create NxM grid (dimensions from policy.yaml, default 2x4)
tmux new-session -d -s "$SESSION_NAME" -x "$CFG_WIDTH" -y "$CFG_HEIGHT"

# Track first pane of each row for horizontal splitting
declare -a ROW_PANES
ROW_PANES[0]=$(tmux display-message -t "$SESSION_NAME" -p '#{pane_id}')

# Create rows by splitting vertically (N-1 splits for N rows)
_bottom_pane="${ROW_PANES[0]}"
for ((_r = 1; _r < GRID_ROWS; _r++)); do
  _remaining=$((GRID_ROWS - _r))
  _total=$((_remaining + 1))
  _pct=$(( (_remaining * 100) / _total ))
  tmux split-window -t "$_bottom_pane" -v -l "${_pct}%"
  _bottom_pane=$(tmux display-message -t "$SESSION_NAME" -p '#{pane_id}')
  ROW_PANES[$_r]="$_bottom_pane"
done

# For each row, create columns by splitting horizontally (M-1 splits per row)
for ((_r = 0; _r < GRID_ROWS; _r++)); do
  _right_pane="${ROW_PANES[$_r]}"
  for ((_c = 1; _c < GRID_COLS; _c++)); do
    _remaining=$((GRID_COLS - _c))
    _total=$((_remaining + 1))
    _pct=$(( (_remaining * 100) / _total ))
    tmux split-window -t "$_right_pane" -h -l "${_pct}%"
    _right_pane=$(tmux display-message -t "$SESSION_NAME" -p '#{pane_id}')
  done
done

# Set a clean minimal prompt in each pane (hides user shell customizations like starship/p10k)
for _pane_id in $(tmux list-panes -t "$SESSION_NAME" -F '#{pane_id}'); do
  tmux send-keys -t "$_pane_id" "unset PROMPT_COMMAND; unset -f starship_precmd 2>/dev/null; PS1='tmup \$ '; clear" Enter
done
sleep 0.5

# Write grid-state.json
PANE_INFO=$(tmux list-panes -t "$SESSION_NAME" -F '#{pane_index} #{pane_id}')
TIMESTAMP=$(date -Iseconds)

# Build panes array safely with jq
PANES_JSON=$(echo "$PANE_INFO" | while IFS=' ' read -r pane_index pane_id; do
  jq -n --argjson idx "$pane_index" --arg pid "$pane_id" \
    '{index:$idx,pane_id:$pid,status:"available"}'
done | jq -s '.')

# Validate pane count matches expected grid layout
ACTUAL_COUNT=$(echo "$PANES_JSON" | jq 'length')
if [[ "$ACTUAL_COUNT" -ne "$EXPECTED_PANES" ]]; then
  echo "ERROR: Grid has $ACTUAL_COUNT panes but expected $EXPECTED_PANES — partial creation failure" >&2
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  exit 1
fi

# Write grid-state.json with proper JSON escaping
jq -n \
  --arg sn "$SESSION_NAME" \
  --arg pd "$PROJECT_DIR" \
  --arg ts "$TIMESTAMP" \
  --argjson rows "$GRID_ROWS" \
  --argjson cols "$GRID_COLS" \
  --argjson panes "$PANES_JSON" \
  '{schema_version:2,session_name:$sn,project_dir:$pd,created_at:$ts,grid:{rows:$rows,cols:$cols},panes:$panes}' \
  > "$STATE_DIR/grid/grid-state.json"

register_grid "$SESSION_NAME"
registry_register "$SESSION_NAME" "$PROJECT_DIR"
# Write current-session with restrictive permissions (matches shared/src/session-ops.ts mode 0o600)
install -m 600 /dev/stdin "$CFG_STATE_ROOT/current-session" <<< "$SESSION_NAME"

# Apply grid styling if available
STYLE_SCRIPT="$HOME/.local/bin/tmux-grid-style.sh"
if [[ -x "$STYLE_SCRIPT" ]]; then
  if ! bash "$STYLE_SCRIPT" "$SESSION_NAME" 2>&1; then
    echo "WARNING: Grid styling script failed (non-fatal)" >&2
  fi
fi

# Auto-launch terminal
ATTACHED=$(tmux display-message -t "$SESSION_NAME" -p '#{session_attached}' 2>/dev/null || echo "0")
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
        -- bash -c "tmux attach -t '$SESSION_NAME'; exec bash" &
      disown
      sleep 1
      echo "Launched terminal attached to $SESSION_NAME"
    fi
  fi
fi

echo "Grid initialized: $EXPECTED_PANES panes"
echo "Session: $SESSION_NAME"
echo "State: $STATE_DIR"
