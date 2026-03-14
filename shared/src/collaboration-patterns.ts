/**
 * Collaboration pattern registry: reusable workflow patterns for tmup coordination.
 *
 * P5.6: instead of inventing one workflow per use case, patterns declare
 * required roles, passes, evidence, and approval authority.
 *
 * Pattern selection is explicit on plans/tasks — not inferred from free text.
 */
import type { CollaborationPattern } from './types.js';

export interface PatternDefinition {
  name: CollaborationPattern;
  description: string;
  required_roles: string[];
  required_passes: number;
  requires_evidence: boolean;
  approval_authority: 'lead' | 'reviewer' | 'any';
  retry_policy: 'auto' | 'manual' | 'none';
  escalation_target: 'lead' | 'reviewer' | null;
}

/**
 * The canonical pattern registry.
 * Each pattern defines the minimum collaborative contract for that workflow type.
 */
export const PATTERN_REGISTRY: readonly PatternDefinition[] = [
  {
    name: 'research',
    description: 'Investigate and report findings without code changes',
    required_roles: ['investigator'],
    required_passes: 1,
    requires_evidence: false,
    approval_authority: 'lead',
    retry_policy: 'manual',
    escalation_target: 'lead',
  },
  {
    name: 'plan',
    description: 'Design and challenge an implementation approach before execution',
    required_roles: ['investigator', 'reviewer'],
    required_passes: 2,  // Initial proposal + challenge pass
    requires_evidence: false,
    approval_authority: 'reviewer',
    retry_policy: 'manual',
    escalation_target: 'lead',
  },
  {
    name: 'implement',
    description: 'Write production code with test evidence',
    required_roles: ['implementer'],
    required_passes: 1,
    requires_evidence: true,
    approval_authority: 'reviewer',
    retry_policy: 'auto',
    escalation_target: 'reviewer',
  },
  {
    name: 'review',
    description: 'Review code or artifacts for quality, correctness, and standards',
    required_roles: ['reviewer'],
    required_passes: 1,
    requires_evidence: true,
    approval_authority: 'lead',
    retry_policy: 'none',
    escalation_target: 'lead',
  },
  {
    name: 'test',
    description: 'Write and run tests to verify behavior',
    required_roles: ['tester'],
    required_passes: 1,
    requires_evidence: true,
    approval_authority: 'reviewer',
    retry_policy: 'auto',
    escalation_target: 'reviewer',
  },
  {
    name: 'audit',
    description: 'Verify compliance, security, or process adherence',
    required_roles: ['reviewer'],
    required_passes: 1,
    requires_evidence: true,
    approval_authority: 'lead',
    retry_policy: 'none',
    escalation_target: 'lead',
  },
  {
    name: 'document',
    description: 'Write documentation, guides, or API references',
    required_roles: ['documenter'],
    required_passes: 1,
    requires_evidence: false,
    approval_authority: 'reviewer',
    retry_policy: 'manual',
    escalation_target: 'reviewer',
  },
] as const;

/**
 * Get a pattern definition by name.
 */
export function getPattern(name: CollaborationPattern): PatternDefinition | undefined {
  return PATTERN_REGISTRY.find(p => p.name === name);
}

/**
 * Validate that a set of roles satisfies a pattern's requirements.
 */
export function validatePatternRoles(
  pattern: PatternDefinition,
  availableRoles: string[]
): { valid: boolean; missing: string[] } {
  const missing = pattern.required_roles.filter(r => !availableRoles.includes(r));
  return { valid: missing.length === 0, missing };
}

/**
 * Check if a pattern requires evidence before completion.
 */
export function patternRequiresEvidence(name: CollaborationPattern): boolean {
  const pattern = getPattern(name);
  return pattern?.requires_evidence ?? false;
}

/**
 * Get all pattern names.
 */
export function listPatterns(): CollaborationPattern[] {
  return PATTERN_REGISTRY.map(p => p.name);
}
