import { describe, it, expect } from 'vitest';
import {
  PATTERN_REGISTRY,
  getPattern,
  validatePatternRoles,
  patternRequiresEvidence,
  listPatterns,
} from '../../shared/src/collaboration-patterns.js';
import type { CollaborationPattern } from '../../shared/src/types.js';

const ALL_PATTERN_NAMES: CollaborationPattern[] = [
  'research', 'plan', 'implement', 'review', 'test', 'audit', 'document',
];

describe('PATTERN_REGISTRY', () => {
  it('has exactly 7 patterns', () => {
    expect(PATTERN_REGISTRY).toHaveLength(7);
  });

  it('all pattern names match the CollaborationPattern type union', () => {
    const registryNames = PATTERN_REGISTRY.map(p => p.name);
    expect(registryNames.sort()).toEqual([...ALL_PATTERN_NAMES].sort());
  });
});

describe('getPattern', () => {
  it.each(ALL_PATTERN_NAMES)('returns correct pattern for "%s"', (name) => {
    const pattern = getPattern(name);
    expect(pattern).toBeDefined();
    expect(pattern!.name).toBe(name);
  });

  it('returns undefined for unknown name', () => {
    const result = getPattern('nonexistent' as CollaborationPattern);
    expect(result).toBeUndefined();
  });
});

describe('validatePatternRoles', () => {
  it('valid when all required roles present', () => {
    const pattern = getPattern('plan')!;
    // plan requires ['investigator', 'reviewer']
    const result = validatePatternRoles(pattern, ['investigator', 'reviewer', 'extra']);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('invalid with missing roles, returns missing list', () => {
    const pattern = getPattern('plan')!;
    const result = validatePatternRoles(pattern, ['investigator']);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['reviewer']);
  });

  it('invalid when no roles provided', () => {
    const pattern = getPattern('implement')!;
    const result = validatePatternRoles(pattern, []);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['implementer']);
  });
});

describe('patternRequiresEvidence', () => {
  it.each(['implement', 'review', 'test', 'audit'] as CollaborationPattern[])(
    'returns true for "%s"',
    (name) => {
      expect(patternRequiresEvidence(name)).toBe(true);
    },
  );

  it.each(['research', 'plan', 'document'] as CollaborationPattern[])(
    'returns false for "%s"',
    (name) => {
      expect(patternRequiresEvidence(name)).toBe(false);
    },
  );

  it('returns false for unknown pattern name', () => {
    expect(patternRequiresEvidence('nonexistent' as CollaborationPattern)).toBe(false);
  });
});

describe('listPatterns', () => {
  it('returns all 7 pattern names', () => {
    const names = listPatterns();
    expect(names).toHaveLength(7);
    expect(names.sort()).toEqual([...ALL_PATTERN_NAMES].sort());
  });
});

describe('each pattern definition', () => {
  it.each(PATTERN_REGISTRY.map(p => [p.name, p] as const))(
    '"%s" has non-empty description',
    (_name, pattern) => {
      expect(pattern.description.length).toBeGreaterThan(0);
    },
  );

  it.each(PATTERN_REGISTRY.map(p => [p.name, p] as const))(
    '"%s" has at least 1 required_role',
    (_name, pattern) => {
      expect(pattern.required_roles.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(PATTERN_REGISTRY.map(p => [p.name, p] as const))(
    '"%s" has required_passes >= 1',
    (_name, pattern) => {
      expect(pattern.required_passes).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(PATTERN_REGISTRY.map(p => [p.name, p] as const))(
    '"%s" has valid approval_authority',
    (_name, pattern) => {
      expect(['lead', 'reviewer', 'any']).toContain(pattern.approval_authority);
    },
  );

  it.each(PATTERN_REGISTRY.map(p => [p.name, p] as const))(
    '"%s" has valid retry_policy',
    (_name, pattern) => {
      expect(['auto', 'manual', 'none']).toContain(pattern.retry_policy);
    },
  );
});
