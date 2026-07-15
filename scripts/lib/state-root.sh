#!/bin/bash
# Shared, dependency-free tmup state-root resolution.

_tmup_normalize_absolute_path() {
  local raw="$1" output_var="$2" rest component normalized index
  local component_count=0
  local -a components=()

  if [[ -z "$raw" || "$raw" != /* ]]; then
    echo "tmup state-root: TMUP_STATE_ROOT must be an absolute path" >&2
    return 1
  fi

  rest="${raw#/}"
  while [[ -n "$rest" ]]; do
    if [[ "$rest" == */* ]]; then
      component="${rest%%/*}"
      rest="${rest#*/}"
    else
      component="$rest"
      rest=""
    fi

    case "$component" in
      ""|.) ;;
      ..)
        if [[ "$component_count" -gt 0 ]]; then
          component_count=$((component_count - 1))
          unset "components[$component_count]"
        fi
        ;;
      *)
        components[component_count]="$component"
        component_count=$((component_count + 1))
        ;;
    esac
  done

  normalized="/"
  for ((index = 0; index < component_count; index++)); do
    if [[ "$normalized" == "/" ]]; then
      normalized="/${components[$index]}"
    else
      normalized="$normalized/${components[$index]}"
    fi
  done
  printf -v "$output_var" '%s' "$normalized"
}

_tmup_resolve_state_root() {
  local output_var="$1" raw
  if [[ ${TMUP_STATE_ROOT+x} ]]; then
    raw="$TMUP_STATE_ROOT"
  else
    if [[ -z "${HOME:-}" ]]; then
      echo "tmup state-root: HOME is not set and TMUP_STATE_ROOT was not provided" >&2
      return 1
    fi
    raw="$HOME/.local/state/tmup"
  fi

  _tmup_normalize_absolute_path "$raw" "$output_var" || return 1
  if [[ "${!output_var}" == "/" ]]; then
    echo "tmup state-root: TMUP_STATE_ROOT must not resolve to /" >&2
    return 1
  fi
}
