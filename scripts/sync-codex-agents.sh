#!/bin/bash
# sync-codex-agents.sh — Gate and install experimental tmup agent TOMLs
# Default-off: active palette installation requires explicit post-canary receipts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="${TMUP_CODEX_AGENT_SOURCE_DIR:-$PLUGIN_DIR/agents/codex}"
TARGET_DIR="${TMUP_CODEX_AGENT_TARGET_DIR:-$HOME/.codex/agents}"
REQUIRED_FILES=(tmup-tier1.toml tmup-tier2.toml)

case "${TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS:-false}" in
  false|"")
    installed=()
    for required in "${REQUIRED_FILES[@]}"; do
      [[ -e "$TARGET_DIR/$required" || -L "$TARGET_DIR/$required" ]] && installed+=("$TARGET_DIR/$required")
    done
    if [[ ${#installed[@]} -gt 0 ]]; then
      echo "ERROR: experimental Codex tiers are disabled but installed definitions remain; explicitly remove: ${installed[*]}" >&2
      exit 1
    fi
    echo "Experimental Codex tiers disabled; no agent definitions installed"
    exit 0
    ;;
  true) ;;
  *)
    echo "ERROR: TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS must be true or false" >&2
    exit 1
    ;;
esac

if [[ -z "${TMUP_CODEX_CATALOG_VALIDATION_RECEIPT:-}" || \
      -z "${TMUP_CODEX_NAMED_ROLE_SELECTOR_RECEIPT:-}" ]]; then
  echo "ERROR: experimental tier enablement requires catalog validation and named-role selector receipts" >&2
  exit 1
fi

hash_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
    return
  fi
  echo "ERROR: need shasum, sha256sum, or openssl to verify tmup agent definitions" >&2
  return 1
}

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "ERROR: tmup Codex agent source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

SOURCE_FILES=()
for required in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$SOURCE_DIR/$required" ]]; then
    echo "ERROR: required tmup Codex agent definition missing: $SOURCE_DIR/$required" >&2
    exit 1
  fi
  SOURCE_FILES+=("$SOURCE_DIR/$required")
done

if [[ -L "$TARGET_DIR" ]]; then
  echo "ERROR: refusing symlinked Codex agent target directory: $TARGET_DIR" >&2
  exit 1
fi
mkdir -p "$TARGET_DIR"
[[ -d "$TARGET_DIR" && ! -L "$TARGET_DIR" ]] || {
  echo "ERROR: invalid Codex agent target directory: $TARGET_DIR" >&2
  exit 1
}

synced=0
for src in "${SOURCE_FILES[@]}"; do
  name="$(basename "$src")"
  tgt="$TARGET_DIR/$name"
  if [[ -L "$tgt" ]]; then
    echo "ERROR: refusing symlinked Codex agent target: $tgt" >&2
    exit 1
  fi
  if [[ ! -f "$tgt" ]] || [[ "$(hash_file "$src")" != "$(hash_file "$tgt")" ]]; then
    tmp=$(mktemp "$TARGET_DIR/.${name}.XXXXXX") || exit 1
    if ! cp "$src" "$tmp" || ! chmod 600 "$tmp" || ! mv "$tmp" "$tgt"; then
      rm -f "$tmp"
      exit 1
    fi
    synced=$((synced + 1))
  else
    chmod 600 "$tgt"
  fi
done

if [[ $synced -gt 0 ]]; then
  echo "Synced $synced agent definition(s) to $TARGET_DIR"
else
  echo "Agent definitions up to date"
fi
