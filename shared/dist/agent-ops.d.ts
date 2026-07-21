import type { Database, AgentRow } from './types.js';
export declare function registerAgent(db: Database, agentId: string, paneIndex: number, role?: string): void;
export declare function updateHeartbeat(db: Database, agentId: string, codexSessionId?: string, paneIndex?: number): void;
export declare function getStaleAgents(db: Database, maxAgeSeconds: number): AgentRow[];
export interface ReconciliationResult {
    agent_id: string;
    task_id: string | null;
    attempt_id: string | null;
    action: 'retained' | 'retried' | 'needs_review' | 'inconclusive' | 'shutdown';
    reason: string;
    mutated: boolean;
}
type PaneLiveness = 'alive' | 'shell' | 'dead' | 'unknown';
export declare function reconcileClaim(db: Database, agentId: string, paneLivenessCallback: (paneIndex: number) => PaneLiveness, options?: {
    staleThresholdSeconds?: number;
    dryRun?: boolean;
}): ReconciliationResult;
export declare function recoverDeadClaim(db: Database, agentId: string, staleThresholdSeconds?: number, paneLivenessCallback?: (paneIndex: number) => 'alive' | 'shell' | 'dead' | 'unknown'): string[];
export declare function getActiveAgents(db: Database): AgentRow[];
export declare function getAgent(db: Database, agentId: string): AgentRow | undefined;
/** Look up the active agent occupying a specific tmux pane. Used by reprompt and status tools. */
export declare function getAgentByPaneIndex(db: Database, paneIndex: number): AgentRow | undefined;
export {};
//# sourceMappingURL=agent-ops.d.ts.map