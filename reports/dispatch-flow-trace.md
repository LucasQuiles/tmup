# Dispatch Flow Trace

## Scope

This report traces the runtime path from MCP `tmup_dispatch` to `scripts/dispatch-agent.sh` to the final Codex CLI launch. It also notes the prerequisite session and grid setup that dispatch depends on.

## Preconditions

1. `tmup_init` must already have selected a session and opened a session database. The MCP server resolves the current session from `~/.local/state/tmup/current-session`, then opens the SQLite DB from the registry. Relevant code:
   - `mcp-server/src/index.ts:78`
   - `shared/src/session-ops.ts:201`
   - `shared/src/session-ops.ts:286`
   - `shared/src/session-ops.ts:315`
   - `shared/src/db.ts:13`
2. `grid-setup.sh` must already have created the tmux session and written `grid-state.json` with per-pane `{index, pane_id, status}` records. Relevant code:
   - `scripts/grid-setup.sh:122`
   - `shared/src/grid-state.ts:19`

## End-to-End Call Chain

1. MCP server startup registers tool metadata from `toolDefinitions` and routes tool invocations to `handleToolCall()`.
   - `mcp-server/src/index.ts:124`
   - `mcp-server/src/index.ts:130`
   - `mcp-server/src/index.ts:134`
2. `tmup_dispatch` is defined with `task_id`, `role`, optional `pane_index`, and optional `working_dir`.
   - `mcp-server/src/tools/index.ts:233`
3. `handleToolCall('tmup_dispatch', ...)` acquires the session DB with `ensureDb()`, validates `task_id` and `role`, and bounds-checks `pane_index` against the active grid size using `getSessionDir()` plus `getGridPaneCount()`.
   - `mcp-server/src/tools/index.ts:595`
   - `mcp-server/src/tools/index.ts:613`
   - `shared/src/grid-state.ts:47`
   - `shared/src/session-ops.ts:322`
4. The handler generates a new agent id and registers the agent row before task claim.
   - `mcp-server/src/tools/index.ts:623`
   - `mcp-server/src/tools/index.ts:626`
   - `shared/src/agent-ops.ts:4`
5. The handler claims the specific task through `claimSpecificTask()`. This is the actual SQLite transaction in the dispatch path: it enforces one-active-task-per-agent, validates role compatibility, updates the task from `pending` to `claimed`, and logs `task_claimed`.
   - `mcp-server/src/tools/index.ts:633`
   - `shared/src/task-lifecycle.ts:58`
6. On successful claim, the handler logs a separate `dispatch` event, resolves the worker `working_dir`, `sessionId`, `dbPath`, and `scripts/dispatch-agent.sh`, then builds the shell arguments.
   - `mcp-server/src/tools/index.ts:644`
   - `mcp-server/src/tools/index.ts:654`
   - `mcp-server/src/tools/index.ts:663`
7. The MCP layer shells out with `execFileSync('bash', dispatchArgs, ...)`, so the shell script becomes the launch boundary.
   - `mcp-server/src/tools/index.ts:677`
8. `dispatch-agent.sh` pre-parses `--session` into `TMUP_SESSION_NAME`, then sources:
   - `scripts/lib/config.sh` for session/grid/trust config and `CFG_STATE_DIR`
   - `scripts/lib/validators.sh` for role/pane/working-dir validation
   - `scripts/lib/tmux-helpers.sh` for pane-process checks
   Relevant code:
   - `scripts/dispatch-agent.sh:9`
   - `scripts/dispatch-agent.sh:19`
   - `scripts/lib/config.sh:53`
   - `scripts/lib/config.sh:82`
   - `scripts/lib/config.sh:131`
   - `scripts/lib/tmux-helpers.sh:5`
9. `dispatch-agent.sh` validates required args, resolves the working directory, validates the role file, then loads `agents/<role>.md` and strips YAML frontmatter with `awk`. The remaining role instructions are appended to the final prompt.
   - `scripts/dispatch-agent.sh:98`
   - `scripts/dispatch-agent.sh:109`
   - `scripts/dispatch-agent.sh:111`
10. If `--pane-index` was omitted, the script auto-selects the first `available` pane from `grid-state.json`.
   - `scripts/dispatch-agent.sh:116`
11. The script builds `FULL_PROMPT`, which includes:
   - the task objective passed in from MCP
   - the resolved working directory
   - the tmup CLI command reference
   - the role-specific instructions from `agents/<role>.md`
   Relevant code:
   - `scripts/dispatch-agent.sh:126`
12. The script writes:
   - a temp prompt file under the session state dir
   - a temp launcher script under the session state dir
   The launcher exports `TMUP_AGENT_ID`, `TMUP_DB`, `TMUP_PANE_INDEX`, `TMUP_SESSION_NAME`, `TMUP_SESSION_DIR`, `TMUP_WORKING_DIR`, optional `TMUP_TASK_ID`, and `CODEX_BIN`.
   - `scripts/dispatch-agent.sh:158`
   - `scripts/dispatch-agent.sh:163`
13. The launcher reads the prompt, deletes both temp files, and `exec`s Codex:
   - `codex -a never -s danger-full-access --no-alt-screen -C "$TMUP_WORKING_DIR" "$_PROMPT"`
   Relevant code:
   - `scripts/dispatch-agent.sh:176`
   - `scripts/dispatch-agent.sh:178`
14. Before sending the launch command, `dispatch-agent.sh` reserves the pane:
   - opens `grid-state.lock`
   - checks `tmux display-message ... #{pane_current_command}`
   - rejects panes already running `codex|node|npm|npx`
   - rewrites the pane entry to `status: "reserved"` with `role` and `agent_id`
   Relevant code:
   - `scripts/dispatch-agent.sh:182`
   - `scripts/dispatch-agent.sh:193`
   - `scripts/dispatch-agent.sh:206`
   - `scripts/lib/tmux-helpers.sh:5`
15. The script then clears the pane and sends `bash '$LAUNCHER'` into the tmux pane with `tmux send-keys`.
   - `scripts/dispatch-agent.sh:227`
   - `scripts/dispatch-agent.sh:233`
16. After a successful send, the script marks dispatch committed and polls the pane for the Codex trust prompt. It auto-presses Enter only when a captured line starts with `Do you trust`, and it stops early if Codex shows `Working (`.
   - `scripts/dispatch-agent.sh:250`
   - `scripts/dispatch-agent.sh:252`
17. The shell script exits after printing `Dispatched <role> to pane <n> (agent <id>)`. At that point the Codex process is running inside the pane with the injected prompt and tmup environment.
   - `scripts/dispatch-agent.sh:268`

## Modules Involved

### Directly in the dispatch call chain

- `mcp-server/src/index.ts`
  - MCP server bootstrap, tool registration, request routing, lazy DB connection.
- `mcp-server/src/tools/index.ts`
  - `tmup_dispatch` definition and handler.
- `shared/src/session-ops.ts`
  - Current session resolution, session DB path lookup, project dir lookup, session dir lookup.
- `shared/src/db.ts`
  - Opens SQLite DB, applies runtime pragmas/schema/migrations.
- `shared/src/agent-ops.ts`
  - Agent registration, heartbeat updates, stale-agent recovery.
- `shared/src/task-lifecycle.ts`
  - `claimSpecificTask()` transaction used by dispatch.
- `shared/src/grid-state.ts`
  - Grid size lookup used for `pane_index` validation.
- `scripts/dispatch-agent.sh`
  - Shell handoff, prompt assembly, pane reservation, launcher creation, Codex launch.
- `scripts/lib/config.sh`
  - Reads `config/policy.yaml`, resolves state dir and trust timeout.
- `scripts/lib/validators.sh`
  - Validates pane index, role, and working directory.
- `scripts/lib/tmux-helpers.sh`
  - Detects whether the pane is already running an agent process.
- `agents/<role>.md`
  - Role instructions injected into the Codex prompt.

### Adjacent modules that shape the path but are not invoked directly by `tmup_dispatch`

- `scripts/grid-setup.sh`
  - Creates the tmux grid and `grid-state.json` that dispatch consumes later.
- `scripts/pane-manager.sh`
  - Owns explicit pane release; dispatch itself leaves successful launches in `reserved` state.

### Present in architecture but not used by the current dispatch path

- `shared/src/execution-target-ops.ts`
  - Provides execution-target abstractions (`tmux_pane`, `local_shell`, `codex_cloud`), but `tmup_dispatch` still routes directly by pane index and never calls this module.

## Observed Behaviors and Findings

### Dispatch is API-level atomic, not one SQLite transaction

`tmup_dispatch` performs all of these steps within one tool call, but only `claimSpecificTask()` is inside an IMMEDIATE SQLite transaction. Agent registration, dispatch event logging, and process launch happen outside that transaction.

Relevant code:
- `mcp-server/src/tools/index.ts:626`
- `shared/src/task-lifecycle.ts:66`
- `mcp-server/src/tools/index.ts:644`
- `mcp-server/src/tools/index.ts:677`

### Launch failure cleanup does not currently make the task recoverable

On shell launch failure, `tmup_dispatch` marks the agent `shutdown`, but stale-claim recovery only scans agents with `status = 'active'`. The current test suite confirms that after launch failure the task stays `claimed` and owned by the shutdown agent.

Relevant code:
- `mcp-server/src/tools/index.ts:686`
- `shared/src/agent-ops.ts:44`
- `shared/src/agent-ops.ts:60`
- `tests/mcp/handle-tool-call.test.ts:246`

Implication:
- The code comment in `tmup_dispatch` says shutdown lets dead-claim recovery reassign the task, but that is not true with the current recovery filter.

### Successful shell dispatch leaves panes `reserved`, not `running`

`dispatch-agent.sh` reserves a pane before `tmux send-keys`, rolls back on pre-commit failure, but does not transition the pane to a separate `running` state after a successful launch. Later release is delegated to `pane-manager.sh`.

Relevant code:
- `scripts/dispatch-agent.sh:206`
- `scripts/dispatch-agent.sh:233`
- `scripts/pane-manager.sh:26`

## Conclusion

The current dispatch path is:

`MCP server -> tmup_dispatch handler -> ensureDb/session lookup -> registerAgent -> claimSpecificTask -> log dispatch -> execFileSync('bash', dispatch-agent.sh ...) -> config/validator/helper shell libs -> role prompt assembly -> pane reservation -> launcher script -> tmux send-keys -> launcher execs Codex`

The architecture is straightforward and mostly layered cleanly, but two important nuances matter:

1. The "atomic" guarantee is scoped to the MCP tool call, not to one DB transaction covering registration, claim, and launch.
2. Launch failure currently strands a claimed task behind a shutdown agent because the recovery path only considers active agents.
