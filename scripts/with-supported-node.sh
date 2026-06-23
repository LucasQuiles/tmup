#!/usr/bin/env bash
set -euo pipefail

required_abi="115" # Node 20; matches the checked-in better-sqlite3 native build.
node20_bin="/opt/homebrew/opt/node@20/bin"

current_abi="$(node -p 'process.versions.modules' 2>/dev/null || true)"
if [[ "$current_abi" == "$required_abi" ]]; then
  exec "$@"
fi

if [[ -x "$node20_bin/node" ]]; then
  export PATH="$node20_bin:$PATH"
  exec "$@"
fi

cat >&2 <<EOF
tmup: unsupported Node ABI $current_abi (expected $required_abi / Node 20)
tmup's current better-sqlite3 dependency is not compatible with this Node runtime.
Install node@20 or upgrade better-sqlite3 before running: $*
EOF
exit 1
