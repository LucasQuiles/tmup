#!/usr/bin/env node
import type { Database } from '@tmup/shared';
export declare function getDb(): Database | null;
export declare function ensureDb(): Database;
export declare function switchSession(sessionId: string, dbPath: string): void;
export declare function getCurrentSessionId(): string | null;
