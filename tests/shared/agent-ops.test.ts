import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { registerAgent, updateHeartbeat, getStaleAgents, recoverDeadClaim, getActiveAgents, getAgent } from '../../shared/src/agent-ops.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import type { Database, TaskRow, AgentRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('agent-ops', () => {
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

  it('registers an agent with correct fields', () => {
    registerAgent(db, 'agent-1', 0, 'implementer');
    const agent = getAgent(db, 'agent-1');
    expect(agent).not.toBeUndefined();
    expect(agent!.id).toBe('agent-1');
    expect(agent!.pane_index).toBe(0);
    expect(agent!.role).toBe('implementer');
    expect(agent!.status).toBe('active');
    expect(agent!.last_heartbeat_at).toBeTruthy();
    expect(agent!.registered_at).toBeTruthy();
    expect(agent!.codex_session_id).toBeNull();
  });

  it('registers agent without role', () => {
    registerAgent(db, 'agent-1', 0);
    const agent = getAgent(db, 'agent-1');
    expect(agent!.role).toBeNull();
  });

  it('re-registration updates existing agent (INSERT OR REPLACE)', () => {
    registerAgent(db, 'agent-1', 0, 'implementer');
    registerAgent(db, 'agent-1', 1, 'tester');
    const agent = getAgent(db, 'agent-1');
    expect(agent!.pane_index).toBe(1);
    expect(agent!.role).toBe('tester');
    // Should still be one agent row
    const count = db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE id = ?').get('agent-1') as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('updates heartbeat timestamp', () => {
    registerAgent(db, 'agent-1', 0);
    const before = getAgent(db, 'agent-1')!.last_heartbeat_at;

    // Small delay to ensure different timestamp
    updateHeartbeat(db, 'agent-1');
    const after = getAgent(db, 'agent-1')!.last_heartbeat_at;
    expect(after).toBeTruthy();
    // Timestamps should be close but may be equal if within same millisecond
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('updates heartbeat with codex session ID', () => {
    registerAgent(db, 'agent-1', 0);
    updateHeartbeat(db, 'agent-1', 'codex-session-abc');
    const agent = getAgent(db, 'agent-1');
    expect(agent!.codex_session_id).toBe('codex-session-abc');
  });

  it('finds stale agents correctly', () => {
    registerAgent(db, 'agent-1', 0);
    registerAgent(db, 'agent-2', 1);
    // Manually backdate only agent-1
    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'"
    ).run();

    const stale = getStaleAgents(db, 300);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('agent-1');
  });

  it('getStaleAgents does not return shutdown agents', () => {
    registerAgent(db, 'agent-1', 0);
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds'), status = 'shutdown' WHERE id = 'agent-1'").run();
    const stale = getStaleAgents(db, 300);
    expect(stale).toHaveLength(0);
  });

  it('recovers dead claims — retriable path', () => {
    registerAgent(db, 'agent-1', 0);
    const taskId = createTask(db, { subject: 'Test', max_retries: 3 });
    claimTask(db, 'agent-1');
    // Backdate heartbeat so agent is stale
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toContain(taskId);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();
    expect(task.retry_count).toBe(1);
    expect(task.failure_reason).toBe('timeout');

    const agent = getAgent(db, 'agent-1');
    expect(agent!.status).toBe('shutdown');
  });

  it('dead-claim: needs_review path does NOT increment retry_count', () => {
    registerAgent(db, 'agent-1', 0);
    const taskId = createTask(db, { subject: 'Exhausted', max_retries: 0 });
    claimTask(db, 'agent-1');
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toContain(taskId);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('needs_review');
    expect(task.retry_count).toBe(0); // NOT incremented
    expect(task.failure_reason).toBe('timeout');
    expect(task.owner).toBeNull();
  });

  it('recovers dead claims with retry_after backoff', () => {
    registerAgent(db, 'agent-1', 0);
    const taskId = createTask(db, { subject: 'Test', max_retries: 3 });
    claimTask(db, 'agent-1');
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toContain(taskId);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.retry_count).toBe(1);
    expect(task.retry_after).not.toBeNull();

    // Verify backoff: 30 * 2^0 = 30 seconds
    const retryTime = new Date(task.retry_after!).getTime();
    const diffSeconds = (retryTime - Date.now()) / 1000;
    expect(diffSeconds).toBeGreaterThan(25);
    expect(diffSeconds).toBeLessThan(35);
  });

  it('dead-claim retry_after prevents immediate re-claim', () => {
    registerAgent(db, 'agent-1', 0);
    const taskId = createTask(db, { subject: 'Test', max_retries: 3 });
    claimTask(db, 'agent-1');
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();

    recoverDeadClaim(db, 'agent-1');

    // Task has retry_after set in the future — should not be claimable
    registerAgent(db, 'agent-2', 1);
    const claimed = claimTask(db, 'agent-2');
    expect(claimed).toBeNull();
  });

  it('recoverDeadClaim on stale agent with no tasks returns empty, still marks shutdown', () => {
    registerAgent(db, 'agent-1', 0);
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();
    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toEqual([]);
    const agent = getAgent(db, 'agent-1');
    expect(agent!.status).toBe('shutdown');
  });

  it('recoverDeadClaim skips non-stale agent (heartbeat still fresh)', () => {
    registerAgent(db, 'agent-1', 0);
    const taskId = createTask(db, { subject: 'Active work' });
    claimTask(db, 'agent-1');
    // Agent heartbeat is fresh — recovery should be skipped
    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toEqual([]);
    const agent = getAgent(db, 'agent-1');
    expect(agent!.status).toBe('active'); // NOT shutdown
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('claimed'); // NOT requeued
    expect(task.owner).toBe('agent-1'); // Still owned
  });

  it('recoverDeadClaim re-checks staleness after a fresh heartbeat arrives', () => {
    registerAgent(db, 'agent-1', 0);
    const taskId = createTask(db, { subject: 'Recovered heartbeat' });
    claimTask(db, 'agent-1');

    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'"
    ).run();

    const stale = getStaleAgents(db, 300);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('agent-1');

    updateHeartbeat(db, 'agent-1');

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toEqual([]);

    const agent = getAgent(db, 'agent-1');
    expect(agent!.status).toBe('active');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('claimed');
    expect(task.owner).toBe('agent-1');
    expect(task.retry_count).toBe(0);
    expect(task.failure_reason).toBeNull();
  });

  it('recoverDeadClaim recovers the single claimed task', () => {
    registerAgent(db, 'agent-1', 0);
    createTask(db, { subject: 'T1', max_retries: 3 });
    claimTask(db, 'agent-1');
    db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-1'").run();

    const recovered = recoverDeadClaim(db, 'agent-1');
    expect(recovered).toHaveLength(1);
    expect(recovered).toContain('001');

    const t1 = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as TaskRow;
    expect(t1.status).toBe('pending');
    expect(t1.retry_count).toBe(1);
  });

  it('getActiveAgents returns only active agents', () => {
    registerAgent(db, 'agent-1', 0);
    registerAgent(db, 'agent-2', 1);
    db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = 'agent-2'").run();

    const active = getActiveAgents(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('agent-1');
  });

  it('getAgent returns undefined for non-existent agent', () => {
    expect(getAgent(db, 'nonexistent')).toBeUndefined();
  });

  it('updateHeartbeat throws for unregistered agent', () => {
    expect(() => updateHeartbeat(db, 'ghost-agent'))
      .toThrow('Agent ghost-agent not found');
  });

  it('updateHeartbeat with codex session throws for unregistered agent', () => {
    expect(() => updateHeartbeat(db, 'ghost-agent', 'session-123'))
      .toThrow('Agent ghost-agent not found');
  });
});
