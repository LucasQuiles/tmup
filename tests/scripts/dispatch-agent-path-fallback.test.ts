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

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-path-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  display-message)
    printf 'bash\\n'
    ;;
  send-keys)
    ;;
  capture-pane)
    printf 'Working (fake)\\n'
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "\${1:-}" >&2
    exit 1
    ;;
esac
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
      'mktemp',
      'mv',
      'rm',
      'seq',
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

  it('falls back to $HOME/.local/bin/codex when PATH lookup fails and CODEX_BIN is unset', () => {
    runDispatch('agent-home-fallback');

    expect(readLauncher()).toContain(
      `export CODEX_BIN=${path.join(tmpHome, '.local/bin/codex')}`
    );
  });

  it('embeds the default codex launcher contract for fresh tmup workers', () => {
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-launch-contract');

    const launcher = readLauncher();
    expect(launcher).toContain('export TMUP_CODEX_MODEL=gpt-5.4');
    expect(launcher).toContain('export TMUP_CODEX_CONTEXT_WINDOW=1050000');
    expect(launcher).toContain('export TMUP_CODEX_AUTO_COMPACT=750000');
    expect(launcher).toContain('export TMUP_CODEX_APPROVAL_POLICY=never');
    expect(launcher).toContain('export TMUP_CODEX_SANDBOX=danger-full-access');
    expect(launcher).toContain('export TMUP_CODEX_NO_ALT_SCREEN=true');
    expect(launcher).toContain('export TMUP_CODEX_REASONING_EFFORT=high');
    expect(launcher).toContain('export TMUP_CODEX_REASONING_SUMMARY=low');
    expect(launcher).toContain('export TMUP_CODEX_PLAN_REASONING=xhigh');
    expect(launcher).toContain('export TMUP_CODEX_VERBOSITY=low');
    expect(launcher).toContain('export TMUP_CODEX_SERVICE_TIER=fast');
    expect(launcher).toContain('export TMUP_CODEX_TOOL_OUTPUT_LIMIT=50000');
    expect(launcher).toContain('export TMUP_CODEX_WEB_SEARCH=live');
    expect(launcher).toContain('export TMUP_CODEX_HISTORY=save-all');
    expect(launcher).toContain('export TMUP_CODEX_UNDO=true');
    expect(launcher).toContain('export TMUP_CODEX_SHELL_INHERIT=all');
    expect(launcher).toContain('export TMUP_CODEX_SHELL_SNAPSHOT=true');
    expect(launcher).toContain('export TMUP_CODEX_REQUEST_COMPRESSION=true');
    expect(launcher).toContain('export TMUP_CODEX_NOTIFICATIONS=true');
    expect(launcher).toContain('export TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT=600000');
    expect(launcher).toContain('export TMUP_CODEX_MAX_THREADS=6');
    expect(launcher).toContain('export TMUP_CODEX_MAX_DEPTH=2');
    expect(launcher).toContain('export TMUP_CODEX_JOB_TIMEOUT=3600');
    expect(launcher).toContain('-m "$TMUP_CODEX_MODEL"');
    expect(launcher).toContain('-c "model_context_window=$TMUP_CODEX_CONTEXT_WINDOW"');
    expect(launcher).toContain('-c "model_auto_compact_token_limit=$TMUP_CODEX_AUTO_COMPACT"');
    expect(launcher).toContain('-a "$TMUP_CODEX_APPROVAL_POLICY"');
    expect(launcher).toContain('-s "$TMUP_CODEX_SANDBOX"');
    expect(launcher).toContain('-c "model_reasoning_effort=$TMUP_CODEX_REASONING_EFFORT"');
    expect(launcher).toContain('-c "model_reasoning_summary=$TMUP_CODEX_REASONING_SUMMARY"');
    expect(launcher).toContain('-c "plan_mode_reasoning_effort=$TMUP_CODEX_PLAN_REASONING"');
    expect(launcher).toContain('-c "model_verbosity=$TMUP_CODEX_VERBOSITY"');
    expect(launcher).toContain('-c "service_tier=$TMUP_CODEX_SERVICE_TIER"');
    expect(launcher).toContain('-c "tool_output_token_limit=$TMUP_CODEX_TOOL_OUTPUT_LIMIT"');
    expect(launcher).toContain('-c "web_search=$TMUP_CODEX_WEB_SEARCH"');
    expect(launcher).toContain('-c "history.persistence=$TMUP_CODEX_HISTORY"');
    expect(launcher).toContain('-c "features.undo=$TMUP_CODEX_UNDO"');
    expect(launcher).toContain('-c "shell_environment_policy.inherit=$TMUP_CODEX_SHELL_INHERIT"');
    expect(launcher).toContain('-c "features.shell_snapshot=$TMUP_CODEX_SHELL_SNAPSHOT"');
    expect(launcher).toContain('-c "features.enable_request_compression=$TMUP_CODEX_REQUEST_COMPRESSION"');
    expect(launcher).toContain('-c "tui.notifications=$TMUP_CODEX_NOTIFICATIONS"');
    expect(launcher).toContain('-c "background_terminal_max_timeout=$TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT"');
    expect(launcher).toContain('-c "agents.max_threads=$TMUP_CODEX_MAX_THREADS"');
    expect(launcher).toContain('-c "agents.max_depth=$TMUP_CODEX_MAX_DEPTH"');
    expect(launcher).toContain('-c "agents.job_max_runtime_seconds=$TMUP_CODEX_JOB_TIMEOUT"');
  });

  it('reapplies the same codex launcher contract on resume', () => {
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-resume-contract', { resumeSessionId: 'csid-123' });

    const launcher = readLauncher();
    expect(launcher).toContain('_COMMON_ARGS=(');
    expect(launcher).toContain('-m "$TMUP_CODEX_MODEL"');
    expect(launcher).toContain('-c "model_context_window=$TMUP_CODEX_CONTEXT_WINDOW"');
    expect(launcher).toContain('-c "model_auto_compact_token_limit=$TMUP_CODEX_AUTO_COMPACT"');
    expect(launcher).toContain('-a "$TMUP_CODEX_APPROVAL_POLICY"');
    expect(launcher).toContain('-s "$TMUP_CODEX_SANDBOX"');
    expect(launcher).toContain('-c "model_reasoning_effort=$TMUP_CODEX_REASONING_EFFORT"');
    expect(launcher).toContain('-c "model_reasoning_summary=$TMUP_CODEX_REASONING_SUMMARY"');
    expect(launcher).toContain('-c "plan_mode_reasoning_effort=$TMUP_CODEX_PLAN_REASONING"');
    expect(launcher).toContain('-c "model_verbosity=$TMUP_CODEX_VERBOSITY"');
    expect(launcher).toContain('-c "service_tier=$TMUP_CODEX_SERVICE_TIER"');
    expect(launcher).toContain('-c "tool_output_token_limit=$TMUP_CODEX_TOOL_OUTPUT_LIMIT"');
    expect(launcher).toContain('-c "web_search=$TMUP_CODEX_WEB_SEARCH"');
    expect(launcher).toContain('-c "history.persistence=$TMUP_CODEX_HISTORY"');
    expect(launcher).toContain('-c "features.undo=$TMUP_CODEX_UNDO"');
    expect(launcher).toContain('-c "shell_environment_policy.inherit=$TMUP_CODEX_SHELL_INHERIT"');
    expect(launcher).toContain('-c "features.shell_snapshot=$TMUP_CODEX_SHELL_SNAPSHOT"');
    expect(launcher).toContain('-c "features.enable_request_compression=$TMUP_CODEX_REQUEST_COMPRESSION"');
    expect(launcher).toContain('-c "tui.notifications=$TMUP_CODEX_NOTIFICATIONS"');
    expect(launcher).toContain('-c "background_terminal_max_timeout=$TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT"');
    expect(launcher).toContain('-c "agents.max_threads=$TMUP_CODEX_MAX_THREADS"');
    expect(launcher).toContain('-c "agents.max_depth=$TMUP_CODEX_MAX_DEPTH"');
    expect(launcher).toContain('-c "agents.job_max_runtime_seconds=$TMUP_CODEX_JOB_TIMEOUT"');
    expect(launcher).toContain('"$CODEX_BIN" "${_COMMON_ARGS[@]}" resume "$RESUME_SESSION_ID"');
  });

  function runDispatch(
    agentId: string,
    options: {
      resumeSessionId?: string;
    } = {},
  ): void {
    const env = shellEnv();
    delete env.CODEX_BIN;

    const args = [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'PATH fallback verification',
      '--agent-id', agentId,
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
    ];

    if (options.resumeSessionId) {
      args.push('--resume-session-id', options.resumeSessionId);
    }

    execFileSync('/bin/bash', args, {
      env,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function readLauncher(): string {
    return fs.readFileSync(path.join(stateDir, 'launcher-1.sh'), 'utf-8');
  }

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: fakeBin,
    };
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function linkSystemBinary(fileName: string): void {
    const filePath = path.join(fakeBin, fileName);
    if (fs.existsSync(filePath)) {
      return;
    }

    const systemPath = execFileSync('/bin/bash', ['-lc', `command -v ${fileName}`], {
      encoding: 'utf-8',
      env: process.env,
    }).trim();
    fs.symlinkSync(systemPath, filePath);
  }
});
