import crypto from 'node:crypto';
export function nextTaskId(db) {
    const row = db.prepare('SELECT MAX(CAST(id AS INTEGER)) as max_id FROM tasks').get();
    const next = (row?.max_id ?? 0) + 1;
    return String(next).padStart(3, '0');
}
export function generateAgentId() {
    return crypto.randomUUID();
}
export function generateMessageId() {
    return crypto.randomUUID();
}
export function generateArtifactId() {
    return crypto.randomUUID();
}
//# sourceMappingURL=id.js.map