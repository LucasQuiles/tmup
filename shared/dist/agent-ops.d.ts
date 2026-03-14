import type { Database, AgentRow } from './types.js';
export declare function registerAgent(db: Database, agentId: string, paneIndex: number, role?: string): void;
export declare function updateHeartbeat(db: Database, agentId: string, codexSessionId?: string): void;
export declare function getStaleAgents(db: Database, maxAgeSeconds: number): AgentRow[];
export declare function recoverDeadClaim(db: Database, agentId: string, staleThresholdSeconds?: number): string[];
export declare function getActiveAgents(db: Database): AgentRow[];
export declare function getAgent(db: Database, agentId: string): AgentRow | undefined;
//# sourceMappingURL=agent-ops.d.ts.map