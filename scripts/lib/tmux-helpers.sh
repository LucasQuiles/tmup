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
