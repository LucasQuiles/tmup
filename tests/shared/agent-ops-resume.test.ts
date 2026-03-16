import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { registerAgent, recoverDeadClaim, getAgent } from '../../shared/src/agent-ops.js';
import { getAgentByPaneIndex } from '../../shared/src/agent-ops.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import type { Database, TaskRow, AgentRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('getAgentByPaneIndex', () => {
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

  it('returns active agent for occupied pane with correct fields', () => {
    registerAgent(db, 'agent-1', 3, 'implementer');
    const agent = getAgentByPaneIndex(db, 3);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe('agent-1');
    expect(agent!.pane_index).toBe(3);
    expect(agent!.role).toBe('implementer');
    expect(agent!.status).toBe('active');
  });

  it('returns undefined for empty pane', () => {
    const agent = getAgentByPaneIndex(db, 5);
    expect(agent).toBeUndefined();
  });

  it('returns undefined when only shutdown agents occupy the pane', () => {
    registerAgent(db, 'agent-dead', 4, 'tester');
    db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = 'agent-dead'").run();
    const agent = getAgentByPaneIndex(db, 4);
    expect(agent).toBeUndefined();
  });

  it('filters by status=active, not by recency alone', () => {
    // Register two agents on pane 2: old (shutdown) and new (active)
    registerAgent(db, 'agent-old', 2, 'tester');
    db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = 'agent-old'").run();
    registerAgent(db, 'agent-new', 2, 'implementer');
    const agent = getAgentByPaneIndex(db, 2);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe('agent-new');
    expect(agent!.status).toBe('active');
  });

  it('does not return agents from other panes', () => {
    registerAgent(db, 'agent-pane-0', 0, 'implementer');
    registerAgent(db, 'agent-pane-1', 1, 'tester');
    const agent = getAgentByPaneIndex(db, 0);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe('agent-pane-0');
  });
});

describe('recoverDeadClaim with paneLivenessCallback', () => {
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

  /** Helper: register agent, backdate heartbeat, create and claim a task */
  function setupStaleAgentWithTask(agentId: string, paneIndex: number): string {
    registerAgent(db, agentId, paneIndex, 'implementer');
    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = ?"
    ).run(agentId);
    const taskId = createTask(db, { subject: `task for ${agentId}` });
    claimTask(db, agentId);
    return taskId;
  }

  it('alive callback: returns empty, refreshes heartbeat, keeps task claimed', () => {
    const taskId = setupStaleAgentWithTask('agent-alive', 0);

    // Capture heartbeat BEFORE recovery to prove it changes
    const before = (getAgent(db, 'agent-alive')!).last_heartbeat_at;

    const recovered = recoverDeadClaim(db, 'agent-alive', 300, () => 'alive');

    // Return value: no tasks recovered
    expect(recovered).toEqual([]);

    // Agent state: still active, heartbeat refreshed
    const agent = getAgent(db, 'agent-alive')!;
    expect(agent.status).toBe('active');
    expect(new Date(agent.last_heartbeat_at).getTime()).toBeGreaterThan(new Date(before).getTime());

    // Task state: still claimed, still owned by this agent
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('claimed');
    expect(task.owner).toBe('agent-alive');

    // Event log: heartbeat refresh event recorded
    const events = db.prepare(
      "SELECT * FROM events WHERE event_type = 'agent_heartbeat_stale' AND actor = 'agent-alive'"
    ).all() as Array<{ payload: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(events[events.length - 1].payload);
    expect(payload.action).toBe('refreshed');
    expect(payload.reason).toBe('pane_alive');
  });

  it('alive callback: receives the correct pane_index from the agent row', () => {
    setupStaleAgentWithTask('agent-pane7', 7);

    const receivedPaneIndices: number[] = [];
    recoverDeadClaim(db, 'agent-pane7', 300, (paneIndex) => {
      receivedPaneIndices.push(paneIndex);
      return 'alive';
    });

    expect(receivedPaneIndices).toEqual([7]);
  });

  it('dead callback: recovers task, clears owner, shuts down agent', () => {
    const taskId = setupStaleAgentWithTask('agent-dead', 0);

    const recovered = recoverDeadClaim(db, 'agent-dead', 300, () => 'dead');

    // Return value: task was recovered
    expect(recovered).toContain(taskId);

    // Task state: requeued with cleared owner and timeout reason
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();
    expect(task.failure_reason).toBe('timeout');
    expect(task.retry_count).toBe(1);

    // Agent state: shut down
    const agent = getAgent(db, 'agent-dead')!;
    expect(agent.status).toBe('shutdown');
  });

  it('shell callback: recovers task same as dead', () => {
    const taskId = setupStaleAgentWithTask('agent-shell', 0);

    const recovered = recoverDeadClaim(db, 'agent-shell', 300, () => 'shell');

    expect(recovered).toContain(taskId);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();

    const agent = getAgent(db, 'agent-shell')!;
    expect(agent.status).toBe('shutdown');
  });

  it('no callback (backward compat): recovers task with full state mutation', () => {
    const taskId = setupStaleAgentWithTask('agent-stale', 0);

    const recovered = recoverDeadClaim(db, 'agent-stale', 300);

    expect(recovered).toContain(taskId);

    // Verify full recovery state — same contract as pre-callback behavior
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('pending');
    expect(task.owner).toBeNull();
    expect(task.failure_reason).toBe('timeout');
    expect(task.retry_count).toBe(1);

    const agent = getAgent(db, 'agent-stale')!;
    expect(agent.status).toBe('shutdown');
  });

  it('callback is not invoked when agent is no longer stale (TOCTOU guard)', () => {
    registerAgent(db, 'agent-fresh', 0, 'implementer');
    // Heartbeat is fresh (just registered) — not stale
    const callbackInvoked = vi.fn(() => 'alive' as const);

    const recovered = recoverDeadClaim(db, 'agent-fresh', 300, callbackInvoked);

    expect(recovered).toEqual([]);
    // The TOCTOU re-check inside the transaction should return early
    // before the callback is ever reached
    expect(callbackInvoked).not.toHaveBeenCalled();
  });

  it('alive callback with exhausted retries: still skips recovery (liveness wins)', () => {
    registerAgent(db, 'agent-alive-nr', 0, 'implementer');
    db.prepare(
      "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = ?"
    ).run('agent-alive-nr');
    const taskId = createTask(db, { subject: 'no-retry task', max_retries: 0 });
    claimTask(db, 'agent-alive-nr');

    const recovered = recoverDeadClaim(db, 'agent-alive-nr', 300, () => 'alive');

    // Even with 0 retries, alive = skip recovery entirely
    expect(recovered).toEqual([]);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    expect(task.status).toBe('claimed');
    expect(task.owner).toBe('agent-alive-nr');
  });
});
