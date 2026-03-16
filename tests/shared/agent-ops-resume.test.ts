import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { registerAgent, recoverDeadClaim, getAgent } from '../../shared/src/agent-ops.js';
import { getAgentByPaneIndex } from '../../shared/src/agent-ops.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import type { Database, TaskRow } from '../../shared/src/types.js';
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

  it('returns active agent for occupied pane', () => {
    registerAgent(db, 'agent-1', 3, 'implementer');
    const agent = getAgentByPaneIndex(db, 3);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe('agent-1');
  });

  it('returns undefined for empty pane', () => {
    const agent = getAgentByPaneIndex(db, 5);
    expect(agent).toBeUndefined();
  });

  it('returns most recent active agent when multiple registered', () => {
    registerAgent(db, 'agent-old', 2, 'tester');
    db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = 'agent-old'").run();
    registerAgent(db, 'agent-new', 2, 'implementer');
    const agent = getAgentByPaneIndex(db, 2);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe('agent-new');
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

  it('skips recovery when callback returns alive', () => {
    registerAgent(db, 'agent-alive', 0, 'implementer');
    db.prepare("UPDATE agents SET last_heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = 'agent-alive'").run();
    const taskId = createTask(db, { subject: 'test task' });
    claimTask(db, 'agent-alive');

    const recovered = recoverDeadClaim(db, 'agent-alive', 300, () => 'alive');
    expect(recovered).toEqual([]);
    // Agent should still be active with refreshed heartbeat
    const agent = getAgent(db, 'agent-alive');
    expect(agent!.status).toBe('active');
  });

  it('proceeds with recovery when callback returns dead', () => {
    registerAgent(db, 'agent-dead', 0, 'implementer');
    db.prepare("UPDATE agents SET last_heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = 'agent-dead'").run();
    const taskId = createTask(db, { subject: 'test task' });
    claimTask(db, 'agent-dead');

    const recovered = recoverDeadClaim(db, 'agent-dead', 300, () => 'dead');
    expect(recovered).toContain(taskId);
  });

  it('proceeds with recovery when callback returns shell', () => {
    registerAgent(db, 'agent-shell', 0, 'implementer');
    db.prepare("UPDATE agents SET last_heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = 'agent-shell'").run();
    const taskId = createTask(db, { subject: 'test task' });
    claimTask(db, 'agent-shell');

    const recovered = recoverDeadClaim(db, 'agent-shell', 300, () => 'shell');
    expect(recovered).toContain(taskId);
  });

  it('backward compatible — works without callback', () => {
    registerAgent(db, 'agent-stale', 0, 'implementer');
    db.prepare("UPDATE agents SET last_heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = 'agent-stale'").run();
    const taskId = createTask(db, { subject: 'test task' });
    claimTask(db, 'agent-stale');

    // No callback — should recover as before
    const recovered = recoverDeadClaim(db, 'agent-stale', 300);
    expect(recovered).toContain(taskId);
  });
});
