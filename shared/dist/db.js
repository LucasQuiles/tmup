import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrations.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, '../../config');
export function openDatabase(dbPath) {
    // Ensure parent directory exists with restrictive permissions
    const dir = path.dirname(dbPath);
    const oldUmask = process.umask(0o077);
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    finally {
        process.umask(oldUmask);
    }
    const db = new BetterSqlite3(dbPath);
    // Apply runtime contract pragmas (allowlist-validated)
    const ALLOWED_PRAGMAS = {
        journal_mode: 'string',
        busy_timeout: 'integer',
        foreign_keys: 'integer',
        synchronous: 'integer',
        wal_autocheckpoint: 'integer',
        journal_size_limit: 'integer',
    };
    const contractPath = path.join(CONFIG_DIR, 'runtime-contract.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
    for (const [key, value] of Object.entries(contract)) {
        if (!(key in ALLOWED_PRAGMAS)) {
            throw new Error(`Unknown pragma in runtime-contract.json: ${key}`);
        }
        const expectedType = ALLOWED_PRAGMAS[key];
        if (expectedType === 'integer') {
            const num = Number(value);
            if (!Number.isFinite(num))
                throw new Error(`Invalid pragma value for ${key}: ${value}`);
            db.pragma(`${key} = ${num}`);
        }
        else {
            // String pragmas: only allow alphanumeric + underscore
            const str = String(value);
            if (!/^[a-zA-Z_]+$/.test(str))
                throw new Error(`Invalid pragma value for ${key}: ${value}`);
            db.pragma(`${key} = ${str}`);
        }
    }
    // Apply schema
    const schemaPath = path.join(CONFIG_DIR, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
    // Run pending migrations
    runMigrations(db);
    // Set file permissions (0600)
    try {
        fs.chmodSync(dbPath, 0o600);
    }
    catch (err) {
        console.error(`[tmup] Warning: failed to set DB file permissions on ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return db;
}
export function closeDatabase(db) {
    try {
        // Run final WAL checkpoint before closing
        db.pragma('wal_checkpoint(PASSIVE)');
    }
    catch (err) {
        console.error(`[tmup] Warning: WAL checkpoint failed on close: ${err instanceof Error ? err.message : String(err)}`);
    }
    db.close();
}
//# sourceMappingURL=db.js.map