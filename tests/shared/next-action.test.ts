import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { getNextAction } from '../../shared/src/next-action.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import { registerAgent } from '../../shared/src/agent-ops.js';
import { sendMessage } from '../../shared/src/message-ops.js';
import { logEvent } from '../../shared/src/event-ops.js';
import type { Database } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('getNextAction', () => {
  let db: Database;
  let dbPath: string;
  const defaultPanes = { totalPanes: 8 };

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  it('returns waiting when no tasks exist', () => {
    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('waiting');
    expect(action.message).toContain('0 pending');
  });

  it('returns needs_review when a task needs review', () => {
    const taskId = createTask(db, { subject: 'Review me' });
    registerAgent(db, 'agent-1', 0);
    db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-1' WHERE id = ?").run(taskId);
    db.prepare("UPDATE tasks SET status = 'needs_review', failure_reason = 'crash' WHERE id = ?").run(taskId);

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('needs_review');
    expect(action.message).toContain('needs review');
    expect(action.message).toContain('crash');
  });

  it('returns blocker when unread blocker message exists', () => {
    createTask(db, { subject: 'Task with blocker' });
    registerAgent(db, 'agent-1', 0);
    sendMessage(db, {
      from_agent: 'agent-1',
      to_agent: null,
      type: 'broadcast',
      payload: 'test',
    });
    // Insert a blocker message directly
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
      VALUES ('blk-1', 'agent-1', 'lead', 'blocker', 'Stuck on auth', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run();

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('blocker');
    expect(action.message).toContain('Blocker from agent-1');
    expect(action.message).toContain('Stuck on auth');
  });

  it('returns unblocked when task just unblocked', () => {
    const dep = createTask(db, { subject: 'Dep task' });
    const taskId = createTask(db, { subject: 'Blocked task', deps: [dep] });

    // Simulate unblock event
    logEvent(db, null, 'task_unblocked', { task_id: taskId });
    // Make sure the task is pending (unblocked)
    db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?").run(taskId);

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('unblocked');
    expect(action.message).toContain('just unblocked');
    expect(action.message).toContain('Blocked task');
  });

  it('returns dispatch when pending tasks and idle panes exist', () => {
    createTask(db, { subject: 'Waiting task' });

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('dispatch');
    expect(action.message).toContain('pending tasks');
    expect(action.message).toContain('idle panes');
  });

  it('returns all_complete when all tasks done', () => {
    const taskId = createTask(db, { subject: 'Done task' });
    registerAgent(db, 'agent-1', 0);
    claimTask(db, 'agent-1');
    db.prepare("UPDATE tasks SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(taskId);

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('all_complete');
    expect(action.message).toContain('completed');
    expect(action.message).toContain('teardown');
  });

  it('returns waiting when all panes busy', () => {
    createTask(db, { subject: 'Pending task' });
    // Register enough agents to fill all panes
    for (let i = 0; i < 8; i++) {
      registerAgent(db, `agent-${i}`, i);
    }

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('waiting');
    expect(action.message).toContain('pending');
  });

  it('respects totalPanes parameter (1 pane)', () => {
    createTask(db, { subject: 'Task' });
    registerAgent(db, 'agent-0', 0);

    const action = getNextAction(db, { totalPanes: 1 });
    expect(action.kind).toBe('waiting');
    // Only 1 pane, 1 active agent = 0 idle
  });

  it('respects variable pane count (9 panes for 3x3 grid)', () => {
    createTask(db, { subject: 'Task' });
    registerAgent(db, 'agent-0', 0);

    const action = getNextAction(db, { totalPanes: 9 });
    expect(action.kind).toBe('dispatch');
    // 9 panes, 1 active agent = 8 idle, should suggest dispatch
    expect(action.message).toContain('idle panes');
  });

  it('reports correct idle pane count for non-default grid', () => {
    createTask(db, { subject: 'Task' });
    // Fill 4 panes on a 4-pane (2x2) grid
    for (let i = 0; i < 4; i++) {
      registerAgent(db, `agent-${i}`, i);
    }

    const action = getNextAction(db, { totalPanes: 4 });
    expect(action.kind).toBe('waiting');
    // 4 panes, 4 agents = 0 idle
  });

  it('needs_review takes priority over blocker', () => {
    const taskId = createTask(db, { subject: 'Review first' });
    db.prepare("UPDATE tasks SET status = 'needs_review', failure_reason = 'timeout' WHERE id = ?").run(taskId);

    // Also insert a blocker
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
      VALUES ('blk-2', 'agent-1', 'lead', 'blocker', 'Other issue', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run();

    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('needs_review');
  });

  it('handles corrupted event payload gracefully', () => {
    createTask(db, { subject: 'Task' });
    // Insert an event with invalid JSON payload
    db.prepare(`
      INSERT INTO events (actor, event_type, payload, timestamp)
      VALUES (NULL, 'task_unblocked', 'not-json', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run();

    // Should not throw — falls through to dispatch
    const action = getNextAction(db, defaultPanes);
    expect(action.kind).toBe('dispatch');
  });
});
