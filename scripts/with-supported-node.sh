#!/bin/bash
set -euo pipefail

required_abi="115" # Node 20; matches the checked-in better-sqlite3 native build.

run_with_node_bin() {
  local directory="$1" candidate_abi
  shift
  [[ -x "$directory/node" ]] || return 1
  candidate_abi=$("$directory/node" -p 'process.versions.modules' 2>/dev/null || true)
  [[ "$candidate_abi" == "$required_abi" ]] || return 1
  export PATH="$directory:$PATH"
  exec "$@"
}

current_abi="$(node -p 'process.versions.modules' 2>/dev/null || true)"
if [[ "$current_abi" == "$required_abi" ]]; then
  exec "$@"
fi

if [[ ${TMUP_NODE20_BIN+x} ]]; then
  if [[ -z "$TMUP_NODE20_BIN" || "$TMUP_NODE20_BIN" != /* ]]; then
    echo "tmup: TMUP_NODE20_BIN must be an absolute bin directory" >&2
    exit 1
  fi
  if ! run_with_node_bin "$TMUP_NODE20_BIN" "$@"; then
    echo "tmup: TMUP_NODE20_BIN does not contain an executable Node ABI $required_abi runtime" >&2
    exit 1
  fi
fi

for node20_bin in \
  /opt/homebrew/opt/node@20/bin \
  /usr/local/opt/node@20/bin \
  /home/linuxbrew/.linuxbrew/opt/node@20/bin
do
  run_with_node_bin "$node20_bin" "$@" || true
done

cat >&2 <<EOF
tmup: unsupported Node ABI $current_abi (expected $required_abi / Node 20)
tmup's current better-sqlite3 dependency is not compatible with this Node runtime.
Install node@20, set TMUP_NODE20_BIN to its absolute bin directory, or upgrade
better-sqlite3 before running: $*
EOF
exit 1
