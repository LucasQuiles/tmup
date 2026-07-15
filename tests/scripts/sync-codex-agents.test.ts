import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const SYNC_CODEX_AGENTS_SH = path.join(PLUGIN_DIR, 'scripts/sync-codex-agents.sh');
const SOURCE_DIR = path.join(PLUGIN_DIR, 'agents/codex');

describe('sync-codex-agents.sh', () => {
  let tmpHome: string;
  let targetDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-sync-agents-'));
    targetDir = path.join(tmpHome, '.codex/agents');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('keeps experimental agent definitions out of the active palette by default', () => {
    const output = runSync();

    expect(output).toContain('Experimental Codex tiers disabled');
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('fails closed when enablement lacks catalog and named-role selector receipts', () => {
    expect(() => runSync({ TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS: 'true' })).toThrowError(
      /catalog.*named-role selector.*receipt/i,
    );
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('fails closed when default-off mode finds previously installed tier files', () => {
    runEnabledSync();

    expect(() => runSync()).toThrowError(/disabled.*installed.*remove/i);
    expect(fs.existsSync(path.join(targetDir, 'tmup-tier1.toml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'tmup-tier2.toml'))).toBe(true);
  });

  it('copies tmup custom agent definitions only after explicit post-canary enablement', () => {
    const output = runEnabledSync();

    expect(output).toContain('Synced 2 agent definition(s)');

    for (const fileName of ['tmup-tier1.toml', 'tmup-tier2.toml']) {
      const sourcePath = path.join(SOURCE_DIR, fileName);
      const targetPath = path.join(targetDir, fileName);

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(fs.readFileSync(sourcePath, 'utf-8'));
    }
  });

  it('installs only the exact owned tier list and ignores unrelated source TOMLs', () => {
    const sourceDir = path.join(tmpHome, 'source-with-unowned-file');
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const fileName of ['tmup-tier1.toml', 'tmup-tier2.toml']) {
      fs.copyFileSync(path.join(SOURCE_DIR, fileName), path.join(sourceDir, fileName));
    }
    fs.writeFileSync(path.join(sourceDir, 'unowned-future-role.toml'), 'name = "unowned"\n');

    const output = runEnabledSync({ TMUP_CODEX_AGENT_SOURCE_DIR: sourceDir });

    expect(output).toContain('Synced 2 agent definition(s)');
    expect(fs.existsSync(path.join(targetDir, 'unowned-future-role.toml'))).toBe(false);
    expect(fs.readFileSync(SYNC_CODEX_AGENTS_SH, 'utf-8')).not.toContain(
      'SOURCE_FILES=("$SOURCE_DIR"/*.toml)',
    );
  });

  it('is idempotent when the target files are already current', () => {
    runEnabledSync();

    const secondRunOutput = runEnabledSync();

    expect(secondRunOutput).toBe('Agent definitions up to date');
  });

  it('repairs drifted installed agent definitions even when the target file is newer', () => {
    runEnabledSync();

    const targetPath = path.join(targetDir, 'tmup-tier1.toml');
    fs.writeFileSync(targetPath, 'name = "drifted"\n');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(targetPath, future, future);

    const output = runEnabledSync();

    expect(output).toContain('Synced 1 agent definition(s)');
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe(
      fs.readFileSync(path.join(SOURCE_DIR, 'tmup-tier1.toml'), 'utf-8'),
    );
  });

  it('fails closed when an owned tmup agent definition is missing', () => {
    const emptySourceDir = path.join(tmpHome, 'empty-source');
    fs.mkdirSync(emptySourceDir, { recursive: true });

    expect(() => runEnabledSync({ TMUP_CODEX_AGENT_SOURCE_DIR: emptySourceDir })).toThrowError(
      /required tmup Codex agent definition missing/i,
    );
  });

  it('fails when the target directory is not writable', () => {
    const lockedTargetDir = path.join(tmpHome, 'locked-target');
    fs.mkdirSync(lockedTargetDir, { recursive: true });
    fs.chmodSync(lockedTargetDir, 0o500);

    try {
      expect(() => runEnabledSync({ TMUP_CODEX_AGENT_TARGET_DIR: lockedTargetDir })).toThrow();
    } finally {
      fs.chmodSync(lockedTargetDir, 0o700);
    }
  });

  it('rejects symlinked target definitions instead of following them', () => {
    const outsideFile = path.join(tmpHome, 'outside-agent.toml');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'outside-content\n');
    fs.symlinkSync(outsideFile, path.join(targetDir, 'tmup-tier1.toml'));

    expect(() => runEnabledSync()).toThrowError(/symlink/i);
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('outside-content\n');
  });

  function runSync(overrides: NodeJS.ProcessEnv = {}): string {
    return execFileSync('bash', [SYNC_CODEX_AGENTS_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        ...overrides,
      },
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  }

  function runEnabledSync(overrides: NodeJS.ProcessEnv = {}): string {
    return runSync({
      TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS: 'true',
      TMUP_CODEX_CATALOG_VALIDATION_RECEIPT: 'catalog-canary-pass',
      TMUP_CODEX_NAMED_ROLE_SELECTOR_RECEIPT: 'selector-canary-pass',
      ...overrides,
    });
  }
});
