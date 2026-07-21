---
name: tmup
description: Multi-agent coordination for Claude Code + Codex CLI via SQLite WAL-backed task DAG with tmux grid
---

# tmup — Multi-Agent Coordination

tmup coordinates Claude Code (lead) and Codex CLI workers with a SQLite WAL task DAG and a tmux NxM grid (default 2x4, configurable in policy.yaml). In the safe default, the lead-side MCP service owns the database, claims, lifecycle transitions, and messages. Workers do the scoped work and report evidence in pane output; the supervisor harvests that output and applies state changes.

Installed ARC binding: `<plugin-root>/.arc/arc.toml`. tmup owns task-DAG and interactive pane
coordination semantics; ARC owns the cross-runtime binding/record vocabulary. Do not assume a
machine-specific source checkout or copy the B1 ownership table into this skill.

## Quick Start

1. **Initialize state**: Call `tmup_init` with `project_dir` (DB + registry).
2. **Create panes**: From this plugin, run `/bin/bash -p scripts/grid-setup.sh --project-dir <absolute-path>`; MCP init does not create tmux panes.
3. **Create and dispatch tasks**: Use `tmup_task_batch`, then `tmup_dispatch` for ready tasks.
4. **Supervise and reconcile**: Harvest pane evidence, reprompt when needed, then call lead-side checkpoint/complete/fail for each claim.
5. **Teardown**: Reprompt and harvest final state, call `tmup_teardown` to record it, then run `/bin/bash -p scripts/grid-teardown.sh` from this plugin to stop the grid.

## Interactive Session Model

tmup workers are long-lived interactive Codex sessions inside existing tmux panes. They are NOT one-shot `codex exec` commands.

Before dispatch, a pane is just a shell. After dispatch, the pane hosts a live Codex session until that process exits.

| Tool | What it does | Underlying mechanism |
|------|-------------|---------------------|
| `tmup_dispatch` | Start or resume an interactive Codex session in a pane | Sends a launcher script into an existing pane via `tmux send-keys`; the launcher starts or resumes codex as a foreground process |
| `tmup_reprompt` | Send follow-up text into that existing session | `tmux send-keys -l` (literal mode) with guards: agent must be at a verified idle prompt, pane must not be at a shell prompt, and post-submit activity must confirm acceptance |
| `tmup_harvest` | Read pane scrollback — observation only | `tmux capture-pane`; returns codex_session_id and resume_command if available |

### Anti-Patterns

- Do NOT run `codex exec "prompt"` via Bash — workers are interactive, not one-shot
- Do NOT type shell commands directly into worker panes
- Do NOT treat each prompt as a fresh codex process
- Do NOT use Bash tool to drive pane content
- Do NOT use `tmup_harvest` as the primary way to communicate with workers — harvest is observational, not conversational

### Correct Patterns

- `tmup_dispatch` once per worker to start or resume that worker's interactive session
- `tmup_reprompt` to continue, redirect, or nudge an existing verified-idle session
- `tmup_harvest` to inspect pane state or recover a session ID
- `tmup_dispatch` with `resume_session_id` to relaunch a crashed worker into a resumed Codex session
- After harvest, attest the observed model, add/review required evidence, then use lead-side `tmup_checkpoint`, `tmup_send_message`, `tmup_complete`, or `tmup_fail` as appropriate. Safe worker prompts do not advertise `tmup-cli`.

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
- fail-closed delivery only to verified-idle workers; active-pane queueing is disabled without a pane-specific receipt
- post-submit activity verification before reporting success
- Enter-based submission handled by tmup, not by handwritten shell tricks

This is the tmup equivalent of the `/using-tmux-for-interactive-commands` pattern: treat the pane as a real interactive terminal and drive it through tmux primitives, not through `codex exec` or shell pipes.

## Fresh Worker Runtime

The MCP path supports only safe Codex workers. It rejects `claude_code` before registration or claim and strips ambient shell-inheritance, tier-activation, trust, and shared-state overrides.

Fresh safe workers currently launch with:

- With `codex.model: "auto"`, tmup omits `-m`; the installed Codex CLI resolves its default model. Context and compaction follow that runtime.
- Explicit model pins require `codex.explicit_model_pins_enabled: true` plus a direct per-dispatch `--model-validation-receipt`. A requested pin is not an observed-model claim.
- Direct dispatch accepts explicit `CODEX_BIN`, then `~/.local/bin/codex`, then the fixed controller `PATH`. MCP resolves a validated absolute executable from `~/.local/bin/codex` or the MCP process's original `PATH` before controller-path filtering.
- `-a never`
- Pane roots use `workspace-write` with `sandbox_workspace_write.network_access=false`. Direct shell network is disabled; mediated Codex web search can remain enabled.
- `-c sandbox_workspace_write.exclude_slash_tmp=true`
- `-c sandbox_workspace_write.exclude_tmpdir_env_var=true`
- `--no-alt-screen`
- `-c model_reasoning_effort=high`
- `-c model_reasoning_summary=concise`
- `-c plan_mode_reasoning_effort=xhigh`
- `-c model_verbosity=low`
- `-c service_tier=fast`
- `-c tool_output_token_limit=50000`
- `-c web_search=live`
- `-c history.persistence=save-all`
- `-c shell_environment_policy.inherit=core`
- `-c features.shell_snapshot=true`
- `-c features.enable_request_compression=true`
- `-c tui.notifications=true`
- `-c background_terminal_max_timeout=600000`
- `-c agents.max_threads=6`
- Native subagent caps include `agents.max_depth=1`.
- `-c agents.job_max_runtime_seconds=3600` applies only to `spawn_agents_on_csv` batch jobs, not arbitrary native children. Non-batch native-child lifecycle and timeout remain controller-supervised and otherwise unknown.

Beyond Codex's core inherited command environment, tmup explicitly sets only `TMUP_AGENT_ID`, `TMUP_PANE_INDEX`, `TMUP_WORKING_DIR`, optional `TMUP_TASK_ID`, and `TMPDIR`/`TMP`/`TEMP`. It does not set `TMUP_DB` or `TMUP_SESSION_DIR`. Persistent policy supports `core` or `none`; a one-command `TMUP_CODEX_SHELL_INHERIT_OVERRIDE` is direct-script-only and MCP strips it.

Shell-snapshot interaction is unproven without a release-specific live canary; command-environment filtering does not prove session-wide confidentiality.

The only extra `--add-dir` in the safe lane is one exact mode-0700 task temp under protected controller state, outside the working and tmup session roots. Prompt, launcher, and log files are also under protected controller state but outside working/session/task roots: prompts/logs use mode 0600, launchers use 0700, and prompt/launcher hashes and modes are checked before use. Teardown validates and removes only the exact controller session root.

Deterministic boundary tests cover the assigned task temp and protected controller paths. Host- and release-specific live sandbox canaries remain pending, so this boundary must not be generalized into exhaustive read isolation or protection from separately authorized same-UID unsandboxed processes.

Trusted shared state is direct-dispatch-only. It requires `codex.trusted_shared_state_enabled: true`, `--trusted-shared-state`, and `--trusted-shared-state-receipt`; only then are the session add-dir and `TMUP_DB`/`TMUP_SESSION_DIR` restored. This is advisory same-UID trust, not peer isolation.

Direct Claude Code dispatch is also default-off and outside the Codex boundary. It requires `claude_code.trusted_unsandboxed_enabled: true`, `--worker-type claude_code`, `--allow-unconfined-claude-code`, and `--claude-code-trust-receipt`; the one-shot worker runs with `bypassPermissions`. MCP does not expose this mode.

Tiered subagent pack:

- Dormant source metadata defines `tmup-tier1` as the high-reasoning leaf profile and `tmup-tier2` as the medium-reasoning leaf profile; exact requested IDs remain centralized in policy and the matching TOML adapters.

The pinned tier model and effort values are experimental adapter metadata. Installation remains default-off and separately receipt-gated; the dispatcher does not activate or advertise these profiles.

Native children inherit the pane model unless the live spawn schema explicitly exposes named-role selection. Task names do not select or pin a role or model. When named-role selection is available, use only post-canary profiles activated by the lead and backed by a runtime receipt. Without named-role selection, native children are same-model leaves; use a model-explicit Codex/tmup process or lane for a distinct model. Never claim model or tier selection without a runtime receipt.

Native-child admission is pane-local and not shared across panes. Pane and thread settings are configuration bounds, not a measured safe aggregate. Start at the default grid and expand only from observed workload evidence; performance and fanout remain a pilot.

The planning-first behavior is carried by the initial prompt. tmup does not depend on an undocumented CLI startup flag for plan mode.

## MCP Tools (Lead)

| Tool | Purpose |
|------|---------|
| `tmup_init` | Initialize/reattach session |
| `tmup_status` | Session overview + dead-claim recovery |
| `tmup_next_action` | Synthesized next step recommendation |
| `tmup_task_create` | Add a task with optional role/evidence/model gates |
| `tmup_task_batch` | Create multiple gated tasks atomically |
| `tmup_task_update` | Modify task (needs_review->pending, etc.) |
| `tmup_claim` | Claim task on behalf of agent |
| `tmup_complete` | Mark task done, cascade unblock |
| `tmup_fail` | Mark task failed with reason |
| `tmup_cancel` | Cancel task (optional cascade) |
| `tmup_checkpoint` | Post progress update |
| `tmup_send_message` | Store a coordination/audit message; safe-pane delivery still uses reprompt |
| `tmup_inbox` | Check unread messages |
| `tmup_dispatch` | Create an attempt receipt and launch a Codex worker in a pane |
| `tmup_attempt_attest` | Record observed runtime model and fallback provenance |
| `tmup_evidence_add` | Attach unreviewed evidence to an attempt |
| `tmup_evidence_review` | Lead approval/challenge/rejection of evidence |
| `tmup_harvest` | Capture pane scrollback |
| `tmup_pause` | Record pause intent; explicitly reprompt/harvest safe panes |
| `tmup_resume` | Resume paused session |
| `tmup_teardown` | Record teardown intent; grid-teardown.sh stops the grid |
| `tmup_reprompt` | Send follow-up prompt to running agent |
| `tmup_heartbeat` | Register agent liveness |

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
// Harvest pane evidence, reprompt as needed, then complete/fail task 001 from the lead.
tmup_harvest({pane_index: 0})
tmup_attempt_attest({attempt_id: "<dispatch receipt>", observed_model: "<observed>", observation_source: "runtime receipt", fallback_used: false})
tmup_evidence_add({attempt_id: "<dispatch receipt>", type: "test_result", payload: "Verified checks passed"})
tmup_evidence_review({evidence_id: "<evidence id>", disposition: "approved"})
tmup_complete({task_id: "001", result_summary: "Verified result"})
tmup_teardown()
// Finally run /bin/bash -p scripts/grid-teardown.sh from the installed plugin.
```

## Re-Prompting Pattern

When an agent finishes early or needs additional instructions:
1. `tmup_harvest` -- capture current output (includes resume command if available)
2. `tmup_reprompt` -- send follow-up prompt to a verified-idle agent
3. Monitor via `tmup_next_action` and `tmup_inbox`

For resuming crashed agents:
1. `tmup_harvest` -- get codex session ID from response
2. `tmup_dispatch` with `resume_session_id` -- continue where agent left off

## Long-Running Task Detection

`tmup_next_action` returns `long_running` kind when a task has been claimed for over 30 minutes without completion. Use `tmup_harvest` to check the agent's progress and `tmup_reprompt` only after the pane reaches a verified idle prompt.

## Key Design Decisions

- **SQLite WAL** for concurrent read/write from 8+ agents
- **Optimistic locking** for task claims (no starvation)
- **Dependency cascade** on completion (blocked -> pending)
- **Dead-claim recovery** via heartbeat timeout
- **Content framing and trust labels** for harvested pane output and trusted-mode inbox text (defense in depth, not complete prompt-injection isolation)
