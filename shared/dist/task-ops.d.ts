import type { Database, CreateTaskInput, UpdateTaskInput, TaskRow, TaskStatus } from './types.js';
export declare function createTask(db: Database, input: CreateTaskInput): string;
export declare function createTaskBatch(db: Database, inputs: CreateTaskInput[]): string[];
/** Get the single active (claimed) task for an agent, or null if none. */
export declare function getActiveTaskForAgent(db: Database, agentId: string): TaskRow | null;
export declare function updateTask(db: Database, taskId: string, updates: UpdateTaskInput): {
    ok: boolean;
    previous_status?: TaskStatus;
};
//# sourceMappingURL=task-ops.d.ts.map