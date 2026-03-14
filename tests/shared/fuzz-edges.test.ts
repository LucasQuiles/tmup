import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask, createTaskBatch } from '../../shared/src/task-ops.js';
import { claimTask, completeTask, failTask } from '../../shared/src/task-lifecycle.js';
import { validateArtifactPath, findArtifactByName } from '../../shared/src/artifact-ops.js';
import { sendMessage } from '../../shared/src/message-ops.js';
import { registerAgent, getAgent } from '../../shared/src/agent-ops.js';
import type { Database, TaskRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

function buildLongArtifactPath(baseDir: string, minLength: number = 1001): string {
  const segment = 'nested-segment-' + 'x'.repeat(32);
  let current = baseDir;

  while (current.length <= minLength) {
    current = path.join(current, segment);
    fs.mkdirSync(current, { recursive: true });
  }

  const filePath = path.join(current, 'artifact.txt');
  fs.writeFileSync(filePath, 'long-path-artifact');
  return filePath;
}

describe('fuzz and edge coverage', () => {
  let db: Database;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-fuzz-'));
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('task creation boundaries', () => {
    it('rejects empty subject strings', () => {
      expect(() => createTask(db, { subject: '' })).toThrow('subject must not be empty');
    });

    it('accepts a 500-char subject and rejects 501 chars', () => {
      const exactSubject = 's'.repeat(500);
      const acceptedId = createTask(db, { subject: exactSubject });
      const accepted = db.prepare('SELECT subject FROM tasks WHERE id = ?').get(acceptedId) as { subject: string };
      expect(accepted.subject).toHaveLength(500);

      expect(() => createTask(db, { subject: 's'.repeat(501) })).toThrow();

      const count = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it('accepts a 10000-char description and rejects 10001 chars', () => {
      const exactDescription = 'd'.repeat(10000);
      const acceptedId = createTask(db, {
        subject: 'Description boundary',
        description: exactDescription,
      });
      const accepted = db.prepare('SELECT description FROM tasks WHERE id = ?').get(acceptedId) as { description: string };
      expect(accepted.description).toHaveLength(10000);

      expect(() => createTask(db, {
        subject: 'Description overflow',
        description: 'd'.repeat(10001),
      })).toThrow();

      const count = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe('numeric boundaries', () => {
    it('accepts boundary priority values and rejects invalid numeric inputs', () => {
      for (const priority of [0, 100]) {
        const id = createTask(db, { subject: `priority-${priority}`, priority });
        const row = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id) as { priority: number };
        expect(row.priority).toBe(priority);
      }

      for (const priority of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => createTask(db, {
          subject: `invalid-priority-${String(priority)}`,
          priority,
        })).toThrow();
      }

      const count = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('accepts boundary max_retries values and rejects out-of-range values', () => {
      for (const maxRetries of [0, 100]) {
        const id = createTask(db, {
          subject: `retries-${maxRetries}`,
          max_retries: maxRetries,
        });
        const row = db.prepare('SELECT max_retries FROM tasks WHERE id = ?').get(id) as { max_retries: number };
        expect(row.max_retries).toBe(maxRetries);
      }

      for (const maxRetries of [-1, 101]) {
        expect(() => createTask(db, {
          subject: `invalid-retries-${maxRetries}`,
          max_retries: maxRetries,
        })).toThrow();
      }

      const count = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });
  });

  describe('artifact path defenses', () => {
    it('rejects parent-directory traversal in artifact paths', () => {
      expect(() => validateArtifactPath(path.join(tmpDir, '..', 'escape.txt'), tmpDir)).toThrow('must be within project directory');
    });

    it('rejects symlink artifacts that escape the project directory', () => {
      const taskId = createTask(db, { subject: 'Symlink publish', produces: ['secret.txt'] });
      claimTask(db, 'agent-1');

      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'outside-project-data');

        const symlinkPath = path.join(tmpDir, 'secret-link.txt');
        fs.symlinkSync(outsideFile, symlinkPath);

        expect(() => completeTask(db, taskId, 'done', [
          { name: 'secret.txt', path: symlinkPath },
        ], tmpDir, 'agent-1')).toThrow();
      } finally {
        try { fs.rmSync(outsideDir, { recursive: true }); } catch {}
      }
    });

    it('throws on null-byte artifact paths and leaves the task claimed', () => {
      const taskId = createTask(db, { subject: 'Null byte artifact', produces: ['null.bin'] });
      claimTask(db, 'agent-1');

      expect(() => completeTask(db, taskId, 'done', [
        { name: 'null.bin', path: path.join(tmpDir, 'bad\0name') },
      ], tmpDir, 'agent-1')).toThrow();

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('claimed');
      expect(task.completed_at).toBeNull();
    });

    it('rejects artifact paths longer than 1000 chars and rolls back completion', () => {
      const taskId = createTask(db, { subject: 'Long path artifact', produces: ['deep.txt'] });
      claimTask(db, 'agent-1');

      const longPath = buildLongArtifactPath(tmpDir, 1005);
      expect(longPath.length).toBeGreaterThan(1000);

      expect(() => completeTask(db, taskId, 'done', [
        { name: 'deep.txt', path: longPath },
      ], tmpDir, 'agent-1')).toThrow();

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('claimed');
      expect(task.completed_at).toBeNull();

      const artifact = findArtifactByName(db, 'deep.txt');
      expect(artifact?.status).toBe('pending');
      expect(artifact?.path).toBe('');
    });
  });

  describe('message payload boundaries', () => {
    it('accepts exact-limit, empty, and unicode payloads and rejects overflow', () => {
      const exactId = sendMessage(db, {
        from_agent: 'agent-limit',
        to_agent: 'lead',
        type: 'direct',
        payload: 'x'.repeat(100000),
      });
      const emptyId = sendMessage(db, {
        from_agent: 'agent-empty',
        to_agent: 'lead',
        type: 'direct',
        payload: '',
      });
      const unicodePayload = 'こんにちは-界-ß-Привет';
      const unicodeId = sendMessage(db, {
        from_agent: 'agent-unicode',
        to_agent: 'lead',
        type: 'direct',
        payload: unicodePayload,
      });

      expect(() => sendMessage(db, {
        from_agent: 'agent-overflow',
        to_agent: 'lead',
        type: 'direct',
        payload: 'x'.repeat(100001),
      })).toThrow('100000');

      const exact = db.prepare('SELECT length(payload) as len FROM messages WHERE id = ?').get(exactId) as { len: number };
      const empty = db.prepare('SELECT payload FROM messages WHERE id = ?').get(emptyId) as { payload: string };
      const unicode = db.prepare('SELECT payload FROM messages WHERE id = ?').get(unicodeId) as { payload: string };

      expect(exact.len).toBe(100000);
      expect(empty.payload).toBe('');
      expect(unicode.payload).toBe(unicodePayload);
    });
  });

  describe('agent id fuzz cases', () => {
    it('stores unusual agent identifiers literally', () => {
      const ids = [
        '',
        'a'.repeat(4096),
        'agent-!@#$%^&*()[]{}<>?/\\\\|~',
        "' OR 1=1 --",
      ];

      ids.forEach((id, index) => registerAgent(db, id, index));
      ids.forEach((id, index) => {
        const row = getAgent(db, id);
        expect(row?.id).toBe(id);
        expect(row?.pane_index).toBe(index);
      });

      const count = db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number };
      expect(count.cnt).toBe(ids.length);
    });
  });

  describe('claim and lifecycle races', () => {
    it('lets exactly one of 10 agents claim the same task', async () => {
      const taskId = createTask(db, { subject: 'Single claim winner' });
      const connections = Array.from({ length: 10 }, () => openDatabase(dbPath));

      try {
        const results = await Promise.all(
          connections.map((conn, index) =>
            Promise.resolve().then(() => claimTask(conn, `agent-${index}`))
          )
        );

        const winners = results.filter((task): task is TaskRow => task !== null);
        expect(winners).toHaveLength(1);
        expect(winners[0].id).toBe(taskId);

        const stored = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
        expect(stored.status).toBe('claimed');
        expect(stored.owner).toBe(winners[0].owner);
      } finally {
        connections.forEach(conn => closeDatabase(conn));
      }
    });

    it('throws when a completed task is completed again', () => {
      const taskId = createTask(db, { subject: 'Double complete' });
      claimTask(db, 'agent-1');
      completeTask(db, taskId, 'done', undefined, undefined, 'agent-1');

      expect(() => completeTask(db, taskId, 'done again', undefined, undefined, 'agent-1')).toThrow("cannot be completed from status 'completed'");
    });

    it('throws when a completed task is failed', () => {
      const taskId = createTask(db, { subject: 'Fail after complete' });
      claimTask(db, 'agent-1');
      completeTask(db, taskId, 'done', undefined, undefined, 'agent-1');

      expect(() => failTask(db, taskId, 'crash', 'late failure', 'agent-1')).toThrow("cannot be failed from status 'completed'");
    });
  });

  describe('batch rollback boundaries', () => {
    it('rolls back a 501-task batch completely', () => {
      const inputs = Array.from({ length: 501 }, (_, index) => ({
        subject: `bulk-task-${index}`,
      }));

      expect(() => createTaskBatch(db, inputs)).toThrow('Task limit reached');

      const tasks = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      const events = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number };

      expect(tasks.cnt).toBe(0);
      expect(events.cnt).toBe(0);
    });
  });
});
