[< Back to README](../README.md)

# Architecture

## System overview

```
Claude Code (Lead)
  |
  +- MCP Server (18 tools)
  |    |  The brain stem. Claude calls these tools to manage
  |    |  the task DAG, dispatch workers, read messages, and
  |    |  harvest output. It runs as a Node.js process that
  |    |  Claude spawns at session start.
  |    |
  |    +- @tmup/shared (SQLite WAL)
  |         +- tmup.db (16 tables)
  |              The shared brain. Every agent reads and writes
  |              to this one file. WAL mode means readers never
  |              block writers. It's beautiful.
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
       +- Codex Workers (tmup-cli)
            |  The workforce. Each Codex process gets a prompt,
            |  a role, and access to tmup-cli for coordination.
            |  They claim tasks, do the work, post checkpoints,
            |  and complete. They run with full disk access and
            |  zero approval prompts because they are here to
            |  work, not to ask permission.
            |
            +- claim -> work -> checkpoint -> complete
            +- All share the same SQLite DB
```

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

## Agent roles and autonomy

Not all agents are created equal. Some are trusted to talk to anyone. Others can only talk to the boss. This is by design -- you don't want eight agents having a group chat about your codebase. You want a hierarchy.

| Role | Autonomy | Can message | What they do |
|------|----------|-------------|-------------|
| implementer | checkpoint | lead only | Write production code. The backbone. |
| tester | checkpoint | lead only | Write and run tests. The skeptic. |
| refactorer | checkpoint | lead only | Restructure code. The perfectionist. |
| documenter | checkpoint | lead only | Write docs. The historian. |
| reviewer | full | any agent | Review code. The critic. Can talk to anyone because they need to ask questions about anyone's work. |
| investigator | full | any agent | Deep analysis, debugging, research. The detective. Can talk to anyone because investigation is inherently cross-cutting. |

**Checkpoint autonomy** means the agent works independently but posts progress at meaningful milestones. "I finished the auth module." "Tests are passing." "I found a bug in the schema." They can only message the lead -- no sidebar conversations with other workers.

**Full participant** means the agent can message anyone directly. Reviewers need this because "hey implementer, what does this function do?" is a question that shouldn't require going through the lead. Investigators need this because debugging is a conversation, not a monologue.

## The concurrency model

We could have used Redis. We could have used Postgres. We could have built a proper message broker with pub/sub and acknowledgment semantics. Instead, we used SQLite. Not because it's the best tool for multi-agent coordination -- it's arguably the worst -- but because it's a single file with zero infrastructure and WAL mode makes it work well enough that we never had a reason to upgrade.

SQLite WAL (Write-Ahead Logging) mode. One writer at a time, unlimited concurrent readers. All writes use `IMMEDIATE` transactions to serialize at the start rather than failing at commit. `busy_timeout=8000ms` handles contention -- if the database is locked, the writer waits up to 8 seconds before giving up.

In practice, 8 agents hammering the same DB file works fine because:

1. Most operations are **reads** (status checks, inbox polling, heartbeats)
2. **Writes are fast** -- inserting a task row or updating a status is microseconds
3. **Task claims are naturally serialized** -- only one agent can claim a given task, and the claim is an atomic UPDATE with a WHERE clause
4. WAL mode means **readers never block writers and writers never block readers**

Will this scale to 100 agents? No. Absolutely not. Will it handle 8? It hasn't complained yet. SQLite runs in your phone, your browser, your car, and now apparently also in your AI agent coordination layer. It was designed for embedded devices and we are using it to coordinate a small army of language models. Dr. Hipp, if you're reading this, we're sorry.

The database lives at `~/.local/state/tmup/<session-id>/tmup.db`. It contains 16 tables (8 operational, 8 for future planning/evidence features that are implemented but not yet wired in because we shipped them early and then forgot to connect them).

## Dead claim recovery

Workers crash. Not often, but often enough that we had to build a recovery system. Codex runs out of context, the pane gets killed, the laptop overheats, you accidentally type `tmux kill-pane` in the wrong terminal. Life is full of small disasters.

When this happens:

1. Workers are supposed to send **heartbeats** via `tmup-cli heartbeat`
2. The lead calls `tmup_status`, which checks for **stale agents** (no heartbeat for 5+ minutes by default)
3. Stale agents are automatically marked as dead
4. Their claimed tasks are **released back to pending** with a `timeout` failure reason
5. The tasks auto-retry with backoff (if retries remain) or escalate to `needs_review`

No task is silently lost. If an agent dies holding a task, the lead will find out on the next status check. The task goes back in the queue. Another worker picks it up. Life goes on.

## Inter-agent messaging

Agents can send messages to each other (subject to their autonomy tier). Messages are stored in the SQLite database and delivered via inbox polling.

Message types:
- **`direct`** -- Point-to-point message. "Hey implementer, your function is wrong."
- **`broadcast`** -- Message to all agents. Used by the lead for announcements.
- **`checkpoint`** -- Progress update on a specific task. "Auth module done, moving to tests."
- **`finding`** -- A review or investigation finding. "Found a SQL injection in line 42."
- **`blocker`** -- Something is preventing progress. "I can't access the database."
- **`shutdown`** -- Sent by the lead when pausing or tearing down. "Save your work."

Messages are **content-framed** for prompt injection defense. When a message from a worker is delivered to another agent, it's wrapped in `[WORKER MESSAGE from <id>, type=<type>]...[END WORKER MESSAGE]` markers. This is supposed to prevent a compromised worker from injecting instructions that other agents would follow. Is it bulletproof? No. Is it better than raw text? Yes. Is the gap between those two things keeping us up at night? Also yes.
