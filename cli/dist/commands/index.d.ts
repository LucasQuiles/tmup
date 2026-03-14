import type { Database } from '@tmup/shared';
interface EnvContext {
    agentId?: string;
    paneIndex?: string;
    sessionName?: string;
    sessionDir?: string;
    taskId?: string;
}
export declare function handleCommand(db: Database, command: string, args: string[], env: EnvContext): Promise<Record<string, unknown>>;
export {};
