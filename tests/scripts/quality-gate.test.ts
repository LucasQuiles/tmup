import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const QUALITY_GATE = path.join(PLUGIN_DIR, 'scripts/quality-gate.sh');
const SHELL_SYNTAX_CHECK = path.join(PLUGIN_DIR, 'scripts/check-shell-syntax.sh');
const GRID_SETUP = path.join(PLUGIN_DIR, 'scripts/grid-setup.sh');
const WORKFLOWS = [
  path.join(PLUGIN_DIR, '.github/workflows/quality-gate.yml'),
];
const CHECKOUT_REF = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0';
const SETUP_NODE_REF = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0';

function makeFakeBin(executables: Record<string, string>): string {
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'tmup-quality-gate-'));
  const isolatedExecutables = {
    node: `exec ${JSON.stringify(process.execPath)} "$@"`,
    ...executables,
  };
  for (const [name, source] of Object.entries(isolatedExecutables)) {
    const executable = path.join(fakeBin, name);
    writeFileSync(executable, `#!/bin/bash\nset -euo pipefail\n${source}\n`);
    chmodSync(executable, 0o755);
  }
  return fakeBin;
}

function runGateWithFakeBin(
  fakeBin: string,
  options: { ci?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync('/bin/bash', options.ci === false ? [QUALITY_GATE] : [QUALITY_GATE, '--ci'], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      ...options.env,
    },
    encoding: 'utf-8',
    timeout: 5000,
  });
}

describe('quality-gate.sh', () => {
  it('delegates repository-wide shell syntax to the shared deterministic checker', () => {
    const source = readFileSync(QUALITY_GATE, 'utf-8');

    expect(source).toContain('step "shell syntax" /bin/bash -p scripts/check-shell-syntax.sh');
    expect(readFileSync(WORKFLOWS[0], 'utf-8')).toContain('scripts/quality-gate.sh --ci');
    expect(readFileSync(WORKFLOWS[0], 'utf-8')).toContain('ubuntu-latest, macos-14');
  });

  it('checks every nested shell script and fails closed on malformed input', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'tmup-shell-syntax-'));
    const nested = path.join(fixtureRoot, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(fixtureRoot, 'valid.sh'), '#!/usr/bin/env bash\ntrue\n');
    writeFileSync(path.join(nested, 'invalid.sh'), '#!/usr/bin/env bash\nif true; then\n');

    try {
      const malformed = spawnSync('bash', [SHELL_SYNTAX_CHECK, fixtureRoot], {
        cwd: PLUGIN_DIR,
        encoding: 'utf-8',
      });
      expect(malformed.status).not.toBe(0);

      rmSync(path.join(nested, 'invalid.sh'));
      const clean = spawnSync('bash', [SHELL_SYNTAX_CHECK, fixtureRoot], {
        cwd: PLUGIN_DIR,
        encoding: 'utf-8',
      });
      expect(clean.status).toBe(0);

      for (const ignored of ['.git', '.worktrees', 'node_modules', 'dist']) {
        const ignoredDir = path.join(fixtureRoot, ignored, 'nested');
        mkdirSync(ignoredDir, { recursive: true });
        writeFileSync(path.join(ignoredDir, 'invalid.sh'), '#!/usr/bin/env bash\nif true; then\n');
      }
      const ignoredMalformed = spawnSync('bash', [SHELL_SYNTAX_CHECK, fixtureRoot], {
        cwd: PLUGIN_DIR,
        encoding: 'utf-8',
      });
      expect(ignoredMalformed.status).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('uses a fixed Bash interpreter before ambient PATH can supply a shim', () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'tmup-fake-bash-'));
    const marker = path.join(markerRoot, 'called');
    const fakeBin = makeFakeBin({ bash: `printf called > ${JSON.stringify(marker)}\nexit 99` });

    try {
      const result = spawnSync(GRID_SETUP, ['--help'], {
        cwd: PLUGIN_DIR,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  it('includes fail-closed production and full dependency audits plus generated-artifact drift', () => {
    const source = readFileSync(QUALITY_GATE, 'utf-8');

    expect(source).toContain(
      'step "npm audit (production)" /bin/bash -p scripts/with-supported-node.sh npm audit --omit=dev --audit-level=low',
    );
    expect(source).toContain(
      'step "npm audit (full)" /bin/bash -p scripts/with-supported-node.sh npm audit --audit-level=low',
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

  it('requires experimental tier files to be absent in default-off local mode', () => {
    const fakeBin = makeFakeBin({ npm: 'exit 0', npx: 'exit 0', git: 'exit 0' });
    const targetDir = mkdtempSync(path.join(os.tmpdir(), 'tmup-gate-agents-'));

    try {
      const clean = runGateWithFakeBin(fakeBin, {
        ci: false,
        env: { TMUP_CODEX_AGENT_TARGET_DIR: targetDir },
      });
      expect(clean.status).toBe(0);

      writeFileSync(path.join(targetDir, 'tmup-tier1.toml'), 'stale\n');
      const stale = runGateWithFakeBin(fakeBin, {
        ci: false,
        env: { TMUP_CODEX_AGENT_TARGET_DIR: targetDir },
      });
      expect(stale.status).toBe(1);
      expect(`${stale.stdout}${stale.stderr}`).toMatch(/disabled.*installed/i);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('requires receipts and exact installed tiers when experimental enablement is active', () => {
    const fakeBin = makeFakeBin({ npm: 'exit 0', npx: 'exit 0', git: 'exit 0' });
    const targetDir = mkdtempSync(path.join(os.tmpdir(), 'tmup-gate-agents-'));

    try {
      const missingReceipts = runGateWithFakeBin(fakeBin, {
        ci: false,
        env: {
          TMUP_CODEX_AGENT_TARGET_DIR: targetDir,
          TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS: 'true',
        },
      });
      expect(missingReceipts.status).toBe(1);
      expect(`${missingReceipts.stdout}${missingReceipts.stderr}`).toMatch(/receipt/i);

      mkdirSync(targetDir, { recursive: true });
      for (const file of ['tmup-tier1.toml', 'tmup-tier2.toml']) {
        copyFileSync(path.join(PLUGIN_DIR, 'agents/codex', file), path.join(targetDir, file));
      }
      const enabled = runGateWithFakeBin(fakeBin, {
        ci: false,
        env: {
          TMUP_CODEX_AGENT_TARGET_DIR: targetDir,
          TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS: 'true',
          TMUP_CODEX_CATALOG_VALIDATION_RECEIPT: 'catalog-canary-pass',
          TMUP_CODEX_NAMED_ROLE_SELECTOR_RECEIPT: 'selector-canary-pass',
        },
      });
      expect(enabled.status).toBe(0);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
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
