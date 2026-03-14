import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask, createTaskBatch, updateTask } from '../../shared/src/task-ops.js';
import { claimTask, claimSpecificTask, completeTask, failTask, cancelTask } from '../../shared/src/task-lifecycle.js';
import { registerAgent } from '../../shared/src/agent-ops.js';
import { createArtifact, linkTaskArtifact, findArtifactByName, computeChecksum } from '../../shared/src/artifact-ops.js';
import { postCheckpoint } from '../../shared/src/message-ops.js';
import type { Database, TaskRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('task lifecycle', () => {
  let db: Database;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-art-'));
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('createTask', () => {
    it('auto-increments IDs', () => {
      const id1 = createTask(db, { subject: 'Task A' });
      const id2 = createTask(db, { subject: 'Task B' });
      expect(id1).toBe('001');
      expect(id2).toBe('002');
    });

    it('sets blocked status when deps are unmet', () => {
      const id1 = createTask(db, { subject: 'Task A' });
      const id2 = createTask(db, { subject: 'Task B', deps: [id1] });
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id2) as TaskRow;
      expect(task.status).toBe('blocked');
    });

    it('sets pending status when no deps', () => {
      const id = createTask(db, { subject: 'No deps' });
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('pending');
    });

    it('enforces 500 task limit', () => {
      for (let i = 0; i < 500; i++) {
        createTask(db, { subject: `Task ${i}` });
      }
      expect(() => createTask(db, { subject: 'One too many' })).toThrow('Task limit');
    });

    it('stores optional fields correctly', () => {
      const id = createTask(db, {
        subject: 'Full task',
        description: 'Detailed desc',
        role: 'implementer',
        priority: 90,
        max_retries: 5,
      });
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.description).toBe('Detailed desc');
      expect(task.role).toBe('implementer');
      expect(task.priority).toBe(90);
      expect(task.max_retries).toBe(5);
    });

    it('applies default values', () => {
      const id = createTask(db, { subject: 'Minimal' });
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.priority).toBe(50);
      expect(task.max_retries).toBe(3);
      expect(task.retry_count).toBe(0);
      expect(task.description).toBeNull();
      expect(task.role).toBeNull();
    });

    it('allows the first producer and rejects a second producer for the same artifact name', () => {
      const firstId = createTask(db, { subject: 'Build schema', produces: ['schema.sql'] });
      expect(firstId).toBe('001');

      const artifact = findArtifactByName(db, 'schema.sql');
      expect(artifact).toBeTruthy();

      const producerLink = db.prepare(
        "SELECT task_id, direction FROM task_artifacts WHERE artifact_id = ? AND direction = 'produces'"
      ).get(artifact!.id) as { task_id: string; direction: string };
      expect(producerLink.task_id).toBe(firstId);
      expect(producerLink.direction).toBe('produces');

      expect(() => createTask(db, { subject: 'Build schema again', produces: ['schema.sql'] }))
        .toThrow("Artifact 'schema.sql' already has a producer (task 001)");
    });

    it('allows requires for an artifact that already has a producer', () => {
      const producerId = createTask(db, { subject: 'Build schema', produces: ['schema.sql'] });
      const consumerId = createTask(db, { subject: 'Use schema', requires: ['schema.sql'] });
      const artifact = findArtifactByName(db, 'schema.sql');

      expect(producerId).toBe('001');
      expect(consumerId).toBe('002');
      expect(artifact).toBeTruthy();

      const links = db.prepare(
        'SELECT task_id, direction FROM task_artifacts WHERE artifact_id = ? ORDER BY task_id, direction'
      ).all(artifact!.id) as Array<{ task_id: string; direction: string }>;
      expect(links).toEqual([
        { task_id: producerId, direction: 'produces' },
        { task_id: consumerId, direction: 'requires' },
      ]);
    });

    it('rolls back duplicate producer rejection without orphan task or artifact rows', () => {
      createTask(db, { subject: 'Build schema', produces: ['schema.sql'] });

      const beforeTasks = (db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number }).cnt;
      const beforeArtifacts = (db.prepare('SELECT COUNT(*) as cnt FROM artifacts').get() as { cnt: number }).cnt;
      const beforeLinks = (db.prepare('SELECT COUNT(*) as cnt FROM task_artifacts').get() as { cnt: number }).cnt;

      expect(() => createTask(db, { subject: 'Duplicate schema build', produces: ['schema.sql'] }))
        .toThrow("Artifact 'schema.sql' already has a producer (task 001)");

      const afterTasks = (db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number }).cnt;
      const afterArtifacts = (db.prepare('SELECT COUNT(*) as cnt FROM artifacts').get() as { cnt: number }).cnt;
      const afterLinks = (db.prepare('SELECT COUNT(*) as cnt FROM task_artifacts').get() as { cnt: number }).cnt;
      const orphanTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('002') as TaskRow | undefined;

      expect(afterTasks).toBe(beforeTasks);
      expect(afterArtifacts).toBe(beforeArtifacts);
      expect(afterLinks).toBe(beforeLinks);
      expect(orphanTask).toBeUndefined();
    });
  });

  describe('createTaskBatch', () => {
    it('creates multiple tasks atomically', () => {
      const ids = createTaskBatch(db, [
        { subject: 'A' },
        { subject: 'B' },
        { subject: 'C' },
      ]);
      expect(ids).toEqual(['001', '002', '003']);
    });

    it('supports intra-batch deps', () => {
      const ids = createTaskBatch(db, [
        { subject: 'A' },
        { subject: 'B', deps: ['001'] },
      ]);
      expect(ids).toEqual(['001', '002']);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('002') as TaskRow;
      expect(task.status).toBe('blocked');
    });

    it('rolls back entire batch on failure — no orphaned rows', () => {
      expect(() => createTaskBatch(db, [
        { subject: 'A' },
        { subject: 'B', deps: ['999'] }, // non-existent dep
      ])).toThrow();
      const tasks = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      const deps = db.prepare('SELECT COUNT(*) as cnt FROM task_deps').get() as { cnt: number };
      expect(tasks.cnt).toBe(0);
      expect(deps.cnt).toBe(0);
    });

    it('atomic createTask: bad dep leaves no orphaned rows', () => {
      expect(() => createTask(db, { subject: 'Orphan', deps: ['999'] })).toThrow();
      const tasks = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      const deps = db.prepare('SELECT COUNT(*) as cnt FROM task_deps').get() as { cnt: number };
      expect(tasks.cnt).toBe(0);
      expect(deps.cnt).toBe(0);
    });
  });

  describe('claimTask', () => {
    it('claims highest priority pending task', () => {
      createTask(db, { subject: 'Low', priority: 10 });
      createTask(db, { subject: 'High', priority: 90 });
      const task = claimTask(db, 'agent-1');
      expect(task?.id).toBe('002');
      expect(task?.subject).toBe('High');
      expect(task?.status).toBe('claimed');
      expect(task?.owner).toBe('agent-1');

      // Low-priority task still pending
      const low = db.prepare('SELECT status FROM tasks WHERE id = ?').get('001') as TaskRow;
      expect(low.status).toBe('pending');
    });

    it('respects FIFO for same priority', () => {
      createTask(db, { subject: 'First' });
      createTask(db, { subject: 'Second' });
      const task = claimTask(db, 'agent-1');
      expect(task?.id).toBe('001');
    });

    it('returns null when no pending tasks', () => {
      const task = claimTask(db, 'agent-1');
      expect(task).toBeNull();
    });

    it('filters by role — only claims matching role', () => {
      createTask(db, { subject: 'Impl', role: 'implementer' });
      createTask(db, { subject: 'Test', role: 'tester' });
      const task = claimTask(db, 'agent-1', 'tester');
      expect(task?.id).toBe('002');
      expect(task?.role).toBe('tester');
    });

    it('null role only claims tasks with no role requirement', () => {
      createTask(db, { subject: 'Role-specific', role: 'implementer' });
      createTask(db, { subject: 'Any agent' }); // role is NULL

      const task = claimTask(db, 'agent-1'); // No role filter
      // Should get '002' (no role requirement), not '001' (requires implementer)
      expect(task?.id).toBe('002');
    });

    it('skips tasks with future retry_after', () => {
      const id = createTask(db, { subject: 'Retry later' });
      db.prepare("UPDATE tasks SET retry_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+3600 seconds') WHERE id = ?").run(id);
      const task = claimTask(db, 'agent-1');
      expect(task).toBeNull();
    });

    it('does not claim blocked tasks', () => {
      const id1 = createTask(db, { subject: 'A' });
      createTask(db, { subject: 'B', deps: [id1] }); // blocked
      // Claim should get A, not B
      const task = claimTask(db, 'agent-1');
      expect(task?.id).toBe('001');
      // Try claiming again — B is still blocked
      const task2 = claimTask(db, 'agent-2');
      expect(task2).toBeNull();
    });

    it('sets claimed_at timestamp', () => {
      createTask(db, { subject: 'Test' });
      const task = claimTask(db, 'agent-1');
      expect(task?.claimed_at).toBeTruthy();
      // Verify it's a valid ISO timestamp
      expect(new Date(task!.claimed_at!).getTime()).not.toBeNaN();
    });

    it('concurrent claims: only one agent wins', () => {
      createTask(db, { subject: 'Single task' });
      const r1 = claimTask(db, 'agent-1');
      const r2 = claimTask(db, 'agent-2');
      const winners = [r1, r2].filter(r => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.owner).toBe('agent-1');
    });
  });

  describe('completeTask', () => {
    it('marks task completed with timestamp and summary', () => {
      const id = createTask(db, { subject: 'Test' });
      claimTask(db, 'agent-1');
      completeTask(db, id, 'Done', undefined, undefined, 'agent-1');
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');
      expect(task.completed_at).not.toBeNull();
      expect(new Date(task.completed_at!).getTime()).not.toBeNaN();
      expect(task.result_summary).toBe('Done');
    });

    it('cascades to unblock dependent tasks', () => {
      const id1 = createTask(db, { subject: 'A' });
      const id2 = createTask(db, { subject: 'B', deps: [id1] });
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(id2) as TaskRow).status).toBe('blocked');

      claimTask(db, 'agent-1');
      const result = completeTask(db, id1, 'Done', undefined, undefined, 'agent-1');
      expect(result.unblocked).toContain(id2);

      const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id2) as TaskRow;
      expect(task2.status).toBe('pending');
    });

    it('rejects completion from pending status', () => {
      const id = createTask(db, { subject: 'Test' });
      expect(() => completeTask(db, id, 'Done', undefined, undefined, 'lead')).toThrow("cannot be completed from status 'pending'");
    });

    it('rejects completion from blocked status', () => {
      const id1 = createTask(db, { subject: 'A' });
      const id2 = createTask(db, { subject: 'B', deps: [id1] });
      expect(() => completeTask(db, id2, 'Done', undefined, undefined, 'lead')).toThrow("cannot be completed from status 'blocked'");
    });

    it('throws for non-existent task', () => {
      expect(() => completeTask(db, '999', 'Done', undefined, undefined, 'lead')).toThrow('not found');
    });

    it('completes task with artifacts — publishes and sets checksum', () => {
      // Create task with a "produces" artifact
      const id = createTask(db, { subject: 'Build', produces: ['output.json'] });
      claimTask(db, 'agent-1');

      // Create the actual file
      const filePath = path.join(tmpDir, 'output.json');
      fs.writeFileSync(filePath, '{"result":"ok"}');

      const result = completeTask(db, id, 'Built successfully', [
        { name: 'output.json', path: filePath },
      ], undefined, 'agent-1');

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');

      // Verify artifact was published with checksum
      const art = findArtifactByName(db, 'output.json');
      expect(art).toBeTruthy();
      expect(art!.status).toBe('published');
      expect(art!.path).toBe(filePath);
      expect(art!.checksum).toBe(computeChecksum(filePath));
    });

    it('rejects artifact path outside project dir when projectDir provided', () => {
      const id = createTask(db, { subject: 'Build', produces: ['evil.txt'] });
      claimTask(db, 'agent-1');

      // Create the file outside the project dir
      const evilPath = path.join(os.tmpdir(), 'evil-outside.txt');
      fs.writeFileSync(evilPath, 'data');
      try {
        expect(() => completeTask(db, id, 'Done', [
          { name: 'evil.txt', path: evilPath },
        ], tmpDir, 'agent-1')).toThrow('must be within project directory');

        // Task should NOT be completed since validation failed before transaction
        const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
        expect(task.status).toBe('claimed');
      } finally {
        try { fs.unlinkSync(evilPath); } catch {}
      }
    });

    it('accepts artifact path within project dir when projectDir provided', () => {
      const id = createTask(db, { subject: 'Build', produces: ['output.json'] });
      claimTask(db, 'agent-1');

      const filePath = path.join(tmpDir, 'output.json');
      fs.writeFileSync(filePath, '{"ok":true}');

      // Should NOT throw when path is within project dir
      const result = completeTask(db, id, 'Done', [
        { name: 'output.json', path: filePath },
      ], tmpDir, 'agent-1');

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');
    });

    it('skips artifact path validation when projectDir not provided (backward compat)', () => {
      const id = createTask(db, { subject: 'Build', produces: ['file.txt'] });
      claimTask(db, 'agent-1');

      const filePath = path.join(tmpDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');

      // No projectDir = no validation, should not throw
      completeTask(db, id, 'Done', [
        { name: 'file.txt', path: filePath },
      ], undefined, 'agent-1');

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');
    });

    it('completeTask rejects artifacts not declared as produces', () => {
      const id = createTask(db, { subject: 'No artifacts' });
      claimTask(db, 'agent-1');

      const filePath = path.join(tmpDir, 'rogue.txt');
      fs.writeFileSync(filePath, 'data');

      // Pass artifacts but task has no "produces" declaration — should throw
      expect(() =>
        completeTask(db, id, 'Done', [{ name: 'rogue.txt', path: filePath }], undefined, 'agent-1')
      ).toThrow("not registered as a 'produces' artifact");

      // Task should NOT be completed — transaction rolled back
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('claimed');
    });
  });

  describe('failTask', () => {
    it('retries on crash with correct backoff formula', () => {
      const id = createTask(db, { subject: 'Crashy', max_retries: 3 });
      claimTask(db, 'agent-1');
      const result = failTask(db, id, 'crash', 'OOM', 'agent-1');
      expect(result.retrying).toBe(true);
      expect(result.retry_after).toBeDefined();

      // Verify backoff: 30 * 2^0 = 30 seconds
      const retryTime = new Date(result.retry_after!).getTime();
      const now = Date.now();
      const diffSeconds = (retryTime - now) / 1000;
      expect(diffSeconds).toBeGreaterThan(25); // ~30s with clock skew tolerance
      expect(diffSeconds).toBeLessThan(35);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('pending');
      expect(task.retry_count).toBe(1);
      expect(task.owner).toBeNull();
      expect(task.failure_reason).toBe('crash');
      expect(task.result_summary).toBe('OOM');
    });

    it('timeout reason is retriable', () => {
      const id = createTask(db, { subject: 'Slow', max_retries: 2 });
      claimTask(db, 'agent-1');
      const result = failTask(db, id, 'timeout', 'Timed out after 300s', 'agent-1');
      expect(result.retrying).toBe(true);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('pending');
      expect(task.retry_count).toBe(1);
      expect(task.failure_reason).toBe('timeout');
    });

    it('logic_error goes to needs_review without retry', () => {
      const id = createTask(db, { subject: 'Bad logic' });
      claimTask(db, 'agent-1');
      const result = failTask(db, id, 'logic_error', 'Bug', 'agent-1');
      expect(result.retrying).toBe(false);
      expect(result.retry_after).toBeUndefined();

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('needs_review');
      expect(task.failure_reason).toBe('logic_error');
      expect(task.retry_count).toBe(0); // NOT incremented for non-retriable
    });

    it('artifact_missing goes to needs_review without retry', () => {
      const id = createTask(db, { subject: 'Missing dep' });
      claimTask(db, 'agent-1');
      const result = failTask(db, id, 'artifact_missing', 'schema.sql not found', 'agent-1');
      expect(result.retrying).toBe(false);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('needs_review');
      expect(task.retry_count).toBe(0);
    });

    it('dependency_invalid goes to needs_review without retry', () => {
      const id = createTask(db, { subject: 'Bad dep' });
      claimTask(db, 'agent-1');
      const result = failTask(db, id, 'dependency_invalid', 'API changed', 'agent-1');
      expect(result.retrying).toBe(false);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('needs_review');
      expect(task.retry_count).toBe(0);
    });

    it('goes to needs_review when retries exhausted', () => {
      const id = createTask(db, { subject: 'Test', max_retries: 0 });
      claimTask(db, 'agent-1');
      const result = failTask(db, id, 'crash', 'OOM', 'agent-1');
      expect(result.retrying).toBe(false);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('needs_review');
      expect(task.retry_count).toBe(0); // NOT incremented — no actual retry
    });

    it('exponential backoff scales with retry_count', () => {
      const id = createTask(db, { subject: 'Retry', max_retries: 5 });

      // First failure: 30 * 2^0 = 30s
      claimTask(db, 'agent-1');
      const r1 = failTask(db, id, 'crash', 'fail 1', 'agent-1');
      expect(r1.retrying).toBe(true);

      // Clear retry_after so we can claim again
      db.prepare("UPDATE tasks SET retry_after = NULL WHERE id = ?").run(id);

      // Second failure: 30 * 2^1 = 60s
      claimTask(db, 'agent-1');
      const r2 = failTask(db, id, 'crash', 'fail 2', 'agent-1');
      expect(r2.retrying).toBe(true);
      const diff2 = (new Date(r2.retry_after!).getTime() - Date.now()) / 1000;
      expect(diff2).toBeGreaterThan(55);
      expect(diff2).toBeLessThan(65);
    });

    it('rejects fail from pending status', () => {
      const id = createTask(db, { subject: 'Test' });
      expect(() => failTask(db, id, 'crash', 'nope', 'lead')).toThrow("cannot be failed from status 'pending'");
    });

    it('throws for non-existent task', () => {
      expect(() => failTask(db, '999', 'crash', 'nope', 'lead')).toThrow('not found');
    });
  });

  describe('cancelTask', () => {
    it('cancels a pending task', () => {
      const id = createTask(db, { subject: 'Cancel me' });
      const result = cancelTask(db, id);
      expect(result.cancelled).toContain(id);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('cancelled');
      expect(task.owner).toBeNull();
    });

    it('cascade cancels transitive dependents', () => {
      const id1 = createTask(db, { subject: 'A' });
      const id2 = createTask(db, { subject: 'B', deps: [id1] });
      const id3 = createTask(db, { subject: 'C', deps: [id2] });

      const result = cancelTask(db, id1, true);
      expect(result.cancelled).toEqual([id1, id2, id3]);

      // Verify DB state
      for (const id of [id1, id2, id3]) {
        const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
        expect(task.status).toBe('cancelled');
      }
    });

    it('without cascade moves direct dependents to needs_review', () => {
      const id1 = createTask(db, { subject: 'A' });
      const id2 = createTask(db, { subject: 'B', deps: [id1] });

      cancelTask(db, id1, false);
      const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id2) as TaskRow;
      expect(task2.status).toBe('needs_review');
    });

    it('skips already completed tasks during cascade', () => {
      const id1 = createTask(db, { subject: 'A' });
      const id2 = createTask(db, { subject: 'B', deps: [id1] });
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(id2);

      const result = cancelTask(db, id1, true);
      expect(result.cancelled).toEqual([id1]); // id2 not cancelled
      const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id2) as TaskRow;
      expect(task2.status).toBe('completed'); // Unchanged
    });

    it('returns empty cancelled list for already-cancelled task', () => {
      const id = createTask(db, { subject: 'Already done' });
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);
      const result = cancelTask(db, id);
      expect(result.cancelled).toEqual([]);
    });

    it('returns empty cancelled list for already-completed task', () => {
      const id = createTask(db, { subject: 'Already done' });
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(id);
      const result = cancelTask(db, id);
      expect(result.cancelled).toEqual([]);
    });

    it('throws for non-existent task', () => {
      expect(() => cancelTask(db, '999')).toThrow('not found');
    });

    it('cancels a claimed task and clears owner', () => {
      const id = createTask(db, { subject: 'Claimed' });
      claimTask(db, 'agent-1');
      const result = cancelTask(db, id);
      expect(result.cancelled).toContain(id);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('cancelled');
      expect(task.owner).toBeNull();
    });
  });

  describe('updateTask', () => {
    it('transitions needs_review -> pending', () => {
      const id = createTask(db, { subject: 'Test' });
      claimTask(db, 'agent-1');
      failTask(db, id, 'logic_error', 'Bug', 'agent-1');

      const result = updateTask(db, id, { status: 'pending' });
      expect(result.ok).toBe(true);
      expect(result.previous_status).toBe('needs_review');

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('pending');
    });

    it('transitions pending -> cancelled', () => {
      const id = createTask(db, { subject: 'Test' });
      const result = updateTask(db, id, { status: 'cancelled' });
      expect(result.ok).toBe(true);
      expect(result.previous_status).toBe('pending');

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('cancelled');
    });

    it('transitions blocked -> pending', () => {
      const id1 = createTask(db, { subject: 'A' });
      const id2 = createTask(db, { subject: 'B', deps: [id1] });

      const result = updateTask(db, id2, { status: 'pending' });
      expect(result.ok).toBe(true);
      expect(result.previous_status).toBe('blocked');
    });

    it('rejects invalid transition: pending -> completed', () => {
      const id = createTask(db, { subject: 'Test' });
      expect(() => updateTask(db, id, { status: 'completed' })).toThrow('Invalid transition');
    });

    it('rejects transition from claimed status', () => {
      const id = createTask(db, { subject: 'Test' });
      claimTask(db, 'agent-1');
      expect(() => updateTask(db, id, { status: 'pending' })).toThrow('Invalid transition');
    });

    it('rejects transition from completed status', () => {
      const id = createTask(db, { subject: 'Test' });
      claimTask(db, 'agent-1');
      completeTask(db, id, 'Done', undefined, undefined, 'agent-1');
      expect(() => updateTask(db, id, { status: 'pending' })).toThrow('Invalid transition');
    });

    it('updates priority', () => {
      const id = createTask(db, { subject: 'Test', priority: 50 });
      updateTask(db, id, { priority: 90 });
      const task = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.priority).toBe(90);
    });

    it('updates role', () => {
      const id = createTask(db, { subject: 'Test' });
      updateTask(db, id, { role: 'tester' });
      const task = db.prepare('SELECT role FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.role).toBe('tester');
    });

    it('updates description', () => {
      const id = createTask(db, { subject: 'Test' });
      updateTask(db, id, { description: 'New description' });
      const task = db.prepare('SELECT description FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.description).toBe('New description');
    });

    it('updates max_retries', () => {
      const id = createTask(db, { subject: 'Test', max_retries: 3 });
      updateTask(db, id, { max_retries: 5 });
      const task = db.prepare('SELECT max_retries FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.max_retries).toBe(5);
    });

    it('throws for non-existent task', () => {
      expect(() => updateTask(db, '999', { priority: 90 })).toThrow('not found');
    });

    it('can update multiple fields at once', () => {
      const id = createTask(db, { subject: 'Test', priority: 50 });
      updateTask(db, id, { priority: 90, role: 'tester', description: 'Updated' });
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.priority).toBe(90);
      expect(task.role).toBe('tester');
      expect(task.description).toBe('Updated');
    });
  });

  // Phase 2 hardening: actor enforcement
  describe('actor ownership enforcement', () => {
    it('completeTask rejects non-owner when actorId is provided', () => {
      const id = createTask(db, { subject: 'Owned task' });
      claimTask(db, 'agent-A');

      // Agent-B tries to complete agent-A's task
      expect(() => completeTask(db, id, 'Hijacked', undefined, undefined, 'agent-B'))
        .toThrow("cannot be completed by 'agent-B': not the owning agent");

      // Task remains claimed
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('claimed');
    });

    it('completeTask allows owner to complete', () => {
      const id = createTask(db, { subject: 'Owned task' });
      claimTask(db, 'agent-A');
      completeTask(db, id, 'Done properly', undefined, undefined, 'agent-A');

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');
    });

    it('completeTask allows lead to complete any task', () => {
      const id = createTask(db, { subject: 'Lead override' });
      claimTask(db, 'agent-A');
      completeTask(db, id, 'Lead completed', undefined, undefined, 'lead');

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');
    });

    it('completeTask with undefined actorId is rejected (actorId is required)', () => {
      const id = createTask(db, { subject: 'No actor' });
      claimTask(db, 'agent-A');
      // @ts-expect-error — testing runtime behavior when actorId is omitted
      expect(() => completeTask(db, id, 'Legacy path')).toThrow('not the owning agent');
    });

    it('failTask rejects non-owner when actorId is provided', () => {
      const id = createTask(db, { subject: 'Owned task' });
      claimTask(db, 'agent-A');

      expect(() => failTask(db, id, 'crash', 'hijacked', 'agent-B'))
        .toThrow("cannot be failed by 'agent-B': not the owning agent");

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('claimed');
    });

    it('failTask allows owner to fail', () => {
      const id = createTask(db, { subject: 'Owned task' });
      claimTask(db, 'agent-A');
      failTask(db, id, 'crash', 'agent failed', 'agent-A');

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).not.toBe('claimed');
    });

    it('failTask allows lead to fail any task', () => {
      const id = createTask(db, { subject: 'Lead fail override' });
      claimTask(db, 'agent-A');
      failTask(db, id, 'logic_error', 'Lead-initiated failure', 'lead');

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('needs_review');
    });

    it('completeTask rejects non-lead when task has null owner', () => {
      const id = createTask(db, { subject: 'Orphaned task' });
      // Manually set to claimed with null owner (edge case)
      db.prepare("UPDATE tasks SET status = 'claimed', owner = NULL WHERE id = ?").run(id);

      expect(() => completeTask(db, id, 'Hijacked', undefined, undefined, 'agent-X'))
        .toThrow("cannot be completed by 'agent-X': not the owning agent");
    });

    it('completeTask allows lead on null-owner task', () => {
      const id = createTask(db, { subject: 'Orphaned task lead' });
      db.prepare("UPDATE tasks SET status = 'claimed', owner = NULL WHERE id = ?").run(id);

      completeTask(db, id, 'Lead rescued', undefined, undefined, 'lead');
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('completed');
    });

    it('owner cleared on completion', () => {
      const id = createTask(db, { subject: 'Clear owner test' });
      claimTask(db, 'agent-1');
      completeTask(db, id, 'Done', undefined, undefined, 'agent-1');

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.owner).toBeNull();
    });
  });

  describe('needs_review -> pending stale field cleanup', () => {
    it('clears stale runtime fields when requeuing from needs_review', () => {
      const id = createTask(db, { subject: 'Requeue test' });
      claimTask(db, 'agent-1');
      failTask(db, id, 'logic_error', 'Failed hard', 'agent-1');

      // Task is now needs_review with stale fields
      let task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('needs_review');
      expect(task.failure_reason).toBe('logic_error');
      expect(task.result_summary).toBe('Failed hard');

      // Requeue to pending
      updateTask(db, id, { status: 'pending' });

      // All stale fields should be cleared
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
      expect(task.failure_reason).toBeNull();
      expect(task.retry_after).toBeNull();
      expect(task.result_summary).toBeNull();
      expect(task.claimed_at).toBeNull();
      expect(task.completed_at).toBeNull();
    });
  });

  describe('checkpoint status enforcement', () => {
    it('rejects checkpoint for completed task', () => {
      // postCheckpoint imported at top
      const id = createTask(db, { subject: 'Completed task' });
      claimTask(db, 'agent-1');
      completeTask(db, id, 'Done', undefined, undefined, 'agent-1');

      expect(() => postCheckpoint(db, id, 'agent-1', 'Late checkpoint'))
        .toThrow("Cannot checkpoint task");
    });

    it('rejects checkpoint for pending task', () => {
      // postCheckpoint imported at top
      const id = createTask(db, { subject: 'Pending task' });

      expect(() => postCheckpoint(db, id, 'agent-1', 'Too early'))
        .toThrow("Cannot checkpoint task");
    });

    it('allows checkpoint for claimed task by owner', () => {
      // postCheckpoint imported at top
      const id = createTask(db, { subject: 'Active task' });
      claimTask(db, 'agent-1');

      expect(() => postCheckpoint(db, id, 'agent-1', 'Progress update')).not.toThrow();
    });
  });

  describe('one-task-per-agent guard', () => {
    it('claimTask rejects second claim by same agent', () => {
      createTask(db, { subject: 'First task' });
      createTask(db, { subject: 'Second task' });
      claimTask(db, 'agent-1');

      expect(() => claimTask(db, 'agent-1'))
        .toThrow('Agent agent-1 already owns active task');
    });

    it('claimSpecificTask rejects when agent already owns a task', () => {
      const id1 = createTask(db, { subject: 'First task' });
      const id2 = createTask(db, { subject: 'Second task' });
      claimTask(db, 'agent-1');

      expect(() => claimSpecificTask(db, id2, 'agent-1', 'implementer'))
        .toThrow('Agent agent-1 already owns active task');
    });

    it('allows claim after previous task is completed', () => {
      const id1 = createTask(db, { subject: 'First task' });
      createTask(db, { subject: 'Second task' });
      claimTask(db, 'agent-1');
      completeTask(db, id1, 'Done', undefined, undefined, 'agent-1');

      // Agent should be able to claim another task now
      const task = claimTask(db, 'agent-1');
      expect(task).not.toBeNull();
      expect(task!.subject).toBe('Second task');
    });
  });

  describe('claimSpecificTask role validation', () => {
    it('empty string role is rejected on role-constrained task', () => {
      const id = createTask(db, { subject: 'Impl task', role: 'implementer' });

      expect(() => claimSpecificTask(db, id, 'agent-1', ''))
        .toThrow('Role mismatch');
    });

    it('undefined role is rejected on role-constrained task', () => {
      const id = createTask(db, { subject: 'Impl task', role: 'implementer' });

      expect(() => claimSpecificTask(db, id, 'agent-1'))
        .toThrow('Role mismatch');
    });

    it('null-role task allows any role', () => {
      const id = createTask(db, { subject: 'No role task' });

      const task = claimSpecificTask(db, id, 'agent-1', 'reviewer');
      expect(task.owner).toBe('agent-1');
    });
  });
});
