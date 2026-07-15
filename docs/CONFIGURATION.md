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

Want a 3x3 grid? Set `rows: 3, cols: 3`. Now you have 9 workers. Want a 4x4? That's 16 workers. We've never tried 16 but the code doesn't stop you. The SQLite database might start having opinions at that point, but it's been through worse.

## Codex workers

```yaml
codex:
  model: "auto"
  model_preference: ["gpt-5.6-sol", "gpt-5.5", "gpt-5"]
  approval_policy: "never"
  sandbox: "workspace-write"
  subagents:
    max_threads: 6
    max_depth: 1
    tiers:
      tier1:
        model: "gpt-5.6-terra"
      tier2:
        model: "gpt-5.6-luna"
```

Fresh pane roots use the auto-detected Codex model (`codex.model: "auto"`). Context and compaction come from the resolved Codex model catalog; tmup does not override them. Pane roots use the `workspace-write` sandbox. Native subagent caps include `agents.max_depth=1`.

`tmup-tier1` is the `gpt-5.6-terra` / high-reasoning leaf profile. `tmup-tier2` is the `gpt-5.6-luna` / medium-reasoning leaf profile.

Native children inherit the pane model unless the live spawn schema explicitly exposes named-role selection. Task names do not select or pin a role or model. When named-role selection is available, `tmup-tier1` and `tmup-tier2` are direct leaves and must not delegate further. Without named-role selection, native children are same-model leaves; use a model-explicit Codex/tmup process or lane for a distinct model. Never claim model or tier selection without a runtime receipt.

Explicit process-isolated Codex workers use `--ignore-user-config --disable multi_agent` so they do not inherit or activate the native multi-agent runtime.

## DAG behavior

```yaml
dag:
  default_priority: 50                # default task priority (1-100)
  max_retries: 3                      # auto-retry on crash/timeout
  retry_backoff_base_seconds: 30      # first retry after 30s, then 60s, 120s...
  stale_max_age_seconds: 300          # agent is "dead" after 5 min without heartbeat
```

## Autonomy tiers

```yaml
autonomy:
  full_participant_roles:
    - investigator              # can message any agent
    - reviewer                  # can message any agent
  checkpoint_roles:
    - implementer               # can only message lead
    - tester                    # can only message lead
    - refactorer                # can only message lead
    - documenter                # can only message lead
```

## Advanced configuration

```yaml
harvesting:
  capture_scrollback_lines: 500       # lines to capture per harvest
  poll_interval_seconds: 30           # how often to auto-poll (unused currently)

timeouts:
  dispatch_trust_prompt_seconds: 6    # wait for Codex trust prompt
  teardown_grace_seconds: 60          # grace period before force-killing panes
  pause_checkpoint_seconds: 30        # time for agents to checkpoint before pause
```

## Project structure

```
tmup/
+-- .claude-plugin/      # Plugin registration (plugin.json, marketplace.json)
|                          Claude Code reads these to discover the MCP server.
|
+-- agents/              # 6 agent role definitions (markdown)
|   +-- implementer.md     Each one is a system prompt that gets injected into
|   +-- tester.md          the Codex worker at dispatch time. They contain the
|   +-- reviewer.md        role description, tmup-cli reference, error recovery
|   +-- refactorer.md      table, autonomy rules, and constraints. They are
|   +-- documenter.md      essentially job descriptions for robots.
|   +-- investigator.md
|
+-- cli/                 # tmup-cli (worker binary)
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
|   +-- dispatch-agent.sh  Launch Codex in a pane with env vars and prompt
|   +-- grid-teardown.sh   Kill session, deregister
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
