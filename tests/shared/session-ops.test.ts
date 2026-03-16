import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// session-ops uses process.env.HOME for STATE_ROOT, so we can test registry logic
// by importing the functions directly. The lock and registry tests use real filesystem.
import {
  readRegistry, initSession, getCurrentSession,
  setCurrentSession, removeFromRegistry, getSessionDbPath, getSessionDir,
  getSessionProjectDir,
} from '../../shared/src/session-ops.js';

describe('session-ops', () => {
  const STATE_ROOT = path.join(process.env.HOME ?? '/tmp', '.local/state/tmup');
  const REGISTRY_PATH = path.join(STATE_ROOT, 'registry.json');
  const CURRENT_SESSION_PATH = path.join(STATE_ROOT, 'current-session');
  let originalRegistry: string | null = null;
  let originalCurrentSession: string | null = null;
  let createdSessionIds: string[] = [];

  beforeEach(() => {
    // Save originals
    try { originalRegistry = fs.readFileSync(REGISTRY_PATH, 'utf-8'); } catch { originalRegistry = null; }
    try { originalCurrentSession = fs.readFileSync(CURRENT_SESSION_PATH, 'utf-8'); } catch { originalCurrentSession = null; }
    createdSessionIds = [];
  });

  afterEach(() => {
    // Restore originals
    if (originalRegistry !== null) {
      fs.writeFileSync(REGISTRY_PATH, originalRegistry);
    } else {
      try { fs.unlinkSync(REGISTRY_PATH); } catch {}
    }
    if (originalCurrentSession !== null) {
      fs.writeFileSync(CURRENT_SESSION_PATH, originalCurrentSession);
    } else {
      try { fs.unlinkSync(CURRENT_SESSION_PATH); } catch {}
    }
    // Clean up session dirs
    for (const id of createdSessionIds) {
      const dir = path.join(STATE_ROOT, id);
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
  });

  it('readRegistry returns empty sessions when no file', () => {
    try { fs.unlinkSync(REGISTRY_PATH); } catch {}
    const reg = readRegistry();
    expect(reg.sessions).toBeDefined();
    expect(Object.keys(reg.sessions)).toHaveLength(0);
  });

  it('initSession creates a new session', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
    try {
      const result = initSession(tmpProject, 'test');
      createdSessionIds.push(result.session_id);
      expect(result.session_id).toMatch(/^test-/);
      expect(result.reattached).toBe(false);
      expect(fs.existsSync(result.db_path)).toBe(true);
    } finally {
      try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
    }
  });

  it('initSession reattaches to existing session for same project', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
    try {
      const result1 = initSession(tmpProject, 'test');
      createdSessionIds.push(result1.session_id);
      const result2 = initSession(tmpProject, 'test');
      expect(result2.session_id).toBe(result1.session_id);
      expect(result2.reattached).toBe(true);
    } finally {
      try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
    }
  });

  it('setCurrentSession and getCurrentSession round-trip', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
    try {
      const result = initSession(tmpProject, 'test');
      createdSessionIds.push(result.session_id);
      // initSession already sets current — change to a different valid session and verify round-trip
      setCurrentSession(result.session_id);
      expect(getCurrentSession()).toBe(result.session_id);
    } finally {
      try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
    }
  });

  it('setCurrentSession rejects session not in registry', () => {
    expect(() => setCurrentSession('test-abc123')).toThrow('not found in registry');
  });

  it('removeFromRegistry removes a session', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
    try {
      const result = initSession(tmpProject, 'test');
      createdSessionIds.push(result.session_id);
      removeFromRegistry(result.session_id);
      const reg = readRegistry();
      expect(reg.sessions[result.session_id]).toBeUndefined();
    } finally {
      try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
    }
  });

  it('getSessionDbPath returns path for known session', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
    try {
      const result = initSession(tmpProject, 'test');
      createdSessionIds.push(result.session_id);
      expect(getSessionDbPath(result.session_id)).toBe(result.db_path);
    } finally {
      try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
    }
  });

  it('getSessionDbPath returns null for unknown session', () => {
    expect(getSessionDbPath('nonexistent-session')).toBeNull();
  });

  it('getSessionDir returns expected path', () => {
    const dir = getSessionDir('test-abc');
    expect(dir).toBe(path.join(STATE_ROOT, 'test-abc'));
  });

  it('getSessionDir rejects path-traversal session IDs', () => {
    expect(() => getSessionDir('../escape')).toThrow('Invalid session ID');
    expect(() => getSessionDir('a/b')).toThrow('Invalid session ID');
    expect(() => getSessionDir('')).toThrow('Invalid session ID');
    expect(() => getSessionDir('a'.repeat(100))).toThrow('Invalid session ID');
  });

  // --- Phase 1, Task 1.1: Session-registry hardening regression tests ---

  describe('session name validation', () => {
    it('rejects session names with path traversal characters', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      try {
        expect(() => initSession(tmpProject, '../escape')).toThrow();
        expect(() => initSession(tmpProject, 'a/b')).toThrow();
        expect(() => initSession(tmpProject, 'a\\b')).toThrow();
      } finally {
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });

    it('rejects session names with null bytes', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      try {
        expect(() => initSession(tmpProject, 'test\0evil')).toThrow();
      } finally {
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });

    it('rejects empty session name', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      try {
        expect(() => initSession(tmpProject, '')).toThrow();
      } finally {
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });

    it('rejects session names longer than 64 characters', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      try {
        expect(() => initSession(tmpProject, 'a'.repeat(65))).toThrow();
      } finally {
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });
  });

  describe('current-session validation', () => {
    it('getCurrentSession rejects malformed content with path separators', () => {
      fs.writeFileSync(CURRENT_SESSION_PATH, '../escape-session');
      const result = getCurrentSession();
      // Should return null for malformed session IDs, not the raw content
      expect(result).toBeNull();
    });

    it('getCurrentSession rejects content with null bytes', () => {
      fs.writeFileSync(CURRENT_SESSION_PATH, 'test\0evil');
      expect(getCurrentSession()).toBeNull();
    });

    it('getCurrentSession rejects whitespace-only content', () => {
      fs.writeFileSync(CURRENT_SESSION_PATH, '   \n  ');
      expect(getCurrentSession()).toBeNull();
    });

    it('getCurrentSession propagates non-ENOENT errors instead of silently returning null', () => {
      // Make the file unreadable to trigger EACCES
      fs.writeFileSync(CURRENT_SESSION_PATH, 'test-valid');
      fs.chmodSync(CURRENT_SESSION_PATH, 0o000);

      try {
        expect(() => getCurrentSession()).toThrow();
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(CURRENT_SESSION_PATH, 0o644);
      }
    });
  });

  describe('canonical project path reattach', () => {
    it('reattaches when project_dir is accessed via symlink', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      const symlink = tmpProject + '-link';
      try {
        fs.symlinkSync(tmpProject, symlink);
        const result1 = initSession(tmpProject, 'test');
        createdSessionIds.push(result1.session_id);
        // Access via symlink should reattach to same session
        const result2 = initSession(symlink, 'test');
        expect(result2.session_id).toBe(result1.session_id);
        expect(result2.reattached).toBe(true);
      } finally {
        try { fs.unlinkSync(symlink); } catch {}
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });

    it('stores canonical (realpath) project_dir in registry', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      const symlink = tmpProject + '-link';
      try {
        fs.symlinkSync(tmpProject, symlink);
        const result = initSession(symlink, 'test');
        createdSessionIds.push(result.session_id);
        // Registry should store the real path, not the symlink
        const projectDir = getSessionProjectDir(result.session_id);
        expect(projectDir).toBe(fs.realpathSync(tmpProject));
      } finally {
        try { fs.unlinkSync(symlink); } catch {}
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });
  });

  describe('registry entry shape', () => {
    it('registry entries always contain db_path', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      try {
        const result = initSession(tmpProject, 'test');
        createdSessionIds.push(result.session_id);
        const registry = readRegistry();
        const entry = registry.sessions[result.session_id];
        expect(entry).toBeDefined();
        expect(entry.db_path).toBeDefined();
        expect(typeof entry.db_path).toBe('string');
        expect(entry.db_path.length).toBeGreaterThan(0);
        expect(entry.session_id).toBe(result.session_id);
        expect(entry.project_dir).toBeDefined();
        expect(entry.created_at).toBeDefined();
      } finally {
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });
  });

  describe('registry corruption recovery', () => {
    // Clean preexisting corrupt backups before each test so assertions are deterministic
    function cleanCorruptBackups(): void {
      try {
        const files = fs.readdirSync(STATE_ROOT).filter(f => f.startsWith('registry.json.corrupt.'));
        for (const f of files) {
          try { fs.unlinkSync(path.join(STATE_ROOT, f)); } catch {}
        }
      } catch {}
    }

    it('readRegistry backs up corrupted registry and returns empty', () => {
      cleanCorruptBackups();
      // Write corrupted JSON to registry
      fs.writeFileSync(REGISTRY_PATH, '{this is not valid json!!!');

      const reg = readRegistry();
      expect(reg.sessions).toBeDefined();
      expect(Object.keys(reg.sessions).length).toBe(0);

      // Verify exactly one new backup was created
      const backups = fs.readdirSync(STATE_ROOT).filter(f => f.startsWith('registry.json.corrupt.'));
      expect(backups.length).toBe(1);

      // Clean up backup files
      for (const backup of backups) {
        try { fs.unlinkSync(path.join(STATE_ROOT, backup)); } catch {}
      }
    });

    it('readRegistry rejects valid JSON with wrong structure without creating backup', () => {
      cleanCorruptBackups();
      // Write valid JSON but missing 'sessions' object — structural validation, NOT corruption
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ foo: 'bar' }));

      const reg = readRegistry();
      expect(reg.sessions).toBeDefined();
      expect(Object.keys(reg.sessions).length).toBe(0);

      // Structural failures should NOT create backup files (only JSON parse failures do)
      const backups = fs.readdirSync(STATE_ROOT).filter(f => f.startsWith('registry.json.corrupt.'));
      expect(backups.length).toBe(0);
    });

    it('readRegistry rejects sessions as non-object without creating backup', () => {
      cleanCorruptBackups();
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ sessions: 'not-an-object' }));

      const reg = readRegistry();
      expect(reg.sessions).toBeDefined();
      expect(Object.keys(reg.sessions).length).toBe(0);

      // Structural failures should NOT create backup files
      const backups = fs.readdirSync(STATE_ROOT).filter(f => f.startsWith('registry.json.corrupt.'));
      expect(backups.length).toBe(0);
    });

    it('readRegistry rejects sessions as Array without creating backup', () => {
      cleanCorruptBackups();
      // Array passes typeof === 'object' but should be rejected
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ sessions: [{ db_path: '/tmp/evil.db' }] }));

      const reg = readRegistry();
      expect(reg.sessions).toBeDefined();
      expect(Object.keys(reg.sessions).length).toBe(0);

      const backups = fs.readdirSync(STATE_ROOT).filter(f => f.startsWith('registry.json.corrupt.'));
      expect(backups.length).toBe(0);
    });

    it('readRegistry rejects top-level Array without creating backup', () => {
      cleanCorruptBackups();
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify([{ sessions: {} }]));

      const reg = readRegistry();
      expect(reg.sessions).toBeDefined();
      expect(Object.keys(reg.sessions).length).toBe(0);

      const backups = fs.readdirSync(STATE_ROOT).filter(f => f.startsWith('registry.json.corrupt.'));
      expect(backups.length).toBe(0);
    });
  });

  describe('setCurrentSession validation', () => {
    it('rejects session IDs with path traversal', () => {
      expect(() => setCurrentSession('../escape')).toThrow();
      expect(() => setCurrentSession('a/b')).toThrow();
    });

    it('rejects empty session ID', () => {
      expect(() => setCurrentSession('')).toThrow();
    });

    it('writes current-session file with restrictive permissions (0o600)', () => {
      const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sess-'));
      try {
        const result = initSession(tmpProject, 'test');
        createdSessionIds.push(result.session_id);
        setCurrentSession(result.session_id);

        const stat = fs.statSync(CURRENT_SESSION_PATH);
        // 0o600 = owner read+write only (0o100600 includes file type bits)
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        try { fs.rmSync(tmpProject, { recursive: true }); } catch {}
      }
    });
  });
});
