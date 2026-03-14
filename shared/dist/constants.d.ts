import type { EventType, FailureReason, MessageType, TaskStatus, PlanStatus, ReviewDisposition, AttemptStatus, EvidenceType, ExecutionTargetType, LifecycleEventType, CollaborationPattern } from './types.js';
/** Exponential backoff base for retry delays (seconds). Used by failTask and recoverDeadClaim. */
export declare const BACKOFF_BASE_SECONDS = 30;
/** Maximum depth for recursive dependency traversal to prevent DoS on deep DAGs. */
export declare const MAX_DEPENDENCY_DEPTH = 100;
/** Maximum artifact file size in bytes for checksum computation (100 MB). */
export declare const MAX_ARTIFACT_SIZE_BYTES: number;
/** Heartbeat stale threshold (seconds). Agents without a heartbeat for this duration are considered stale. */
export declare const STALE_AGENT_THRESHOLD_SECONDS = 300;
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
/** Lifecycle bridge enums (P5.1) */
export declare const LIFECYCLE_EVENT_TYPES: readonly LifecycleEventType[];
/** Collaboration patterns (P5.6) */
export declare const COLLABORATION_PATTERNS: readonly CollaborationPattern[];
//# sourceMappingURL=constants.d.ts.map