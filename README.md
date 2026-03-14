# tmup

**tmux + team up = tmup**

Claude Code and Codex CLI, duct-taped together with bash scripts and a SQLite database, arranged in a tmux grid so you can watch them all work at the same time. It's like a group project where everyone is an AI and nobody is slacking because they literally can't.

```
  Claude Code (lead)         tmux 2x4 grid
  +----------------+     +----+----+----+----+
  | "I'll break    |---->| C1 | C2 | C3 | C4 |  Codex workers
  |  this into     |     +----+----+----+----+  (8 panes)
  |  8 tasks"      |     | C5 | C6 | C7 | C8 |
  +-------+--------+     +----+----+----+----+
          |                    |
          +------ SQLite WAL --+
               (shared brain)
```

One Claude Code session makes the plan. Up to 8 Codex CLI workers try to execute it. They coordinate through a task DAG backed by SQLite WAL mode, which is a fancy way of saying they all read and write to the same file on disk and somehow this doesn't end in tears. Dependencies cascade. Failed tasks retry. Dead workers get their claims recovered. You get to sit there and watch, which is either supervisory oversight or voyeurism depending on your perspective.

## Documentation

| | |
|---|---|
| **[Architecture](docs/ARCHITECTURE.md)** | How it actually works under the hood |
| **[API Reference](docs/API.md)** | All 18 MCP tools + 9 CLI commands |
| **[Configuration](docs/CONFIGURATION.md)** | Grid layout, DAG behavior, autonomy tiers, project structure |
| **[Development](docs/DEVELOPMENT.md)** | Dev workflow, the cache sync thing that will absolutely trip you up |
| **[FAQ & Limitations](docs/FAQ.md)** | Honest answers and honest limitations |
| **[SYSTEM-INVENTORY.md](SYSTEM-INVENTORY.md)** | 46 KB of engineering notes. You probably don't need this. |

---

## What is this

tmup is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that lets you coordinate multiple AI coding agents from a single session:

- **Claude Code** is the lead. It decides what needs doing, breaks it into tasks, and dispatches workers. Occasionally it makes questionable prioritization decisions, just like a real manager.
- **Codex CLI** workers run in tmux panes. They claim tasks, write code, and report back. They're good at this. They're also good at confidently doing the wrong thing and then explaining why it's actually correct. Just like real interns.
- **SQLite WAL** is the coordination layer. Every agent reads and writes to the same `.db` file. This should not work as well as it does. We have stopped asking why.
- **tmux** is the grid. You can watch the agents work in real time. You cannot make them go faster by watching. We've tried.

## Why this exists

We wanted to parallelize coding tasks across multiple AI agents without building a distributed system. So we didn't build a distributed system. We just put a bunch of AI processes in tmux panes and gave them a SQLite file to share. The bar was on the floor and we are proud to report that we cleared it.

tmup exists because:

1. **Claude Code works alone.** One session. One thread. It can do a lot, but it can only do one thing at a time.
2. **Codex CLI also works alone.** It has no idea what anyone else is doing. It's just a process in a terminal.
3. **tmux can hold multiple terminals.** This is not a breakthrough in computer science. tmux has been doing this since 2007.
4. **SQLite can be shared.** WAL mode lets multiple processes read and write to the same file. This is also not a breakthrough. SQLite has been doing this since 2010.

We connected these four things with bash scripts. That's the whole innovation. The fact that the result is genuinely useful is a surprise to everyone, including us.

### It's agents all the way down

Here's where it gets silly. Claude Code can spawn **sub-agents** for research, code review, exploration. Codex can also spawn sub-agents within its own sessions. So the actual topology looks something like:

```
You (human, allegedly in charge)
 +-- Claude Code (lead, up to 1M context)
      +-- Claude sub-agent: research
      +-- Claude sub-agent: code review
      +-- tmux pane 0: Codex worker
      |    +-- Codex sub-agent: explore
      |    +-- Codex sub-agent: test
      +-- tmux pane 1: Codex worker
      |    +-- Codex sub-agent: refactor
      +-- ... (8 panes, each potentially nesting more)
```

Russian nesting dolls of AI agents. We didn't plan this. Each Codex worker is a full Codex session with its own context window and tool access, so when it needs to explore a codebase before editing, it just... spawns another agent to do the reading. The workers delegate. The delegates might delegate. At some point your laptop fan turns on and that's how you know it's working.

We're not going to pretend this is a carefully designed agent hierarchy. It's more like a bacterial colony with a task list.

### The numbers

Context windows vary by model. Here's what you might end up with:

| Configuration | Lead | Workers (x8) | Combined |
|--------------|------|-------------|----------|
| Opus 4.6 (1M) + GPT-5.4 (1M) | 1M | 8M | **9M tokens** |
| Sonnet 4.6 (200K) + GPT-4.1 (200K) | 200K | 1.6M | **1.8M tokens** |
| Opus 4.6 (1M) + GPT-4.1 (200K) | 1M | 1.6M | **2.6M tokens** |

That's a lot of context. Whether any of it is being used well is a separate question that we are choosing not to investigate.

---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- [Codex CLI](https://github.com/openai/codex) (`~/.local/bin/codex` or in PATH)
- [tmux](https://github.com/tmux/tmux) >= 3.0
- Node.js >= 20
- jq

## Installation

```bash
git clone https://github.com/LucasQuiles/tmup.git ~/.claude/plugins/tmup
cd ~/.claude/plugins/tmup
npm install && npm run build
claude plugin install tmup@tmup-dev
```

<details>
<summary>Manual registration (if <code>plugin install</code> doesn't work)</summary>

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

Then restart Claude Code. Yes, you have to restart. No, there is no hot-reload.

</details>

<details>
<summary>Permissions for <code>dontAsk</code> mode</summary>

If you run Claude Code with `defaultMode: "dontAsk"`, the tmup MCP tools need explicit permission. The `mcp__*` wildcard does **not** override an explicit allow list in `settings.local.json`. We learned this the hard way. Add to `~/.claude/settings.local.json`:

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

Restart Claude Code after updating.

</details>

---

## Quick start

Inside a Claude Code session:

```
> /tmup
```

Claude will set up a session, create a tmux grid, ask what you want done, build a task DAG, and start dispatching workers. Sometimes this goes smoothly. Sometimes a worker gets confused and reviews the wrong file. It's a process.

### What it looks like

Empty grid after setup -- 8 panes, nothing happening yet:

![Empty tmup grid -- 8 panes ready for dispatch](docs/images/grid-empty.png)

Same grid a few minutes later with 8 Codex workers doing things. Whether they're doing the *right* things is for the lead to figure out:

![Full tmup grid -- 8 Codex workers running in parallel](docs/images/grid-full.png)

### What the backend looks like

Real output from a tmup session where we used tmup to review tmup (yes, really):

```json
{
  "ok": true,
  "tasks": [
    {
      "id": "001", "subject": "Review README.md for accuracy",
      "role": "reviewer", "status": "completed",
      "result_summary": "changes-requested: README has 5 accuracy issues covering the events --type flag, CLI error exit semantics, schema source-of-truth wording, test DB wording, and terminal auto-launch behavior.",
      "completed_at": "2026-03-14T09:45:11.550Z"
    },
    {
      "id": "005", "subject": "Deep audit using sub-agents for parallel exploration",
      "role": "investigator", "status": "claimed",
      "result_summary": "Launched two nested Codex sub-agents: one auditing task lifecycle and dependency resolution, one auditing session and agent operations."
    }
  ],
  "agents": [
    {"id": "549cefe9-...", "pane_index": 4, "role": "investigator", "status": "active"},
    {"id": "4b7a2219-...", "pane_index": 5, "role": "tester", "status": "active"},
    {"id": "3521112a-...", "pane_index": 6, "role": "documenter", "status": "active"}
  ],
  "unread": 18
}
```

Real messages from workers:

```json
{
  "messages": [
    {
      "from": "a6ddcc67-...", "type": "checkpoint", "task_id": "002",
      "payload_framed": "[WORKER MESSAGE from a6ddcc67, type=checkpoint, task=002]:\nTester checkpoint: fresh npm test completed successfully with 24/24 files and 631/631 tests passing in 20.91s\n[END WORKER MESSAGE]"
    },
    {
      "from": "e1c5dc3e-...", "type": "finding",
      "payload_framed": "[WORKER MESSAGE from e1c5dc3e, type=finding]:\nDispatch-path finding: mcp-server marks the agent shutdown on launch failure, but dead-claim recovery only scans status='active'. The task remains claimed by the shutdown agent, so the current cleanup does not actually make the task recoverable.\n[END WORKER MESSAGE]"
    },
    {
      "from": "549cefe9-...", "type": "checkpoint", "task_id": "005",
      "payload_framed": "[WORKER MESSAGE from 549cefe9, type=checkpoint, task=005]:\nLaunched two nested Codex sub-agents: one auditing task lifecycle and dependency resolution, one auditing session and agent operations.\n[END WORKER MESSAGE]"
    }
  ]
}
```

That last message is a Codex worker spawning its own sub-agents to parallelize work. We didn't tell it to do that. It just did. We're choosing to interpret this as a feature.

---

## License

[MIT](LICENSE).

## Credits

Built by [@LucasQuiles](https://github.com/LucasQuiles) and a fluctuating number of AI agents, at least some of whom were, at one point, deployed to review the very system that deployed them. They found bugs. They did not find this concerning. We did.

Powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex).
