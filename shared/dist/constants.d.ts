import type { EventType, FailureReason, MessageType, TaskStatus, PlanStatus, ReviewDisposition, AttemptStatus, EvidenceType, ExecutionTargetType, LifecycleEventType, CollaborationPattern, CynefinDomain, SdlcLoopLevel, SdlcPhase, WorkerType } from './types.js';
/** Exponential backoff base for retry delays (seconds). Used by failTask and recoverDeadClaim. */
export declare const BACKOFF_BASE_SECONDS = 30;
/** Maximum depth for recursive dependency traversal to prevent DoS on deep DAGs. */
export declare const MAX_DEPENDENCY_DEPTH = 100;
/** Maximum artifact file size in bytes for checksum computation (100 MB). */
export declare const MAX_ARTIFACT_SIZE_BYTES: number;
/** Heartbeat stale threshold (seconds). Agents without a heartbeat for this duration are considered stale. */
export declare const STALE_AGENT_THRESHOLD_SECONDS = 300;
/** Background heartbeat interval (seconds). Launcher sends heartbeats at this cadence. */
export declare const HEARTBEAT_INTERVAL_SECONDS = 60;
/** Warning threshold for long-running tasks without completion (seconds). Default 30 minutes. */
export declare const CLAIMED_DURATION_WARNING_SECONDS = 1800;
/** Priority range for tasks. */
export declare const MIN_PRIORITY = 0;
export declare const MAX_PRIORITY = 100;
export declare const DEFAULT_PRIORITY = 50;
/** Default grid pane count when grid-state.json is unavailable. */
export declare const DEFAULT_PANE_COUNT = 8;
/** Runtime-validated enum arrays — canonical SSOT derived from types.ts unions. */
export declare const TASK_STATUSES: readonly TaskStatus[];
export declare const FAILURE_REASONS: readonly FailureReason[];
export declare const MESSAGE_TYPES: readonly MessageType[];
export declare const EVENT_TYPES: readonly EventType[];
/** Planning domain enums (P5.2) */
export declare const PLAN_STATUSES: readonly PlanStatus[];
export declare const REVIEW_DISPOSITIONS: readonly ReviewDisposition[];
/** Evidence enums (P5.3) */
export declare const ATTEMPT_STATUSES: readonly AttemptStatus[];
export declare const EVIDENCE_TYPES: readonly EvidenceType[];
/** Execution target enums (P5.4) */
export declare const EXECUTION_TARGET_TYPES: readonly ExecutionTargetType[];
export declare const CYNEFIN_DOMAINS: readonly CynefinDomain[];
export declare const SDLC_LOOP_LEVELS: readonly SdlcLoopLevel[];
export declare const SDLC_PHASES: readonly SdlcPhase[];
export declare const WORKER_TYPES: readonly WorkerType[];
/** Per-session budget ceiling for Conductor sessions (spec §8). */
export declare const CONDUCTOR_BUDGET_USD = 10;
/** Per-worker budget ceiling (spec §8). */
export declare const WORKER_BUDGET_SONNET_USD = 3;
export declare const WORKER_BUDGET_HAIKU_USD = 0.5;
/** Per-bead budget ceiling (spec §8). */
export declare const BEAD_BUDGET_USD = 50;
/** Heartbeat stale thresholds by Cynefin domain in seconds (spec §3.3, SC-COL-20). */
export declare const HEARTBEAT_THRESHOLDS: Record<CynefinDomain, number>;
/** Lifecycle bridge enums (P5.1) */
export declare const LIFECYCLE_EVENT_TYPES: readonly LifecycleEventType[];
/** Collaboration patterns (P5.6) */
export declare const COLLABORATION_PATTERNS: readonly CollaborationPattern[];
//# sourceMappingURL=constants.d.ts.map