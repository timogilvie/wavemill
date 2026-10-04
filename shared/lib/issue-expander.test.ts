import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appendAuthoredLinksFooter,
  buildIssueExpansionCallOptions,
  enforcePacketBudget,
  expandIssue,
  extractAuthoredLinksFooter,
  parseIssueInput,
} from './issue-expander.ts';
import { NativeExpansionUnavailableError } from './native-expansion.ts';

function makeRepo(config?: unknown): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'issue-expander-test-'));
  if (config) {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
  }
  return repoDir;
}

describe('issue-expander', () => {
  it('uses cliCmd for explicit Claude command overrides', () => {
    const options = buildIssueExpansionCallOptions('/custom/claude');
    assert.equal(options.cliCmd, '/custom/claude');
    assert.equal(options.mode, 'stream');
    assert.ok(options.cliFlags?.includes('--append-system-prompt'));
  });

  it('uses durable Claude settings for packet expansion', () => {
    const options = buildIssueExpansionCallOptions('/custom/claude');
    assert.equal(options.taskType, 'planning');
    assert.equal(options.retry, true);
    assert.equal(options.maxRetries, 2);
    assert.equal(options.timeout, 600_000);
    assert.equal(options.activityTimeout, undefined);
    assert.equal(options.maxBuffer, 50 * 1024 * 1024);
  });

  it('falls back to CLAUDE_CMD when no explicit override is provided', () => {
    const original = process.env.CLAUDE_CMD;
    process.env.CLAUDE_CMD = '/env/claude';

    try {
      const options = buildIssueExpansionCallOptions();
      assert.equal(options.cliCmd, '/env/claude');
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_CMD;
      } else {
        process.env.CLAUDE_CMD = original;
      }
    }
  });

  it('parseIssueInput accepts canonical identifiers', () => {
    assert.equal(parseIssueInput('HOK-1494'), 'HOK-1494');
  });

  it('parseIssueInput canonicalizes lowercase identifiers', () => {
    assert.equal(parseIssueInput('hok-1494'), 'HOK-1494');
  });

  it('parseIssueInput trims surrounding whitespace', () => {
    assert.equal(parseIssueInput(' HOK-1494 '), 'HOK-1494');
  });

  it('extracts a trailing authored links footer verbatim', () => {
    const footer = [
      '---',
      '## Program Links',
      '',
      '- [Program brief](https://example.com/brief)',
      '- [Plan of record](https://example.com/plan)',
    ].join('\n');
    const description = `Human-authored context\n\n${footer}`;

    const result = extractAuthoredLinksFooter(description);

    assert.equal(result.body, 'Human-authored context\n\n');
    assert.equal(result.footer, footer);
  });

  it('appends an authored links footer exactly once at the end', () => {
    const footer = '---\n## Links & Context\n\n- [Design doc](https://example.com/design)';
    const generated = '# Task Packet\n\nGenerated details.\n';

    const result = appendAuthoredLinksFooter(generated, footer);

    assert.equal(
      result,
      '# Task Packet\n\nGenerated details.\n\n---\n## Links & Context\n\n- [Design doc](https://example.com/design)'
    );
    assert.equal(appendAuthoredLinksFooter(result, footer), result);
  });

  it('does not extract a footer when the links block convention is absent', () => {
    const description = 'Human-authored context\n\n## Program Links\n\n- https://example.com';

    const result = extractAuthoredLinksFooter(description);

    assert.equal(result.body, description);
    assert.equal(result.footer, null);
  });

  it('does not extract a delimiter that is not immediately followed by a links heading', () => {
    const description = [
      'Human-authored context',
      '',
      '---',
      '',
      '## Program Links',
      '',
      '- https://example.com',
    ].join('\n');

    const result = extractAuthoredLinksFooter(description);

    assert.equal(result.body, description);
    assert.equal(result.footer, null);
  });

  it('enforces packet budgets by preserving core sections and truncating the tail', () => {
    const packet = [
      '# Task Packet',
      '',
      '## Detailed Sections',
      '| Section | Purpose |',
      '| - | - |',
      '| Objective | Keep |',
      '',
      '## Objective',
      'Build the thing.',
      '',
      '## Technical Context',
      'x'.repeat(1_000),
      '',
      '## Implementation Approach',
      'y'.repeat(1_000),
      '',
      '## Success Criteria',
      'z'.repeat(1_000),
      '',
      '## Extra Evidence',
      'tail should be removed '.repeat(1_000),
    ].join('\n');

    const result = enforcePacketBudget(packet, { maxPacketTokens: 260 });

    assert.equal(result.truncated, true);
    assert.ok(result.originalTokens > result.retainedTokens);
    assert.match(result.markdown, /## Objective/);
    assert.match(result.markdown, /## Technical Context/);
    assert.match(result.markdown, /\[\.\.\. truncated for context budget \.\.\.\]/);
    assert.doesNotMatch(result.markdown, /Extra Evidence/);
  });

  it('leaves packets under budget unchanged', () => {
    const packet = '# Task Packet\n\n## Objective\n\nSmall.';

    const result = enforcePacketBudget(packet, { maxPacketTokens: 10_000 });

    assert.equal(result.truncated, false);
    assert.equal(result.markdown, packet);
  });

  it('extracts only the applicable trailing footer when multiple separators exist', () => {
    const description = [
      'Human-authored context',
      '',
      '---',
      '## Not Links',
      '',
      'Keep this in the LLM input.',
      '',
      '---',
      '## Program Links',
      '',
      '- [Plan](https://example.com/plan)',
    ].join('\n');

    const result = extractAuthoredLinksFooter(description);

    assert.equal(
      result.body,
      [
        'Human-authored context',
        '',
        '---',
        '## Not Links',
        '',
        'Keep this in the LLM input.',
        '',
        '',
      ].join('\n')
    );
    assert.equal(
      result.footer,
      '---\n## Program Links\n\n- [Plan](https://example.com/plan)'
    );
  });

  it('parseIssueInput accepts Linear issue URLs', () => {
    assert.equal(
      parseIssueInput('https://linear.app/hokusai/issue/HOK-1494/fix'),
      'HOK-1494'
    );
  });

  it('parseIssueInput accepts case-insensitive Linear issue URLs', () => {
    assert.equal(
      parseIssueInput('https://Linear.App/hokusai/issue/hok-1494/fix'),
      'HOK-1494'
    );
  });

  it('parseIssueInput accepts a digit-bearing team key', () => {
    assert.equal(parseIssueInput('ab2-1'), 'AB2-1');
    assert.equal(parseIssueInput('https://linear.app/team/issue/ab2-1/slug'), 'AB2-1');
  });

  for (const invalidInput of [
    'FOOBAR',
    'HOK-',
    'HOK-1494/extra',
    'https://example.com/HOK-1494',
    '',
    '   ',
  ]) {
    it(`parseIssueInput rejects invalid input: ${JSON.stringify(invalidInput)}`, () => {
      assert.throws(
        () => parseIssueInput(invalidInput),
        /Expected format: TEAM-123 or Linear issue URL/
      );
    });
  }

  it('expandIssue uses Claude path when native expansion is disabled', async () => {
    const repoDir = makeRepo();
    const calls: string[] = [];
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => {
          calls.push('claude');
          return 'claude result';
        },
        importNativeExpansion: async () => {
          throw new Error('native module should not be imported');
        },
      });

      assert.equal(result.text, 'claude result');
      assert.deepEqual(calls, ['claude']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue uses native path when task expansion is enabled', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        providers: {
          openai: {},
        },
      },
    });
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        importNativeExpansion: async () => ({
          NativeExpansionUnavailableError,
          runNativeExpansion: async () => ({
            text: 'native result',
            native: {
              agent: 'native-openai',
              model: 'gpt-4o',
              provider: 'openai',
              api: 'openai-responses',
              transcriptPath: '/tmp/native.jsonl',
              cost: 0,
              durationMs: 1,
              stopReason: 'stop',
              totalInputTokens: 1,
              totalOutputTokens: 1,
              deniedToolCalls: [],
            },
          }),
        }),
      });

      assert.equal(result.text, 'native result');
      assert.equal(result.native?.agent, 'native-openai');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue rolls back to Claude when nativeAgent is enabled but task-expansion is removed from allowedPhases', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning', 'review'],
        providers: {
          openai: {},
        },
      },
    });
    const calls: string[] = [];
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => {
          calls.push('claude');
          return 'claude rollback';
        },
        importNativeExpansion: async () => {
          throw new Error('native module should not be imported when task-expansion is disabled');
        },
      });

      assert.equal(result.text, 'claude rollback');
      assert.deepEqual(calls, ['claude']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue falls back to Claude when native prerequisites are unavailable and fallback is enabled', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        expansion: {
          fallbackOnUnavailable: true,
        },
        providers: {
          openai: {},
        },
      },
    });
    const error = new NativeExpansionUnavailableError('missing_key', 'OPENAI_API_KEY is not set');
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => 'claude fallback',
        importNativeExpansion: async () => ({
          NativeExpansionUnavailableError,
          runNativeExpansion: async () => {
            throw error;
          },
        }),
      });

      assert.equal(result.text, 'claude fallback');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue rethrows native prerequisite failures when fallback is disabled', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        providers: {
          openai: {},
        },
      },
    });
    const error = new NativeExpansionUnavailableError('uncertified', 'model is uncertified');
    try {
      await assert.rejects(
        () => expandIssue({
          promptTemplate: 'prompt',
          issueContext: 'issue',
          repoDir,
        }, {
          importNativeExpansion: async () => ({
            NativeExpansionUnavailableError,
            runNativeExpansion: async () => {
              throw error;
            },
          }),
        }),
        /uncertified/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
