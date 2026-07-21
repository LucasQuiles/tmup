import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../shared/src/db.js';
import { createTask } from '../../shared/src/task-ops.js';
import {
  attestAttempt,
  beginDispatch,
  finalizeAttempt,
  getDispatchReceipt,
} from '../../shared/src/dispatch-ops.js';
import type { Database } from '../../shared/src/types.js';
import { cleanupDb, tmpDbPath } from '../helpers/db.js';

describe('dispatch-ops', () => {
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

  it('registers, claims, and creates one receipt atomically', () => {
    const taskId = createTask(db, { subject: 'Review', role: 'reviewer' });

    const result = beginDispatch(db, {
      attempt_id: 'attempt-1',
      task_id: taskId,
      agent_id: 'agent-1',
      pane_index: 2,
      role: 'reviewer',
      selector: 'tmup-policy',
      requested_model: 'auto',
      observed_model: 'unknown',
      observation_source: null,
      fallback_used: null,
    });

    expect(result.task).toEqual(expect.objectContaining({
      id: taskId,
      status: 'claimed',
      owner: 'agent-1',
    }));
    expect(result.receipt).toEqual({
      attempt_id: 'attempt-1',
      task_id: taskId,
      agent_id: 'agent-1',
      role: 'reviewer',
      selector: 'tmup-policy',
      requested_model: 'auto',
      observed_model: 'unknown',
      observation_source: null,
      fallback_used: null,
      fallback_model: null,
      fallback_reason: null,
      terminal_status: 'running',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agents').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_attempts').get()).toEqual({ count: 1 });
  });

  it('rolls back registration and claim when attempt creation fails', () => {
    const firstTaskId = createTask(db, { subject: 'First', role: 'reviewer' });
    beginDispatch(db, {
      attempt_id: 'duplicate', task_id: firstTaskId, agent_id: 'agent-1', pane_index: 1,
      role: 'reviewer', selector: 'tmup-policy', requested_model: 'auto',
      observed_model: 'unknown', fallback_used: null,
    });
    const secondTaskId = createTask(db, { subject: 'Second', role: 'reviewer' });

    expect(() => beginDispatch(db, {
      attempt_id: 'duplicate', task_id: secondTaskId, agent_id: 'agent-2', pane_index: 2,
      role: 'reviewer', selector: 'tmup-policy', requested_model: 'auto',
      observed_model: 'unknown', fallback_used: null,
    })).toThrow();

    expect(db.prepare('SELECT status, owner FROM tasks WHERE id = ?').get(secondTaskId)).toEqual({
      status: 'pending',
      owner: null,
    });
    expect(db.prepare("SELECT id FROM agents WHERE id = 'agent-2'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_attempts').get()).toEqual({ count: 1 });
  });

  it('rejects a receipt role that does not match the task without partial state', () => {
    const taskId = createTask(db, { subject: 'Review', role: 'reviewer' });

    expect(() => beginDispatch(db, {
      attempt_id: 'attempt-1', task_id: taskId, agent_id: 'agent-1', pane_index: 2,
      role: 'tester', selector: 'tmup-policy', requested_model: 'auto',
      observed_model: 'unknown', fallback_used: null,
    })).toThrow("task requires 'reviewer'");

    expect(db.prepare('SELECT status, owner FROM tasks WHERE id = ?').get(taskId)).toEqual({
      status: 'pending',
      owner: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agents').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_attempts').get()).toEqual({ count: 0 });
  });

  it('attests the observed model while preserving requested and fallback provenance', () => {
    const taskId = createTask(db, { subject: 'Review', role: 'reviewer' });
    beginDispatch(db, {
      attempt_id: 'attempt-1', task_id: taskId, agent_id: 'agent-1', pane_index: 2,
      role: 'reviewer', selector: 'tmup-policy', requested_model: 'model-a',
      observed_model: 'unknown', fallback_used: null,
    });

    const receipt = attestAttempt(db, 'attempt-1', {
      observed_model: 'model-b',
      observation_source: 'runtime-session-banner',
      fallback_used: true,
      fallback_model: 'model-b',
      fallback_reason: 'requested model unavailable',
    });

    expect(receipt).toEqual(expect.objectContaining({
      requested_model: 'model-a',
      observed_model: 'model-b',
      observation_source: 'runtime-session-banner',
      fallback_used: true,
      fallback_model: 'model-b',
      fallback_reason: 'requested model unavailable',
      terminal_status: 'running',
    }));
  });

  it('rejects incomplete fallback provenance without changing the receipt', () => {
    const taskId = createTask(db, { subject: 'Review', role: 'reviewer' });
    beginDispatch(db, {
      attempt_id: 'attempt-1', task_id: taskId, agent_id: 'agent-1', pane_index: 2,
      role: 'reviewer', selector: 'tmup-policy', requested_model: 'model-a',
      observed_model: 'unknown', fallback_used: null,
    });

    expect(() => attestAttempt(db, 'attempt-1', {
      observed_model: 'model-b',
      observation_source: 'runtime-session-banner',
      fallback_used: true,
      fallback_model: 'model-b',
    })).toThrow('fallback_reason is required');
    expect(getDispatchReceipt(db, 'attempt-1')).toEqual(expect.objectContaining({
      observed_model: 'unknown',
      fallback_used: null,
      fallback_model: null,
      fallback_reason: null,
    }));
  });

  for (const outcome of ['unavailable', 'skipped', 'inconclusive'] as const) {
    it(`finalizes an attempt as ${outcome} without completing the task`, () => {
      const taskId = createTask(db, { subject: 'Review', role: 'reviewer' });
      beginDispatch(db, {
        attempt_id: 'attempt-1', task_id: taskId, agent_id: 'agent-1', pane_index: 2,
        role: 'reviewer', selector: 'tmup-policy', requested_model: 'auto',
        observed_model: 'unknown', fallback_used: null,
      });

      const receipt = finalizeAttempt(db, 'attempt-1', outcome, `${outcome} during launch`);

      expect(receipt.terminal_status).toBe(outcome);
      expect(db.prepare('SELECT status, execution_outcome FROM tasks WHERE id = ?').get(taskId)).toEqual({
        status: 'claimed',
        execution_outcome: outcome,
      });
      const attempt = db.prepare(
        'SELECT status, ended_at, execution_outcome, failure_reason FROM task_attempts WHERE id = ?'
      ).get('attempt-1') as Record<string, unknown>;
      expect(attempt.status).not.toBe('running');
      expect(attempt.ended_at).toEqual(expect.any(String));
      expect(attempt.execution_outcome).toBe(outcome);
      expect(attempt.failure_reason).toBe(`${outcome} during launch`);
    });
  }
});
