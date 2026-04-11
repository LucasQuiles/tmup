import type { Database, TaskRow, FailureReason } from './types.js';
/**
 * Claims the next eligible pending task for an agent, optionally filtered by role.
 *
 * @param db - Database handle used to select and update the task.
 * @param agentId - Agent attempting to claim work.
 * @param role - Optional role filter that must match the task's role requirement.
 * @returns The claimed task, or `null` when no matching task is available.
 */
export declare function claimTask(db: Database, agentId: string, role?: string): TaskRow | null;
/**
 * Claim a specific task by ID (for dispatch). Validates role consistency.
 * Unlike claimTask() which picks from the queue, this targets a known task.
 */
export declare function claimSpecificTask(db: Database, taskId: string, agentId: string, role?: string): TaskRow;
export interface CompleteResult {
    unblocked: string[];
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
export declare function completeTask(db: Database, taskId: string, resultSummary: string, artifacts: Array<{
    name: string;
    path: string;
}> | undefined, projectDir: string | undefined, actorId: string): CompleteResult;
export interface FailResult {
    retrying: boolean;
    retry_after?: string;
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
export declare function failTask(db: Database, taskId: string, reason: FailureReason, message: string, actorId: string): FailResult;
export interface CancelResult {
    cancelled: string[];
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
export declare function cancelTask(db: Database, taskId: string, cascade?: boolean, actorId?: string): CancelResult;
//# sourceMappingURL=task-lifecycle.d.ts.map