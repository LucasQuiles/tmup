import { nextTaskId } from './id.js';
import { logEvent } from './event-ops.js';
import { addDependency, hasUnmetDependencies } from './dep-resolver.js';
import { createArtifact, linkTaskArtifact, findArtifactByName } from './artifact-ops.js';
import { DEFAULT_PRIORITY } from './constants.js';
const MAX_TASKS = 500;
// Valid lead-initiated status transitions
const LEAD_TRANSITIONS = {
    needs_review: ['pending'],
    pending: ['cancelled'],
    blocked: ['pending'],
};
/** Shared task creation logic. Must be called inside an IMMEDIATE transaction. */
function _createTaskInner(db, input) {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get();
    if (count.cnt >= MAX_TASKS) {
        throw new Error(`Task limit reached (${MAX_TASKS})`);
    }
    const id = nextTaskId(db);
    const priority = input.priority ?? DEFAULT_PRIORITY;
    const maxRetries = input.max_retries ?? 3;
    db.prepare(`
    INSERT INTO tasks (id, subject, description, role, priority, status, max_retries)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, input.subject, input.description ?? null, input.role ?? null, priority, maxRetries);
    if (input.deps) {
        for (const depId of input.deps) {
            addDependency(db, id, depId);
        }
    }
    if (input.requires) {
        for (const name of input.requires) {
            const artifact = findArtifactByName(db, name);
            if (!artifact) {
                const artId = createArtifact(db, name, '');
                linkTaskArtifact(db, id, artId, 'requires');
            }
            else {
                linkTaskArtifact(db, id, artifact.id, 'requires');
            }
        }
    }
    if (input.produces) {
        for (const name of input.produces) {
            const artifact = findArtifactByName(db, name);
            if (!artifact) {
                const artId = createArtifact(db, name, '');
                linkTaskArtifact(db, id, artId, 'produces');
            }
            else {
                // Reject duplicate producers: only one task may produce a given artifact
                const existingProducer = db.prepare("SELECT task_id FROM task_artifacts WHERE artifact_id = ? AND direction = 'produces'").get(artifact.id);
                if (existingProducer) {
                    throw new Error(`Artifact '${name}' already has a producer (task ${existingProducer.task_id})`);
                }
                linkTaskArtifact(db, id, artifact.id, 'produces');
            }
        }
    }
    if (hasUnmetDependencies(db, id)) {
        db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(id);
    }
    logEvent(db, null, 'task_created', { task_id: id, subject: input.subject });
    return id;
}
export function createTask(db, input) {
    const create = db.transaction(() => _createTaskInner(db, input));
    return create.immediate();
}
export function createTaskBatch(db, inputs) {
    const ids = [];
    const runBatch = db.transaction(() => {
        for (const input of inputs) {
            ids.push(_createTaskInner(db, input));
        }
    });
    runBatch.immediate();
    return ids;
}
/** Get the single active (claimed) task for an agent, or null if none. */
export function getActiveTaskForAgent(db, agentId) {
    return db.prepare("SELECT * FROM tasks WHERE owner = ? AND status = 'claimed' LIMIT 1").get(agentId) ?? null;
}
export function updateTask(db, taskId, updates) {
    const run = db.transaction(() => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        const result = { ok: true };
        if (updates.status !== undefined) {
            const allowed = LEAD_TRANSITIONS[task.status];
            if (!allowed || !allowed.includes(updates.status)) {
                throw new Error(`Invalid transition: ${task.status} -> ${updates.status}`);
            }
            result.previous_status = task.status;
            // Clear stale runtime fields when requeuing needs_review -> pending
            if (task.status === 'needs_review' && updates.status === 'pending') {
                db.prepare(`
          UPDATE tasks SET status = 'pending', owner = NULL, failure_reason = NULL,
            retry_after = NULL, result_summary = NULL, claimed_at = NULL, completed_at = NULL
          WHERE id = ?
        `).run(taskId);
            }
            else {
                db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(updates.status, taskId);
            }
        }
        if (updates.priority !== undefined) {
            db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(updates.priority, taskId);
        }
        if (updates.role !== undefined) {
            db.prepare('UPDATE tasks SET role = ? WHERE id = ?').run(updates.role, taskId);
        }
        if (updates.description !== undefined) {
            db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run(updates.description, taskId);
        }
        if (updates.max_retries !== undefined) {
            if (updates.max_retries < task.retry_count) {
                throw new Error(`Cannot set max_retries (${updates.max_retries}) below current retry_count (${task.retry_count})`);
            }
            db.prepare('UPDATE tasks SET max_retries = ? WHERE id = ?').run(updates.max_retries, taskId);
        }
        logEvent(db, null, 'task_updated', { task_id: taskId, updates });
        return result;
    });
    return run.immediate();
}
//# sourceMappingURL=task-ops.js.map