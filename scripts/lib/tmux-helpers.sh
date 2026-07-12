#!/usr/bin/env bash
# tmux-helpers.sh — Tmux utility functions for tmup

# Check if a process in a pane is an agent (not a shell).
# Uses a shell-allowlist approach: known idle shells are "free", everything
# else (codex, claude, node, git, python, any child process) is treated as
# occupied. This aligns with the MCP liveness checker which also treats
# unknown pane commands as alive.
is_agent_process() {
  local cmd="${1:-}"
  case "$cmd" in
    bash|zsh|sh|fish|"") return 1 ;;  # shell prompt = not an agent
    *) return 0 ;;                     # anything else = agent or agent child
  esac
}

# Wait for a pane to be at a shell prompt
wait_for_shell_ready() {
  local session="$1" pane="$2" max_wait="${3:-5}"
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    local cmd
    cmd=$(tmux display-message -t "$session:0.$pane" -p '#{pane_current_command}' 2>/dev/null) || cmd=""
    case "$cmd" in
      bash|zsh|sh|fish) return 0 ;;
    esac
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Strip ANSI escape codes from text (uses perl for BSD/GNU portability — sed \xHH escapes are GNU-only)
strip_ansi() {
  perl -pe 's/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]//g; s/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)//g'
}

# Respawn a tmux pane via `respawn-pane -k`, discarding the running command
# and resetting the pane to a fresh shell. Callers handle their own logging
# and retry/escalation — this helper only owns the subprocess call so the
# `-k` flag and stderr redirection live in one place.
#
# Args: pane_target (e.g. session:0.1)
# Returns: 0 on success, non-zero on failure
respawn_pane() {
  local pane_target="${1:-}"
  tmux respawn-pane -k -t "$pane_target" 2>/dev/null
}

# Return the deepest foreground process reachable beneath tmux's pane root.
# The pane root shell is exempt; any non-zombie descendant whose process group
# owns its terminal foreground group means the pane is occupied.
#
# Returns: 0 with the occupied command, 1 when the root shell is idle, and 2
# when tmux/process inspection is unavailable or ambiguous.
pane_foreground_descendant_command() {
  local session="${1:-}" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  local pane_pid process_snapshot

  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null) || return 2
  [[ "$pane_pid" =~ ^[0-9]+$ && "$pane_pid" -gt 1 ]] || return 2

  process_snapshot=$(ps -axo pid=,ppid=,pgid=,tpgid=,stat=,ucomm= 2>/dev/null) || return 2
  [[ -n "$process_snapshot" ]] || return 2

  awk -v root="$pane_pid" '
    {
      if ($1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ &&
          $3 ~ /^[0-9]+$/ && $4 ~ /^-?[0-9]+$/ && NF >= 6) {
        if (seen[$1]) {
          invalid_row = 1
          next
        }
        row_count++
        pid[row_count] = $1
        parent[row_count] = $2
        process_group[row_count] = $3
        foreground_group[row_count] = $4
        state[row_count] = $5
        process_name[row_count] = $6
        for (field = 7; field <= NF; field++) {
          process_name[row_count] = process_name[row_count] " " $field
        }
        seen[$1] = 1
      } else if ($0 !~ /^[[:space:]]*$/) {
        invalid_row = 1
      }
    }
    END {
      if (invalid_row || row_count == 0 || !seen[root]) {
        exit 2
      }

      for (i = 1; i <= row_count; i++) {
        if (pid[i] == root && state[i] ~ /^Z/) {
          exit 2
        }
      }

      reachable[root] = 1
      depth[root] = 0
      for (pass = 1; pass <= row_count; pass++) {
        changed = 0
        for (i = 1; i <= row_count; i++) {
          if (reachable[parent[i]] && !reachable[pid[i]]) {
            reachable[pid[i]] = 1
            depth[pid[i]] = depth[parent[i]] + 1
            changed = 1
          }
        }
        if (!changed) {
          break
        }
      }

      found = 0
      best_depth = -1
      for (i = 1; i <= row_count; i++) {
        executable = process_name[i]
        sub(/^.*\//, "", executable)
        if (pid[i] != root && reachable[pid[i]] &&
            process_group[i] == foreground_group[i] && foreground_group[i] > 0 &&
            state[i] !~ /^Z/ && depth[pid[i]] > best_depth) {
          found = 1
          best_depth = depth[pid[i]]
          best_command = executable
        }
      }

      if (found) {
        print best_command
        exit 0
      }
      exit 1
    }
  ' <<<"$process_snapshot"
}

# Classify pane occupancy without destroying its contents.
# Returns: 0 with the occupied command, 1 for a proven-idle root shell, and 2
# when occupancy cannot be verified.
pane_occupancy_command() {
  local session="${1:-}" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  local cmd foreground_command inspection_status

  cmd=$(tmux display-message -t "$target" -p '#{pane_current_command}' 2>/dev/null) || return 2
  [[ -n "$cmd" ]] || return 2

  case "$cmd" in
    bash|zsh|sh|fish)
      if foreground_command=$(pane_foreground_descendant_command "$session" "$pane_index"); then
        printf '%s\n' "$foreground_command"
        return 0
      else
        inspection_status=$?
      fi
      if [[ "$inspection_status" -eq 1 ]]; then
        return 1
      fi
      return 2
      ;;
    *)
      printf '%s\n' "$cmd"
      return 0
      ;;
  esac
}

# Get the actual running command in a pane (walks process tree)
get_pane_command() {
  local session="${1:-}" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  tmux display-message -t "$target" -p '#{pane_current_command}' 2>/dev/null || echo ""
}

capture_pane_scrollback() {
  local target="${1:-}" start="${2:--20}"
  tmux capture-pane -t "$target" -p -S "$start" 2>/dev/null | strip_ansi
}

# Active-work detector: checks ONLY for Codex's `Working (...)` spinner, the
# one signal Codex emits when it is currently processing a request. This
# string cannot appear inside a user-typed prompt echo (it is drawn by the
# TUI, not from scrollback history), so it is safe to match against raw
# scrollback without any prompt-exclusion filtering. Use this for idleness
# checks (is_agent_idle / send_reprompt guard).
codex_scrollback_shows_active_work() {
  local scrollback="${1:-}"
  echo "$scrollback" | grep -qF "Working ("
}

# Submit-accepted detector: checks for `Working (` OR tool-call output. The
# tool-call regex is needed for the race where Codex executes a tool call
# faster than our 2-second poll and `Working (` has already cleared by
# capture time. Because tool names (update_plan, apply_patch, exec_command,
# ...) are also common English words inside dispatch prompts, this function
# takes an optional prompt_text arg and strips any scrollback line whose
# normalized content echoes the prompt before running the tool-name regex.
# Use this for submit-confirmation checks (wait_for_codex_submit_confirmation).
codex_scrollback_shows_work() {
  local scrollback="${1:-}"
  local prompt_text="${2:-}"

  if codex_scrollback_shows_active_work "$scrollback"; then
    return 0
  fi

  local work_area="$scrollback"
  if [[ -n "$prompt_text" ]]; then
    # Strip any line whose content is an echo of the typed prompt. The input
    # area may render as `❯ <text>`, `› <text>`, `│ > <text>`, or wrapped
    # continuation without any marker, so we normalize each line by removing
    # leading input markers + whitespace before the containment check.
    #
    # Ultra-short lines (< MIN_PROMPT_ECHO_LEN chars after stripping markers)
    # are preserved unconditionally because a 0-3 char token is too small to
    # meaningfully match against a prompt — a bare prompt indicator like `❯`
    # would become empty and match every non-empty prompt by substring, which
    # would strip legitimate tool-call output.
    #
    # Use ENVIRON[] instead of -v to safely pass multi-line prompt_text
    # (BSD awk on macOS rejects newlines in -v assignments).
    local MIN_PROMPT_ECHO_LEN=4
    work_area=$(TMUX_PROMPT_TEXT="$prompt_text" awk -v min_len="$MIN_PROMPT_ECHO_LEN" '
      BEGIN { p = ENVIRON["TMUX_PROMPT_TEXT"] }
      {
        line = $0
        # Strip leading input markers (❯, ›, │, >, box-drawing prefixes) + ws
        sub(/^[[:space:]]*[❯›│|>[:space:]]+/, "", line)
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        if (length(line) < min_len) { print; next }
        if (index(p, line) > 0) { next }
        print
      }
    ' <<<"$scrollback")
  fi

  if echo "$work_area" | grep -qiE \
    'functions\.[a-z_]+|multi_tool_use\.parallel|web\.(search_query|image_query|open|click|find|screenshot|sports|finance|weather|time)|apply_patch|exec_command|write_stdin|spawn_agent|send_input|wait_agent|read_mcp_resource|list_mcp_resources|list_mcp_resource_templates|update_plan'; then
    return 0
  fi

  return 1
}

# Idle-prompt detector: pane is idle if Codex is NOT actively working and
# the input prompt marker is visible. Uses the strict `Working (` check, not
# the tool-name regex — tool names appearing in scrollback from completed
# prior turns (or echoed user prompts) must NOT block idleness detection.
codex_scrollback_shows_idle_prompt() {
  local scrollback="${1:-}"
  if codex_scrollback_shows_active_work "$scrollback"; then
    return 1
  fi
  echo "$scrollback" | grep -qE '❯|›'
}

wait_for_codex_submit_confirmation() {
  local session="${1:-}" pane_index="${2:-0}" delay_seconds="${3:-2}" prompt_text="${4:-}"
  local target="${session}:0.${pane_index}"
  local scrollback

  sleep "$delay_seconds"
  scrollback=$(capture_pane_scrollback "$target" "-40") || scrollback=""
  codex_scrollback_shows_work "$scrollback" "$prompt_text"
}

# Check if a pane is at an idle shell prompt
is_shell_ready() {
  local session="$1" pane_index="${2:-0}"
  local cmd
  cmd=$(get_pane_command "$session" "$pane_index")
  case "$cmd" in
    bash|zsh|sh|fish|"") return 0 ;;
    *) return 1 ;;
  esac
}

# Check if an agent in a pane is idle (not actively "Working")
is_agent_idle() {
  local session="$1" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  local scrollback
  scrollback=$(capture_pane_scrollback "$target" "-20") || return 1
  codex_scrollback_shows_idle_prompt "$scrollback"
}

# Check if an agent pane is queueable (actively working but accepting queued input).
# Codex shows "Tab to queue" or similar indicator when a prompt can be queued.
is_agent_queueable() {
  local session="$1" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  local scrollback
  scrollback=$(capture_pane_scrollback "$target" "-20") || return 1
  # Must be actively working (not idle)
  codex_scrollback_shows_active_work "$scrollback" || return 1
  # And must show the queueable indicator
  echo "$scrollback" | grep -qiE 'tab to queue|⌥.*queue'
}

# Clear any stale input from a pane
clear_pane_input() {
  local session="$1" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  tmux send-keys -t "$target" C-u 2>/dev/null || true
  sleep 0.1
}

send_codex_prompt_with_retry() {
  local session="${1:-}" pane_index="${2:-0}" prompt_text="${3:-}" mode="${4:-dispatch}"
  local target="${session}:0.${pane_index}"
  local max_full_retries=1
  local failure_message="failed to confirm Codex accepted the prompt"

  if [[ -z "$session" || -z "$prompt_text" ]]; then
    echo "send_codex_prompt_with_retry: session and prompt_text required" >&2
    return 1
  fi

  case "$mode" in
    dispatch)
      max_full_retries=3
      failure_message="failed to confirm Codex accepted the initial prompt"
      ;;
    reprompt)
      max_full_retries=1
      failure_message="failed to confirm Codex accepted the reprompt"
      ;;
    *)
      echo "send_codex_prompt_with_retry: unknown mode '$mode'" >&2
      return 1
      ;;
  esac

  local full_retry
  for ((full_retry = 1; full_retry <= max_full_retries; full_retry++)); do
    if [[ "$full_retry" -gt 1 ]]; then
      tmux send-keys -t "$target" C-c 2>/dev/null || true
      sleep 0.2
    fi

    clear_pane_input "$session" "$pane_index"

    if ! tmux send-keys -l -t "$target" "$prompt_text" 2>/dev/null; then
      echo "send_codex_prompt_with_retry: failed to send text to $target" >&2
      return 1
    fi

    sleep 0.2

    local submit_attempt
    for submit_attempt in 1 2 3; do
      if [[ "$mode" == "dispatch" && "$submit_attempt" -eq 2 ]]; then
        tmux send-keys -t "$target" S-Tab 2>/dev/null || true
        sleep 0.2
      fi

      tmux send-keys -t "$target" Enter 2>/dev/null || true
      if wait_for_codex_submit_confirmation "$session" "$pane_index" 2 "$prompt_text"; then
        return 0
      fi
    done
  done

  echo "send_codex_prompt_with_retry: ${failure_message}" >&2
  return 1
}

# Send a follow-up prompt to a running agent
# Args: session pane_index prompt_text
# Returns: 0 on success, 1 on failure
send_reprompt() {
  local session="${1:-}" pane_index="${2:-0}" prompt_text="${3:-}"

  if [[ -z "$session" || -z "$prompt_text" ]]; then
    echo "send_reprompt: session and prompt_text required" >&2
    return 1
  fi

  # Verify session exists
  if ! tmux has-session -t "$session" 2>/dev/null; then
    echo "send_reprompt: session '$session' does not exist" >&2
    return 1
  fi

  local target="${session}:0.${pane_index}"

  # Guard: pane must be running a process, NOT at an idle shell prompt
  if is_shell_ready "$session" "$pane_index"; then
    echo "send_reprompt: pane $target is at shell prompt, not a running agent" >&2
    return 1
  fi

  # Guard: agent must be idle OR queueable (actively working but accepting queued input)
  local _reprompt_mode="reprompt"
  if is_agent_idle "$session" "$pane_index"; then
    _reprompt_mode="reprompt"
  elif is_agent_queueable "$session" "$pane_index"; then
    _reprompt_mode="queue"
  else
    echo "send_reprompt: pane $target is neither idle nor queueable" >&2
    return 1
  fi

  if [[ "$_reprompt_mode" == "queue" ]]; then
    # Queueable pane: type text and press Tab to queue (not Enter)
    clear_pane_input "$session" "$pane_index"
    tmux send-keys -l -t "$target" "$prompt_text" 2>/dev/null || {
      echo "send_reprompt: failed to send text to $target" >&2
      return 1
    }
    sleep 0.2
    tmux send-keys -t "$target" Tab 2>/dev/null || {
      echo "send_reprompt: failed to send Tab to $target" >&2
      return 1
    }
    # Verify queue acceptance — scrollback should still show active work
    sleep 0.2
    local _queue_check
    _queue_check=$(capture_pane_scrollback "$target" "-10") || _queue_check=""
    if codex_scrollback_shows_active_work "$_queue_check"; then
      return 0
    fi
    echo "send_reprompt: Tab sent but could not confirm queue acceptance on $target" >&2
    return 1
  fi

  send_codex_prompt_with_retry "$session" "$pane_index" "$prompt_text" "reprompt"
}
