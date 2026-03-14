[< Back to README](../README.md)

# Development

```bash
npm test          # Run all 631 tests
npm run build     # Build all workspaces (shared -> mcp-server -> cli)
npm run test:watch  # Watch mode for development
```

## Dev workflow (after making changes)

Here is the single most important thing to understand about developing tmup, and if you skip this section you will waste an hour wondering why your changes aren't working:

**The MCP server runs from a cache copy, not from the source directory.**

Claude Code copies the plugin to `~/.claude/plugins/cache/tmup-dev/tmup/0.1.0/` and runs it from there. Your source directory is not what's executing. After editing source:

```bash
# 1. Build (compiles TypeScript, bundles with esbuild)
cd ~/.claude/plugins/tmup && npm run build

# 2. Sync to plugin cache (rsync source -> cache)
bash scripts/sync-cache.sh

# 3. Restart Claude Code session
# The MCP server loads once at session start.
# There is no hot-reload. There never will be.
# Accept this. Move on. Restart the session.
```

Skipping step 2 means Claude runs stale code from the cache. Skipping step 3 means the old MCP server process stays in memory with the old bundle. Both of these will make you question your sanity. Do all three steps. Every time.

## Test coverage

631 tests across 24 files. Every test creates a fresh temp SQLite database, runs the operation, and asserts the result. No shared state between tests. Minimal flakiness. We spent more time on the tests than on several of the features they test, which is either good engineering or misplaced priorities depending on who you ask.

Coverage includes:
- Task DAG operations and dependency resolution (including cycle detection)
- Task lifecycle state machine (every transition, including edge cases)
- Inter-agent messaging (framing, inbox, broadcast, autonomy enforcement)
- Dead claim recovery (stale heartbeats, task reassignment)
- Concurrent SQLite access patterns
- MCP tool handler integration (including dispatch shell boundary)
- CLI command handling (all 9 commands, error paths, JSON output)
- Shell script boundary conditions (config loading, session resolution)
- Schema parity between SQL and TypeScript (compile-time safety net)
- Fuzz edge cases (empty strings, null values, Unicode, injection attempts)
- Non-cascade transitive cancel propagation (A -> B -> C depth)
- Multi-artifact completion rollback integrity
