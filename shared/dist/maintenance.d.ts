import type { Database } from './types.js';
export interface MaintenanceResult {
    eventsPruned: number;
    messagesPruned: number;
    walCheckpoint: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Run all maintenance operations in one exportable call.
 * Each operation runs independently — failures are collected, not thrown.
 * Returns a structured result for logging/observability.
 */
export declare function runMaintenance(db: Database, eventMaxAgeSeconds?: number): MaintenanceResult;
//# sourceMappingURL=maintenance.d.ts.map