import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const QUALITY_GATE = path.join(PLUGIN_DIR, 'scripts/quality-gate.sh');
const WORKFLOWS = [
  path.join(PLUGIN_DIR, '.github/workflows/quality.yml'),
  path.join(PLUGIN_DIR, '.github/workflows/quality-gate.yml'),
];
const CHECKOUT_REF = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0';
const SETUP_NODE_REF = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0';

function makeFakeBin(executables: Record<string, string>): string {
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'tmup-quality-gate-'));
  for (const [name, source] of Object.entries(executables)) {
    const executable = path.join(fakeBin, name);
    writeFileSync(executable, `#!/bin/bash\nset -euo pipefail\n${source}\n`);
    chmodSync(executable, 0o755);
  }
  return fakeBin;
}

function runGateWithFakeBin(fakeBin: string) {
  return spawnSync('/bin/bash', [QUALITY_GATE, '--ci'], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    encoding: 'utf-8',
    timeout: 5000,
  });
}

describe('quality-gate.sh', () => {
  it('includes the established tmux helper syntax check', () => {
    const source = readFileSync(QUALITY_GATE, 'utf-8');

    expect(source).toContain(
      'step "shell syntax" bash -n scripts/dispatch-agent.sh scripts/lib/tmux-helpers.sh',
    );
  });

  it('includes fail-closed production and full dependency audits plus generated-artifact drift', () => {
    const source = readFileSync(QUALITY_GATE, 'utf-8');

    expect(source).toContain(
      'step "npm audit (production)" bash scripts/with-supported-node.sh npm audit --omit=dev --audit-level=low',
    );
    expect(source).toContain(
      'step "npm audit (full)" bash scripts/with-supported-node.sh npm audit --audit-level=low',
    );
    expect(source).toContain(
      'step "generated artifact drift" git diff --exit-code -- shared/dist mcp-server/dist cli/dist',
    );
  });

  it('fails closed with the production audit step name without using the network', () => {
    const fakeBin = makeFakeBin({
      npm: '[[ "$1" == "audit" && " $* " == *" --omit=dev "* ]] && exit 42\nexit 0',
    });

    try {
      const result = runGateWithFakeBin(fakeBin);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'GATE FAIL: npm audit (production)',
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('fails closed with the full audit step name without using the network', () => {
    const fakeBin = makeFakeBin({
      npm: '[[ "$1" == "audit" && " $* " != *" --omit=dev "* ]] && exit 42\nexit 0',
    });

    try {
      const result = runGateWithFakeBin(fakeBin);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'GATE FAIL: npm audit (full)',
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('fails closed when the build leaves tracked generated artifacts dirty', () => {
    const fakeBin = makeFakeBin({
      npm: 'exit 0',
      git: '[[ "$1" == "diff" ]] && exit 42\nexit 0',
    });

    try {
      const result = runGateWithFakeBin(fakeBin);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'GATE FAIL: generated artifact drift',
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('pins both workflows to immutable current action releases', () => {
    for (const workflowPath of WORKFLOWS) {
      const workflow = readFileSync(workflowPath, 'utf-8');

      expect(workflow).toContain(CHECKOUT_REF);
      expect(workflow).toContain(SETUP_NODE_REF);
      expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
    }
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
