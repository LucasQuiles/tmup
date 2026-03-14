import { logEvent } from './event-ops.js';
// Valid plan state transitions
const PLAN_TRANSITIONS = {
    proposed: ['challenged', 'operational', 'superseded'],
    challenged: ['proposed', 'operational', 'superseded'],
    operational: ['superseded'],
    superseded: [], // Terminal
};
/**
 * Create a new plan in 'proposed' state.
 */
export function createPlan(db, planId, input, actorId = 'lead') {
    const now = new Date().toISOString();
    db.prepare(`
    INSERT INTO plans (id, subject, description, status, owner, rationale, open_questions, created_at, updated_at)
    VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?)
  `).run(planId, input.subject, input.description ?? null, actorId, input.rationale ?? null, input.open_questions ?? null, now, now);
    logEvent(db, actorId, 'task_created', { plan_id: planId, type: 'plan' });
    return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}
/**
 * Transition a plan's status. Validates allowed transitions.
 */
export function updatePlanStatus(db, planId, newStatus, actorId = 'lead') {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!plan)
        throw new Error(`Plan ${planId} not found`);
    const allowed = PLAN_TRANSITIONS[plan.status];
    if (!allowed.includes(newStatus)) {
        throw new Error(`Invalid plan transition: ${plan.status} -> ${newStatus}. ` +
            `Allowed: ${allowed.join(', ') || '(none — terminal state)'}`);
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, planId);
    logEvent(db, actorId, 'task_updated', { plan_id: planId, status: newStatus, type: 'plan' });
    return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}
/**
 * Get a plan by ID.
 */
export function getPlan(db, planId) {
    return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}
/**
 * List plans, optionally filtered by status.
 */
export function listPlans(db, status) {
    if (status) {
        return db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY updated_at DESC').all(status);
    }
    return db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all();
}
/**
 * Add a review to a plan. Automatically transitions plan status if approved/challenged.
 */
export function addPlanReview(db, reviewId, input) {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(input.plan_id);
    if (!plan)
        throw new Error(`Plan ${input.plan_id} not found`);
    db.prepare(`
    INSERT INTO plan_reviews (id, plan_id, reviewer, disposition, comment)
    VALUES (?, ?, ?, ?, ?)
  `).run(reviewId, input.plan_id, input.reviewer, input.disposition, input.comment ?? null);
    // Auto-transition on review
    if (input.disposition === 'challenged' && plan.status === 'proposed') {
        updatePlanStatus(db, input.plan_id, 'challenged', input.reviewer);
    }
    else if (input.disposition === 'approved' && plan.status !== 'operational') {
        updatePlanStatus(db, input.plan_id, 'operational', input.reviewer);
    }
    return db.prepare('SELECT * FROM plan_reviews WHERE id = ?').get(reviewId);
}
/**
 * Get reviews for a plan.
 */
export function getPlanReviews(db, planId) {
    return db.prepare('SELECT * FROM plan_reviews WHERE plan_id = ? ORDER BY created_at ASC').all(planId);
}
/**
 * Add a research packet, optionally linked to a plan.
 */
export function addResearchPacket(db, packetId, input) {
    db.prepare(`
    INSERT INTO research_packets (id, plan_id, subject, findings, author)
    VALUES (?, ?, ?, ?, ?)
  `).run(packetId, input.plan_id ?? null, input.subject, input.findings, input.author);
    return db.prepare('SELECT * FROM research_packets WHERE id = ?').get(packetId);
}
/**
 * Get research packets for a plan.
 */
export function getResearchPackets(db, planId) {
    return db.prepare('SELECT * FROM research_packets WHERE plan_id = ? ORDER BY created_at ASC').all(planId);
}
/**
 * Link a plan to execution tasks.
 */
export function linkPlanTask(db, planId, taskId) {
    db.prepare('INSERT OR IGNORE INTO plan_tasks (plan_id, task_id) VALUES (?, ?)').run(planId, taskId);
}
/**
 * Get task IDs linked to a plan.
 */
export function getPlanTaskIds(db, planId) {
    const rows = db.prepare('SELECT task_id FROM plan_tasks WHERE plan_id = ?').all(planId);
    return rows.map(r => r.task_id);
}
//# sourceMappingURL=plan-ops.js.map