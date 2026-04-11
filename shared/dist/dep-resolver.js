import { logEvent } from './event-ops.js';
import { MAX_DEPENDENCY_DEPTH } from './constants.js';
/**
 * Checks whether adding a dependency edge would introduce a cycle.
 *
 * @param db - Database handle used to traverse the dependency graph.
 * @param taskId - Task that would gain a dependency.
 * @param dependsOnId - Task that would be added as a prerequisite.
 * @returns `true` when the new edge would create a cycle.
 */
export function checkCycle(db, taskId, dependsOnId) {
    // Adding edge (taskId depends on dependsOnId).
    // Cycle exists if dependsOnId already transitively depends on taskId.
    // Bounded recursive CTE to prevent DoS on deep/cyclic graphs.
    const row = db.prepare(`
    WITH RECURSIVE reachable(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT td.depends_on_task_id, r.depth + 1
      FROM task_deps td
      JOIN reachable r ON td.task_id = r.id
      WHERE r.depth < ?
    )
    SELECT 1 FROM reachable WHERE id = ? LIMIT 1
  `).get(dependsOnId, MAX_DEPENDENCY_DEPTH, taskId);
    return row !== undefined;
}
/**
 * Get the transitive closure of all tasks that depend on the given task.
 * Bounded by MAX_DEPENDENCY_DEPTH to prevent DoS.
 * Logs when traversal reaches the configured depth limit and returns discovered IDs.
 */
export function getTransitiveDependents(db, taskId) {
    const rows = db.prepare(`
    WITH RECURSIVE dependents(id, depth) AS (
      SELECT task_id, 1 FROM task_deps WHERE depends_on_task_id = ?
      UNION
      SELECT td.task_id, d.depth + 1
      FROM task_deps td
      JOIN dependents d ON td.depends_on_task_id = d.id
      WHERE d.depth < ?
    )
    SELECT id, MAX(depth) as max_depth FROM dependents GROUP BY id
  `).all(taskId, MAX_DEPENDENCY_DEPTH);
    const maxObservedDepth = rows.reduce((max, r) => Math.max(max, r.max_depth), 0);
    if (maxObservedDepth >= MAX_DEPENDENCY_DEPTH) {
        logEvent(db, null, 'dependency_traversal_truncated', {
            root_task_id: taskId,
            max_depth: MAX_DEPENDENCY_DEPTH,
            dependents_found: rows.length,
        });
    }
    return rows.map(r => r.id);
}
/**
 * Adds a dependency edge after verifying both tasks exist and the new edge is acyclic.
 *
 * @param db - Database handle used for validation and persistence.
 * @param taskId - Task that will depend on another task.
 * @param dependsOnId - Task that must complete before `taskId`.
 */
export function addDependency(db, taskId, dependsOnId) {
    // Wrap in IMMEDIATE transaction to prevent concurrent cycle creation.
    // Without this, two concurrent addDependency calls could each pass the cycle
    // check and both insert, creating a cycle (A->B and B->A).
    const add = db.transaction(() => {
        // Verify both tasks exist
        const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        const dep = db.prepare('SELECT id FROM tasks WHERE id = ?').get(dependsOnId);
        if (!dep)
            throw new Error(`Dependency task ${dependsOnId} not found`);
        // Check for cycles
        if (checkCycle(db, taskId, dependsOnId)) {
            throw new Error(`Adding dependency ${taskId} -> ${dependsOnId} would create a cycle`);
        }
        db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)').run(taskId, dependsOnId);
        // Re-block the task if it has unmet dependencies and is currently pending
        if (task.status === 'pending' && hasUnmetDependencies(db, taskId)) {
            db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ? AND status = 'pending'").run(taskId);
        }
    });
    add.immediate();
}
/**
 * Checks whether a task still has any dependencies that are not completed.
 *
 * @param db - Database handle used to query dependency status.
 * @param taskId - Task to inspect.
 * @returns `true` when at least one prerequisite remains incomplete.
 */
export function hasUnmetDependencies(db, taskId) {
    const row = db.prepare(`
    SELECT 1 FROM task_deps td
    JOIN tasks t ON td.depends_on_task_id = t.id
    WHERE td.task_id = ? AND t.status != 'completed'
    LIMIT 1
  `).get(taskId);
    return row !== undefined;
}
/**
 * Finds dependents unblocked by a completed task and re-queues blocked ones as pending.
 *
 * @param db - Database handle used to evaluate and update dependent tasks.
 * @param completedTaskId - Completed task that may unblock dependents.
 * @returns IDs of dependent tasks whose prerequisites are now fully satisfied.
 */
export function findUnblockedDependents(db, completedTaskId) {
    const rows = db.prepare(`
    SELECT DISTINCT td.task_id FROM task_deps td
    WHERE td.depends_on_task_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM task_deps td2
      JOIN tasks t2 ON td2.depends_on_task_id = t2.id
      WHERE td2.task_id = td.task_id
      AND t2.status != 'completed'
    )
  `).all(completedTaskId);
    const unblockedIds = rows.map(r => r.task_id);
    // Transition unblocked tasks from blocked -> pending
    for (const id of unblockedIds) {
        const result = db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'blocked'").run(id);
        if (result.changes > 0) {
            logEvent(db, null, 'task_unblocked', { task_id: id, unblocked_by: completedTaskId });
        }
    }
    return unblockedIds;
}
//# sourceMappingURL=dep-resolver.js.map