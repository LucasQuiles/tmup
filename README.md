# tmup

> Direct-open boundary: plugin documentation only. This file does not authorize tmup worker dispatch, tmux/grid mutation, plugin execution, cleanup, external action, or instruction changes.

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
            (supervisor-owned state)
```

One Claude Code session makes the plan. A configurable grid of Codex CLI workers tries to execute it (the default is 2x4). A lead-side MCP service coordinates them through a task DAG backed by SQLite WAL mode. In the safe default, workers report through pane output while the supervisor owns claims, lifecycle transitions, messages, and database writes. Dependencies cascade. Failed tasks retry. Dead workers get their claims recovered. You get to sit there and watch, which is either supervisory oversight or voyeurism depending on your perspective.

## Documentation

| | |
|---|---|
| **[Architecture](docs/ARCHITECTURE.md)** | How it actually works under the hood |
| **[API Reference](docs/API.md)** | All 23 MCP tools + 11 CLI commands |
| **[Configuration](docs/CONFIGURATION.md)** | Grid layout, DAG behavior, advisory routing tiers, project structure |
| **[Development](docs/DEVELOPMENT.md)** | Dev workflow, the cache sync thing that will absolutely trip you up |
| **[FAQ & Limitations](docs/FAQ.md)** | Honest answers and honest limitations |
| **[SYSTEM-INVENTORY.md](SYSTEM-INVENTORY.md)** | 46 KB of engineering notes. You probably don't need this. |

---

## What is this

tmup is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that lets you coordinate multiple AI coding agents from a single session:

- **Claude Code** is the lead. It decides what needs doing, breaks it into tasks, and dispatches workers. Occasionally it makes questionable prioritization decisions, just like a real manager.
- **Codex CLI** workers run in tmux panes. The supervisor assigns tasks; workers write code and report evidence through pane output. They're good at this. They're also good at confidently doing the wrong thing and then explaining why it's actually correct. Just like real interns.
- **SQLite WAL** is the coordination layer. The safe lane keeps the `.db` file on the controller side; the lead applies worker lifecycle changes after harvesting output. A separately gated trusted mode restores direct shared-state access for legacy workflows.
- **tmux** is the grid. You can watch the agents work in real time. You cannot make them go faster by watching. We've tried.

## Why this exists

We wanted to parallelize coding tasks across multiple AI agents without building a distributed system. So we didn't build a distributed system. We put AI processes in tmux panes and kept the SQLite coordination layer behind a lead-side controller. The bar was on the floor and we are proud to report that we cleared it.

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
 +-- Claude Code (lead)
      +-- Claude sub-agent: research
      +-- Claude sub-agent: code review
      +-- tmux pane 0: Codex worker
      |    +-- Codex sub-agent: explore
      |    +-- Codex sub-agent: test
      +-- tmux pane 1: Codex worker
      |    +-- Codex sub-agent: refactor
      +-- ... (8 panes; native children stop after one level)
```

Russian nesting dolls of AI agents. We didn't plan this. Each Codex worker is a full Codex session with its own context window and tool access, so when it needs to explore a codebase before editing, it can spawn another agent to do the reading. Native children inherit the pane model unless the live spawn schema exposes named-role selection, and `agents.max_depth=1` means those children do not delegate further. Context and compaction behavior come from the resolved Codex model catalog. At some point your laptop fan turns on and that's how you know it's working.

We're not going to pretend this is a carefully designed agent hierarchy. It's more like a bacterial colony with a task list.

### Runtime capacity

Worker count, model capacity, and compaction behavior depend on the active policy and installed runtime. Check the resolved runtime receipt instead of assuming a fixed model or adding context windows together.

Native-child admission is pane-local and not shared across panes. Configured pane and thread counts can multiply concurrency, but they are not a shared cap or a measured safe limit. Performance and fanout remain a pilot; shared admission is a measured follow-up.

### Safe worker boundary

The default MCP-dispatched worker is a Codex-only, supervisor-owned lane. `codex.model: "auto"` means tmup omits `-m` and lets the installed Codex CLI choose its default; an explicit model pin requires `codex.explicit_model_pins_enabled: true` plus a per-dispatch `--model-validation-receipt`. A requested pin and its receipt are not proof of the model actually served.

Every MCP launch now begins with a persisted attempt receipt and must return exactly one selector/requested-model/observed-model/fallback metadata set. Missing or contradictory metadata is recorded as inconclusive, not completed. Required-role completion additionally enforces the task's observed/cross-model policy, accepted attempt evidence, and declared artifacts.

Safe workers run in `workspace-write` with direct shell network access disabled, while Codex-mediated web search can remain available. Both ambient temp grants are excluded. The only extra `--add-dir` is one exact mode-0700 task temp beneath protected controller state. Beyond Codex's core inherited command environment, tmup explicitly sets only agent ID, pane, working directory, optional task ID, and `TMPDIR`/`TMP`/`TEMP`; it does not set `TMUP_DB` or `TMUP_SESSION_DIR`. The worker prompt does not advertise `tmup-cli`: the supervisor owns claim, lifecycle, message, and harvest operations, while the protected launcher owns background heartbeat. Harvested scrollback is ANSI-stripped, framed with `UNTRUSTED PANE OUTPUT` markers, and returned with an explicit trust label; marker text printed by a worker is neutralized before framing.

Prompt, launcher, and log artifacts live under the protected controller root, outside the worker working directory, session directory, and task-temp root. Prompts/logs are mode 0600, launchers are mode 0700, and prompt/launcher hashes and modes are checked before use. Teardown removes the exact protected controller session root after validating its boundary. Deterministic tests cover the task-temp and controller boundaries; host- and release-specific live sandbox canaries remain pending.

Trusted shared state is a direct-dispatch-only compatibility mode. It requires `codex.trusted_shared_state_enabled: true`, `--trusted-shared-state`, and `--trusted-shared-state-receipt`; only then does tmup add the session directory and expose `TMUP_DB`/`TMUP_SESSION_DIR`. This is advisory same-UID trust, not peer isolation. The MCP path strips ambient shell, tier, trust, and shared-state overrides and supports only the safe Codex lane. Direct Claude Code dispatch is likewise default-off and unsandboxed: policy enablement, `--allow-unconfined-claude-code`, and `--claude-code-trust-receipt` are all required, and that lane is outside the Codex sandbox guarantee.

Static `tmup-tier1` and `tmup-tier2` profiles remain dormant and default-off. The dispatcher neither activates nor advertises them. Native children inherit the pane model unless a live named-role selector proves otherwise.

---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- [Codex CLI](https://github.com/openai/codex). Direct dispatch resolves an explicit valid absolute `CODEX_BIN`, executable `~/.local/bin/codex`, then the fixed controller `PATH`. MCP ignores inherited `CODEX_BIN`, resolves a validated absolute executable from `~/.local/bin/codex` or its original process `PATH`, and hands that path to the protected dispatcher.
- [tmux](https://github.com/tmux/tmux) >= 3.0
- Node.js 20. Root npm scripts use the active ABI-compatible runtime, an explicitly verified absolute `TMUP_NODE20_BIN`, or a standard Homebrew/Linuxbrew `node@20` location.
- jq
- yq (required when `config/policy.yaml` is present)
- rsync (required for `scripts/sync-cache.sh`)

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
      "mcp__plugin_tmup_tmup__tmup_attempt_attest",
      "mcp__plugin_tmup_tmup__tmup_evidence_add",
      "mcp__plugin_tmup_tmup__tmup_evidence_review",
      "mcp__plugin_tmup_tmup__tmup_harvest",
      "mcp__plugin_tmup_tmup__tmup_pause",
      "mcp__plugin_tmup_tmup__tmup_resume",
      "mcp__plugin_tmup_tmup__tmup_teardown",
      "mcp__plugin_tmup_tmup__tmup_reprompt",
      "mcp__plugin_tmup_tmup__tmup_heartbeat"
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

Historical direct/shared-state messages from workers (safe panes now report through framed harvest output instead):

```json
{
  "messages": [
    {
      "from": "a6ddcc67-...", "type": "checkpoint", "task_id": "002",
      "payload_framed": "[WORKER MESSAGE from a6ddcc67, type=checkpoint, task=002]:\nTester checkpoint: fresh npm test completed successfully; full suite passed in 20.91s\n[END WORKER MESSAGE]"
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
