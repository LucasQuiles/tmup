#!/usr/bin/env bash
# Sync tmup plugin source to Claude Code plugin cache
# Run after making changes to source files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(dirname "$SCRIPT_DIR")"
CACHE="$HOME/.claude/plugins/cache/tmup-dev/tmup/0.1.0"

if [ ! -d "$CACHE" ]; then
  echo "Cache directory does not exist. Creating..."
  mkdir -p "$CACHE"
fi

rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  "$SRC/" "$CACHE/"

# node_modules needs special handling — copy only if missing
if [ ! -d "$CACHE/node_modules" ] && [ -d "$SRC/node_modules" ]; then
  cp -r "$SRC/node_modules" "$CACHE/node_modules"
fi

echo "tmup cache synced: $CACHE"
