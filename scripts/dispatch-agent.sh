#!/bin/bash
# dispatch-agent.sh — Launch a Codex worker in a tmux pane with tmup env vars
# Uses wrapper script pattern (NOT $(cat) in tmux command) for security
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

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
source "$SCRIPT_DIR/lib/validators.sh"
source "$SCRIPT_DIR/lib/tmux-helpers.sh"

STATE_DIR="$CFG_STATE_DIR"
CODEX_BIN="${CODEX_BIN:-$HOME/.local/bin/codex}"

die() { echo "ERROR: $*" >&2; exit 1; }

# Parse arguments
ROLE="" PROMPT="" PANE_INDEX="" WORKING_DIR="" AGENT_ID="" TASK_ID="" DB_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --pane-index) PANE_INDEX="$2"; shift 2 ;;
    --working-dir) WORKING_DIR="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --task-id) TASK_ID="$2"; shift 2 ;;
    --db-path) DB_PATH="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$ROLE" ]] || die "--role required"
[[ -n "$PROMPT" ]] || die "--prompt required"
[[ -n "$AGENT_ID" ]] || die "--agent-id required"
[[ -n "$DB_PATH" ]] || die "--db-path required"

SESSION_NAME="$CFG_SESSION_NAME"
[[ -n "$SESSION_NAME" ]] || die "No active session"
[[ -n "$WORKING_DIR" ]] || die "--working-dir required (will not fall back to pwd)"
validate_working_dir "$WORKING_DIR" || die "Invalid working directory: $WORKING_DIR"
WORKING_DIR="$(cd "$WORKING_DIR" && pwd -P)" || die "Failed to resolve working directory: $WORKING_DIR"

validate_role "$ROLE"

# Read agent instructions
AGENT_FILE="$PLUGIN_DIR/agents/$ROLE.md"
AGENT_INSTRUCTIONS=$(awk '/^---$/ { if (++fm == 2) { skip=0; next } else { skip=1; next } } skip { next } { print }' "$AGENT_FILE")
[[ -n "$AGENT_INSTRUCTIONS" ]] || die "Agent instructions for role '$ROLE' are empty — check $AGENT_FILE for valid YAML frontmatter"

# Auto-select pane if not specified
if [[ -z "$PANE_INDEX" ]]; then
  GRID_STATE="$STATE_DIR/grid/grid-state.json"
  [[ -f "$GRID_STATE" ]] || die "Grid state not found"
  PANE_INDEX=$(jq -r '[.panes[] | select(.status == "available")] | first | .index // empty' "$GRID_STATE")
  [[ -n "$PANE_INDEX" ]] || die "No available panes"
fi

validate_pane_index "$PANE_INDEX"

# Build full prompt
CLI_PATH="$PLUGIN_DIR/cli/dist/tmup-cli.js"
FULL_PROMPT="You are a $ROLE agent in a tmup-coordinated team.

## Objective
$PROMPT

## Working Directory
$WORKING_DIR

## tmup-cli Commands
Use \`node $CLI_PATH <command>\` for coordination:
- \`claim [--role $ROLE]\` — Claim next available task
- \`complete \"summary\" [--artifact name:path]\` — Mark task done
- \`fail --reason <crash|timeout|logic_error> \"message\"\` — Report failure
- \`checkpoint \"progress update\"\` — Post checkpoint to lead
- \`message --to lead \"message\"\` — Message the lead
- \`inbox [--mark-read]\` — Check messages
- \`heartbeat\` — Register liveness
- \`status\` — Check your current assignment
- \`events [--limit N] [--type TYPE]\` — Query audit event log

## Error Recovery
| Error | Action |
|-------|--------|
| NO_PENDING_TASKS | Check inbox, then idle |
| ALREADY_CLAIMED | Claim again (different task) |
| DATABASE_LOCKED | Retry after 2 seconds |

## Constraints
$AGENT_INSTRUCTIONS"

# Write prompt to session-scoped temp file
PROMPT_FILE="$STATE_DIR/prompt-${PANE_INDEX}-${AGENT_ID}.txt"
echo "$FULL_PROMPT" > "$PROMPT_FILE"
chmod 600 "$PROMPT_FILE"

# Write launcher wrapper script with env vars baked in (security: no shell interpolation in send-keys)
LAUNCHER="$STATE_DIR/launcher-${PANE_INDEX}.sh"
cat > "$LAUNCHER" <<WRAPPER
#!/bin/bash
export TMUP_AGENT_ID=$(printf '%q' "$AGENT_ID")
export TMUP_DB=$(printf '%q' "$DB_PATH")
export TMUP_PANE_INDEX=$(printf '%q' "$PANE_INDEX")
export TMUP_SESSION_NAME=$(printf '%q' "$SESSION_NAME")
export TMUP_SESSION_DIR=$(printf '%q' "$STATE_DIR")
export CODEX_BIN=$(printf '%q' "$CODEX_BIN")
export TMUP_WORKING_DIR=$(printf '%q' "$WORKING_DIR")
$(if [[ -n "$TASK_ID" ]]; then printf 'export TMUP_TASK_ID=%q' "$TASK_ID"; fi)
# Read prompt into memory, then clean up temp files before exec
_PROMPT=\$(cat $(printf '%q' "$PROMPT_FILE"))
rm -f $(printf '%q' "$PROMPT_FILE") "\$0" 2>/dev/null || true
exec "\$CODEX_BIN" -a never -s danger-full-access --no-alt-screen -C "\$TMUP_WORKING_DIR" "\$_PROMPT"
WRAPPER
chmod 700 "$LAUNCHER"

# Reserve pane BEFORE launch — fail closed on lock failure
PANE_TARGET="$SESSION_NAME:0.$PANE_INDEX"
GRID_STATE="$STATE_DIR/grid/grid-state.json"

# Cleanup function for rollback on failure
_dispatch_cleanup() {
  rm -f "$PROMPT_FILE" "$LAUNCHER" 2>/dev/null || true
}

if [[ -f "$GRID_STATE" ]]; then
  LOCK_FILE="$STATE_DIR/grid/grid-state.lock"
  exec 9>"$LOCK_FILE"
  if ! flock -w 5 9; then
    _dispatch_cleanup
    die "Failed to acquire grid state lock — another operation in progress"
  fi

  # Verify pane is at shell prompt WHILE HOLDING LOCK (prevent TOCTOU race)
  PANE_CMD=$(tmux display-message -t "$PANE_TARGET" -p '#{pane_current_command}' 2>/dev/null || echo "")
  if is_agent_process "$PANE_CMD"; then
    exec 9>&-
    _dispatch_cleanup
    die "Pane $PANE_INDEX has a running agent ($PANE_CMD)"
  fi

  _temp=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX") || {
    exec 9>&-
    _dispatch_cleanup
    die "Failed to create temp file for grid state"
  }
  if jq --argjson idx "$PANE_INDEX" --arg role "$ROLE" --arg aid "$AGENT_ID" \
    '(.panes[] | select(.index == $idx)) |= . + {status: "reserved", role: $role, agent_id: $aid}' \
    "$GRID_STATE" > "$_temp" && [[ -s "$_temp" ]]; then
    mv "$_temp" "$GRID_STATE"
  else
    rm -f "$_temp"
    exec 9>&-
    _dispatch_cleanup
    die "Failed to reserve pane $PANE_INDEX in grid state"
  fi
  exec 9>&-
else
  # No grid state — still check pane occupancy
  PANE_CMD=$(tmux display-message -t "$PANE_TARGET" -p '#{pane_current_command}' 2>/dev/null || echo "")
  if is_agent_process "$PANE_CMD"; then
    _dispatch_cleanup
    die "Pane $PANE_INDEX has a running agent ($PANE_CMD)"
  fi
fi

# Launch — all env vars are in the launcher script, no interpolation in send-keys
tmux send-keys -t "$PANE_TARGET" C-c 2>/dev/null || true
sleep 0.1
tmux send-keys -t "$PANE_TARGET" C-u 2>/dev/null || true
sleep 0.1

if ! tmux send-keys -t "$PANE_TARGET" "bash '$LAUNCHER'" Enter 2>/dev/null; then
  # Rollback pane reservation on launch failure
  if [[ -f "$GRID_STATE" ]]; then
    exec 9>"$LOCK_FILE"
    if flock -w 2 9 2>/dev/null; then
      _temp=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX" 2>/dev/null) || _temp=""
      if [[ -n "$_temp" ]]; then
        jq --argjson idx "$PANE_INDEX" \
          '(.panes[] | select(.index == $idx)) |= {index: .index, pane_id: .pane_id, status: "available"}' \
          "$GRID_STATE" > "$_temp" 2>/dev/null && mv "$_temp" "$GRID_STATE"
      fi
      exec 9>&- 2>/dev/null || true
    fi
  fi
  _dispatch_cleanup
  die "Failed to send launch command to pane $PANE_INDEX — tmux session may be dead"
fi

# Trust prompt auto-accept — narrow check to exact pane only
ATTEMPTS=$((CFG_TRUST_SECONDS / 2))
[[ $ATTEMPTS -lt 1 ]] && ATTEMPTS=1
for _attempt in $(seq 1 $ATTEMPTS); do
  sleep 2
  TRUST_CHECK=$(tmux capture-pane -t "$PANE_TARGET" -p -S -10 2>/dev/null || true)
  # Narrow pattern: only accept the specific codex trust prompt ("Do you trust ...?")
  # Anchored to start-of-line to avoid matching agent output paragraphs
  if echo "$TRUST_CHECK" | grep -qiE "^\s*Do you trust\b"; then
    tmux send-keys -t "$PANE_TARGET" Enter
    echo "Trust prompt accepted (attempt $_attempt)"
    break
  fi
  echo "$TRUST_CHECK" | grep -qF "Working (" && break
done

echo "Dispatched $ROLE to pane $PANE_INDEX (agent $AGENT_ID)"
