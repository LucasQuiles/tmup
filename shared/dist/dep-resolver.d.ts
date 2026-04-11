import type { Database } from './types.js';
/**
 * Checks whether adding a dependency edge would introduce a cycle.
 *
 * @param db - Database handle used to traverse the dependency graph.
 * @param taskId - Task that would gain a dependency.
 * @param dependsOnId - Task that would be added as a prerequisite.
 * @returns `true` when the new edge would create a cycle.
 */
export declare function checkCycle(db: Database, taskId: string, dependsOnId: string): boolean;
/**
 * Get the transitive closure of all tasks that depend on the given task.
 * Bounded by MAX_DEPENDENCY_DEPTH to prevent DoS.
 * Logs when traversal reaches the configured depth limit and returns discovered IDs.
 */
export declare function getTransitiveDependents(db: Database, taskId: string): string[];
/**
 * Adds a dependency edge after verifying both tasks exist and the new edge is acyclic.
 *
 * @param db - Database handle used for validation and persistence.
 * @param taskId - Task that will depend on another task.
 * @param dependsOnId - Task that must complete before `taskId`.
 */
export declare function addDependency(db: Database, taskId: string, dependsOnId: string): void;
/**
 * Checks whether a task still has any dependencies that are not completed.
 *
 * @param db - Database handle used to query dependency status.
 * @param taskId - Task to inspect.
 * @returns `true` when at least one prerequisite remains incomplete.
 */
export declare function hasUnmetDependencies(db: Database, taskId: string): boolean;
/**
 * Finds dependents unblocked by a completed task and re-queues blocked ones as pending.
 *
 * @param db - Database handle used to evaluate and update dependent tasks.
 * @param completedTaskId - Completed task that may unblock dependents.
 * @returns IDs of dependent tasks whose prerequisites are now fully satisfied.
 */
export declare function findUnblockedDependents(db: Database, completedTaskId: string): string[];
//# sourceMappingURL=dep-resolver.d.ts.map