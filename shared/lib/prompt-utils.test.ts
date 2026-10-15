/**
 * Tests for prompt-utils.ts
 */

import { describe, test } from 'node:test';
import { expect } from './test-assertions.ts';
import { readFileSync } from 'node:fs';
import { fillPromptSlots, fillPromptTemplate, fillPromptTemplatePositional } from './prompt-utils.ts';
import { fillReviewPromptTemplate } from './review-engine.ts';

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

describe('fillPromptTemplate replacement patterns', () => {
  test('inserts $` and $& literally', () => {
    const result = fillPromptTemplate('A {{ISSUE_CONTEXT}} B', { ISSUE_CONTEXT: 'x $` y $& z' });
    expect(result).toBe('A x $` y $& z B');
  });
});

describe('fillPromptSlots', () => {
  test('inserts $`, $\' and $& literally instead of expanding them', () => {
    const template = 'prefix\n{{DIFF}}\n{{PLAN_CONTEXT}}\nsuffix';
    const result = fillPromptSlots(template, { DIFF: 'd $` d', PLAN_CONTEXT: "p $' $& p" });
    expect(result).toBe("prefix\nd $` d\np $' $& p\nsuffix");
  });

  test('fills the standalone slot, not inline mentions', () => {
    const template = '- `{{DIFF}}` - the diff\nOnly if `{{DIFF}}` exists\n\n{{DIFF}}\n';
    const result = fillPromptSlots(template, { DIFF: 'THE-DIFF' });
    expect(result).toBe('- `{{DIFF}}` - the diff\nOnly if `{{DIFF}}` exists\n\nTHE-DIFF\n');
  });

  test('falls back to the first inline occurrence when there is no standalone slot', () => {
    expect(fillPromptSlots('Packet: {{TASK_PACKET}} and {{TASK_PACKET}}', { TASK_PACKET: 'P' }))
      .toBe('Packet: P and {{TASK_PACKET}}');
  });

  test('does not substitute placeholders that appear inside filled values', () => {
    const template = '{{DIFF}}\n{{PLAN_CONTEXT}}';
    const result = fillPromptSlots(template, { DIFF: '+{{PLAN_CONTEXT}}\n{{PLAN_CONTEXT}}', PLAN_CONTEXT: 'PLAN' });
    expect(result).toBe('+{{PLAN_CONTEXT}}\n{{PLAN_CONTEXT}}\nPLAN');
  });

  test('review template: prompt size stays linear in input size when inputs contain $`', () => {
    // Regression: a 2.7 MB diff plus a plan and packet containing `$\`` produced a
    // 32 MB (8.2M-token) review prompt, failing review with native-context-window-exceeded.
    const template = readFileSync(new URL('../../tools/prompts/review-general.md', import.meta.url), 'utf8');
    const diff = `diff --git a/x.json b/x.json\n${'+  "value": 1,\n'.repeat(20_000)}`;
    const context = {
      diff,
      plan: 'Use `$`-prefixed keys like $`ref` and $` again',
      taskPacket: 'Packet with $` and $` and $&',
      designContext: null,
      metadata: { branch: 'b', files: [], lineCount: 0, hasUiChanges: false },
    };
    const prompt = fillReviewPromptTemplate(template, context as never, true);
    const overhead = template.length + context.plan.length + context.taskPacket.length;
    expect(prompt.length).toBe(overhead + diff.length - '{{DIFF}}{{PLAN_CONTEXT}}{{TASK_PACKET_CONTEXT}}{{DESIGN_CONTEXT}}'.length + 'null'.length);
    expect(prompt.split(diff).length - 1).toBe(1);
    expect(prompt).toContain('- **`{{DIFF}}`** (required)');
    expect(prompt.indexOf(diff)).toBeGreaterThan(template.indexOf('\n{{DIFF}}\n') - 1);
  });
});
