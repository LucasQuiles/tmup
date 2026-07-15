#!/bin/bash
# Trusted toolchain bootstrap for supervisor-owned shell control paths.

# Never accept an inherited internal test directory. A validated Vitest-only
# override may populate this value for the dispatcher's second boundary pass.
_TMUP_CONTROLLER_TEST_DIR_PHYSICAL=""
source "${BASH_SOURCE[0]%/*}/state-root.sh" || return 1 2>/dev/null || exit 1

_tmup_controller_paths_overlap() {
  local left="${1%/}" right="${2%/}"
  [[ "$right" == "$left" || "$right" == "$left"/* || "$left" == "$right"/* ]]
}

_tmup_controller_path_contains() {
  local parent="${1%/}" candidate="${2%/}"
  [[ "$candidate" == "$parent" || "$candidate" == "$parent"/* ]]
}

_tmup_controller_resolve_file() {
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

_tmup_controller_test_harness_active() {
  local ps_bin="" parent_command=""
  [[ "${VITEST:-}" == "true" ]] || return 1
  if [[ -x /bin/ps ]]; then
    ps_bin=/bin/ps
  elif [[ -x /usr/bin/ps ]]; then
    ps_bin=/usr/bin/ps
  else
    return 1
  fi
  parent_command=$("$ps_bin" -p "$PPID" -o command= 2>/dev/null) || return 1
  case "$parent_command" in
    *vitest*|*tinypool*) return 0 ;;
    *) return 1 ;;
  esac
}

tmup_controller_establish_toolchain() {
  local worker_root="${1:-}" plugin_root="${2:-}" worker_physical="" home_physical
  local state_root_mode="${3:-existing}" mkdir_bin="" chmod_bin=""
  local state_root control_root source_path remaining entry physical result="" candidate target tool
  local fixed_dirs="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin"
  local approved_prefixes="/opt/homebrew:/usr/local:/usr:/bin:/sbin:/home/linuxbrew/.linuxbrew"

  # Strip startup, runtime-loader, and language-loader injection before the
  # first external command this helper invokes.
  unset BASH_ENV ENV NODE_OPTIONS NODE_PATH CDPATH
  unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
  unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
  unset PERL5OPT PERL5LIB PYTHONPATH PYTHONHOME RUBYOPT RUBYLIB

  [[ -d "$HOME" ]] || return 1
  home_physical=$(cd -P -- "$HOME" && pwd -P) || return 1
  if [[ -n "$worker_root" ]]; then
    [[ "$worker_root" == /* && -d "$worker_root" ]] || return 1
    worker_physical=$(cd -P -- "$worker_root" && pwd -P) || return 1
  fi
  control_root="$home_physical/.local/state/tmup-control"
  _tmup_resolve_state_root state_root || return 1
  [[ "$state_root" == /* && "$state_root" != "/" ]] || return 1
  if _tmup_controller_paths_overlap "$state_root" "$control_root" || \
     { [[ -n "$worker_physical" ]] && _tmup_controller_paths_overlap "$state_root" "$worker_physical"; } || \
     { [[ -n "$plugin_root" ]] && _tmup_controller_paths_overlap "$state_root" "$plugin_root"; }; then
    return 1
  fi
  if [[ ! -d "$state_root" ]]; then
    [[ "$state_root_mode" == "create-state-root" ]] || return 1
    for candidate in /bin/mkdir /usr/bin/mkdir; do
      [[ -x "$candidate" ]] && { mkdir_bin="$candidate"; break; }
    done
    for candidate in /bin/chmod /usr/bin/chmod; do
      [[ -x "$candidate" ]] && { chmod_bin="$candidate"; break; }
    done
    [[ -n "$mkdir_bin" && -n "$chmod_bin" ]] || return 1
    "$mkdir_bin" -p -- "$state_root" || return 1
    "$chmod_bin" 700 "$state_root" || return 1
  fi
  state_root=$(cd -P -- "$state_root" && pwd -P) || return 1
  if _tmup_controller_paths_overlap "$state_root" "$control_root" || \
     { [[ -n "$worker_physical" ]] && _tmup_controller_paths_overlap "$state_root" "$worker_physical"; } || \
     { [[ -n "$plugin_root" ]] && _tmup_controller_paths_overlap "$state_root" "$plugin_root"; }; then
    return 1
  fi

  source_path="$fixed_dirs"
  if [[ -n "${TMUP_TEST_CONTROLLER_TOOL_DIRS:-}" ]]; then
    [[ "${TMUP_TEST_CONTROLLER_OVERRIDE:-0}" == "1" ]] || return 1
    _tmup_controller_test_harness_active || return 1
    [[ "$TMUP_TEST_CONTROLLER_TOOL_DIRS" == /* && "$TMUP_TEST_CONTROLLER_TOOL_DIRS" != *:* && \
       -d "$TMUP_TEST_CONTROLLER_TOOL_DIRS" ]] || return 1
    _TMUP_CONTROLLER_TEST_DIR_PHYSICAL=$(cd -P -- "$TMUP_TEST_CONTROLLER_TOOL_DIRS" && pwd -P) || return 1
  fi
  if [[ -n "${_TMUP_CONTROLLER_TEST_DIR_PHYSICAL:-}" ]]; then
    source_path="$_TMUP_CONTROLLER_TEST_DIR_PHYSICAL:$source_path"
  fi

  # Parse colon-separated paths without unquoted expansion or globbing.
  remaining="$source_path"
  while :; do
    case "$remaining" in
      *:*) entry="${remaining%%:*}"; remaining="${remaining#*:}" ;;
      *) entry="$remaining"; remaining="" ;;
    esac
    if [[ -n "$entry" && "$entry" == /* && -d "$entry" ]]; then
      physical=$(cd -P -- "$entry" 2>/dev/null && pwd -P) || physical=""
      if [[ -n "$physical" ]]; then
        if [[ -n "$worker_physical" ]] && _tmup_controller_paths_overlap "$physical" "$worker_physical"; then
          return 1
        elif _tmup_controller_paths_overlap "$physical" "$state_root" || \
             _tmup_controller_paths_overlap "$physical" "$control_root" || \
             { [[ -n "$plugin_root" ]] && _tmup_controller_paths_overlap "$physical" "$plugin_root"; }; then
          physical=""
        fi
      fi
      if [[ -n "$physical" ]]; then
        case ":$result:" in
          *":$physical:"*) ;;
          *) result="${result:+$result:}$physical" ;;
        esac
      fi
    fi
    [[ -n "$remaining" ]] || break
  done
  [[ "$state_root_mode" == "existing" || "$state_root_mode" == "create-state-root" ]] || return 1
  [[ -n "$result" ]] || return 1
  PATH="$result"
  export PATH

  # Fixed directories are outside worker roots, but final executable symlinks
  # must be checked too. This also falsifies unsafe test overrides.
  for tool in \
    awk bash basename cat chmod cp cut date dirname du flock git gnome-terminal grep head \
    hostname id install jq mkdir mktemp mv node od openssl perl ps readlink realpath rm \
    rmdir sed sha256sum shasum sleep sort stat tail tmux touch tr uname wc yq; do
    candidate=$(type -P "$tool" 2>/dev/null || true)
    [[ -n "$candidate" ]] || continue
    target=$(_tmup_controller_resolve_file "$candidate") || return 1
    [[ -f "$target" && -x "$target" && ! -L "$target" ]] || return 1
    local target_approved=0 prefix prefix_physical prefix_remaining="$approved_prefixes"
    if [[ -n "${_TMUP_CONTROLLER_TEST_DIR_PHYSICAL:-}" ]] && \
       _tmup_controller_path_contains "$_TMUP_CONTROLLER_TEST_DIR_PHYSICAL" "$candidate"; then
      if _tmup_controller_path_contains "$_TMUP_CONTROLLER_TEST_DIR_PHYSICAL" "$target"; then
        target_approved=1
      fi
    else
      while :; do
        case "$prefix_remaining" in
          *:*) prefix="${prefix_remaining%%:*}"; prefix_remaining="${prefix_remaining#*:}" ;;
          *) prefix="$prefix_remaining"; prefix_remaining="" ;;
        esac
        if [[ -d "$prefix" ]]; then
          prefix_physical=$(cd -P -- "$prefix" 2>/dev/null && pwd -P) || prefix_physical=""
          if [[ -n "$prefix_physical" ]] && _tmup_controller_path_contains "$prefix_physical" "$target"; then
            target_approved=1
            break
          fi
        fi
        [[ -n "$prefix_remaining" ]] || break
      done
    fi
    [[ "$target_approved" -eq 1 ]] || return 1
    if [[ -n "$worker_physical" ]] && _tmup_controller_paths_overlap "$target" "$worker_physical"; then
      return 1
    fi
    if _tmup_controller_paths_overlap "$target" "$state_root" || \
       _tmup_controller_paths_overlap "$target" "$control_root" || \
       { [[ -n "$plugin_root" ]] && _tmup_controller_paths_overlap "$target" "$plugin_root"; }; then
      return 1
    fi
  done

  TMUP_CONTROLLER_PATH="$PATH"
  export TMUP_CONTROLLER_PATH
  unset TMUP_TEST_CONTROLLER_TOOL_DIRS TMUP_TEST_CONTROLLER_OVERRIDE
}
