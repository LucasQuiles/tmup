#!/bin/bash
# tmux-helpers.sh — Tmux utility functions for tmup

# Check if a process in a pane is an agent (not a shell)
is_agent_process() {
  local cmd="${1:-}"
  case "$cmd" in
    codex|node|npm|npx) return 0 ;;
    *) return 1 ;;
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

# Strip ANSI escape codes from text
strip_ansi() {
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g'
}

# Get the actual running command in a pane (walks process tree)
get_pane_command() {
  local session="${1:-}" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  tmux display-message -t "$target" -p '#{pane_current_command}' 2>/dev/null || echo ""
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
  scrollback=$(tmux capture-pane -t "$target" -p -S -5 2>/dev/null) || return 1
  # If scrollback contains "Working (" the agent is busy
  if echo "$scrollback" | grep -qF "Working ("; then
    # Exception: "tab to queue" means agent accepts input while working
    if echo "$scrollback" | grep -qiF "tab to queue"; then
      return 0
    fi
    return 1
  fi
  return 0
}

# Clear any stale input from a pane
clear_pane_input() {
  local session="$1" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  tmux send-keys -t "$target" C-u 2>/dev/null || true
  sleep 0.1
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

  # Guard: agent must be idle (not actively working)
  if ! is_agent_idle "$session" "$pane_index"; then
    echo "send_reprompt: agent in $target is busy (Working)" >&2
    return 1
  fi

  # Clear any stale input before sending new text
  clear_pane_input "$session" "$pane_index"

  # Write prompt to secure temp file
  local tmpfile
  tmpfile=$(mktemp "/tmp/tmup-reprompt-${pane_index}-XXXXXX.txt")
  chmod 600 "$tmpfile"
  echo "$prompt_text" > "$tmpfile"

  # Send text with -l flag (literal mode prevents "Enter" in text triggering keys)
  tmux send-keys -l -t "$target" "$(cat "$tmpfile")" || {
    echo "send_reprompt: failed to send text to $target" >&2
    rm -f "$tmpfile"
    return 1
  }

  # Verify text appeared in scrollback (write verify text to file to avoid shell quoting issues)
  local verify_text="${prompt_text:0:40}"
  local reprompt_timeout="${CFG_REPROMPT_TIMEOUT:-10}"
  local verify_file
  verify_file=$(mktemp "/tmp/tmup-verify-XXXXXX.txt")
  printf '%s' "$verify_text" > "$verify_file"

  if ! timeout "$reprompt_timeout" bash -c '
    _vfile="$1"; _target="$2"
    sleep 0.3
    scrollback=$(tmux capture-pane -t "$_target" -p -S -20 2>/dev/null) || scrollback=""
    if echo "$scrollback" | grep -qFf "$_vfile"; then exit 0; fi
    sleep 0.3
    scrollback=$(tmux capture-pane -t "$_target" -p -S -20 2>/dev/null) || scrollback=""
    echo "$scrollback" | grep -qFf "$_vfile"
  ' _ "$verify_file" "$target"; then
    echo "send_reprompt: text not confirmed in scrollback for $target (timed out)" >&2
    rm -f "$tmpfile" "$verify_file"
    return 1
  fi
  rm -f "$verify_file"

  # Submit: double-Enter (first may not register if input buffer unfocused)
  tmux send-keys -t "$target" Enter
  sleep 0.2
  tmux send-keys -t "$target" Enter

  rm -f "$tmpfile"
  return 0
}
