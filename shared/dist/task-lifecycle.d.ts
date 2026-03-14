import type { Database, TaskRow, FailureReason } from './types.js';
export declare function claimTask(db: Database, agentId: string, role?: string): TaskRow | null;
/**
 * Claim a specific task by ID (for dispatch). Validates role consistency.
 * Unlike claimTask() which picks from the queue, this targets a known task.
 */
export declare function claimSpecificTask(db: Database, taskId: string, agentId: string, role?: string): TaskRow;
export interface CompleteResult {
    unblocked: string[];
}
export declare function completeTask(db: Database, taskId: string, resultSummary: string, artifacts: Array<{
    name: string;
    path: string;
}> | undefined, projectDir: string | undefined, actorId: string): CompleteResult;
export interface FailResult {
    retrying: boolean;
    retry_after?: string;
}
export declare function failTask(db: Database, taskId: string, reason: FailureReason, message: string, actorId: string): FailResult;
export interface CancelResult {
    cancelled: string[];
}
export declare function cancelTask(db: Database, taskId: string, cascade?: boolean, actorId?: string): CancelResult;
//# sourceMappingURL=task-lifecycle.d.ts.map