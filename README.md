# tmup

**tmux + team up = tmup**

Claude Code and Codex CLI. Together. In a tmux grid. Talking to each other through a shared SQLite database while you watch them argue about your codebase in real time.

```
  Claude Code (lead)         tmux 2x4 grid
  ┌──────────────┐     ┌────┬────┬────┬────┐
  │ "I'll break  │────>│ C1 │ C2 │ C3 │ C4 │  Codex workers
  │  this into   │     ├────┼────┼────┼────┤  (8 panes)
  │  8 tasks"    │     │ C5 │ C6 │ C7 │ C8 │
  └──────┬───────┘     └────┴────┴────┴────┘
         │                    │
         └────── SQLite WAL ──┘
              (shared brain)
```

One Claude Code session orchestrates. Up to 8 Codex CLI workers execute. They coordinate through a task DAG backed by SQLite WAL mode. Dependencies cascade. Failed tasks retry. Dead workers get their claims recovered. You get to lean back and watch a small army of AI agents build your project in parallel.

## What is this

tmup is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that turns your terminal into a multi-agent war room:

- **Claude Code** is the lead. It plans the work, creates a task DAG, dispatches workers, monitors progress, and harvests results.
- **Codex CLI** workers run in tmux panes. Each one claims tasks, writes code, checkpoints progress, and reports back.
- **SQLite WAL** is the shared brain. One writer, many readers. No network. No API. Just a file on disk that 9 AI agents hammer concurrently.
- **tmux** is the grid. You can see every agent working in real time. You can watch them. You can judge them.

### The numbers

Context windows depend on your model configuration. Some real combinations:

| Configuration | Lead | Workers (x8) | Combined context |
|--------------|------|-------------|-----------------|
| Claude Opus 4.6 (1M) + Codex GPT-5.4 (1M) | 1M tokens | 8M tokens | **9M tokens** |
| Claude Sonnet 4.6 (200K) + Codex GPT-4.1 (200K) | 200K tokens | 1.6M tokens | **1.8M tokens** |
| Claude Opus 4.6 (1M) + Codex GPT-4.1 (200K) | 1M tokens | 1.6M tokens | **2.6M tokens** |

That's up to **9 million tokens** of combined context window working on your codebase simultaneously. Each agent has full tool access. The lead sees everything. The workers are autonomous within their task scope.

Is this a good idea? Probably not. Does it work? Yes, disturbingly well.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- [Codex CLI](https://github.com/openai/codex) (`~/.local/bin/codex` or in PATH)
- [tmux](https://github.com/tmux/tmux) >= 3.0
- Node.js >= 20
- jq

## Installation

```bash
# Clone this repo into your Claude Code plugins directory
git clone https://github.com/LucasQuiles/tmup.git ~/.claude/plugins/tmup

# Install dependencies and build
cd ~/.claude/plugins/tmup
npm install && npm run build

# Install the plugin into Claude Code
claude plugin install tmup@tmup-dev
```

### Manual registration (if `plugin install` doesn't work)

Add to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "tmup-dev": {
      "source": { "source": "directory", "path": "~/.claude/plugins/tmup" }
    }
  },
  "enabledPlugins": {
    "tmup@tmup-dev": true
  }
}
```

Then restart Claude Code.

### Permissions (required for `dontAsk` mode)

If you run Claude Code with `defaultMode: "dontAsk"` in your settings, the tmup MCP tools need explicit permission. The `mcp__*` wildcard in `settings.json` does **not** override an explicit allow list in `settings.local.json`.

Add all 18 tmup tools to your `~/.claude/settings.local.json` permissions:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_tmup_tmup__tmup_init",
      "mcp__plugin_tmup_tmup__tmup_status",
      "mcp__plugin_tmup_tmup__tmup_next_action",
      "mcp__plugin_tmup_tmup__tmup_task_create",
      "mcp__plugin_tmup_tmup__tmup_task_batch",
      "mcp__plugin_tmup_tmup__tmup_task_update",
      "mcp__plugin_tmup_tmup__tmup_claim",
      "mcp__plugin_tmup_tmup__tmup_complete",
      "mcp__plugin_tmup_tmup__tmup_fail",
      "mcp__plugin_tmup_tmup__tmup_cancel",
      "mcp__plugin_tmup_tmup__tmup_checkpoint",
      "mcp__plugin_tmup_tmup__tmup_send_message",
      "mcp__plugin_tmup_tmup__tmup_inbox",
      "mcp__plugin_tmup_tmup__tmup_dispatch",
      "mcp__plugin_tmup_tmup__tmup_harvest",
      "mcp__plugin_tmup_tmup__tmup_pause",
      "mcp__plugin_tmup_tmup__tmup_resume",
      "mcp__plugin_tmup_tmup__tmup_teardown"
    ]
  }
}
```

Without this, you'll get `Permission denied` errors when Claude tries to use tmup tools. Restart Claude Code after updating settings.

## Quick start

Inside a Claude Code session:

```
> /tmup

# Claude will:
# 1. Initialize a tmup session for your project
# 2. Create a tmux grid (default 2x4 = 8 panes, opens in a new terminal)
# 3. Ask you what you want to build
# 4. Break it into a task DAG with dependencies
# 5. Dispatch Codex workers to tmux panes
# 6. Monitor, coordinate, harvest, and integrate the results
```

That's it. One command. Claude handles the rest.

## How it works

### Architecture

```
Claude Code (Lead)
  │
  ├─ MCP Server (18 tools)
  │    └─ @tmup/shared (SQLite WAL)
  │         └─ tmup.db (16 tables, task DAG)
  │
  ├─ Bash Scripts
  │    ├─ grid-setup.sh    (create NxM tmux grid)
  │    ├─ dispatch-agent.sh (launch Codex in pane)
  │    ├─ grid-teardown.sh  (cleanup)
  │    └─ lib/              (config, registry, validation)
  │
  └─ tmux Grid (2x4 default)
       └─ Codex Workers (tmup-cli)
            ├─ claim → work → checkpoint → complete
            └─ All share the same SQLite DB
```

### Task lifecycle

```
pending ──> claimed ──> completed (cascades: unblocks dependents)
                    ──> needs_review (non-retriable failure)
                    ──> pending (retriable failure, with backoff)
blocked ──> pending (when dependencies satisfied)
any ────> cancelled (lead only)
```

### Agent roles

| Role | Autonomy | Can message |
|------|----------|-------------|
| implementer | checkpoint | lead only |
| tester | checkpoint | lead only |
| refactorer | checkpoint | lead only |
| documenter | checkpoint | lead only |
| reviewer | full | any agent |
| investigator | full | any agent |

**Checkpoint autonomy**: agent works independently but posts progress at milestones. Can only talk to the lead.

**Full participant**: agent can message any other agent directly. Used for cross-cutting concerns like code review and investigation.

### Concurrency model

SQLite WAL mode. One writer at a time, unlimited concurrent readers. All writes use `IMMEDIATE` transactions. `busy_timeout=8000ms` handles contention. In practice, 8 agents hammering the same DB file works fine because most operations are fast reads and task claims are serialized by nature.

### Dead claim recovery

Workers send heartbeats. If a worker dies (crashed Codex, killed pane, heat death of laptop), the lead detects stale claims via `tmup_status` and can reassign the work. No task is silently lost.

## MCP tools (18)

These are the tools Claude Code uses to orchestrate:

| Tool | What it does |
|------|-------------|
| `tmup_init` | Initialize session (DB + registry) |
| `tmup_status` | DAG overview + dead claim detection |
| `tmup_next_action` | "What should I do next?" decision tree |
| `tmup_task_create` | Add one task to the DAG |
| `tmup_task_batch` | Add multiple tasks atomically with deps |
| `tmup_task_update` | Modify task status or priority |
| `tmup_claim` | Claim a task for an agent |
| `tmup_complete` | Mark task done, cascade unblocks |
| `tmup_fail` | Report task failure with reason |
| `tmup_cancel` | Cancel a task (optional cascade) |
| `tmup_checkpoint` | Post progress update |
| `tmup_send_message` | Inter-agent messaging |
| `tmup_inbox` | Check unread messages |
| `tmup_dispatch` | Launch Codex worker in tmux pane |
| `tmup_harvest` | Capture pane scrollback output |
| `tmup_pause` | Pause session |
| `tmup_resume` | Resume paused session |
| `tmup_teardown` | Shut everything down |

## CLI commands (9)

These are the commands Codex workers use from inside their panes:

```bash
tmup-cli claim [--role <role>]              # Claim next available task
tmup-cli complete "summary" [--artifact]    # Mark task done
tmup-cli fail --reason <reason> "message"   # Report failure
tmup-cli checkpoint "progress update"       # Post progress
tmup-cli message --to <target> "message"    # Send message
tmup-cli inbox [--mark-read]                # Check messages
tmup-cli heartbeat                          # Register liveness
tmup-cli status                             # Current assignment
tmup-cli events [--limit N]                 # Query audit log
```

## Configuration

Everything is in `config/policy.yaml`:

```yaml
grid:
  rows: 2          # tmux grid rows
  cols: 4          # tmux grid columns (2x4 = 8 panes)
  width: 240       # terminal width
  height: 55       # terminal height

dag:
  max_retries: 3   # auto-retry on crash/timeout
  retry_backoff_base_seconds: 30

autonomy:
  full_participant_roles: [investigator, reviewer]
  checkpoint_roles: [implementer, tester, refactorer, documenter]
```

## Project structure

```
tmup/
├── .claude-plugin/      # Plugin registration
├── agents/              # 6 agent role definitions
├── cli/                 # tmup-cli (worker binary)
├── commands/            # /tmup slash command
├── config/              # policy.yaml, schema.sql, runtime-contract.json
├── mcp-server/          # MCP server (18 tools)
├── scripts/             # Bash automation (grid, dispatch, teardown)
├── shared/              # @tmup/shared library (22 TypeScript modules)
├── skills/              # Skill documentation
└── tests/               # 621 tests (vitest)
```

## Development

```bash
# Run tests
npm test

# Build all workspaces
npm run build

# Watch mode
npm run test:watch
```

### Dev workflow (after making changes)

The MCP server runs from a **cache copy**, not from the source directory. After editing source:

```bash
# 1. Build
cd ~/.claude/plugins/tmup && npm run build

# 2. Sync to plugin cache
bash scripts/sync-cache.sh

# 3. Restart Claude Code session
# The MCP server loads once at session start — you must restart
# to pick up code changes. There is no hot-reload.
```

Skipping step 2 means Claude runs stale code. Skipping step 3 means the old MCP server process stays in memory with the old bundle.

### Test coverage

631 tests across 24 files covering:
- Task DAG operations and dependency resolution
- Cycle detection
- Task lifecycle state machine
- Inter-agent messaging
- Dead claim recovery
- Concurrent SQLite access
- MCP tool integration
- CLI command handling
- Shell script boundary conditions
- Schema parity and migrations
- Fuzz edge cases

## FAQ

**Q: Do I need both Claude Code and Codex?**
Yes. Claude Code is the lead (orchestrator). Codex CLI workers do the actual coding in tmux panes. They're different products from different companies working together through a shared database. It's beautiful and slightly unhinged.

**Q: How many workers can I run?**
The default grid is 2x4 (8 panes). You can change this in `config/policy.yaml`. Each worker is a Codex CLI process with its own context window (up to 1M tokens with GPT-5.4). More workers = more parallelism = more SQLite contention = more fun.

**Q: What happens if a worker crashes?**
The lead detects stale claims via heartbeat timeouts and can reassign the work. Retriable failures (crash, timeout) auto-retry with exponential backoff. Non-retriable failures (logic errors) escalate to `needs_review` for the lead to handle.

**Q: Can I use this without tmux?**
No. tmux is the grid. Without it, where would the agents live? In your heart? That's not how computers work.

**Q: Is this production ready?**
It works. It has 621 tests. It handles concurrent database access, dead workers, dependency cascades, and retry backoff. Whether you should deploy this to manage your production infrastructure is a question for your therapist, not your tech lead.

**Q: Why SQLite and not Redis/Postgres/a real database?**
Because SQLite WAL mode gives you concurrent read/write from a single file with zero infrastructure. No server. No connection strings. No Docker compose. Just a `.db` file that 9 AI agents share like a family dinner table. WAL mode means readers never block writers and writers never block readers. It's perfect for this use case.

**Q: Why is it called tmup?**
**t**mux + tea**m** **up** = **tmup**. It's a team-up. In tmux. Get it? Get it?

## License

[MIT](LICENSE)

## Credits

Built with unreasonable enthusiasm by [@LucasQuiles](https://github.com/LucasQuiles).

Powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex).
