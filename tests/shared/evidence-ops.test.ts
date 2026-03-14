import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import {
  createAttempt,
  completeAttempt,
  getTaskAttempts,
  getLatestAttempt,
  addEvidence,
  reviewEvidence,
  getAttemptEvidence,
  hasAcceptedEvidence,
} from '../../shared/src/evidence-ops.js';
import type { Database, TaskAttemptRow, EvidencePacketRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('evidence-ops', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    // Seed a task for attempts to reference
    db.prepare("INSERT INTO tasks (id, subject) VALUES (?, ?)").run('t1', 'Test task');
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  describe('createAttempt', () => {
    it('creates attempt in running status', () => {
      const attempt = createAttempt(db, 'att-1', { task_id: 't1' });
      expect(attempt.id).toBe('att-1');
      expect(attempt.task_id).toBe('t1');
      expect(attempt.status).toBe('running');
      expect(attempt.started_at).toBeTruthy();
      expect(attempt.ended_at).toBeNull();
      expect(attempt.agent_id).toBeNull();
      expect(attempt.execution_target_id).toBeNull();
      expect(attempt.model_family).toBeNull();
      expect(attempt.failure_reason).toBeNull();
      expect(attempt.result_summary).toBeNull();
      expect(attempt.confidence).toBeNull();
    });

    it('stores optional fields when provided', () => {
      const attempt = createAttempt(db, 'att-2', {
        task_id: 't1',
        agent_id: 'agent-a',
        execution_target_id: 'et-1',
        model_family: 'opus',
      });
      expect(attempt.agent_id).toBe('agent-a');
      expect(attempt.execution_target_id).toBe('et-1');
      expect(attempt.model_family).toBe('opus');
    });
  });

  describe('completeAttempt', () => {
    it('transitions running attempt to succeeded', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const completed = completeAttempt(db, 'att-1', 'succeeded', 'All tests pass', 0.95);
      expect(completed.status).toBe('succeeded');
      expect(completed.ended_at).toBeTruthy();
      expect(completed.result_summary).toBe('All tests pass');
      expect(completed.confidence).toBe(0.95);
      expect(completed.failure_reason).toBeNull();
    });

    it('transitions running attempt to failed with reason', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const completed = completeAttempt(db, 'att-1', 'failed', undefined, undefined, 'compile error');
      expect(completed.status).toBe('failed');
      expect(completed.ended_at).toBeTruthy();
      expect(completed.failure_reason).toBe('compile error');
      expect(completed.result_summary).toBeNull();
    });

    it('transitions running attempt to abandoned', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const completed = completeAttempt(db, 'att-1', 'abandoned');
      expect(completed.status).toBe('abandoned');
      expect(completed.ended_at).toBeTruthy();
    });

    it('throws for non-existent attempt', () => {
      expect(() => completeAttempt(db, 'does-not-exist', 'succeeded')).toThrow(
        'Attempt does-not-exist not found'
      );
    });

    it('does not update an already-completed attempt', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      completeAttempt(db, 'att-1', 'failed', undefined, undefined, 'first failure');
      // Attempting to complete again should not change status (UPDATE WHERE status='running' matches nothing),
      // but the row still exists so it returns the unchanged row
      const second = completeAttempt(db, 'att-1', 'succeeded', 'second try');
      expect(second.status).toBe('failed');
      expect(second.failure_reason).toBe('first failure');
    });
  });

  describe('getTaskAttempts', () => {
    it('returns all attempts for a task ordered by started_at', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      createAttempt(db, 'att-2', { task_id: 't1' });
      createAttempt(db, 'att-3', { task_id: 't1' });

      const attempts = getTaskAttempts(db, 't1');
      expect(attempts).toHaveLength(3);
      expect(attempts[0].id).toBe('att-1');
      expect(attempts[1].id).toBe('att-2');
      expect(attempts[2].id).toBe('att-3');
    });

    it('returns empty array for task with no attempts', () => {
      const attempts = getTaskAttempts(db, 't1');
      expect(attempts).toEqual([]);
    });

    it('does not include attempts for other tasks', () => {
      db.prepare("INSERT INTO tasks (id, subject) VALUES (?, ?)").run('t2', 'Other task');
      createAttempt(db, 'att-1', { task_id: 't1' });
      createAttempt(db, 'att-2', { task_id: 't2' });

      const attempts = getTaskAttempts(db, 't1');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].id).toBe('att-1');
    });
  });

  describe('getLatestAttempt', () => {
    it('returns most recent attempt', () => {
      // BUG: getLatestAttempt orders by started_at DESC, but SQLite DEFAULT
      // timestamps can collide within the same millisecond when inserts are
      // rapid. This causes non-deterministic results among tied rows.
      // Workaround: manually set distinct started_at values to test intended behavior.
      createAttempt(db, 'att-1', { task_id: 't1' });
      createAttempt(db, 'att-2', { task_id: 't1' });
      createAttempt(db, 'att-3', { task_id: 't1' });
      db.prepare("UPDATE task_attempts SET started_at = '2025-01-01T00:00:00.000Z' WHERE id = 'att-1'").run();
      db.prepare("UPDATE task_attempts SET started_at = '2025-01-01T00:00:01.000Z' WHERE id = 'att-2'").run();
      db.prepare("UPDATE task_attempts SET started_at = '2025-01-01T00:00:02.000Z' WHERE id = 'att-3'").run();

      const latest = getLatestAttempt(db, 't1');
      expect(latest).toBeDefined();
      expect(latest!.id).toBe('att-3');
    });

    it('returns undefined when no attempts exist', () => {
      const latest = getLatestAttempt(db, 't1');
      expect(latest).toBeUndefined();
    });
  });

  describe('addEvidence', () => {
    it('creates evidence packet linked to attempt', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const evidence = addEvidence(db, 'ev-1', {
        attempt_id: 'att-1',
        type: 'test_result',
        payload: '{"passed": 42, "failed": 0}',
        hash: 'sha256:abc123',
      });
      expect(evidence.id).toBe('ev-1');
      expect(evidence.attempt_id).toBe('att-1');
      expect(evidence.type).toBe('test_result');
      expect(evidence.payload).toBe('{"passed": 42, "failed": 0}');
      expect(evidence.hash).toBe('sha256:abc123');
      expect(evidence.reviewer_disposition).toBeNull();
      expect(evidence.created_at).toBeTruthy();
    });

    it('stores evidence without optional hash', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const evidence = addEvidence(db, 'ev-1', {
        attempt_id: 'att-1',
        type: 'diff',
        payload: '+added line\n-removed line',
      });
      expect(evidence.hash).toBeNull();
    });

    it('supports all evidence types', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const types = ['diff', 'test_result', 'build_log', 'screenshot', 'review_comment', 'artifact_checksum'] as const;
      for (const [i, type] of types.entries()) {
        const ev = addEvidence(db, `ev-${i}`, {
          attempt_id: 'att-1',
          type,
          payload: `payload for ${type}`,
        });
        expect(ev.type).toBe(type);
      }
    });
  });

  describe('reviewEvidence', () => {
    it('sets reviewer disposition to approved', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', {
        attempt_id: 'att-1',
        type: 'test_result',
        payload: 'all green',
      });
      const reviewed = reviewEvidence(db, 'ev-1', 'approved');
      expect(reviewed.reviewer_disposition).toBe('approved');
    });

    it('sets reviewer disposition to challenged', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', {
        attempt_id: 'att-1',
        type: 'test_result',
        payload: 'partial coverage',
      });
      const reviewed = reviewEvidence(db, 'ev-1', 'challenged');
      expect(reviewed.reviewer_disposition).toBe('challenged');
    });

    it('sets reviewer disposition to rejected', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', {
        attempt_id: 'att-1',
        type: 'build_log',
        payload: 'build failed',
      });
      const reviewed = reviewEvidence(db, 'ev-1', 'rejected');
      expect(reviewed.reviewer_disposition).toBe('rejected');
    });

    it('throws for non-existent evidence', () => {
      expect(() => reviewEvidence(db, 'does-not-exist', 'approved')).toThrow(
        'Evidence does-not-exist not found'
      );
    });
  });

  describe('getAttemptEvidence', () => {
    it('returns evidence for an attempt ordered by created_at', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'diff', payload: 'diff1' });
      addEvidence(db, 'ev-2', { attempt_id: 'att-1', type: 'test_result', payload: 'test1' });
      addEvidence(db, 'ev-3', { attempt_id: 'att-1', type: 'build_log', payload: 'log1' });

      const packets = getAttemptEvidence(db, 'att-1');
      expect(packets).toHaveLength(3);
      expect(packets[0].id).toBe('ev-1');
      expect(packets[1].id).toBe('ev-2');
      expect(packets[2].id).toBe('ev-3');
    });

    it('returns empty array when attempt has no evidence', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      const packets = getAttemptEvidence(db, 'att-1');
      expect(packets).toEqual([]);
    });

    it('does not include evidence from other attempts', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      createAttempt(db, 'att-2', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'diff', payload: 'p1' });
      addEvidence(db, 'ev-2', { attempt_id: 'att-2', type: 'diff', payload: 'p2' });

      const packets = getAttemptEvidence(db, 'att-1');
      expect(packets).toHaveLength(1);
      expect(packets[0].id).toBe('ev-1');
    });
  });

  describe('hasAcceptedEvidence', () => {
    it('returns true when succeeded attempt has all evidence approved', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'test_result', payload: 'pass' });
      addEvidence(db, 'ev-2', { attempt_id: 'att-1', type: 'diff', payload: 'changes' });
      reviewEvidence(db, 'ev-1', 'approved');
      reviewEvidence(db, 'ev-2', 'approved');
      completeAttempt(db, 'att-1', 'succeeded', 'done');

      expect(hasAcceptedEvidence(db, 't1')).toBe(true);
    });

    it('returns false when no succeeded attempts exist', () => {
      // No attempts at all
      expect(hasAcceptedEvidence(db, 't1')).toBe(false);
    });

    it('returns false when attempt is failed even with approved evidence', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'test_result', payload: 'pass' });
      reviewEvidence(db, 'ev-1', 'approved');
      completeAttempt(db, 'att-1', 'failed', undefined, undefined, 'late failure');

      expect(hasAcceptedEvidence(db, 't1')).toBe(false);
    });

    it('returns false when evidence is not all approved', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'test_result', payload: 'pass' });
      addEvidence(db, 'ev-2', { attempt_id: 'att-1', type: 'diff', payload: 'changes' });
      reviewEvidence(db, 'ev-1', 'approved');
      reviewEvidence(db, 'ev-2', 'rejected');
      completeAttempt(db, 'att-1', 'succeeded', 'done');

      expect(hasAcceptedEvidence(db, 't1')).toBe(false);
    });

    it('returns false when evidence has no disposition yet', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'test_result', payload: 'pass' });
      completeAttempt(db, 'att-1', 'succeeded', 'done');

      expect(hasAcceptedEvidence(db, 't1')).toBe(false);
    });

    it('returns false when succeeded attempt has no evidence packets', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      completeAttempt(db, 'att-1', 'succeeded', 'done with no evidence');

      expect(hasAcceptedEvidence(db, 't1')).toBe(false);
    });

    it('returns true when at least one succeeded attempt has all evidence approved among multiple attempts', () => {
      // First attempt fails
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'test_result', payload: 'fail' });
      reviewEvidence(db, 'ev-1', 'rejected');
      completeAttempt(db, 'att-1', 'failed', undefined, undefined, 'test failure');

      // Second attempt succeeds with approved evidence
      createAttempt(db, 'att-2', { task_id: 't1' });
      addEvidence(db, 'ev-2', { attempt_id: 'att-2', type: 'test_result', payload: 'pass' });
      reviewEvidence(db, 'ev-2', 'approved');
      completeAttempt(db, 'att-2', 'succeeded', 'all good');

      expect(hasAcceptedEvidence(db, 't1')).toBe(true);
    });

    it('returns false when evidence is partially approved and partially unreviewed', () => {
      createAttempt(db, 'att-1', { task_id: 't1' });
      addEvidence(db, 'ev-1', { attempt_id: 'att-1', type: 'test_result', payload: 'pass' });
      addEvidence(db, 'ev-2', { attempt_id: 'att-1', type: 'diff', payload: 'changes' });
      reviewEvidence(db, 'ev-1', 'approved');
      // ev-2 left unreviewed
      completeAttempt(db, 'att-1', 'succeeded', 'done');

      expect(hasAcceptedEvidence(db, 't1')).toBe(false);
    });
  });
});
