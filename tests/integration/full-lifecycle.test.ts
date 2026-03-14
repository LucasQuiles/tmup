import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask, createTaskBatch } from '../../shared/src/task-ops.js';
import { claimTask, completeTask, failTask, cancelTask } from '../../shared/src/task-lifecycle.js';
import { sendMessage, getInbox, getUnreadCount, postCheckpoint } from '../../shared/src/message-ops.js';
import { registerAgent, updateHeartbeat, getStaleAgents, recoverDeadClaim, getAgent } from '../../shared/src/agent-ops.js';
import { findArtifactByName, verifyArtifact } from '../../shared/src/artifact-ops.js';
import { logEvent, getRecentEvents } from '../../shared/src/event-ops.js';
import type { Database, TaskRow, EventRow } from '../../shared/src/types.js';

import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('full lifecycle integration', () => {
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

  it('full workflow: create -> claim -> checkpoint -> complete -> cascade -> teardown', () => {
    // Create task chain: T-001 -> T-002 -> T-003
    const ids = createTaskBatch(db, [
      { subject: 'Define schema', role: 'implementer', priority: 80 },
      { subject: 'Implement models', role: 'implementer', deps: ['001'] },
      { subject: 'Write tests', role: 'tester', deps: ['002'] },
    ]);
    expect(ids).toEqual(['001', '002', '003']);

    // Verify initial statuses
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('001') as TaskRow).status).toBe('pending');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow).status).toBe('blocked');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow).status).toBe('blocked');

    // Agent 1 claims T-001
    registerAgent(db, 'agent-1', 0, 'implementer');
    const claimed = claimTask(db, 'agent-1', 'implementer');
    expect(claimed!.id).toBe('001');
    expect(claimed!.status).toBe('claimed');
    expect(claimed!.owner).toBe('agent-1');

    // Agent 1 checkpoints
    postCheckpoint(db, '001', 'agent-1', 'Schema 50% complete');
    expect(getUnreadCount(db, 'lead')).toBe(1);

    // Verify checkpoint message content
    const cpMsgs = getInbox(db, 'lead', true);
    expect(cpMsgs).toHaveLength(1);
    expect(cpMsgs[0].type).toBe('checkpoint');
    expect(cpMsgs[0].payload).toBe('Schema 50% complete');
    expect(cpMsgs[0].task_id).toBe('001');

    // Agent 1 completes T-001
    const result1 = completeTask(db, '001', 'Schema defined', undefined, undefined, 'agent-1');
    expect(result1.unblocked).toContain('002');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('002') as TaskRow).status).toBe('pending');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow).status).toBe('blocked');

    // Agent 2 claims T-002
    registerAgent(db, 'agent-2', 1, 'implementer');
    const claimed2 = claimTask(db, 'agent-2', 'implementer');
    expect(claimed2!.id).toBe('002');

    // Agent 2 completes T-002
    const result2 = completeTask(db, '002', 'Models implemented', undefined, undefined, 'agent-2');
    expect(result2.unblocked).toContain('003');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get('003') as TaskRow).status).toBe('pending');

    // Agent 3 claims T-003
    registerAgent(db, 'agent-3', 2, 'tester');
    const claimed3 = claimTask(db, 'agent-3', 'tester');
    expect(claimed3!.id).toBe('003');

    // Agent 3 completes T-003
    completeTask(db, '003', 'Tests passing', undefined, undefined, 'agent-3');

    // All tasks completed
    const incomplete = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status != 'completed'").get() as { cnt: number };
    expect(incomplete.cnt).toBe(0);

    // Events logged — verify specific events exist
    const events = getRecentEvents(db);
    expect(events.length).toBeGreaterThan(0);
    const eventTypes = events.map(e => e.event_type);
    expect(eventTypes).toContain('task_created');
    expect(eventTypes).toContain('task_claimed');
    expect(eventTypes).toContain('task_completed');
    expect(eventTypes).toContain('task_unblocked');
  });

  it('concurrent claim simulation — exactly one winner', () => {
    createTask(db, { subject: 'Single task', priority: 50 });

    const result1 = claimTask(db, 'agent-1');
    const result2 = claimTask(db, 'agent-2');

    const winners = [result1, result2].filter(r => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe('001');
    expect(winners[0]!.owner).toBe('agent-1');

    // Verify DB has exactly one owner
    const task = db.prepare('SELECT owner, status FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(task.owner).toBe('agent-1');
    expect(task.status).toBe('claimed');
  });

  it('message flow: checkpoint from worker, inbox from lead, broadcast', () => {
    createTask(db, { subject: 'Work' });
    registerAgent(db, 'agent-1', 0);
    claimTask(db, 'agent-1');

    // Worker sends checkpoint
    postCheckpoint(db, '001', 'agent-1', 'Progress update');

    // Lead reads inbox
    const msgs = getInbox(db, 'lead', true);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('checkpoint');
    expect(msgs[0].from_agent).toBe('agent-1');

    // Lead sends broadcast
    sendMessage(db, {
      from_agent: 'lead',
      to_agent: null,
      type: 'broadcast',
      payload: 'Good work everyone',
    });

    // Worker sees broadcast
    expect(getUnreadCount(db, 'agent-1')).toBe(1);

    // Worker reads broadcast
    const workerMsgs = getInbox(db, 'agent-1', true);
    expect(workerMsgs).toHaveLength(1);
    expect(workerMsgs[0].type).toBe('broadcast');
    expect(workerMsgs[0].payload).toBe('Good work everyone');
  });

  it('dead-claim recovery during status check', () => {
    createTask(db, { subject: 'Will stall', max_retries: 3 });
    registerAgent(db, 'agent-1', 0);
    claimTask(db, 'agent-1');

    // Simulate stale heartbeat
    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'"
    ).run();

    // Recovery
    const stale = getStaleAgents(db, 300);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('agent-1');

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toContain('001');

    // Task should be back to pending for retry
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();
    expect(task.retry_count).toBe(1);
    expect(task.failure_reason).toBe('timeout');
  });

  it('fail + retry + eventual needs_review', () => {
    createTask(db, { subject: 'Flaky', max_retries: 1 });
    registerAgent(db, 'agent-1', 0);

    // First attempt: claim and crash
    claimTask(db, 'agent-1');
    const fail1 = failTask(db, '001', 'crash', 'OOM', 'agent-1');
    expect(fail1.retrying).toBe(true);

    const afterFail1 = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(afterFail1.status).toBe('pending');
    expect(afterFail1.retry_count).toBe(1);

    // Clear retry_after for test
    db.prepare("UPDATE tasks SET retry_after = NULL WHERE id = '001'").run();

    // Second attempt: claim again and crash
    claimTask(db, 'agent-1');
    const fail2 = failTask(db, '001', 'crash', 'OOM again', 'agent-1');
    expect(fail2.retrying).toBe(false);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(task.status).toBe('needs_review');
    expect(task.retry_count).toBe(1); // Only the successful retry incremented it
    expect(task.failure_reason).toBe('crash');
  });

  it('dead-claim recovery with retry vs needs_review paths', () => {
    // Task with retries: dead-claim should increment retry_count
    createTask(db, { subject: 'Will stall', max_retries: 3 });
    registerAgent(db, 'agent-1', 0);
    claimTask(db, 'agent-1');

    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'"
    ).run();

    recoverDeadClaim(db, getStaleAgents(db, 300)[0].id);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.retry_count).toBe(1);
    expect(task.failure_reason).toBe('timeout');

    // Task with NO retries: dead-claim should NOT increment retry_count
    createTask(db, { subject: 'No retries', max_retries: 0, priority: 99 });
    registerAgent(db, 'agent-2', 1);
    const claimed2 = claimTask(db, 'agent-2');
    expect(claimed2!.id).toBe('002');

    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-2'"
    ).run();

    recoverDeadClaim(db, getStaleAgents(db, 300)[0].id);

    const task2 = db.prepare('SELECT * FROM tasks WHERE id = ?').get('002') as TaskRow;
    expect(task2.status).toBe('needs_review');
    expect(task2.retry_count).toBe(0);
  });

  it('broadcast isolation: agent A read does not affect agent B', () => {
    sendMessage(db, {
      from_agent: 'lead',
      to_agent: null,
      type: 'broadcast',
      payload: 'Global notice',
    });

    // Agent A reads and marks read
    const msgsA = getInbox(db, 'agent-1', true);
    expect(msgsA).toHaveLength(1);

    // Agent B still sees the broadcast
    expect(getUnreadCount(db, 'agent-2')).toBe(1);

    // Agent B reads
    const msgsB = getInbox(db, 'agent-2', true);
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0].payload).toBe('Global notice');
  });

  it('lead checkpoint bypasses ownership', () => {
    createTask(db, { subject: 'Worker task' });
    registerAgent(db, 'agent-1', 0);
    claimTask(db, 'agent-1');

    // Lead can checkpoint despite not owning the task
    postCheckpoint(db, '001', 'lead', 'Lead override checkpoint');
    const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(task.result_summary).toBe('Lead override checkpoint');
  });

  it('cancel with cascade then recover — no phantom tasks', () => {
    const ids = createTaskBatch(db, [
      { subject: 'Root' },
      { subject: 'Child 1', deps: ['001'] },
      { subject: 'Child 2', deps: ['001'] },
      { subject: 'Grandchild', deps: ['002', '003'] },
    ]);

    const result = cancelTask(db, '001', true);
    expect(result.cancelled).toHaveLength(4);

    // ALL tasks should be cancelled
    for (const id of ids) {
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as TaskRow;
      expect(task.status).toBe('cancelled');
    }

    // No pending/blocked tasks should remain
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN ('cancelled', 'completed')").get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  it('mixed fail reasons track correctly across lifecycle', () => {
    createTask(db, { subject: 'Mixed', max_retries: 3 });
    registerAgent(db, 'agent-1', 0);

    // Crash (retriable) — retry_count goes to 1
    claimTask(db, 'agent-1');
    failTask(db, '001', 'crash', 'OOM', 'agent-1');
    db.prepare("UPDATE tasks SET retry_after = NULL WHERE id = '001'").run();

    // Timeout (retriable) — retry_count goes to 2
    claimTask(db, 'agent-1');
    failTask(db, '001', 'timeout', 'Slow', 'agent-1');
    db.prepare("UPDATE tasks SET retry_after = NULL WHERE id = '001'").run();

    const mid = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(mid.retry_count).toBe(2);
    expect(mid.failure_reason).toBe('timeout'); // Most recent

    // Logic error (non-retriable) — goes to needs_review, no retry_count bump
    claimTask(db, 'agent-1');
    failTask(db, '001', 'logic_error', 'Fundamental bug', 'agent-1');

    const final = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(final.status).toBe('needs_review');
    expect(final.retry_count).toBe(2); // NOT incremented for non-retriable
    expect(final.failure_reason).toBe('logic_error');
  });

  it('stale-agent recovery transfers claim and blocks the original agent from completing', () => {
    createTask(db, { subject: 'Recoverable work', max_retries: 3 });
    registerAgent(db, 'agent-1', 0, 'implementer');
    registerAgent(db, 'agent-2', 1, 'implementer');

    const firstClaim = claimTask(db, 'agent-1', 'implementer');
    expect(firstClaim!.id).toBe('001');

    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'"
    ).run();

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toEqual(['001']);

    // Make the recovered task immediately claimable for the takeover part of the scenario.
    db.prepare("UPDATE tasks SET retry_after = NULL WHERE id = '001'").run();

    const takeover = claimTask(db, 'agent-2', 'implementer');
    expect(takeover!.id).toBe('001');
    expect(takeover!.owner).toBe('agent-2');

    expect(() => completeTask(db, '001', 'late completion', undefined, undefined, 'agent-1'))
      .toThrow("cannot be completed by 'agent-1': not the owning agent");

    const taskAfterReject = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(taskAfterReject.status).toBe('claimed');
    expect(taskAfterReject.owner).toBe('agent-2');

    const result = completeTask(db, '001', 'completed by replacement', undefined, undefined, 'agent-2');
    expect(result.unblocked).toEqual([]);

    const finalTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(finalTask.status).toBe('completed');
    expect(finalTask.owner).toBeNull();
  });

  it('cascade cancel during active checkpoint preserves old checkpoint but rejects new ones', () => {
    const ids = createTaskBatch(db, [
      { subject: 'Root task' },
      { subject: 'Dependent worker task', deps: ['001'] },
    ]);
    expect(ids).toEqual(['001', '002']);

    registerAgent(db, 'agent-child', 1);

    // Simulate an adversarial race: the dependent task is already active when the
    // root task gets cancelled, even though the normal DAG flow would keep it blocked.
    db.prepare(`
      UPDATE tasks
      SET status = 'claimed', owner = 'agent-child', claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = '002'
    `).run();

    postCheckpoint(db, '002', 'agent-child', 'checkpoint before cancel');
    expect(getUnreadCount(db, 'lead')).toBe(1);

    const cancelResult = cancelTask(db, '001', true);
    expect(cancelResult.cancelled).toEqual(['001', '002']);

    const cancelledChild = db.prepare('SELECT * FROM tasks WHERE id = ?').get('002') as TaskRow;
    expect(cancelledChild.status).toBe('cancelled');
    expect(cancelledChild.owner).toBeNull();

    const existingLeadInbox = getInbox(db, 'lead', true);
    expect(existingLeadInbox).toHaveLength(1);
    expect(existingLeadInbox[0].payload).toBe('checkpoint before cancel');

    expect(() => postCheckpoint(db, '002', 'agent-child', 'checkpoint after cancel'))
      .toThrow("Cannot checkpoint task 002 in status 'cancelled'");

    expect(getUnreadCount(db, 'lead')).toBe(0);
  });

  it('message to an agent survives after that agent is shut down mid-flight', () => {
    registerAgent(db, 'agent-1', 0);

    sendMessage(db, {
      from_agent: 'lead',
      to_agent: 'agent-1',
      type: 'direct',
      payload: 'finish your handoff',
    });

    // Backdate heartbeat so recovery treats the agent as stale
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toEqual([]);

    const agent = getAgent(db, 'agent-1');
    expect(agent!.status).toBe('shutdown');

    expect(getUnreadCount(db, 'agent-1')).toBe(1);
    const inbox = getInbox(db, 'agent-1');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].payload).toBe('finish your handoff');
    expect(inbox[0].to_agent).toBe('agent-1');
  });

  it('artifact modified between checksum validation and publish commits stale metadata', () => {
    createTask(db, { subject: 'Build artifact', produces: ['bundle.txt'] });
    registerAgent(db, 'agent-1', 0);
    claimTask(db, 'agent-1');

    const artifactPath = path.join(os.tmpdir(), `tmup-integration-artifact-${Date.now()}.txt`);
    fs.writeFileSync(artifactPath, 'original-content');

    const originalTransaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(((fn: Parameters<typeof originalTransaction>[0]) => {
      const wrapped = originalTransaction(fn);
      return {
        immediate: () => {
          fs.writeFileSync(artifactPath, 'mutated-before-commit');
          return wrapped.immediate();
        },
      } as ReturnType<typeof originalTransaction>;
    }) as typeof db.transaction);

    try {
      const result = completeTask(
        db,
        '001',
        'artifact published under race',
        [{ name: 'bundle.txt', path: artifactPath }],
        undefined,
        'agent-1'
      );
      expect(result.unblocked).toEqual([]);
    } finally {
      transactionSpy.mockRestore();
    }

    const artifact = findArtifactByName(db, 'bundle.txt');
    expect(artifact).toBeTruthy();
    expect(artifact!.status).toBe('published');
    expect(artifact!.path).toBe(artifactPath);

    expect(verifyArtifact(db, artifact!.id)).toBe('stale');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(task.status).toBe('completed');

    try { fs.unlinkSync(artifactPath); } catch {}
  });

  it('batch creation accepts exactly 500 tasks and leaves the queue usable at the boundary', () => {
    const inputs = Array.from({ length: 500 }, (_, index) => ({
      subject: `Boundary task ${index + 1}`,
      priority: index === 0 ? 100 : 50,
    }));

    const ids = createTaskBatch(db, inputs);
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe('001');
    expect(ids[499]).toBe('500');

    const taskCount = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
    const eventCount = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE event_type = 'task_created'").get() as { cnt: number };
    expect(taskCount.cnt).toBe(500);
    expect(eventCount.cnt).toBe(500);

    registerAgent(db, 'boundary-agent', 0);
    const claimed = claimTask(db, 'boundary-agent');
    expect(claimed!.id).toBe('001');
    expect(claimed!.priority).toBe(100);

    expect(() => createTask(db, { subject: '501st task' })).toThrow('Task limit reached (500)');
  });
});
