import type BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

// --- Enums ---

export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'claimed'
  | 'completed'
  | 'cancelled'
  | 'needs_review';

export type FailureReason =
  | 'crash'
  | 'timeout'
  | 'logic_error'
  | 'artifact_missing'
  | 'dependency_invalid'
  | 'launch_failed';

export type MessageType =
  | 'direct'
  | 'broadcast'
  | 'finding'
  | 'blocker'
  | 'checkpoint'
  | 'shutdown';

export type ArtifactStatus = 'pending' | 'published' | 'missing' | 'stale';

export type AgentStatus = 'active' | 'idle' | 'shutdown';

export type EventType =
  | 'task_created'
  | 'task_claimed'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled'
  | 'task_unblocked'
  | 'dependency_traversal_truncated'
  | 'task_updated'
  | 'agent_registered'
  | 'agent_shutdown'
  | 'agent_heartbeat_stale'
  | 'dispatch'
  | 'harvest'
  | 'session_init'
  | 'session_pause'
  | 'session_resume'
  | 'session_teardown'
  | 'task_unclaimed_on_launch_failure';

export type ArtifactDirection = 'produces' | 'requires';

export type AutonomyTier = 'checkpoint' | 'full_participant';

// --- Planning domain types (P5.2) ---

export type PlanStatus =
  | 'proposed'
  | 'challenged'
  | 'operational'
  | 'superseded';

export type ReviewDisposition =
  | 'approved'
  | 'challenged'
  | 'rejected';

// --- Evidence types (P5.3) ---

export type AttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'abandoned';

export type EvidenceType =
  | 'diff'
  | 'test_result'
  | 'build_log'
  | 'screenshot'
  | 'review_comment'
  | 'artifact_checksum';

// --- Execution target types (P5.4) ---

export type ExecutionTargetType =
  | 'tmux_pane'
  | 'local_shell'
  | 'codex_cloud';

// --- Lifecycle bridge types (P5.1) ---

export type LifecycleEventType =
  | 'claude_session_start'
  | 'claude_session_end'
  | 'claude_precompact'
  | 'claude_task_completed'
  | 'claude_subagent_stop';

// --- Colony runtime types (spec §4.2) ---

export type CynefinDomain = 'clear' | 'complicated' | 'complex' | 'chaotic' | 'confusion';
export type SdlcLoopLevel = 'L0' | 'L1' | 'L2' | 'L2.5' | 'L2.75';
export type SdlcPhase = 'frame' | 'scout' | 'architect' | 'execute' | 'synthesize';
export type WorkerType = 'codex' | 'claude_code';

export interface TaskCorrectionRow {
  task_id: string;
  level: SdlcLoopLevel;
  cycle: number;
  max_cycles: number;
  last_finding: string | null;
}

// --- Collaboration pattern types (P5.6) ---

export type CollaborationPattern =
  | 'research'
  | 'plan'
  | 'implement'
  | 'review'
  | 'test'
  | 'audit'
  | 'document';

// --- Row interfaces (DB row shapes) ---

export interface TaskRow {
  id: string;
  subject: string;
  description: string | null;
  role: string | null;
  priority: number;
  status: TaskStatus;
  owner: string | null;
  max_retries: number;
  retry_count: number;
  failure_reason: FailureReason | null;
  retry_after: string | null;
  result_summary: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string | null;
  type: MessageType;
  payload: string;
  task_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface ArtifactRow {
  id: string;
  name: string;
  path: string;
  status: ArtifactStatus;
  checksum: string | null;
  created_at: string;
}

export interface AgentRow {
  id: string;
  pane_index: number;
  role: string | null;
  codex_session_id: string | null;
  status: AgentStatus;
  last_heartbeat_at: string;
  registered_at: string;
}

export interface EventRow {
  id: number;
  timestamp: string;
  actor: string | null;
  event_type: EventType;
  payload: string | null;
}

export interface TaskDepRow {
  task_id: string;
  depends_on_task_id: string;
}

export interface TaskArtifactRow {
  task_id: string;
  artifact_id: string;
  direction: ArtifactDirection;
}

// --- Planning domain row interfaces (P5.2) ---

export interface PlanRow {
  id: string;
  subject: string;
  description: string | null;
  status: PlanStatus;
  owner: string | null;
  rationale: string | null;
  open_questions: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanReviewRow {
  id: string;
  plan_id: string;
  reviewer: string;
  disposition: ReviewDisposition;
  comment: string | null;
  created_at: string;
}

export interface ResearchPacketRow {
  id: string;
  plan_id: string | null;
  subject: string;
  findings: string;
  author: string;
  created_at: string;
}

// --- Evidence row interfaces (P5.3) ---

export interface TaskAttemptRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  execution_target_id: string | null;
  model_family: string | null;
  status: AttemptStatus;
  failure_reason: string | null;
  result_summary: string | null;
  confidence: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface EvidencePacketRow {
  id: string;
  attempt_id: string;
  type: EvidenceType;
  payload: string;
  hash: string | null;
  reviewer_disposition: ReviewDisposition | null;
  created_at: string;
}

// --- Execution target row interface (P5.4) ---

export interface ExecutionTargetRow {
  id: string;
  type: ExecutionTargetType;
  label: string | null;
  pane_index: number | null;
  capabilities: string;  // JSON array of capability strings
  created_at: string;
}

// --- Lifecycle event row interface (P5.1) ---

export interface LifecycleEventRow {
  id: number;
  timestamp: string;
  event_type: LifecycleEventType;
  session_id: string | null;
  agent_id: string | null;
  payload: string | null;
}

// --- Input interfaces ---

export interface CreateTaskInput {
  subject: string;
  description?: string;
  role?: string;
  priority?: number;
  max_retries?: number;
  deps?: string[];
  requires?: string[];
  produces?: string[];
}

export interface CreateMessageInput {
  from_agent: string;
  to_agent?: string | null;
  type: MessageType;
  payload: string;
  task_id?: string;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  priority?: number;
  role?: string;
  description?: string;
  max_retries?: number;
}

export interface CompleteTaskInput {
  task_id: string;
  result_summary: string;
  artifacts?: Array<{ name: string; path: string }>;
}

export interface FailTaskInput {
  task_id: string;
  reason: FailureReason;
  message: string;
}

// --- Planning input interfaces (P5.2) ---

export interface CreatePlanInput {
  subject: string;
  description?: string;
  rationale?: string;
  open_questions?: string;
}

export interface CreatePlanReviewInput {
  plan_id: string;
  reviewer: string;
  disposition: ReviewDisposition;
  comment?: string;
}

export interface CreateResearchPacketInput {
  plan_id?: string;
  subject: string;
  findings: string;
  author: string;
}

// --- Evidence input interfaces (P5.3) ---

export interface CreateAttemptInput {
  task_id: string;
  agent_id?: string;
  execution_target_id?: string;
  model_family?: string;
}

export interface CreateEvidenceInput {
  attempt_id: string;
  type: EvidenceType;
  payload: string;
  hash?: string;
}

// --- Execution target input interfaces (P5.4) ---

export interface CreateExecutionTargetInput {
  type: ExecutionTargetType;
  label?: string;
  pane_index?: number;
  capabilities?: string[];
}

// --- Session types ---

export interface RegistryEntry {
  session_id: string;
  project_dir: string;
  db_path: string;
  created_at: string;
}

export interface SessionRegistry {
  sessions: Record<string, RegistryEntry>;
}

// --- Policy types ---

export interface Policy {
  dag: {
    default_priority: number;
    max_retries: number;
    retry_backoff_base_seconds: number;
    stale_max_age_seconds: number;
    heartbeat_interval_seconds: number;
    claimed_duration_warning_seconds: number;
  };
  grid: {
    session_prefix: string;
    rows: number;
    cols: number;
    width: number;
    height: number;
  };
  harvesting: {
    capture_scrollback_lines: number;
    poll_interval_seconds: number;
  };
  timeouts: {
    dispatch_trust_prompt_seconds: number;
    teardown_grace_seconds: number;
    pause_checkpoint_seconds: number;
    send_reprompt_seconds: number;
  };
  autonomy: {
    full_participant_roles: string[];
    checkpoint_roles: string[];
  };
}
