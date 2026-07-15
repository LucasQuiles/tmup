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

function expectCapabilityRouting(text: string, file: string): void {
  expect(text, file).toMatch(/native children inherit the pane model/i);
  expect(text, file).toMatch(/spawn schema[^\n]*named-role selection/i);
  expect(text, file).toMatch(/task names do not[^\n]*(?:select|pin)[^\n]*(?:role|model)/i);
  expect(text, file).toMatch(/named-role selection[^\n]*tmup-tier1[^\n]*tmup-tier2[^\n]*leaves/i);
  expect(text, file).toMatch(/without named-role selection[^\n]*same-model leaves/i);
  expect(text, file).toMatch(/model-explicit Codex\/tmup process or lane/i);
  expect(text, file).toMatch(/runtime receipt/i);
}

function expectCurrentRuntimeDoc(text: string, file: string): void {
  expect(text, file).toMatch(/auto-detected Codex model/i);
  expect(text, file).toMatch(/context and compaction[^\n]*resolved Codex model catalog/i);
  expect(text, file).toMatch(/workspace-write/i);
  expect(text, file).toMatch(/max_depth(?:=|:\s*)1/i);
  expect(text, file).toMatch(/tmup-tier1[^\n]*gpt-5\.6-terra[^\n]*high/i);
  expect(text, file).toMatch(/tmup-tier2[^\n]*gpt-5\.6-luna[^\n]*medium/i);
}

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
      expectCapabilityRouting(prompt, file);
    }
  });

  it('keeps tmup runtime docs aligned with reviewed capability and policy semantics', () => {
    for (const file of RUNTIME_DOC_FILES) {
      const markdown = fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf-8');

      expect(markdown, file).not.toMatch(
        /model_context_window|model_auto_compact_token_limit|features\.undo|danger-full-access|agents\.max_depth=2|runtime contract \(model, context, compaction|`tmup-tier[12]`[^\n]*`gpt-5\.5`/i,
      );
      expectCurrentRuntimeDoc(markdown, file);
      expectCapabilityRouting(markdown, file);
    }
  });

  it('keeps active user docs and the archival trace consistent with current runtime semantics', () => {
    const readme = fs.readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf-8');
    expect(readme).not.toMatch(/up to 1M context|delegates might delegate|each potentially nesting more/i);
    expect(readme).not.toMatch(/\|\s*(?:Opus|Sonnet)[^\n]*\*\*\d+(?:\.\d+)?M tokens\*\*/i);
    expect(readme).toMatch(/native children inherit[^\n]*pane model/i);
    expect(readme).toMatch(/max_depth(?:=|:\s*)1/i);
    expect(readme).toMatch(/context[^\n]*resolved Codex model catalog/i);

    const faq = fs.readFileSync(path.join(PLUGIN_DIR, 'docs/FAQ.md'), 'utf-8');
    expect(faq).not.toMatch(/danger-full-access|unsandboxed|full disk|up to 1M tokens|GPT-5\.4/i);
    expect(faq).toMatch(/workspace-write/i);
    expect(faq).toMatch(/--add-dir[^\n]*session/i);
    expect(faq).toMatch(/resolved Codex model catalog/i);

    const architecture = fs.readFileSync(path.join(PLUGIN_DIR, 'docs/ARCHITECTURE.md'), 'utf-8');
    expect(architecture).not.toMatch(/full disk access/i);
    expect(architecture).toMatch(/workspace-write/i);
    expect(architecture).toMatch(/--add-dir[^\n]*session/i);

    const traceHead = fs.readFileSync(path.join(PLUGIN_DIR, 'reports/dispatch-flow-trace.md'), 'utf-8')
      .split('\n')
      .slice(0, 12)
      .join('\n');
    expect(traceHead).toMatch(/status:\s*archival/i);
    expect(traceHead).toMatch(/not current/i);
    expect(traceHead).toMatch(/20\d{2}-\d{2}-\d{2}/);
  });
});
