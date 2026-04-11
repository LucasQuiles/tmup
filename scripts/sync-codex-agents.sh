#!/bin/bash
# sync-codex-agents.sh — Install tmup custom agent TOMLs into ~/.codex/agents/
# Idempotent: only copies when source is newer or target is missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="${TMUP_CODEX_AGENT_SOURCE_DIR:-$PLUGIN_DIR/agents/codex}"
TARGET_DIR="${TMUP_CODEX_AGENT_TARGET_DIR:-$HOME/.codex/agents}"
REQUIRED_FILES=(tmup-tier1.toml tmup-tier2.toml)

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

shopt -s nullglob
SOURCE_FILES=("$SOURCE_DIR"/*.toml)
shopt -u nullglob

if [[ ${#SOURCE_FILES[@]} -eq 0 ]]; then
  echo "ERROR: no tmup Codex agent definitions found in $SOURCE_DIR" >&2
  exit 1
fi

for required in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$SOURCE_DIR/$required" ]]; then
    echo "ERROR: required tmup Codex agent definition missing: $SOURCE_DIR/$required" >&2
    exit 1
  fi
done

mkdir -p "$TARGET_DIR"

synced=0
for src in "${SOURCE_FILES[@]}"; do
  name="$(basename "$src")"
  tgt="$TARGET_DIR/$name"
  if [[ ! -f "$tgt" ]] || [[ "$(hash_file "$src")" != "$(hash_file "$tgt")" ]]; then
    cp "$src" "$tgt"
    synced=$((synced + 1))
  fi
done

if [[ $synced -gt 0 ]]; then
  echo "Synced $synced agent definition(s) to $TARGET_DIR"
else
  echo "Agent definitions up to date"
fi
