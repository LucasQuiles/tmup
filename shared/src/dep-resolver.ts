import type { Database } from './types.js';
import { logEvent } from './event-ops.js';
import { MAX_DEPENDENCY_DEPTH } from './constants.js';

export function checkCycle(db: Database, taskId: string, dependsOnId: string): boolean {
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
 * Returns { dependents, truncated } so callers can detect incomplete traversal.
 */
export function getTransitiveDependents(
  db: Database,
  taskId: string
): string[] {
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
  `).all(taskId, MAX_DEPENDENCY_DEPTH) as Array<{ id: string; max_depth: number }>;

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

export function addDependency(db: Database, taskId: string, dependsOnId: string): void {
  // Wrap in IMMEDIATE transaction to prevent concurrent cycle creation.
  // Without this, two concurrent addDependency calls could each pass the cycle
  // check and both insert, creating a cycle (A->B and B->A).
  const add = db.transaction(() => {
    // Verify both tasks exist
    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string } | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);

    const dep = db.prepare('SELECT id FROM tasks WHERE id = ?').get(dependsOnId);
    if (!dep) throw new Error(`Dependency task ${dependsOnId} not found`);

    // Check for cycles
    if (checkCycle(db, taskId, dependsOnId)) {
      throw new Error(`Adding dependency ${taskId} -> ${dependsOnId} would create a cycle`);
    }

    db.prepare(
      'INSERT OR IGNORE INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)'
    ).run(taskId, dependsOnId);

    // Re-block the task if it has unmet dependencies and is currently pending
    if (task.status === 'pending' && hasUnmetDependencies(db, taskId)) {
      db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ? AND status = 'pending'").run(taskId);
    }
  });

  add.immediate();
}

export function hasUnmetDependencies(db: Database, taskId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM task_deps td
    JOIN tasks t ON td.depends_on_task_id = t.id
    WHERE td.task_id = ? AND t.status != 'completed'
    LIMIT 1
  `).get(taskId);
  return row !== undefined;
}

export function findUnblockedDependents(db: Database, completedTaskId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT td.task_id FROM task_deps td
    WHERE td.depends_on_task_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM task_deps td2
      JOIN tasks t2 ON td2.depends_on_task_id = t2.id
      WHERE td2.task_id = td.task_id
      AND t2.status != 'completed'
    )
  `).all(completedTaskId) as Array<{ task_id: string }>;

  const unblockedIds = rows.map(r => r.task_id);

  // Transition unblocked tasks from blocked -> pending
  for (const id of unblockedIds) {
    const result = db.prepare(
      "UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'blocked'"
    ).run(id);
    if (result.changes > 0) {
      logEvent(db, null, 'task_unblocked', { task_id: id, unblocked_by: completedTaskId });
    }
  }

  return unblockedIds;
}
