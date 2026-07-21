import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getSchemaVersion } from './migrations.js';

/**
 * Create a fresh in-memory SQLite database with the base schema
 * (tables that exist before any migrations run).
 */
function freshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
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
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      actor TEXT,
      event_type TEXT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      pane_index INTEGER,
      role TEXT,
      codex_session_id TEXT,
      status TEXT DEFAULT 'active',
      last_heartbeat_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      registered_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS task_artifacts (
      task_id TEXT,
      artifact_id TEXT,
      direction TEXT
    );
  `);
  return db;
}

describe('migration v4: colony support', () => {
  it('colony columns exist after migration (bead_id, sdlc_loop_level, output_path, clone_dir, worker_type, bridge_synced)', () => {
    const db = freshDb();
    runMigrations(db);

    db.prepare(`
      INSERT INTO tasks (id, subject, bead_id, sdlc_loop_level, output_path, clone_dir, worker_type, bridge_synced)
      VALUES ('t1', 'test', 'bead-1', 'L0', '/tmp/out', '/tmp/clone', 'codex', 0)
    `).run();

    const row = db.prepare(
      'SELECT bead_id, sdlc_loop_level, output_path, clone_dir, worker_type, bridge_synced FROM tasks WHERE id = ?'
    ).get('t1') as any;

    expect(row.bead_id).toBe('bead-1');
    expect(row.sdlc_loop_level).toBe('L0');
    expect(row.output_path).toBe('/tmp/out');
    expect(row.clone_dir).toBe('/tmp/clone');
    expect(row.worker_type).toBe('codex');
    expect(row.bridge_synced).toBe(0);

    db.close();
  });

  it('accepts claude_code as worker_type', () => {
    const db = freshDb();
    runMigrations(db);

    db.prepare(
      "INSERT INTO tasks (id, subject, worker_type) VALUES ('t1', 'claude task', 'claude_code')"
    ).run();

    const row = db.prepare('SELECT worker_type FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.worker_type).toBe('claude_code');

    db.close();
  });

  it('creates task_corrections table and it is functional', () => {
    const db = freshDb();
    runMigrations(db);

    db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'test')").run();
    db.prepare(
      "INSERT INTO task_corrections (task_id, level, cycle, max_cycles, last_finding) VALUES ('t1', 'L1', 1, 2, 'missing error handling')"
    ).run();

    const row = db.prepare('SELECT * FROM task_corrections WHERE task_id = ?').get('t1') as any;
    expect(row.task_id).toBe('t1');
    expect(row.level).toBe('L1');
    expect(row.cycle).toBe(1);
    expect(row.max_cycles).toBe(2);
    expect(row.last_finding).toBe('missing error handling');

    db.close();
  });

  it('rejects invalid sdlc_loop_level via CHECK constraint', () => {
    const db = freshDb();
    runMigrations(db);

    expect(() => {
      db.prepare("INSERT INTO tasks (id, subject, sdlc_loop_level) VALUES ('t1', 'test', 'L99')").run();
    }).toThrow();

    db.close();
  });

  it('rejects invalid worker_type via CHECK constraint', () => {
    const db = freshDb();
    runMigrations(db);

    expect(() => {
      db.prepare("INSERT INTO tasks (id, subject, worker_type) VALUES ('t1', 'test', 'invalid')").run();
    }).toThrow();

    db.close();
  });

  it('allows NULL sdlc_loop_level for backward compatibility with non-colony tasks', () => {
    const db = freshDb();
    runMigrations(db);

    db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'non-colony task')").run();

    const row = db.prepare('SELECT sdlc_loop_level, bead_id FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.sdlc_loop_level).toBeNull();
    expect(row.bead_id).toBeNull();

    db.close();
  });

  it('creates idx_tasks_bead index', () => {
    const db = freshDb();
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_bead'"
    ).all();
    expect(indexes).toHaveLength(1);

    db.close();
  });

  it('creates idx_tasks_colony index', () => {
    const db = freshDb();
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_colony'"
    ).all();
    expect(indexes).toHaveLength(1);

    db.close();
  });

  it('is idempotent — running migrations twice applies zero additional', () => {
    const db = freshDb();

    const applied1 = runMigrations(db);
    const applied2 = runMigrations(db);

    expect(applied1).toBeGreaterThan(0);
    expect(applied2).toBe(0);

    db.close();
  });

  it('schema version is 5 after migration', () => {
    const db = freshDb();
    runMigrations(db);

    const version = getSchemaVersion(db);
    expect(version).toBe(5);

    db.close();
  });
});

describe('migration v5: dispatch receipt enforcement', () => {
  it('adds fail-closed execution policy and receipt metadata with legacy-safe defaults', () => {
    const db = freshDb();
    runMigrations(db);

    db.prepare("INSERT INTO tasks (id, subject, role) VALUES ('t1', 'review', 'reviewer')").run();
    db.prepare("INSERT INTO tasks (id, subject) VALUES ('t2', 'legacy task')").run();
    db.prepare(`
      INSERT INTO task_attempts
        (id, task_id, role, selector, requested_model, observed_model, fallback_used)
      VALUES
        ('a1', 't1', 'reviewer', 'tmup-policy', 'auto', 'unknown', NULL)
    `).run();

    expect(db.prepare(`
      SELECT role_required, evidence_required, model_requirement,
             reference_model, execution_outcome
      FROM tasks WHERE id = 't1'
    `).get()).toEqual({
      role_required: 0,
      evidence_required: 0,
      model_requirement: 'none',
      reference_model: null,
      execution_outcome: null,
    });
    expect(db.prepare(`
      SELECT role, selector, requested_model, observed_model, fallback_used,
             fallback_model, fallback_reason, execution_outcome
      FROM task_attempts WHERE id = 'a1'
    `).get()).toEqual({
      role: 'reviewer',
      selector: 'tmup-policy',
      requested_model: 'auto',
      observed_model: 'unknown',
      fallback_used: null,
      fallback_model: null,
      fallback_reason: null,
      execution_outcome: null,
    });

    db.close();
  });

  it('rejects invalid policy, outcome, and nullable boolean values', () => {
    const db = freshDb();
    runMigrations(db);

    const taskColumns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    const attemptColumns = (db.prepare('PRAGMA table_info(task_attempts)').all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    expect(taskColumns).toEqual(expect.arrayContaining([
      'role_required', 'evidence_required', 'model_requirement', 'execution_outcome',
    ]));
    expect(attemptColumns).toEqual(expect.arrayContaining([
      'fallback_used', 'execution_outcome',
    ]));

    expect(() => db.prepare(
      "INSERT INTO tasks (id, subject, role_required) VALUES ('role-invalid', 'bad', 2)"
    ).run()).toThrow();
    expect(() => db.prepare(
      "INSERT INTO tasks (id, subject, evidence_required) VALUES ('evidence-invalid', 'bad', -1)"
    ).run()).toThrow();
    expect(() => db.prepare(
      "INSERT INTO tasks (id, subject, model_requirement) VALUES ('model-invalid', 'bad', 'guessed')"
    ).run()).toThrow();
    expect(() => db.prepare(
      "INSERT INTO tasks (id, subject, execution_outcome) VALUES ('outcome-invalid', 'bad', 'completed')"
    ).run()).toThrow();

    db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'review')").run();
    expect(() => db.prepare(`
      INSERT INTO task_attempts (id, task_id, fallback_used)
      VALUES ('fallback-invalid', 't1', 2)
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO task_attempts (id, task_id, execution_outcome)
      VALUES ('outcome-invalid', 't1', 'completed')
    `).run()).toThrow();

    db.close();
  });
});
