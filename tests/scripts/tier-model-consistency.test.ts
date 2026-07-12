import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const SOURCE_DIR = path.join(PLUGIN_DIR, 'agents/codex');

describe('Tier model consistency', () => {
  it('should ensure TOML models match policy.yaml single source of truth', () => {
    // Load policy.yaml
    const policyPath = path.join(PLUGIN_DIR, 'config/policy.yaml');
    const policy = yaml.load(fs.readFileSync(policyPath, 'utf-8')) as any;

    // Verify policy values are as expected (owner decision 2026-07-10: both worker tiers on gpt-5.5)
    expect(policy.codex.subagents.tiers.tier1.model).toBe('gpt-5.5');
    expect(policy.codex.subagents.tiers.tier2.model).toBe('gpt-5.5');

    // Check tier1
    const tier1Toml = fs.readFileSync(path.join(SOURCE_DIR, 'tmup-tier1.toml'), 'utf-8');
    const m1 = tier1Toml.match(/^model\s*=\s*"([^"]+)"/m);
    expect(m1?.[1]).toBe(policy.codex.subagents.tiers.tier1.model);

    // Check tier2
    const tier2Toml = fs.readFileSync(path.join(SOURCE_DIR, 'tmup-tier2.toml'), 'utf-8');
    const m2 = tier2Toml.match(/^model\s*=\s*"([^"]+)"/m);
    expect(m2?.[1]).toBe(policy.codex.subagents.tiers.tier2.model);
  });
});
