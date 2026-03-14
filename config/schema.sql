-- tmup schema v1
-- Task DAG with dependencies, artifacts, messaging, and agent tracking

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL CHECK (length(subject) <= 500),
  description TEXT CHECK (description IS NULL OR length(description) <= 10000),
  role TEXT,
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','blocked','claimed','completed',
                      'cancelled','needs_review')),
  owner TEXT,
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 0 AND 100),
  retry_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT
    CHECK (failure_reason IS NULL OR failure_reason IN
           ('crash','timeout','logic_error','artifact_missing','dependency_invalid')),
  retry_after TEXT,
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 10000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  completed_at TEXT
);

-- DAG edges: dependency relationships between tasks
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);

-- Task-artifact relationships: what tasks produce and require
CREATE TABLE IF NOT EXISTS task_artifacts (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  direction TEXT NOT NULL CHECK (direction IN ('produces','requires')),
  PRIMARY KEY (task_id, artifact_id, direction)
);

-- Artifacts: files produced by tasks, tracked with checksums
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) <= 200),
  path TEXT NOT NULL CHECK (length(path) <= 1000),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','published','missing','stale')),
  checksum TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Messages: inter-agent communication
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  type TEXT NOT NULL
    CHECK (type IN ('direct','broadcast','finding','blocker','checkpoint','shutdown')),
  payload TEXT NOT NULL CHECK (length(payload) <= 100000),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);

-- Agents: registered workers with heartbeat tracking
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  pane_index INTEGER NOT NULL,
  role TEXT,
  codex_session_id TEXT,
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active','idle','shutdown')),
  last_heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Events: append-only audit log
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('task_created','task_claimed','task_completed','task_failed',
                          'task_cancelled','task_unblocked','dependency_traversal_truncated','task_updated',
                          'agent_registered','agent_shutdown','agent_heartbeat_stale',
                          'dispatch','harvest','session_init','session_pause',
                          'session_resume','session_teardown')),
  payload TEXT CHECK (payload IS NULL OR length(payload) <= 100000)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_task_deps_target ON task_deps(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_source ON task_deps(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(status, role, priority, created_at, retry_after)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_agent, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_by_name ON artifacts(name);
CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat_at)
  WHERE status = 'active';
