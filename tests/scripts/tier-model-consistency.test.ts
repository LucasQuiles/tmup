import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const SOURCE_DIR = path.join(PLUGIN_DIR, 'agents/codex');
const PANE_ROLE_FILES = [
  'implementer.md',
  'tester.md',
  'refactorer.md',
  'investigator.md',
  'documenter.md',
  'reviewer.md',
];
const RUNTIME_DOC_FILES = [
  'commands/tmup.md',
  'skills/tmup/SKILL.md',
  'skills/tmup/REFERENCE.md',
  'docs/CONFIGURATION.md',
];
const CAPABILITY_ROUTING_GUIDANCE = [
  'Native children inherit the pane model unless the live spawn schema explicitly exposes named-role selection.',
  'Task names do not select or pin a role or model.',
  'When named-role selection is available, `tmup-tier1` and `tmup-tier2` are direct leaves and must not delegate further.',
  'Without named-role selection, native children are same-model leaves; use a model-explicit Codex/tmup process or lane for a distinct model.',
  'Never claim model or tier selection without a runtime receipt.',
];
const RUNTIME_DOC_GUIDANCE = [
  'Fresh pane roots use the auto-detected Codex model (`codex.model: "auto"`).',
  'Context and compaction come from the resolved Codex model catalog; tmup does not override them.',
  'Pane roots use the `workspace-write` sandbox.',
  'Native subagent caps include `agents.max_depth=1`.',
  '`tmup-tier1` is the `gpt-5.6-terra` / high-reasoning leaf profile.',
  '`tmup-tier2` is the `gpt-5.6-luna` / medium-reasoning leaf profile.',
];

describe('Tier model consistency', () => {
  it('should ensure TOML models match policy.yaml single source of truth', () => {
    // Load policy.yaml
    const policyPath = path.join(PLUGIN_DIR, 'config/policy.yaml');
    const policy = yaml.load(fs.readFileSync(policyPath, 'utf-8')) as any;

    expect(policy.codex.subagents.max_depth).toBe(1);
    expect(policy.codex.subagents.tiers.tier1.model).toBe('gpt-5.6-terra');
    expect(policy.codex.subagents.tiers.tier2.model).toBe('gpt-5.6-luna');

    for (const file of ['tmup-tier1.toml', 'tmup-tier2.toml']) {
      const toml = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf-8');
      expect(toml).toContain('[features]');
      expect(toml).toMatch(/^multi_agent\s*=\s*false$/m);
      expect(toml).not.toMatch(/^sandbox_mode\s*=/m);
    }

    // Check tier1
    const tier1Toml = fs.readFileSync(path.join(SOURCE_DIR, 'tmup-tier1.toml'), 'utf-8');
    expect(tier1Toml).toContain('Do not delegate further.');
    expect(tier1Toml).not.toContain('spawn tmup-tier2');
    const m1 = tier1Toml.match(/^model\s*=\s*"([^"]+)"/m);
    expect(m1?.[1]).toBe(policy.codex.subagents.tiers.tier1.model);

    // Check tier2
    const tier2Toml = fs.readFileSync(path.join(SOURCE_DIR, 'tmup-tier2.toml'), 'utf-8');
    const m2 = tier2Toml.match(/^model\s*=\s*"([^"]+)"/m);
    expect(m2?.[1]).toBe(policy.codex.subagents.tiers.tier2.model);
  });

  it('keeps pane prompts and the generated Codex contract capability-aware', () => {
    const prompts = PANE_ROLE_FILES.map((file) => [
      file,
      fs.readFileSync(path.join(PLUGIN_DIR, 'agents', file), 'utf-8'),
    ] as const);
    const script = fs.readFileSync(path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh'), 'utf-8');
    expect(script).not.toContain('\\`tmup-tier1\\`');
    prompts.push([
      'scripts/dispatch-agent.sh',
      script,
    ]);

    for (const [file, prompt] of prompts) {
      expect(prompt, file).not.toMatch(/pane root may dispatch `tmup-tier|model pinning is preserved/i);
      for (const guidance of CAPABILITY_ROUTING_GUIDANCE) {
        expect(prompt, file).toContain(
          file === 'scripts/dispatch-agent.sh' ? guidance.replaceAll('`', '') : guidance,
        );
      }
    }
  });

  it('keeps tmup runtime docs aligned with reviewed capability and policy semantics', () => {
    for (const file of RUNTIME_DOC_FILES) {
      const markdown = fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf-8');

      expect(markdown, file).not.toMatch(
        /model_context_window|model_auto_compact_token_limit|features\.undo|danger-full-access|agents\.max_depth=2|runtime contract \(model, context, compaction|`tmup-tier[12]`[^\n]*`gpt-5\.5`/i,
      );
      for (const guidance of [...RUNTIME_DOC_GUIDANCE, ...CAPABILITY_ROUTING_GUIDANCE]) {
        expect(markdown, file).toContain(guidance);
      }
    }
  });
});
