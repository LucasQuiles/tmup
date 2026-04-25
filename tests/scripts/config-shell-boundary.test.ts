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
  /** A PATH directory containing essential shell tools but NOT yq. */
  let noYqPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-cfg-'));
    stateDir = path.join(tmpHome, '.local/state/tmup');
    configDir = path.join(PLUGIN_DIR, 'config');
    fs.mkdirSync(stateDir, { recursive: true });

    // Build a sandboxed bin directory with symlinks to essential tools but NOT yq.
    // Tests that need yq-absent behavior can't rely on PATH=/usr/bin:/bin because
    // yq may be installed at /usr/bin/yq via apt on some systems.
    noYqPath = path.join(tmpHome, 'no-yq-bin');
    fs.mkdirSync(noYqPath, { recursive: true });
    const essentials = ['bash', 'cat', 'echo', 'grep', 'sed', 'awk', 'head', 'tail', 'cut', 'tr',
      'sort', 'uniq', 'wc', 'mkdir', 'rm', 'mv', 'cp', 'chmod', 'test', 'env', 'dirname',
      'basename', 'realpath', 'readlink', 'id', 'pwd', 'date', 'mktemp', 'tee', 'true', 'false',
      'printf', 'seq', 'sleep', 'kill', 'flock', 'command'];
    for (const tool of essentials) {
      const resolved = execFileSync('bash', ['-c', `command -v ${tool} 2>/dev/null || true`], {
        encoding: 'utf-8',
      }).trim();
      if (resolved && fs.existsSync(resolved)) {
        try { fs.symlinkSync(resolved, path.join(noYqPath, tool)); } catch {}
      }
    }
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
      // Use a sandboxed PATH that excludes yq but includes bash basics
      const result = runShell(`
        source "${CONFIG_SH}" 2>/dev/null
        echo "$CFG_CONFIG_DEGRADED"
      `, { PATH: noYqPath });
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
      `, { CFG_CONFIG_DIR: emptyConfig, PATH: noYqPath });
      // No policy.yaml → no degradation even without yq
      expect(result).toBe('0');
    });
  });

  describe('preflight yq contract', () => {
    it('check_prerequisites fails when yq is missing and policy.yaml exists', () => {
      // Sandboxed PATH excludes yq; CFG_CONFIG_DIR has policy.yaml
      expect(() => {
        execFileSync('bash', ['-c', `
          source "${PREREQUISITES_SH}"
          check_prerequisites
        `], {
          env: shellEnv({ PATH: noYqPath }),
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
          source "${PREREQUISITES_SH}"
          check_prerequisites
        `], {
          env: shellEnv({ PATH: noYqPath }),
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

  describe('new config values from policy.yaml', () => {
    it('CFG_HEARTBEAT_INTERVAL loads from policy.yaml with correct default', () => {
      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_HEARTBEAT_INTERVAL"
      `);
      expect(result).toBe('60');
    });

    it('CFG_CLAIMED_WARNING loads from policy.yaml with correct default', () => {
      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_CLAIMED_WARNING"
      `);
      expect(result).toBe('1800');
    });

    it('CFG_REPROMPT_TIMEOUT loads from policy.yaml with correct default', () => {
      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_REPROMPT_TIMEOUT"
      `);
      expect(result).toBe('10');
    });

    it('falls back to defaults when policy.yaml is missing', () => {
      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_HEARTBEAT_INTERVAL:$CFG_CLAIMED_WARNING:$CFG_REPROMPT_TIMEOUT"
      `, { CFG_CONFIG_DIR: '/nonexistent/path' });
      expect(result).toBe('60:1800:10');
    });

    it('new config values are exported (available in subshells)', () => {
      const result = runShell(`
        source "${CONFIG_SH}"
        bash -c 'echo "$CFG_HEARTBEAT_INTERVAL:$CFG_CLAIMED_WARNING:$CFG_REPROMPT_TIMEOUT"'
      `);
      expect(result).toBe('60:1800:10');
    });

    it('exports codex worker defaults used by tmup dispatch', () => {
      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_CODEX_MODEL:$CFG_CODEX_CONTEXT_WINDOW:$CFG_CODEX_AUTO_COMPACT:$CFG_CODEX_APPROVAL_POLICY:$CFG_CODEX_SANDBOX:$CFG_CODEX_NO_ALT_SCREEN:$CFG_CODEX_PLAN_FIRST:$CFG_CODEX_REASONING_EFFORT:$CFG_CODEX_REASONING_SUMMARY:$CFG_CODEX_PLAN_REASONING:$CFG_CODEX_VERBOSITY:$CFG_CODEX_SERVICE_TIER:$CFG_CODEX_TOOL_OUTPUT_LIMIT:$CFG_CODEX_WEB_SEARCH:$CFG_CODEX_HISTORY:$CFG_CODEX_UNDO:$CFG_CODEX_SHELL_INHERIT:$CFG_CODEX_SHELL_SNAPSHOT:$CFG_CODEX_REQUEST_COMPRESSION:$CFG_CODEX_NOTIFICATIONS:$CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT:$CFG_CODEX_MAX_THREADS:$CFG_CODEX_MAX_DEPTH:$CFG_CODEX_JOB_TIMEOUT"
      `, { CFG_CONFIG_DIR: '/nonexistent/path' });
      expect(result).toBe('gpt-5.4:1050000:750000:never:danger-full-access:true:true:high:low:xhigh:low:fast:50000:live:save-all:true:all:true:true:true:600000:6:2:3600');
    });

    it('loads codex worker settings from policy.yaml queries', () => {
      const fakeBin = path.join(tmpHome, 'codex-yq-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), `#!/bin/bash
query="$2"
case "$query" in
  '.codex.model // "gpt-5.4"') echo 'gpt-5.4-mini' ;;
  '.codex.context_window // 1050000') echo '777777' ;;
  '.codex.auto_compact_token_limit // 750000') echo '555555' ;;
  '.codex.approval_policy // "never"') echo 'on-request' ;;
  '.codex.sandbox // "danger-full-access"') echo 'workspace-write' ;;
  '.codex.no_alt_screen // true') echo 'false' ;;
  '.codex.plan_first // true') echo 'false' ;;
  '.codex.reasoning_effort // "high"') echo 'xhigh' ;;
  '.codex.reasoning_summary // "low"') echo 'medium' ;;
  '.codex.plan_mode_reasoning_effort // "xhigh"') echo 'high' ;;
  '.codex.verbosity // "low"') echo 'medium' ;;
  '.codex.service_tier // "fast"') echo 'flex' ;;
  '.codex.tool_output_token_limit // 50000') echo '54321' ;;
  '.codex.web_search // "live"') echo 'cached' ;;
  '.codex.history_persistence // "save-all"') echo 'none' ;;
  '.codex.enable_undo // true') echo 'false' ;;
  '.codex.shell_env_inherit // "all"') echo 'core' ;;
  '.codex.shell_snapshot // true') echo 'false' ;;
  '.codex.enable_request_compression // true') echo 'false' ;;
  '.codex.notifications // true') echo 'false' ;;
  '.codex.background_terminal_max_timeout // 600000') echo '420000' ;;
  '.codex.subagents.max_threads // 6') echo '3' ;;
  '.codex.subagents.max_depth // 2') echo '3' ;;
  '.codex.subagents.job_max_runtime_seconds // 3600') echo '2700' ;;
  *) echo 'null' ;;
esac
`);
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);

      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_CODEX_MODEL:$CFG_CODEX_CONTEXT_WINDOW:$CFG_CODEX_AUTO_COMPACT:$CFG_CODEX_APPROVAL_POLICY:$CFG_CODEX_SANDBOX:$CFG_CODEX_NO_ALT_SCREEN:$CFG_CODEX_PLAN_FIRST:$CFG_CODEX_REASONING_EFFORT:$CFG_CODEX_REASONING_SUMMARY:$CFG_CODEX_PLAN_REASONING:$CFG_CODEX_VERBOSITY:$CFG_CODEX_SERVICE_TIER:$CFG_CODEX_TOOL_OUTPUT_LIMIT:$CFG_CODEX_WEB_SEARCH:$CFG_CODEX_HISTORY:$CFG_CODEX_UNDO:$CFG_CODEX_SHELL_INHERIT:$CFG_CODEX_SHELL_SNAPSHOT:$CFG_CODEX_REQUEST_COMPRESSION:$CFG_CODEX_NOTIFICATIONS:$CFG_CODEX_BACKGROUND_TERMINAL_TIMEOUT:$CFG_CODEX_MAX_THREADS:$CFG_CODEX_MAX_DEPTH:$CFG_CODEX_JOB_TIMEOUT"
      `, { PATH: `${fakeBin}:/usr/bin:/bin` });
      expect(result).toBe('gpt-5.4-mini:777777:555555:on-request:workspace-write:false:false:xhigh:medium:high:medium:flex:54321:cached:none:false:core:false:false:false:420000:3:3:2700');
    });

    it('repairs invalid codex compaction thresholds and caps subagent fanout', () => {
      const fakeBin = path.join(tmpHome, 'codex-yq-cap-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'yq'), `#!/bin/bash
query="$2"
case "$query" in
  '.codex.model // "gpt-5.4"') echo 'gpt-5.4' ;;
  '.codex.context_window // 1050000') echo '600000' ;;
  '.codex.auto_compact_token_limit // 750000') echo '900000' ;;
  '.codex.approval_policy // "never"') echo 'never' ;;
  '.codex.sandbox // "danger-full-access"') echo 'danger-full-access' ;;
  '.codex.no_alt_screen // true') echo 'true' ;;
  '.codex.plan_first // true') echo 'true' ;;
  '.codex.reasoning_effort // "high"') echo 'high' ;;
  '.codex.reasoning_summary // "low"') echo 'high' ;;
  '.codex.plan_mode_reasoning_effort // "xhigh"') echo 'xhigh' ;;
  '.codex.verbosity // "low"') echo 'low' ;;
  '.codex.service_tier // "fast"') echo 'fast' ;;
  '.codex.tool_output_token_limit // 50000') echo '999999' ;;
  '.codex.web_search // "live"') echo 'live' ;;
  '.codex.history_persistence // "save-all"') echo 'save-all' ;;
  '.codex.enable_undo // true') echo 'true' ;;
  '.codex.shell_env_inherit // "all"') echo 'all' ;;
  '.codex.shell_snapshot // true') echo 'true' ;;
  '.codex.enable_request_compression // true') echo 'true' ;;
  '.codex.notifications // true') echo 'true' ;;
  '.codex.background_terminal_max_timeout // 600000') echo '600000' ;;
  '.codex.subagents.max_threads // 6') echo '99' ;;
  '.codex.subagents.max_depth // 2') echo '9' ;;
  '.codex.subagents.job_max_runtime_seconds // 3600') echo '99999' ;;
  *) echo 'null' ;;
esac
`);
      fs.chmodSync(path.join(fakeBin, 'yq'), 0o755);

      const result = runShell(`
        source "${CONFIG_SH}"
        echo "$CFG_CODEX_CONTEXT_WINDOW:$CFG_CODEX_AUTO_COMPACT:$CFG_CODEX_TOOL_OUTPUT_LIMIT:$CFG_CODEX_MAX_THREADS:$CFG_CODEX_MAX_DEPTH:$CFG_CODEX_JOB_TIMEOUT"
      `, { PATH: `${fakeBin}:/usr/bin:/bin` });

      expect(result).toBe('600000:599999:200000:12:3:7200');
    });
  });
});
