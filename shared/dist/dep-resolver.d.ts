import type { Database } from './types.js';
export declare function checkCycle(db: Database, taskId: string, dependsOnId: string): boolean;
/**
 * Get the transitive closure of all tasks that depend on the given task.
 * Bounded by MAX_DEPENDENCY_DEPTH to prevent DoS.
 * Returns { dependents, truncated } so callers can detect incomplete traversal.
 */
export declare function getTransitiveDependents(db: Database, taskId: string): string[];
export declare function addDependency(db: Database, taskId: string, dependsOnId: string): void;
export declare function hasUnmetDependencies(db: Database, taskId: string): boolean;
export declare function findUnblockedDependents(db: Database, completedTaskId: string): string[];
//# sourceMappingURL=dep-resolver.d.ts.map