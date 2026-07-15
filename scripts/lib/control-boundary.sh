#!/bin/bash
# Protected controller paths for artifacts that an unsandboxed supervisor opens.

tmup_path_contains() {
  local parent="${1%/}" candidate="${2%/}"
  [[ "$candidate" == "$parent" || "$candidate" == "$parent"/* ]]
}

tmup_paths_overlap() {
  tmup_path_contains "$1" "$2" || tmup_path_contains "$2" "$1"
}

tmup_control_prepare_session() {
  local session_name="${1:-}" home_physical expected_root root_physical session_physical path child child_physical
  [[ "$session_name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ && ${#session_name} -le 128 ]] || {
    echo "invalid controller session name: $session_name" >&2
    return 1
  }
  [[ -d "$HOME" ]] || return 1
  home_physical=$(cd "$HOME" && pwd -P) || return 1
  expected_root="$home_physical/.local/state/tmup-control"

  for path in "$HOME/.local" "$HOME/.local/state" "$expected_root" "$expected_root/$session_name"; do
    [[ ! -L "$path" ]] || {
      echo "controller boundary contains a symlink component: $path" >&2
      return 1
    }
    [[ ! -e "$path" || -d "$path" ]] || {
      echo "controller boundary component is not a directory: $path" >&2
      return 1
    }
  done
  for child in artifacts locks logs tasks; do
    path="$expected_root/$session_name/$child"
    [[ ! -L "$path" ]] || {
      echo "controller boundary contains a symlink component: $path" >&2
      return 1
    }
    [[ ! -e "$path" || -d "$path" ]] || {
      echo "controller boundary component is not a directory: $path" >&2
      return 1
    }
  done

  umask 0077
  mkdir -p \
    "$expected_root/$session_name/artifacts" \
    "$expected_root/$session_name/locks" \
    "$expected_root/$session_name/logs" \
    "$expected_root/$session_name/tasks" || return 1
  chmod 700 \
    "$expected_root" \
    "$expected_root/$session_name" \
    "$expected_root/$session_name/artifacts" \
    "$expected_root/$session_name/locks" \
    "$expected_root/$session_name/logs" \
    "$expected_root/$session_name/tasks" || return 1

  root_physical=$(cd "$expected_root" && pwd -P) || return 1
  session_physical=$(cd "$expected_root/$session_name" && pwd -P) || return 1
  [[ "$root_physical" == "$expected_root" && "$session_physical" == "$root_physical/$session_name" ]] || {
    echo "controller boundary escaped its canonical root" >&2
    return 1
  }
  for child in artifacts locks logs tasks; do
    path="$session_physical/$child"
    [[ -d "$path" && ! -L "$path" ]] || return 1
    child_physical=$(cd "$path" && pwd -P) || return 1
    [[ "$child_physical" == "$session_physical/$child" ]] || {
      echo "controller child escaped its canonical session: $path" >&2
      return 1
    }
  done

  TMUP_CONTROL_ROOT="$root_physical"
  TMUP_CONTROL_SESSION_DIR="$session_physical"
  TMUP_CONTROL_ARTIFACT_DIR="$session_physical/artifacts"
  TMUP_CONTROL_LOCK_DIR="$session_physical/locks"
  TMUP_CONTROL_LOG_DIR="$session_physical/logs"
  TMUP_CONTROL_TASK_ROOT="$session_physical/tasks"
  export TMUP_CONTROL_ROOT TMUP_CONTROL_SESSION_DIR TMUP_CONTROL_ARTIFACT_DIR
  export TMUP_CONTROL_LOCK_DIR TMUP_CONTROL_LOG_DIR TMUP_CONTROL_TASK_ROOT
}

tmup_control_validate_worker_boundary() {
  local working_dir="$1" state_dir="$2" plugin_dir="$3" trusted_shared="${4:-0}"
  local state_root="${state_dir%/*}"

  if tmup_paths_overlap "$working_dir" "$TMUP_CONTROL_ROOT"; then
    echo "working directory overlaps protected controller state: $working_dir" >&2
    return 1
  fi
  if tmup_path_contains "$working_dir" "$plugin_dir"; then
    echo "working directory overlaps supervisor plugin code: $working_dir" >&2
    return 1
  fi
  if tmup_path_contains "$plugin_dir" "$working_dir" && \
     ! tmup_path_contains "$plugin_dir/.worktrees" "$working_dir"; then
    echo "working directory is inside a controller-consumed plugin subtree: $working_dir" >&2
    return 1
  fi
  if tmup_paths_overlap "$working_dir" "$state_root"; then
    # Trusted shared-state mode may place the worker at or below this exact
    # session only. It never authorizes ancestors or sibling sessions.
    if [[ "$trusted_shared" -ne 1 ]] || ! tmup_path_contains "$state_dir" "$working_dir"; then
      echo "working directory overlaps protected session state root: $working_dir" >&2
      return 1
    fi
  fi
}

tmup_control_remove_session() {
  local session_name="${1:-}" home_physical root session root_physical session_physical child child_path
  [[ "$session_name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ && ${#session_name} -le 128 ]] || return 1
  home_physical=$(cd "$HOME" 2>/dev/null && pwd -P) || return 1
  root="$home_physical/.local/state/tmup-control"
  session="$root/$session_name"

  [[ -e "$root" || -L "$root" ]] || return 0
  [[ -d "$root" && ! -L "$root" ]] || {
    echo "refusing unsafe controller root cleanup: $root" >&2
    return 1
  }
  [[ -e "$session" || -L "$session" ]] || return 0
  [[ -d "$session" && ! -L "$session" ]] || {
    echo "refusing unsafe controller session cleanup: $session" >&2
    return 1
  }

  root_physical=$(cd "$root" && pwd -P) || return 1
  session_physical=$(cd "$session" && pwd -P) || return 1
  [[ "$root_physical" == "$root" && "$session_physical" == "$root_physical/$session_name" ]] || {
    echo "refusing controller cleanup outside canonical session boundary" >&2
    return 1
  }
  for child in artifacts locks logs tasks; do
    child_path="$session/$child"
    [[ ! -L "$child_path" ]] || {
      echo "refusing controller cleanup with symlinked child: $child_path" >&2
      return 1
    }
    [[ ! -e "$child_path" || -d "$child_path" ]] || {
      echo "refusing controller cleanup with invalid child: $child_path" >&2
      return 1
    }
  done
  rm -rf -- "$session"
}
