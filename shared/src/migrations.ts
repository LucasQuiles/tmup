import type { Database } from './types.js';
import { SDLC_LOOP_LEVELS, WORKER_TYPES } from './constants.js';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
}

/**
 * Get the current schema version from the database.
 * Returns 0 if the schema_version table doesn't exist (fresh or pre-migration DB).
 */
export function getSchemaVersion(db: Database): number {
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch (err) {
    // Only treat "no such table" as pre-migration — all other errors propagate
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('no such table')) {
      return 0;
    }
    throw err;
  }
}

/**
 * Ensure the schema_version table exists.
 */
function ensureVersionTable(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      description TEXT NOT NULL
    )
  `).run();
}

/**
 * All migrations, ordered by version number.
 * Each migration runs inside an IMMEDIATE transaction.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Migrate dead states: failed -> needs_review, in_progress -> claimed',
    up: (db: Database) => {
      // Migrate "failed" rows to "needs_review" — preserving all other fields
      db.prepare("UPDATE tasks SET status = 'needs_review' WHERE status = 'failed'").run();

      // Migrate "in_progress" rows to "claimed" — preserving owner and timestamps
      db.prepare("UPDATE tasks SET status = 'claimed' WHERE status = 'in_progress'").run();
    },
  },
  {
    version: 2,
    description: 'Add schema constraints: event timestamp index, non-empty subject, one-active-per-owner',
    up: (db: Database) => {
      // Preflight: check for empty subjects
      const emptySubjects = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE subject = ''").get() as { cnt: number };
      if (emptySubjects.cnt > 0) {
        throw new Error(
          `Migration preflight failed: ${emptySubjects.cnt} tasks have empty subjects. ` +
          `Fix these before upgrading: SELECT id, subject FROM tasks WHERE subject = ''`
        );
      }

      // Preflight: check for duplicate active tasks per owner
      const dupeOwners = db.prepare(`
        SELECT owner, COUNT(*) as cnt FROM tasks
        WHERE status IN ('claimed') AND owner IS NOT NULL
        GROUP BY owner HAVING COUNT(*) > 1
      `).all() as Array<{ owner: string; cnt: number }>;
      if (dupeOwners.length > 0) {
        const details = dupeOwners.map(d => `${d.owner}(${d.cnt})`).join(', ');
        throw new Error(
          `Migration preflight failed: agents with multiple active tasks: ${details}. ` +
          `Resolve duplicate ownership before upgrading.`
        );
      }

      // Preflight: check for duplicate producers
      const dupeProducers = db.prepare(`
        SELECT artifact_id, COUNT(*) as cnt FROM task_artifacts
        WHERE direction = 'produces'
        GROUP BY artifact_id HAVING COUNT(*) > 1
      `).all() as Array<{ artifact_id: string; cnt: number }>;
      if (dupeProducers.length > 0) {
        throw new Error(
          `Migration preflight failed: ${dupeProducers.length} artifacts have multiple producers. ` +
          `Resolve before upgrading.`
        );
      }

      // Add event timestamp index for pruning performance
      db.prepare('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)').run();

      // Add non-empty subject constraint via trigger (SQLite doesn't support ALTER TABLE ADD CHECK)
      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS trg_tasks_nonempty_subject
        BEFORE INSERT ON tasks
        FOR EACH ROW
        WHEN NEW.subject = ''
        BEGIN
          SELECT RAISE(ABORT, 'subject must not be empty');
        END
      `).run();

      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS trg_tasks_nonempty_subject_update
        BEFORE UPDATE OF subject ON tasks
        FOR EACH ROW
        WHEN NEW.subject = ''
        BEGIN
          SELECT RAISE(ABORT, 'subject must not be empty');
        END
      `).run();

      // Partial unique index: one active task per owner
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_active_per_owner
        ON tasks(owner)
        WHERE status = 'claimed' AND owner IS NOT NULL
      `).run();

      // Partial unique index: one producer per artifact
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifacts_one_producer
        ON task_artifacts(artifact_id)
        WHERE direction = 'produces'
      `).run();
    },
  },
  {
    version: 3,
    description: 'Add planning domain, evidence records, execution targets, and lifecycle bridge tables (P5)',
    up: (db: Database) => {
      // --- P5.2: Planning domain ---
      db.prepare(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          subject TEXT NOT NULL CHECK (length(subject) <= 500),
          description TEXT CHECK (description IS NULL OR length(description) <= 10000),
          status TEXT NOT NULL DEFAULT 'proposed'
            CHECK (status IN ('proposed','challenged','operational','superseded')),
          owner TEXT,
          rationale TEXT CHECK (rationale IS NULL OR length(rationale) <= 10000),
          open_questions TEXT CHECK (open_questions IS NULL OR length(open_questions) <= 10000),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS plan_reviews (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id),
          reviewer TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('approved','challenged','rejected')),
          comment TEXT CHECK (comment IS NULL OR length(comment) <= 10000),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS research_packets (
          id TEXT PRIMARY KEY,
          plan_id TEXT REFERENCES plans(id),
          subject TEXT NOT NULL CHECK (length(subject) <= 500),
          findings TEXT NOT NULL CHECK (length(findings) <= 100000),
          author TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `).run();

      // Link plans to execution tasks
      db.prepare(`
        CREATE TABLE IF NOT EXISTS plan_tasks (
          plan_id TEXT NOT NULL REFERENCES plans(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          PRIMARY KEY (plan_id, task_id)
        )
      `).run();

      // --- P5.3: Evidence records ---
      db.prepare(`
        CREATE TABLE IF NOT EXISTS task_attempts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          agent_id TEXT,
          execution_target_id TEXT,
          model_family TEXT,
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running','succeeded','failed','abandoned')),
          failure_reason TEXT,
          result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 10000),
          confidence REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          ended_at TEXT
        )
      `).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS evidence_packets (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL REFERENCES task_attempts(id),
          type TEXT NOT NULL
            CHECK (type IN ('diff','test_result','build_log','screenshot','review_comment','artifact_checksum')),
          payload TEXT NOT NULL CHECK (length(payload) <= 100000),
          hash TEXT,
          reviewer_disposition TEXT
            CHECK (reviewer_disposition IS NULL OR reviewer_disposition IN ('approved','challenged','rejected')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `).run();

      // --- P5.4: Execution targets ---
      db.prepare(`
        CREATE TABLE IF NOT EXISTS execution_targets (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('tmux_pane','local_shell','codex_cloud')),
          label TEXT,
          pane_index INTEGER,
          capabilities TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `).run();

      // Add execution_target_id to agents (nullable for backward compatibility)
      db.prepare('ALTER TABLE agents ADD COLUMN execution_target_id TEXT REFERENCES execution_targets(id)').run();

      // --- P5.1: Lifecycle bridge ---
      db.prepare(`
        CREATE TABLE IF NOT EXISTS lifecycle_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          event_type TEXT NOT NULL
            CHECK (event_type IN ('claude_session_start','claude_session_end','claude_precompact',
                                  'claude_task_completed','claude_subagent_stop')),
          session_id TEXT,
          agent_id TEXT,
          payload TEXT CHECK (payload IS NULL OR length(payload) <= 100000)
        )
      `).run();

      // Performance indexes for new tables
      db.prepare('CREATE INDEX IF NOT EXISTS idx_plan_reviews_plan ON plan_reviews(plan_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_research_packets_plan ON research_packets(plan_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_plan_tasks_task ON plan_tasks(task_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_evidence_packets_attempt ON evidence_packets(attempt_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_session ON lifecycle_events(session_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_type ON lifecycle_events(event_type, timestamp)').run();
    },
  },
  {
    version: 4,
    description: 'Add SDLC-OS colony support: bead tracking, loop levels, worker types, corrections',
    up: (db: Database) => {
      // Source-of-truth for SDLC loop levels and worker types lives in
      // shared/src/types.ts (SdlcLoopLevel, WorkerType) and is re-exported
      // as runtime-indexable arrays from shared/src/constants.ts. Template
      // the CHECK constraints from those constants so the SQL and the TS
      // enum cannot drift.
      const loopLevelList = SDLC_LOOP_LEVELS.map((l) => `'${l}'`).join(',');
      const workerTypeList = WORKER_TYPES.map((w) => `'${w}'`).join(',');

      // Colony columns on tasks table (spec §4.1)
      db.prepare('ALTER TABLE tasks ADD COLUMN bead_id TEXT').run();
      db.prepare(`ALTER TABLE tasks ADD COLUMN sdlc_loop_level TEXT CHECK (sdlc_loop_level IS NULL OR sdlc_loop_level IN (${loopLevelList}))`).run();
      db.prepare('ALTER TABLE tasks ADD COLUMN output_path TEXT').run();
      db.prepare('ALTER TABLE tasks ADD COLUMN clone_dir TEXT').run();
      db.prepare(`ALTER TABLE tasks ADD COLUMN worker_type TEXT DEFAULT 'codex' CHECK (worker_type IN (${workerTypeList}))`).run();
      db.prepare('ALTER TABLE tasks ADD COLUMN bridge_synced INTEGER DEFAULT 0').run();

      // Correction tracking table (spec §4.1)
      db.prepare(`
        CREATE TABLE IF NOT EXISTS task_corrections (
          task_id TEXT NOT NULL REFERENCES tasks(id),
          level TEXT NOT NULL CHECK (level IN (${loopLevelList})),
          cycle INTEGER NOT NULL DEFAULT 0,
          max_cycles INTEGER NOT NULL DEFAULT 2,
          last_finding TEXT,
          PRIMARY KEY (task_id, level)
        )
      `).run();

      // Performance indexes
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_bead ON tasks(bead_id) WHERE bead_id IS NOT NULL').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_colony ON tasks(sdlc_loop_level, status) WHERE sdlc_loop_level IS NOT NULL').run();
    },
  },
];

/**
 * Run all pending migrations on the database.
 * Each migration runs in its own IMMEDIATE transaction.
 * Returns the number of migrations applied.
 */
export function runMigrations(db: Database): number {
  ensureVersionTable(db);
  const currentVersion = getSchemaVersion(db);

  let applied = 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    const run = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(
        migration.version,
        migration.description
      );
    });

    run.immediate();
    applied++;
  }

  return applied;
}
