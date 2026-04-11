import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('openDatabase', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      cleanupDb(p);
    }
    paths.length = 0;
  });

  it('creates WAL DB with correct pragmas', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(8000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
    closeDatabase(db);
  });

  it('creates all tables with correct names', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name).sort();
    expect(names).toEqual([
      'agents', 'artifacts', 'events', 'evidence_packets', 'execution_targets',
      'lifecycle_events', 'messages', 'plan_reviews', 'plan_tasks', 'plans',
      'research_packets', 'schema_version', 'task_artifacts', 'task_attempts',
      'task_corrections', 'task_deps', 'tasks',
    ]);
    closeDatabase(db);
  });

  it('is idempotent — second open does not duplicate tables or lose data', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db1 = openDatabase(p);
    // Insert data
    db1.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'test')").run();
    closeDatabase(db1);

    const db2 = openDatabase(p);
    const tables = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    expect(tables.length).toBe(17);
    // Data survives
    const task = db2.prepare('SELECT subject FROM tasks WHERE id = ?').get('001') as { subject: string };
    expect(task.subject).toBe('test');
    closeDatabase(db2);
  });

  it('sets 0600 permissions on DB file', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
    closeDatabase(db);
  });

  it('runtime-contract.json pragma allowlist matches applied pragmas', () => {
    const p = tmpDbPath();
    paths.push(p);

    // Read the runtime contract to get the declared pragmas
    const contractPath = path.resolve(__dirname, '../../config/runtime-contract.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8')) as Record<string, unknown>;
    const declaredPragmas = Object.keys(contract);

    // Every pragma in the contract must be applied and verifiable
    const db = openDatabase(p);
    for (const pragma of declaredPragmas) {
      const value = db.pragma(pragma, { simple: true });
      expect(value).toBe(contract[pragma]);
    }
    closeDatabase(db);
  });

  it('applies all pragmas from the runtime-contract.json', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    // Verify every pragma from the contract is actually applied
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(8000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
    expect(db.pragma('journal_size_limit', { simple: true })).toBe(33554432);
    closeDatabase(db);
  });

  it('tasks table has correct columns and constraints', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);

    // Verify primary key
    const task = db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'test') RETURNING id").get() as { id: string };
    expect(task.id).toBe('001');

    // Duplicate PK should fail
    expect(() => db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'dup')").run()).toThrow();

    // Default values
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('001') as Record<string, unknown>;
    expect(row.status).toBe('pending');
    expect(row.priority).toBe(50);
    expect(row.max_retries).toBe(3);
    expect(row.retry_count).toBe(0);

    closeDatabase(db);
  });

  it('rejects description exceeding 10000 character limit', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    const longDesc = 'x'.repeat(10001);
    expect(() =>
      db.prepare("INSERT INTO tasks (id, subject, description) VALUES ('001', 'test', ?)").run(longDesc)
    ).toThrow();
    closeDatabase(db);
  });

  it('accepts description at exactly 10000 characters', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    const desc = 'x'.repeat(10000);
    db.prepare("INSERT INTO tasks (id, subject, description) VALUES ('001', 'test', ?)").run(desc);
    const row = db.prepare('SELECT description FROM tasks WHERE id = ?').get('001') as { description: string };
    expect(row.description.length).toBe(10000);
    closeDatabase(db);
  });

  it('rejects result_summary exceeding 10000 character limit', () => {
    const p = tmpDbPath();
    paths.push(p);
    const db = openDatabase(p);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('001', 'test')").run();
    const longSummary = 'x'.repeat(10001);
    expect(() =>
      db.prepare("UPDATE tasks SET result_summary = ? WHERE id = '001'").run(longSummary)
    ).toThrow();
    closeDatabase(db);
  });
});
