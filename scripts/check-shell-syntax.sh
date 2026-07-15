#!/bin/bash
# Check every repository shell script deterministically.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ROOT="${1:-$REPO_ROOT}"

[[ -d "$ROOT" ]] || {
  echo "shell syntax root is not a directory: $ROOT" >&2
  exit 1
}

count=0
while IFS= read -r script; do
  bash -n "$script"
  count=$((count + 1))
done < <(
  find "$ROOT" \
    \( -type d \( -name .git -o -name .worktrees -o -name node_modules -o -name dist \) -prune \) -o \
    \( -type f -name '*.sh' -print \) |
    LC_ALL=C sort
)

[[ "$count" -gt 0 ]] || {
  echo "no shell scripts found under: $ROOT" >&2
  exit 1
}
