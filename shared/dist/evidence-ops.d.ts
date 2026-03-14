/**
 * Evidence operations: task attempts and evidence packets.
 *
 * P5.3: structured multi-pass evidence review.
 * Enriches existing task lifecycle without duplicating completion state.
 *
 * Key principle: task status transitions remain authoritative in task-lifecycle.ts.
 * Evidence records feed review and promotion decisions, not replace state transitions.
 */
import type { Database, TaskAttemptRow, EvidencePacketRow, CreateAttemptInput, CreateEvidenceInput, ReviewDisposition } from './types.js';
/**
 * Start a new attempt on a task.
 */
export declare function createAttempt(db: Database, attemptId: string, input: CreateAttemptInput): TaskAttemptRow;
/**
 * Complete an attempt with result.
 */
export declare function completeAttempt(db: Database, attemptId: string, status: 'succeeded' | 'failed' | 'abandoned', resultSummary?: string, confidence?: number, failureReason?: string): TaskAttemptRow;
/**
 * Get all attempts for a task.
 */
export declare function getTaskAttempts(db: Database, taskId: string): TaskAttemptRow[];
/**
 * Get the latest attempt for a task.
 */
export declare function getLatestAttempt(db: Database, taskId: string): TaskAttemptRow | undefined;
/**
 * Add an evidence packet to an attempt.
 */
export declare function addEvidence(db: Database, evidenceId: string, input: CreateEvidenceInput): EvidencePacketRow;
/**
 * Set reviewer disposition on an evidence packet.
 */
export declare function reviewEvidence(db: Database, evidenceId: string, disposition: ReviewDisposition): EvidencePacketRow;
/**
 * Get evidence packets for an attempt.
 */
export declare function getAttemptEvidence(db: Database, attemptId: string): EvidencePacketRow[];
/**
 * Check if a task has accepted evidence (at least one attempt with succeeded status
 * and all evidence packets approved).
 */
export declare function hasAcceptedEvidence(db: Database, taskId: string): boolean;
//# sourceMappingURL=evidence-ops.d.ts.map