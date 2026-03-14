import type { Database, CreateMessageInput, MessageRow } from './types.js';
export declare function sendMessage(db: Database, input: CreateMessageInput): string;
export declare function getInbox(db: Database, agentId: string, markRead?: boolean): MessageRow[];
export declare function getUnreadCount(db: Database, agentId: string): number;
export declare function postCheckpoint(db: Database, taskId: string, agentId: string, message: string): void;
export declare const MESSAGE_PRUNE_BATCH_SIZE = 500;
/**
 * Prune old messages in bounded batches:
 * - Read direct messages older than max age
 * - Expired broadcasts older than max age
 * Returns the number of pruned rows.
 */
export declare function pruneMessages(db: Database, maxAgeSeconds?: number): number;
//# sourceMappingURL=message-ops.d.ts.map