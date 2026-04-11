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

## Interactive Session Model

tmup workers are long-lived interactive Codex sessions inside existing tmux panes. They are NOT one-shot `codex exec` commands.

Before dispatch, a pane is just a shell. After dispatch, the pane hosts a live Codex session until that process exits.

| Tool | What it does | Underlying mechanism |
|------|-------------|---------------------|
| `tmup_dispatch` | Start or resume an interactive Codex session in a pane | Sends a launcher script into an existing pane via `tmux send-keys`; the launcher starts or resumes codex as a foreground process |
| `tmup_reprompt` | Send follow-up text into that existing session | `tmux send-keys -l` (literal mode) with guards: agent must be idle or explicitly queueable ("tab to queue" visible), pane must not be at shell prompt, text verified in scrollback before double-Enter submission |
| `tmup_harvest` | Read pane scrollback — observation only | `tmux capture-pane`; returns codex_session_id and resume_command if available |

### Anti-Patterns

- Do NOT run `codex exec "prompt"` via Bash — workers are interactive, not one-shot
- Do NOT type shell commands directly into worker panes
- Do NOT treat each prompt as a fresh codex process
- Do NOT use Bash tool to drive pane content
- Do NOT use `tmup_harvest` as the primary way to communicate with workers — harvest is observational, not conversational

### Correct Patterns

- `tmup_dispatch` once per worker to start or resume that worker's interactive session
- `tmup_reprompt` to continue, redirect, or nudge an existing idle or queueable session
- `tmup_harvest` to inspect pane state or recover a session ID
- `tmup_dispatch` with `resume_session_id` to relaunch a crashed worker into a resumed Codex session

## Grid Supervisor Discipline

Treat each tmux pane as a long-lived external subagent lane.

- Manage pane workers the way you would manage your own subagents: clear objective, scoped context, ongoing supervision, explicit completion.
- Keep objectives clean per lane. Do not pile unrelated workstreams into a single pane just because it is free.
- Run a harvest-evaluate-reprompt loop:
  1. `tmup_harvest` to inspect current state
  2. Evaluate whether the worker is blocked, drifting, done, or ready for the next chunk
  3. `tmup_reprompt` to redirect, sharpen, or continue the same lane
- Prefer reprompting an existing pane over dispatching a fresh worker when that pane already contains relevant context.
- Only redispatch when the pane is back at a shell prompt, the worker crashed, or the context in that lane is genuinely wrong for the task.

## tmux Input Model

`tmup_reprompt` is the interaction primitive for live worker panes. It already applies the important tmux mechanics that ad-hoc Bash should not replace:

- literal input with `tmux send-keys -l`
- guardrails for shell prompts vs active worker sessions
- support for idle or explicitly queueable workers
- scrollback verification before submission
- Enter-based submission handled by tmup, not by handwritten shell tricks

This is the tmup equivalent of the `/using-tmux-for-interactive-commands` pattern: treat the pane as a real interactive terminal and drive it through tmux primitives, not through `codex exec` or shell pipes.

## Fresh Worker Runtime

Fresh tmup workers currently launch with:

- `--model gpt-5.4`
- `-c model_context_window=1050000`
- `-c model_auto_compact_token_limit=750000`
- `-a never`
- `-s danger-full-access`
- `--no-alt-screen`
- `-c model_reasoning_effort=high`
- `-c model_reasoning_summary=low`
- `-c plan_mode_reasoning_effort=xhigh`
- `-c model_verbosity=low`
- `-c service_tier=fast`
- `-c tool_output_token_limit=50000`
- `-c web_search=live`
- `-c history.persistence=save-all`
- `-c features.undo=true`
- `-c shell_environment_policy.inherit=all`
- `-c features.shell_snapshot=true`
- `-c features.enable_request_compression=true`
- `-c tui.notifications=true`
- `-c background_terminal_max_timeout=600000`
- `-c agents.max_threads=6`
- `-c agents.max_depth=2`
- `-c agents.job_max_runtime_seconds=3600`

Tiered subagent pack:

- `tmup-tier1` — `gpt-5.3-codex`, high reasoning, first-tier helper
- `tmup-tier2` — `gpt-5.2-codex`, medium reasoning, narrow leaf helper
- `grid-setup.sh` syncs these TOMLs from `agents/codex/` into `~/.codex/agents/`

The planning-first behavior is carried by the initial prompt. tmup does not depend on an undocumented CLI startup flag for plan mode.

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
2. `tmup_reprompt` -- send follow-up prompt to idle or queueable agent
3. Monitor via `tmup_next_action` and `tmup_inbox`

For resuming crashed agents:
1. `tmup_harvest` -- get codex session ID from response
2. `tmup_dispatch` with `resume_session_id` -- continue where agent left off

## Long-Running Task Detection

`tmup_next_action` returns `long_running` kind when a task has been claimed for over 30 minutes without completion. Use `tmup_harvest` to check the agent's progress and `tmup_reprompt` to nudge if idle or queueable.

## Key Design Decisions

- **SQLite WAL** for concurrent read/write from 8+ agents
- **Optimistic locking** for task claims (no starvation)
- **Dependency cascade** on completion (blocked -> pending)
- **Dead-claim recovery** via heartbeat timeout
- **Content framing** for worker-sourced text (prompt injection defense)
