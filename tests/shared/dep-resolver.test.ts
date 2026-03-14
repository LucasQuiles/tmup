import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { checkCycle, addDependency, hasUnmetDependencies, findUnblockedDependents, getTransitiveDependents } from '../../shared/src/dep-resolver.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask, failTask } from '../../shared/src/task-lifecycle.js';
import { updateTask } from '../../shared/src/task-ops.js';
import { MAX_DEPENDENCY_DEPTH } from '../../shared/src/constants.js';
import type { Database, TaskRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

function buildDenseDependencyGraph(db: Database, count: number): string[] {
  const ids = ['001', '002', '003'];
  while (ids.length < count) {
    ids.push(createTask(db, { subject: `Dense ${ids.length + 1}` }));
  }

  for (let i = 1; i < ids.length; i++) {
    for (let j = 0; j < i; j++) {
      addDependency(db, ids[i], ids[j]);
    }
  }

  return ids;
}

describe('dep-resolver', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'A')").run();
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('002', 'B')").run();
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('003', 'C')").run();
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  describe('checkCycle', () => {
    it('returns false for valid A->B (no existing deps)', () => {
      expect(checkCycle(db, '002', '001')).toBe(false);
    });

    it('returns true for direct cycle A->B->A', () => {
      addDependency(db, '002', '001'); // B depends on A
      expect(checkCycle(db, '001', '002')).toBe(true); // A depends on B would create cycle
    });

    it('returns true for transitive cycle A->B->C->A', () => {
      addDependency(db, '002', '001'); // B depends on A
      addDependency(db, '003', '002'); // C depends on B
      expect(checkCycle(db, '001', '003')).toBe(true); // A depends on C would create cycle
    });

    it('detects cycle through diamond topology', () => {
      db.prepare("INSERT INTO tasks (id, subject) VALUES ('004', 'D')").run();
      addDependency(db, '002', '001'); // B depends on A
      addDependency(db, '003', '001'); // C depends on A
      addDependency(db, '004', '002'); // D depends on B
      addDependency(db, '004', '003'); // D depends on C

      // A -> D would cycle via D -> B -> A
      expect(checkCycle(db, '001', '004')).toBe(true);
      // But new task E depending on D is fine
      db.prepare("INSERT INTO tasks (id, subject) VALUES ('005', 'E')").run();
      expect(checkCycle(db, '005', '004')).toBe(false);
    });

    it('self-dependency is detected as cycle', () => {
      expect(checkCycle(db, '001', '001')).toBe(true);
    });
  });

  describe('addDependency', () => {
    it('succeeds and creates correct dep row', () => {
      addDependency(db, '002', '001');
      const dep = db.prepare('SELECT * FROM task_deps WHERE task_id = ? AND depends_on_task_id = ?').get('002', '001');
      expect(dep).toBeTruthy();
    });

    it('throws on cycle with descriptive message', () => {
      addDependency(db, '002', '001');
      expect(() => addDependency(db, '001', '002')).toThrow('cycle');
    });

    it('throws on non-existent task (task_id)', () => {
      expect(() => addDependency(db, '999', '001')).toThrow('not found');
    });

    it('throws on non-existent dependency (depends_on_task_id)', () => {
      expect(() => addDependency(db, '001', '999')).toThrow('not found');
    });

    it('is idempotent — INSERT OR IGNORE does not throw on duplicate', () => {
      addDependency(db, '002', '001');
      addDependency(db, '002', '001'); // Should not throw
      const deps = db.prepare('SELECT COUNT(*) as cnt FROM task_deps WHERE task_id = ?').get('002') as { cnt: number };
      expect(deps.cnt).toBe(1);
    });

    it('self-dependency is rejected by cycle check', () => {
      expect(() => addDependency(db, '001', '001')).toThrow('cycle');
    });
  });

  describe('hasUnmetDependencies', () => {
    it('returns true when deps are not completed', () => {
      addDependency(db, '002', '001');
      expect(hasUnmetDependencies(db, '002')).toBe(true);
    });

    it('returns false when all deps are completed', () => {
      addDependency(db, '002', '001');
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();
      expect(hasUnmetDependencies(db, '002')).toBe(false);
    });

    it('returns false when task has no deps', () => {
      expect(hasUnmetDependencies(db, '001')).toBe(false);
    });

    it('returns true when one of multiple deps is incomplete', () => {
      addDependency(db, '003', '001');
      addDependency(db, '003', '002');
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();
      // '002' still pending
      expect(hasUnmetDependencies(db, '003')).toBe(true);
    });

    it('cancelled dep counts as unmet', () => {
      addDependency(db, '002', '001');
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = '001'").run();
      expect(hasUnmetDependencies(db, '002')).toBe(true);
    });
  });

  describe('findUnblockedDependents', () => {
    it('unblocks task when all deps are completed', () => {
      addDependency(db, '002', '001');
      db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = '002'").run();
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();

      const unblocked = findUnblockedDependents(db, '001');
      expect(unblocked).toContain('002');

      // Verify the DB was actually updated
      const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow;
      expect(task2.status).toBe('pending');
    });

    it('does NOT unblock when other deps remain unmet', () => {
      addDependency(db, '003', '001');
      addDependency(db, '003', '002');
      db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = '003'").run();
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();

      const unblocked = findUnblockedDependents(db, '001');
      expect(unblocked).not.toContain('003');
      // Verify DB wasn't modified
      const task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow;
      expect(task3.status).toBe('blocked');
    });

    it('returns empty when completed task has no dependents', () => {
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();
      const unblocked = findUnblockedDependents(db, '001');
      expect(unblocked).toEqual([]);
    });

    it('does not transition non-blocked tasks (e.g. already pending)', () => {
      addDependency(db, '002', '001');
      // '002' is pending, not blocked
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();

      const unblocked = findUnblockedDependents(db, '001');
      // It may appear in the returned list (the SELECT finds it), but no DB change
      const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow;
      expect(task2.status).toBe('pending'); // unchanged
    });
  });

  describe('addDependency re-blocking', () => {
    it('re-blocks a pending task when new unmet dependency is added', () => {
      // Task 002 is pending (no deps yet)
      let task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow;
      expect(task2.status).toBe('pending');

      // Add dependency on 001 (which is not completed)
      addDependency(db, '002', '001');

      // Task 002 should now be blocked
      task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow;
      expect(task2.status).toBe('blocked');
    });

    it('does not re-block if dependency is already completed', () => {
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();
      addDependency(db, '002', '001');

      const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow;
      expect(task2.status).toBe('pending');
    });
  });

  describe('getTransitiveDependents', () => {
    it('returns all transitive dependents', () => {
      // getTransitiveDependents imported at top
      addDependency(db, '002', '001');
      addDependency(db, '003', '002');

      const deps = getTransitiveDependents(db, '001');
      expect(deps).toContain('002');
      expect(deps).toContain('003');
    });

    it('handles diamond DAGs', () => {
      // getTransitiveDependents imported at top
      // 001 <- 002, 001 <- 003, 002 <- 004, 003 <- 004
      addDependency(db, '002', '001');
      addDependency(db, '003', '001');

      const id4 = createTask(db, { subject: 'D' });
      addDependency(db, id4, '002');
      addDependency(db, id4, '003');

      const deps = getTransitiveDependents(db, '001');
      expect(deps).toContain('002');
      expect(deps).toContain('003');
      expect(deps).toContain(id4);
      // No duplicates
      expect(new Set(deps).size).toBe(deps.length);
    });
  });

  describe('challenge stress cases', () => {
    it('checkCycle completes within 5 seconds on a dense 50-node graph', () => {
      const ids = buildDenseDependencyGraph(db, 50);

      const start = Date.now();
      const hasCycle = checkCycle(db, ids[0], ids[49]);
      const elapsedMs = Date.now() - start;

      expect(hasCycle).toBe(true);
      expect(elapsedMs).toBeLessThan(5000);
    });

    it('getTransitiveDependents returns the correct unique set on a dense 50-node graph', () => {
      const ids = buildDenseDependencyGraph(db, 50);

      const deps = getTransitiveDependents(db, ids[0]);

      expect(deps).toHaveLength(49);
      expect(new Set(deps).size).toBe(49);
      expect(deps).toEqual(expect.arrayContaining(ids.slice(1)));
      expect(deps).not.toContain(ids[0]);
    });

    it('truncates traversal at MAX_DEPENDENCY_DEPTH for a chain of MAX_DEPENDENCY_DEPTH + 1 dependents', () => {
      let prev = '001';
      const chainIds: string[] = [];

      for (let i = 0; i < MAX_DEPENDENCY_DEPTH + 1; i++) {
        const id = createTask(db, { subject: `Chain ${i}` });
        addDependency(db, id, prev);
        chainIds.push(id);
        prev = id;
      }

      const deps = getTransitiveDependents(db, '001');
      expect(deps).toHaveLength(MAX_DEPENDENCY_DEPTH);
      expect(new Set(deps).size).toBe(MAX_DEPENDENCY_DEPTH);
      expect(deps).toContain(chainIds[0]);
      expect(deps).toContain(chainIds[MAX_DEPENDENCY_DEPTH - 1]);
      expect(deps).not.toContain(chainIds[MAX_DEPENDENCY_DEPTH]);
    });

    it('returns the correct unique traversal set for a 200-node diamond DAG', () => {
      const branchIds = ['002', '003'];
      while (branchIds.length < 198) {
        branchIds.push(createTask(db, { subject: `Branch ${branchIds.length}` }));
      }

      for (const id of branchIds) {
        addDependency(db, id, '001');
      }

      const sinkId = createTask(db, { subject: 'Sink' });
      for (const id of branchIds) {
        addDependency(db, sinkId, id);
      }

      const deps = getTransitiveDependents(db, '001');
      expect(deps).toHaveLength(199);
      expect(new Set(deps).size).toBe(199);
      expect(deps).toContain('002');
      expect(deps).toContain('003');
      expect(deps).toContain(sinkId);
    });

    it('keeps a blocked task blocked when a second unmet dependency is added before the first resolves', () => {
      addDependency(db, '003', '001');
      let task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow;
      expect(task3.status).toBe('blocked');

      addDependency(db, '003', '002');
      task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow;
      expect(task3.status).toBe('blocked');

      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();
      const afterFirstCompletion = findUnblockedDependents(db, '001');
      expect(afterFirstCompletion).not.toContain('003');
      task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow;
      expect(task3.status).toBe('blocked');

      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '002'").run();
      const afterSecondCompletion = findUnblockedDependents(db, '002');
      expect(afterSecondCompletion).toContain('003');
      task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow;
      expect(task3.status).toBe('pending');
    });

    it('does not unblock a dependent when another dependency is cancelled instead of completed', () => {
      addDependency(db, '003', '001');
      addDependency(db, '003', '002');

      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = '001'").run();
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = '002'").run();

      const unblocked = findUnblockedDependents(db, '001');
      expect(unblocked).not.toContain('003');

      const task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow;
      expect(task3.status).toBe('blocked');
    });

    it('logs dependency_traversal_truncated when traversal hits the depth cap', () => {
      let prev = '001';
      for (let i = 0; i < MAX_DEPENDENCY_DEPTH + 1; i++) {
        const id = createTask(db, { subject: `Deep ${i}` });
        addDependency(db, id, prev);
        prev = id;
      }

      const deps = getTransitiveDependents(db, '001');
      expect(deps).toHaveLength(MAX_DEPENDENCY_DEPTH);

      const event = db.prepare(
        "SELECT * FROM events WHERE event_type = 'dependency_traversal_truncated' ORDER BY id DESC LIMIT 1"
      ).get() as { payload: string | null } | undefined;

      expect(event).toBeDefined();
      expect(event?.payload).toBeTruthy();

      const payload = JSON.parse(event!.payload!);
      expect(payload.root_task_id).toBe('001');
      expect(payload.max_depth).toBe(MAX_DEPENDENCY_DEPTH);
      expect(payload.dependents_found).toBe(MAX_DEPENDENCY_DEPTH);
    });
  });

  describe('max_retries floor validation', () => {
    it('rejects max_retries below retry_count', () => {
      // imports at top
      claimTask(db, 'agent-1');
      // Fail with retry (crash is retriable)
      failTask(db, '001', 'crash', 'first fail', 'agent-1');
      // retry_count is now 1
      const task = db.prepare('SELECT retry_count FROM tasks WHERE id = ?').get('001') as TaskRow;
      expect(task.retry_count).toBe(1);

      // Try to set max_retries to 0 (below retry_count)
      expect(() => updateTask(db, '001', { max_retries: 0 }))
        .toThrow('Cannot set max_retries');
    });
  });
});
