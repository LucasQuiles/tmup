---
name: tmup
description: Multi-agent coordination via task DAG + tmux grid
allowed-tools:
  - mcp__tmup__tmup_init
  - mcp__tmup__tmup_status
  - mcp__tmup__tmup_next_action
  - mcp__tmup__tmup_task_create
  - mcp__tmup__tmup_task_batch
  - mcp__tmup__tmup_task_update
  - mcp__tmup__tmup_claim
  - mcp__tmup__tmup_complete
  - mcp__tmup__tmup_fail
  - mcp__tmup__tmup_cancel
  - mcp__tmup__tmup_checkpoint
  - mcp__tmup__tmup_send_message
  - mcp__tmup__tmup_inbox
  - mcp__tmup__tmup_dispatch
  - mcp__tmup__tmup_harvest
  - mcp__tmup__tmup_pause
  - mcp__tmup__tmup_resume
  - mcp__tmup__tmup_teardown
  - mcp__tmup__tmup_reprompt
  - mcp__plugin_tmup_tmup__tmup_init
  - mcp__plugin_tmup_tmup__tmup_status
  - mcp__plugin_tmup_tmup__tmup_next_action
  - mcp__plugin_tmup_tmup__tmup_task_create
  - mcp__plugin_tmup_tmup__tmup_task_batch
  - mcp__plugin_tmup_tmup__tmup_task_update
  - mcp__plugin_tmup_tmup__tmup_claim
  - mcp__plugin_tmup_tmup__tmup_complete
  - mcp__plugin_tmup_tmup__tmup_fail
  - mcp__plugin_tmup_tmup__tmup_cancel
  - mcp__plugin_tmup_tmup__tmup_checkpoint
  - mcp__plugin_tmup_tmup__tmup_send_message
  - mcp__plugin_tmup_tmup__tmup_inbox
  - mcp__plugin_tmup_tmup__tmup_dispatch
  - mcp__plugin_tmup_tmup__tmup_harvest
  - mcp__plugin_tmup_tmup__tmup_pause
  - mcp__plugin_tmup_tmup__tmup_resume
  - mcp__plugin_tmup_tmup__tmup_teardown
  - mcp__plugin_tmup_tmup__tmup_reprompt
---

# /tmup — Multi-Agent Coordination

Use this command to coordinate Codex CLI workers across a tmux NxM grid (default 2x4, configurable in policy.yaml).

## Usage

`/tmup` — Check status or initialize a new session
`/tmup init` — Initialize a new tmup session for the current project
`/tmup status` — Show DAG status summary
`/tmup next` — Get next recommended action
`/tmup teardown` — Shut down the session

## Workflow

1. Initialize: `tmup_init` with the project directory
2. Plan: Create tasks with dependencies using `tmup_task_batch`
3. Execute: Dispatch workers with `tmup_dispatch`
4. Monitor: Use `tmup_next_action` and `tmup_inbox` in a loop
5. Complete: `tmup_teardown` when done

## Session Model

Workers are interactive Codex sessions in tmux panes. Use `tmup_dispatch` to start them, `tmup_reprompt` to send follow-up instructions. Never use `codex exec` or Bash to drive worker panes.

## Grid Supervision

- Treat each pane as a long-lived external subagent lane that you supervise directly.
- Keep one clear objective per lane. Do not mix unrelated workstreams into the same pane.
- Dispatch once for a fresh lane, then prefer `tmup_harvest` + `tmup_reprompt` over redispatch when the pane already holds relevant context.
- Do not retire or respawn a pane just to send new instructions if the existing worker is still the right lane.
- Harvest, evaluate, and reprompt as a loop. `tmup_harvest` is observational; `tmup_reprompt` is the control path.

## tmux Input Model

- `tmup_reprompt` sends literal text into the live worker session with `tmux send-keys -l`, verifies the text appeared, then submits it.
- Queueable workers are valid reprompt targets when the pane indicates queued input is allowed.
- Do not type shell commands into worker panes to continue the session. Use tmup tools only.

## Fresh Worker Runtime

- Fresh tmup workers launch on `gpt-5.4`.
- tmup also requests the GPT-5.4 1M Codex context window through `model_context_window=1050000`.
- tmup sets `model_auto_compact_token_limit=750000` to compact well before context quality degrades.
- tmup pins worker reasoning and output controls with `model_reasoning_effort=high`, `model_reasoning_summary=low`, `plan_mode_reasoning_effort=xhigh`, and `model_verbosity=low`.
- tmup enables `service_tier=fast`, `tool_output_token_limit=50000`, and `web_search=live` for higher-throughput interactive lanes.
- tmup preserves resumability and operator ergonomics with `history.persistence=save-all`, `features.undo=true`, `shell_environment_policy.inherit=all`, `features.shell_snapshot=true`, `features.enable_request_compression=true`, `tui.notifications=true`, and `background_terminal_max_timeout=600000`.
- tmup configures worker lanes for interactive Codex use with autonomous execution and inline scrollback-friendly mode.
- Planning-first behavior is enforced by the initial worker prompt. tmup does not rely on an undocumented Codex startup flag for this.
- Fresh lanes also set Codex subagent caps (`agents.max_threads=6`, `agents.max_depth=2`, `agents.job_max_runtime_seconds=3600`) so each pane can use internal teams when appropriate.
- `grid-setup.sh` syncs the named tiered agents into `~/.codex/agents/`: `tmup-tier1` on `gpt-5.3-codex`, then `tmup-tier2` on `gpt-5.2-codex`.

## Task DAG

Tasks form a directed acyclic graph. Dependencies are resolved automatically:
- When a task completes, blocked dependents are unblocked
- Cycle detection prevents invalid dependency chains
- Failed tasks auto-retry (crash/timeout) or escalate (logic errors)

## Roles

| Role | Autonomy | Messaging |
|------|----------|-----------|
| implementer | checkpoint | lead only |
| tester | checkpoint | lead only |
| reviewer | full | any agent |
| refactorer | checkpoint | lead only |
| documenter | checkpoint | lead only |
| investigator | full | any agent |
