# tmup — Multi-Agent Task DAG + tmux Grid

## What This Is
Claude Code plugin for multi-agent coordination via SQLite WAL-backed task DAG with tmux grid execution. Supports Codex CLI and Claude Code workers.

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
- dispatch-agent.sh: Codex launch path must remain VERBATIM — do not modify existing codex branch
- All pre-existing tests (698) must pass after any change — backward compat is non-negotiable

## Testing

    npm run build                    # Build succeeds
    npx vitest run                   # 698 tests pass
    bash -n scripts/dispatch-agent.sh # Syntax OK

## Project Layout

    shared/src/        — Types, constants, migrations, task/agent/message ops
    mcp-server/src/    — MCP tool definitions and handlers
    cli/src/           — CLI entry points
    scripts/           — dispatch-agent.sh, grid-setup.sh, pane-manager.sh
    tests/             — vitest test suites

## Development
- TypeScript: strict mode, vitest, ES2022, Node16 module resolution
- Git: conventional commits
- Plugin path: symlinked from ~/LAB/tmup/ to ~/.claude/plugins/tmup/
