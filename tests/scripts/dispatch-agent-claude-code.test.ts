import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Resolve the real plugin root — dispatch-agent.sh bakes PLUGIN_DIR from its
// own location (scripts/..), so the launcher will contain this exact path.
const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh worker-type claude_code', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let workingDir: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-claude-code-')));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    workingDir = path.join(tmpHome, 'work');
    process.env.TMUP_TEST_CONTROLLER_OVERRIDE = '1';
    process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS = fakeBin;

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });

    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );
    fs.writeFileSync(path.join(stateDir, 'tmup.db'), '');

    writeTmuxStub();
    writeExecutable('ps', "#!/bin/bash\nprintf '100 1 100 100 S /bin/bash\\n'\n");
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('flock', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', `#!/bin/bash
case "\${2:-}" in
  '.claude_code.trusted_unsandboxed_enabled // false') printf 'true\\n' ;;
  *) printf 'null\\n' ;;
esac
`);
    // Stubs for both worker binaries — the launcher is written but never
    // executed by the tmux stub, so these exist only as PATH defensive nets.
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
    writeExecutable('claude', '#!/bin/bash\nexit 0\n');
  });

  afterEach(() => {
    delete process.env.TMUP_TEST_CONTROLLER_OVERRIDE;
    delete process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('rejects claude_code unless the direct dispatcher receives both trust flag and receipt', () => {
    expect(() => execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Untrusted Claude code worker',
      '--agent-id', 'agent-cc-untrusted',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
      '--worker-type', 'claude_code',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrowError(/allow-unconfined-claude-code.*trust receipt/i);

    expect(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8')).toContain(
      '"status": "available"',
    );
  });

  it('rejects resume IDs for direct claude_code one-shot dispatches', () => {
    expect(() => execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Invalid Claude resume',
      '--agent-id', 'agent-cc-resume',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
      '--worker-type', 'claude_code',
      '--resume-session-id', 'csid-not-supported',
      '--allow-unconfined-claude-code',
      '--claude-code-trust-receipt', 'operator-asserted',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrowError(/resume-session-id.*not supported.*claude_code/i);
  });

  it('bakes the claude -p runtime contract into the launcher when --worker-type claude_code', () => {
    execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Claude code worker verification',
      '--agent-id', 'agent-cc',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
      '--worker-type', 'claude_code',
      '--allow-unconfined-claude-code',
      '--claude-code-trust-receipt', 'test-reviewed-claude-lane',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const launcherPath = launcherPathFor('agent-cc');
    expect(fs.existsSync(launcherPath)).toBe(true);
    const launcher = fs.readFileSync(launcherPath, 'utf-8');

    // Worker-type branch selection
    expect(launcher).toContain("_WORKER_TYPE=claude_code");
    expect(launcher).toContain('if [[ "$_WORKER_TYPE" == "claude_code" ]]');

    // claude -p invocation with the one-shot runtime contract.
    // Model and fallback selection must inherit Claude Code settings instead
    // of pinning an implicit Sonnet worker model here.
    expect(launcher).toContain(`export CLAUDE_BIN=${path.join(fakeBin, 'claude')}`);
    expect(launcher).toContain('"$CLAUDE_BIN" -p');
    expect(launcher).not.toMatch(/(^|\s)claude -p/);
    expect(launcher).not.toContain('--model sonnet');
    expect(launcher).toContain('--permission-mode bypassPermissions');
    expect(launcher).toContain('--max-budget-usd 3.00');

    // PLUGIN_DIR baked as a literal argument — plugin-dir must resolve to the
    // real tmup plugin root (not $HOME or $TMUP_WORKING_DIR).
    expect(launcher).toContain(`--plugin-dir ${PLUGIN_DIR}`);

    // Prompt file wired via stdin redirect, not via --prompt-file / argv
    expect(launcher).toContain('< "$_PROMPT_FILE"');

    // Output is opened only under the protected controller log root.
    expect(launcher).toContain('> "$_CLAUDE_OUTPUT" 2>&1');
    expect(launcher).not.toContain('"$TMUP_WORKING_DIR/session-output-$TMUP_AGENT_ID.json"');

    // Prompt file cleanup runs after claude exits
    expect(launcher).toContain('"$_SYSTEM_RM_BIN" -f "$_PROMPT_FILE"');

    const promptPath = path.join(
      tmpHome,
      '.local/state/tmup-control',
      sessionName,
      'artifacts',
      'prompt-1-agent-cc.txt',
    );
    const prompt = fs.readFileSync(promptPath, 'utf-8');
    expect(prompt).toContain('Runtime Contract — CLAUDE CODE ONE-SHOT');
    expect(prompt).toContain('outside the sandboxed Codex integrity guarantee');
    expect(prompt).toContain('Coordination Mode — SUPERVISOR OWNED');
    expect(prompt).not.toMatch(/INTERACTIVE CODEX|max_threads|max_depth|native children|Codex skills/i);

    // Claude_code branch must still run the background heartbeat loop —
    // platform-enforced liveness that matches the codex lane.
    expect(launcher).toContain('"$TMUP_NODE_BIN" "$_CLI_PATH" heartbeat');

    // Grid state reflects reservation
    const gridState = JSON.parse(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8'));
    expect(gridState.panes[0].role).toBe('tester');
    expect(gridState.panes[0].agent_id).toBe('agent-cc');
  });

  it('bakes the codex runtime contract into the launcher when --worker-type is omitted', () => {
    execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Codex default worker',
      '--agent-id', 'agent-codex-default',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const launcherPath = launcherPathFor('agent-codex-default');
    expect(fs.existsSync(launcherPath)).toBe(true);
    const launcher = fs.readFileSync(launcherPath, 'utf-8');

    // Both worker-type branches are always baked into the launcher — the
    // `_WORKER_TYPE=<value>` line decides which branch runs at launch time.
    // Regression guard: the _WORKER_TYPE assignment must pin to codex when
    // the flag is omitted, and the `if [[ ... == "claude_code" ]]` gate must
    // still be present (we don't want the conditional deleted in favour of
    // an unconditional claude invocation).
    expect(launcher).toContain("_WORKER_TYPE=codex");
    expect(launcher).toContain('if [[ "$_WORKER_TYPE" == "claude_code" ]]');

    // Positive configured Codex contract. Context, compaction, and undo come
    // from the resolved runtime rather than explicit tmup launch overrides.
    expect(launcher).toContain('_CODEX_COMMAND=("$CODEX_BIN")');
    const codexContractPins = [
      '-a "$TMUP_CODEX_APPROVAL_POLICY"',
      '-s "$TMUP_CODEX_SANDBOX"',
      '--add-dir "$TMUP_TASK_TMPDIR"',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      'sandbox_workspace_write.network_access=false',
      'model_reasoning_effort=$TMUP_CODEX_REASONING_EFFORT',
      'model_reasoning_summary=$TMUP_CODEX_REASONING_SUMMARY',
      'plan_mode_reasoning_effort=$TMUP_CODEX_PLAN_REASONING',
      'model_verbosity=$TMUP_CODEX_VERBOSITY',
      'service_tier=$TMUP_CODEX_SERVICE_TIER',
      'tool_output_token_limit=$TMUP_CODEX_TOOL_OUTPUT_LIMIT',
      'web_search=$TMUP_CODEX_WEB_SEARCH',
      'history.persistence=$TMUP_CODEX_HISTORY',
      'shell_environment_policy.inherit=$TMUP_CODEX_SHELL_INHERIT',
      'features.shell_snapshot=$TMUP_CODEX_SHELL_SNAPSHOT',
      'features.enable_request_compression=$TMUP_CODEX_REQUEST_COMPRESSION',
      'tui.notifications=$TMUP_CODEX_NOTIFICATIONS',
      'background_terminal_max_timeout=$TMUP_CODEX_BACKGROUND_TERMINAL_TIMEOUT',
      'agents.max_threads=$TMUP_CODEX_MAX_THREADS',
      'agents.max_depth=$TMUP_CODEX_MAX_DEPTH',
      'agents.job_max_runtime_seconds=$TMUP_CODEX_JOB_TIMEOUT',
      '-C "$TMUP_WORKING_DIR"',
    ];
    for (const pin of codexContractPins) {
      expect(launcher, `codex contract pin missing: ${pin}`).toContain(pin);
    }
  });

  it('completes claude_code dispatch without entering the codex post-launch flow', () => {
    // Non-codex capture-pane output: no `Working (`, no `❯`, no `›`.
    // Load-bearing for mutation detection — if the codex post-launch gate
    // ever regresses, this stub's output would fail to satisfy the trust
    // loop and ready loop, and the test's negative assertions below would
    // still fire correctly.
    writeTmuxStub('$ \\n');

    const output = execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Claude code post-launch gate verification',
      '--agent-id', 'agent-gate',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
      '--worker-type', 'claude_code',
      '--allow-unconfined-claude-code',
      '--claude-code-trust-receipt', 'test-reviewed-claude-lane',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(output).toContain('Dispatched tester to pane 1 (agent agent-gate)');
    expect(output).not.toContain('Waiting for codex to become ready');
    expect(output).not.toContain('Codex ready in pane');
    expect(output).not.toContain('Initial prompt confirmed');
    expect(output).not.toContain('Codex session ID:');
  });

  it('claude_code worker does not source clone-manager.sh when --clone-isolation is omitted', () => {
    const output = execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Claude code without clone isolation',
      '--agent-id', 'agent-cc-no-clone',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
      '--worker-type', 'claude_code',
      '--allow-unconfined-claude-code',
      '--claude-code-trust-receipt', 'test-reviewed-claude-lane',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        // Point SDLC_OS_PLUGIN at a nonexistent path. If clone-isolation
        // were accidentally triggered by --worker-type claude_code, the
        // dispatcher would die on the missing clone-manager.sh.
        SDLC_OS_PLUGIN: path.join(tmpHome, 'does-not-exist'),
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Negative guard: dispatch-agent.sh only emits CLONE_DIR=<path> when the
    // clone_isolation branch runs. If --worker-type claude_code ever leaked
    // into the clone branch without aborting, this assertion catches it.
    expect(output).not.toMatch(/^CLONE_DIR=/m);

    const launcherPath = launcherPathFor('agent-cc-no-clone');
    expect(fs.existsSync(launcherPath)).toBe(true);
    const launcher = fs.readFileSync(launcherPath, 'utf-8');
    expect(launcher).toContain('"$CLAUDE_BIN" -p');
    expect(launcher).toContain("_WORKER_TYPE=claude_code");
  });

  // Default captureOutput emits the codex-ready markers (`Working (` and `❯`)
  // that short-circuit the dispatch script's trust loop and ready loop. Pass
  // a custom string (e.g. `'$ \\n'`) to simulate a non-codex pane.
  function writeTmuxStub(captureOutput: string = 'Working (fake)\\n\u276f\\n'): void {
    const sendKeysLog = shellQuote(path.join(tmuxStateDir, 'send-keys.log'));
    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
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
    printf '%s\\n' "$*" >> ${sendKeysLog}
    ;;
  capture-pane)
    printf '${captureOutput}'
    if [[ '${captureOutput}' == *'Working ('* ]]; then
      count_file="$HOME/.tmup-test-capture-count"
      count=0
      [[ ! -f "$count_file" ]] || count=$(cat "$count_file")
      count=$((count + 1))
      printf '%s' "$count" > "$count_file"
      printf 'Working (receipt-%s)\\n' "$count"
    fi
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "$cmd" >&2
    exit 1
    ;;
esac
`);
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function launcherPathFor(agentId: string): string {
    return path.join(
      tmpHome,
      '.local/state/tmup-control',
      sessionName,
      'artifacts',
      `launcher-1-${agentId}.sh`,
    );
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
});
