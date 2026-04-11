import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getSchemaVersion } from '../../shared/src/migrations.js';

describe('migration v4: colony support', () => {
  function freshDb(): InstanceType<typeof Database> {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    // Create the minimal base schema that exists before any migrations run.
    // Do NOT include tables/columns that migrations create (e.g. execution_targets from v3).
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        description TEXT,
        role TEXT,
        priority INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'pending',
        owner TEXT,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retry_count INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        retry_after TEXT,
        result_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        claimed_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), actor TEXT, event_type TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, pane_index INTEGER, role TEXT, codex_session_id TEXT, status TEXT DEFAULT 'active', last_heartbeat_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), registered_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS task_artifacts (task_id TEXT, artifact_id TEXT, direction TEXT);
    `);
    return db;
  }

  it('adds colony columns to tasks table', () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare(`
      INSERT INTO tasks (id, subject, bead_id, sdlc_loop_level, output_path, clone_dir, worker_type, bridge_synced)
      VALUES ('t1', 'test', 'bead-1', 'L0', '/tmp/out', '/tmp/clone', 'codex', 0)
    `).run();
    const row = db.prepare('SELECT bead_id, sdlc_loop_level, worker_type, bridge_synced FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.bead_id).toBe('bead-1');
    expect(row.sdlc_loop_level).toBe('L0');
    expect(row.worker_type).toBe('codex');
    expect(row.bridge_synced).toBe(0);
  });

  it('creates task_corrections table', () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'test')").run();
    db.prepare("INSERT INTO task_corrections (task_id, level, cycle, max_cycles, last_finding) VALUES ('t1', 'L1', 1, 2, 'missing error handling')").run();
    const row = db.prepare('SELECT * FROM task_corrections WHERE task_id = ?').get('t1') as any;
    expect(row.level).toBe('L1');
    expect(row.cycle).toBe(1);
    expect(row.last_finding).toBe('missing error handling');
  });

  it('rejects invalid sdlc_loop_level', () => {
    const db = freshDb();
    runMigrations(db);
    expect(() => {
      db.prepare("INSERT INTO tasks (id, subject, sdlc_loop_level) VALUES ('t1', 'test', 'L99')").run();
    }).toThrow();
  });

  it('rejects invalid worker_type', () => {
    const db = freshDb();
    runMigrations(db);
    expect(() => {
      db.prepare("INSERT INTO tasks (id, subject, worker_type) VALUES ('t1', 'test', 'invalid')").run();
    }).toThrow();
  });

  it('allows NULL sdlc_loop_level for backward compatibility', () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'non-colony task')").run();
    const row = db.prepare('SELECT sdlc_loop_level, bead_id FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.sdlc_loop_level).toBeNull();
    expect(row.bead_id).toBeNull();
  });

  it('creates bead index', () => {
    const db = freshDb();
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_bead'").all();
    expect(indexes.length).toBe(1);
  });

  it('is idempotent', () => {
    const db = freshDb();
    const applied1 = runMigrations(db);
    const applied2 = runMigrations(db);
    expect(applied1).toBeGreaterThan(0);
    expect(applied2).toBe(0);
  });
});
