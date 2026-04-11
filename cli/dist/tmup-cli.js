#!/usr/bin/env node

// ../shared/dist/db.js
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ../shared/dist/constants.js
var BACKOFF_BASE_SECONDS = 30;
var MAX_ARTIFACT_SIZE_BYTES = 100 * 1024 * 1024;
var DEFAULT_PANE_COUNT = 8;
var FAILURE_REASONS = ["crash", "timeout", "logic_error", "artifact_missing", "dependency_invalid"];
var MESSAGE_TYPES = ["direct", "broadcast", "finding", "blocker", "checkpoint", "shutdown"];
var EVENT_TYPES = [
  "task_created",
  "task_claimed",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "task_unblocked",
  "dependency_traversal_truncated",
  "task_updated",
  "agent_registered",
  "agent_shutdown",
  "agent_heartbeat_stale",
  "dispatch",
  "harvest",
  "session_init",
  "session_pause",
  "session_resume",
  "session_teardown"
];
var SDLC_LOOP_LEVELS = ["L0", "L1", "L2", "L2.5", "L2.75"];
var WORKER_TYPES = ["codex", "claude_code"];

// ../shared/dist/migrations.js
function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
    return row?.version ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("no such table")) {
      return 0;
    }
    throw err;
  }
}
function ensureVersionTable(db) {
  db.pragma("journal_mode = WAL");
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      description TEXT NOT NULL
    )
  `).run();
}
var migrations = [
  {
    version: 1,
    description: "Migrate dead states: failed -> needs_review, in_progress -> claimed",
    up: (db) => {
      db.prepare("UPDATE tasks SET status = 'needs_review' WHERE status = 'failed'").run();
      db.prepare("UPDATE tasks SET status = 'claimed' WHERE status = 'in_progress'").run();
    }
  },
  {
    version: 2,
    description: "Add schema constraints: event timestamp index, non-empty subject, one-active-per-owner",
    up: (db) => {
      const emptySubjects = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE subject = ''").get();
      if (emptySubjects.cnt > 0) {
        throw new Error(`Migration preflight failed: ${emptySubjects.cnt} tasks have empty subjects. Fix these before upgrading: SELECT id, subject FROM tasks WHERE subject = ''`);
      }
      const dupeOwners = db.prepare(`
        SELECT owner, COUNT(*) as cnt FROM tasks
        WHERE status IN ('claimed') AND owner IS NOT NULL
        GROUP BY owner HAVING COUNT(*) > 1
      `).all();
      if (dupeOwners.length > 0) {
        const details = dupeOwners.map((d) => `${d.owner}(${d.cnt})`).join(", ");
        throw new Error(`Migration preflight failed: agents with multiple active tasks: ${details}. Resolve duplicate ownership before upgrading.`);
      }
      const dupeProducers = db.prepare(`
        SELECT artifact_id, COUNT(*) as cnt FROM task_artifacts
        WHERE direction = 'produces'
        GROUP BY artifact_id HAVING COUNT(*) > 1
      `).all();
      if (dupeProducers.length > 0) {
        throw new Error(`Migration preflight failed: ${dupeProducers.length} artifacts have multiple producers. Resolve before upgrading.`);
      }
      db.prepare("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)").run();
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
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_active_per_owner
        ON tasks(owner)
        WHERE status = 'claimed' AND owner IS NOT NULL
      `).run();
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifacts_one_producer
        ON task_artifacts(artifact_id)
        WHERE direction = 'produces'
      `).run();
    }
  },
  {
    version: 3,
    description: "Add planning domain, evidence records, execution targets, and lifecycle bridge tables (P5)",
    up: (db) => {
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
      db.prepare(`
        CREATE TABLE IF NOT EXISTS plan_tasks (
          plan_id TEXT NOT NULL REFERENCES plans(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          PRIMARY KEY (plan_id, task_id)
        )
      `).run();
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
      db.prepare("ALTER TABLE agents ADD COLUMN execution_target_id TEXT REFERENCES execution_targets(id)").run();
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
      db.prepare("CREATE INDEX IF NOT EXISTS idx_plan_reviews_plan ON plan_reviews(plan_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_research_packets_plan ON research_packets(plan_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_plan_tasks_task ON plan_tasks(task_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_evidence_packets_attempt ON evidence_packets(attempt_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_events_session ON lifecycle_events(session_id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_events_type ON lifecycle_events(event_type, timestamp)").run();
    }
  },
  {
    version: 4,
    description: "Add SDLC-OS colony support: bead tracking, loop levels, worker types, corrections",
    up: (db) => {
      const loopLevelList = SDLC_LOOP_LEVELS.map((l) => `'${l}'`).join(",");
      const workerTypeList = WORKER_TYPES.map((w) => `'${w}'`).join(",");
      db.prepare("ALTER TABLE tasks ADD COLUMN bead_id TEXT").run();
      db.prepare(`ALTER TABLE tasks ADD COLUMN sdlc_loop_level TEXT CHECK (sdlc_loop_level IS NULL OR sdlc_loop_level IN (${loopLevelList}))`).run();
      db.prepare("ALTER TABLE tasks ADD COLUMN output_path TEXT").run();
      db.prepare("ALTER TABLE tasks ADD COLUMN clone_dir TEXT").run();
      db.prepare(`ALTER TABLE tasks ADD COLUMN worker_type TEXT DEFAULT 'codex' CHECK (worker_type IN (${workerTypeList}))`).run();
      db.prepare("ALTER TABLE tasks ADD COLUMN bridge_synced INTEGER DEFAULT 0").run();
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
      db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_bead ON tasks(bead_id) WHERE bead_id IS NOT NULL").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_colony ON tasks(sdlc_loop_level, status) WHERE sdlc_loop_level IS NOT NULL").run();
    }
  }
];
function runMigrations(db) {
  ensureVersionTable(db);
  const currentVersion = getSchemaVersion(db);
  let applied = 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion)
      continue;
    const run = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version, description) VALUES (?, ?)").run(migration.version, migration.description);
    });
    run.immediate();
    applied++;
  }
  return applied;
}

// ../shared/dist/db.js
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var CONFIG_DIR = path.resolve(__dirname, "../../config");
function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  const oldUmask = process.umask(63);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 448 });
  } finally {
    process.umask(oldUmask);
  }
  const db = new BetterSqlite3(dbPath);
  const ALLOWED_PRAGMAS = {
    journal_mode: "string",
    busy_timeout: "integer",
    foreign_keys: "integer",
    synchronous: "integer",
    wal_autocheckpoint: "integer",
    journal_size_limit: "integer"
  };
  const contractPath = path.join(CONFIG_DIR, "runtime-contract.json");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
  for (const [key, value] of Object.entries(contract)) {
    if (!(key in ALLOWED_PRAGMAS)) {
      throw new Error(`Unknown pragma in runtime-contract.json: ${key}`);
    }
    const expectedType = ALLOWED_PRAGMAS[key];
    if (expectedType === "integer") {
      const num = Number(value);
      if (!Number.isFinite(num))
        throw new Error(`Invalid pragma value for ${key}: ${value}`);
      db.pragma(`${key} = ${num}`);
    } else {
      const str = String(value);
      if (!/^[a-zA-Z_]+$/.test(str))
        throw new Error(`Invalid pragma value for ${key}: ${value}`);
      db.pragma(`${key} = ${str}`);
    }
  }
  const schemaPath = path.join(CONFIG_DIR, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  runMigrations(db);
  try {
    fs.chmodSync(dbPath, 384);
  } catch (err) {
    console.error(`[tmup] Warning: failed to set DB file permissions on ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return db;
}
function closeDatabase(db) {
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (err) {
    console.error(`[tmup] Warning: WAL checkpoint failed on close: ${err instanceof Error ? err.message : String(err)}`);
  }
  db.close();
}

// ../shared/dist/id.js
import crypto from "node:crypto";
function generateMessageId() {
  return crypto.randomUUID();
}

// ../shared/dist/event-ops.js
function logEvent(db, actor, eventType, payload) {
  db.prepare("INSERT INTO events (actor, event_type, payload) VALUES (?, ?, ?)").run(actor, eventType, payload ? JSON.stringify(payload) : null);
}
function getRecentEvents(db, eventType, limit = 50) {
  if (eventType) {
    return db.prepare("SELECT * FROM events WHERE event_type = ? ORDER BY id DESC LIMIT ?").all(eventType, limit);
  }
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
}

// ../shared/dist/dep-resolver.js
function findUnblockedDependents(db, completedTaskId) {
  const rows = db.prepare(`
    SELECT DISTINCT td.task_id FROM task_deps td
    WHERE td.depends_on_task_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM task_deps td2
      JOIN tasks t2 ON td2.depends_on_task_id = t2.id
      WHERE td2.task_id = td.task_id
      AND t2.status != 'completed'
    )
  `).all(completedTaskId);
  const unblockedIds = rows.map((r) => r.task_id);
  for (const id of unblockedIds) {
    const result = db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'blocked'").run(id);
    if (result.changes > 0) {
      logEvent(db, null, "task_unblocked", { task_id: id, unblocked_by: completedTaskId });
    }
  }
  return unblockedIds;
}

// ../shared/dist/artifact-ops.js
import fs2 from "node:fs";
import crypto2 from "node:crypto";
import path2 from "node:path";
function publishArtifact(db, artifactId, artifactPath, checksum) {
  const result = db.prepare("UPDATE artifacts SET status = 'published', path = ?, checksum = ? WHERE id = ?").run(artifactPath, checksum, artifactId);
  if (result.changes === 0) {
    throw new Error(`Artifact ${artifactId} not found`);
  }
}
function computeChecksum(filePath) {
  const stat = fs2.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Cannot checksum non-regular file: ${filePath}`);
  }
  if (stat.size > MAX_ARTIFACT_SIZE_BYTES) {
    throw new Error(`Artifact file exceeds size limit (${stat.size} > ${MAX_ARTIFACT_SIZE_BYTES} bytes)`);
  }
  const content = fs2.readFileSync(filePath);
  return crypto2.createHash("sha256").update(content).digest("hex");
}
function validateArtifactPath(artifactPath, projectDir) {
  const resolved = path2.resolve(artifactPath);
  const resolvedProject = path2.resolve(projectDir);
  if (!resolved.startsWith(resolvedProject + path2.sep) && resolved !== resolvedProject) {
    throw new Error(`Artifact path must be within project directory: ${artifactPath}`);
  }
  try {
    const realPath = fs2.realpathSync(resolved);
    const realProject = fs2.realpathSync(resolvedProject);
    if (!realPath.startsWith(realProject + path2.sep) && realPath !== realProject) {
      throw new Error(`Artifact path must be within project directory: ${artifactPath} (resolves to ${realPath})`);
    }
    return realPath;
  } catch (err) {
    if (err.code === "ENOENT") {
      return resolved;
    }
    throw err;
  }
}

// ../shared/dist/task-ops.js
function getActiveTaskForAgent(db, agentId) {
  return db.prepare("SELECT * FROM tasks WHERE owner = ? AND status = 'claimed' LIMIT 1").get(agentId) ?? null;
}

// ../shared/dist/task-lifecycle.js
var RETRIABLE_REASONS = ["crash", "timeout"];
function claimTask(db, agentId, role) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const claimRole = role ?? null;
  const claim = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM tasks WHERE owner = ? AND status = 'claimed' LIMIT 1").get(agentId);
    if (existing) {
      throw new Error(`Agent ${agentId} already owns active task ${existing.id}`);
    }
    const result = db.prepare(`
      UPDATE tasks SET status = 'claimed', owner = ?, claimed_at = ?
      WHERE id = (
        SELECT id FROM tasks
        WHERE status = 'pending'
          AND (role IS NULL OR role = ?)
          AND (retry_after IS NULL OR retry_after <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      ) AND status = 'pending'
    `).run(agentId, now, claimRole, now);
    if (result.changes === 0)
      return null;
    const task = db.prepare("SELECT * FROM tasks WHERE owner = ? AND status = 'claimed' AND claimed_at = ?").get(agentId, now);
    if (!task) {
      throw new Error("Claim succeeded but task row not found \u2014 concurrent modification detected");
    }
    logEvent(db, agentId, "task_claimed", { task_id: task.id });
    return task;
  });
  return claim.immediate();
}
function completeTask(db, taskId, resultSummary, artifacts, projectDir, actorId) {
  const checksums = [];
  if (artifacts) {
    for (const art of artifacts) {
      if (projectDir) {
        validateArtifactPath(art.path, projectDir);
      }
      checksums.push({
        name: art.name,
        path: art.path,
        checksum: computeChecksum(art.path)
      });
    }
  }
  const complete = db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task)
      throw new Error(`Task ${taskId} not found`);
    if (task.status !== "claimed") {
      throw new Error(`Task ${taskId} cannot be completed from status '${task.status}'`);
    }
    if (actorId !== "lead" && task.owner !== actorId) {
      throw new Error(`Task ${taskId} cannot be completed by '${actorId}': not the owning agent`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, result_summary = ?, owner = NULL WHERE id = ?").run(now, resultSummary, taskId);
    for (const art of checksums) {
      const artifact = db.prepare("SELECT a.id FROM artifacts a JOIN task_artifacts ta ON a.id = ta.artifact_id WHERE a.name = ? AND ta.task_id = ? AND ta.direction = ?").get(art.name, taskId, "produces");
      if (!artifact) {
        throw new Error(`Artifact '${art.name}' not registered as a 'produces' artifact for task ${taskId}`);
      }
      publishArtifact(db, artifact.id, art.path, art.checksum);
    }
    const unblocked = findUnblockedDependents(db, taskId);
    logEvent(db, actorId, "task_completed", {
      task_id: taskId,
      unblocked
    });
    return { unblocked };
  });
  return complete.immediate();
}
function failTask(db, taskId, reason, message, actorId) {
  const fail = db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task)
      throw new Error(`Task ${taskId} not found`);
    if (task.status !== "claimed") {
      throw new Error(`Task ${taskId} cannot be failed from status '${task.status}'`);
    }
    if (actorId !== "lead" && task.owner !== actorId) {
      throw new Error(`Task ${taskId} cannot be failed by '${actorId}': not the owning agent`);
    }
    const isRetriable = RETRIABLE_REASONS.includes(reason);
    const hasRetries = task.retry_count < task.max_retries;
    if (isRetriable && hasRetries) {
      const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, task.retry_count);
      const retryAfter = new Date(Date.now() + backoffSeconds * 1e3).toISOString();
      db.prepare(`
        UPDATE tasks SET
          status = 'pending',
          owner = NULL,
          failure_reason = ?,
          retry_count = retry_count + 1,
          retry_after = ?,
          result_summary = ?
        WHERE id = ?
      `).run(reason, retryAfter, message, taskId);
      logEvent(db, actorId, "task_failed", {
        task_id: taskId,
        reason,
        retrying: true,
        retry_after: retryAfter
      });
      return { retrying: true, retry_after: retryAfter };
    }
    db.prepare(`
      UPDATE tasks SET
        status = 'needs_review',
        owner = NULL,
        failure_reason = ?,
        result_summary = ?
      WHERE id = ?
    `).run(reason, message, taskId);
    logEvent(db, actorId, "task_failed", {
      task_id: taskId,
      reason,
      retrying: false
    });
    return { retrying: false };
  });
  return fail.immediate();
}

// ../shared/dist/message-ops.js
var MAX_MESSAGES_PER_AGENT = 1e3;
var MAX_PAYLOAD_LENGTH = 1e5;
var BROADCAST_MAX_AGE_SECONDS = 3600;
function sendMessage(db, input) {
  if (input.payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(`Message payload exceeds ${MAX_PAYLOAD_LENGTH} character limit`);
  }
  const run = db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent = ?").get(input.from_agent);
    if (count.cnt >= MAX_MESSAGES_PER_AGENT) {
      throw new Error(`Agent ${input.from_agent} has reached the ${MAX_MESSAGES_PER_AGENT} message limit`);
    }
    let toAgent;
    if (input.type === "broadcast") {
      toAgent = null;
    } else {
      toAgent = input.to_agent ?? null;
      if (!toAgent) {
        throw new Error(`Non-broadcast message of type '${input.type}' must have a non-empty recipient (to_agent)`);
      }
    }
    const id = generateMessageId();
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, type, payload, task_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.from_agent, toAgent, input.type, input.payload, input.task_id ?? null);
    return id;
  });
  return run.immediate();
}
function getInbox(db, agentId, markRead = false) {
  const query = `
    SELECT * FROM messages
    WHERE (
      (to_agent = ? AND read_at IS NULL)
      OR (to_agent IS NULL AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds'))
    )
    ORDER BY created_at ASC
  `;
  const broadcastAge = `-${BROADCAST_MAX_AGE_SECONDS}`;
  if (markRead) {
    const readInbox = db.transaction(() => {
      const messages = db.prepare(query).all(agentId, broadcastAge);
      if (messages.length > 0) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        for (const m of messages) {
          if (m.to_agent !== null) {
            db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, m.id);
          }
        }
      }
      return messages;
    });
    return readInbox.immediate();
  }
  return db.prepare(query).all(agentId, broadcastAge);
}
function getUnreadCount(db, agentId) {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE (
      (to_agent = ? AND read_at IS NULL)
      OR (to_agent IS NULL AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds'))
    )
  `).get(agentId, `-${BROADCAST_MAX_AGE_SECONDS}`);
  return row.cnt;
}
function postCheckpoint(db, taskId, agentId, message) {
  const run = db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task)
      throw new Error(`Task ${taskId} not found`);
    if (task.status !== "claimed") {
      throw new Error(`Cannot checkpoint task ${taskId} in status '${task.status}'`);
    }
    if (agentId !== "lead" && task.owner !== agentId) {
      throw new Error(`Task ${taskId} cannot be checkpointed by '${agentId}': not the owning agent`);
    }
    const id = generateMessageId();
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, type, payload, task_id)
      VALUES (?, ?, 'lead', 'checkpoint', ?, ?)
    `).run(id, agentId, message, taskId);
    db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run(message, taskId);
  });
  run.immediate();
}

// ../shared/dist/session-ops.js
import path3 from "node:path";
function getStateRoot() {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME environment variable is not set \u2014 cannot determine state directory");
  }
  return path3.join(home, ".local/state/tmup");
}
var STATE_ROOT = getStateRoot();
var REGISTRY_PATH = path3.join(STATE_ROOT, "registry.json");
var REGISTRY_LOCK = path3.join(STATE_ROOT, "registry.lock");
var CURRENT_SESSION_PATH = path3.join(STATE_ROOT, "current-session");

// ../shared/dist/agent-ops.js
function registerAgent(db, agentId, paneIndex, role) {
  db.prepare(`
    INSERT INTO agents (id, pane_index, role, status, last_heartbeat_at, registered_at)
    VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      pane_index = excluded.pane_index,
      role = excluded.role,
      status = 'active',
      last_heartbeat_at = excluded.last_heartbeat_at
  `).run(agentId, paneIndex, role ?? null);
  logEvent(db, agentId, "agent_registered", { pane_index: paneIndex, role });
}
function updateHeartbeat(db, agentId, codexSessionId, paneIndex) {
  const result = db.prepare(`
    UPDATE agents SET
      last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      codex_session_id = COALESCE(?, codex_session_id),
      pane_index = COALESCE(?, pane_index)
    WHERE id = ?
  `).run(codexSessionId ?? null, paneIndex ?? null, agentId);
  if (result.changes === 0) {
    throw new Error(`Agent ${agentId} not found \u2014 heartbeat requires prior registration`);
  }
}
function getAgent(db, agentId) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
}

// ../shared/dist/grid-state.js
import fs3 from "node:fs";
import path4 from "node:path";
function readGridState(sessionDir) {
  try {
    const gridPath = path4.join(sessionDir, "grid", "grid-state.json");
    const raw = fs3.readFileSync(gridPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.panes)) {
      return parsed;
    }
    return null;
  } catch (err) {
    const code = err.code;
    if (code !== "ENOENT") {
      console.error(`[tmup] Warning: failed to read grid state: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}
function getGridPaneCount(sessionDir) {
  if (!sessionDir) {
    return { count: DEFAULT_PANE_COUNT, source: "default" };
  }
  const gridState = readGridState(sessionDir);
  if (gridState) {
    return { count: gridState.panes.length, source: "grid-state" };
  }
  return { count: DEFAULT_PANE_COUNT, source: "default-session-no-grid" };
}

// src/commands/index.ts
function requireAgentId(env) {
  if (!env.agentId) throw new Error("TMUP_AGENT_ID not set");
  return env.agentId;
}
function parseFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return void 0;
  return args[idx + 1];
}
function hasFlag(args, flag) {
  return args.includes(flag);
}
var FLAGS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--role",
  "--reason",
  "--task-id",
  "--to",
  "--type",
  "--artifact",
  "--codex-session-id",
  "--limit"
]);
function positional(args) {
  const skip = /* @__PURE__ */ new Set();
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.has(args[i])) {
      skip.add(i);
      skip.add(i + 1);
      i++;
    } else if (args[i].startsWith("--")) {
      skip.add(i);
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skip.has(i)) return args[i];
  }
  return void 0;
}
async function handleCommand(db, command, args, env) {
  switch (command) {
    case "claim": {
      const agentId = requireAgentId(env);
      const role = parseFlag(args, "--role");
      const task = claimTask(db, agentId, role);
      if (!task) {
        const unread2 = getUnreadCount(db, agentId);
        return { ok: true, task: null, error: "NO_PENDING_TASKS", unread: unread2 };
      }
      const unread = getUnreadCount(db, agentId);
      return { ok: true, task_id: task.id, subject: task.subject, description: task.description, unread };
    }
    case "complete": {
      const agentId = requireAgentId(env);
      const resultSummary = positional(args);
      if (!resultSummary) throw new Error("Result summary required");
      const artifacts = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--artifact" && i + 1 < args.length) {
          const parts = args[i + 1].split(":");
          if (parts.length < 2) throw new Error(`Invalid artifact format: ${args[i + 1]} (expected name:path)`);
          const name = parts[0];
          const path5 = parts.slice(1).join(":");
          artifacts.push({ name, path: path5 });
          i++;
        }
      }
      const taskId = parseFlag(args, "--task-id") ?? env.taskId;
      if (!taskId) {
        const task = getActiveTaskForAgent(db, agentId);
        if (!task) throw new Error("No active task. Specify --task-id");
        const result2 = completeTask(db, task.id, resultSummary, artifacts.length > 0 ? artifacts : void 0, env.projectDir, agentId);
        const unread2 = getUnreadCount(db, agentId);
        return { ok: true, task_id: task.id, unblocked: result2.unblocked, unread: unread2 };
      }
      const result = completeTask(db, taskId, resultSummary, artifacts.length > 0 ? artifacts : void 0, env.projectDir, agentId);
      const unread = getUnreadCount(db, agentId);
      return { ok: true, task_id: taskId, unblocked: result.unblocked, unread };
    }
    case "fail": {
      const agentId = requireAgentId(env);
      const reasonStr = parseFlag(args, "--reason");
      if (!reasonStr) throw new Error(`--reason required (${FAILURE_REASONS.join(", ")})`);
      if (!FAILURE_REASONS.includes(reasonStr)) throw new Error(`Invalid reason: ${reasonStr}. Valid: ${FAILURE_REASONS.join(", ")}`);
      const reason = reasonStr;
      const message = positional(args);
      if (!message) throw new Error("Failure message required");
      const taskId = parseFlag(args, "--task-id") ?? env.taskId;
      if (!taskId) {
        const task = getActiveTaskForAgent(db, agentId);
        if (!task) throw new Error("No active task");
        const result2 = failTask(db, task.id, reason, message, agentId);
        return { ok: true, task_id: task.id, ...result2 };
      }
      const result = failTask(db, taskId, reason, message, agentId);
      return { ok: true, task_id: taskId, ...result };
    }
    case "checkpoint": {
      const agentId = requireAgentId(env);
      const checkpointMessage = positional(args);
      if (!checkpointMessage) throw new Error("Checkpoint message required");
      const taskId = parseFlag(args, "--task-id") ?? env.taskId;
      let resolvedTaskId;
      if (taskId) {
        resolvedTaskId = taskId;
      } else {
        const task = getActiveTaskForAgent(db, agentId);
        if (!task) throw new Error("No active task. Specify --task-id");
        resolvedTaskId = task.id;
      }
      postCheckpoint(db, resolvedTaskId, agentId, checkpointMessage);
      return { ok: true };
    }
    case "message": {
      const agentId = requireAgentId(env);
      const to = parseFlag(args, "--to");
      const isBroadcast = hasFlag(args, "--broadcast");
      const msgType = parseFlag(args, "--type") ?? (isBroadcast ? "broadcast" : "direct");
      if (!MESSAGE_TYPES.includes(msgType)) {
        throw new Error(`Invalid message type '${msgType}'. Valid: ${MESSAGE_TYPES.join(", ")}`);
      }
      const payload = positional(args);
      if (!payload) throw new Error("Message payload required");
      sendMessage(db, {
        from_agent: agentId,
        to_agent: isBroadcast ? null : to ?? "lead",
        type: msgType,
        payload
      });
      return { ok: true };
    }
    case "inbox": {
      const agentId = requireAgentId(env);
      const markRead = hasFlag(args, "--mark-read");
      if (!markRead) {
        const count = getUnreadCount(db, agentId);
        return { ok: true, unread: count };
      }
      const messages = getInbox(db, agentId, true);
      return { ok: true, messages: messages.map((m) => ({
        id: m.id,
        from: m.from_agent,
        type: m.type,
        payload: m.payload,
        task_id: m.task_id,
        created_at: m.created_at
      })) };
    }
    case "heartbeat": {
      const agentId = requireAgentId(env);
      const codexSessionId = parseFlag(args, "--codex-session-id");
      if (codexSessionId && !/^[a-zA-Z0-9-]+$/.test(codexSessionId)) {
        throw new Error("Invalid codex session ID format (must be alphanumeric + hyphens)");
      }
      const rawPaneIndex = env.paneIndex ?? "0";
      const paneIndex = parseInt(rawPaneIndex, 10);
      if (isNaN(paneIndex) || paneIndex < 0) {
        throw new Error(`Invalid TMUP_PANE_INDEX: '${rawPaneIndex}' (must be a non-negative integer)`);
      }
      const existing = getAgent(db, agentId);
      if (!existing) {
        const { count: gridPanes, source: gridSource } = getGridPaneCount(env.sessionDir);
        if (gridSource !== "default" && paneIndex >= gridPanes) {
          throw new Error(`Invalid TMUP_PANE_INDEX: '${rawPaneIndex}' (grid has ${gridPanes} panes, max index: ${gridPanes - 1})`);
        }
        registerAgent(db, agentId, paneIndex);
      }
      updateHeartbeat(db, agentId, codexSessionId, paneIndex);
      return { ok: true };
    }
    case "status": {
      const agentId = requireAgentId(env);
      const agent = getAgent(db, agentId);
      const currentTask = getActiveTaskForAgent(db, agentId);
      const unread = getUnreadCount(db, agentId);
      return {
        ok: true,
        agent_id: agentId,
        pane_index: agent?.pane_index ?? env.paneIndex,
        current_task: currentTask ? {
          id: currentTask.id,
          subject: currentTask.subject,
          status: currentTask.status
        } : null,
        unread
      };
    }
    case "events": {
      const rawLimit = parseFlag(args, "--limit");
      let limit = 50;
      if (rawLimit !== void 0) {
        const parsed = parseInt(rawLimit, 10);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`Invalid --limit: '${rawLimit}' (must be a positive integer)`);
        }
        limit = parsed;
      }
      const rawType = parseFlag(args, "--type");
      let eventType;
      if (rawType !== void 0) {
        if (!EVENT_TYPES.includes(rawType)) {
          throw new Error(`Invalid --type '${rawType}'. Valid: ${EVENT_TYPES.join(", ")}`);
        }
        eventType = rawType;
      }
      const events = getRecentEvents(db, eventType, limit);
      return { ok: true, events };
    }
    default:
      throw new Error(`Unknown command: ${command}. Valid: claim, complete, fail, checkpoint, message, inbox, heartbeat, status, events`);
  }
}

// src/index.ts
var CliError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
};
function getEnv(name) {
  return process.env[name];
}
function output(data) {
  console.log(JSON.stringify(data));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new CliError("Usage: tmup-cli <command> [args...]\nCommands: claim, complete, fail, checkpoint, message, inbox, heartbeat, status, events");
  }
  const command = args[0];
  const commandArgs = args.slice(1);
  const dbPath = getEnv("TMUP_DB");
  if (!dbPath) {
    throw new CliError("TMUP_DB not set");
  }
  let db = null;
  try {
    db = openDatabase(dbPath);
    const result = await handleCommand(db, command, commandArgs, {
      agentId: getEnv("TMUP_AGENT_ID"),
      paneIndex: getEnv("TMUP_PANE_INDEX"),
      sessionName: getEnv("TMUP_SESSION_NAME"),
      sessionDir: getEnv("TMUP_SESSION_DIR"),
      taskId: getEnv("TMUP_TASK_ID"),
      projectDir: getEnv("TMUP_PROJECT_DIR") ?? getEnv("TMUP_WORKING_DIR")
    });
    output(result);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    output({ ok: false, error: "COMMAND_ERROR", message });
    process.exit(1);
  } finally {
    if (db) closeDatabase(db);
  }
}
main().catch((error) => {
  if (error instanceof CliError) {
    output({ ok: false, error: "CLI_ERROR", message: error.message });
    process.exit(1);
  }
  console.error(JSON.stringify({ ok: false, error: "SYSTEM_ERROR", message: String(error) }));
  process.exit(2);
});
export {
  CliError
};
