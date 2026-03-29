# Shared Library Audit

Task: `005`
Date: `2026-03-14`
Scope: `shared/src/task-lifecycle.ts`, `shared/src/dep-resolver.ts`, `shared/src/session-ops.ts`, `shared/src/agent-ops.ts`

Method:
- Local end-to-end code read of the four target modules plus supporting paths in `task-ops.ts`, `artifact-ops.ts`, and MCP entrypoints.
- Nested sub-agent audit of `session-ops.ts` and `agent-ops.ts` by `Descartes`.
- Nested sub-agent audit of `task-lifecycle.ts` and `dep-resolver.ts` by `Planck` and `Archimedes`.
- Local runtime confirmation of the highest-severity findings with ad hoc Node reproductions.
- Targeted verification with `npm test -- -t "artifact modified between checksum validation and publish commits stale metadata"`.

## Findings

1. Finding: `claimSpecificTask()` bypasses retry backoff.
Severity: high
Confidence: high
Evidence:
- `shared/src/task-lifecycle.ts:34`
- `shared/src/task-lifecycle.ts:66`
- `shared/src/task-lifecycle.ts:92`
- `shared/src/task-lifecycle.ts:231`
Impact:
- Normal queue claims respect `retry_after`, but direct dispatch claims do not.
- A task that just failed with `crash` or `timeout` can be re-claimed immediately, defeating exponential backoff and making hot retry storms possible.
Recommendation:
- Apply the same `retry_after <= now` gate inside `claimSpecificTask()`, or add a separate explicit force-claim path with distinct audit logging.
Verification:
- Local reproduction showed a task with a future `retry_after` moving from `pending` to `claimed` via `claimSpecificTask()`.

2. Finding: `completeTask()` publishes stale artifact metadata if the file changes between checksum and commit.
Severity: high
Confidence: high
Evidence:
- `shared/src/task-lifecycle.ts:134`
- `shared/src/task-lifecycle.ts:149`
- `shared/src/task-lifecycle.ts:168`
- `shared/src/artifact-ops.ts:20`
- `tests/integration/full-lifecycle.test.ts:418`
Impact:
- Completion can succeed and publish an artifact as `published` even when the file content no longer matches the stored checksum by commit time.
- Downstream consumers see a completed task and a published artifact, but the artifact is immediately stale.
Recommendation:
- Compute and persist the checksum inside the same critical section as publication, or re-verify the file before commit and fail completion on mismatch.
Verification:
- Targeted Vitest run passed the integration case that demonstrates `completeTask()` returns success while `verifyArtifact()` immediately reports `stale`.
- Local reproduction confirmed `status_after_complete = published` and `verify = stale`.

3. Finding: `addDependency()` only repairs lifecycle state for `pending` tasks.
Severity: high
Confidence: high
Evidence:
- `shared/src/dep-resolver.ts:71`
- `shared/src/dep-resolver.ts:92`
- `shared/src/task-lifecycle.ts:151`
- `shared/src/task-lifecycle.ts:217`
Impact:
- A new prerequisite can be attached to a task that is already `claimed` or `completed`, and the task remains in that state.
- `completeTask()` and retry requeue paths do not re-check dependency closure, so work can finish or resume while prerequisites are incomplete.
Recommendation:
- Reject dependency additions for non-queued tasks, or immediately transition affected tasks back to `blocked`.
- Add a dependency-closure check in `completeTask()` as a backstop.
Verification:
- Local reproduction showed a `claimed` task remaining `claimed` after gaining a new unmet dependency.
- Local reproduction showed a `completed` task remaining `completed` after a new incomplete prerequisite was attached.

4. Finding: Session registry locking can be broken while the owning process is still alive.
Severity: high
Confidence: high
Evidence:
- `shared/src/session-ops.ts:127`
- `shared/src/session-ops.ts:153`
- `shared/src/session-ops.ts:161`
- `shared/src/session-ops.ts:162`
- `shared/src/session-ops.ts:188`
Impact:
- Any critical section that lasts more than 10 seconds can have its lock file unlinked purely because the lock is old, even if the owner PID is still live.
- There is no ownership revalidation immediately before unlink, so one process can also delete a newer lock that replaced the original file.
- That defeats mutual exclusion for registry writes and can cause duplicate session creation or lost updates.
Recommendation:
- Replace the ad hoc stale-file lock with an OS-backed lock, SQLite-backed coordination, or a lock directory plus ownership token.
- If this file lock stays, only evict when the owner PID is confirmed dead and verify the same lock instance immediately before unlink.

5. Finding: Non-cascade cancellation leaves ghost ownership on descendants moved to `needs_review`.
Severity: medium
Confidence: high
Evidence:
- `shared/src/task-lifecycle.ts:309`
- `shared/src/task-lifecycle.ts:320`
- `shared/src/task-lifecycle.ts:324`
Impact:
- `cancelTask(taskId, false)` updates transitive dependents to `needs_review` but does not clear `owner`.
- A formerly claimed descendant can remain assigned to a worker even though it is no longer actionable.
Recommendation:
- Clear `owner`, and ideally `claimed_at`, whenever non-cascade cancellation moves a task to `needs_review`.
Verification:
- Local reproduction produced `{ "status": "needs_review", "owner": "agent-child" }` for a claimed dependent after non-cascade cancellation of its prerequisite.

6. Finding: `current-session` is not kept atomically consistent with the registry.
Severity: medium
Confidence: high
Evidence:
- `shared/src/session-ops.ts:262`
- `shared/src/session-ops.ts:267`
- `shared/src/session-ops.ts:276`
- `shared/src/session-ops.ts:304`
- `shared/src/session-ops.ts:308`
- `shared/src/session-ops.ts:315`
Impact:
- `setCurrentSession()` validates against the registry without holding the registry lock.
- `removeFromRegistry()` deletes entries without clearing `current-session`.
- That allows stale global pointers and check-then-write races where `current-session` names a session that no longer exists.
Recommendation:
- Guard current-session updates and registry deletion under the same lock.
- Clear or rewrite `current-session` when deleting the active session.
- Optionally make `getCurrentSession()` reject IDs missing from the registry, not just malformed IDs.

7. Finding: Dependency depth limits fail open for cancellation and cycle safety.
Severity: medium
Confidence: medium
Evidence:
- `shared/src/dep-resolver.ts:16`
- `shared/src/dep-resolver.ts:31`
- `shared/src/dep-resolver.ts:52`
- `shared/src/task-lifecycle.ts:308`
Impact:
- Once a graph exceeds `MAX_DEPENDENCY_DEPTH`, traversal is truncated but callers still treat the result as complete.
- Deep descendants can remain active during cancel or review cascades, and deep cycle detection can miss real cycles.
Recommendation:
- When traversal hits the configured cap, fail the write/cancel path or route it through a full validation flow instead of returning partial success.

8. Finding: `initSession()` can orphan a new session database before it is registered.
Severity: medium
Confidence: high
Evidence:
- `shared/src/session-ops.ts:227`
- `shared/src/session-ops.ts:239`
- `shared/src/session-ops.ts:243`
- `shared/src/session-ops.ts:250`
Impact:
- If the process crashes after creating the session directory and database but before writing the registry entry, the session exists on disk but is undiscoverable through the registry.
- A later init for the same project creates a second session instead of recovering the orphaned one.
Recommendation:
- Register a provisional session entry before DB initialization, or add a reconciliation pass that can discover orphaned session directories on startup.

9. Finding: `registerAgent()` is not atomic with event logging.
Severity: low
Confidence: high
Evidence:
- `shared/src/agent-ops.ts:10`
- `shared/src/agent-ops.ts:20`
- `shared/src/event-ops.ts:3`
- `shared/src/event-ops.ts:9`
Impact:
- If `logEvent()` throws after the agent row has been upserted, callers see registration failure even though the agent is now active in the database.
Recommendation:
- Put the upsert and event insert in one transaction, or explicitly treat event logging as best-effort.

## Recommended Fix Order

1. Align all claim paths with retry backoff and harden dependency invariants (`claimSpecificTask`, `addDependency`, `completeTask`).
2. Fix the artifact checksum race so task completion cannot publish immediately stale artifacts.
3. Replace or harden the session registry lock, then make `current-session` updates atomic with registry mutation.
4. Clean up secondary lifecycle consistency issues: owner clearing on non-cascade cancel, depth-cap fail-open behavior, and session orphan recovery.
