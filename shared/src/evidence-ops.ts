/**
 * Evidence operations: task attempts and evidence packets.
 *
 * P5.3: structured multi-pass evidence review.
 * Enriches existing task lifecycle without duplicating completion state.
 *
 * Key principle: task status transitions remain authoritative in task-lifecycle.ts.
 * Evidence records feed review and promotion decisions, not replace state transitions.
 */
import type {
  Database,
  TaskAttemptRow, EvidencePacketRow,
  CreateAttemptInput, CreateEvidenceInput,
  AttemptStatus, ReviewDisposition,
} from './types.js';

/**
 * Start a new attempt on a task.
 */
export function createAttempt(
  db: Database,
  attemptId: string,
  input: CreateAttemptInput
): TaskAttemptRow {
  db.prepare(`
    INSERT INTO task_attempts (id, task_id, agent_id, execution_target_id, model_family, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(
    attemptId,
    input.task_id,
    input.agent_id ?? null,
    input.execution_target_id ?? null,
    input.model_family ?? null
  );

  return db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId) as TaskAttemptRow;
}

/**
 * Complete an attempt with result.
 */
export function completeAttempt(
  db: Database,
  attemptId: string,
  status: 'succeeded' | 'failed' | 'abandoned',
  resultSummary?: string,
  confidence?: number,
  failureReason?: string
): TaskAttemptRow {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE task_attempts
    SET status = ?, ended_at = ?, result_summary = ?, confidence = ?, failure_reason = ?
    WHERE id = ? AND status = 'running'
  `).run(status, now, resultSummary ?? null, confidence ?? null, failureReason ?? null, attemptId);

  const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId) as TaskAttemptRow | undefined;
  if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
  return attempt;
}

/**
 * Get all attempts for a task.
 */
export function getTaskAttempts(db: Database, taskId: string): TaskAttemptRow[] {
  return db.prepare(
    'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY started_at ASC'
  ).all(taskId) as TaskAttemptRow[];
}

/**
 * Get the latest attempt for a task.
 */
export function getLatestAttempt(db: Database, taskId: string): TaskAttemptRow | undefined {
  return db.prepare(
    'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1'
  ).get(taskId) as TaskAttemptRow | undefined;
}

/**
 * Add an evidence packet to an attempt.
 */
export function addEvidence(
  db: Database,
  evidenceId: string,
  input: CreateEvidenceInput
): EvidencePacketRow {
  db.prepare(`
    INSERT INTO evidence_packets (id, attempt_id, type, payload, hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(evidenceId, input.attempt_id, input.type, input.payload, input.hash ?? null);

  return db.prepare('SELECT * FROM evidence_packets WHERE id = ?').get(evidenceId) as EvidencePacketRow;
}

/**
 * Set reviewer disposition on an evidence packet.
 */
export function reviewEvidence(
  db: Database,
  evidenceId: string,
  disposition: ReviewDisposition
): EvidencePacketRow {
  db.prepare(
    'UPDATE evidence_packets SET reviewer_disposition = ? WHERE id = ?'
  ).run(disposition, evidenceId);

  const packet = db.prepare('SELECT * FROM evidence_packets WHERE id = ?').get(evidenceId) as EvidencePacketRow | undefined;
  if (!packet) throw new Error(`Evidence ${evidenceId} not found`);
  return packet;
}

/**
 * Get evidence packets for an attempt.
 */
export function getAttemptEvidence(db: Database, attemptId: string): EvidencePacketRow[] {
  return db.prepare(
    'SELECT * FROM evidence_packets WHERE attempt_id = ? ORDER BY created_at ASC'
  ).all(attemptId) as EvidencePacketRow[];
}

/**
 * Check if a task has accepted evidence (at least one attempt with succeeded status
 * and all evidence packets approved).
 */
export function hasAcceptedEvidence(db: Database, taskId: string): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM task_attempts ta
    WHERE ta.task_id = ? AND ta.status = 'succeeded'
    AND NOT EXISTS (
      SELECT 1 FROM evidence_packets ep
      WHERE ep.attempt_id = ta.id
      AND (ep.reviewer_disposition IS NULL OR ep.reviewer_disposition != 'approved')
    )
    AND EXISTS (
      SELECT 1 FROM evidence_packets ep WHERE ep.attempt_id = ta.id
    )
  `).get(taskId) as { cnt: number };
  return row.cnt > 0;
}
