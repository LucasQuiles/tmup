# tmup — Multi-Agent Task DAG + tmux Grid

## What This Is
Claude Code plugin for multi-agent coordination via SQLite WAL-backed task DAG with tmux grid execution. Supports Codex CLI and Claude Code workers. MCP server for tool access, CLI for worker coordination.

## Colony Runtime Integration
tmup is the execution engine for the sdlc-os Colony Runtime:
- Schema migration v4 adds colony columns: bead_id, sdlc_loop_level, worker_type, bridge_synced, clone_dir
- tmup_heartbeat MCP tool with SC-COL-19 next_heartbeat_due
- tmup_dispatch supports worker_type (codex/claude_code) and clone_isolation
- dispatch-agent.sh has Claude Code launch path (--worker-type claude_code)
- Colony constants: HEARTBEAT_THRESHOLDS per Cynefin domain (SC-COL-20)

## Hard Rules
- Never modify ExecutionTargetType for colony workers — use worker_type on tasks table (council C2)
- Workers dispatched with --permission-mode bypassPermissions (V-02 finding: auto broken in -p mode)
- dispatch-agent.sh: Codex launch path must preserve the full TMUP_CODEX_* runtime contract — bare-default regressions are forbidden
- All pre-existing tests must pass after any change — backward compat is non-negotiable

## Project Layout

    agents/        — 6 agent prompts (implementer, tester, reviewer, refactorer, documenter, investigator)
    agents/codex/  — Codex tiered agent TOMLs (tier1=gpt-5.3, tier2=gpt-5.2)
    cli/           — tmup-cli (Node.js, claim/complete/fail/message)
    mcp-server/    — MCP server (tmup_init, tmup_dispatch, tmup_harvest, tmup_reprompt, tmup_heartbeat, etc.)
    shared/        — Shared TypeScript library (task-ops, agent-ops, dep-resolver, migrations, colony types)
    scripts/       — Shell scripts (dispatch-agent, grid-setup, sync-codex-agents, lib/common.sh, lib/tmux-helpers.sh)
    config/        — policy.yaml (grid, timeouts, codex runtime contract)
    skills/        — tmup skill (SKILL.md, REFERENCE.md)
    commands/      — /tmup slash command
    tests/         — Vitest + shell test suites

## Agent Runtime Constraints

4 agents have enriched frontmatter with runtime-enforced fields (Phase 1, 2026-04-10):

| Agent | tools | isolation | memory | model |
|-------|-------|-----------|--------|-------|
| implementer | Read,Write,Edit,Grep,Glob,LS,Bash,Skill | worktree | local | sonnet |
| tester | Read,Write,Edit,Grep,Glob,LS,Bash | worktree | local | sonnet |
| reviewer | Read,Grep,Glob,LS,LSP | — | — | sonnet |
| refactorer | Read,Write,Edit,Grep,Glob,LS,Bash,Skill | worktree | local | sonnet |

Key constraints:
- tools: allowlists are enforced at session startup only (not after /reload-plugins)
- Read-only agents (reviewer) cannot Bash, Write, or Edit
- Write-capable agents get worktree isolation and local memory
- All agents pin model: sonnet (not inherited from session)

## Development Conventions
- TypeScript: strict mode, vitest, ES2022, Node16 module resolution
- Bash: set -euo pipefail
- Git: conventional commits (feat:, fix:, test:, docs:, refactor:)
- MCP server runs from plugin cache, not source dir — rebuild + sync-cache after changes
- Plugin path: symlinked from ~/LAB/tmup/ to ~/.claude/plugins/tmup/

## Testing — Required Before Commits

    npm run build                     # Build succeeds
    npx vitest run                    # all tests pass
    cd mcp-server && npx tsc --noEmit # TypeScript: 0 errors
    cd shared && npx tsc --noEmit     # TypeScript: 0 errors
    cd cli && npx tsc --noEmit        # TypeScript: 0 errors
    bash -n scripts/dispatch-agent.sh # Syntax OK

## Key Docs
- docs/ARCHITECTURE.md — System design
- docs/CONFIGURATION.md — policy.yaml reference
- docs/DEVELOPMENT.md — Dev workflow (cache sync critical)
- skills/tmup/REFERENCE.md — MCP tool reference
