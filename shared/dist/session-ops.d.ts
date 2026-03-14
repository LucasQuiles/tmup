import type { SessionRegistry } from './types.js';
export declare function validateSessionName(name: string): void;
export declare function isValidSessionId(id: string): boolean;
export declare function readRegistry(): SessionRegistry;
export declare function initSession(projectDir: string, sessionName?: string): {
    session_id: string;
    db_path: string;
    reattached: boolean;
};
export declare function setCurrentSession(sessionId: string): void;
export declare function getCurrentSession(): string | null;
export declare function removeFromRegistry(sessionId: string): void;
export declare function getSessionDbPath(sessionId?: string): string | null;
export declare function getSessionDir(sessionId: string): string;
export declare function getSessionProjectDir(sessionId?: string): string | null;
//# sourceMappingURL=session-ops.d.ts.map