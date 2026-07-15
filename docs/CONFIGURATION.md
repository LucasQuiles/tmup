[< Back to README](../README.md)

# Configuration

Everything is in `config/policy.yaml`. The defaults are sensible. You probably don't need to change anything. But you will anyway, because you're like that.

## Grid layout

```yaml
grid:
  session_prefix: "tmup"     # tmux session name prefix
  rows: 2                    # grid rows
  cols: 4                    # grid columns (2x4 = 8 panes)
  width: 240                 # terminal width in characters
  height: 55                 # terminal height in characters
```

Grid dimensions are configurable, but they are not a shared admission controller. Start with the default, measure supervisor latency, host saturation, and task quality, then increase one dimension at a time. Pane count multiplied by per-pane thread settings is a configuration bound, not a validated safe operating point.

## Codex workers

```yaml
codex:
  model: "auto"
  explicit_model_pins_enabled: false
  trusted_shared_state_enabled: false
  approval_policy: "never"
  sandbox: "workspace-write"
  shell_env_inherit: "core"
  subagents:
    max_threads: 6
    max_depth: 1
    tiers:
      tier1:
        model: "gpt-5.6-terra"
      tier2:
        model: "gpt-5.6-luna"

claude_code:
  trusted_unsandboxed_enabled: false
```

### Model and executable resolution

`codex.model: "auto"` is not an auto-detection routine: tmup omits `-m` and lets the installed Codex CLI resolve its default. Context and compaction follow that runtime. If `codex.model` is explicit, dispatch fails unless `codex.explicit_model_pins_enabled` is `true` and the direct invocation includes `--model-validation-receipt <receipt>`. The pin and receipt record a requested configuration; they are not an observed-model claim. MCP does not accept a receipt, so explicit pins are direct-dispatch-only.

Direct dispatch resolves `CODEX_BIN` in this order: explicitly supplied valid absolute path, executable `$HOME/.local/bin/codex`, then the fixed controller `PATH`. MCP ignores inherited `CODEX_BIN`; before replacing controller `PATH`, it resolves and validates an absolute Codex executable from `$HOME/.local/bin/codex` or its original process `PATH`. Unsafe or worker/plugin/state-owned targets are rejected.

### Safe Codex lane

The MCP path dispatches only safe Codex lanes. It rejects `claude_code` before agent registration or task claim and strips ambient shell-inheritance, experimental-tier, trust, and shared-state override variables. The safe initial prompt does not advertise `tmup-cli`; the lead owns claim, checkpoint, message, complete, fail, and harvest transitions through supervisor-side APIs, while the protected launcher owns background heartbeat.

Safe panes use `workspace-write`, `sandbox_workspace_write.network_access=false`, `exclude_slash_tmp=true`, and `exclude_tmpdir_env_var=true`. Direct shell network access is disabled, while mediated Codex web search can remain enabled. The only extra `--add-dir` is an exact mode-0700 task temp beneath protected controller state, outside the working and tmup session roots. `TMPDIR`, `TMP`, and `TEMP` point to that child; the Codex parent retains its ambient temp.

Beyond Codex's core inherited command environment, tmup explicitly sets only `TMUP_AGENT_ID`, `TMUP_PANE_INDEX`, `TMUP_WORKING_DIR`, optional `TMUP_TASK_ID`, and the three temp values. It does not set `TMUP_DB` or `TMUP_SESSION_DIR`. Persistent policy accepts only `shell_env_inherit: "core"` or `"none"`; a one-command `TMUP_CODEX_SHELL_INHERIT_OVERRIDE` is a direct-script option and is stripped by MCP. Shell-snapshot interaction remains runtime-dependent, so command-environment filtering is not a claim of session-wide confidentiality.

Prompt, launcher, and log artifacts live below `$HOME/.local/state/tmup-control/<session>/`, outside working/session/task-temp roots. Prompts and logs are mode 0600; launchers are mode 0700. Prompt/launcher hashes and modes are checked before use. Teardown validates and removes only the exact protected controller session root.

Coordination state defaults to `$HOME/.local/state/tmup`. `TMUP_STATE_ROOT` may select another normalized absolute root; session paths must remain canonical children of it and may not overlap the plugin or protected controller state.

Deterministic tests cover writes inside the assigned task temp and rejection of controller-boundary aliases. Host- and release-specific live sandbox canaries remain pending. This constrains writes but is not exhaustive read isolation or protection from separately authorized same-UID unsandboxed processes.

### Direct trusted modes

Trusted shared state is a direct-dispatch-only compatibility escape hatch, not the default. It requires all three controls: `codex.trusted_shared_state_enabled: true`, direct `--trusted-shared-state`, and direct `--trusted-shared-state-receipt <receipt>`. Only that mode adds the tmup session directory and sets `TMUP_DB`, `TMUP_SESSION_NAME`, and `TMUP_SESSION_DIR` in worker command environments. The resulting shared SQLite/WAL and grid access is advisory same-UID trust, not mechanical peer isolation.

Claude Code direct workers are also default-off. They require `claude_code.trusted_unsandboxed_enabled: true`, `--worker-type claude_code`, `--allow-unconfined-claude-code`, and `--claude-code-trust-receipt <receipt>`. They run one-shot with `bypassPermissions`, are not available through MCP dispatch, and are outside the Codex sandbox guarantee.

### Native subagents and dormant tiers

Native subagent caps include `agents.max_depth=1` and `agents.max_threads=6`. `agents.job_max_runtime_seconds=3600` applies only to `spawn_agents_on_csv` batch jobs, not arbitrary native children. Non-batch native-child lifecycle and timeout remain controller-supervised and otherwise unknown. Admission is pane-local rather than shared across panes; pane and thread settings do not constitute a measured safe aggregate.

Dormant source metadata defines `tmup-tier1` as the high-reasoning leaf profile and `tmup-tier2` as the medium-reasoning leaf profile. Exact requested IDs remain centralized in policy and the matching TOML adapters. Installation remains default-off and separately receipt-gated. The dispatcher does not activate or advertise these profiles. Native children inherit the pane model unless the live spawn schema explicitly proves named-role selection; task names do not select or pin a role or model. Without named-role selection, native children are same-model leaves; use a model-explicit Codex/tmup process or lane for a distinct model. When named-role selection exists, use only post-canary profiles backed by a runtime receipt. Never claim model or tier selection without runtime evidence.

## DAG behavior

```yaml
dag:
  default_priority: 50                # default task priority (1-100)
  max_retries: 3                      # auto-retry on crash/timeout
  retry_backoff_base_seconds: 30      # first retry after 30s, then 60s, 120s...
  stale_max_age_seconds: 300          # agent is "dead" after 5 min without heartbeat
```

## Autonomy tiers (advisory supervisor policy)

```yaml
autonomy:
  full_participant_roles:
    - investigator              # supervisor may route to any agent
    - reviewer                  # supervisor may route to any agent
  checkpoint_roles:
    - implementer               # supervisor should route to lead
    - tester                    # supervisor should route to lead
    - refactorer                # supervisor should route to lead
    - documenter                # supervisor should route to lead
```

These lists are not mechanically enforced recipient permissions. Safe workers lack direct messaging access, so the supervisor applies the routing policy when relaying pane output. Trusted shared-state workers regain direct CLI messaging under an advisory same-UID boundary.

## Advanced configuration

```yaml
harvesting:
  capture_scrollback_lines: 500       # lines to capture per harvest
  poll_interval_seconds: 30           # how often to auto-poll (unused currently)

timeouts:
  dispatch_trust_prompt_seconds: 6    # wait for Codex trust prompt
  teardown_grace_seconds: 60          # reserved; currently unused by MCP teardown
  pause_checkpoint_seconds: 30        # reserved; currently unused by MCP pause
```

Pause and teardown currently store controller events/messages without waiting or stopping panes. Safe-pane delivery requires `tmup_reprompt`; explicit shutdown requires `/bin/bash -p scripts/grid-teardown.sh` from the plugin root. `tmup_teardown({force: true})` skips storing shutdown messages but still records the event and does not change pane lifecycle.

## Project structure

```
tmup/
+-- .claude-plugin/      # Plugin registration (plugin.json, marketplace.json)
|                          Claude Code reads these to discover the MCP server.
|
+-- agents/              # 6 runtime-neutral role definitions (markdown)
|   +-- implementer.md     Each one contributes a compact mission, workflow,
|   +-- tester.md          constraints, and deliverable contract. Runtime and
|   +-- reviewer.md        coordination details are injected by the dispatcher,
|   +-- refactorer.md      so role files do not assume Codex, Claude Code,
|   +-- documenter.md      tmup-cli, model tiers, or shared database access.
|   +-- investigator.md
|
+-- cli/                 # tmup-cli (lead/trusted compatibility binary)
|   +-- src/               TypeScript source. ~200 lines. esbuild bundles it
|   |   +-- commands/      into a single executable JS file. It talks directly
|   +-- dist/              to SQLite. No MCP. No HTTP. Just a file.
|       +-- tmup-cli.js
|
+-- commands/            # /tmup slash command definition
|   +-- tmup.md            This is what makes /tmup work in Claude Code.
|
+-- config/              # Runtime configuration
|   +-- policy.yaml        Grid size, DAG behavior, autonomy tiers, timeouts.
|   +-- schema.sql         Base schema (migrations add P5 tables at runtime).
|   +-- runtime-contract.json  SQLite pragmas (WAL, timeouts, foreign keys).
|
+-- mcp-server/          # MCP server (18 tools)
|   +-- src/               TypeScript source. The brain stem. Claude calls
|   |   +-- tools/         these tools via MCP protocol. Each tool is a
|   +-- dist/              function that reads/writes the shared SQLite DB.
|       +-- index.js       esbuild bundles everything into one file.
|
+-- scripts/             # Bash automation
|   +-- grid-setup.sh      Create NxM tmux grid with proper geometry
|   +-- dispatch-agent.sh  Launch safe Codex or gated direct trusted workers
|   +-- grid-teardown.sh   Kill session, deregister, remove controller state
|   +-- pane-manager.sh    Reserve/release panes with CAS locking
|   +-- sync-cache.sh      Sync source to plugin cache
|   +-- trust-sweep.sh     Auto-accept Codex trust prompts
|   +-- lib/               Shared shell libraries (config, registry, validation)
|
+-- shared/              # @tmup/shared library (22 TypeScript modules)
|   +-- src/               The core domain logic. Task operations, lifecycle
|   |                      state machine, dependency resolution, messaging,
|   |                      agent management, session registry.
|   +-- dist/              tsc output. Not bundled -- used as a workspace dep.
|
+-- skills/              # Skill documentation for Claude Code
|   +-- tmup/
|       +-- SKILL.md       Quick start and tool overview
|       +-- REFERENCE.md   Complete API reference
|
+-- tests/               # Vitest suite
|   +-- shared/            Unit tests for all 22 shared modules
|   +-- mcp/               MCP tool integration tests
|   +-- cli/               CLI command tests
|   +-- scripts/           Shell script boundary tests
|   +-- integration/       End-to-end lifecycle tests
|   +-- helpers/           Test utilities (temp DB setup)
|
+-- SYSTEM-INVENTORY.md  # Complete internal documentation (46 KB)
|                          If the README is the brochure, SYSTEM-INVENTORY
|                          is the engineering manual. Everything is in there.
|
+-- package.json         # npm workspace root
+-- vitest.config.ts     # Test runner config
+-- LICENSE              # MIT. Do what you want. We're not your mom.
```
