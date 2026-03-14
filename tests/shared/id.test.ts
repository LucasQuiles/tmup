import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { nextTaskId, generateAgentId, generateMessageId, generateArtifactId } from '../../shared/src/id.js';
import type { Database } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('nextTaskId', () => {
  let dbPath: string;
  let db: Database;

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  it('returns "001" on empty DB', () => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    expect(nextTaskId(db)).toBe('001');
  });

  it('increments correctly through sequential inserts', () => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'test')").run();
    expect(nextTaskId(db)).toBe('002');
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('002', 'test2')").run();
    expect(nextTaskId(db)).toBe('003');
  });

  it('handles gaps — uses MAX, not count', () => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'a')").run();
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('005', 'b')").run();
    // Should be 006, not 003
    expect(nextTaskId(db)).toBe('006');
  });

  it('zero-pads to at least 3 digits for IDs < 1000', () => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    const id1 = nextTaskId(db);
    expect(id1).toBe('001');
    expect(id1).toHaveLength(3);

    db.prepare("INSERT INTO tasks (id, subject) VALUES ('099', 'x')").run();
    const id2 = nextTaskId(db);
    expect(id2).toBe('100');
    expect(id2).toHaveLength(3);
  });

  it('IDs beyond 999 still work but are 4+ digits', () => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('999', 'x')").run();
    const id = nextTaskId(db);
    expect(id).toBe('1000');
    expect(id).toHaveLength(4); // No longer 3-padded
  });

  it('handles deleted rows correctly — MAX ignores gaps from deletion', () => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'a')").run();
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('002', 'b')").run();
    db.prepare("DELETE FROM tasks WHERE id = '002'").run();
    // MAX is still 1 (only '001' remains), so next should be 002
    // Actually MAX(CAST('001' AS INTEGER)) = 1, so next = 2 = '002'
    expect(nextTaskId(db)).toBe('002');
  });
});

describe('generateAgentId', () => {
  it('returns valid UUID v4 format', () => {
    const id = generateAgentId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns unique values across 100 calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateAgentId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateMessageId', () => {
  it('returns valid UUID v4 format', () => {
    const id = generateMessageId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateMessageId()));
    expect(ids.size).toBe(50);
  });
});

describe('generateArtifactId', () => {
  it('returns valid UUID v4 format', () => {
    const id = generateArtifactId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateArtifactId()));
    expect(ids.size).toBe(50);
  });
});
