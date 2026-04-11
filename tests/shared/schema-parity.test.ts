import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import type { Database } from '../../shared/src/types.js';

// TypeScript enum definitions — the source of truth for type unions
import type {
  TaskStatus, FailureReason, MessageType, ArtifactStatus, AgentStatus, EventType,
} from '../../shared/src/types.js';

import { tmpDbPath, cleanupDb } from '../helpers/db.js';

/**
 * Extract CHECK constraint enum literals from schema.sql for a given column.
 * Parses patterns like: CHECK (status IN ('a','b','c'))
 */
function extractSqlEnumValues(schemaSql: string, tableName: string, columnName: string): string[] {
  // Find the CREATE TABLE block for the given table
  const tableRegex = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    'i'
  );
  const tableMatch = schemaSql.match(tableRegex);
  if (!tableMatch) throw new Error(`Table ${tableName} not found in schema`);

  // Find CHECK constraint for the column
  // Match: column_name ... CHECK (column_name IN ('val1','val2',...))
  // or: CHECK (column_name IS NULL OR column_name IN ('val1','val2',...))
  const checkRegex = new RegExp(
    `${columnName}[^)]*CHECK\\s*\\([^)]*IN\\s*\\(([^)]+)\\)`,
    'i'
  );
  const checkMatch = tableMatch[1].match(checkRegex);
  if (!checkMatch) throw new Error(`CHECK constraint for ${tableName}.${columnName} not found`);

  const literals = checkMatch[1].match(/'([^']+)'/g);
  if (!literals) throw new Error(`No literals found in CHECK constraint for ${tableName}.${columnName}`);

  return literals.map(l => l.replace(/'/g, ''));
}

/**
 * Get all possible values from a TypeScript union type by reflecting on the type system.
 * We hardcode these since TypeScript types are erased at runtime.
 */
const TS_ENUMS: Record<string, string[]> = {
  TaskStatus: ['pending', 'blocked', 'claimed', 'completed', 'cancelled', 'needs_review'],
  FailureReason: ['crash', 'timeout', 'logic_error', 'artifact_missing', 'dependency_invalid', 'launch_failed'],
  MessageType: ['direct', 'broadcast', 'finding', 'blocker', 'checkpoint', 'shutdown'],
  ArtifactStatus: ['pending', 'published', 'missing', 'stale'],
  AgentStatus: ['active', 'idle', 'shutdown'],
  EventType: [
    'task_created', 'task_claimed', 'task_completed', 'task_failed',
    'task_cancelled', 'task_unblocked', 'dependency_traversal_truncated', 'task_updated',
    'agent_registered', 'agent_shutdown', 'agent_heartbeat_stale',
    'dispatch', 'harvest', 'session_init', 'session_pause',
    'session_resume', 'session_teardown',
  ],
};

describe('schema-parity', () => {
  let schemaSql: string;
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    const schemaPath = path.resolve(__dirname, '../../config/schema.sql');
    schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  describe('SQL-TypeScript enum parity', () => {
    it('TaskStatus SQL CHECK matches TypeScript union', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'tasks', 'status');
      expect(new Set(sqlValues)).toEqual(new Set(TS_ENUMS.TaskStatus));
    });

    it('FailureReason SQL CHECK matches TypeScript union', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'tasks', 'failure_reason');
      expect(new Set(sqlValues)).toEqual(new Set(TS_ENUMS.FailureReason));
    });

    it('MessageType SQL CHECK matches TypeScript union', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'messages', 'type');
      expect(new Set(sqlValues)).toEqual(new Set(TS_ENUMS.MessageType));
    });

    it('ArtifactStatus SQL CHECK matches TypeScript union', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'artifacts', 'status');
      expect(new Set(sqlValues)).toEqual(new Set(TS_ENUMS.ArtifactStatus));
    });

    it('AgentStatus SQL CHECK matches TypeScript union', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'agents', 'status');
      expect(new Set(sqlValues)).toEqual(new Set(TS_ENUMS.AgentStatus));
    });

    it('EventType SQL CHECK matches TypeScript union', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'events', 'event_type');
      expect(new Set(sqlValues)).toEqual(new Set(TS_ENUMS.EventType));
    });
  });

  describe('runtime constant arrays match TypeScript unions', () => {
    it('TASK_STATUSES matches TaskStatus union', async () => {
      const { TASK_STATUSES } = await import('../../shared/src/constants.js');
      expect(new Set(TASK_STATUSES as readonly string[])).toEqual(new Set(TS_ENUMS.TaskStatus));
    });

    it('FAILURE_REASONS matches FailureReason union', async () => {
      const { FAILURE_REASONS } = await import('../../shared/src/constants.js');
      expect(new Set(FAILURE_REASONS as readonly string[])).toEqual(new Set(TS_ENUMS.FailureReason));
    });

    it('MESSAGE_TYPES matches MessageType union', async () => {
      const { MESSAGE_TYPES } = await import('../../shared/src/constants.js');
      expect(new Set(MESSAGE_TYPES as readonly string[])).toEqual(new Set(TS_ENUMS.MessageType));
    });

    it('EVENT_TYPES matches EventType union', async () => {
      const { EVENT_TYPES } = await import('../../shared/src/constants.js');
      expect(new Set(EVENT_TYPES as readonly string[])).toEqual(new Set(TS_ENUMS.EventType));
    });
  });

  describe('dead state removal', () => {
    it('SQL schema no longer includes "failed" status', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'tasks', 'status');
      expect(sqlValues).not.toContain('failed');
    });

    it('SQL schema no longer includes "in_progress" status', () => {
      const sqlValues = extractSqlEnumValues(schemaSql, 'tasks', 'status');
      expect(sqlValues).not.toContain('in_progress');
    });
  });

  describe('schema constraints enforced after migration', () => {
    it('rejects duplicate active tasks per owner (partial unique index)', () => {
      db.prepare("INSERT INTO tasks (id, subject, status, owner) VALUES ('t1', 'First', 'claimed', 'agent-1')").run();
      expect(() =>
        db.prepare("INSERT INTO tasks (id, subject, status, owner) VALUES ('t2', 'Second', 'claimed', 'agent-1')").run()
      ).toThrow('UNIQUE constraint');
    });

    it('rejects empty subject (trigger constraint)', () => {
      expect(() =>
        db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', '')").run()
      ).toThrow('subject must not be empty');
    });

    it('has event timestamp index', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all() as Array<{ name: string }>;
      const hasTimestampIndex = indexes.some(i => i.name.includes('timestamp'));
      expect(hasTimestampIndex).toBe(true);
    });

    it('rejects duplicate producers for the same artifact (partial unique index)', () => {
      db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'Producer 1')").run();
      db.prepare("INSERT INTO tasks (id, subject) VALUES ('t2', 'Producer 2')").run();
      db.prepare("INSERT INTO artifacts (id, name, path) VALUES ('a1', 'output.json', '/tmp/out')").run();
      db.prepare("INSERT INTO task_artifacts (task_id, artifact_id, direction) VALUES ('t1', 'a1', 'produces')").run();
      expect(() =>
        db.prepare("INSERT INTO task_artifacts (task_id, artifact_id, direction) VALUES ('t2', 'a1', 'produces')").run()
      ).toThrow('UNIQUE constraint');
    });

    it('allows multiple consumers for the same artifact', () => {
      db.prepare("INSERT INTO tasks (id, subject) VALUES ('t1', 'Consumer 1')").run();
      db.prepare("INSERT INTO tasks (id, subject) VALUES ('t2', 'Consumer 2')").run();
      db.prepare("INSERT INTO artifacts (id, name, path) VALUES ('a1', 'shared.json', '/tmp/shared')").run();
      db.prepare("INSERT INTO task_artifacts (task_id, artifact_id, direction) VALUES ('t1', 'a1', 'requires')").run();
      db.prepare("INSERT INTO task_artifacts (task_id, artifact_id, direction) VALUES ('t2', 'a1', 'requires')").run();
      const count = db.prepare("SELECT COUNT(*) as cnt FROM task_artifacts WHERE artifact_id = 'a1' AND direction = 'requires'").get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });
  });

  describe('migration behavior', () => {
    it('fresh DB rejects "failed" status after migration', () => {
      expect(() =>
        db.prepare("INSERT INTO tasks (id, subject, status) VALUES ('t1', 'Attempt failed', 'failed')").run()
      ).toThrow(); // CHECK constraint rejects
    });

    it('fresh DB rejects "in_progress" status after migration', () => {
      expect(() =>
        db.prepare("INSERT INTO tasks (id, subject, status, owner) VALUES ('t1', 'Attempt in-progress', 'in_progress', 'agent-1')").run()
      ).toThrow(); // CHECK constraint rejects
    });

    it('allows overlong agent IDs (no constraint)', () => {
      const longId = 'a'.repeat(4096);
      db.prepare("INSERT INTO agents (id, pane_index) VALUES (?, 0)").run(longId);
      const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(longId) as { id: string };
      expect(agent.id).toBe(longId);
    });

    it('schema_version table records applied migrations', () => {
      const versions = db.prepare('SELECT version, description FROM schema_version ORDER BY version').all() as Array<{ version: number; description: string }>;
      expect(versions.length).toBe(4);
      expect(versions[0].version).toBe(1);
      expect(versions[0].description).toContain('dead states');
      expect(versions[1].version).toBe(2);
      expect(versions[1].description).toContain('schema constraints');
      expect(versions[2].version).toBe(3);
      expect(versions[2].description).toContain('P5');
      expect(versions[3].version).toBe(4);
      expect(versions[3].description).toContain('colony');
    });
  });

  describe('P5 enum parity (planning/evidence/execution/lifecycle/collaboration)', () => {
    it('PLAN_STATUSES matches plans CHECK constraint', () => {
      const migrationsSql = fs.readFileSync(
        path.resolve(__dirname, '../../shared/src/migrations.ts'), 'utf-8'
      );
      const match = migrationsSql.match(/status IN \('proposed','challenged','operational','superseded'\)/);
      expect(match).not.toBeNull();
    });

    it('PLAN_STATUSES runtime constant matches TypeScript type', async () => {
      const { PLAN_STATUSES } = await import('../../shared/src/constants.js');
      expect(new Set(PLAN_STATUSES as readonly string[])).toEqual(
        new Set(['proposed', 'challenged', 'operational', 'superseded'])
      );
    });

    it('REVIEW_DISPOSITIONS runtime constant matches TypeScript type', async () => {
      const { REVIEW_DISPOSITIONS } = await import('../../shared/src/constants.js');
      expect(new Set(REVIEW_DISPOSITIONS as readonly string[])).toEqual(
        new Set(['approved', 'challenged', 'rejected'])
      );
    });

    it('ATTEMPT_STATUSES runtime constant matches TypeScript type', async () => {
      const { ATTEMPT_STATUSES } = await import('../../shared/src/constants.js');
      expect(new Set(ATTEMPT_STATUSES as readonly string[])).toEqual(
        new Set(['running', 'succeeded', 'failed', 'abandoned'])
      );
    });

    it('EVIDENCE_TYPES runtime constant matches TypeScript type', async () => {
      const { EVIDENCE_TYPES } = await import('../../shared/src/constants.js');
      expect(new Set(EVIDENCE_TYPES as readonly string[])).toEqual(
        new Set(['diff', 'test_result', 'build_log', 'screenshot', 'review_comment', 'artifact_checksum'])
      );
    });

    it('EXECUTION_TARGET_TYPES runtime constant matches TypeScript type', async () => {
      const { EXECUTION_TARGET_TYPES } = await import('../../shared/src/constants.js');
      expect(new Set(EXECUTION_TARGET_TYPES as readonly string[])).toEqual(
        new Set(['tmux_pane', 'local_shell', 'codex_cloud'])
      );
    });

    it('LIFECYCLE_EVENT_TYPES runtime constant matches TypeScript type', async () => {
      const { LIFECYCLE_EVENT_TYPES } = await import('../../shared/src/constants.js');
      expect(new Set(LIFECYCLE_EVENT_TYPES as readonly string[])).toEqual(
        new Set(['claude_session_start', 'claude_session_end', 'claude_precompact',
                 'claude_task_completed', 'claude_subagent_stop'])
      );
    });

    it('COLLABORATION_PATTERNS runtime constant matches TypeScript type', async () => {
      const { COLLABORATION_PATTERNS } = await import('../../shared/src/constants.js');
      expect(new Set(COLLABORATION_PATTERNS as readonly string[])).toEqual(
        new Set(['research', 'plan', 'implement', 'review', 'test', 'audit', 'document'])
      );
    });
  });

  describe('P5 tables exist in fresh DB', () => {
    const v3Tables = [
      'plans', 'plan_reviews', 'research_packets', 'plan_tasks',
      'task_attempts', 'evidence_packets', 'execution_targets', 'lifecycle_events',
    ];

    for (const table of v3Tables) {
      it(`${table} table exists`, () => {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table) as { name: string } | undefined;
        expect(row?.name).toBe(table);
      });
    }

    it('agents table has execution_target_id column (ALTER TABLE from v3)', () => {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('execution_target_id');
    });
  });

  describe('migration preflight failures', () => {
    it('migration 2 rejects empty subjects', async () => {
      const { tmpDbPath: tmpPath, cleanupDb: cleanDb } = await import('../helpers/db.js');
      const BetterSqlite3 = (await import('better-sqlite3')).default;
      const preDbPath = tmpPath();
      const preDb = new BetterSqlite3(preDbPath);
      preDb.pragma('journal_mode = WAL');

      // Create a pre-migration DB at version 1 with an empty subject
      preDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          description TEXT NOT NULL
        );
        INSERT INTO schema_version (version, description) VALUES (1, 'migration 1');
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          subject TEXT NOT NULL DEFAULT '',
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 50,
          role TEXT, owner TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          failure_reason TEXT, result_summary TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          started_at TEXT, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS task_artifacts (
          task_id TEXT NOT NULL, artifact_id TEXT NOT NULL, direction TEXT NOT NULL,
          PRIMARY KEY (task_id, artifact_id, direction)
        );
        INSERT INTO tasks (id, subject, status) VALUES ('bad-1', '', 'pending');
      `);

      const { runMigrations } = await import('../../shared/src/migrations.js');
      expect(() => runMigrations(preDb)).toThrow('empty subjects');

      preDb.close();
      cleanDb(preDbPath);
    });

    it('migration 2 rejects duplicate active tasks per owner', async () => {
      const { tmpDbPath: tmpPath, cleanupDb: cleanDb } = await import('../helpers/db.js');
      const BetterSqlite3 = (await import('better-sqlite3')).default;
      const preDbPath = tmpPath();
      const preDb = new BetterSqlite3(preDbPath);
      preDb.pragma('journal_mode = WAL');

      preDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          description TEXT NOT NULL
        );
        INSERT INTO schema_version (version, description) VALUES (1, 'migration 1');
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          subject TEXT NOT NULL DEFAULT 'x',
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 50,
          role TEXT, owner TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          failure_reason TEXT, result_summary TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          started_at TEXT, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS task_artifacts (
          task_id TEXT NOT NULL, artifact_id TEXT NOT NULL, direction TEXT NOT NULL,
          PRIMARY KEY (task_id, artifact_id, direction)
        );
        INSERT INTO tasks (id, subject, status, owner) VALUES ('t1', 'Task 1', 'claimed', 'agent-1');
        INSERT INTO tasks (id, subject, status, owner) VALUES ('t2', 'Task 2', 'claimed', 'agent-1');
      `);

      const { runMigrations } = await import('../../shared/src/migrations.js');
      expect(() => runMigrations(preDb)).toThrow('multiple active tasks');

      preDb.close();
      cleanDb(preDbPath);
    });
  });
});
