import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, closeDatabase } from './db.js';
function getStateRoot() {
    const home = process.env.HOME;
    if (!home) {
        throw new Error('HOME environment variable is not set — cannot determine state directory');
    }
    return path.join(home, '.local/state/tmup');
}
const STATE_ROOT = getStateRoot();
const REGISTRY_PATH = path.join(STATE_ROOT, 'registry.json');
const REGISTRY_LOCK = path.join(STATE_ROOT, 'registry.lock');
const CURRENT_SESSION_PATH = path.join(STATE_ROOT, 'current-session');
/** Session name/ID validation: alphanumeric, hyphen, underscore only. No path separators, no null bytes. */
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,71}$/; // prefix(64) + dash + hex(6) = 71 max
export function validateSessionName(name) {
    if (!SESSION_NAME_RE.test(name)) {
        throw new Error('Session name must be 1-64 alphanumeric, hyphen, or underscore characters');
    }
}
export function isValidSessionId(id) {
    return SESSION_ID_RE.test(id) && !id.includes('/') && !id.includes('\\') && !id.includes('\0');
}
/** Canonicalize a project directory to its realpath. Falls back to path.resolve() only for ENOENT; other errors propagate. */
function canonicalizeProjectDir(dir) {
    try {
        return fs.realpathSync(dir);
    }
    catch (err) {
        const code = err.code;
        if (code !== 'ENOENT') {
            // Permission errors, symlink loops, etc. should not be masked
            throw err;
        }
        // Non-existent dir: resolve the path as best we can
        const resolved = path.resolve(dir);
        if (resolved.includes('\0')) {
            throw new Error('Project directory path contains null bytes');
        }
        return resolved;
    }
}
function ensureStateRoot() {
    const oldUmask = process.umask(0o077);
    try {
        fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
    }
    finally {
        process.umask(oldUmask);
    }
}
export function readRegistry() {
    ensureStateRoot();
    if (!fs.existsSync(REGISTRY_PATH)) {
        return { sessions: {} };
    }
    let content;
    try {
        content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    }
    catch (err) {
        // I/O errors (EACCES, ENOSPC, etc.) should propagate — only missing file is normal
        const code = err.code;
        if (code === 'ENOENT')
            return { sessions: {} };
        throw err;
    }
    // Step 1: Parse JSON — backup and return empty on parse failure (genuine corruption)
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch (err) {
        const backupPath = REGISTRY_PATH + '.corrupt.' + Date.now();
        try {
            fs.copyFileSync(REGISTRY_PATH, backupPath);
            console.error(`[tmup] Warning: registry.json corrupted — backed up to ${backupPath}:`, err instanceof Error ? err.message : String(err));
        }
        catch (backupErr) {
            console.error('[tmup] Warning: registry.json corrupted AND backup failed:', err instanceof Error ? err.message : String(err), '| backup error:', backupErr instanceof Error ? backupErr.message : String(backupErr));
        }
        return { sessions: {} };
    }
    // Step 2: Structural validation — wrong shape is a hard error, not silent corruption recovery
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof parsed.sessions !== 'object' ||
        parsed.sessions === null ||
        Array.isArray(parsed.sessions)) {
        console.error('[tmup] Warning: registry.json has wrong structure (missing or invalid "sessions" object) — treating as empty');
        return { sessions: {} };
    }
    // Step 3: Validate individual entries — skip malformed ones to be resilient
    const validated = {};
    for (const [key, entry] of Object.entries(parsed.sessions)) {
        const e = entry;
        if (e && typeof e === 'object' && typeof e.db_path === 'string' && e.db_path) {
            validated[key] = e;
        }
        else {
            console.error(`[tmup] Warning: skipping malformed registry entry '${key}': missing or invalid db_path`);
        }
    }
    return { sessions: validated };
}
function writeRegistry(registry) {
    ensureStateRoot();
    const tmp = REGISTRY_PATH + '.tmp.' + process.pid;
    try {
        fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, REGISTRY_PATH);
    }
    catch (err) {
        // Clean up temp file on failure to prevent accumulation
        try {
            fs.unlinkSync(tmp);
        }
        catch (cleanupErr) {
            console.error(`[tmup] Warning: failed to clean up temp file ${tmp}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
        throw err;
    }
}
const LOCK_STALE_MS = 10_000;
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // ESRCH = no such process (dead). EPERM = exists but no permission (alive).
        if (err.code === 'ESRCH')
            return false;
        return true; // Treat permission errors and unknowns as alive (fail closed)
    }
}
function acquireLock() {
    ensureStateRoot();
    let lastProbeError;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            fs.writeFileSync(REGISTRY_LOCK, String(process.pid), { flag: 'wx' });
            return;
        }
        catch (err) {
            const code = err.code;
            if (code !== 'EEXIST') {
                // Unexpected filesystem error (EACCES, ENOSPC, etc.) — fail immediately
                throw new Error(`Failed to create registry lock: ${code ?? (err instanceof Error ? err.message : String(err))}`);
            }
            // Lock exists — check staleness by PID liveness and mtime
            try {
                const content = fs.readFileSync(REGISTRY_LOCK, 'utf-8').trim();
                const lockPid = parseInt(content, 10);
                const stat = fs.statSync(REGISTRY_LOCK);
                const isStale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
                const isDeadPid = !isNaN(lockPid) && lockPid > 0 && !isPidAlive(lockPid);
                if (isStale || isDeadPid) {
                    fs.unlinkSync(REGISTRY_LOCK);
                    continue;
                }
            }
            catch (probeErr) {
                const probeCode = probeErr.code;
                if (probeCode === 'ENOENT') {
                    // Lock was released between our check — retry
                    continue;
                }
                // Unexpected probe error — log and retry, but track for final error message
                lastProbeError = probeCode ?? (probeErr instanceof Error ? probeErr.message : String(probeErr));
                console.error(`[tmup] Lock probe error (attempt ${attempt}): ${lastProbeError}`);
                continue;
            }
            // Wait briefly then retry
            const waitMs = 10 + Math.random() * 40;
            const end = Date.now() + waitMs;
            while (Date.now() < end) { /* busy wait */ }
        }
    }
    const detail = lastProbeError ? ` (last probe error: ${lastProbeError})` : '';
    throw new Error(`Failed to acquire registry lock after 50 attempts${detail}`);
}
function releaseLock() {
    try {
        const content = fs.readFileSync(REGISTRY_LOCK, 'utf-8').trim();
        if (content === String(process.pid)) {
            fs.unlinkSync(REGISTRY_LOCK);
        }
    }
    catch (err) {
        const code = err.code;
        if (code !== 'ENOENT') {
            // Unexpected error releasing lock — log so orphaned locks are diagnosable
            console.error(`[tmup] Lock release error: ${code ?? (err instanceof Error ? err.message : String(err))}`);
        }
    }
}
export function initSession(projectDir, sessionName) {
    // Canonicalize project_dir before any comparison or storage
    const canonicalDir = canonicalizeProjectDir(projectDir);
    acquireLock();
    try {
        const registry = readRegistry();
        // Check if session already exists for this project (using canonical path)
        for (const [id, entry] of Object.entries(registry.sessions)) {
            if (entry.project_dir === canonicalDir) {
                // Reattach
                setCurrentSession(id);
                return { session_id: id, db_path: entry.db_path, reattached: true };
            }
        }
        // Generate new session ID
        const prefix = sessionName ?? 'tmup';
        validateSessionName(prefix);
        const hex = crypto.randomBytes(3).toString('hex');
        const sessionId = `${prefix}-${hex}`;
        // Create session directory
        const sessionDir = path.join(STATE_ROOT, sessionId);
        const oldUmask = process.umask(0o077);
        try {
            fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
            fs.mkdirSync(path.join(sessionDir, 'grid'), { recursive: true, mode: 0o700 });
        }
        finally {
            process.umask(oldUmask);
        }
        const dbPath = path.join(sessionDir, 'tmup.db');
        // Initialize database (opens, applies schema, closes)
        const db = openDatabase(dbPath);
        closeDatabase(db);
        // Register session with canonical project_dir
        const entry = {
            session_id: sessionId,
            project_dir: canonicalDir,
            db_path: dbPath,
            created_at: new Date().toISOString(),
        };
        registry.sessions[sessionId] = entry;
        writeRegistry(registry);
        // Set as current
        setCurrentSession(sessionId);
        return { session_id: sessionId, db_path: dbPath, reattached: false };
    }
    finally {
        releaseLock();
    }
}
export function setCurrentSession(sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`Invalid session ID: must match ${SESSION_ID_RE} with no path separators`);
    }
    // Verify session exists in registry to prevent orphaned pointers
    const registry = readRegistry();
    if (!registry.sessions[sessionId]) {
        throw new Error(`Cannot set current session to '${sessionId}': not found in registry`);
    }
    ensureStateRoot();
    // Use temp+rename to ensure mode 0o600 is applied even on overwrite
    // (writeFileSync mode is only applied on file creation, not overwrite)
    const tmp = CURRENT_SESSION_PATH + '.tmp.' + process.pid;
    try {
        fs.writeFileSync(tmp, sessionId, { mode: 0o600 });
        fs.renameSync(tmp, CURRENT_SESSION_PATH);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch (cleanupErr) {
            console.error(`[tmup] Warning: failed to clean up temp file ${tmp}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
        throw err;
    }
}
export function getCurrentSession() {
    try {
        const id = fs.readFileSync(CURRENT_SESSION_PATH, 'utf-8').trim();
        if (!id)
            return null;
        // Validate stored session ID before returning
        if (!isValidSessionId(id)) {
            console.error(`[tmup] Warning: current-session file contains invalid session ID: ${JSON.stringify(id)}`);
            return null;
        }
        return id;
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return null;
        // Unexpected read error (EACCES, EIO, etc.) — propagate so callers don't silently operate sessionless
        throw err;
    }
}
export function removeFromRegistry(sessionId) {
    acquireLock();
    try {
        const registry = readRegistry();
        delete registry.sessions[sessionId];
        writeRegistry(registry);
    }
    finally {
        releaseLock();
    }
}
export function getSessionDbPath(sessionId) {
    const id = sessionId ?? getCurrentSession();
    if (!id)
        return null;
    const registry = readRegistry();
    return registry.sessions[id]?.db_path ?? null;
}
export function getSessionDir(sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`Invalid session ID: ${JSON.stringify(sessionId)}`);
    }
    return path.join(STATE_ROOT, sessionId);
}
export function getSessionProjectDir(sessionId) {
    const id = sessionId ?? getCurrentSession();
    if (!id)
        return null;
    const registry = readRegistry();
    return registry.sessions[id]?.project_dir ?? null;
}
//# sourceMappingURL=session-ops.js.map