import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const QUALITY_GATE = path.join(PLUGIN_DIR, 'scripts/quality-gate.sh');

describe('quality-gate.sh', () => {
  it('includes the established tmux helper syntax check', () => {
    const source = readFileSync(QUALITY_GATE, 'utf-8');

    expect(source).toContain(
      'step "shell syntax" bash -n scripts/dispatch-agent.sh scripts/lib/tmux-helpers.sh',
    );
  });

  it('propagates an injected failure with the failing step name', () => {
    const result = spawnSync('bash', [QUALITY_GATE, '--ci'], {
      cwd: PLUGIN_DIR,
      env: {
        ...process.env,
        TMUP_GATE_SELFTEST_FAIL: '1',
      },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'GATE FAIL: selftest-injected-failure',
    );
  });
});
