# tmup — Multi-Agent Task Coordination Plugin

## What This Is
Claude Code plugin: task DAG + tmux grid for coordinating Claude Code and Codex CLI workers. SQLite WAL-backed state, MCP server for tool access, CLI for worker coordination.

## Project Layout

    agents/        — 6 agent prompts (implementer, tester, reviewer, refactorer, documenter, investigator)
    agents/codex/  — Codex tiered agent TOMLs (tier1=gpt-5.3, tier2=gpt-5.2)
    cli/           — tmup-cli (Node.js, claim/complete/fail/message)
    mcp-server/    — MCP server (tmup_init, tmup_dispatch, tmup_harvest, tmup_reprompt, etc.)
    shared/        — Shared TypeScript library (task-ops, agent-ops, dep-resolver, etc.)
    scripts/       — Shell scripts (dispatch-agent, grid-setup, sync-codex-agents, etc.)
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
- TypeScript: strict mode, vitest, ES2022
- Bash: set -euo pipefail
- Git: conventional commits (feat:, fix:, test:, docs:, refactor:)
- MCP server runs from plugin cache, not source dir — rebuild + sync-cache after changes

## Testing — Required Before Commits

    npx vitest run                    # all tests pass
    cd mcp-server && npx tsc --noEmit # TypeScript: 0 errors
    cd shared && npx tsc --noEmit     # TypeScript: 0 errors
    cd cli && npx tsc --noEmit        # TypeScript: 0 errors

## Key Docs
- docs/ARCHITECTURE.md — System design
- docs/CONFIGURATION.md — policy.yaml reference
- docs/DEVELOPMENT.md — Dev workflow (cache sync critical)
- skills/tmup/REFERENCE.md — MCP tool reference (19 tools)
