import { registerAgent } from './agent-ops.js';
import { createAttempt } from './evidence-ops.js';
import { logEvent } from './event-ops.js';
import { claimSpecificTask } from './task-lifecycle.js';
function requireNonEmpty(value, field) {
    if (!value.trim()) {
        throw new Error(`${field} is required for a dispatch receipt`);
    }
}
function validateFallback(fallbackUsed, fallbackModel, fallbackReason) {
    if (fallbackUsed === true) {
        if (!fallbackModel?.trim()) {
            throw new Error('fallback_model is required when fallback_used is true');
        }
        if (!fallbackReason?.trim()) {
            throw new Error('fallback_reason is required when fallback_used is true');
        }
        return;
    }
    if (fallbackModel !== undefined || fallbackReason !== undefined) {
        throw new Error('fallback provenance requires fallback_used to be true');
    }
}
export function toDispatchReceipt(row) {
    return {
        attempt_id: row.id,
        task_id: row.task_id,
        agent_id: row.agent_id,
        role: row.role ?? 'unknown',
        selector: row.selector ?? 'unknown',
        requested_model: row.requested_model,
        observed_model: row.observed_model,
        fallback_used: row.fallback_used === null ? null : row.fallback_used === 1,
        fallback_model: row.fallback_model,
        fallback_reason: row.fallback_reason,
        terminal_status: row.execution_outcome ?? row.status,
    };
}
export function getDispatchReceipt(db, attemptId) {
    const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId);
    if (!attempt) {
        throw new Error(`Attempt ${attemptId} not found`);
    }
    return toDispatchReceipt(attempt);
}
export function beginDispatch(db, input) {
    requireNonEmpty(input.attempt_id, 'attempt_id');
    requireNonEmpty(input.task_id, 'task_id');
    requireNonEmpty(input.agent_id, 'agent_id');
    requireNonEmpty(input.role, 'role');
    requireNonEmpty(input.selector, 'selector');
    requireNonEmpty(input.requested_model, 'requested_model');
    requireNonEmpty(input.observed_model, 'observed_model');
    validateFallback(input.fallback_used, input.fallback_model, input.fallback_reason);
    const begin = db.transaction(() => {
        registerAgent(db, input.agent_id, input.pane_index, input.role);
        const task = claimSpecificTask(db, input.task_id, input.agent_id, input.role);
        db.prepare('UPDATE tasks SET execution_outcome = NULL WHERE id = ?').run(input.task_id);
        const attempt = createAttempt(db, input.attempt_id, {
            task_id: input.task_id,
            agent_id: input.agent_id,
            execution_target_id: input.execution_target_id,
            role: input.role,
            selector: input.selector,
            requested_model: input.requested_model,
            observed_model: input.observed_model,
            fallback_used: input.fallback_used,
            fallback_model: input.fallback_model,
            fallback_reason: input.fallback_reason,
        });
        const receipt = toDispatchReceipt(attempt);
        logEvent(db, input.agent_id, 'dispatch', {
            attempt_id: receipt.attempt_id,
            task_id: receipt.task_id,
            role: receipt.role,
            selector: receipt.selector,
            requested_model: receipt.requested_model,
            observed_model: receipt.observed_model,
            fallback_used: receipt.fallback_used,
        });
        return { task, receipt };
    });
    return begin.immediate();
}
export function attestAttempt(db, attemptId, input) {
    requireNonEmpty(input.observed_model, 'observed_model');
    if (input.observed_model === 'unknown') {
        throw new Error('observed_model attestation must identify the observed model');
    }
    validateFallback(input.fallback_used, input.fallback_model, input.fallback_reason);
    const attest = db.transaction(() => {
        const result = db.prepare(`
      UPDATE task_attempts
      SET observed_model = ?, fallback_used = ?, fallback_model = ?, fallback_reason = ?
      WHERE id = ? AND status = 'running' AND execution_outcome IS NULL
    `).run(input.observed_model, input.fallback_used ? 1 : 0, input.fallback_model ?? null, input.fallback_reason ?? null, attemptId);
        if (result.changes === 0) {
            const existing = db.prepare('SELECT status, execution_outcome FROM task_attempts WHERE id = ?')
                .get(attemptId);
            if (!existing)
                throw new Error(`Attempt ${attemptId} not found`);
            throw new Error(`Attempt ${attemptId} is already terminal`);
        }
        return getDispatchReceipt(db, attemptId);
    });
    return attest.immediate();
}
export function finalizeAttempt(db, attemptId, outcome, reason) {
    requireNonEmpty(reason, 'reason');
    const storageStatus = outcome === 'unavailable' ? 'failed' : 'abandoned';
    const finalize = db.transaction(() => {
        const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId);
        if (!attempt)
            throw new Error(`Attempt ${attemptId} not found`);
        if (attempt.status !== 'running' || attempt.execution_outcome !== null) {
            throw new Error(`Attempt ${attemptId} is already terminal`);
        }
        const endedAt = new Date().toISOString();
        db.prepare(`
      UPDATE task_attempts
      SET status = ?, execution_outcome = ?, failure_reason = ?, ended_at = ?
      WHERE id = ? AND status = 'running' AND execution_outcome IS NULL
    `).run(storageStatus, outcome, reason, endedAt, attemptId);
        db.prepare(`
      UPDATE tasks SET execution_outcome = ?
      WHERE id = ? AND status NOT IN ('completed', 'cancelled')
    `).run(outcome, attempt.task_id);
        logEvent(db, attempt.agent_id, 'dispatch', {
            attempt_id: attemptId,
            task_id: attempt.task_id,
            terminal_status: outcome,
            reason,
        });
        return getDispatchReceipt(db, attemptId);
    });
    return finalize.immediate();
}
//# sourceMappingURL=dispatch-ops.js.map