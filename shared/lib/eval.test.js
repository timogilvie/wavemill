import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from './eval.js';

let originalFetch;

function mockFetch(responseText, status = 200) {
  globalThis.fetch = mock.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () =>
        Promise.resolve({
          content: [{ type: 'text', text: responseText }],
        }),
      text: () => Promise.resolve(responseText),
    })
  );
}

describe('evaluateTask', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns a valid EvalRecord conforming to eval-schema', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Task was completed successfully with clean implementation.',
      interventionFlags: [],
    });
    mockFetch(validResponse);

    const result = await evaluateTask({
      taskPrompt: 'Add a loading spinner',
      prReviewOutput: 'Clean diff, all tests pass',
      issueId: 'HOK-100',
    });

    // Core EvalRecord fields from eval-schema.ts
    assert.ok(result.id, 'should have a UUID id');
    assert.equal(result.schemaVersion, '1.0.0');
    assert.equal(result.originalPrompt, 'Add a loading spinner');
    assert.ok(result.modelId);
    assert.ok(result.modelVersion);
    assert.equal(result.score, 0.85);
    assert.equal(result.scoreBand, 'Minor Feedback');
    assert.equal(typeof result.timeSeconds, 'number');
    assert.ok(new Date(result.timestamp).toISOString() === result.timestamp);
    assert.equal(result.interventionRequired, false);
    assert.equal(result.interventionCount, 0);
    assert.deepEqual(result.interventionDetails, []);
    assert.equal(result.rationale, 'Task was completed successfully with clean implementation.');
    assert.equal(result.issueId, 'HOK-100');
  });

  it('derives correct score band from eval-schema rubric', async () => {
    const validResponse = JSON.stringify({
      score: 1.0,
      rationale: 'Perfect autonomous execution.',
      interventionFlags: [],
    });
    mockFetch(validResponse);

    const result = await evaluateTask({
      taskPrompt: 'Simple task',
      prReviewOutput: 'Flawless',
    });

    assert.equal(result.scoreBand, 'Full Success');
  });

  it('passes intervention metadata through to the result', async () => {
    const validResponse = JSON.stringify({
      score: 0.6,
      rationale: 'Task completed but required guidance.',
      interventionFlags: ['needed-design-guidance'],
    });
    mockFetch(validResponse);

    const result = await evaluateTask({
      taskPrompt: 'Build a dashboard',
      prReviewOutput: 'Implementation works but needed corrections',
      interventions: [
        { description: 'Corrected component structure', severity: 'major' },
        { description: 'Fixed import path', severity: 'minor' },
      ],
      issueId: 'HOK-200',
    });

    assert.equal(result.interventionRequired, true);
    assert.equal(result.interventionCount, 2);
    assert.deepEqual(result.interventionDetails, [
      'Corrected component structure',
      'Fixed import path',
    ]);
    assert.deepEqual(result.metadata.interventionFlags, ['needed-design-guidance']);
    assert.equal(result.scoreBand, 'Assisted Success');
  });

  it('retries on malformed JSON and succeeds on second attempt', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      const text =
        callCount === 1
          ? 'This is not JSON at all'
          : JSON.stringify({
              score: 0.75,
              rationale: 'Good work on second parse.',
              interventionFlags: [],
            });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: [{ type: 'text', text }],
          }),
      });
    });

    const result = await evaluateTask({
      taskPrompt: 'Fix a bug',
      prReviewOutput: 'Bug fixed correctly',
    });

    assert.equal(result.score, 0.75);
    assert.equal(callCount, 2);
  });

  it('rejects scores outside 0-1 range and retries', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      const text =
        callCount === 1
          ? JSON.stringify({ score: 1.5, rationale: 'Too high', interventionFlags: [] })
          : JSON.stringify({ score: 0.9, rationale: 'Valid score now.', interventionFlags: [] });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: [{ type: 'text', text }],
          }),
      });
    });

    const result = await evaluateTask({
      taskPrompt: 'Add feature',
      prReviewOutput: 'Feature added',
    });

    assert.equal(result.score, 0.9);
    assert.equal(callCount, 2);
  });

  it('throws after max retries exhausted', async () => {
    mockFetch('not json at all');

    await assert.rejects(
      () =>
        evaluateTask({
          taskPrompt: 'Do something',
          prReviewOutput: 'Did something',
        }),
      (err) => {
        assert.ok(err.message.includes('Failed to parse LLM judge response after 3 attempts'));
        return true;
      }
    );

    // Should have been called 3 times (1 initial + 2 retries)
    assert.equal(globalThis.fetch.mock.callCount(), 3);
  });

  it('throws immediately on API error (no retry)', async () => {
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })
    );

    await assert.rejects(
      () =>
        evaluateTask({
          taskPrompt: 'Do something',
          prReviewOutput: 'Did something',
        }),
      (err) => {
        assert.ok(err.message.includes('Anthropic API error (500)'));
        return true;
      }
    );

    // Should only have been called once — no retry on API errors
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockFetch('irrelevant');

    await assert.rejects(
      () =>
        evaluateTask({
          taskPrompt: 'Do something',
          prReviewOutput: 'Did something',
        }),
      (err) => {
        assert.ok(err.message.includes('ANTHROPIC_API_KEY'));
        return true;
      }
    );
  });

  it('handles response wrapped in markdown code fences', async () => {
    const wrappedResponse =
      '```json\n' +
      JSON.stringify({
        score: 0.7,
        rationale: 'Decent execution with fenced response.',
        interventionFlags: ['minor-style-issue'],
      }) +
      '\n```';
    mockFetch(wrappedResponse);

    const result = await evaluateTask({
      taskPrompt: 'Refactor module',
      prReviewOutput: 'Refactoring looks good',
    });

    assert.equal(result.score, 0.7);
    assert.equal(result.rationale, 'Decent execution with fenced response.');
    assert.equal(result.scoreBand, 'Assisted Success');
  });
});
