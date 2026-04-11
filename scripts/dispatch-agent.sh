#!/bin/bash
# dispatch-agent.sh — Launch a Codex worker in a tmux pane with tmup env vars
# Uses wrapper script pattern (NOT $(cat) in tmux command) for security
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

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
GRID_STATE="$STATE_DIR/grid/grid-state.json"
LOCK_FILE="$STATE_DIR/grid/grid-state.lock"
CODEX_BIN="${CODEX_BIN:-}"
if [[ -z "$CODEX_BIN" ]]; then
  CODEX_BIN="$(command -v codex 2>/dev/null || true)"
  [[ -n "$CODEX_BIN" ]] || CODEX_BIN="$HOME/.local/bin/codex"
fi

PROMPT_FILE=""
LAUNCHER=""
RESERVATION_ACTIVE=0
DISPATCH_COMMITTED=0


_dispatch_cleanup() {
  rm -f "${PROMPT_FILE:-}" "${LAUNCHER:-}" 2>/dev/null || true
}

_respawn_available_pane() {
  local pane_target="$1"
  local pane_index="$2"
  local pane_cmd="$3"

  echo "Pane $pane_index marked available but still running $pane_cmd; respawning it"
  respawn_pane "$pane_target" || return 1
  wait_for_shell_ready "$SESSION_NAME" "$pane_index" 5
}

_release_pane_reservation() {
  [[ "${RESERVATION_ACTIVE:-0}" -eq 1 ]] || return 0
  [[ -f "${GRID_STATE:-}" ]] || return 0
  [[ -n "${PANE_INDEX:-}" ]] || return 0

  exec 8>"$LOCK_FILE" 2>/dev/null || return 0
  if flock -w 2 8 2>/dev/null; then
    local temp_file
    temp_file=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX" 2>/dev/null || true)
    if [[ -n "$temp_file" ]]; then
      if jq --argjson idx "$PANE_INDEX" \
        '(.panes[] | select(.index == $idx)) |= {index: .index, pane_id: .pane_id, status: "available"}' \
        "$GRID_STATE" > "$temp_file" 2>/dev/null && [[ -s "$temp_file" ]]; then
        mv "$temp_file" "$GRID_STATE"
        RESERVATION_ACTIVE=0
      else
        rm -f "$temp_file"
      fi
    fi
  fi
  exec 8>&- 2>/dev/null || true
}

_dispatch_teardown() {
  local exit_code="${1:-1}"
  trap - EXIT INT TERM
  exec 9>&- 2>/dev/null || true
  if [[ "${DISPATCH_COMMITTED:-0}" -eq 0 ]]; then
    _release_pane_reservation
    _dispatch_cleanup
  fi
  exit "$exit_code"
}

trap '_dispatch_teardown "$?"' EXIT
trap '_dispatch_teardown 130' INT
trap '_dispatch_teardown 143' TERM

# Parse arguments
ROLE="" PROMPT="" PANE_INDEX="" WORKING_DIR="" AGENT_ID="" TASK_ID="" DB_PATH="" RESUME_SESSION_ID="" WORKER_TYPE="codex" CLONE_ISOLATION=0

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
    --resume-session-id) RESUME_SESSION_ID="$2"; shift 2 ;;
    --worker-type) WORKER_TYPE="$2"; shift 2 ;;
    --clone-isolation) CLONE_ISOLATION=1; shift ;;
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

# Clone isolation: create isolated git clone for colony workers (council M4)
if [[ "$CLONE_ISOLATION" -eq 1 ]]; then
  _CLONE_MANAGER="${SDLC_OS_PLUGIN:-/home/q/.claude/plugins/sdlc-os}/colony/clone-manager.sh"
  if [[ -f "$_CLONE_MANAGER" ]]; then
    source "$_CLONE_MANAGER"
    WORKING_DIR="$(colony_clone_create "$WORKING_DIR" "$SESSION_NAME" "$AGENT_ID")" || die "Failed to create isolated clone"
    colony_clone_verify "$WORKING_DIR" || die "Clone verification failed"
  else
    die "Clone isolation requested but clone-manager.sh not found at $_CLONE_MANAGER"
  fi
  unset _CLONE_MANAGER
fi

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
PLAN_FIRST_LINE=""
if [[ "${CFG_CODEX_PLAN_FIRST:-true}" == "true" ]]; then
  PLAN_FIRST_LINE="- Start plan-first. Restate the objective, constraints, risks, and execution plan before making broad changes."
fi

FULL_PROMPT=$(cat <<EOF
You are a $ROLE agent in a tmup-coordinated team.

## Objective
$PROMPT

## Working Directory
$WORKING_DIR

## Runtime Contract
- You are running in a persistent interactive Codex worker pane managed by tmup.
- This is not \`codex exec\`, not a one-shot subprocess, and not a shell-only lane.
- Fresh tmup workers launch on \`$CFG_CODEX_MODEL\`.
- Your runtime contract assumes a native context window of up to $CFG_CODEX_CONTEXT_WINDOW tokens for this model.
- Runtime defaults for this lane: reasoning_effort=$CFG_CODEX_REASONING_EFFORT, reasoning_summary=$CFG_CODEX_REASONING_SUMMARY, verbosity=$CFG_CODEX_VERBOSITY, web_search=$CFG_CODEX_WEB_SEARCH.
- Interactive safeguards and productivity features are enabled through tmup policy: history=$CFG_CODEX_HISTORY, undo=$CFG_CODEX_UNDO, shell_snapshot=$CFG_CODEX_SHELL_SNAPSHOT, request_compression=$CFG_CODEX_REQUEST_COMPRESSION.
$PLAN_FIRST_LINE
- Use relevant Codex skills when they clearly apply to the task.
- Use built-in Codex subagents when the task has parallelizable workstreams.
- Current subagent caps for fresh tmup workers: max_threads=$CFG_CODEX_MAX_THREADS, max_depth=$CFG_CODEX_MAX_DEPTH, job_max_runtime_seconds=$CFG_CODEX_JOB_TIMEOUT.

## Lane Discipline
- The lead or appointed grid supervisor manages this pane as a long-lived external subagent lane.
- Preserve lane context between turns. Follow-up prompts are continuations of the same session, not fresh starts.
- Do not ask the lead to spawn a replacement worker if this pane already has the relevant context; expect harvest-and-reprompt instead.
- Keep your scope clean. Do not contaminate this lane with unrelated workstreams.

## tmux Input Model
- Follow-up instructions arrive through \`tmux send-keys\` via \`tmup_reprompt\`.
- The supervisor may harvest pane output and reprompt you while the session remains alive.
- When the interface is queueable, the supervisor may queue input while you are still working.
- Never tell the lead to type shell commands directly into the pane to continue your work.
- Treat reprompts as authoritative updates to objective, priority, or constraints.

## Process Context
- You are operating inside a supervised SDLC workflow: discover, plan, implement, verify, review, and document.
- Your output will be adversarially reviewed. Every claim should be backed by repo evidence, test output, or cited documentation.
- Shared coordination surfaces:
  - \`TMUP_WORKING_DIR\` is your working root
  - \`TMUP_SESSION_DIR\` is the session-scoped state directory shared with the lead
  - \`TMUP_DB\` is the tmup database path; use \`tmup-cli\`, not raw SQL, to interact with it
  - \`tmup-cli inbox\`, \`checkpoint\`, \`message\`, \`complete\`, and \`fail\` are the coordination interface
- Check your inbox after claiming work, after meaningful milestones, and before declaring completion.

## Quality Posture
- Act as a skeptic and adversarial reviewer of your own work.
- Verify assumptions before building on them.
- Evaluate every changed line for correctness, security, conventions, and regression risk.
- Prefer explicit evidence over intuition. If evidence conflicts, stop and resolve the contradiction.
- Run relevant verification as you go; do not leave all checking for the end.
- Escalate blockers, ambiguity, or upstream defects early instead of silently guessing.

## Internal Teams
- The tmup tiered agent pack is synced into \`~/.codex/agents\` during grid setup.
- For tasks with separable workstreams, spawn \`tmup-tier1\` subagents (model \`gpt-5.3-codex\`).
- \`tmup-tier1\` agents may spawn \`tmup-tier2\` subagents (model \`gpt-5.2-codex\`) for narrow leaf tasks.
- Do not spawn raw unnamed agents. Use the named tmup tiered agents so model pinning is enforced.
- max_threads: $CFG_CODEX_MAX_THREADS concurrent, max_depth: $CFG_CODEX_MAX_DEPTH nesting levels.
- Collect and synthesize subagent results before reporting back to the lead.

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
$AGENT_INSTRUCTIONS
EOF
)

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
export TMUP_CODEX_MODEL=$(printf '%q' "$CFG_CODEX_MODEL")
export TMUP_CODEX_CONTEXT_WINDOW=$(printf '%q' "$CFG_CODEX_CONTEXT_WINDOW")
export TMUP_CODEX_AUTO_COMPACT=$(printf '%q' "$CFG_CODEX_AUTO_COMPACT")
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
export TMUP_CODEX_UNDO=$(printf '%q' "$CFG_CODEX_UNDO")
export TMUP_CODEX_SHELL_INHERIT=$(printf '%q' "$CFG_CODEX_SHELL_INHERIT")
export TMUP_CODEX_SHELL_SNAPSHOT=$(printf '%q' "$CFG_CODEX_SHELL_SNAPSHOT")
export TMUP_CODEX_REQUEST_COMPRESSION=$(printf '%q' "$CFG_CODEX_REQUEST_COMPRESSION")
export TMUP_CODEX_NOTIFICATIONS=$(printf '%q' "$CFG_CODEX_NOTIFICATIONS")
export TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT=$(printf '%q' "$CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT")
export TMUP_CODEX_MAX_THREADS=$(printf '%q' "$CFG_CODEX_MAX_THREADS")
export TMUP_CODEX_MAX_DEPTH=$(printf '%q' "$CFG_CODEX_MAX_DEPTH")
export TMUP_CODEX_JOB_TIMEOUT=$(printf '%q' "$CFG_CODEX_JOB_TIMEOUT")
$(if [[ -n "$TASK_ID" ]]; then printf 'export TMUP_TASK_ID=%q' "$TASK_ID"; fi)
$(if [[ -n "$RESUME_SESSION_ID" ]]; then printf 'export RESUME_SESSION_ID=%q' "$RESUME_SESSION_ID"; fi)
_CLI_PATH=$(printf '%q' "$PLUGIN_DIR/cli/dist/tmup-cli.js")
_HB_INTERVAL=${CFG_HEARTBEAT_INTERVAL:-60}
_WORKER_TYPE=$(printf '%q' "$WORKER_TYPE")
_PROMPT_FILE=$(printf '%q' "$PROMPT_FILE")

rm -f "\$0" 2>/dev/null || true

if [[ "\$_WORKER_TYPE" == "claude_code" ]]; then
  # Claude Code worker — uses MCP heartbeat, no background heartbeat loop needed
  cd "\$TMUP_WORKING_DIR" && claude -p \\
    --model sonnet \\
    --permission-mode bypassPermissions \\
    --plugin-dir $(printf '%q' "$PLUGIN_DIR") \\
    --max-budget-usd 3.00 \\
    < "\$_PROMPT_FILE" \\
    > "\$TMUP_WORKING_DIR/session-output.json" 2>&1
else
  # Codex worker — runtime contract pinned from policy.yaml-sourced env vars
  _INLINE_ARGS=()
  if [[ "\${TMUP_CODEX_NO_ALT_SCREEN}" == "true" ]]; then
    _INLINE_ARGS+=(--no-alt-screen)
  fi

  _COMMON_ARGS=(
    -m "\$TMUP_CODEX_MODEL"
    -c "model_context_window=\$TMUP_CODEX_CONTEXT_WINDOW"
    -c "model_auto_compact_token_limit=\$TMUP_CODEX_AUTO_COMPACT"
    -a "\$TMUP_CODEX_APPROVAL_POLICY"
    -s "\$TMUP_CODEX_SANDBOX"
    -c "model_reasoning_effort=\$TMUP_CODEX_REASONING_EFFORT"
    -c "model_reasoning_summary=\$TMUP_CODEX_REASONING_SUMMARY"
    -c "plan_mode_reasoning_effort=\$TMUP_CODEX_PLAN_REASONING"
    -c "model_verbosity=\$TMUP_CODEX_VERBOSITY"
    -c "service_tier=\$TMUP_CODEX_SERVICE_TIER"
    -c "tool_output_token_limit=\$TMUP_CODEX_TOOL_OUTPUT_LIMIT"
    -c "web_search=\$TMUP_CODEX_WEB_SEARCH"
    -c "history.persistence=\$TMUP_CODEX_HISTORY"
    -c "features.undo=\$TMUP_CODEX_UNDO"
    -c "shell_environment_policy.inherit=\$TMUP_CODEX_SHELL_INHERIT"
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
    while true; do
      sleep "\$_HB_INTERVAL"
      TMUP_AGENT_ID="\$TMUP_AGENT_ID" TMUP_DB="\$TMUP_DB" TMUP_PANE_INDEX="\$TMUP_PANE_INDEX" \\
        TMUP_SESSION_NAME="\$TMUP_SESSION_NAME" TMUP_SESSION_DIR="\$TMUP_SESSION_DIR" \\
        node "\$_CLI_PATH" heartbeat 2>/dev/null || true
    done
  ) &
  _HB_PID=\$!

  # Run codex as foreground child — interactive session, no prompt arg.
  # Outer dispatch-agent.sh waits for codex to be ready, then sends the
  # initial prompt via send_codex_prompt_with_retry (interactive session model).
  if [[ -n "\${RESUME_SESSION_ID:-}" ]]; then
    # Reapply the current runtime contract on resume so recovered panes stay pinned
    # to the configured model, context, compaction, approval, sandbox, and subagent caps.
    "\$CODEX_BIN" "\${_COMMON_ARGS[@]}" resume "\$RESUME_SESSION_ID"
  else
    "\$CODEX_BIN" "\${_COMMON_ARGS[@]}"
  fi
  _EXIT=\$?

  # Kill heartbeat loop when codex exits
  kill "\$_HB_PID" 2>/dev/null
  wait "\$_HB_PID" 2>/dev/null
  exit "\$_EXIT"
fi
WRAPPER
chmod 700 "$LAUNCHER"

# Reserve pane BEFORE launch — fail closed on lock failure
PANE_TARGET="$SESSION_NAME:0.$PANE_INDEX"
GRID_STATE="$STATE_DIR/grid/grid-state.json"

if [[ -f "$GRID_STATE" ]]; then
  exec 9>"$LOCK_FILE"
  if ! flock -w 5 9; then
    _dispatch_cleanup
    die "Failed to acquire grid state lock — another operation in progress"
  fi

  # Pull pane status from the grid state under the held flock. A single jq
  # pass returns empty EITHER when the pane index is missing from .panes[]
  # OR when a matched pane carries no .status field. Both are fatal here,
  # so one non-empty check covers both. tmup authors grid-state.json itself
  # and always sets .status on every pane (see grid-setup.sh), so the
  # "found but no status" branch is not a reachable runtime state.
  _pane_status=$(jq -r --argjson idx "$PANE_INDEX" '.panes[] | select(.index == $idx) | .status // ""' "$GRID_STATE")
  [[ -n "$_pane_status" ]] || {
    exec 9>&-
    _dispatch_cleanup
    die "Pane $PANE_INDEX not found in grid state"
  }

  # Verify pane is at shell prompt WHILE HOLDING LOCK (prevent TOCTOU race)
  PANE_CMD=$(tmux display-message -t "$PANE_TARGET" -p '#{pane_current_command}' 2>/dev/null || echo "")
  if is_agent_process "$PANE_CMD"; then
    if [[ "$_pane_status" == "available" ]]; then
      if ! _respawn_available_pane "$PANE_TARGET" "$PANE_INDEX" "$PANE_CMD"; then
        exec 9>&-
        _dispatch_cleanup
        die "Pane $PANE_INDEX is marked available but could not be reset from $PANE_CMD"
      fi
    else
      exec 9>&-
      _dispatch_cleanup
      die "Pane $PANE_INDEX has a running agent ($PANE_CMD)"
    fi
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
    RESERVATION_ACTIVE=1
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
DISPATCH_COMMITTED=1

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

# Wait for codex to be ready for input (idle at its prompt)
echo "Waiting for codex to become ready..."
for _ready_attempt in $(seq 1 20); do
  sleep 1
  _ready_check=$(tmux capture-pane -t "$PANE_TARGET" -p -S -5 2>/dev/null || true)
  if echo "$_ready_check" | grep -qE '❯|›'; then
    echo "Codex ready in pane $PANE_INDEX (attempt $_ready_attempt)"
    break
  fi
done

# Send the initial prompt via tmux send-keys
if [[ -f "$PROMPT_FILE" ]]; then
  _prompt_text=$(cat "$PROMPT_FILE")
  if send_codex_prompt_with_retry "$SESSION_NAME" "$PANE_INDEX" "$_prompt_text" "dispatch"; then
    rm -f "$PROMPT_FILE" 2>/dev/null || true
    echo "Initial prompt confirmed in pane $PANE_INDEX"
  else
    rm -f "$PROMPT_FILE" 2>/dev/null || true
    die "failed to confirm Codex accepted the initial prompt for pane $PANE_INDEX"
  fi
fi

# Capture Codex session ID for resume capability
# Race mitigation: after reading the last history entry, verify its cwd matches
# our WORKING_DIR. In multi-dispatch scenarios, another agent's entry could be
# the last one — the cwd check prevents cross-contamination.
CODEX_SID=""
HISTORY_FILE="$HOME/.codex/history.jsonl"
if [[ -f "$HISTORY_FILE" ]]; then
  sleep 2  # Wait for codex to register the session
  _last_entry=$(tail -1 "$HISTORY_FILE" 2>/dev/null) || _last_entry=""
  if [[ -n "$_last_entry" ]]; then
    _entry_cwd=$(echo "$_last_entry" | jq -r '.cwd // ""' 2>/dev/null) || _entry_cwd=""
    CODEX_SID=$(echo "$_last_entry" | jq -r '.session_id // ""' 2>/dev/null) || CODEX_SID=""
    # Correlation check: reject if entry's working directory doesn't match ours
    if [[ -n "$_entry_cwd" && "$_entry_cwd" != "$WORKING_DIR" ]]; then
      echo "Session ID skipped: history entry cwd '$_entry_cwd' != working dir '$WORKING_DIR'" >&2
      CODEX_SID=""
    fi
  fi
  unset _last_entry _entry_cwd
  if [[ -n "$CODEX_SID" && "$CODEX_SID" != "null" ]]; then
    # Store in grid-state.json pane entry
    if [[ -f "$GRID_STATE" ]]; then
      exec 9>"$LOCK_FILE"
      if flock -w 5 9 2>/dev/null; then
        _temp=$(mktemp "$STATE_DIR/grid/grid-state.XXXXXX" 2>/dev/null) || _temp=""
        if [[ -n "$_temp" ]]; then
          if jq --argjson idx "$PANE_INDEX" --arg csid "$CODEX_SID" \
            '(.panes[] | select(.index == $idx)).codex_session_id = $csid' \
            "$GRID_STATE" > "$_temp" 2>/dev/null && [[ -s "$_temp" ]]; then
            mv "$_temp" "$GRID_STATE"
          else
            rm -f "$_temp"
          fi
        fi
      fi
      exec 9>&- 2>/dev/null || true
    fi

    # Store in agents table via heartbeat
    CLI_PATH="$PLUGIN_DIR/cli/dist/tmup-cli.js"
    TMUP_AGENT_ID="$AGENT_ID" TMUP_DB="$DB_PATH" TMUP_PANE_INDEX="$PANE_INDEX" \
      TMUP_SESSION_NAME="$SESSION_NAME" TMUP_SESSION_DIR="$STATE_DIR" \
      node "$CLI_PATH" heartbeat --codex-session-id "$CODEX_SID" 2>/dev/null || true

    echo "Codex session ID: $CODEX_SID"
    echo "Resume: codex resume $CODEX_SID"
  fi
fi
