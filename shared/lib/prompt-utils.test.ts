/**
 * Tests for prompt-utils.ts
 */

import { describe, test, expect } from 'vitest';
import { fillPromptTemplate, fillPromptTemplatePositional } from './prompt-utils.ts';

describe('fillPromptTemplate', () => {
  test('replaces single variable', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123: Fix login bug',
    });
    expect(result).toBe('Issue: HOK-123: Fix login bug');
  });

  test('replaces multiple variables', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123: Fix bug',
      CODEBASE_CONTEXT: 'Uses React',
    });
    expect(result).toBe('Issue: HOK-123: Fix bug\n\nCodebase: Uses React');
  });

  test('ignores undefined variables', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123',
    });
    expect(result).toBe('Issue: HOK-123\n\nCodebase: {{CODEBASE_CONTEXT}}');
  });

  test('handles empty string values', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: '',
    });
    expect(result).toBe('Issue: ');
  });

  test('is case-sensitive', () => {
    const template = 'Issue: {{issue_context}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123',
    });
    expect(result).toBe('Issue: {{issue_context}}'); // Not replaced
  });

  test('handles custom variable names', () => {
    const template = 'Custom: {{CUSTOM_VAR}}';
    const result = fillPromptTemplate(template, {
      CUSTOM_VAR: 'custom value',
    });
    expect(result).toBe('Custom: custom value');
  });

  test('replaces multiple occurrences of same variable', () => {
    const template = '{{ISSUE_CONTEXT}} and {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123',
    });
    expect(result).toBe('HOK-123 and HOK-123');
  });
});

describe('fillPromptTemplatePositional', () => {
  test('maps to ISSUE_CONTEXT by default', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'HOK-123', '');
    expect(result).toBe('Issue: HOK-123');
  });

  test('maps to INITIATIVE_CONTEXT when template uses it', () => {
    const template = 'Initiative: {{INITIATIVE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'Epic-456', '');
    expect(result).toBe('Initiative: Epic-456');
  });

  test('fills both issue and codebase context', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'HOK-123', 'Uses React');
    expect(result).toBe('Issue: HOK-123\n\nCodebase: Uses React');
  });

  test('handles missing codebase context (defaults to empty)', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'HOK-123');
    expect(result).toBe('Issue: HOK-123');
  });
});
