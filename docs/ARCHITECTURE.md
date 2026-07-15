[< Back to README](../README.md)

# Architecture

## System overview

```
Claude Code (Lead)
  |
  +- MCP Server (20 tools)
  |    |  The brain stem. Claude calls these tools to manage
  |    |  the task DAG, dispatch workers, read messages, and
  |    |  harvest output. It runs as a Node.js process that
  |    |  Claude spawns at session start.
  |    |
  |    +- @tmup/shared (SQLite WAL)
  |         +- tmup.db (17 tables)
  |              Controller-owned coordination state. The lead-side
  |              tools claim, checkpoint, message, and complete on
  |              behalf of safe workers after harvesting output.
  |
  +- Bash Scripts
  |    |  The muscle. These create tmux grids, launch Codex
  |    |  processes, manage pane reservations, and handle
  |    |  cleanup. Yes, it's bash. Yes, it works. No, we
  |    |  will not rewrite it in Rust.
  |    |
  |    +- grid-setup.sh      (create NxM tmux grid)
  |    +- dispatch-agent.sh  (launch Codex in pane)
  |    +- grid-teardown.sh   (cleanup)
  |    +- lib/               (config, registry, validation)
  |
  +- tmux Grid (2x4 default)
       |
       +- Codex Workers (safe default)
            |  The workforce. Each Codex process gets a prompt,
            |  a role, and a workspace-write sandbox. They do the
            |  work and report evidence in pane output. The initial
            |  prompt does not advertise tmup-cli or direct DB access.
            |
            +- supervisor claim -> work -> harvest -> supervisor complete
            +- one exact task-temp add-dir; no session-state add-dir
```

## Worker and controller boundary

Safe Codex panes use `workspace-write`, `sandbox_workspace_write.network_access=false`, `exclude_slash_tmp=true`, and `exclude_tmpdir_env_var=true`. Direct shell network access is disabled; mediated Codex web search may still be available. The only extra writable `--add-dir` is one exact mode-0700 task temp under a protected controller root, outside the project working directory, tmup session directory, and every controller-interpreted artifact path. `TMPDIR`, `TMP`, and `TEMP` point to that child. This constrains writes but does not provide exhaustive read isolation or protection from a separately authorized same-UID unsandboxed process.

Beyond Codex's core inherited command environment, tmup explicitly sets only `TMUP_AGENT_ID`, `TMUP_PANE_INDEX`, `TMUP_WORKING_DIR`, optional `TMUP_TASK_ID`, and the three task-temp variables. It does not set `TMUP_DB` or `TMUP_SESSION_DIR`. Prompt, launcher, and log artifacts live under `~/.local/state/tmup-control/<session>/`, outside working/session/task roots. Prompts and logs are mode 0600, launchers are mode 0700, and prompt/launcher hashes and modes are checked before use. Teardown validates the canonical boundary and removes only the exact controller session root.

Deterministic tests cover the assigned task temp and protected controller boundaries. Host- and release-specific live sandbox canaries remain pending; no cross-version or cross-host sandbox guarantee is claimed.

`codex.model: "auto"` means tmup omits `-m`, leaving default-model selection to the installed Codex CLI. An explicit pin requires `codex.explicit_model_pins_enabled: true` and a per-dispatch `--model-validation-receipt`; this records a requested configuration, not the model actually served. Direct dispatch accepts explicit absolute `CODEX_BIN`, then `~/.local/bin/codex`, then the fixed controller `PATH`. MCP resolves a validated absolute Codex executable from `~/.local/bin/codex` or its original process `PATH` before filtering controller utilities.

The MCP dispatch path is intentionally narrower than the direct script: it supports only safe Codex workers and removes ambient shell-inheritance, tier-activation, trust, and shared-state overrides before launch. It rejects `claude_code` before registration or claim. The supervisor owns task claim/lifecycle/message operations and harvests worker output; safe workers do not invoke `tmup-cli` directly. Harvested scrollback is ANSI-stripped, framed as `UNTRUSTED PANE OUTPUT`, and returned with an explicit trust label; worker-printed marker text is neutralized first.

Two direct-only escape hatches are fail-closed:

- Trusted shared-state Codex requires `codex.trusted_shared_state_enabled: true`, `--trusted-shared-state`, and `--trusted-shared-state-receipt`. It adds the session directory and exposes `TMUP_DB`/`TMUP_SESSION_DIR`, so its integrity is advisory same-UID trust rather than peer isolation.
- Trusted Claude Code requires `claude_code.trusted_unsandboxed_enabled: true`, `--worker-type claude_code`, `--allow-unconfined-claude-code`, and `--claude-code-trust-receipt`. It runs with `bypassPermissions` and is outside the Codex sandbox guarantee.

Static tier TOMLs remain dormant and default-off. The dispatcher does not activate or advertise them. Native Codex children inherit their pane model unless the live spawn surface proves named-role selection.

## The task DAG

Tasks form a directed acyclic graph. If you don't know what that means: it's a tree where tasks can depend on other tasks, but nothing can depend on itself (not even indirectly). If you try to create a cycle, tmup will politely refuse.

```
[Define schema]------------------+
       |                         |
       v                         v
[Implement models]        [Write migrations]
       |                         |
       v                         |
[Write tests]<-------------------+
       |
       v
[Code review]
```

When "Define schema" completes, "Implement models" and "Write migrations" both unblock automatically. When both of those complete, "Write tests" unblocks. This is the cascade. It's the best part of the system. You create the plan, set the dependencies, and the cascade does the rest.

Tasks are created atomically via `tmup_task_batch`. Intra-batch dependencies are allowed -- tasks are inserted in array order, so later tasks can depend on earlier ones. Priority determines claim order when multiple tasks are pending.

## Task lifecycle

```
                +----------------------------------+
                |                                  |
                v                                  |
 +---------+  claim  +---------+  complete  +-------------+
 | pending |-------->| claimed |---------->|  completed  |
 +---------+         +---------+            +-------------+
      ^                   |                  (cascades: unblocks
      |                   |                   dependent tasks)
      |                   | fail (retriable)
      |                   | + backoff
      |                   |
      |                   v
      |              +--------------+
      +--------------| pending      |  (retry with exponential
                     | (retry_after)|   backoff, up to max_retries)
                     +--------------+
                          |
                          | fail (non-retriable OR
                          |       retries exhausted)
                          v
                     +--------------+
                     | needs_review |  (lead must intervene)
                     +--------------+

 +---------+  deps met  +---------+
 | blocked |---------->| pending |  (automatic on dependency
 +---------+            +---------+   completion cascade)

     any --------------> cancelled   (lead only)
```

**Retriable failures** (`crash`, `timeout`): the task goes back to pending with exponential backoff. First retry after 30s, second after 60s, third after 120s. After `max_retries` (default 3), it escalates to `needs_review`.

**Non-retriable failures** (`logic_error`, `artifact_missing`, `dependency_invalid`): straight to `needs_review`. These are problems the lead needs to look at. Maybe the task description was wrong. Maybe the dependency produced garbage. Maybe the AI just gave up. It happens.

## Agent roles and advisory routing

The role tiers below are advisory supervisor-routing policy, not a mechanically enforced recipient ACL. Safe workers cannot message peers directly because the supervisor withholds database and CLI lifecycle access; the lead applies this routing policy when relaying pane output. Trusted shared-state mode restores direct messaging and therefore relies on operator/worker compliance.

| Role | Supervisor policy | Intended recipients | What they do |
|------|----------|-------------|-------------|
| implementer | checkpoint | lead only | Write production code. The backbone. |
| tester | checkpoint | lead only | Write and run tests. The skeptic. |
| refactorer | checkpoint | lead only | Restructure code. The perfectionist. |
| documenter | checkpoint | lead only | Write docs. The historian. |
| reviewer | full | any agent | Review code. The critic. Can talk to anyone because they need to ask questions about anyone's work. |
| investigator | full | any agent | Deep analysis, debugging, research. The detective. Can talk to anyone because investigation is inherently cross-cutting. |

**Checkpoint autonomy** means the agent works independently but reports progress at meaningful milestones. "I finished the auth module." "Tests are passing." "I found a bug in the schema." In safe mode, the supervisor should route that output to the lead rather than start worker sidebars.

**Full participant** means the supervisor may relay the role's output to any agent. Trusted shared-state mode can use direct CLI messaging, but the tier is still advisory rather than an authorization boundary.

## The concurrency model

We could have used Redis. We could have used Postgres. We could have built a proper message broker with pub/sub and acknowledgment semantics. Instead, we used SQLite. Not because it's the best tool for multi-agent coordination -- it's arguably the worst -- but because it's a single file with zero infrastructure and WAL mode makes it work well enough that we never had a reason to upgrade.

SQLite WAL (Write-Ahead Logging) mode. One writer at a time, unlimited concurrent readers. All writes use `IMMEDIATE` transactions to serialize at the start rather than failing at commit. `busy_timeout=8000ms` handles contention -- if the database is locked, the writer waits up to 8 seconds before giving up.

In the safe architecture, lead-side MCP operations and protected controller launchers are the primary database clients. Trusted shared-state workers can opt back into direct access. SQLite remains practical because:

1. Most operations are **reads** (status checks, inbox polling, heartbeats)
2. **Writes are fast** -- inserting a task row or updating a status is microseconds
3. **Task claims are naturally serialized** -- only one agent can claim a given task, and the claim is an atomic UPDATE with a WHERE clause
4. WAL mode means **readers never block writers and writers never block readers**

Will this scale to 100 agents? No. Absolutely not. Will it handle 8? It hasn't complained yet. SQLite runs in your phone, your browser, your car, and now apparently also in your AI agent coordination layer. It was designed for embedded devices and we are using it to coordinate a small army of language models. Dr. Hipp, if you're reading this, we're sorry.

The state root defaults to `~/.local/state/tmup` and can be replaced with an absolute non-root `TMUP_STATE_ROOT`. Each session database lives at `<state-root>/<session-id>/tmup.db` and contains 17 tables, including operational and currently dormant planning/evidence surfaces.

## Dead claim recovery

Workers crash. Not often, but often enough that we had to build a recovery system. Codex runs out of context, the pane gets killed, the laptop overheats, you accidentally type `tmux kill-pane` in the wrong terminal. Life is full of small disasters.

When this happens:

1. A protected controller launcher sends **heartbeats** while each worker process is alive
2. The lead calls `tmup_status`, which checks for **stale agents** (no heartbeat for 5+ minutes by default)
3. Stale agents are automatically marked as dead
4. Their claimed tasks are **released back to pending** with a `timeout` failure reason
5. The tasks auto-retry with backoff (if retries remain) or escalate to `needs_review`

No task is silently lost. If an agent dies holding a task, the lead will find out on the next status check. The task goes back in the queue, and the supervisor can assign it to another worker. Life goes on.

## Inter-agent messaging

The lead can store coordination messages while applying the advisory routing tiers above. Stored database messages are not delivered to safe panes: workers surface findings in harvested pane output, and the supervisor uses `tmup_reprompt` when text must reach them. Direct `tmup-cli` messaging and inbox polling are reserved for explicitly enabled trusted shared-state mode and are not role-ACL enforced.

Message types:
- **`direct`** -- Point-to-point message. "Hey implementer, your function is wrong."
- **`broadcast`** -- Message to all agents. Used by the lead for announcements.
- **`checkpoint`** -- Progress update on a specific task. "Auth module done, moving to tests."
- **`finding`** -- A review or investigation finding. "Found a SQL injection in line 42."
- **`blocker`** -- Something is preventing progress. "I can't access the database."
- **`shutdown`** -- Sent by the lead when pausing or tearing down. "Save your work."

Worker-sourced text is **content-framed** as defense in depth. Trusted-mode inbox messages use `[WORKER MESSAGE ...]...[END WORKER MESSAGE]`; safe-lane harvest and pre-reprompt output use `[UNTRUSTED PANE OUTPUT ...]...[END UNTRUSTED PANE OUTPUT]` plus a machine-readable trust label. Worker-printed pane markers are neutralized before wrapping. Framing is not a complete prompt-injection boundary, so the lead must still verify evidence and treat the content as untrusted data.
