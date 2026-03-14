import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const CONFIG_SH = path.join(PLUGIN_DIR, 'scripts/lib/config.sh');
const PREREQUISITES_SH = path.join(PLUGIN_DIR, 'scripts/lib/prerequisites.sh');

describe('config.sh shell boundary', () => {
  let tmpHome: string;
  let stateDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-cfg-'));
    stateDir = path.join(tmpHome, '.local/state/tmup');
    configDir = path.join(PLUGIN_DIR, 'config');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true }); } catch {}
  });

  function shellEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      HOME: tmpHome,
      CFG_CONFIG_DIR: configDir,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...overrides,
    };
  }

  function runShell(script: string, overrides: NodeJS.ProcessEnv = {}): string {
    return execFileSync('bash', ['-c', script], {
      env: shellEnv(overrides),
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  }

  describe('session name resolution from current-session', () => {
    it('reads current-session file when TMUP_SESSION_NAME not set', () => {
      fs.writeFileSync(path.join(stateDir, 'current-session'), 'test-abc123');

      const sessionName = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_SESSION_NAME"
      `);

      expect(sessionName).toBe('test-abc123');
    });

    it('rejects current-session content with path traversal', () => {
      // Write malicious session name to current-session
      fs.writeFileSync(path.join(stateDir, 'current-session'), '../escape');

      const result = runShell(`
        source "${CONFIG_SH}"
        if [[ -z "$CFG_SESSION_NAME" ]]; then
          echo "REJECTED"
        elif [[ "$CFG_SESSION_NAME" == "../escape" ]]; then
          echo "UNSAFE"
        else
          echo "OTHER"
        fi
      `);

      expect(result).toBe('REJECTED');
    });

    it('rejects current-session content with slashes', () => {
      fs.writeFileSync(path.join(stateDir, 'current-session'), 'a/b/c');

      const result = runShell(`
        source "${CONFIG_SH}"
        if [[ "$CFG_SESSION_NAME" == "a/b/c" ]]; then
          echo "ACCEPTED_INVALID"
        elif [[ -z "$CFG_SESSION_NAME" ]]; then
          echo "REJECTED"
        else
          echo "UNKNOWN"
        fi
      `);

      // After hardening: CFG_SESSION_NAME should be empty (rejected)
      expect(result).toBe('REJECTED');
    });

    it('TMUP_SESSION_NAME env takes precedence', () => {
      fs.writeFileSync(path.join(stateDir, 'current-session'), 'file-session');

      const sessionName = execFileSync('bash', ['-c', `
        export TMUP_SESSION_NAME="env-session"
        source "${CONFIG_SH}"
        echo "$CFG_SESSION_NAME"
      `], {
        env: shellEnv({ TMUP_SESSION_NAME: 'env-session' }),
        encoding: 'utf-8',
        timeout: 30000,
      }).trim();

      expect(sessionName).toBe('env-session');
    });

    it('validates TMUP_SESSION_NAME env var', () => {
      const result = execFileSync('bash', ['-c', `
        export TMUP_SESSION_NAME="../escape"
        source "${CONFIG_SH}" 2>/dev/null
        if [[ -z "$CFG_SESSION_NAME" ]]; then
          echo "REJECTED"
        elif [[ "$CFG_SESSION_NAME" == "../escape" ]]; then
          echo "UNSAFE"
        else
          echo "OTHER"
        fi
      `], {
        env: shellEnv({ TMUP_SESSION_NAME: '../escape' }),
        encoding: 'utf-8',
        timeout: 30000,
      }).trim();

      expect(result).toBe('REJECTED');
    });
  });

  describe('config degradation detection', () => {
    it('CFG_CONFIG_DEGRADED=0 when yq works', () => {
      // Fake working yq: only success is relevant to the degradation probe.
      const fakeBin = path.join(tmpHome, 'goodbin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), '#!/bin/bash\necho "2"\n');
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);

      const result = runShell(`
        source "${CONFIG_SH}" 2>/dev/null
        echo "$CFG_CONFIG_DEGRADED"
      `, { PATH: `${fakeBin}:/usr/bin:/bin` });
      expect(result).toBe('0');
    });

    it('CFG_CONFIG_DEGRADED=1 when yq is missing and policy.yaml exists', () => {
      // Use a PATH that excludes yq but includes bash basics
      const result = runShell(`
        source "${CONFIG_SH}" 2>/dev/null
        echo "$CFG_CONFIG_DEGRADED"
      `, { PATH: '/usr/bin:/bin' });
      expect(result).toBe('1');
    });

    it('CFG_CONFIG_DEGRADED=1 when yq exists but is broken', () => {
      // Create a fake broken yq
      const fakeBin = path.join(tmpHome, 'fakebin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), '#!/bin/bash\nexit 1\n');
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);

      const result = runShell(`
        source "${CONFIG_SH}" 2>/dev/null
        echo "$CFG_CONFIG_DEGRADED"
      `, { PATH: `${fakeBin}:/usr/bin:/bin` });
      expect(result).toBe('1');
    });

    it('CFG_CONFIG_DEGRADED=0 when policy.yaml does not exist', () => {
      // Point config dir at an empty temp directory (no policy.yaml)
      const emptyConfig = path.join(tmpHome, 'empty-config');
      fs.mkdirSync(emptyConfig, { recursive: true });

      const result = runShell(`
        source "${CONFIG_SH}" 2>/dev/null
        echo "$CFG_CONFIG_DEGRADED"
      `, { CFG_CONFIG_DIR: emptyConfig, PATH: '/usr/bin:/bin' });
      // No policy.yaml → no degradation even without yq
      expect(result).toBe('0');
    });
  });

  describe('preflight yq contract', () => {
    it('check_prerequisites fails when yq is missing and policy.yaml exists', () => {
      // PATH excludes yq; CFG_CONFIG_DIR has policy.yaml
      expect(() => {
        execFileSync('bash', ['-c', `
          export PATH=/usr/bin:/bin
          source "${PREREQUISITES_SH}"
          check_prerequisites
        `], {
          env: shellEnv({ PATH: '/usr/bin:/bin' }),
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }).toThrow();
    });

    it('check_prerequisites error message mentions yq when missing', () => {
      let stderr = '';
      try {
        execFileSync('bash', ['-c', `
          export PATH=/usr/bin:/bin
          source "${PREREQUISITES_SH}"
          check_prerequisites
        `], {
          env: shellEnv({ PATH: '/usr/bin:/bin' }),
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e: any) {
        stderr = e.stderr || '';
      }
      expect(stderr).toContain('yq');
    });

    it('check_prerequisites fails when yq exists but cannot read policy.yaml', () => {
      const fakeBin = path.join(tmpHome, 'broken-yq-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), '#!/bin/bash\nexit 1\n');
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);
      for (const tool of ['node', 'jq']) {
        fs.writeFileSync(path.join(fakeBin, tool), '#!/bin/bash\necho "ok"\n');
        fs.chmodSync(path.join(fakeBin, tool), 0o755);
      }
      fs.writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/bash\nif [[ "$1" == "-V" ]]; then echo "tmux 3.4"; else echo "ok"; fi\n');
      fs.chmodSync(path.join(fakeBin, 'tmux'), 0o755);

      expect(() => {
        execFileSync('bash', ['-c', `
          source "${PREREQUISITES_SH}"
          check_prerequisites
        `], {
          env: shellEnv({ PATH: `${fakeBin}:/usr/bin:/bin` }),
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }).toThrow();
    });

    it('check_prerequisites error message mentions yq when yq is broken', () => {
      const fakeBin = path.join(tmpHome, 'broken-yq-msg-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), '#!/bin/bash\nexit 1\n');
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);
      for (const tool of ['node', 'jq']) {
        fs.writeFileSync(path.join(fakeBin, tool), '#!/bin/bash\necho "ok"\n');
        fs.chmodSync(path.join(fakeBin, tool), 0o755);
      }
      fs.writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/bash\nif [[ "$1" == "-V" ]]; then echo "tmux 3.4"; else echo "ok"; fi\n');
      fs.chmodSync(path.join(fakeBin, 'tmux'), 0o755);

      let stderr = '';
      try {
        execFileSync('bash', ['-c', `
          source "${PREREQUISITES_SH}"
          check_prerequisites
        `], {
          env: shellEnv({ PATH: `${fakeBin}:/usr/bin:/bin` }),
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e: any) {
        stderr = e.stderr || '';
      }
      expect(stderr).toContain('yq');
    });

    it('check_prerequisites passes when yq is present', () => {
      // Create fake yq + tmux + node + jq
      const fakeBin = path.join(tmpHome, 'allbin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), '#!/bin/bash\necho "2"\n');
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);
      for (const tool of ['node', 'jq']) {
        fs.writeFileSync(path.join(fakeBin, tool), '#!/bin/bash\necho "ok"\n');
        fs.chmodSync(path.join(fakeBin, tool), 0o755);
      }
      // tmux needs to report version >= 3.0
      fs.writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/bash\nif [[ "$1" == "-V" ]]; then echo "tmux 3.4"; else echo "ok"; fi\n');
      fs.chmodSync(path.join(fakeBin, 'tmux'), 0o755);

      const result = execFileSync('bash', ['-c', `
        export PATH="${fakeBin}":/usr/bin:/bin
        source "${PREREQUISITES_SH}"
        check_prerequisites && echo "PASS" || echo "FAIL"
      `], {
          env: shellEnv({ PATH: `${fakeBin}:/usr/bin:/bin` }),
          encoding: 'utf-8',
          timeout: 30000,
      }).trim();
      expect(result).toBe('PASS');
    });

    it('check_prerequisites passes without yq when no policy.yaml exists', () => {
      // Empty config dir (no policy.yaml) — yq should not be required
      const emptyConfig = path.join(tmpHome, 'empty-config');
      fs.mkdirSync(emptyConfig, { recursive: true });

      const fakeBin = path.join(tmpHome, 'noyq-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      for (const tool of ['node', 'jq']) {
        fs.writeFileSync(path.join(fakeBin, tool), '#!/bin/bash\necho "ok"\n');
        fs.chmodSync(path.join(fakeBin, tool), 0o755);
      }
      fs.writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/bash\nif [[ "$1" == "-V" ]]; then echo "tmux 3.4"; else echo "ok"; fi\n');
      fs.chmodSync(path.join(fakeBin, 'tmux'), 0o755);

      const result = execFileSync('bash', ['-c', `
        export PATH="${fakeBin}":/usr/bin:/bin
        source "${PREREQUISITES_SH}"
        check_prerequisites && echo "PASS" || echo "FAIL"
      `], {
          env: shellEnv({ CFG_CONFIG_DIR: emptyConfig, PATH: `${fakeBin}:/usr/bin:/bin` }),
          encoding: 'utf-8',
          timeout: 30000,
      }).trim();
      expect(result).toBe('PASS');
    });
  });

  describe('state directory derivation', () => {
    it('CFG_STATE_DIR is derived from validated session name', () => {
      fs.writeFileSync(path.join(stateDir, 'current-session'), 'valid-session');

      const stateResult = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_STATE_DIR"
      `);

      expect(stateResult).toBe(path.join(stateDir, 'valid-session'));
    });

    it('CFG_STATE_DIR is empty when no session', () => {
      // No current-session file and no TMUP_SESSION_NAME
      const stateResult = runShell(`
        unset TMUP_SESSION_NAME
        source "${CONFIG_SH}"
        echo "$CFG_STATE_DIR"
      `);

      expect(stateResult).toBe('');
    });
  });
});
