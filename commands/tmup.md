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
