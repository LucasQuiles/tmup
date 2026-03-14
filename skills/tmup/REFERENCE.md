---
name: tmup-reference
description: Complete reference for all 18 MCP tools and 9 CLI commands
---

# tmup Reference

## MCP Tools

### tmup_init
Initializes or reattaches DB and session registry for a project directory. Does not create tmux panes (grid-setup.sh handles grid creation).
```json
{"project_dir": "/path/to/project", "session_name?": "my-session"}
→ {"ok": true, "session_id": "tmup-a3f1b2", "reattached": false}
```

### tmup_status
```json
{"verbose?": true}
→ "3 pending, 2 claimed, 5 completed. 1 unread messages."
→ (verbose) {"ok": true, "tasks": [...], "agents": [...], "unread": 1}
```

### tmup_next_action
```json
{}
→ "Task T-04 (implement auth) just unblocked — assign to implementer."
```

### tmup_task_create
```json
{"subject": "Define schema", "role?": "implementer", "priority?": 80,
 "deps?": ["001"], "requires?": ["config"], "produces?": ["schema"]}
→ {"ok": true, "task_id": "003"}
```

### tmup_task_batch
```json
{"tasks": [{"subject": "A"}, {"subject": "B", "deps": ["001"]}]}
→ {"ok": true, "task_ids": ["001", "002"]}
```

### tmup_task_update
```json
{"task_id": "005", "status?": "pending", "priority?": 90}
→ {"ok": true, "previous_status": "needs_review"}
```
Valid transitions: needs_review→pending, pending→cancelled, blocked→pending

### tmup_claim
```json
{"agent_id": "uuid", "role?": "implementer"}
→ {"ok": true, "task_id": "003", "subject": "...", "description": "..."}
```

### tmup_complete
```json
{"task_id": "003", "result_summary": "Done",
 "artifacts?": [{"name": "schema", "path": "/abs/path"}]}
→ {"ok": true, "unblocked": ["004", "005"]}
```

### tmup_fail
```json
{"task_id": "003", "reason": "crash|timeout|logic_error|artifact_missing|dependency_invalid",
 "message": "OOM at 4GB"}
→ {"ok": true, "retrying": true, "retry_after": "2026-03-12T10:05:00Z"}
```

### tmup_cancel
```json
{"task_id": "003", "cascade?": true}
→ {"ok": true, "cancelled": ["003", "004", "005"]}
```

### tmup_send_message
```json
{"to?": "agent-uuid", "type": "direct|broadcast|finding|blocker",
 "payload": "message text", "task_id?": "003"}
```

### tmup_inbox
```json
{"agent_id?": "lead", "mark_read?": true}
→ {"ok": true, "unread": 3}
→ (mark_read) {"ok": true, "messages": [...]}
```

### tmup_dispatch
```json
{"task_id": "003", "role": "implementer",
 "pane_index?": 2, "working_dir?": "/path"}
→ {"ok": true, "agent_id": "uuid", "pane_index": 2}
```

### tmup_harvest
```json
{"pane_index": 3, "lines?": 200}
→ {"ok": true, "instruction": "tmux capture-pane ..."}
```

### tmup_pause / tmup_resume / tmup_teardown
```json
{} / {"session_id?": "tmup-a3f1b2"} / {"force?": true}
```

## CLI Commands (tmup-cli)

Success output is JSON to stdout. CLI errors go to stdout as `{ok: false, error: "CLI_ERROR", message: "..."}` (exit 1). System errors go to stderr (exit 2).

Env vars: TMUP_AGENT_ID, TMUP_DB, TMUP_PANE_INDEX, TMUP_SESSION_NAME, TMUP_SESSION_DIR, TMUP_WORKING_DIR, TMUP_TASK_ID.

| Command | Usage |
|---------|-------|
| `claim` | `tmup-cli claim [--role investigator]` |
| `complete` | `tmup-cli complete "summary" [--artifact name:path]` |
| `fail` | `tmup-cli fail --reason crash "error message"` |
| `checkpoint` | `tmup-cli checkpoint "progress update"` |
| `message` | `tmup-cli message --to lead "text"` or `--broadcast` |
| `inbox` | `tmup-cli inbox [--mark-read]` |
| `heartbeat` | `tmup-cli heartbeat [--codex-session-id ID]` |
| `status` | `tmup-cli status` |
| `events` | `tmup-cli events [--limit 10] [--type session_init]` |

Exit codes: 0=tool result, 1=CLI error, 2=system error.
