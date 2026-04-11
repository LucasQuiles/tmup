[< Back to README](../README.md)

# API Reference

## MCP tools (18)

These are the tools Claude Code uses to orchestrate. They're exposed via the MCP server and Claude calls them like any other tool.

### Session management

| Tool | What it does | The vibe |
|------|-------------|----------|
| `tmup_init` | Initialize session (DB + registry + grid) | Opening the office |
| `tmup_status` | DAG overview + dead claim recovery | Morning standup, but useful |
| `tmup_next_action` | "What should I do next?" decision tree | The one coworker who always knows |
| `tmup_pause` | Pause session, notify all agents | Fire alarm (orderly) |
| `tmup_resume` | Resume paused session | False alarm, back to work |
| `tmup_teardown` | Shut everything down | Closing time |

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
| `tmup_send_message` | Inter-agent messaging | Slack but for robots |
| `tmup_inbox` | Check unread messages | The anxiety |
| `tmup_dispatch` | Launch Codex worker in tmux pane | Hiring |
| `tmup_harvest` | Capture pane scrollback output | Reading over their shoulder |

For detailed input/output schemas, see [skills/tmup/REFERENCE.md](../skills/tmup/REFERENCE.md).

---

## CLI commands (9)

These are the commands Codex workers use from inside their panes. They're exposed via `tmup-cli`, a lightweight CLI binary that talks directly to the shared SQLite database. Claude Code workers (`worker_type='claude_code'`) call the MCP `tmup_heartbeat` tool instead — the same payload via a different transport. The platform enforces a background heartbeat loop for both worker types, so the CLI/MCP call is defensive against the model ignoring its prompt, not the primary liveness signal.

Codex workers use this CLI from inside their tmux pane — it's faster than MCP (no server round-trip, just opens the DB file, writes, prints JSON, exits). Claude Code workers use the MCP tools from the enclosing Claude Code session because they have no pane shell; the dispatch-agent.sh launcher pipes the prompt via stdin and captures output to `session-output-<agent_id>.json`. Both transports write to the same SQLite database with the same schema.

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

All output is JSON to stdout. Errors are `{"ok": false, "error": "CLI_ERROR", "message": "..."}` with exit code 1. System errors (missing env, DB corruption) go to stderr with exit code 2.

**Failure reasons for `fail`:** `crash`, `timeout`, `logic_error`, `artifact_missing`, `dependency_invalid`. The first two are retriable (the task goes back in the queue with backoff). The rest are non-retriable (the lead has to deal with it).

### Environment variables

Set automatically by `dispatch-agent.sh`:

| Variable | What | Example |
|----------|------|---------|
| `TMUP_AGENT_ID` | This agent's UUID | `78622b58-2429-...` |
| `TMUP_DB` | Path to shared SQLite database | `~/.local/state/tmup/.../tmup.db` |
| `TMUP_PANE_INDEX` | Which tmux pane this agent lives in | `3` |
| `TMUP_SESSION_NAME` | tmux session name | `tmup-efdfdf` |
| `TMUP_TASK_ID` | Pre-assigned task (if dispatched with one) | `007` |
| `TMUP_WORKING_DIR` | Project directory | `/path/to/your/project` |
