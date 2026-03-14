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
export declare const PATTERN_REGISTRY: readonly PatternDefinition[];
/**
 * Get a pattern definition by name.
 */
export declare function getPattern(name: CollaborationPattern): PatternDefinition | undefined;
/**
 * Validate that a set of roles satisfies a pattern's requirements.
 */
export declare function validatePatternRoles(pattern: PatternDefinition, availableRoles: string[]): {
    valid: boolean;
    missing: string[];
};
/**
 * Check if a pattern requires evidence before completion.
 */
export declare function patternRequiresEvidence(name: CollaborationPattern): boolean;
/**
 * Get all pattern names.
 */
export declare function listPatterns(): CollaborationPattern[];
//# sourceMappingURL=collaboration-patterns.d.ts.map