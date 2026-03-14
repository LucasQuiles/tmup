/**
 * Planning domain operations: CRUD for plans, reviews, and research packets.
 *
 * P5.2: first-class planning domain with collaborative lifecycle:
 *   research -> synthesize -> challenge -> refine -> approve -> execute -> verify -> learn
 *
 * Plan states: proposed -> challenged -> operational -> superseded
 */
import type {
  Database,
  PlanRow, PlanReviewRow, ResearchPacketRow, PlanStatus,
  CreatePlanInput, CreatePlanReviewInput, CreateResearchPacketInput,
} from './types.js';
import { logEvent } from './event-ops.js';

// Valid plan state transitions
const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  proposed: ['challenged', 'operational', 'superseded'],
  challenged: ['proposed', 'operational', 'superseded'],
  operational: ['superseded'],
  superseded: [],  // Terminal
};

/**
 * Create a new plan in 'proposed' state.
 */
export function createPlan(
  db: Database,
  planId: string,
  input: CreatePlanInput,
  actorId: string = 'lead'
): PlanRow {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO plans (id, subject, description, status, owner, rationale, open_questions, created_at, updated_at)
    VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?)
  `).run(
    planId,
    input.subject,
    input.description ?? null,
    actorId,
    input.rationale ?? null,
    input.open_questions ?? null,
    now, now
  );

  logEvent(db, actorId, 'task_created', { plan_id: planId, type: 'plan' });

  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow;
}

/**
 * Transition a plan's status. Validates allowed transitions.
 */
export function updatePlanStatus(
  db: Database,
  planId: string,
  newStatus: PlanStatus,
  actorId: string = 'lead'
): PlanRow {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const allowed = PLAN_TRANSITIONS[plan.status];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid plan transition: ${plan.status} -> ${newStatus}. ` +
      `Allowed: ${allowed.join(', ') || '(none — terminal state)'}`
    );
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, planId);

  logEvent(db, actorId, 'task_updated', { plan_id: planId, status: newStatus, type: 'plan' });

  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow;
}

/**
 * Get a plan by ID.
 */
export function getPlan(db: Database, planId: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
}

/**
 * List plans, optionally filtered by status.
 */
export function listPlans(db: Database, status?: PlanStatus): PlanRow[] {
  if (status) {
    return db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY updated_at DESC').all(status) as PlanRow[];
  }
  return db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as PlanRow[];
}

/**
 * Add a review to a plan. Automatically transitions plan status if approved/challenged.
 */
export function addPlanReview(
  db: Database,
  reviewId: string,
  input: CreatePlanReviewInput
): PlanReviewRow {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(input.plan_id) as PlanRow | undefined;
  if (!plan) throw new Error(`Plan ${input.plan_id} not found`);

  db.prepare(`
    INSERT INTO plan_reviews (id, plan_id, reviewer, disposition, comment)
    VALUES (?, ?, ?, ?, ?)
  `).run(reviewId, input.plan_id, input.reviewer, input.disposition, input.comment ?? null);

  // Auto-transition on review
  if (input.disposition === 'challenged' && plan.status === 'proposed') {
    updatePlanStatus(db, input.plan_id, 'challenged', input.reviewer);
  } else if (input.disposition === 'approved' && plan.status !== 'operational') {
    updatePlanStatus(db, input.plan_id, 'operational', input.reviewer);
  }

  return db.prepare('SELECT * FROM plan_reviews WHERE id = ?').get(reviewId) as PlanReviewRow;
}

/**
 * Get reviews for a plan.
 */
export function getPlanReviews(db: Database, planId: string): PlanReviewRow[] {
  return db.prepare(
    'SELECT * FROM plan_reviews WHERE plan_id = ? ORDER BY created_at ASC'
  ).all(planId) as PlanReviewRow[];
}

/**
 * Add a research packet, optionally linked to a plan.
 */
export function addResearchPacket(
  db: Database,
  packetId: string,
  input: CreateResearchPacketInput
): ResearchPacketRow {
  db.prepare(`
    INSERT INTO research_packets (id, plan_id, subject, findings, author)
    VALUES (?, ?, ?, ?, ?)
  `).run(packetId, input.plan_id ?? null, input.subject, input.findings, input.author);

  return db.prepare('SELECT * FROM research_packets WHERE id = ?').get(packetId) as ResearchPacketRow;
}

/**
 * Get research packets for a plan.
 */
export function getResearchPackets(db: Database, planId: string): ResearchPacketRow[] {
  return db.prepare(
    'SELECT * FROM research_packets WHERE plan_id = ? ORDER BY created_at ASC'
  ).all(planId) as ResearchPacketRow[];
}

/**
 * Link a plan to execution tasks.
 */
export function linkPlanTask(db: Database, planId: string, taskId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO plan_tasks (plan_id, task_id) VALUES (?, ?)'
  ).run(planId, taskId);
}

/**
 * Get task IDs linked to a plan.
 */
export function getPlanTaskIds(db: Database, planId: string): string[] {
  const rows = db.prepare(
    'SELECT task_id FROM plan_tasks WHERE plan_id = ?'
  ).all(planId) as Array<{ task_id: string }>;
  return rows.map(r => r.task_id);
}
