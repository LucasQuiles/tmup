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

  it('copies tmup custom agent definitions into ~/.codex/agents', () => {
    const output = runSync();

    expect(output).toContain('Synced 2 agent definition(s)');

    for (const fileName of ['tmup-tier1.toml', 'tmup-tier2.toml']) {
      const sourcePath = path.join(SOURCE_DIR, fileName);
      const targetPath = path.join(targetDir, fileName);

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(fs.readFileSync(sourcePath, 'utf-8'));
    }
  });

  it('is idempotent when the target files are already current', () => {
    runSync();

    const secondRunOutput = runSync();

    expect(secondRunOutput).toBe('Agent definitions up to date');
  });

  it('repairs drifted installed agent definitions even when the target file is newer', () => {
    runSync();

    const targetPath = path.join(targetDir, 'tmup-tier1.toml');
    fs.writeFileSync(targetPath, 'name = "drifted"\n');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(targetPath, future, future);

    const output = runSync();

    expect(output).toContain('Synced 1 agent definition(s)');
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe(
      fs.readFileSync(path.join(SOURCE_DIR, 'tmup-tier1.toml'), 'utf-8'),
    );
  });

  it('fails closed when the source directory has no tmup agent definitions', () => {
    const emptySourceDir = path.join(tmpHome, 'empty-source');
    fs.mkdirSync(emptySourceDir, { recursive: true });

    expect(() => runSync({ TMUP_CODEX_AGENT_SOURCE_DIR: emptySourceDir })).toThrowError(
      /no tmup Codex agent definitions found/i,
    );
  });

  it('fails when the target directory is not writable', () => {
    const lockedTargetDir = path.join(tmpHome, 'locked-target');
    fs.mkdirSync(lockedTargetDir, { recursive: true });
    fs.chmodSync(lockedTargetDir, 0o500);

    try {
      expect(() => runSync({ TMUP_CODEX_AGENT_TARGET_DIR: lockedTargetDir })).toThrow();
    } finally {
      fs.chmodSync(lockedTargetDir, 0o700);
    }
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
});
