---
name: tmup
description: Multi-agent coordination for Claude Code + Codex CLI via SQLite WAL-backed task DAG with tmux grid
---

# tmup — Multi-Agent Coordination

tmup coordinates Claude Code (lead) and Codex CLI workers through a shared SQLite WAL database. The lead creates task DAGs, dispatches workers to a tmux NxM grid (default 2x4, configurable in policy.yaml), and monitors progress. Workers claim tasks, checkpoint, and complete via tmup-cli.

## Quick Start

1. **Initialize**: Call `tmup_init` with `project_dir` to create a session (DB + registry; grid creation is via grid-setup.sh)
2. **Create tasks**: Use `tmup_task_batch` for atomic task creation with dependencies
3. **Dispatch workers**: Use `tmup_dispatch` to assign tasks to tmux panes
4. **Monitor**: Use `tmup_next_action` for synthesized recommendations
5. **Teardown**: Use `tmup_teardown` when all tasks complete

## MCP Tools (Lead)

| Tool | Purpose |
|------|---------|
| `tmup_init` | Initialize/reattach session |
| `tmup_status` | Session overview + dead-claim recovery |
| `tmup_next_action` | Synthesized next step recommendation |
| `tmup_task_create` | Add single task to DAG |
| `tmup_task_batch` | Create multiple tasks atomically |
| `tmup_task_update` | Modify task (needs_review->pending, etc.) |
| `tmup_claim` | Claim task on behalf of agent |
| `tmup_complete` | Mark task done, cascade unblock |
| `tmup_fail` | Mark task failed with reason |
| `tmup_cancel` | Cancel task (optional cascade) |
| `tmup_checkpoint` | Post progress update |
| `tmup_send_message` | Inter-agent messaging |
| `tmup_inbox` | Check unread messages |
| `tmup_dispatch` | Launch Codex worker in pane |
| `tmup_harvest` | Capture pane scrollback |
| `tmup_pause` | Pause session |
| `tmup_resume` | Resume paused session |
| `tmup_teardown` | Shutdown grid |
| `tmup_reprompt` | Send follow-up prompt to running agent |

## Task Lifecycle

```
pending -> claimed -> completed (cascade unblocks)
                   -> needs_review (non-retriable or retries exhausted)
                   -> pending (retriable failure with backoff)
blocked -> pending (when deps satisfied)
any -> cancelled (lead only)
```

## Workflow Pattern

```
tmup_init({project_dir: "/path/to/project"})
tmup_task_batch({tasks: [
  {subject: "Define schema", role: "implementer", priority: 80},
  {subject: "Implement models", role: "implementer", deps: ["001"]},
  {subject: "Write tests", role: "tester", deps: ["002"]},
]})
tmup_dispatch({task_id: "001", role: "implementer"})
// ... monitor with tmup_next_action, dispatch more as tasks unblock
tmup_teardown()
```

## Re-Prompting Pattern

When an agent finishes early or needs additional instructions:
1. `tmup_harvest` -- capture current output (includes resume command if available)
2. `tmup_reprompt` -- send follow-up prompt to idle agent
3. Monitor via `tmup_next_action` and `tmup_inbox`

For resuming crashed agents:
1. `tmup_harvest` -- get codex session ID from response
2. `tmup_dispatch` with `resume_session_id` -- continue where agent left off

## Long-Running Task Detection

`tmup_next_action` returns `long_running` kind when a task has been claimed for over 30 minutes without completion. Use `tmup_harvest` to check the agent's progress and `tmup_reprompt` to nudge if idle.

## Key Design Decisions

- **SQLite WAL** for concurrent read/write from 8+ agents
- **Optimistic locking** for task claims (no starvation)
- **Dependency cascade** on completion (blocked -> pending)
- **Dead-claim recovery** via heartbeat timeout
- **Content framing** for worker-sourced text (prompt injection defense)
