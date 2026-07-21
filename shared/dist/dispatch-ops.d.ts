import type { AttemptAttestationInput, BeginDispatchInput, Database, DispatchReceipt, ExecutionOutcome, TaskAttemptRow, TaskRow } from './types.js';
export declare function toDispatchReceipt(row: TaskAttemptRow): DispatchReceipt;
export declare function getDispatchReceipt(db: Database, attemptId: string): DispatchReceipt;
export declare function beginDispatch(db: Database, input: BeginDispatchInput): {
    task: TaskRow;
    receipt: DispatchReceipt;
};
export declare function attestAttempt(db: Database, attemptId: string, input: AttemptAttestationInput): DispatchReceipt;
export declare function finalizeAttempt(db: Database, attemptId: string, outcome: ExecutionOutcome, reason: string): DispatchReceipt;
//# sourceMappingURL=dispatch-ops.d.ts.map