import { describe, expect, it } from 'vitest';
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

function bodyAfterFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match?.[1] ?? markdown;
}

function expectCapabilityRouting(text: string, file: string): void {
  expect(text, file).toMatch(/native children inherit the pane model/i);
  expect(text, file).toMatch(/spawn schema[^\n]*named-role selection/i);
  expect(text, file).toMatch(/task names do not[^\n]*(?:select|pin)[^\n]*(?:role|model)/i);
  expect(text, file).toMatch(/without named-role selection[^\n]*same-model leaves/i);
  expect(text, file).toMatch(/model-explicit Codex\/tmup process or lane/i);
  expect(text, file).toMatch(/runtime receipt/i);
}

function expectSafeRuntimeDoc(text: string, file: string): void {
  expect(text, file).toMatch(/codex\.model[^\n]*auto[^\n]*omit[^\n]*-m/i);
  expect(text, file).toMatch(/explicit_model_pins_enabled/i);
  expect(text, file).toMatch(/model-validation-receipt/i);
  expect(text, file).toMatch(/CODEX_BIN/i);
  expect(text, file).toMatch(/\.local\/bin\/codex/i);
  expect(text, file).toMatch(/workspace-write/i);
  expect(text, file).toMatch(/sandbox_workspace_write\.network_access=false/i);
  expect(text, file).toMatch(/mediated[^\n]*web search/i);
  expect(text, file).toMatch(/exclude_slash_tmp=true/i);
  expect(text, file).toMatch(/exclude_tmpdir_env_var=true/i);
  expect(text, file).toMatch(/only extra[^\n]*--add-dir[^\n]*exact[^\n]*task temp/i);
  expect(text, file).toMatch(/prompt[^\n]*launcher[^\n]*(?:log|artifact)[^\n]*outside[^\n]*(?:working|session|task)/i);
  expect(text, file).toMatch(/0600/i);
  expect(text, file).toMatch(/0700/i);
  expect(text, file).toMatch(/hash/i);
  expect(text, file).toMatch(/does not (?:set|expose)[^\n]*TMUP_DB[^\n]*TMUP_SESSION_DIR/i);
  expect(text, file).toMatch(/owns[^\n]*(?:claim|claims)/i);
  expect(text, file).toMatch(/prompts?[^\n]*do(?:es)? not advertise[^\n]*tmup-cli/i);
  expect(text, file).toMatch(/trusted shared state[^\n]*direct-dispatch-only/i);
  expect(text, file).toMatch(/codex\.trusted_shared_state_enabled/i);
  expect(text, file).toMatch(/--trusted-shared-state-receipt/i);
  expect(text, file).toMatch(/claude_code\.trusted_unsandboxed_enabled/i);
  expect(text, file).toMatch(/--allow-unconfined-claude-code/i);
  expect(text, file).toMatch(/--claude-code-trust-receipt/i);
  expect(text, file).toMatch(/outside[^\n]*Codex (?:sandbox )?(?:boundary|guarantee)/i);
  expect(text, file).toMatch(/deterministic[^\n]*(?:task temp|task-temp)[^\n]*(?:controller|protected)[^\n]*boundar/i);
  expect(text, file).toMatch(/host[^\n]*release[^\n]*live sandbox canar(?:y|ies)[^\n]*(?:pending|remain pending)/i);
  expect(text, file).toMatch(/dispatch(?:er)? does not activate or advertise/i);
  expect(text, file).toMatch(/agents\.max_depth(?:=|:)1/i);
  expect(text, file).toMatch(/job_max_runtime_seconds[^\n]*spawn_agents_on_csv[^\n]*batch jobs/i);
  expect(text, file).toMatch(/(?:native-child )?admission[^\n]*pane-local[^\n]*(?:not shared|rather than shared)/i);
  expectCapabilityRouting(text, file);
}

describe('Codex orchestration contract consistency', () => {
  it('keeps dormant TOML models aligned with policy and all unsafe modes default-off', () => {
    const policyPath = path.join(PLUGIN_DIR, 'config/policy.yaml');
    const policyText = fs.readFileSync(policyPath, 'utf-8');
    const policy = yaml.load(policyText) as any;

    expect(policy.codex.model).toBe('auto');
    expect(policy.codex.explicit_model_pins_enabled).toBe(false);
    expect(policy.codex.trusted_shared_state_enabled).toBe(false);
    expect(policy.codex.shell_env_inherit).toBe('core');
    expect(policy.codex.sandbox).toBe('workspace-write');
    expect(policy.claude_code.trusted_unsandboxed_enabled).toBe(false);
    expect(policy.codex.subagents.max_depth).toBe(1);
    const tier1Model = policy.codex.subagents.tiers.tier1.model;
    const tier2Model = policy.codex.subagents.tiers.tier2.model;
    expect(typeof tier1Model).toBe('string');
    expect(tier1Model.trim()).not.toBe('');
    expect(typeof tier2Model).toBe('string');
    expect(tier2Model.trim()).not.toBe('');
    expect(policyText).not.toContain('model_preference');

    for (const [file, expectedModel] of [
      ['tmup-tier1.toml', policy.codex.subagents.tiers.tier1.model],
      ['tmup-tier2.toml', policy.codex.subagents.tiers.tier2.model],
    ] as const) {
      const toml = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf-8');
      expect(toml, file).toContain('[features]');
      expect(toml, file).toMatch(/^multi_agent\s*=\s*false$/m);
      expect(toml, file).not.toMatch(/^sandbox_mode\s*=/m);
      expect(toml, file).toMatch(/experimental adapter metadata/i);
      expect(toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1], file).toBe(expectedModel);
    }
  });

  it('keeps role bodies compact and runtime-neutral while the dispatcher owns runtime semantics', () => {
    for (const file of PANE_ROLE_FILES) {
      const body = bodyAfterFrontmatter(
        fs.readFileSync(path.join(PLUGIN_DIR, 'agents', file), 'utf-8'),
      );
      for (const heading of ['Mission', 'Workflow', 'Constraints', 'Deliverable']) {
        expect(body, file).toContain(`## ${heading}`);
      }
      expect(body.split('\n').length, file).toBeLessThan(45);
      expect(body, file).not.toMatch(
        /Codex|Claude Code|tmup-cli|TMUP_DB|TMUP_SESSION_DIR|tmup-tier|max_threads|max_depth|native child|named-role|model-explicit/i,
      );
    }

    const script = fs.readFileSync(path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh'), 'utf-8');
    expect(script).not.toMatch(
      /TMUP_ENABLE_EXPERIMENTAL_CODEX_TIERS|TMUP_CODEX_CATALOG_VALIDATION_RECEIPT|TMUP_CODEX_NAMED_ROLE_SELECTOR_RECEIPT|EXPERIMENTAL_TIER_CONTRACT/,
    );
    expect(script).toMatch(/tmup omits -m[^\n]*installed Codex CLI resolves/i);
    expect(script).toMatch(/Coordination Mode — SUPERVISOR OWNED/i);
    expect(script).toMatch(/Direct tmup SQLite[^\n]*tmup-cli lifecycle writes[^\n]*unavailable/i);
    expect(script).toContain('sandbox_workspace_write.network_access=false');
    expect(script).toContain('--add-dir "\\$TMUP_TASK_TMPDIR"');
    expect(script).toContain('--trusted-shared-state-receipt');
    expect(script).toContain('--allow-unconfined-claude-code');
    expect(script).toContain('--model-validation-receipt');
  });

  it('keeps all runtime documents aligned with the safe-default and explicit escape hatches', () => {
    for (const file of RUNTIME_DOC_FILES) {
      const markdown = fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf-8');
      expect(markdown, file).not.toMatch(
        /auto-detected Codex model|session directory[^\n]*only additional[^\n]*--add-dir|positive sandbox write[^\n]*(?:unproven|pending)|model_preference/i,
      );
      expectSafeRuntimeDoc(markdown, file);
    }
  });

  it('keeps user-facing boundary docs current and the old dispatch trace explicitly archival', () => {
    const readme = fs.readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf-8');
    expect(readme).toMatch(/safe default[^\n]*supervisor owns/i);
    expect(readme).toMatch(/only extra[^\n]*--add-dir[^\n]*exact[^\n]*task temp/i);
    expect(readme).toMatch(/MCP path[^\n]*supports only the safe Codex lane/i);
    expect(readme).toMatch(/Static `tmup-tier1`[^\n]*remain dormant[^\n]*default-off/i);

    const faq = fs.readFileSync(path.join(PLUGIN_DIR, 'docs/FAQ.md'), 'utf-8');
    expect(faq).toMatch(/Safe Codex workers do not receive shared session state/i);
    expect(faq).toMatch(/Controller artifacts are separate/i);
    expect(faq).toMatch(/Sandbox observations are runtime-specific/i);
    expect(faq).toMatch(/Trusted modes are direct-only escape hatches/i);

    const architecture = fs.readFileSync(path.join(PLUGIN_DIR, 'docs/ARCHITECTURE.md'), 'utf-8');
    expect(architecture).toMatch(/Controller-owned coordination state/i);
    expect(architecture).toMatch(/Codex Workers \(safe default\)/i);
    expect(architecture).toMatch(/direct-only escape hatches/i);
    expect(architecture).toMatch(/advisory supervisor-routing policy/i);

    const configuration = fs.readFileSync(path.join(PLUGIN_DIR, 'docs/CONFIGURATION.md'), 'utf-8');
    expect(configuration).toMatch(/autonomy tiers[\s\S]*not mechanically enforce/i);

    const traceHead = fs.readFileSync(path.join(PLUGIN_DIR, 'reports/dispatch-flow-trace.md'), 'utf-8')
      .split('\n')
      .slice(0, 12)
      .join('\n');
    expect(traceHead).toMatch(/status:\s*archival/i);
    expect(traceHead).toMatch(/not current/i);
    expect(traceHead).toMatch(/20\d{2}-\d{2}-\d{2}/);
  });
});
