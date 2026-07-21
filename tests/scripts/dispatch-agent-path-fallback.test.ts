import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh CODEX_BIN fallback', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let fakeBin: string;
  let workingDir: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-path-')));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');
    workingDir = path.join(tmpHome, 'workspace');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );
    fs.writeFileSync(path.join(stateDir, 'tmup.db'), '');

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  list-panes)
    [[ "$*" == *'-s -t =test-session'* ]] || exit 1
    printf '1 %%1\\n'
    ;;
  display-message)
    if [[ "$*" == *'pane_pid'* ]]; then
      printf '100\\n'
    else
      printf 'bash\\n'
    fi
    ;;
  send-keys)
    ;;
  capture-pane)
    count_file="$HOME/.tmup-test-capture-count"
    count=0
    [[ ! -f "$count_file" ]] || count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    printf 'Working (fake-%s)\\n' "$count"
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "\${1:-}" >&2
    exit 1
    ;;
esac
`);

    writeExecutable('ps', `#!/bin/bash
printf '100 1 100 100 S /bin/bash\\n'
`);

    writeExecutable('sleep', `#!/bin/bash
exit 0
`);

    writeExecutable('flock', `#!/bin/bash
exit 0
`);

    writeExecutable('yq', `#!/bin/bash
printf 'null\\n'
`);

    for (const commandName of [
      'awk',
      'cat',
      'chmod',
      'dirname',
      'grep',
      'jq',
      'mkdir',
      'mktemp',
      'mv',
      'perl',
      'rm',
      'sed',
      'shasum',
      'stat',
      'touch',
    ]) {
      linkSystemBinary(commandName);
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('prefers codex resolved from PATH when CODEX_BIN is unset', () => {
    const pathCodex = path.join(fakeBin, 'codex');
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-path');

    expect(readLauncher()).toContain(`export CODEX_BIN=${pathCodex}`);
  });

  it('emits one complete dispatch selector receipt before returning success', () => {
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    const output = runDispatch('agent-receipt');

    for (const line of [
      'TMUP_DISPATCH_SELECTOR=tmup-policy',
      'TMUP_DISPATCH_REQUESTED_MODEL=auto',
      'TMUP_DISPATCH_OBSERVED_MODEL=unknown',
      'TMUP_DISPATCH_FALLBACK_USED=unknown',
    ]) {
      expect(output.split('\n').filter((candidate) => candidate === line)).toHaveLength(1);
    }
  });

  it('falls back to an executable $HOME/.local/bin/codex when PATH lookup fails', () => {
    const homeCodexDir = path.join(tmpHome, '.local/bin');
    fs.mkdirSync(homeCodexDir, { recursive: true });
    fs.writeFileSync(path.join(homeCodexDir, 'codex'), '#!/bin/bash\nexit 0\n');
    fs.chmodSync(path.join(homeCodexDir, 'codex'), 0o755);

    runDispatch('agent-home-fallback');

    expect(readLauncher()).toContain(
      `export CODEX_BIN=${path.join(tmpHome, '.local/bin/codex')}`
    );
  });

  it('prefers the executable local-bin install over an older PATH result', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const homeCodexDir = path.join(tmpHome, '.local/bin');
    fs.mkdirSync(homeCodexDir, { recursive: true });
    fs.writeFileSync(path.join(homeCodexDir, 'codex'), '#!/bin/bash\nexit 0\n');
    fs.chmodSync(path.join(homeCodexDir, 'codex'), 0o755);

    runDispatch('agent-local-preferred');

    expect(readLauncher()).toContain(`export CODEX_BIN=${path.join(homeCodexDir, 'codex')}`);
  });

  it('rejects a missing explicit executable before creating artifacts or mutating the pane', () => {
    expect(() => runDispatch('agent-missing-codex', {
      codexBin: path.join(tmpHome, 'missing-codex'),
    })).toThrowError(/Codex executable/i);

    expect(fs.readdirSync(stateDir).some((entry) => /^(?:prompt|launcher|task-tmp)-/.test(entry))).toBe(false);
    expect(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8')).toContain(
      '"status": "available"',
    );
  });

  it('rejects a relative explicit CODEX_BIN before creating dispatch artifacts', () => {
    expect(() => runDispatch('agent-relative-codex', { codexBin: './codex' })).toThrowError(
      /absolute.*Codex executable/i,
    );
    expect(fs.readdirSync(stateDir).some((entry) => /^(?:prompt|launcher|task-tmp)-/.test(entry))).toBe(false);
  });

  it('resolves the final Codex symlink and rejects a target inside the worker root', () => {
    const workspaceCodex = path.join(workingDir, 'workspace-codex');
    fs.writeFileSync(workspaceCodex, '#!/bin/bash\nexit 0\n');
    fs.chmodSync(workspaceCodex, 0o755);
    fs.symlinkSync(workspaceCodex, path.join(fakeBin, 'codex'));

    expect(() => runDispatch('agent-workspace-codex')).toThrowError(
      /Codex executable is inside the worker-writable root/i,
    );
  });

  it.each([
    '--dangerously-bypass-approvals-and-sandbox',
    'contains whitespace',
    'nested/session',
  ])('rejects option-unsafe resume session ID %j', (resumeSessionId) => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');

    expect(() => runDispatch('agent-invalid-resume', { resumeSessionId })).toThrowError(
      /Invalid --resume-session-id/i,
    );
  });

  it('rejects hard-linked DB and grid-state inodes before dispatch', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const dbAlias = path.join(workingDir, 'db-alias');
    fs.linkSync(path.join(stateDir, 'tmup.db'), dbAlias);
    expect(() => runDispatch('agent-hardlink-db')).toThrowError(/database.*single-link|single-link.*database/i);
    fs.unlinkSync(dbAlias);

    const gridAlias = path.join(workingDir, 'grid-alias');
    fs.linkSync(path.join(gridDir, 'grid-state.json'), gridAlias);
    expect(() => runDispatch('agent-hardlink-grid')).toThrowError(/grid state.*single-link|single-link.*grid state/i);
  });

  it('ignores failed BSD stat probe output before using the GNU fallback', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    writeExecutable('stat', `#!/bin/bash
if [[ "\${1:-}" == '-f' ]]; then
  printf 'partial filesystem report\\n'
  exit 1
fi
case "\${1:-}:\${2:-}" in
  '-c:%h') exec /usr/bin/perl -e '@s = stat($ARGV[0]); exit 1 unless @s; print "$s[3]\\n"' "\${3:-}" ;;
  '-c:%a') exec /usr/bin/perl -e '@s = stat($ARGV[0]); exit 1 unless @s; printf "%o\\n", $s[2] & 07777' "\${3:-}" ;;
  *) exit 2 ;;
esac
`);

    expect(() => runDispatch('agent-gnu-stat-fallback')).not.toThrow();
  });

  it('rejects a symlinked grid directory even when grid-state.json itself is regular', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const outsideGrid = path.join(tmpHome, 'outside-grid');
    fs.renameSync(gridDir, outsideGrid);
    fs.symlinkSync(outsideGrid, gridDir, 'dir');

    expect(() => runDispatch('agent-symlink-grid-parent')).toThrowError(
      /grid directory.*canonical non-symlink/i,
    );
  });

  it('embeds the default codex launcher contract for fresh tmup workers', () => {
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-launch-contract');

    const launcher = readLauncher();
    expect(launcher).toContain('export TMUP_CODEX_MODEL=auto');
    expect(launcher).not.toContain('TMUP_CODEX_CONTEXT_WINDOW');
    expect(launcher).not.toContain('TMUP_CODEX_AUTO_COMPACT');
    expect(launcher).toContain('export TMUP_CODEX_APPROVAL_POLICY=never');
    expect(launcher).toContain('export TMUP_CODEX_SANDBOX=workspace-write');
    expect(launcher).toContain('export TMUP_CODEX_NO_ALT_SCREEN=true');
    expect(launcher).toContain('export TMUP_CODEX_REASONING_EFFORT=high');
    expect(launcher).toContain('export TMUP_CODEX_REASONING_SUMMARY=concise');
    expect(launcher).toContain('export TMUP_CODEX_PLAN_REASONING=xhigh');
    expect(launcher).toContain('export TMUP_CODEX_VERBOSITY=low');
    expect(launcher).toContain('export TMUP_CODEX_SERVICE_TIER=fast');
    expect(launcher).toContain('export TMUP_CODEX_TOOL_OUTPUT_LIMIT=50000');
    expect(launcher).toContain('export TMUP_CODEX_WEB_SEARCH=live');
    expect(launcher).toContain('export TMUP_CODEX_HISTORY=save-all');
    expect(launcher).not.toContain('TMUP_CODEX_UNDO');
    expect(launcher).toContain('export TMUP_CODEX_SHELL_INHERIT=core');
    expect(launcher).toContain('export TMUP_CODEX_SHELL_SNAPSHOT=true');
    expect(launcher).toContain('export TMUP_CODEX_REQUEST_COMPRESSION=true');
    expect(launcher).toContain('export TMUP_CODEX_NOTIFICATIONS=true');
    expect(launcher).toContain('export TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT=600000');
    expect(launcher).toContain('export TMUP_CODEX_MAX_THREADS=6');
    expect(launcher).toContain('export TMUP_CODEX_MAX_DEPTH=1');
    expect(launcher).toContain('export TMUP_CODEX_JOB_TIMEOUT=3600');
    const taskTmp = launcher.match(/^export TMUP_TASK_TMPDIR=(.+)$/m)?.[1];
    expect(taskTmp).toBeTruthy();
    expect(taskTmp!.startsWith(`${controlSessionDir()}/tasks/task-tmp-1-agent-launch-contract.`)).toBe(true);
    expect(fs.statSync(taskTmp!).mode & 0o777).toBe(0o700);
    expect(launcher).not.toContain('export TMPDIR="$TMUP_TASK_TMPDIR"');
    expect(launcher).not.toContain('export TMP="$TMUP_TASK_TMPDIR"');
    expect(launcher).not.toContain('export TEMP="$TMUP_TASK_TMPDIR"');
    expect(launcher).not.toContain('-m "$TMUP_CODEX_MODEL"');
    expect(launcher).not.toContain('model_context_window');
    expect(launcher).not.toContain('model_auto_compact_token_limit');
    expect(launcher).toContain('-a "$TMUP_CODEX_APPROVAL_POLICY"');
    expect(launcher).toContain('-s "$TMUP_CODEX_SANDBOX"');
    const commonArgs = readCommonArgs(launcher);
    expect(commonArgs).toContain('--add-dir "$TMUP_TASK_TMPDIR"');
    expect(commonArgs).not.toContain('--add-dir "$TMUP_SESSION_DIR"');
    expect(commonArgs.match(/--add-dir/g)).toHaveLength(1);
    expect(commonArgs).toContain('-c "sandbox_workspace_write.exclude_slash_tmp=true"');
    expect(commonArgs).toContain('-c "sandbox_workspace_write.exclude_tmpdir_env_var=true"');
    expect(commonArgs).toContain('-c "sandbox_workspace_write.network_access=false"');
    for (const envName of [
      'TMUP_AGENT_ID',
      'TMUP_PANE_INDEX',
      'TMUP_WORKING_DIR',
      'TMPDIR',
      'TMP',
      'TEMP',
    ]) {
      expect(commonArgs).toContain(`shell_environment_policy.set.${envName}=`);
    }
    for (const hiddenEnvName of ['TMUP_DB', 'TMUP_SESSION_NAME', 'TMUP_SESSION_DIR']) {
      expect(commonArgs).not.toContain(`shell_environment_policy.set.${hiddenEnvName}=`);
    }
    expect(commonArgs).not.toContain('shell_environment_policy.set.TMUP_TASK_ID=');
    expect(commonArgs).not.toContain('TMUP_SYNTHETIC_SHOULD_DROP');
    expect(launcher).toContain('-c "model_reasoning_effort=$TMUP_CODEX_REASONING_EFFORT"');
    expect(launcher).toContain('-c "model_reasoning_summary=$TMUP_CODEX_REASONING_SUMMARY"');
    expect(launcher).toContain('-c "plan_mode_reasoning_effort=$TMUP_CODEX_PLAN_REASONING"');
    expect(launcher).toContain('-c "model_verbosity=$TMUP_CODEX_VERBOSITY"');
    expect(launcher).toContain('-c "service_tier=$TMUP_CODEX_SERVICE_TIER"');
    expect(launcher).toContain('-c "tool_output_token_limit=$TMUP_CODEX_TOOL_OUTPUT_LIMIT"');
    expect(launcher).toContain('-c "web_search=$TMUP_CODEX_WEB_SEARCH"');
    expect(launcher).toContain('-c "history.persistence=$TMUP_CODEX_HISTORY"');
    expect(launcher).not.toContain('features.undo');
    expect(launcher).toContain('-c "shell_environment_policy.inherit=$TMUP_CODEX_SHELL_INHERIT"');
    expect(launcher).toContain('-c "features.shell_snapshot=$TMUP_CODEX_SHELL_SNAPSHOT"');
    expect(launcher).toContain('-c "features.enable_request_compression=$TMUP_CODEX_REQUEST_COMPRESSION"');
    expect(launcher).toContain('-c "tui.notifications=$TMUP_CODEX_NOTIFICATIONS"');
    expect(launcher).toContain('-c "background_terminal_max_timeout=$TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT"');
    expect(launcher).toContain('-c "agents.max_threads=$TMUP_CODEX_MAX_THREADS"');
    expect(launcher).toContain('-c "agents.max_depth=$TMUP_CODEX_MAX_DEPTH"');
    expect(launcher).toContain('-c "agents.job_max_runtime_seconds=$TMUP_CODEX_JOB_TIMEOUT"');
  });

  it('requires policy enablement and a per-dispatch receipt before pinning a model', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    configureExplicitModel('test-model-id', false);

    expect(() => runDispatch('agent-model-policy-disabled', {
      modelValidationReceipt: 'catalog-reviewed',
    })).toThrowError(/model pins are disabled by policy/i);

    configureExplicitModel('test-model-id', true);
    expect(() => runDispatch('agent-model-missing-receipt')).toThrowError(
      /requires a per-dispatch live-validation receipt/i,
    );

    runDispatch('agent-model-pinned', {
      modelValidationReceipt: 'catalog-reviewed',
    });
    const launcher = readLauncher();
    expect(launcher).toContain('export TMUP_CODEX_MODEL=test-model-id');
    expect(readCommonArgs(launcher)).toContain('-m "$TMUP_CODEX_MODEL"');
  });

  it('reapplies the same codex launcher contract on resume', () => {
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-resume-contract', { resumeSessionId: 'csid-123' });

    const launcher = readLauncher();
    const gridState = JSON.parse(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8'));
    expect(gridState.panes[0].codex_session_id).toBe('csid-123');
    expect(launcher).toContain('_COMMON_ARGS=(');
    expect(launcher).not.toContain('-m "$TMUP_CODEX_MODEL"');
    expect(launcher).not.toContain('model_context_window');
    expect(launcher).not.toContain('model_auto_compact_token_limit');
    expect(launcher).toContain('-a "$TMUP_CODEX_APPROVAL_POLICY"');
    expect(launcher).toContain('-s "$TMUP_CODEX_SANDBOX"');
    const commonArgs = readCommonArgs(launcher);
    expect(commonArgs).toContain('--add-dir "$TMUP_TASK_TMPDIR"');
    expect(commonArgs).not.toContain('--add-dir "$TMUP_SESSION_DIR"');
    expect(commonArgs.match(/--add-dir/g)).toHaveLength(1);
    expect(commonArgs).toContain('-c "sandbox_workspace_write.exclude_slash_tmp=true"');
    expect(commonArgs).toContain('-c "sandbox_workspace_write.exclude_tmpdir_env_var=true"');
    expect(commonArgs).toContain('-c "sandbox_workspace_write.network_access=false"');
    for (const envName of [
      'TMUP_AGENT_ID',
      'TMUP_PANE_INDEX',
      'TMUP_WORKING_DIR',
      'TMPDIR',
      'TMP',
      'TEMP',
    ]) {
      expect(commonArgs).toContain(`shell_environment_policy.set.${envName}=`);
    }
    for (const hiddenEnvName of ['TMUP_DB', 'TMUP_SESSION_NAME', 'TMUP_SESSION_DIR']) {
      expect(commonArgs).not.toContain(`shell_environment_policy.set.${hiddenEnvName}=`);
    }
    expect(commonArgs).not.toContain('shell_environment_policy.set.TMUP_TASK_ID=');
    expect(launcher).toContain('-c "model_reasoning_effort=$TMUP_CODEX_REASONING_EFFORT"');
    expect(launcher).toContain('-c "model_reasoning_summary=$TMUP_CODEX_REASONING_SUMMARY"');
    expect(launcher).toContain('-c "plan_mode_reasoning_effort=$TMUP_CODEX_PLAN_REASONING"');
    expect(launcher).toContain('-c "model_verbosity=$TMUP_CODEX_VERBOSITY"');
    expect(launcher).toContain('-c "service_tier=$TMUP_CODEX_SERVICE_TIER"');
    expect(launcher).toContain('-c "tool_output_token_limit=$TMUP_CODEX_TOOL_OUTPUT_LIMIT"');
    expect(launcher).toContain('-c "web_search=$TMUP_CODEX_WEB_SEARCH"');
    expect(launcher).toContain('-c "history.persistence=$TMUP_CODEX_HISTORY"');
    expect(launcher).not.toContain('features.undo');
    expect(launcher).toContain('-c "shell_environment_policy.inherit=$TMUP_CODEX_SHELL_INHERIT"');
    expect(launcher).toContain('-c "features.shell_snapshot=$TMUP_CODEX_SHELL_SNAPSHOT"');
    expect(launcher).toContain('-c "features.enable_request_compression=$TMUP_CODEX_REQUEST_COMPRESSION"');
    expect(launcher).toContain('-c "tui.notifications=$TMUP_CODEX_NOTIFICATIONS"');
    expect(launcher).toContain('-c "background_terminal_max_timeout=$TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT"');
    expect(launcher).toContain('-c "agents.max_threads=$TMUP_CODEX_MAX_THREADS"');
    expect(launcher).toContain('-c "agents.max_depth=$TMUP_CODEX_MAX_DEPTH"');
    expect(launcher).toContain('-c "agents.job_max_runtime_seconds=$TMUP_CODEX_JOB_TIMEOUT"');
    expect(launcher).toContain('"${_CODEX_COMMAND[@]}" "${_COMMON_ARGS[@]}" resume "$RESUME_SESSION_ID"');
  });

  it.each(['--working-dir', '--session'])('does not treat prompt value %j as a boundary option', (prompt) => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    expect(() => runDispatch(`agent-prompt-${prompt.slice(2)}`, { prompt })).not.toThrow();
  });

  it('allows an explicit per-dispatch opt-in to broader shell inheritance', () => {
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-shell-opt-in', { shellEnvInheritOverride: 'all' });

    expect(fs.readFileSync(DISPATCH_AGENT_SH, 'utf-8')).toContain(
      'TMUP_CODEX_SHELL_INHERIT_OVERRIDE',
    );
    const launcher = readLauncher();
    expect(launcher).toContain('export TMUP_CODEX_SHELL_INHERIT=all');
    expect(launcher).toContain('unset TMUP_CODEX_SHELL_INHERIT_OVERRIDE');
  });

  it('keeps executable control artifacts outside both worker-writable roots', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');

    runDispatch('agent-control-boundary');

    const launcherPath = launcherFilePath();
    const launcher = fs.readFileSync(launcherPath, 'utf-8');
    const promptPath = launcher.match(/^_PROMPT_FILE=(.+)$/m)?.[1];
    const taskTmp = launcher.match(/^export TMUP_TASK_TMPDIR=(.+)$/m)?.[1];
    expect(promptPath).toBeTruthy();
    expect(taskTmp).toBeTruthy();
    for (const artifact of [launcherPath, promptPath!]) {
      expect(isWithin(stateDir, artifact)).toBe(false);
      expect(isWithin(workingDir, artifact)).toBe(false);
      expect(isWithin(taskTmp!, artifact)).toBe(false);
    }
    expect(fs.statSync(launcherPath).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(launcherPath)).mode & 0o777).toBe(0o700);
    expect(launcher).toContain('_PROMPT_HASH=');
    expect(fs.readFileSync(DISPATCH_AGENT_SH, 'utf-8')).toContain('chmod 600 "$PROMPT_FILE"');
    expect(fs.realpathSync(taskTmp!).startsWith(`${controlSessionDir()}/tasks/`)).toBe(true);
  });

  it('ignores shell and Node loader injection in the dispatcher and protected pane launcher', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const marker = path.join(tmpHome, 'bash-env-executed');
    const nodeMarker = path.join(tmpHome, 'node-options-executed');
    const bashEnv = path.join(tmpHome, 'attacker-bash-env.sh');
    const nodeRequire = path.join(tmpHome, 'attacker-node-options.cjs');
    fs.writeFileSync(bashEnv, `#!/bin/bash\nprintf 'executed\\n' > ${JSON.stringify(marker)}\n`);
    fs.writeFileSync(nodeRequire, `require('node:fs').writeFileSync(${JSON.stringify(nodeMarker)}, 'executed\\n');\n`);

    runDispatch('agent-bash-env', {
      environment: {
        BASH_ENV: bashEnv,
        ENV: bashEnv,
        SDLC_OS_PLUGIN: path.join(tmpHome, 'attacker-plugin'),
        NODE_OPTIONS: `--require=${nodeRequire}`,
        NODE_PATH: path.join(tmpHome, 'attacker-node-path'),
      },
    });
    expect(fs.existsSync(marker)).toBe(false);

    const launcherPath = launcherFilePath();
    const launcher = fs.readFileSync(launcherPath, 'utf-8');
    expect(launcher).toContain('unset BASH_ENV ENV SDLC_OS_PLUGIN NODE_OPTIONS NODE_PATH');
    execFileSync('/bin/bash', ['-p', launcherPath], {
      env: {
        ...shellEnv(),
        BASH_ENV: bashEnv,
        ENV: bashEnv,
        SDLC_OS_PLUGIN: path.join(tmpHome, 'attacker-plugin'),
        NODE_OPTIONS: `--require=${nodeRequire}`,
        NODE_PATH: path.join(tmpHome, 'attacker-node-path'),
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(nodeMarker)).toBe(false);
  });

  it('allows direct shared-state access only with an explicit trusted receipt', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    enableTrustedSharedStatePolicy();

    expect(() => runDispatch('agent-trusted-missing-receipt', {
      trustedSharedState: true,
    })).toThrowError(/trusted shared-state.*receipt/i);

    runDispatch('agent-trusted-state', {
      trustedSharedState: true,
      trustedSharedStateReceipt: 'operator-reviewed-shared-state',
    });
    const commonArgs = readCommonArgs(readLauncher());
    expect(commonArgs).toContain('--add-dir "$TMUP_SESSION_DIR"');
    expect(commonArgs.match(/--add-dir/g)).toHaveLength(2);
    for (const envName of ['TMUP_DB', 'TMUP_SESSION_NAME', 'TMUP_SESSION_DIR']) {
      expect(commonArgs).toContain(`shell_environment_policy.set.${envName}=`);
    }
  });

  it('rejects a working root that overlaps protected controller or plugin state', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');

    expect(() => runDispatch('agent-overlap', { workingDir: tmpHome })).toThrowError(
      /(?:trusted controller toolchain|overlaps.*(?:controller|session|plugin))/i,
    );
    const sessionChild = path.join(stateDir, 'worker-root');
    fs.mkdirSync(sessionChild);
    expect(() => runDispatch('agent-session-child', {
      workingDir: sessionChild,
    })).toThrowError(/trusted controller toolchain validation failed/i);
    expect(fs.readdirSync(stateDir).some((entry) => /^(?:prompt|launcher|task-tmp)-/.test(entry))).toBe(false);
  });

  it('executes tmup-cli with required identity through the filtered Codex command environment', () => {
    const resultPath = path.join(tmpHome, 'filtered-env-result.txt');
    const cliPath = path.join(PLUGIN_DIR, 'cli/dist/tmup-cli.js');

    writeExecutable('codex', `#!/bin/bash
set -euo pipefail
env_args=("PATH=$PATH" "HOME=$HOME")
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-c" && $# -ge 2 ]]; then
    setting="$2"
    case "$setting" in
      shell_environment_policy.set.*=*)
        pair="\${setting#shell_environment_policy.set.}"
        key="\${pair%%=*}"
        encoded="\${pair#*=}"
        value="$(printf '%s' "$encoded" | jq -r .)"
        env_args+=("$key=$value")
        ;;
    esac
    shift 2
  else
    shift
  fi
done
/usr/bin/env -i "\${env_args[@]}" /bin/bash -c '
  [[ -z "\${TMUP_SYNTHETIC_SHOULD_DROP+x}" ]] || exit 70
  [[ "$TMPDIR" == "$TMP" && "$TMPDIR" == "$TEMP" ]] || exit 71
  : > "$TMPDIR/tool-temp-canary"
  printf "identity=%s|%s|%s|%s|%s|%s|%s\\n" \
    "$TMUP_AGENT_ID" "$TMUP_DB" "$TMUP_PANE_INDEX" "$TMUP_SESSION_NAME" \
    "$TMUP_SESSION_DIR" "$TMUP_WORKING_DIR" "$TMUP_TASK_ID"
  exec "$1" "$2" status
' _ ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} > ${JSON.stringify(resultPath)}
`);

    enableTrustedSharedStatePolicy();
    runDispatch('agent-filtered-env', {
      taskId: '007',
      trustedSharedState: true,
      trustedSharedStateReceipt: 'filtered-env-shared-state',
    });
    const launcherPath = launcherFilePath();
    const launcher = fs.readFileSync(launcherPath, 'utf-8');
    expect(readCommonArgs(launcher)).toContain(
      'shell_environment_policy.set.TMUP_TASK_ID=',
    );
    const taskTmp = launcher.match(/^export TMUP_TASK_TMPDIR=(.+)$/m)?.[1];
    expect(taskTmp).toBeTruthy();

    execFileSync('/bin/bash', [launcherPath], {
      env: {
        ...shellEnv(),
        TMUP_SYNTHETIC_SHOULD_DROP: 'must-not-reach-worker-tools',
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = fs.readFileSync(resultPath, 'utf-8');
    expect(result).toContain(
      `identity=agent-filtered-env|${path.join(stateDir, 'tmup.db')}|1|${sessionName}|${stateDir}|${workingDir}|007`,
    );
    expect(result).toContain('"ok":true');
    expect(result).toContain('"agent_id":"agent-filtered-env"');
    expect(result).not.toContain('must-not-reach-worker-tools');
    expect(fs.existsSync(taskTmp!)).toBe(false);
  });

  it('rejects filesystem-unsafe agent IDs before creating dispatch artifacts', () => {
    let stderr = '';
    try {
      runDispatch('unsafe/../../escape');
    } catch (error: any) {
      stderr = String(error?.stderr ?? '');
    }

    expect(stderr).toContain('Invalid --agent-id');
    expect(fs.readdirSync(stateDir).some((entry) => entry.startsWith('prompt-'))).toBe(false);
  });

  it('fails closed before dispatch when the session directory is a symlink escape', () => {
    const outsideState = path.join(tmpHome, 'outside-session-state');
    fs.renameSync(stateDir, outsideState);
    fs.symlinkSync(outsideState, stateDir, 'dir');

    expect(() => runDispatch('agent-symlink-state')).toThrow();
    expect(fs.existsSync(path.join(outsideState, 'launcher-1.sh'))).toBe(false);
    expect(fs.existsSync(path.join(outsideState, 'prompt-1-agent-symlink-state.txt'))).toBe(false);
  });

  it('supports an absolute custom tmup state root without weakening containment checks', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const customRoot = path.join(tmpHome, 'custom-tmup-state');
    const customSession = path.join(customRoot, sessionName);
    const customGrid = path.join(customSession, 'grid');
    fs.mkdirSync(customGrid, { recursive: true });
    fs.writeFileSync(path.join(customSession, 'tmup.db'), '');
    fs.writeFileSync(path.join(customGrid, 'grid-state.json'), JSON.stringify({
      panes: [{ index: 1, pane_id: '%1', status: 'available' }],
    }, null, 2));

    const output = runDispatch('agent-custom-state-root', { stateRoot: customRoot });

    expect(output).toContain('Dispatched tester to pane 1');
  });

  it('does not persist a global-tail Codex session ID when history lacks cwd correlation', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({
      session_id: 'wrong-global-tail',
      text: 'unrelated',
      ts: Math.floor(Date.now() / 1000),
    }) + '\n');

    const output = runDispatch('agent-uncorrelated-history');
    const gridState = JSON.parse(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8'));
    expect(output).not.toContain('Codex session ID:');
    expect(gridState.panes[0].codex_session_id).toBeUndefined();
  });

  it('does not persist a same-cwd global-tail session ID without pane-specific evidence', () => {
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'history.jsonl'), [
      { session_id: 'other-pane-one', cwd: workingDir, ts: 1 },
      { session_id: 'other-pane-two', cwd: workingDir, ts: 2 },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const output = runDispatch('agent-same-cwd-history');
    const gridState = JSON.parse(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8'));
    expect(output).not.toContain('Codex session ID:');
    expect(gridState.panes[0].codex_session_id).toBeUndefined();
  });

  function runDispatch(
    agentId: string,
    options: {
      resumeSessionId?: string;
      taskId?: string;
      shellEnvInheritOverride?: string;
      codexBin?: string;
      trustedSharedState?: boolean;
      trustedSharedStateReceipt?: string;
      modelValidationReceipt?: string;
      environment?: NodeJS.ProcessEnv;
      workingDir?: string;
      prompt?: string;
      stateRoot?: string;
    } = {},
  ): string {
    const env = shellEnv();
    delete env.CODEX_BIN;
    const effectiveStateDir = options.stateRoot
      ? path.join(options.stateRoot, sessionName)
      : stateDir;

    const args = [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', options.prompt ?? 'PATH fallback verification',
      '--agent-id', agentId,
      '--db-path', path.join(effectiveStateDir, 'tmup.db'),
      '--node-bin', process.execPath,
      '--working-dir', options.workingDir ?? workingDir,
      '--pane-index', '1',
    ];

    if (options.resumeSessionId) {
      args.push('--resume-session-id', options.resumeSessionId);
    }
    if (options.taskId) {
      args.push('--task-id', options.taskId);
    }
    if (options.trustedSharedState) {
      args.push('--trusted-shared-state');
    }
    if (options.trustedSharedStateReceipt) {
      args.push('--trusted-shared-state-receipt', options.trustedSharedStateReceipt);
    }
    if (options.modelValidationReceipt) {
      args.push('--model-validation-receipt', options.modelValidationReceipt);
    }

    return execFileSync('/bin/bash', ['-p', ...args], {
      env: {
        ...env,
        ...(options.shellEnvInheritOverride
          ? { TMUP_CODEX_SHELL_INHERIT_OVERRIDE: options.shellEnvInheritOverride }
          : {}),
        ...(options.codexBin ? { CODEX_BIN: options.codexBin } : {}),
        ...(options.stateRoot ? { TMUP_STATE_ROOT: options.stateRoot } : {}),
        ...options.environment,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function readLauncher(): string {
    return fs.readFileSync(launcherFilePath(), 'utf-8');
  }

  function controlSessionDir(): string {
    return path.join(tmpHome, '.local/state/tmup-control', sessionName);
  }

  function launcherFilePath(): string {
    const artifactDir = path.join(controlSessionDir(), 'artifacts');
    const match = fs.readdirSync(artifactDir).find((entry) => /^launcher-1-.*\.sh$/.test(entry));
    if (!match) throw new Error(`launcher not found in ${artifactDir}`);
    return path.join(artifactDir, match);
  }

  function readCommonArgs(launcher: string): string {
    const start = launcher.indexOf('_COMMON_ARGS=(');
    const end = launcher.indexOf('_COMMON_ARGS+=', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return launcher.slice(start, end);
  }

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMUP_TEST_CONTROLLER_OVERRIDE: '1',
      TMUP_TEST_CONTROLLER_TOOL_DIRS: fakeBin,
    };
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function enableTrustedSharedStatePolicy(): void {
    writeExecutable('yq', `#!/bin/bash
case "\${2:-}" in
  '.codex.trusted_shared_state_enabled // false') printf 'true\\n' ;;
  *) printf 'null\\n' ;;
esac
`);
  }

  function configureExplicitModel(model: string, enabled: boolean): void {
    writeExecutable('yq', `#!/bin/bash
case "\${2:-}" in
  '.codex.model // "auto"') printf '%s\\n' ${JSON.stringify(model)} ;;
  '.codex.explicit_model_pins_enabled // false') printf '%s\\n' ${JSON.stringify(String(enabled))} ;;
  *) printf 'null\\n' ;;
esac
`);
  }

  function isWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  function linkSystemBinary(_fileName: string): void {}
});
