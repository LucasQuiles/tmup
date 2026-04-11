import { logEvent } from './event-ops.js';
import { findUnblockedDependents, getTransitiveDependents } from './dep-resolver.js';
import { publishArtifact, computeChecksum, validateArtifactPath } from './artifact-ops.js';
import { BACKOFF_BASE_SECONDS } from './constants.js';
const RETRIABLE_REASONS = ['crash', 'timeout'];
/**
 * Claims the next eligible pending task for an agent, optionally filtered by role.
 *
 * @param db - Database handle used to select and update the task.
 * @param agentId - Agent attempting to claim work.
 * @param role - Optional role filter that must match the task's role requirement.
 * @returns The claimed task, or `null` when no matching task is available.
 */
export function claimTask(db, agentId, role) {
    const now = new Date().toISOString();
    const claimRole = role ?? null;
    const claim = db.transaction(() => {
        // One-task-per-agent guard: reject if agent already owns an active task
        const existing = db.prepare("SELECT id FROM tasks WHERE owner = ? AND status = 'claimed' LIMIT 1").get(agentId);
        if (existing) {
            throw new Error(`Agent ${agentId} already owns active task ${existing.id}`);
        }
        const result = db.prepare(`
      UPDATE tasks SET status = 'claimed', owner = ?, claimed_at = ?
      WHERE id = (
        SELECT id FROM tasks
        WHERE status = 'pending'
          AND (role IS NULL OR role = ?)
          AND (retry_after IS NULL OR retry_after <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      ) AND status = 'pending'
    `).run(agentId, now, claimRole, now);
        if (result.changes === 0)
            return null;
        const task = db.prepare("SELECT * FROM tasks WHERE owner = ? AND status = 'claimed' AND claimed_at = ?").get(agentId, now);
        if (!task) {
            throw new Error('Claim succeeded but task row not found — concurrent modification detected');
        }
        logEvent(db, agentId, 'task_claimed', { task_id: task.id });
        return task;
    });
    return claim.immediate();
}
/**
 * Claim a specific task by ID (for dispatch). Validates role consistency.
 * Unlike claimTask() which picks from the queue, this targets a known task.
 */
export function claimSpecificTask(db, taskId, agentId, role) {
    const now = new Date().toISOString();
    const claim = db.transaction(() => {
        // One-task-per-agent guard
        const existing = db.prepare("SELECT id FROM tasks WHERE owner = ? AND status = 'claimed' LIMIT 1").get(agentId);
        if (existing) {
            throw new Error(`Agent ${agentId} already owns active task ${existing.id}`);
        }
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        // Validate role consistency: if the task has a role requirement, caller must match it
        const normalizedRole = role || null;
        if (task.role && (!normalizedRole || task.role !== normalizedRole)) {
            throw new Error(`Role mismatch: task requires '${task.role}' but dispatch requested '${normalizedRole ?? '(none)'}'`);
        }
        const result = db.prepare("UPDATE tasks SET status = 'claimed', owner = ?, claimed_at = ? WHERE id = ? AND status = 'pending'").run(agentId, now, taskId);
        if (result.changes === 0) {
            throw new Error(`Task ${taskId} could not be claimed (current status: ${task.status})`);
        }
        logEvent(db, agentId, 'task_claimed', { task_id: taskId, dispatch: true });
        const claimed = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!claimed) {
            throw new Error(`Claim succeeded but task ${taskId} not found — concurrent modification detected`);
        }
        return claimed;
    });
    return claim.immediate();
}
/**
 * Completes a claimed task, publishes its produced artifacts, and unblocks satisfied dependents.
 *
 * @param db - Database handle used for validation, updates, and event logging.
 * @param taskId - Task to mark as completed.
 * @param resultSummary - Completion summary recorded on the task.
 * @param artifacts - Produced artifacts to publish for the task, if any.
 * @param projectDir - Project root used to validate artifact paths when provided.
 * @param actorId - Agent completing the task, or `lead` for administrative completion.
 * @returns IDs of dependent tasks whose remaining prerequisites are now satisfied.
 */
export function completeTask(db, taskId, resultSummary, artifacts, projectDir, actorId) {
    // Phase 1: Validate paths and compute checksums OUTSIDE transaction
    const checksums = [];
    if (artifacts) {
        for (const art of artifacts) {
            if (projectDir) {
                validateArtifactPath(art.path, projectDir);
            }
            checksums.push({
                name: art.name,
                path: art.path,
                checksum: computeChecksum(art.path),
            });
        }
    }
    // Phase 2: Everything else inside IMMEDIATE transaction
    const complete = db.transaction(() => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        if (task.status !== 'claimed') {
            throw new Error(`Task ${taskId} cannot be completed from status '${task.status}'`);
        }
        // Enforce actor ownership: only the owning agent (or lead) can complete
        if (actorId !== 'lead' && task.owner !== actorId) {
            throw new Error(`Task ${taskId} cannot be completed by '${actorId}': not the owning agent`);
        }
        const now = new Date().toISOString();
        // Clear owner on completion — completed tasks have no live owner
        db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, result_summary = ?, owner = NULL WHERE id = ?").run(now, resultSummary, taskId);
        // Register artifacts with checksums
        for (const art of checksums) {
            const artifact = db.prepare('SELECT a.id FROM artifacts a JOIN task_artifacts ta ON a.id = ta.artifact_id WHERE a.name = ? AND ta.task_id = ? AND ta.direction = ?').get(art.name, taskId, 'produces');
            if (!artifact) {
                throw new Error(`Artifact '${art.name}' not registered as a 'produces' artifact for task ${taskId}`);
            }
            publishArtifact(db, artifact.id, art.path, art.checksum);
        }
        // Cascade: find and unblock dependents
        const unblocked = findUnblockedDependents(db, taskId);
        logEvent(db, actorId, 'task_completed', {
            task_id: taskId,
            unblocked,
        });
        return { unblocked };
    });
    return complete.immediate();
}
/**
 * Fails a claimed task and either requeues it with backoff or sends it to review.
 *
 * @param db - Database handle used for task updates and event logging.
 * @param taskId - Task to fail.
 * @param reason - Failure reason that determines whether retry logic applies.
 * @param message - Failure summary stored on the task.
 * @param actorId - Agent failing the task, or `lead` for administrative failure.
 * @returns Whether the task was requeued and, when applicable, when retry is allowed.
 */
export function failTask(db, taskId, reason, message, actorId) {
    const fail = db.transaction(() => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        if (task.status !== 'claimed') {
            throw new Error(`Task ${taskId} cannot be failed from status '${task.status}'`);
        }
        // Enforce actor ownership: only the owning agent (or lead) can fail
        if (actorId !== 'lead' && task.owner !== actorId) {
            throw new Error(`Task ${taskId} cannot be failed by '${actorId}': not the owning agent`);
        }
        const isRetriable = RETRIABLE_REASONS.includes(reason);
        const hasRetries = task.retry_count < task.max_retries;
        if (isRetriable && hasRetries) {
            const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, task.retry_count);
            const retryAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
            db.prepare(`
        UPDATE tasks SET
          status = 'pending',
          owner = NULL,
          failure_reason = ?,
          retry_count = retry_count + 1,
          retry_after = ?,
          result_summary = ?
        WHERE id = ?
      `).run(reason, retryAfter, message, taskId);
            logEvent(db, actorId, 'task_failed', {
                task_id: taskId,
                reason,
                retrying: true,
                retry_after: retryAfter,
            });
            return { retrying: true, retry_after: retryAfter };
        }
        // Non-retriable or out of retries -> needs_review
        // Don't increment retry_count — consistent with dead-claim recovery
        db.prepare(`
      UPDATE tasks SET
        status = 'needs_review',
        owner = NULL,
        failure_reason = ?,
        result_summary = ?
      WHERE id = ?
    `).run(reason, message, taskId);
        logEvent(db, actorId, 'task_failed', {
            task_id: taskId,
            reason,
            retrying: false,
        });
        return { retrying: false };
    });
    return fail.immediate();
}
/**
 * Cancels a task and either cancels or flags its transitive dependents for review.
 *
 * @param db - Database handle used for task updates and dependency traversal.
 * @param taskId - Root task to cancel.
 * @param cascade - When `true`, also cancels transitive dependents; otherwise marks them `needs_review`.
 * @param actorId - Actor recorded in the cancellation event.
 * @returns IDs of tasks whose status changed to `cancelled`.
 */
export function cancelTask(db, taskId, cascade = false, actorId = 'lead') {
    const cancel = db.transaction(() => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        if (task.status === 'completed' || task.status === 'cancelled') {
            return { cancelled: [] };
        }
        db.prepare("UPDATE tasks SET status = 'cancelled', owner = NULL WHERE id = ?").run(taskId);
        const cancelled = [taskId];
        // Use bounded transitive traversal for both cascade and non-cascade
        const transitiveDeps = getTransitiveDependents(db, taskId);
        if (cascade) {
            for (const depId of transitiveDeps) {
                const result = db.prepare("UPDATE tasks SET status = 'cancelled', owner = NULL WHERE id = ? AND status NOT IN ('completed', 'cancelled')").run(depId);
                if (result.changes > 0) {
                    cancelled.push(depId);
                }
            }
        }
        else {
            // Non-cascade: mark ALL transitive dependents needs_review (not just direct)
            for (const depId of transitiveDeps) {
                db.prepare("UPDATE tasks SET status = 'needs_review' WHERE id = ? AND status NOT IN ('completed', 'cancelled')").run(depId);
            }
        }
        logEvent(db, actorId, 'task_cancelled', { task_id: taskId, cascade, cancelled });
        return { cancelled };
    });
    return cancel.immediate();
}
//# sourceMappingURL=task-lifecycle.js.map