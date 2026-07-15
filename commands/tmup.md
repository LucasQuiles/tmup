---
name: tmup
description: Multi-agent coordination via task DAG + tmux grid
allowed-tools:
  - Bash
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
  - mcp__tmup__tmup_heartbeat
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
  - mcp__plugin_tmup_tmup__tmup_heartbeat
---

# /tmup — Multi-Agent Coordination

Use this command to coordinate Codex CLI workers across a tmux NxM grid (default 2x4, configurable in policy.yaml).

## Usage

`/tmup` — Check status or initialize a new session
`/tmup init` — Initialize a new tmup session for the current project
`/tmup status` — Show DAG status summary
`/tmup next` — Get next recommended action
`/tmup teardown` — Reconcile task state and shut down the grid

## Workflow

1. Initialize state: call `tmup_init` with the project directory.
2. Create or verify panes: run `/bin/bash -p scripts/grid-setup.sh --project-dir <absolute-project-dir>` from this plugin.
3. Plan and execute: create the DAG with `tmup_task_batch`, then dispatch ready tasks with `tmup_dispatch`.
4. Supervise: loop over `tmup_next_action` and `tmup_harvest`; use `tmup_reprompt` for text that must reach a safe pane.
5. Reconcile: after evaluating harvested evidence, call lead-side `tmup_checkpoint`, `tmup_complete`, or `tmup_fail`. Database messages are audit records for safe panes, not delivery.
6. Shut down: reprompt workers to stop, harvest final output, reconcile every claim, call `tmup_teardown` to record the event, then run `/bin/bash -p scripts/grid-teardown.sh` from this plugin.

## Session Model

Workers are interactive Codex sessions in tmux panes. Use `tmup_dispatch` to start them, `tmup_reprompt` to send follow-up instructions. Never use `codex exec` or Bash to drive worker panes.

## Grid Supervision

- Treat each pane as a long-lived external subagent lane that you supervise directly.
- Keep one clear objective per lane. Do not mix unrelated workstreams into the same pane.
- Dispatch once for a fresh lane, then prefer `tmup_harvest` + `tmup_reprompt` over redispatch when the pane already holds relevant context.
- Do not retire or respawn a pane just to send new instructions if the existing worker is still the right lane.
- Harvest, evaluate, and reprompt as a loop. `tmup_harvest` is observational; `tmup_reprompt` is the control path.

## tmux Input Model

- `tmup_reprompt` sends literal text into a verified-idle worker session with `tmux send-keys -l`, then requires post-submit activity before reporting success.
- Active-pane queue delivery is disabled because the interface provides no pane-specific acceptance receipt.
- Do not type shell commands into worker panes to continue the session. Use tmup tools only.

## Fresh Worker Runtime

- The MCP dispatch path supports only the safe Codex lane. It rejects `claude_code` before registration or task claim and strips ambient shell-inheritance, tier-activation, trust, and shared-state overrides.
- `codex.model: "auto"` means tmup omits `-m`; the installed Codex CLI chooses its default model. Context and compaction come from that resolved runtime.
- Explicit model pins are direct-dispatch-only and require both `codex.explicit_model_pins_enabled: true` and a non-empty per-dispatch `--model-validation-receipt`. The requested pin and receipt are not an observed-model claim.
- Direct-script Codex resolution accepts an explicit valid absolute `CODEX_BIN`, then executable `~/.local/bin/codex`, then the fixed controller `PATH`. MCP resolves a validated absolute executable from `~/.local/bin/codex` or its own original `PATH` before replacing controller `PATH`.
- Pane roots use `workspace-write`. Direct shell network access is disabled with `sandbox_workspace_write.network_access=false`; mediated Codex web search can remain enabled.
- tmup configures `model_reasoning_effort=high`, `model_reasoning_summary=concise`, `plan_mode_reasoning_effort=xhigh`, and `model_verbosity=low`.
- tmup enables `service_tier=fast`, `tool_output_token_limit=50000`, and `web_search=live` for higher-throughput interactive lanes.
- tmup preserves resumability and operator ergonomics with `history.persistence=save-all`, `shell_environment_policy.inherit=core`, `features.shell_snapshot=true`, `features.enable_request_compression=true`, `tui.notifications=true`, and `background_terminal_max_timeout=600000`.
- The safe command environment explicitly sets only `TMUP_AGENT_ID`, `TMUP_PANE_INDEX`, `TMUP_WORKING_DIR`, optional `TMUP_TASK_ID`, and `TMPDIR`/`TMP`/`TEMP`. It does not expose `TMUP_DB` or `TMUP_SESSION_DIR`. A one-command shell inheritance override is available only through direct script dispatch; MCP removes it.
- Shell-snapshot interaction is unproven without a release-specific live canary; command-environment filtering does not prove session-wide confidentiality.
- Workspace-write launches set `exclude_slash_tmp=true` and `exclude_tmpdir_env_var=true`. The only extra `--add-dir` in the safe lane is one exact mode-0700 task temp under a protected controller root, outside the working and tmup session roots. The command environment points all three temp variables at that child; the parent keeps its ambient temp unchanged. This constrains writes but does not provide exhaustive read isolation.
- Prompts, launchers, and logs live under the protected controller root, outside working/session/task roots. Prompts/logs are mode 0600, launchers are mode 0700, and prompt/launcher hashes and modes are rechecked before use. Teardown validates and removes the exact controller session root.
- Deterministic tests cover the assigned task temp and protected controller boundaries. Host- and release-specific live sandbox canaries remain pending.
- The initial safe prompt does not advertise `tmup-cli` or direct database access. The supervisor owns claim, checkpoint, message, complete, fail, and harvest operations; the protected launcher owns background heartbeat. Workers report progress, blockers, evidence, and final results in pane output.
- Trusted shared state is a direct-dispatch-only compatibility mode. It requires `codex.trusted_shared_state_enabled: true`, `--trusted-shared-state`, and a non-empty `--trusted-shared-state-receipt`; only then are the session directory and `TMUP_DB`/`TMUP_SESSION_DIR` added. This is advisory same-UID trust, not peer isolation.
- Direct Claude Code dispatch uses `bypassPermissions`, is unsandboxed, and is outside this Codex boundary. It requires `claude_code.trusted_unsandboxed_enabled: true`, `--allow-unconfined-claude-code`, and `--claude-code-trust-receipt`; MCP does not expose it.
- tmup configures worker lanes for interactive Codex use with autonomous execution and inline scrollback-friendly mode.
- Planning-first behavior is enforced by the initial worker prompt. tmup does not rely on an undocumented Codex startup flag for this.
- Native subagent caps include `agents.max_depth=1`; fresh lanes also set `agents.max_threads=6`. `agents.job_max_runtime_seconds=3600` applies only to `spawn_agents_on_csv` batch jobs, not arbitrary native children. Non-batch native-child lifecycle and timeout remain controller-supervised and otherwise unknown.
- Dormant source metadata defines `tmup-tier1` as the high-reasoning leaf profile and `tmup-tier2` as the medium-reasoning leaf profile; exact requested IDs remain centralized in policy and the matching TOML adapters.
- Their pinned model and effort values are experimental adapter metadata. Installation is default-off and receipt-gated; dispatch does not activate or advertise these profiles.
- Native children inherit the pane model unless the live spawn schema explicitly exposes named-role selection. Task names do not select or pin a role or model.
- When named-role selection is available, use only post-canary profiles activated by the lead and backed by a runtime receipt.
- Without named-role selection, native children are same-model leaves; use a model-explicit Codex/tmup process or lane for a distinct model.
- Never claim model or tier selection without a runtime receipt.
- Native-child admission is pane-local and not shared across panes. Pane and thread settings are configuration bounds, not a measured safe aggregate. Start with the default grid, expand only from observed workload evidence, and treat fanout performance as a pilot.

## Task DAG

Tasks form a directed acyclic graph. Dependencies are resolved automatically:
- When a task completes, blocked dependents are unblocked
- Cycle detection prevents invalid dependency chains
- Failed tasks auto-retry (crash/timeout) or escalate (logic errors)

## Roles

| Role | Supervisor routing | Stored-message audience |
|------|--------------------|-------------------------|
| implementer | checkpoint | lead |
| tester | checkpoint | lead |
| reviewer | full participant | any agent |
| refactorer | checkpoint | lead |
| documenter | checkpoint | lead |
| investigator | full participant | any agent |

This table is advisory routing metadata, not a recipient ACL or proof of delivery. Safe panes receive text only through `tmup_reprompt`; the supervisor applies routing after harvest.
