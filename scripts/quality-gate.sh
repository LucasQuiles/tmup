#!/bin/bash
# quality-gate.sh — one fail-closed gate for the tmup plugin.
#
# Runs every check the repo requires before a commit is trusted:
#   production and full dependency audits, build, tracked generated-artifact
#   drift, full vitest suite, three tsc --noEmit passes, repository shell
#   syntax, model-id consistency between policy.yaml and agent TOMLs, and
#   (locally) default-off or receipt-gated experimental agent palette state.
#
# Fail-closed: the first failing step aborts with a named step and a
# nonzero exit. No step's output is discarded.
#
# Usage: scripts/quality-gate.sh [--ci]
#   --ci   skip machine-local checks (installed-agent sync drift)
#
# TMUP_GATE_SELFTEST_FAIL=1 injects a deliberately failing step so
# failure propagation itself is testable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
CI_MODE=0
[[ "${1:-}" == "--ci" ]] && CI_MODE=1

cd "$PLUGIN_DIR"

step() {
  local name="$1"; shift
  echo "== gate: $name"
  if ! "$@"; then
    echo "GATE FAIL: $name" >&2
    exit 1
  fi
}

if [[ "${TMUP_GATE_SELFTEST_FAIL:-0}" == "1" ]]; then
  step "selftest-injected-failure" false
fi

step "npm audit (production)" /bin/bash -p scripts/with-supported-node.sh npm audit --omit=dev --audit-level=low
step "npm audit (full)" /bin/bash -p scripts/with-supported-node.sh npm audit --audit-level=low
step "build" /bin/bash -p scripts/with-supported-node.sh npm run build --workspaces
step "generated artifact drift" git diff --exit-code -- shared/dist mcp-server/dist cli/dist
step "vitest" /bin/bash -p scripts/with-supported-node.sh npx vitest run
step "tsc mcp-server" /bin/bash -p -c 'cd mcp-server && /bin/bash -p ../scripts/with-supported-node.sh npx tsc --noEmit'
step "tsc shared" /bin/bash -p -c 'cd shared && /bin/bash -p ../scripts/with-supported-node.sh npx tsc --noEmit'
step "tsc cli" /bin/bash -p -c 'cd cli && /bin/bash -p ../scripts/with-supported-node.sh npx tsc --noEmit'
step "shell syntax" /bin/bash -p scripts/check-shell-syntax.sh

# model-id consistency: agent TOMLs must state exactly the policy.yaml tier models
check_models() {
  local policy="config/policy.yaml"
  local tier1 tier2 toml1 toml2
  tier1=$(awk '/tier1:/{f=1;next} f&&/model:/{gsub(/[" ]/,"",$2);print $2;exit}' "$policy")
  tier2=$(awk '/tier2:/{f=1;next} f&&/model:/{gsub(/[" ]/,"",$2);print $2;exit}' "$policy")
  toml1=$(awk -F'"' '/^model = /{print $2;exit}' agents/codex/tmup-tier1.toml)
  toml2=$(awk -F'"' '/^model = /{print $2;exit}' agents/codex/tmup-tier2.toml)
  if [[ -z "$tier1" || -z "$tier2" ]]; then
    echo "could not parse tier models from $policy" >&2
    return 1
  fi
  if [[ "$tier1" != "$toml1" || "$tier2" != "$toml2" ]]; then
    echo "model drift: policy tier1=$tier1 tier2=$tier2 vs TOML $toml1/$toml2" >&2
    return 1
  fi
}
step "policy/TOML model consistency" check_models

if [[ "$CI_MODE" -eq 0 ]]; then
  # Local only: dormant experimental profiles must be absent by default.
  # Explicit post-canary enablement requires both operator receipt assertions
  # and exact canonical-vs-installed parity.
  check_sync() {
    local target="${TMUP_CODEX_AGENT_TARGET_DIR:-$HOME/.codex/agents}"
    local enabled="${TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS:-false}" f

    case "$enabled" in
      false|"")
        for f in tmup-tier1.toml tmup-tier2.toml; do
          if [[ -e "$target/$f" || -L "$target/$f" ]]; then
            echo "experimental tiers are disabled but installed definition remains: $target/$f" >&2
            return 1
          fi
        done
        ;;
      true)
        if [[ -z "${TMUP_CODEX_CATALOG_VALIDATION_RECEIPT:-}" || \
              -z "${TMUP_CODEX_NAMED_ROLE_SELECTOR_RECEIPT:-}" ]]; then
          echo "experimental tier enablement requires catalog validation and named-role selector receipts" >&2
          return 1
        fi
        [[ ! -L "$target" ]] || {
          echo "installed agent target is a symlink: $target" >&2
          return 1
        }
        for f in tmup-tier1.toml tmup-tier2.toml; do
          if [[ ! -f "$target/$f" || -L "$target/$f" ]]; then
            echo "enabled experimental agent missing or symlinked: $target/$f (run scripts/sync-codex-agents.sh with receipts)" >&2
            return 1
          fi
          if ! diff -q "agents/codex/$f" "$target/$f" >/dev/null; then
            echo "installed experimental agent drift: $target/$f != agents/codex/$f" >&2
            return 1
          fi
        done
        ;;
      *)
        echo "TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS must be true or false" >&2
        return 1
        ;;
    esac
  }
  step "experimental agent palette state" check_sync
fi

echo "quality gate: all steps passed"
