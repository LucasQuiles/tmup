import type {
  EventType, FailureReason, MessageType, TaskStatus,
  PlanStatus, ReviewDisposition, AttemptStatus, EvidenceType,
  ExecutionTargetType, LifecycleEventType, CollaborationPattern,
  CynefinDomain, SdlcLoopLevel, SdlcPhase, WorkerType,
} from './types.js';

/** Exponential backoff base for retry delays (seconds). Used by failTask and recoverDeadClaim. */
export const BACKOFF_BASE_SECONDS = 30;

/** Maximum depth for recursive dependency traversal to prevent DoS on deep DAGs. */
export const MAX_DEPENDENCY_DEPTH = 100;

/** Maximum artifact file size in bytes for checksum computation (100 MB). */
export const MAX_ARTIFACT_SIZE_BYTES = 100 * 1024 * 1024;

/** Heartbeat stale threshold (seconds). Agents without a heartbeat for this duration are considered stale. */
export const STALE_AGENT_THRESHOLD_SECONDS = 300;

/** Background heartbeat interval (seconds). Launcher sends heartbeats at this cadence. */
export const HEARTBEAT_INTERVAL_SECONDS = 60;

/** Warning threshold for long-running tasks without completion (seconds). Default 30 minutes. */
export const CLAIMED_DURATION_WARNING_SECONDS = 1800;

/** Priority range for tasks. */
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 100;
export const DEFAULT_PRIORITY = 50;

/** Default grid pane count when grid-state.json is unavailable. */
export const DEFAULT_PANE_COUNT = 8;

/** Runtime-validated enum arrays — canonical SSOT derived from types.ts unions. */
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'blocked', 'claimed', 'completed', 'cancelled', 'needs_review'] as const;
export const FAILURE_REASONS: readonly FailureReason[] = ['crash', 'timeout', 'logic_error', 'artifact_missing', 'dependency_invalid'] as const;
export const MESSAGE_TYPES: readonly MessageType[] = ['direct', 'broadcast', 'finding', 'blocker', 'checkpoint', 'shutdown'] as const;
export const EVENT_TYPES: readonly EventType[] = [
  'task_created', 'task_claimed', 'task_completed', 'task_failed',
  'task_cancelled', 'task_unblocked', 'dependency_traversal_truncated', 'task_updated',
  'agent_registered', 'agent_shutdown', 'agent_heartbeat_stale',
  'dispatch', 'harvest', 'session_init', 'session_pause',
  'session_resume', 'session_teardown',
] as const;

/** Planning domain enums (P5.2) */
export const PLAN_STATUSES: readonly PlanStatus[] = ['proposed', 'challenged', 'operational', 'superseded'] as const;
export const REVIEW_DISPOSITIONS: readonly ReviewDisposition[] = ['approved', 'challenged', 'rejected'] as const;

/** Evidence enums (P5.3) */
export const ATTEMPT_STATUSES: readonly AttemptStatus[] = ['running', 'succeeded', 'failed', 'abandoned'] as const;
export const EVIDENCE_TYPES: readonly EvidenceType[] = ['diff', 'test_result', 'build_log', 'screenshot', 'review_comment', 'artifact_checksum'] as const;

/** Execution target enums (P5.4) */
export const EXECUTION_TARGET_TYPES: readonly ExecutionTargetType[] = ['tmux_pane', 'local_shell', 'codex_cloud'] as const;

export const CYNEFIN_DOMAINS: readonly CynefinDomain[] = ['clear', 'complicated', 'complex', 'chaotic', 'confusion'] as const;
export const SDLC_LOOP_LEVELS: readonly SdlcLoopLevel[] = ['L0', 'L1', 'L2', 'L2.5', 'L2.75'] as const;
export const SDLC_PHASES: readonly SdlcPhase[] = ['frame', 'scout', 'architect', 'execute', 'synthesize'] as const;
export const WORKER_TYPES: readonly WorkerType[] = ['codex', 'claude_code'] as const;

/** Per-session budget ceiling for Conductor sessions (spec §8). */
export const CONDUCTOR_BUDGET_USD = 10.0;

/** Per-worker budget ceiling (spec §8). */
export const WORKER_BUDGET_SONNET_USD = 3.0;
export const WORKER_BUDGET_HAIKU_USD = 0.5;

/** Per-bead budget ceiling (spec §8). */
export const BEAD_BUDGET_USD = 50.0;

/** Heartbeat stale thresholds by Cynefin domain in seconds (spec §3.3, SC-COL-20). */
export const HEARTBEAT_THRESHOLDS: Record<CynefinDomain, number> = {
  clear: 300,       // 5 minutes
  complicated: 900, // 15 minutes
  complex: 1800,    // 30 minutes
  chaotic: 300,     // 5 minutes (fast cycle)
  confusion: 900,   // 15 minutes
};

/** Lifecycle bridge enums (P5.1) */
export const LIFECYCLE_EVENT_TYPES: readonly LifecycleEventType[] = [
  'claude_session_start', 'claude_session_end', 'claude_precompact',
  'claude_task_completed', 'claude_subagent_stop',
] as const;

/** Collaboration patterns (P5.6) */
export const COLLABORATION_PATTERNS: readonly CollaborationPattern[] = [
  'research', 'plan', 'implement', 'review', 'test', 'audit', 'document',
] as const;
