import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import {
  createPlan,
  updatePlanStatus,
  getPlan,
  listPlans,
  addPlanReview,
  addResearchPacket,
  getResearchPackets,
  linkPlanTask,
  getPlanTaskIds,
} from '../../shared/src/plan-ops.js';
import type { Database, PlanRow, PlanReviewRow, ResearchPacketRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('plan-ops', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  // ── createPlan ──────────────────────────────────────────────────────

  describe('createPlan', () => {
    it('creates a plan in proposed status with correct defaults', () => {
      const plan = createPlan(db, 'plan-001', { subject: 'Migrate to v2' });
      expect(plan.id).toBe('plan-001');
      expect(plan.subject).toBe('Migrate to v2');
      expect(plan.status).toBe('proposed');
      expect(plan.owner).toBe('lead');
      expect(plan.description).toBeNull();
      expect(plan.rationale).toBeNull();
      expect(plan.open_questions).toBeNull();
      expect(plan.created_at).toBeTruthy();
      expect(plan.updated_at).toBeTruthy();
    });

    it('stores optional fields when provided', () => {
      const plan = createPlan(db, 'plan-002', {
        subject: 'Refactor DB layer',
        description: 'Move from raw SQL to query builder',
        rationale: 'Type safety and composability',
        open_questions: 'Which query builder?',
      }, 'alice');
      expect(plan.description).toBe('Move from raw SQL to query builder');
      expect(plan.rationale).toBe('Type safety and composability');
      expect(plan.open_questions).toBe('Which query builder?');
      expect(plan.owner).toBe('alice');
    });

    it('logs an event on creation', () => {
      createPlan(db, 'plan-003', { subject: 'Test event logging' });
      const events = db.prepare(
        "SELECT * FROM events WHERE event_type = 'task_created'"
      ).all() as Array<{ payload: string }>;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(events[events.length - 1].payload);
      expect(payload.plan_id).toBe('plan-003');
      expect(payload.type).toBe('plan');
    });
  });

  // ── updatePlanStatus ────────────────────────────────────────────────

  describe('updatePlanStatus', () => {
    it('transitions proposed -> challenged', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      const updated = updatePlanStatus(db, 'p1', 'challenged');
      expect(updated.status).toBe('challenged');
    });

    it('transitions proposed -> operational', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      const updated = updatePlanStatus(db, 'p1', 'operational');
      expect(updated.status).toBe('operational');
    });

    it('transitions proposed -> superseded', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      const updated = updatePlanStatus(db, 'p1', 'superseded');
      expect(updated.status).toBe('superseded');
    });

    it('transitions challenged -> proposed', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'challenged');
      const updated = updatePlanStatus(db, 'p1', 'proposed');
      expect(updated.status).toBe('proposed');
    });

    it('transitions challenged -> operational', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'challenged');
      const updated = updatePlanStatus(db, 'p1', 'operational');
      expect(updated.status).toBe('operational');
    });

    it('transitions operational -> superseded', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'operational');
      const updated = updatePlanStatus(db, 'p1', 'superseded');
      expect(updated.status).toBe('superseded');
    });

    it('rejects operational -> proposed', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'operational');
      expect(() => updatePlanStatus(db, 'p1', 'proposed'))
        .toThrow('Invalid plan transition: operational -> proposed');
    });

    it('rejects operational -> challenged', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'operational');
      expect(() => updatePlanStatus(db, 'p1', 'challenged'))
        .toThrow('Invalid plan transition: operational -> challenged');
    });

    it('rejects superseded -> any status (terminal)', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'superseded');

      expect(() => updatePlanStatus(db, 'p1', 'proposed'))
        .toThrow('(none — terminal state)');
      expect(() => updatePlanStatus(db, 'p1', 'challenged'))
        .toThrow('(none — terminal state)');
      expect(() => updatePlanStatus(db, 'p1', 'operational'))
        .toThrow('(none — terminal state)');
    });

    it('throws for non-existent plan', () => {
      expect(() => updatePlanStatus(db, 'ghost', 'operational'))
        .toThrow('Plan ghost not found');
    });

    it('updates the updated_at timestamp', () => {
      const plan = createPlan(db, 'p1', { subject: 'Test' });
      const before = plan.updated_at;
      const updated = updatePlanStatus(db, 'p1', 'challenged');
      expect(new Date(updated.updated_at).getTime())
        .toBeGreaterThanOrEqual(new Date(before).getTime());
    });

    it('logs an event on status change', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'challenged', 'reviewer-1');
      const events = db.prepare(
        "SELECT * FROM events WHERE event_type = 'task_updated'"
      ).all() as Array<{ actor: string; payload: string }>;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1];
      expect(last.actor).toBe('reviewer-1');
      const payload = JSON.parse(last.payload);
      expect(payload.plan_id).toBe('p1');
      expect(payload.status).toBe('challenged');
    });
  });

  // ── getPlan ─────────────────────────────────────────────────────────

  describe('getPlan', () => {
    it('returns a plan by ID', () => {
      createPlan(db, 'p1', { subject: 'Findable' });
      const plan = getPlan(db, 'p1');
      expect(plan).toBeDefined();
      expect(plan!.id).toBe('p1');
      expect(plan!.subject).toBe('Findable');
    });

    it('returns undefined for non-existent plan', () => {
      const plan = getPlan(db, 'nonexistent');
      expect(plan).toBeUndefined();
    });
  });

  // ── listPlans ───────────────────────────────────────────────────────

  describe('listPlans', () => {
    it('returns all plans when no filter', () => {
      createPlan(db, 'p1', { subject: 'Plan A' });
      createPlan(db, 'p2', { subject: 'Plan B' });
      createPlan(db, 'p3', { subject: 'Plan C' });
      const plans = listPlans(db);
      expect(plans).toHaveLength(3);
    });

    it('filters by status', () => {
      createPlan(db, 'p1', { subject: 'Plan A' });
      createPlan(db, 'p2', { subject: 'Plan B' });
      updatePlanStatus(db, 'p2', 'operational');

      const proposed = listPlans(db, 'proposed');
      expect(proposed).toHaveLength(1);
      expect(proposed[0].id).toBe('p1');

      const operational = listPlans(db, 'operational');
      expect(operational).toHaveLength(1);
      expect(operational[0].id).toBe('p2');
    });

    it('returns empty array when no plans match filter', () => {
      createPlan(db, 'p1', { subject: 'Plan A' });
      const superseded = listPlans(db, 'superseded');
      expect(superseded).toEqual([]);
    });

    it('orders by updated_at DESC', () => {
      createPlan(db, 'p1', { subject: 'First' });
      createPlan(db, 'p2', { subject: 'Second' });
      // Update p1 so it has a newer updated_at
      updatePlanStatus(db, 'p1', 'challenged');
      updatePlanStatus(db, 'p1', 'proposed');

      const plans = listPlans(db);
      // p1 was updated most recently, should be first
      expect(plans[0].id).toBe('p1');
    });
  });

  // ── addPlanReview ───────────────────────────────────────────────────

  describe('addPlanReview', () => {
    it('creates a review record', () => {
      createPlan(db, 'p1', { subject: 'Reviewable' });
      const review = addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'bob',
        disposition: 'challenged',
        comment: 'Needs more research',
      });
      expect(review.id).toBe('rev-001');
      expect(review.plan_id).toBe('p1');
      expect(review.reviewer).toBe('bob');
      expect(review.disposition).toBe('challenged');
      expect(review.comment).toBe('Needs more research');
      expect(review.created_at).toBeTruthy();
    });

    it('creates review without comment', () => {
      createPlan(db, 'p1', { subject: 'Reviewable' });
      const review = addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'bob',
        disposition: 'approved',
      });
      expect(review.comment).toBeNull();
    });

    it('auto-transitions proposed plan to challenged on challenge disposition', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'critic',
        disposition: 'challenged',
      });
      const plan = getPlan(db, 'p1');
      expect(plan!.status).toBe('challenged');
    });

    it('auto-transitions proposed plan to operational on approval', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'approver',
        disposition: 'approved',
      });
      const plan = getPlan(db, 'p1');
      expect(plan!.status).toBe('operational');
    });

    it('auto-transitions challenged plan to operational on approval', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'challenged');
      addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'approver',
        disposition: 'approved',
      });
      const plan = getPlan(db, 'p1');
      expect(plan!.status).toBe('operational');
    });

    it('does not auto-transition operational plan on challenged disposition', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'operational');
      // challenged disposition on an operational plan should not change status
      // because the code only transitions proposed -> challenged
      addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'critic',
        disposition: 'challenged',
      });
      const plan = getPlan(db, 'p1');
      expect(plan!.status).toBe('operational');
    });

    it('does not auto-transition already operational plan on approval', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      updatePlanStatus(db, 'p1', 'operational');
      // approved disposition on operational plan: code says status !== 'operational'
      // so no transition should fire
      addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'approver',
        disposition: 'approved',
      });
      const plan = getPlan(db, 'p1');
      expect(plan!.status).toBe('operational');
    });

    it('rejected disposition does not auto-transition', () => {
      createPlan(db, 'p1', { subject: 'Test' });
      addPlanReview(db, 'rev-001', {
        plan_id: 'p1',
        reviewer: 'critic',
        disposition: 'rejected',
      });
      const plan = getPlan(db, 'p1');
      expect(plan!.status).toBe('proposed');
    });

    it('throws for non-existent plan', () => {
      expect(() => addPlanReview(db, 'rev-001', {
        plan_id: 'ghost',
        reviewer: 'bob',
        disposition: 'approved',
      })).toThrow('Plan ghost not found');
    });
  });

  // ── addResearchPacket / getResearchPackets ──────────────────────────

  describe('addResearchPacket', () => {
    it('creates a research packet linked to a plan', () => {
      createPlan(db, 'p1', { subject: 'Research target' });
      const packet = addResearchPacket(db, 'rp-001', {
        plan_id: 'p1',
        subject: 'Market analysis',
        findings: 'Competitors use GraphQL',
        author: 'researcher-1',
      });
      expect(packet.id).toBe('rp-001');
      expect(packet.plan_id).toBe('p1');
      expect(packet.subject).toBe('Market analysis');
      expect(packet.findings).toBe('Competitors use GraphQL');
      expect(packet.author).toBe('researcher-1');
      expect(packet.created_at).toBeTruthy();
    });

    it('creates a research packet without a plan link', () => {
      const packet = addResearchPacket(db, 'rp-002', {
        subject: 'General investigation',
        findings: 'Interesting patterns found',
        author: 'researcher-2',
      });
      expect(packet.plan_id).toBeNull();
    });
  });

  describe('getResearchPackets', () => {
    it('returns packets for a specific plan', () => {
      createPlan(db, 'p1', { subject: 'Target plan' });
      addResearchPacket(db, 'rp-001', {
        plan_id: 'p1',
        subject: 'First finding',
        findings: 'Finding A',
        author: 'alice',
      });
      addResearchPacket(db, 'rp-002', {
        plan_id: 'p1',
        subject: 'Second finding',
        findings: 'Finding B',
        author: 'bob',
      });

      const packets = getResearchPackets(db, 'p1');
      expect(packets).toHaveLength(2);
      expect(packets[0].id).toBe('rp-001');
      expect(packets[1].id).toBe('rp-002');
    });

    it('returns empty array for plan with no packets', () => {
      createPlan(db, 'p1', { subject: 'Empty plan' });
      const packets = getResearchPackets(db, 'p1');
      expect(packets).toEqual([]);
    });

    it('does not return packets from other plans', () => {
      createPlan(db, 'p1', { subject: 'Plan A' });
      createPlan(db, 'p2', { subject: 'Plan B' });
      addResearchPacket(db, 'rp-001', {
        plan_id: 'p1',
        subject: 'For plan A only',
        findings: 'Data',
        author: 'alice',
      });

      const packets = getResearchPackets(db, 'p2');
      expect(packets).toEqual([]);
    });
  });

  // ── linkPlanTask / getPlanTaskIds ───────────────────────────────────

  describe('linkPlanTask / getPlanTaskIds', () => {
    it('links a plan to a task and retrieves task IDs', () => {
      createPlan(db, 'p1', { subject: 'Plan with tasks' });
      db.prepare("INSERT INTO tasks (id, subject) VALUES (?, ?)").run('t1', 'Task 1');
      db.prepare("INSERT INTO tasks (id, subject) VALUES (?, ?)").run('t2', 'Task 2');

      linkPlanTask(db, 'p1', 't1');
      linkPlanTask(db, 'p1', 't2');

      const taskIds = getPlanTaskIds(db, 'p1');
      expect(taskIds).toHaveLength(2);
      expect(taskIds).toContain('t1');
      expect(taskIds).toContain('t2');
    });

    it('returns empty array when plan has no linked tasks', () => {
      createPlan(db, 'p1', { subject: 'No tasks' });
      const taskIds = getPlanTaskIds(db, 'p1');
      expect(taskIds).toEqual([]);
    });

    it('duplicate link is idempotent (INSERT OR IGNORE)', () => {
      createPlan(db, 'p1', { subject: 'Plan' });
      db.prepare("INSERT INTO tasks (id, subject) VALUES (?, ?)").run('t1', 'Task 1');

      linkPlanTask(db, 'p1', 't1');
      linkPlanTask(db, 'p1', 't1'); // Should not throw or duplicate

      const taskIds = getPlanTaskIds(db, 'p1');
      expect(taskIds).toHaveLength(1);
      expect(taskIds[0]).toBe('t1');
    });

    it('different plans can link to the same task', () => {
      createPlan(db, 'p1', { subject: 'Plan A' });
      createPlan(db, 'p2', { subject: 'Plan B' });
      db.prepare("INSERT INTO tasks (id, subject) VALUES (?, ?)").run('t1', 'Shared task');

      linkPlanTask(db, 'p1', 't1');
      linkPlanTask(db, 'p2', 't1');

      expect(getPlanTaskIds(db, 'p1')).toEqual(['t1']);
      expect(getPlanTaskIds(db, 'p2')).toEqual(['t1']);
    });
  });
});
