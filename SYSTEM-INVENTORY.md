# tmup System Inventory

> Multi-agent coordination for Claude Code + Codex CLI via SQLite WAL-backed task DAG
> Version: 0.1.0 | 18 MCP tools | 9 CLI commands | 22 shared modules
> 36 test files | All passing

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Plugin Registration](#2-plugin-registration)
3. [Database Layer](#3-database-layer)
4. [Shared Library](#4-shared-library)
5. [MCP Server](#5-mcp-server)
6. [CLI (`tmup-cli`)](#6-cli-tmup-cli)
7. [Bash Scripts](#7-bash-scripts)
8. [Agent Definitions](#8-agent-definitions)
9. [Skill & Command](#9-skill--command)
10. [Configuration](#10-configuration)
11. [Build System](#11-build-system)
12. [Test Suite](#12-test-suite)
13. [State & Runtime](#13-state--runtime)
14. [Security Hardening](#14-security-hardening)
15. [File Manifest](#15-file-manifest)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code (Lead)                          │
│  ┌─────────────┐   ┌────────────────┐   ┌──────────────────┐   │
│  │ /tmup       │──▶│ MCP Server     │──▶│ SQLite WAL DB    │   │
│  │ (command)   │   │ (18 tools)     │   │ (17 tables)      │   │
│  └─────────────┘   └────────┬───────┘   └────────▲─────────┘   │
│                             │                     │             │
│                    ┌────────▼────────┐            │             │
│                    │ Bash Scripts    │            │             │
│                    │ (grid/dispatch) │            │             │
│                    └────────┬────────┘            │             │
│                             │                     │             │
└─────────────────────────────┼─────────────────────┼─────────────┘
                              │                     │
              ┌───────────────▼───────────────┐     │
              │       tmux NxM Grid (default 2x4)  │     │
              │  ┌─────┬─────┬─────┬─────┐    │     │
              │  │ P0  │ P1  │ P2  │ P3  │    │     │
              │  ├─────┼─────┼─────┼─────┤    │     │
              │  │ P4  │ P5  │ P6  │ P7  │    │     │
              │  └──┬──┴──┬──┴──┬──┴──┘    │     │
              └─────┼─────┼─────┼─────┼───────┘     │
                    │     │     │     │               │
              ┌─────▼─────▼─────▼─────▼──────────────┘
              │   Codex CLI Workers (tmup-cli)
              │   Each: claim → work → checkpoint → complete
              └──────────────────────────────────────────
```

**Data flow:**
1. Lead uses MCP tools to create task DAG and dispatch workers
2. MCP server reads/writes SQLite WAL database via `@tmup/shared`
3. Bash scripts create tmux grid and launch Codex CLI in panes
4. Workers use `tmup-cli` binary to coordinate via the same SQLite DB
5. Lead monitors via `tmup_next_action`, `tmup_inbox`, `tmup_harvest`

**Concurrency model:** SQLite WAL mode allows 1 writer + N readers. All writes use IMMEDIATE transactions to serialize. `busy_timeout=8000ms` prevents lock failures under moderate contention from concurrent workers.

**Multi-session behavior:** Session reuse is registry-driven, canonical-path-based, and conditional on context:
- Shell path (`grid-registry.sh`): canonicalizes directories, uses portable `mkdir`-based locking, traverses parent directories, and only returns a match if `tmux has-session` succeeds for the registered session.
- Shared path (`session-ops.ts`): canonicalizes directories, uses a PID-file lock, and reattaches purely on canonical `project_dir` equality in the registry. Does not verify tmux session liveness.
- These two layers operate on the same on-disk registry but do not share lock semantics. Stale registry entries (dead tmux sessions) are ignored by the shell path but may be reattached by the shared path.

---

## 2. Plugin Registration

### Installation

**Prerequisites:** Node.js (v20+), npm, tmux (>=3.0)

```bash
# 1. Build the plugin
cd ~/.claude/plugins/tmup
npm install && npm run build

# 2. Register the marketplace source in Claude Code settings
#    In ~/.claude/settings.json, add:
#    "extraKnownMarketplaces": {
#      "tmup-dev": {
#        "source": {"source": "directory", "path": "~/.claude/plugins/tmup"}
#      }
#    }
#    "enabledPlugins": {
#      "tmup@tmup-dev": true
#    }

# 3. Install the plugin (creates cache entry in ~/.claude/plugins/cache/tmup-dev/tmup/0.1.0/)
claude plugin install tmup@tmup-dev

# 4. Restart Claude Code — /tmup command and MCP tools become available
```

**After source edits:** Run `scripts/sync-cache.sh` to push changes to the plugin cache, then restart Claude Code.

### `.claude-plugin/plugin.json`
```json
{
  "name": "tmup",
  "version": "0.1.0",
  "description": "Multi-agent coordination for Claude Code + Codex CLI via SQLite WAL-backed task DAG",
  "mcpServers": {
    "tmup": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

Registers the MCP server as a Claude Code plugin. The `${CLAUDE_PLUGIN_ROOT}` variable resolves to the plugin's install directory at runtime.

### `.claude-plugin/marketplace.json`
```json
{
  "name": "tmup-dev",
  "owner": {
    "name": "q"
  },
  "plugins": [
    {
      "name": "tmup",
      "source": "./",
      "description": "Multi-agent coordination for Claude Code + Codex CLI via SQLite WAL-backed task DAG",
      "version": "0.1.0"
    }
  ]
}
```

Marketplace manifest for directory-source registration. The `name` field is the **marketplace name** (not the plugin name). The `plugins` array lists plugins available from this marketplace, with `source: "./"` pointing to the plugin root relative to the marketplace.json location.

**Key distinction:** `plugin.json` describes the plugin itself (name, MCP servers). `marketplace.json` describes the marketplace that hosts the plugin (used by `claude plugin install`).

---

## 3. Database Layer

### Schema (`config/schema.sql` + migrations — 17 tables, 19 indexes)

#### Core Tables (schema.sql v1)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `tasks` | Task DAG nodes | `id` (TEXT PK, zero-padded), `status`, `owner`, `priority`, `retry_count`, `failure_reason`, `retry_after` |
| `task_deps` | DAG edges | `(task_id, depends_on_task_id)` composite PK, self-dep CHECK |
| `task_artifacts` | Task-artifact join | `(task_id, artifact_id, direction)` PK, direction IN (produces, requires) |
| `artifacts` | File tracking with checksums | `name` UNIQUE, `path`, `status`, `checksum` (SHA-256) |
| `messages` | Inter-agent messaging | `from_agent`, `to_agent` (NULL=broadcast), `type`, `payload` (100KB limit), `read_at` |
| `agents` | Worker registration | `id`, `pane_index`, `role`, `codex_session_id`, `execution_target_id`, `status`, `last_heartbeat_at` |
| `events` | Append-only audit log | `AUTOINCREMENT` PK, `actor`, `event_type`, `payload` (JSON) |
| `schema_version` | Migration tracking | `version`, `applied_at` |

#### Planning Domain Tables (migration v3)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `plans` | Planning objects with state machine | `id`, `subject` (<=500), `description`, `status` (proposed/challenged/operational/superseded), `owner`, `rationale`, `open_questions`, timestamps |
| `plan_reviews` | Multi-pass review records | `id`, `plan_id`, `reviewer`, `disposition` (approved/challenged/rejected), `comment` |
| `research_packets` | Research findings linked to plans | `id`, `plan_id`, `subject` (<=500), `findings` (<=100000), `author` |
| `plan_tasks` | Plan-to-task linkage | `(plan_id, task_id)` composite PK |

#### Evidence Domain Tables (migration v3)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `task_attempts` | Execution attempts per task | `id`, `task_id`, `agent_id`, `execution_target_id`, `model_family`, `status` (running/succeeded/failed/abandoned), `confidence` (0.0-1.0), `failure_reason`, `result_summary` |
| `evidence_packets` | Structured evidence per attempt | `id`, `attempt_id`, `type` (diff/test_result/build_log/screenshot/review_comment/artifact_checksum), `payload`, `hash`, `reviewer_disposition` |

#### Execution Target Tables (migration v3)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `execution_targets` | Abstract execution locations | `id`, `type` (tmux_pane/local_shell/codex_cloud), `label`, `pane_index`, `capabilities` (JSON) |

#### Lifecycle Bridge Tables (migration v3)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `lifecycle_events` | Claude-native event ingress | `id` (AUTOINCREMENT), `timestamp`, `event_type`, `session_id`, `payload` (JSON) |

**Status enums with CHECK constraints:**
- Task: `pending`, `blocked`, `claimed`, `completed`, `cancelled`, `needs_review`
- Plan: `proposed`, `challenged`, `operational`, `superseded`
- Attempt: `running`, `succeeded`, `failed`, `abandoned`
- Message types: `direct`, `broadcast`, `finding`, `blocker`, `checkpoint`, `shutdown`
- Failure reasons: `crash`, `timeout`, `logic_error`, `artifact_missing`, `dependency_invalid`
- Agent status: `active`, `idle`, `shutdown`
- Evidence types: `diff`, `test_result`, `build_log`, `screenshot`, `review_comment`, `artifact_checksum`
- Execution target types: `tmux_pane`, `local_shell`, `codex_cloud`
- 24 event types (see types.ts)

**Indexes:**
- `idx_tasks_claimable` — partial index on pending tasks by (status, role, priority, created_at, retry_after)
- `idx_messages_inbox` — (to_agent, read_at, created_at) for inbox queries
- `idx_task_deps_source/target` — bidirectional dep traversal
- `idx_artifacts_by_name` — artifact name lookups
- `idx_agents_heartbeat` — partial index on active agents by heartbeat
- `idx_events_timestamp` — event timestamp for pruning queries
- `idx_tasks_one_active_per_owner` — partial unique index: one claimed task per owner
- `idx_task_artifacts_one_producer` — partial unique index: one producer per artifact

**Triggers:**
- `trg_tasks_nonempty_subject` / `trg_tasks_nonempty_subject_update` — reject empty subject on INSERT/UPDATE

**Migration framework:**
- `schema_version` table tracks applied migrations
- Migration v1: dead state removal (failed→needs_review, in_progress→claimed)
- Migration v2: schema constraints (indexes, triggers, unique constraints with preflight checks)
- Migration v3: planning domain, evidence records, execution targets, lifecycle bridge (P5)
- Migration v4: SDLC-OS colony support (bead tracking, loop levels, worker types, corrections)

### Runtime Contract (`config/runtime-contract.json`)

```json
{
  "journal_mode": "wal",
  "busy_timeout": 8000,
  "foreign_keys": 1,
  "synchronous": 1,
  "wal_autocheckpoint": 1000,
  "journal_size_limit": 33554432
}
```

Applied via **allowlist-validated pragma injection** in `db.ts`. Only the 6 known pragmas are accepted; unknown keys throw. String values validated against `/^[a-zA-Z_]+$/`, integers validated with `Number.isFinite()`.

### Database Initialization (`shared/src/db.ts`)

- Creates parent directory with `umask(0o077)` + `mode: 0o700`
- Opens `better-sqlite3` connection
- Applies runtime contract pragmas (allowlist validated)
- Executes `schema.sql` (all `CREATE IF NOT EXISTS`)
- Sets file permissions `0o600`
- `closeDatabase()` runs `wal_checkpoint(PASSIVE)` before close

---

## 4. Shared Library

**Package:** `@tmup/shared` | **Main:** `dist/index.js` | **Types:** `dist/index.d.ts`
**Dependencies:** `better-sqlite3`, `js-yaml`

### Module Map

| Module | Exports | LOC | Transaction Safety |
|--------|---------|-----|-------------------|
| `db.ts` | `openDatabase`, `closeDatabase` | 76 | N/A (initialization) |
| `id.ts` | `nextTaskId`, `generateAgentId`, `generateMessageId`, `generateArtifactId` | 21 | Called within transactions |
| `types.ts` | All type definitions (15 enums, 15 row interfaces, 12 input interfaces, 3 session types, 1 policy type) | ~350 | N/A |
| `event-ops.ts` | `logEvent`, `pruneEvents`, `getRecentEvents` | 35 | Single-statement (inherent) |
| `dep-resolver.ts` | `checkCycle`, `addDependency`, `hasUnmetDependencies`, `findUnblockedDependents` | 75 | Called within transactions |
| `artifact-ops.ts` | `createArtifact`, `publishArtifact`, `verifyArtifact`, `linkTaskArtifact`, `computeChecksum`, `findArtifactByName`, `validateArtifactPath` | 101 | TOCTOU-safe (try-catch ENOENT) |
| `task-ops.ts` | `createTask`, `createTaskBatch`, `updateTask` | 183 | All IMMEDIATE |
| `task-lifecycle.ts` | `claimTask`, `completeTask`, `failTask`, `cancelTask` | 229 | All IMMEDIATE |
| `message-ops.ts` | `sendMessage`, `getInbox`, `getUnreadCount`, `postCheckpoint` | 109 | All IMMEDIATE |
| `agent-ops.ts` | `registerAgent`, `updateHeartbeat`, `getStaleAgents`, `recoverDeadClaim`, `getActiveAgents`, `getAgent` | 87 | `recoverDeadClaim` IMMEDIATE |
| `session-ops.ts` | `initSession`, `readRegistry`, `setCurrentSession`, `getCurrentSession`, `removeFromRegistry`, `getSessionDbPath`, `getSessionDir` | 183 | PID-based file lock |
| `plan-ops.ts` | `createPlan`, `updatePlanStatus`, `getPlan`, `listPlans`, `addPlanReview`, `addResearchPacket`, `getResearchPackets`, `linkPlanTask`, `getPlanTaskIds` | ~170 | PLAN_TRANSITIONS state machine | **Dormant:** exported, test-covered, not wired into MCP/CLI |
| `evidence-ops.ts` | `createAttempt`, `completeAttempt`, `getTaskAttempts`, `getLatestAttempt`, `addEvidence`, `reviewEvidence`, `getAttemptEvidence`, `hasAcceptedEvidence` | ~130 | Single-statement | **Dormant:** exported, test-covered, not wired into MCP/CLI |
| `execution-target-ops.ts` | `createExecutionTarget`, `getExecutionTarget`, `listExecutionTargets`, `findTargetByPaneIndex`, `getTargetCapabilities`, `targetHasCapability`, `ensureTmuxPaneTarget` | ~100 | Single-statement | **Dormant:** exported, test-covered, not wired into MCP/CLI |
| `lifecycle-bridge.ts` | `logLifecycleEvent`, `getLifecycleEvents`, `pruneLifecycleEvents` | ~50 | Single-statement | **Dormant:** exported, test-covered, not wired into MCP/CLI |
| `collaboration-patterns.ts` | `PATTERN_REGISTRY`, `getPattern`, `validatePatternRoles`, `patternRequiresEvidence`, `listPatterns` | ~100 | N/A (pure functions) | **Dormant:** exported, test-covered, not wired into MCP/CLI |
| `migrations.ts` | `getSchemaVersion`, `runMigrations` | ~120 | IMMEDIATE per migration |
| `index.ts` | Re-exports all modules | 17 | N/A |

### Key Patterns

**Task claiming (optimistic locking):**
```
UPDATE tasks SET status='claimed', owner=?, claimed_at=?
WHERE id = (SELECT id FROM tasks WHERE status='pending' ... LIMIT 1)
  AND status='pending'
```
The redundant `AND status='pending'` ensures the UPDATE fails (changes=0) if a concurrent writer claimed between subquery evaluation and outer UPDATE.

**Dependency cascade:**
`completeTask` → `findUnblockedDependents` uses recursive CTE to find all dependents whose dependencies are now fully completed, then transitions them `blocked → pending`.

**Retry backoff:**
`failTask` computes `retry_after = now + 30 * 2^retry_count` seconds. Retriable reasons: `crash`, `timeout`. Non-retriable: `logic_error`, `artifact_missing`, `dependency_invalid`. Non-retriable failures go directly to `needs_review` without incrementing `retry_count`.

**Dead-claim recovery:**
`recoverDeadClaim(agentId)` finds all claimed tasks for a stale agent. If `retry_count < max_retries`, sets `status='pending'` and increments `retry_count`. Otherwise sets `status='needs_review'` without incrementing. Always sets `failure_reason='timeout'` and marks agent `'shutdown'`.

**Broadcast isolation:**
`getInbox(agent, markRead=true)` only marks `read_at` on messages where `to_agent IS NOT NULL` (direct messages). Broadcasts (`to_agent IS NULL`) are never marked read, so all agents can consume them.

**Session registry locking:**
`acquireLock()` uses exclusive file creation (`flag: 'wx'`). On conflict, reads PID from lock file, checks liveness via `process.kill(pid, 0)`. Stale if PID dead or mtime > 10s. `releaseLock()` validates PID ownership before unlinking. 50 attempts with 10-50ms jitter.

---

## 5. MCP Server

**Package:** `@tmup/mcp-server` | **Entry:** `dist/index.js` (esbuild bundle)
**Dependencies:** `@modelcontextprotocol/sdk`, `zod`, `@tmup/shared`
**Transport:** stdio (Claude Code spawns as child process)

### 18 MCP Tools

| Tool | Category | Description |
|------|----------|-------------|
| `tmup_init` | Session | Initialize/reattach DB and session registry for project_dir (does not create tmux panes) |
| `tmup_status` | Session | Status summary + dead-claim recovery side-effect |
| `tmup_next_action` | Session | Synthesized recommendation (priority-ordered decision tree) |
| `tmup_pause` | Session | Broadcast shutdown messages to all agents |
| `tmup_resume` | Session | Re-attach session, run dead-claim recovery |
| `tmup_teardown` | Session | Grace period shutdown with agent notification |
| `tmup_task_create` | DAG | Create single task with deps/artifacts |
| `tmup_task_batch` | DAG | Atomic multi-task creation (IMMEDIATE transaction) |
| `tmup_task_update` | DAG | Lead status transitions (needs_review→pending, etc.) |
| `tmup_claim` | Lifecycle | Claim highest-priority pending task for agent |
| `tmup_complete` | Lifecycle | Mark done, cascade unblock dependents |
| `tmup_fail` | Lifecycle | Report failure — auto-retry with backoff or escalate to needs_review |
| `tmup_cancel` | Lifecycle | Cancel task, optional cascade to dependents |
| `tmup_checkpoint` | Communication | Post progress update, update result_summary |
| `tmup_send_message` | Communication | Send direct/broadcast/finding/blocker |
| `tmup_inbox` | Communication | Check unread count or read messages with framing |
| `tmup_dispatch` | Execution | Atomic claim+register, launch Codex in pane |
| `tmup_harvest` | Monitoring | Capture pane scrollback (validated args) |

### `tmup_next_action` Decision Tree

1. `needs_review` tasks → "Review and reset or cancel"
2. Unread blocker messages → "Resolve before proceeding" (content-framed)
3. Recently unblocked tasks → "Assign to {role}"
4. Idle panes + pending tasks → "Dispatch next highest-priority"
5. All tasks complete → "Ready for teardown"
6. Default → "No action needed" (waiting status)

### Server Lifecycle

- **Lazy DB:** Connection opened on first tool call (not at startup)
- **Session switching:** `switchSession()` cleanly closes old connection, opens new. Failure rolls back to null state.
- **WAL checkpoint timer:** 60s interval `wal_checkpoint(PASSIVE)` to prevent WAL file growth
- **Crash resilience:** `uncaughtException` handler with 10-exception threshold before exit
- **Content framing:** Worker messages wrapped in `[WORKER MESSAGE from {agent}, type={type}]...[END WORKER MESSAGE]` for prompt injection defense

---

## 6. CLI (`tmup-cli`)

**Package:** `@tmup/cli` | **Binary:** `dist/tmup-cli.js` (esbuild bundle)
**Environment variables:** `TMUP_AGENT_ID`, `TMUP_DB`, `TMUP_PANE_INDEX`, `TMUP_SESSION_NAME`, `TMUP_SESSION_DIR`, `TMUP_WORKING_DIR`, `TMUP_TASK_ID`

### 9 Commands

| Command | Usage | Notes |
|---------|-------|-------|
| `claim` | `claim [--role X]` | Returns highest-priority pending task matching role |
| `complete` | `complete "summary" [--artifact name:path]` | Auto-detects active task if no --task-id |
| `fail` | `fail --reason crash "message"` | Validates reason against enum at CLI boundary |
| `checkpoint` | `checkpoint "message"` or `checkpoint <task_id> "message"` | 1-arg vs 2-arg disambiguation |
| `message` | `message --to lead "text"` or `--broadcast` | Defaults to_agent to "lead" |
| `inbox` | `inbox [--mark-read]` | Without flag: count only. With flag: full messages |
| `heartbeat` | `heartbeat [--codex-session-id ID]` | Auto-registers agent if not exists |
| `status` | `status` | Current task + unread count |
| `events` | `events [--limit N] [--type TYPE]` | Query audit event log. Default limit 50. |

### Exit Codes

| Code | Class | Condition |
|------|-------|-----------|
| 0 | Success / Business logic | Tool result returned (even NO_PENDING_TASKS) |
| 1 | CLI error | Missing env vars, bad args (`CliError` class) |
| 2 | System error | Uncaught exception |

Success output is JSON to stdout. CLI-level errors (`CliError`) go to stdout as structured JSON and exit 1. System errors go to stderr as JSON and exit 2. Structured error shape: `{ok: false, error: "ERROR_CODE", message: "..."}`.

---

## 7. Bash Scripts

### Main Scripts (5)

| Script | Purpose | LOC |
|--------|---------|-----|
| `grid-setup.sh` | Create tmux NxM grid (default 2x4), write grid-state.json | 165 |
| `grid-teardown.sh` | Kill tmux session, deregister from registry | 29 |
| `dispatch-agent.sh` | Launch Codex worker in pane with env vars | 175 |
| `pane-manager.sh` | List/release pane reservations in grid-state.json | 50 |
| `trust-sweep.sh` | Auto-accept trust prompts across all panes | 22 |

### Library Scripts (6)

| Script | Purpose | LOC |
|--------|---------|-----|
| `lib/config.sh` | YAML config loader (via yq), env validation, all `CFG_*` exports | 85 |
| `lib/validators.sh` | `validate_pane_index`, `validate_role`, `validate_working_dir` | 47 |
| `lib/tmux-helpers.sh` | `is_agent_process`, `wait_for_shell_ready`, `strip_ansi` | 33 |
| `lib/grid-registry.sh` | Multi-grid project-to-session registry (JSON + mkdir-lock) | 70 |
| `lib/grid-identity.sh` | Grid ownership tracking (PID-based) with `jq -n` safe JSON | 36 |
| `lib/prerequisites.sh` | Verify tmux (>=3.0), node, jq installed | 27 |

### Security Patterns

- **No shell interpolation in `tmux send-keys`**: `dispatch-agent.sh` writes env vars to a launcher wrapper script using `printf '%q'`, then sends `bash '$LAUNCHER'` to the pane.
- **`jq -n` for JSON construction**: `grid-setup.sh` and `grid-identity.sh` build JSON entirely through `jq --arg`/`--argjson` — never heredoc interpolation.
- **File descriptor locking**: `grid-registry.sh` uses portable `mkdir`-based locking; `pane-manager.sh` uses `flock` on a lock file for atomic JSON read-modify-write.
- **Restrictive permissions**: `umask 0077`, `chmod 600` for state files, `chmod 700` for launcher scripts.

---

## 8. Agent Definitions

Six agent role definitions in `agents/*.md`. Each has frontmatter (`name`, `description`) and a body containing:
- Role description
- Full `tmup-cli` reference with examples
- Error recovery table
- Autonomy tier documentation
- Role-specific constraints

| Agent | Autonomy | Messaging | Focus |
|-------|----------|-----------|-------|
| `implementer` | Checkpoint | Lead only | Write production code |
| `tester` | Checkpoint | Lead only | Write/run tests, report evidence |
| `reviewer` | Full participant | Any agent | Code review, findings |
| `investigator` | Full participant | Any agent | Deep analysis, debugging |
| `refactorer` | Checkpoint | Lead only | Restructure without behavior change |
| `documenter` | Checkpoint | Lead only | Write docs from source |

**Autonomy tiers:**
- **Checkpoint:** Can only message lead. Post checkpoints at milestones. Cannot broadcast.
- **Full participant:** Can message any agent or broadcast. Can ask clarifying questions to peers.

Agent definitions are injected into the Codex worker prompt by `dispatch-agent.sh` (frontmatter stripped via awk).

---

## 9. Skill & Command

### Slash Command (`commands/tmup.md`)

Registered as `/tmup` in Claude Code. Frontmatter declares all 18 MCP tools in `allowed-tools`. Body documents:
- Usage patterns (`/tmup`, `/tmup init`, `/tmup status`, `/tmup next`, `/tmup teardown`)
- 5-step workflow (initialize → plan → execute → monitor → complete)
- Task DAG semantics
- Role/autonomy/messaging table

### Skill (`skills/tmup/SKILL.md`)

Loaded when tmup-related work is detected. Contains:
- Quick start guide
- Full 18-tool reference table
- Task lifecycle state machine
- Workflow example with real tool calls
- Key design decisions

### Reference (`skills/tmup/REFERENCE.md`)

Complete API reference for all 18 MCP tools and 9 CLI commands with:
- Input/output JSON examples for every tool
- Valid transition documentation
- CLI env var requirements
- Exit code semantics

---

## 10. Configuration

### `config/policy.yaml`

| Section | Key | Default | Purpose |
|---------|-----|---------|---------|
| `dag` | `default_priority` | 50 | New task priority |
| `dag` | `max_retries` | 3 | Retry limit |
| `dag` | `retry_backoff_base_seconds` | 30 | Backoff formula base |
| `dag` | `stale_max_age_seconds` | 300 | Heartbeat staleness threshold |
| `grid` | `session_prefix` | "tmup" | Session name prefix |
| `grid` | `rows` / `cols` | 2 / 4 | Grid dimensions |
| `grid` | `width` / `height` | 240 / 55 | Terminal character dimensions |
| `harvesting` | `capture_scrollback_lines` | 500 | Default harvest depth |
| `harvesting` | `poll_interval_seconds` | 30 | Harvest polling interval |
| `timeouts` | `dispatch_trust_prompt_seconds` | 6 | Trust prompt auto-accept window |
| `timeouts` | `teardown_grace_seconds` | 60 | Graceful shutdown timeout |
| `timeouts` | `pause_checkpoint_seconds` | 30 | Pause checkpoint window |
| `autonomy` | `full_participant_roles` | investigator, reviewer | Full messaging |
| `autonomy` | `checkpoint_roles` | implementer, tester, refactorer, documenter | Lead-only messaging |
| `collaboration` | `patterns` | research, plan, implement, review, test, audit, document | Reusable workflow patterns |
| `lifecycle` | `prune_max_age_seconds` | 86400 | Lifecycle event retention (24h) |
| `lifecycle` | `enabled_events` | claude_session_start/end, claude_precompact, claude_task_completed, claude_subagent_stop | Claude-native events for tmup ingress |

Loaded by `lib/config.sh` via `yq` with hardcoded defaults as fallback.

---

## 11. Build System

### Monorepo Structure (npm workspaces)

```
tmup/
├── package.json          # Root: workspaces, devDependencies, test scripts
├── shared/               # @tmup/shared — TypeScript library (tsc → dist/)
│   └── package.json      # main: dist/index.js, types: dist/index.d.ts
├── mcp-server/           # @tmup/mcp-server — esbuild bundle
│   └── package.json      # build: tsc --noEmit && esbuild → dist/index.js
├── cli/                  # @tmup/cli — esbuild bundle
│   └── package.json      # build: tsc --noEmit && esbuild → dist/tmup-cli.js
└── vitest.config.ts      # Test configuration
```

**Build pipeline:**
1. `shared`: `tsc` → generates `dist/*.js` + `dist/*.d.ts` (consumed by mcp-server and cli)
2. `mcp-server`: `tsc --noEmit` (type-check only) → `esbuild --bundle --external:better-sqlite3`
3. `cli`: Same as mcp-server → outputs `dist/tmup-cli.js`

**Key build decisions:**
- `better-sqlite3` is `--external` in esbuild (native addon, can't be bundled)
- TypeScript strict mode across all packages
- Target: ES2022 with Node16 module resolution
- `shared/tsconfig.json` has `composite: true` for project references
- Test files run directly from TypeScript source (vitest handles transpilation)

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `better-sqlite3` | ^12.4.1 | SQLite3 native binding |
| `js-yaml` | ^4.1.0 | YAML config parsing |
| `@modelcontextprotocol/sdk` | ^1.20.0 | MCP server framework |
| `zod` | ^3.25.76 | Schema validation (declared, minimally used) |
| `typescript` | ^5.9.3 | Type checking |
| `esbuild` | ^0.25.11 | Bundle MCP server and CLI |
| `vitest` | ^3.2.4 | Test runner |

---

## 12. Test Suite

**Runner:** Vitest | **Config:** `vitest.config.ts` | **24 files, 621 tests**

| Test File | Tests | Coverage Focus |
|-----------|-------|---------------|
| `tests/shared/db.test.ts` | 10 | WAL pragmas, 17 tables, idempotent opens, 0600 perms, pragma values, table constraints, migration framework, schema versioning |
| `tests/shared/id.test.ts` | 12 | nextTaskId (empty/increment/gaps/padding/overflow), UUID format + uniqueness |
| `tests/shared/event-ops.test.ts` | 15 | logEvent fields/null actor/no payload, filter/limit/ordering, pruneEvents boundary, bounded batch pruning |
| `tests/shared/dep-resolver.test.ts` | 32 | checkCycle (direct/transitive/diamond/self), addDependency (valid/cycle/not-found/idempotent/self/re-block), hasUnmetDependencies, findUnblockedDependents, traversal depth limit, transitive dependents, stress (50-node dense graph) |
| `tests/shared/task-lifecycle.test.ts` | 81 | createTask (IDs/blocked/pending/limit/defaults), batch (atomic/intra-deps/rollback), claim (priority/FIFO/null/role/retry_after/blocked/concurrent/one-task-per-agent), complete (cascade/wrong-status/blocked/actor-ownership/stale-field-clear), fail (all 5 reasons/backoff/exhausted/actor-enforcement), cancel (cascade/no-cascade/skip-completed/transitive-needs-review), updateTask (all transitions/field updates/max-retries-floor), dispatch-claim integration |
| `tests/shared/message-ops.test.ts` | 33 | sendMessage (direct/broadcast/forced-null/payload-limit/task_id/sender-validation/recipient-validation), getInbox (chrono/mark-read/agent-isolation), postCheckpoint (fields/non-owner/lead-override/active-state-only/overwrite), broadcast isolation, message pruning (batch-limited), global message limits |
| `tests/shared/agent-ops.test.ts` | 19 | register (fields/no-role/re-register), heartbeat (timestamp/codex-session), stale (selective/shutdown-excluded/two-phase-idle), recoverDeadClaim (retry/needs_review/empty/multi-task), getActiveAgents, getAgent |
| `tests/shared/artifact-ops.test.ts` | 22 | create/publish/verify (pending/available/missing/stale/ENOENT), link (idempotent), checksum (SHA-256/size-cap), findByName, validateArtifactPath (containment/symlink-escape/device-file/canonical-path) |
| `tests/shared/session-ops.test.ts` | 29 | readRegistry (corruption backup/structural validation), initSession (new/reattach/canonical-path), setCurrentSession (temp+rename/permissions), removeFromRegistry, getSessionDbPath, getSessionDir, session-name validation (path-traversal/null-bytes/length), current-session validation |
| `tests/shared/next-action.test.ts` | 12 | Priority routing (needs_review/blocker/unblocked/dispatch/all-complete/waiting), pane count awareness |
| `tests/shared/schema-parity.test.ts` | 40 | Enum parity (task status/failure reason/message type/event type vs TS), dead state removal, partial unique indexes, migration preflight, constraint coverage |
| `tests/shared/fuzz-edges.test.ts` | 15 | Overlong strings, boundary integers, special characters, rapid-fire claim/fail, malformed artifact paths, concurrent message send |
| `tests/shared/plan-ops.test.ts` | 39 | Plan creation, state transitions (PLAN_TRANSITIONS), reviews with auto-transition, research packets, plan-task linkage |
| `tests/shared/evidence-ops.test.ts` | 30 | Attempt lifecycle (running→succeeded/failed/abandoned), evidence packets, reviewer disposition, hasAcceptedEvidence |
| `tests/shared/execution-target-ops.test.ts` | 23 | Target CRUD, capability parsing, pane-index lookup, ensureTmuxPaneTarget migration helper |
| `tests/shared/collaboration-patterns.test.ts` | 57 | Pattern registry (7 patterns), role validation, evidence requirements, pattern properties |
| `tests/shared/lifecycle-bridge.test.ts` | 13 | Lifecycle event logging/filtering/pruning, session_id association |
| `tests/integration/full-lifecycle.test.ts` | 15 | Full workflow create→claim→checkpoint→complete→cascade, concurrent claim, message flow, dead-claim recovery, fail+retry, cascade cancel, broadcast isolation, mixed fail reasons, actor ownership enforcement |
| `tests/shared/grid-state.test.ts` | 15 | Grid state reading, pane count resolution |
| `tests/shared/system-inventory-parity.test.ts` | 29 | SYSTEM-INVENTORY.md parity with source (module counts, export lists, table counts) |
| `tests/mcp/handle-tool-call.test.ts` | 28 | Dispatch contract, resume, actor enforcement, input validation, pause/harvest, tmup_init/status |
| `tests/cli/handle-command.test.ts` | 31 | Actor identity, fail validation, exit codes, checkpoint contract, message routing, heartbeat validation |
| `tests/scripts/grid-registry.test.ts` | 6 | Shell registry CRUD, canonical path matching, lock semantics |
| `tests/scripts/config-shell-boundary.test.ts` | 15 | Session name resolution from current-session pointer, TMUP_SESSION_NAME precedence, validation, state directory derivation |

**Test patterns:**
- Each test uses a unique temp DB path with `Date.now()` + random suffix
- `afterEach` cleans up DB + WAL + SHM files
- Backdated timestamps via SQL `strftime('now', '-N seconds')` for staleness testing
- Tolerance-based comparisons for backoff timing
- Direct SQL assertions alongside API-level checks

---

## 13. State & Runtime

### State Directory Structure

```
~/.local/state/tmup/
├── current-session           # Points to active session ID
├── registry.json             # Session-to-project mapping
├── registry.lock             # PID-based file lock
└── tmup-<hex>/               # Per-session directory
    ├── tmup.db               # SQLite WAL database
    ├── tmup.db-wal           # WAL file
    ├── tmup.db-shm           # Shared memory
    ├── grid-identity.json    # Grid ownership (PID, session, hostname)
    ├── grid/
    │   ├── grid-state.json   # Pane assignments and status
    │   └── grid-state.lock   # flock for atomic grid updates
    ├── logs/                 # (Reserved for future use)
    ├── artifacts/            # Artifact storage
    ├── prompt-N-UUID.txt     # Worker prompt files (ephemeral — cleaned up before exec)
    └── launcher-N.sh         # Worker launcher scripts (ephemeral — self-deleting)
```

### Registry Format (`registry.json`)

```json
{
  "sessions": {
    "tmup-a3f1b2": {
      "session_id": "tmup-a3f1b2",
      "project_dir": "/path/to/your/project",
      "db_path": "~/.local/state/tmup/tmup-a3f1b2/tmup.db",
      "created_at": "2026-03-12T15:30:00.000Z"
    }
  }
}
```

### Grid State Format (`grid-state.json`)

```json
{
  "schema_version": 2,
  "session_name": "tmup-a3f1b2",
  "project_dir": "/path/to/your/project",
  "created_at": "2026-03-12T15:30:00+00:00",
  "grid": {"rows": 2, "cols": 4},
  "panes": [
    {"index": 0, "pane_id": "%0", "status": "available"},
    {"index": 1, "pane_id": "%1", "status": "reserved", "role": "implementer", "agent_id": "uuid"}
  ]
}
```

---

## 14. Security Hardening

### Applied Fixes (51 total across 7 rounds)

**Round 1 (Plan fixes):**
1. Pragma allowlist validation in `db.ts`
2. Broadcast read poisoning fix in `message-ops.ts`
3. Atomic `createTask` (IMMEDIATE transaction)
4. Atomic `createTaskBatch` (inlined, no nested IMMEDIATE)
5. `validateArtifactPath` traversal fix (resolved path prefix check)
6. `claimTask` retrieval by `claimed_at` timestamp
7. `tmup_checkpoint` agent_id parameter added
8. `tmup_dispatch` changes===0 check
9. Registry file locking (`acquireLock`/`releaseLock`)
10. Dead-claim recovery `retry_count` fix (no increment for needs_review)
11. `CliError` class for exit code consistency
12. Content framing for worker messages

**Round 2 (Transaction safety):**
13. `updateTask` wrapped in IMMEDIATE
14. `sendMessage` wrapped in IMMEDIATE
15. `postCheckpoint` wrapped in IMMEDIATE (inlined message insert)
16. `tmup_harvest` pane_index/lines validation (shell injection defense)
17. `tmup_dispatch` atomic claim+register transaction
18. `switchSession` try/catch with state cleanup

**Round 3 (Shell + script hardening):**
19. `dispatch-agent.sh` env vars via `printf '%q'`
20. `grid-setup.sh` JSON via `jq -n`
21. `grid-identity.sh` JSON via `jq -n`
22. CLI checkpoint 1-arg vs 2-arg fix
23. CLI fail reason validation at boundary
24. `verifyArtifact` TOCTOU fix (try-catch ENOENT)
25. `releaseLock` PID ownership validation
26. `tmup_next_action` reads actual pane count from grid-state.json
27. `writeRegistry` writes with `mode: 0o600`

**Round 4 (Source bug):**
28. `failTask` needs_review path no longer increments `retry_count`

**Round 5 (Observability + maintenance):**
29. `runMaintenance` returns structured `{warnings, errors}` with backlog detection
30. `mcp-server/index.ts` consecutive failure tracking for maintenance
31. Registry corruption backup-and-recover pattern (JSON parse vs structural)
32. `setCurrentSession` temp+rename pattern with 0o600 permissions

**Round 6 (Shell boundary + dead code removal):**
33. Trust prompt narrowing: anchored `^\s*Do you trust\b` pattern
34. Launcher self-cleanup: reads prompt into memory, deletes temp files before exec
35. Dead code removal: `artifact-writer.sh` (path traversal), `session-identity.sh` (unused)
36. `REFERENCE.md` updated: `TMUP_WORKING_DIR` env var added

**Round 7 (Adversarial review fixes):**
37. TOCTOU fix: `dispatch-agent.sh` holds grid-state lock through pane-occupancy check
38. `registry_lookup` fails closed on canonicalization failure (no raw input fallback)
39. Maintenance failure counter uses `===` instead of `>=` (log once, not every cycle)
40. `pane-manager.sh` release dies on unknown options instead of silently discarding
41. `config.sh` warns when current-session pointer contains invalid session ID
42. `grid-setup.sh` warns on styling script failure instead of silent suppression
43. `next_action` grid-state error message differentiates ENOENT vs unreadable
44. `next-action.ts` iterates through all unblocked events instead of only checking index 0
45. `grid-teardown.sh` cleans up current-session pointer when tearing down active session
46. `grid-setup.sh` validates pane count matches expected grid layout after creation
47. `dispatch-agent.sh` validates agent instructions are non-empty after frontmatter extraction
48. `dispatch-agent.sh` checks send-keys exit status on launch, rolls back pane reservation on failure
49. `grid-teardown.sh` makes kill and deregister independent so partial failures don't cascade
50. `grid-identity.sh` fails closed on corrupted identity file instead of granting ownership
51. `completeTask` throws on unregistered artifact instead of silently skipping publication

### Defense Layers

| Vector | Defense |
|--------|---------|
| SQL injection | Parameterized queries everywhere (never string interpolation in SQL) |
| Shell injection | `printf '%q'` for env vars, `jq -n` for JSON, validated pane_index/lines |
| Prompt injection | Content framing (`[WORKER MESSAGE]...[END WORKER MESSAGE]`) |
| Path traversal | `validateArtifactPath` checks resolved path starts with project dir; canonical realpath |
| Race conditions | IMMEDIATE transactions on all read-then-write; grid-state lock held through pane check |
| TOCTOU | `verifyArtifact` catches ENOENT; dispatch lock covers check+reserve atomically |
| Lock poisoning | PID liveness check, mtime staleness, ownership validation; fail closed on lock failure |
| Pragma injection | Allowlist with type validation |
| State corruption | `switchSession` rolls back on failure; temp+rename for registry/session writes |
| Silent failure | Structured maintenance results; invalid session-pointer warnings; canonicalization fail-closed |
| Dead code | Removed `artifact-writer.sh` (path traversal vector), `session-identity.sh` (unused) |

---

## 15. File Manifest

```
.claude-plugin/
  marketplace.json               # Marketplace registration metadata
  plugin.json                    # Plugin registration (MCP server definition)

agents/
  documenter.md                  # Documenter agent role definition
  implementer.md                 # Implementer agent role definition
  investigator.md                # Investigator agent role definition
  refactorer.md                  # Refactorer agent role definition
  reviewer.md                    # Reviewer agent role definition
  tester.md                      # Tester agent role definition

cli/
  package.json                   # @tmup/cli package definition
  tsconfig.json                  # TypeScript config (strict, ES2022, Node16)
  src/
    index.ts                     # CLI entry point (CliError, exit codes)
    commands/
      index.ts                   # 9 CLI command handlers

commands/
  tmup.md                        # /tmup slash command definition

config/
  policy.yaml                    # Grid, DAG, harvesting, timeout, autonomy config
  runtime-contract.json          # SQLite pragma values (WAL, busy_timeout, etc.)
  schema.sql                     # 8-table base schema + 9 migration tables = 17 total

mcp-server/
  package.json                   # @tmup/mcp-server package definition
  tsconfig.json                  # TypeScript config
  src/
    index.ts                     # MCP server lifecycle (lazy DB, WAL timer, crash guard)
    tools/
      index.ts                   # 18 MCP tool definitions and handlers

scripts/
  dispatch-agent.sh              # Launch Codex worker in tmux pane
  grid-setup.sh                  # Create tmux NxM grid (default 2x4)
  grid-teardown.sh               # Tear down tmux session
  pane-manager.sh                # Manage pane reservations
  trust-sweep.sh                 # Auto-accept trust prompts
  lib/
    config.sh                    # YAML config loader, CFG_* exports
    grid-identity.sh             # Grid ownership (PID-based)
    grid-registry.sh             # Multi-grid project-to-session registry
    prerequisites.sh             # Tool version checks (tmux >= 3.0)
    tmux-helpers.sh              # Process detection, shell ready, ANSI strip
    validators.sh                # Input validation (pane index, role, directory)

shared/
  package.json                   # @tmup/shared package definition
  tsconfig.json                  # TypeScript config (composite: true)
  src/
    index.ts                     # Re-exports all modules
    types.ts                     # All type definitions
    db.ts                        # Database init (pragma allowlist, schema, perms)
    id.ts                        # ID generation (sequential tasks, UUID agents/msgs)
    event-ops.ts                 # Event logging and pruning
    dep-resolver.ts              # Cycle detection, dependency resolution
    artifact-ops.ts              # Artifact CRUD, checksum verification
    task-ops.ts                  # Task CRUD (createTask, createTaskBatch, updateTask)
    task-lifecycle.ts            # Claim, complete, fail, cancel
    message-ops.ts               # Messaging, inbox, checkpoints
    agent-ops.ts                 # Agent registration, heartbeat, dead-claim recovery
    session-ops.ts               # Session registry with file locking
    grid-state.ts                # Grid state reader (pane count resolution)
    constants.ts                 # Runtime constants (enums, defaults, EVENT_TYPES)
    plan-ops.ts                  # Plan CRUD, state machine, reviews, research packets
    evidence-ops.ts              # Task attempts, evidence packets, accepted-evidence checks
    execution-target-ops.ts      # Execution target abstraction (tmux_pane, local_shell, codex_cloud)
    lifecycle-bridge.ts          # Claude-native lifecycle event ingress to tmup
    collaboration-patterns.ts    # Reusable workflow pattern registry (7 patterns)
    migrations.ts                # Schema versioning and migration runner (v1-v3)

skills/tmup/
  SKILL.md                       # Skill definition (quick start, tool table)
  REFERENCE.md                   # Complete API reference for all tools and commands

tests/
  shared/
    db.test.ts                   # 7 tests — database initialization
    id.test.ts                   # 12 tests — ID generation
    event-ops.test.ts            # 9 tests — event logging/pruning
    dep-resolver.test.ts         # 20 tests — cycle detection, dependencies
    task-lifecycle.test.ts       # 55 tests — full task lifecycle
    message-ops.test.ts          # 20 tests — messaging and checkpoints
    agent-ops.test.ts            # 13 tests — agent management
    artifact-ops.test.ts         # 16 tests — artifact tracking
    session-ops.test.ts          # 8 tests — session registry
    plan-ops.test.ts             # Plan ops integration tests
    evidence-ops.test.ts         # Evidence ops integration tests
    execution-target-ops.test.ts # Execution target integration tests
    collaboration-patterns.test.ts # Pattern registry unit tests
    lifecycle-bridge.test.ts     # Lifecycle bridge integration tests
  integration/
    full-lifecycle.test.ts       # 10 tests — end-to-end integration

package.json                     # Root workspace definition
vitest.config.ts                 # Test configuration
```
