import type { Database } from './types.js';
export type NextActionKind = 'needs_review' | 'blocker' | 'unblocked' | 'dispatch' | 'all_complete' | 'waiting';
export interface NextAction {
    kind: NextActionKind;
    message: string;
}
interface PaneInfo {
    totalPanes: number;
}
/**
 * Synthesize a single recommended next action from DAG state.
 * Pure domain logic — no adapter concerns (grid state, MCP response formatting).
 */
export declare function getNextAction(db: Database, paneInfo: PaneInfo): NextAction;
export {};
//# sourceMappingURL=next-action.d.ts.map