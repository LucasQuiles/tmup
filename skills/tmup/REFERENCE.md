---
name: tmup-reference
description: Complete reference for all 19 MCP tools and 9 CLI commands
---

# tmup Reference

## MCP Tools

All workers are interactive Codex sessions in tmux panes. Use `tmup_dispatch` to start sessions, `tmup_reprompt` to send follow-up text into them, `tmup_harvest` to observe. Never use `codex exec` or Bash to drive panes.

## Supervisor Loop

- Treat each pane as a persistent worker lane, not a disposable process.
- Use `tmup_dispatch` for fresh or resumed sessions only.
- Use `tmup_harvest` to inspect current progress before changing course.
- Use `tmup_reprompt` to continue or redirect an existing lane when it already has relevant context.
- Prefer reprompting over respawning when a live pane is still the right worker.

## Fresh Worker Runtime

Fresh tmup workers launch with `gpt-5.4`, `model_context_window=1050000`, `model_auto_compact_token_limit=750000`, `model_reasoning_effort=high`, `model_reasoning_summary=low`, `plan_mode_reasoning_effort=xhigh`, `model_verbosity=low`, `service_tier=fast`, `tool_output_token_limit=50000`, `web_search=live`, `history.persistence=save-all`, `features.undo=true`, `shell_environment_policy.inherit=all`, `features.shell_snapshot=true`, `features.enable_request_compression=true`, `tui.notifications=true`, `background_terminal_max_timeout=600000`, autonomous shell execution, inline-mode scrollback, and Codex subagent caps of `max_threads=6`, `max_depth=2`, and `job_max_runtime_seconds=3600`. Planning-first behavior is supplied in the initial prompt rather than via an undocumented CLI startup flag.

Tiered subagent pack:

- `tmup-tier1` in `~/.codex/agents/tmup-tier1.toml` — `gpt-5.3-codex`
- `tmup-tier2` in `~/.codex/agents/tmup-tier2.toml` — `gpt-5.2-codex`
- `grid-setup.sh` syncs these files from plugin-local `agents/codex/` before returning success, including on existing-grid reattach paths

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
Registers agent, claims task, and launches an interactive Codex session in a pane. The session persists until the codex process exits. Follow-up communication goes through `tmup_reprompt`, not by running additional commands in the pane.
```json
{"task_id": "003", "role": "implementer",
 "pane_index?": 2, "working_dir?": "/path", "resume_session_id?": "codex-session-abc"}
→ {"ok": true, "agent_id": "uuid", "pane_index": 2, "launched": true,
   "session_mode": "interactive", "follow_up_via": "tmup_reprompt",
   "launch_output": "Dispatched implementer to pane 2 (agent uuid)"}
```

With `resume_session_id`, uses `codex resume <ID>` instead of fresh launch while reapplying the same model, context, compaction, approval, sandbox, and subagent-cap flags.

### tmup_harvest
```json
{"pane_index": 3, "lines?": 200}
→ {"ok": true, "pane_index": 3, "lines": 200, "output": "...captured scrollback...",
   "codex_session_id?": "abc123", "resume_command?": "codex resume abc123"}
```

### tmup_reprompt
Send follow-up text to a running interactive session via `tmux send-keys -l` (literal mode). This is the only way to send text into the worker's interactive pane. Structured inter-agent messaging uses `tmup_send_message` separately.
```json
{"pane_index": 3, "prompt": "Now implement the error handling for edge cases",
 "harvest_first?": true, "all?": false}
→ {"ok": true, "pane_index": 3, "output": "Pane 3: sent",
   "harvested_before_reprompt": "...scrollback..."}
```

Safety guards:
- Agent must be idle or explicitly queueable ("tab to queue" visible in scrollback)
- Rejects shell prompts (pane must be hosting a Codex session, not at bare shell)
- Uses literal mode (`-l`) to prevent prompt text from triggering key events
- Text verified in scrollback before double-Enter submission

### tmup_pause / tmup_resume / tmup_teardown
```json
{} / {"session_id?": "tmup-a3f1b2"} / {"force?": true}
```

`tmup_resume` now returns `resume_commands` array with `codex resume <ID>` for each recovered task.

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
