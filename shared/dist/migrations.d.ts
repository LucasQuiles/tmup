import type { Database } from './types.js';
export interface Migration {
    version: number;
    description: string;
    up: (db: Database) => void;
}
/**
 * Get the current schema version from the database.
 * Returns 0 if the schema_version table doesn't exist (fresh or pre-migration DB).
 */
export declare function getSchemaVersion(db: Database): number;
/**
 * All migrations, ordered by version number.
 * Each migration runs inside an IMMEDIATE transaction.
 */
export declare const migrations: Migration[];
/**
 * Run all pending migrations on the database.
 * Each migration runs in its own IMMEDIATE transaction.
 * Returns the number of migrations applied.
 */
export declare function runMigrations(db: Database): number;
//# sourceMappingURL=migrations.d.ts.map