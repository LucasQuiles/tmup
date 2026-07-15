[< Back to README](../README.md)

# API Reference

## MCP tools (20)

These are the tools Claude Code uses to orchestrate. They're exposed via the MCP server and Claude calls them like any other tool.

### Session management

| Tool | What it does | The vibe |
|------|-------------|----------|
| `tmup_init` | Initialize session (DB + registry; grid setup is separate) | Opening the office |
| `tmup_status` | DAG overview + dead claim recovery | Morning standup, but useful |
| `tmup_next_action` | "What should I do next?" decision tree | The one coworker who always knows |
| `tmup_pause` | Record pause event/messages; safe-pane delivery uses reprompt | Fire alarm logbook |
| `tmup_resume` | Resume paused session | False alarm, back to work |
| `tmup_teardown` | Record teardown event/messages; grid shutdown is separate | Closing checklist |

### Task management

| Tool | What it does | The vibe |
|------|-------------|----------|
| `tmup_task_create` | Add one task to the DAG | Sticky note on the board |
| `tmup_task_batch` | Add multiple tasks atomically with deps | The whole sprint plan at once |
| `tmup_task_update` | Modify task status or priority | Reprioritizing mid-sprint |
| `tmup_claim` | Claim a task for an agent | "I'll take that one" |
| `tmup_complete` | Mark task done, cascade unblocks | The dopamine hit |
| `tmup_fail` | Report task failure with reason | The honesty |
| `tmup_cancel` | Cancel a task (optional cascade) | The mercy kill |

### Communication & monitoring

| Tool | What it does | The vibe |
|------|-------------|----------|
| `tmup_checkpoint` | Post progress update | "Still alive, still working" |
| `tmup_send_message` | Store coordination/audit message; safe-pane delivery uses reprompt | Slack archive for robots |
| `tmup_inbox` | Check unread messages | The anxiety |
| `tmup_dispatch` | Launch Codex worker in tmux pane | Hiring |
| `tmup_harvest` | Capture scrollback, framed and labeled as untrusted worker output | Reading over their shoulder |
| `tmup_reprompt` | Send follow-up text into a live worker pane | Manager drive-by |
| `tmup_heartbeat` | Register agent liveness | Pulse check |

For detailed input/output schemas, see [skills/tmup/REFERENCE.md](../skills/tmup/REFERENCE.md).

---

## CLI commands (10)

`tmup-cli` is the low-level controller and trusted-compatibility interface to the SQLite coordination database. Safe MCP-dispatched Codex commands do not receive `TMUP_DB` or `TMUP_SESSION_DIR`, and their prompt does not advertise this CLI. The lead uses MCP tools for claims, checkpoints, messages, completion/failure transitions, and harvesting; the protected launcher invokes the CLI heartbeat with controller-held identity.

A Codex worker may call these commands only in the separately gated trusted shared-state mode. That direct mode requires policy enablement, `--trusted-shared-state`, and `--trusted-shared-state-receipt`; it restores the session add-dir and database/session variables, so its peer-integrity boundary is advisory. Direct one-shot Claude Code workers are likewise outside the safe MCP path; their protected launcher owns heartbeat and output capture.

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
tmup-cli arc-health [--plugin-root DIR]     # ARC runtime-health readback
```

All output is JSON to stdout. Errors are `{"ok": false, "error": "CLI_ERROR", "message": "..."}` with exit code 1. System errors (missing env, DB corruption) go to stderr with exit code 2.

**Failure reasons for `fail`:** `crash`, `timeout`, `logic_error`, `artifact_missing`, `dependency_invalid`. The first two are retriable (the task goes back in the queue with backoff). The rest are non-retriable (the lead has to deal with it).

### Environment variables

The protected launcher supplies the identity needed for its controller-owned heartbeat. The full set below is exposed to worker commands only in trusted shared-state mode; safe worker commands receive agent ID, pane, working directory, optional task ID, and task-temp variables, but not the database or session paths.

| Variable | What | Example |
|----------|------|---------|
| `TMUP_AGENT_ID` | This agent's UUID | `78622b58-2429-...` |
| `TMUP_DB` | Path to shared SQLite database | `~/.local/state/tmup/.../tmup.db` |
| `TMUP_PANE_INDEX` | Which tmux pane this agent lives in | `3` |
| `TMUP_SESSION_NAME` | tmux session name | `tmup-efdfdf` |
| `TMUP_SESSION_DIR` | tmup session-state directory | `~/.local/state/tmup/tmup-efdfdf` |
| `TMUP_TASK_ID` | Pre-assigned task (if dispatched with one) | `007` |
| `TMUP_WORKING_DIR` | Project directory | `/path/to/your/project` |
