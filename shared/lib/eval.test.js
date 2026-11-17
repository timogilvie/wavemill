import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from './eval.ts';
import { enrichEvalRecord } from './eval-record-builder.ts';
import { SCHEMA_VERSION } from './eval-schema.ts';
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, loadPricingTable } from './pricing/model-pricing.ts';

function mockCallFn(responseText, usage = null, costUsd = undefined) {
  return mock.fn(() => Promise.resolve({ text: responseText, usage, costUsd }));
}

function sequenceCallFn(...responses) {
  let index = 0;
  return mock.fn(() => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(typeof next === 'string' ? { text: next, usage: null } : next);
  });
}

async function withMockSession(fn) {
  const previousSession = process.env.WAVEMILL_SESSION;
  process.env.WAVEMILL_SESSION = 'test-session';
  try {
    return await fn();
  } finally {
    if (previousSession === undefined) {
      delete process.env.WAVEMILL_SESSION;
    } else {
      process.env.WAVEMILL_SESSION = previousSession;
    }
  }
}

/** A `git diff` chunk that adds `path` with `content` (HOK-3493 fixtures). */
function addedSource(path, content) {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

/**
 * A stub judge adapter (HOK-3493): a fixed context window and a preflight that
 * either mirrors the limits (`preflightFromLimits`) or accepts everything.
 */
function stubAdapter({ contextWindowTokens, preflightFromLimits }) {
  return {
    kind: 'claude-cli',
    model: 'stub-judge',
    limits: { contextWindowTokens, reservedOutputTokens: 0, cliHarnessOverheadTokens: 0 },
    countTokens: (text) => Buffer.byteLength(text, 'utf8'),
    preflight: (prompt) => {
      if (!preflightFromLimits) return undefined;
      const tokens = Buffer.byteLength(prompt, 'utf8');
      return tokens > contextWindowTokens
        ? { kind: 'context-exceeded', message: `prompt ${tokens} > ${contextWindowTokens}`, policyKind: 'context-window-exceeded' }
        : undefined;
    },
    invoke: async () => ({ text: '', reportedModel: 'unverified' }),
    parseResult: () => ({ text: '', reportedModel: 'unverified' }),
  };
}

describe('evaluateTask', () => {
  it('returns a valid EvalRecord conforming to eval-schema', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Task was completed successfully with clean implementation.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Add a loading spinner',
        prReviewOutput: 'Clean diff, all tests pass',
        issueId: 'HOK-100',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    // Core EvalRecord fields from eval-schema.ts
    assert.ok(result.id, 'should have a UUID id');
    assert.equal(result.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.originalPrompt, 'Add a loading spinner');
    assert.ok(result.modelId);
    assert.ok(result.modelVersion);
    assert.equal(result.score, 0.85);
    assert.equal(result.scoreBand, 'Minor Feedback');
    assert.equal(result.timeSeconds, null);
    assert.ok(new Date(result.timestamp).toISOString() === result.timestamp);
    assert.equal(result.interventionRequired, false);
    assert.equal(result.interventionCount, 0);
    assert.deepEqual(result.interventionDetails, []);
    assert.equal(result.rationale, 'Task was completed successfully with clean implementation.');
    assert.equal(result.issueId, 'HOK-100');
    assert.equal(result.trainingEligible, false);
    assert.equal(result.budgetEvalEligible, false);
    assert.equal(result.budgetEvalEligibilityError, 'missing_budget');
    assert.deepEqual(result.eligibilityErrors, [
      'missing_budget',
      'missing_budget_snapshot',
      'missing_cost',
      'missing_outcome',
      'missing_routing',
      'missing_task_descriptor',
    ]);
  });

  it('derives correct score band from eval-schema rubric', async () => {
    const validResponse = JSON.stringify({
      score: 1.0,
      rationale: 'Perfect autonomous execution.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Simple task',
        prReviewOutput: 'Flawless',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.scoreBand, 'Full Success');
  });

  it('preserves explicit null timeSeconds', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Duration was unknown but the implementation was good.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Handle missing timing metadata',
        prReviewOutput: 'Clean diff',
        timeSeconds: null,
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.timeSeconds, null);
  });

  it('normalizes invalid timeSeconds values to null', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Timing input was invalid.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Handle invalid timing metadata',
        prReviewOutput: 'Clean diff',
        timeSeconds: Number.NaN,
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.timeSeconds, null);
  });

  it('passes intervention metadata through to the result', async () => {
    const validResponse = JSON.stringify({
      score: 0.6,
      rationale: 'Task completed but required guidance.',
      interventionFlags: ['needed-design-guidance'],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Build a dashboard',
        prReviewOutput: 'Implementation works but needed corrections',
        interventions: [
          { description: 'Corrected component structure', severity: 'major' },
          { description: 'Fixed import path', severity: 'minor' },
        ],
        issueId: 'HOK-200',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.interventionRequired, true);
    assert.equal(result.interventionCount, 2);
    assert.deepEqual(result.interventionDetails, [
      'Corrected component structure',
      'Fixed import path',
    ]);
    assert.deepEqual(result.metadata.interventionFlags, ['needed-design-guidance']);
    assert.equal(result.scoreBand, 'Assisted Success');
  });

  it('stores planCritique in metadata when the judge returns it', async () => {
    const validResponse = JSON.stringify({
      score: 0.88,
      rationale: 'Implementation succeeded and the plan was mostly strong.',
      interventionFlags: [],
      stageScores: {
        expansion: { score: 0.9, rationale: 'Spec was clear.' },
        plan: { score: 0.84, rationale: 'Plan mostly identified the right work.' },
        implementation: { score: 0.9, rationale: 'Code landed cleanly.' },
        review: { score: 0.85, rationale: 'Review coverage was good.' },
      },
      planCritique: {
        component_boundaries: {
          score: 0.9,
          rationale: 'The plan targeted the correct eval prompt, parser, and schema layers.',
        },
        invariant_coverage: {
          score: 0.75,
          rationale: 'It identified the key optional-field compatibility constraint.',
        },
        approach_soundness: {
          score: 0.85,
          rationale: 'The approach was viable without adding extra judge calls.',
        },
        missed_patches: {
          score: 0.8,
          rationale: 'Only minor parser cleanup was needed during implementation.',
        },
        overall: {
          score: 0.82,
          rationale: 'The plan provided a solid implementation guide.',
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Add plan critique to evals',
        prReviewOutput: 'Changes are correct',
        planContent: 'Implement schema, prompt, parser, and tests.',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.metadata.planCritique, {
      component_boundaries: {
        score: 0.9,
        rationale: 'The plan targeted the correct eval prompt, parser, and schema layers.',
      },
      invariant_coverage: {
        score: 0.75,
        rationale: 'It identified the key optional-field compatibility constraint.',
      },
      approach_soundness: {
        score: 0.85,
        rationale: 'The approach was viable without adding extra judge calls.',
      },
      missed_patches: {
        score: 0.8,
        rationale: 'Only minor parser cleanup was needed during implementation.',
      },
      overall: {
        score: 0.82,
        rationale: 'The plan provided a solid implementation guide.',
      },
    });
    assert.equal(result.metadata.stageScores.plan.score, 0.84);
  });

  it('stores populated stageScores and schema-valid rubricEval from the judge', async () => {
    const validResponse = JSON.stringify({
      score: 0.7,
      rationale:
        'The task landed but a human-fixed functional issue capped the score at 0.7.',
      interventionFlags: [
        'review_comment:found schema compatibility issue',
        'post_pr_commit:fixed stage output wording',
      ],
      stageScores: {
        expansion: {
          score: 0.9,
          rationale: 'Requirement coverage and ambiguity resolution were strong.',
        },
        plan: {
          score: 0.82,
          rationale: 'Invariant coverage was solid, but validation planning missed one compatibility risk.',
        },
        implementation: {
          score: 0.68,
          rationale: 'Requirement completeness was good, but correctness suffered from the human-fixed issue.',
        },
        review: {
          score: 0.8,
          rationale: 'Issue detection eventually worked, though self-review missed the bug initially.',
        },
      },
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.0',
        criteria: {
          completeness: {
            score: 0.9,
            rationale: 'The requested behavior was mostly implemented.',
          },
          correctness: {
            score: 0.68,
            rationale: 'A human-found compatibility bug reduced correctness.',
          },
          code_quality: {
            score: 0.84,
            rationale: 'The resulting changes fit the project structure well.',
          },
          intervention_impact: {
            score: 0.66,
            rationale: 'Human review and a fix meaningfully reduced autonomous execution quality.',
          },
          autonomy: {
            score: 0.7,
            rationale: 'The workflow was mostly autonomous but not bug-free.',
          },
        },
        determinative_boundary: 'functional_bug',
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Rewrite the eval judge prompt',
        prReviewOutput: 'One compatibility issue found and fixed',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.metadata.stageScores, {
      expansion: {
        score: 0.9,
        rationale: 'Requirement coverage and ambiguity resolution were strong.',
      },
      plan: {
        score: 0.82,
        rationale: 'Invariant coverage was solid, but validation planning missed one compatibility risk.',
      },
      implementation: {
        score: 0.68,
        rationale: 'Requirement completeness was good, but correctness suffered from the human-fixed issue.',
      },
      review: {
        score: 0.8,
        rationale: 'Issue detection eventually worked, though self-review missed the bug initially.',
      },
    });

    assert.deepEqual(result.rubricEval, {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: {
        completeness: {
          score: 0.9,
          rationale: 'The requested behavior was mostly implemented.',
        },
        correctness: {
          score: 0.68,
          rationale: 'A human-found compatibility bug reduced correctness.',
        },
        code_quality: {
          score: 0.84,
          rationale: 'The resulting changes fit the project structure well.',
        },
        intervention_impact: {
          score: 0.66,
          rationale: 'Human review and a fix meaningfully reduced autonomous execution quality.',
        },
        autonomy: {
          score: 0.7,
          rationale: 'The workflow was mostly autonomous but not bug-free.',
        },
      },
      determinative_boundary: 'functional_bug',
    });
  });

  it('accepts rubricEval with determinative_boundary "unverified_prediction"', async () => {
    const validResponse = JSON.stringify({
      score: 0.84,
      rationale: 'Unreproduced predicted failures only slightly affected the score.',
      interventionFlags: [],
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.1',
        criteria: {
          completeness: { score: 0.88, rationale: 'Scope was covered.' },
          correctness: { score: 0.82, rationale: 'No reproduced failure was shown.' },
          code_quality: { score: 0.84, rationale: 'The change fit project conventions.' },
          intervention_impact: { score: 0.8, rationale: 'No functional fix was required.' },
          autonomy: { score: 0.83, rationale: 'The workflow remained mostly autonomous.' },
        },
        determinative_boundary: 'unverified_prediction',
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Cap unreproduced predicted failures',
        prReviewOutput: 'Predicted issue was not reproduced',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.rubricEval?.determinative_boundary, 'unverified_prediction');
    assert.equal(result.rubricEval?.rubric_version, '1.1');
  });

  it('accepts rubricEval with determinative_boundary "vacuous_safety_gate"', async () => {
    const validResponse = JSON.stringify({
      score: 0.58,
      rationale: 'The gate was structurally bypassable on the default path.',
      interventionFlags: [],
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.1',
        criteria: {
          completeness: { score: 0.7, rationale: 'Most requested pieces were present.' },
          correctness: { score: 0.55, rationale: 'The gate could not enforce its main assertion.' },
          code_quality: { score: 0.74, rationale: 'The code was readable but structurally weak.' },
          intervention_impact: { score: 0.6, rationale: 'The defect materially reduced confidence.' },
          autonomy: { score: 0.58, rationale: 'The workflow shipped a vacuous gate.' },
        },
        determinative_boundary: 'vacuous_safety_gate',
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Score vacuous CI gates correctly',
        prReviewOutput: 'Gate passes by skipping enforcement',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.rubricEval?.determinative_boundary, 'vacuous_safety_gate');
    assert.equal(result.rubricEval?.rubric_version, '1.1');
  });

  it('drops unknown rubricEval determinative boundaries while preserving the rest', async () => {
    const validResponse = JSON.stringify({
      score: 0.8,
      rationale: 'Unknown boundary labels should not poison rubric parsing.',
      interventionFlags: [],
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.1',
        criteria: {
          completeness: { score: 0.85, rationale: 'Scope was covered.' },
          correctness: { score: 0.8, rationale: 'Behavior appears correct.' },
          code_quality: { score: 0.82, rationale: 'The change fit the codebase.' },
          intervention_impact: { score: 0.79, rationale: 'Interventions were limited.' },
          autonomy: { score: 0.8, rationale: 'Execution was mostly autonomous.' },
        },
        determinative_boundary: 'totally_unknown_boundary',
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Ignore invalid determinative boundary values',
        prReviewOutput: 'Boundary label is invalid',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.rubricEval, {
      schema_version: '1.0',
      rubric_version: '1.1',
      criteria: {
        completeness: { score: 0.85, rationale: 'Scope was covered.' },
        correctness: { score: 0.8, rationale: 'Behavior appears correct.' },
        code_quality: { score: 0.82, rationale: 'The change fit the codebase.' },
        intervention_impact: { score: 0.79, rationale: 'Interventions were limited.' },
        autonomy: { score: 0.8, rationale: 'Execution was mostly autonomous.' },
      },
    });
  });

  it('accepts rubricEval with no determinative_boundary', async () => {
    const validResponse = JSON.stringify({
      score: 0.89,
      rationale: 'determinative_boundary remains optional.',
      interventionFlags: [],
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.1',
        criteria: {
          completeness: { score: 0.9, rationale: 'Scope was fully covered.' },
          correctness: { score: 0.88, rationale: 'No functional defects were reported.' },
          code_quality: { score: 0.9, rationale: 'The code was well integrated.' },
          intervention_impact: { score: 0.87, rationale: 'Intervention burden was low.' },
          autonomy: { score: 0.88, rationale: 'The workflow was nearly autonomous.' },
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Keep determinative boundary optional',
        prReviewOutput: 'Clean verification evidence',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.rubricEval, {
      schema_version: '1.0',
      rubric_version: '1.1',
      criteria: {
        completeness: { score: 0.9, rationale: 'Scope was fully covered.' },
        correctness: { score: 0.88, rationale: 'No functional defects were reported.' },
        code_quality: { score: 0.9, rationale: 'The code was well integrated.' },
        intervention_impact: { score: 0.87, rationale: 'Intervention burden was low.' },
        autonomy: { score: 0.88, rationale: 'The workflow was nearly autonomous.' },
      },
    });
  });

  it('stores rubricCriteria from stageScores and enriches stageOutcomes', async () => {
    const validResponse = JSON.stringify({
      score: 0.86,
      rationale: 'The workflow completed with strong stage quality.',
      interventionFlags: [],
      stageScores: {
        expansion: {
          score: 0.9,
          rationale: 'Expansion covered requirements and validation.',
          rubricCriteria: [
            {
              criterion: 'requirement_coverage',
              score: 0.92,
              notes: 'All key requirements were surfaced.',
            },
          ],
        },
        plan: {
          score: 0.84,
          rationale: 'Plan captured the right boundaries.',
          rubricCriteria: [
            {
              criterion: 'component_boundaries',
              score: 0.86,
              notes: 'The affected modules were identified.',
            },
          ],
        },
        implementation: {
          score: 0.88,
          rationale: 'Implementation matched the plan.',
          rubricCriteria: [
            {
              criterion: 'correctness',
              score: 0.9,
              notes: 'No functional issues were found.',
            },
          ],
        },
        review: {
          score: 0.82,
          rationale: 'Review checked the important behavior.',
          rubricCriteria: [
            {
              criterion: 'issue_detection',
              score: 0.8,
              notes: 'Review covered the main failure modes.',
            },
          ],
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Persist stage rubric criteria',
        prReviewOutput: 'Clean diff',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.metadata.stageScores.expansion.rubricCriteria, [
      {
        criterion: 'requirement_coverage',
        score: 0.92,
        notes: 'All key requirements were surfaced.',
      },
    ]);

    enrichEvalRecord(result, {});
    assert.deepEqual(result.stageOutcomes.expansion.rubricCriteria, [
      {
        criterion: 'requirement_coverage',
        score: 0.92,
        notes: 'All key requirements were surfaced.',
      },
    ]);
    assert.deepEqual(result.stageOutcomes.plan.rubricCriteria, [
      {
        criterion: 'component_boundaries',
        score: 0.86,
        notes: 'The affected modules were identified.',
      },
    ]);
  });

  it('keeps scalar-only stageScores compatible without rubricCriteria warnings', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const validResponse = JSON.stringify({
        score: 0.8,
        rationale: 'Task completed without structured stage criteria.',
        interventionFlags: [],
        stageScores: {
          expansion: { score: 0.8, rationale: 'Expansion was adequate.' },
          plan: { score: 0.78, rationale: 'Plan was adequate.' },
          implementation: { score: 0.82, rationale: 'Implementation was adequate.' },
          review: { score: 0.79, rationale: 'Review was adequate.' },
        },
      });

      const result = await withMockSession(() =>
        evaluateTask(
          {
            taskPrompt: 'Scalar-only judge payload',
            prReviewOutput: 'Clean',
          },
          undefined,
          { _callFn: mockCallFn(validResponse) }
        )
      );

      for (const stage of Object.values(result.metadata.stageScores)) {
        assert.equal('rubricCriteria' in stage, false);
      }
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it('preserves rubricCriteria only for stages that provide them', async () => {
    const validResponse = JSON.stringify({
      score: 0.77,
      rationale: 'Mixed old and new stage payloads were accepted.',
      interventionFlags: [],
      stageScores: {
        expansion: {
          score: 0.83,
          rationale: 'Expansion had structured evidence.',
          rubricCriteria: [
            { criterion: 'validation_readiness', score: 0.8 },
          ],
        },
        plan: { score: 0.75, rationale: 'Plan used the scalar format.' },
        implementation: { score: 0.78, rationale: 'Implementation used the scalar format.' },
        review: { score: 0.74, rationale: 'Review used the scalar format.' },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Mixed stage payload',
        prReviewOutput: 'Mostly clean',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );
    enrichEvalRecord(result, {});

    assert.deepEqual(result.stageOutcomes.expansion.rubricCriteria, [
      { criterion: 'validation_readiness', score: 0.8 },
    ]);
    assert.equal('rubricCriteria' in result.stageOutcomes.plan, false);
    assert.equal('rubricCriteria' in result.stageOutcomes.implementation, false);
    assert.equal('rubricCriteria' in result.stageOutcomes.review, false);
  });

  it('drops malformed rubricCriteria without failing the eval', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const validResponse = JSON.stringify({
        score: 0.73,
        rationale: 'Malformed per-stage criteria were ignored.',
        interventionFlags: [],
        stageScores: {
          expansion: {
            score: 0.8,
            rationale: 'Expansion had invalid criteria shape.',
            rubricCriteria: 'not an array',
          },
          plan: {
            score: 0.72,
            rationale: 'Plan had malformed criteria item.',
            rubricCriteria: [
              { score: 0.7, notes: 'Missing criterion.' },
            ],
          },
        },
      });

      const result = await withMockSession(() =>
        evaluateTask(
          {
            taskPrompt: 'Malformed criteria payload',
            prReviewOutput: 'Completed',
          },
          undefined,
          { _callFn: mockCallFn(validResponse) }
        )
      );

      assert.equal('rubricCriteria' in result.metadata.stageScores.expansion, false);
      assert.equal('rubricCriteria' in result.metadata.stageScores.plan, false);
      assert.equal(warn.mock.callCount(), 2);
    } finally {
      warn.mock.restore();
    }
  });

  it('omits planCritique when the judge does not return it', async () => {
    const validResponse = JSON.stringify({
      score: 0.8,
      rationale: 'Good execution.',
      interventionFlags: [],
      stageScores: {
        expansion: { score: 0.8, rationale: 'Adequate.' },
        plan: { score: 0.78, rationale: 'Reasonable inferred planning.' },
        implementation: { score: 0.82, rationale: 'Correct result.' },
        review: { score: 0.79, rationale: 'No major misses.' },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Task without saved plan artifact',
        prReviewOutput: 'Clean',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal('planCritique' in result.metadata, false);
  });

  it('ignores invalid planCritique dimensions gracefully', async () => {
    const validResponse = JSON.stringify({
      score: 0.73,
      rationale: 'Task completed.',
      interventionFlags: [],
      planCritique: {
        component_boundaries: {
          score: 1.2,
          rationale: 'Out of range score should invalidate the object.',
        },
        invariant_coverage: {
          score: 0.7,
          rationale: 'Valid but should be dropped with the invalid object.',
        },
        approach_soundness: {
          score: 0.75,
          rationale: 'Valid but incomplete overall object.',
        },
        missed_patches: {
          score: 0.8,
          rationale: 'Valid but incomplete overall object.',
        },
        overall: {
          score: 0.74,
          rationale: 'Valid but incomplete overall object.',
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Task with malformed plan critique',
        prReviewOutput: 'Completed',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal('planCritique' in result.metadata, false);
  });

  it('recovers malformed JSON locally before retrying', async () => {
    const malformedResponse = '{"score":0.6,"rationale":"Line one\nHe said "ship it" yesterday.","interventionFlags":[]}';
    const callFn = mockCallFn(malformedResponse);

    const result = await evaluateTask(
      {
        taskPrompt: 'Do something',
        prReviewOutput: 'Did something',
      },
      undefined,
      { _callFn: callFn }
    );

    assert.equal(result.score, 0.6);
    assert.equal(result.rationale, 'Line one\nHe said "ship it" yesterday.');
    assert.equal(result.metadata.judgeJsonRecovered, true);
    assert.equal(callFn.mock.callCount(), 1);
  });

  it('retries the judge once when local repair fails', async () => {
    const callFn = sequenceCallFn(
      'not json at all',
      JSON.stringify({
        score: 0.77,
        rationale: 'Recovered after a single retry.',
        interventionFlags: [],
      })
    );

    const result = await evaluateTask(
      {
        taskPrompt: 'Do something',
        prReviewOutput: 'Did something',
      },
      undefined,
      { _callFn: callFn }
    );

    assert.equal(result.score, 0.77);
    assert.equal(callFn.mock.callCount(), 2);
  });

  it('throws bounded recovery error on unrecoverable malformed JSON response', async () => {
    const callFn = sequenceCallFn('not json at all', 'still not json');

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Do something',
            prReviewOutput: 'Did something',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.equal(err.name, 'JudgeResponseRecoveryError');
        assert.ok(err.message.includes('bounded recovery attempts'));
        return true;
      }
    );

    assert.equal(callFn.mock.callCount(), 2);
  });

  it('throws immediately on scores outside 0-1 range', async () => {
    const callFn = mockCallFn(
      JSON.stringify({ score: 1.5, rationale: 'Too high', interventionFlags: [] })
    );

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Add feature',
            prReviewOutput: 'Feature added',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.ok(err.message.includes('Invalid score: 1.5'));
        return true;
      }
    );

    assert.equal(callFn.mock.callCount(), 1);
  });

  it('caps recovery at one extra judge call', async () => {
    const callFn = sequenceCallFn('This is not JSON at all', 'still invalid JSON');

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Fix a bug',
            prReviewOutput: 'Bug fixed correctly',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.equal(err.name, 'JudgeResponseRecoveryError');
        return true;
      }
    );

    assert.equal(callFn.mock.callCount(), 2);
  });

  it('throws immediately on CLI error (no retry)', async () => {
    const callFn = mock.fn(() => Promise.reject(new Error('claude CLI exited with code 1')));

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Do something',
            prReviewOutput: 'Did something',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.ok(err.message.includes('claude CLI exited with code 1'));
        return true;
      }
    );

    // Should only have been called once — no retry on CLI errors
    assert.equal(callFn.mock.callCount(), 1);
  });

  it('includes tokenUsage from CLI JSON response', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Good work.',
      interventionFlags: [],
    });
    const usage = { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 };

    const result = await evaluateTask(
      {
        taskPrompt: 'Add a feature',
        prReviewOutput: 'Clean diff',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, usage) }
    );

    assert.ok(result.tokenUsage, 'should have tokenUsage');
    assert.equal(result.tokenUsage.inputTokens, 2000);
    assert.equal(result.tokenUsage.outputTokens, 500);
    assert.equal(result.tokenUsage.totalTokens, 2500);
  });

  it('includes estimatedCost when model is in pricing table', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Well done.',
      interventionFlags: [],
    });
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

    const result = await evaluateTask(
      {
        taskPrompt: 'Quick task',
        prReviewOutput: 'Good',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, usage) }
    );

    // estimatedCost may be undefined if pricing table not loaded (test cwd may not have config)
    if (result.estimatedCost !== undefined) {
      assert.equal(typeof result.estimatedCost, 'number');
      assert.ok(result.estimatedCost >= 0);
    }
  });

  it('prefers CLI costUsd over pricing table estimate', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Well done.',
      interventionFlags: [],
    });
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

    const result = await evaluateTask(
      {
        taskPrompt: 'Quick task',
        prReviewOutput: 'Good',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, usage, 0.03078) }
    );

    assert.equal(result.estimatedCost, 0.03078);
  });

  // protects: HOK-3409 — a judge call whose prompt was served from the
  // provider cache is priced at the cache-read rate, not the ~10x uncached
  // input rate the private adapter mappers charged before they adopted the
  // SDK's own usage semantics.
  it('prices judge cache reads at the cache-read rate, not the input rate', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Well done.',
      interventionFlags: [],
    });
    // A registry judge model with no explicit cache rate, so @hokusai/costs
    // applies the documented cache-read default (0.1x input).
    const judgeModel = 'gpt-5.5';
    const pricing = loadPricingTable()[judgeModel];
    assert.ok(pricing, `expected registry pricing for ${judgeModel}`);
    const cacheReadRate =
      pricing.cacheReadCostPerMTok ?? pricing.inputCostPerMTok * CACHE_READ_MULTIPLIER;
    const cacheWriteRate =
      pricing.cacheWriteCostPerMTok ?? pricing.inputCostPerMTok * CACHE_WRITE_MULTIPLIER;

    const previousModel = process.env.EVAL_MODEL;
    process.env.EVAL_MODEL = judgeModel;
    try {
      const cached = await evaluateTask(
        {
          taskPrompt: 'Quick task',
          prReviewOutput: 'Good',
        },
        undefined,
        {
          _callFn: mockCallFn(validResponse, {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 1000,
            cacheReadTokens: 1000,
          }),
        }
      );
      const uncached = await evaluateTask(
        {
          taskPrompt: 'Quick task',
          prReviewOutput: 'Good',
        },
        undefined,
        {
          _callFn: mockCallFn(validResponse, {
            inputTokens: 1000,
            outputTokens: 0,
            totalTokens: 1000,
          }),
        }
      );

      const cacheWritten = await evaluateTask(
        {
          taskPrompt: 'Quick task',
          prReviewOutput: 'Good',
        },
        undefined,
        {
          _callFn: mockCallFn(validResponse, {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 1000,
            cacheWriteTokens: 1000,
          }),
        }
      );

      // The cache bucket survives the aggregation onto the record, and stays
      // absent when the judge transport reported no cache counters.
      assert.equal(cached.tokenUsage.cacheReadTokens, 1000);
      assert.equal(cached.tokenUsage.inputTokens, 0);
      assert.equal(cacheWritten.tokenUsage.cacheWriteTokens, 1000);
      assert.equal(uncached.tokenUsage.cacheReadTokens, undefined);
      assert.equal(uncached.tokenUsage.cacheWriteTokens, undefined);

      assert.ok(cached.estimatedCost !== undefined, 'the cached judge call must be priced');
      assert.ok(uncached.estimatedCost !== undefined, 'the uncached judge call must be priced');
      const expectedCacheRead = (1000 / 1_000_000) * cacheReadRate;
      const expectedInput = (1000 / 1_000_000) * pricing.inputCostPerMTok;
      assert.ok(
        Math.abs(cached.estimatedCost - expectedCacheRead) < 1e-12,
        `cached judge cost ${cached.estimatedCost} should be ${expectedCacheRead}`
      );
      assert.ok(
        Math.abs(uncached.estimatedCost - expectedInput) < 1e-12,
        `uncached judge cost ${uncached.estimatedCost} should be ${expectedInput}`
      );
      // The two buckets reach different rates: the cached call is 10x cheaper.
      assert.ok(
        Math.abs(uncached.estimatedCost - 10 * cached.estimatedCost) < 1e-11,
        `uncached ${uncached.estimatedCost} should be 10x cached ${cached.estimatedCost}`
      );
      // Cache writes reach their own (default 1.25x) rate.
      const expectedCacheWrite = (1000 / 1_000_000) * cacheWriteRate;
      assert.ok(
        Math.abs(cacheWritten.estimatedCost - expectedCacheWrite) < 1e-12,
        `cache-write judge cost ${cacheWritten.estimatedCost} should be ${expectedCacheWrite}`
      );
    } finally {
      if (previousModel === undefined) {
        delete process.env.EVAL_MODEL;
      } else {
        process.env.EVAL_MODEL = previousModel;
      }
    }
  });

  it('omits tokenUsage when CLI response has no usage', async () => {
    const validResponse = JSON.stringify({
      score: 0.8,
      rationale: 'Done.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Do something',
        prReviewOutput: 'Something done',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, null) }
    );

    assert.equal(result.tokenUsage, undefined);
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

    const result = await evaluateTask(
      {
        taskPrompt: 'Refactor module',
        prReviewOutput: 'Refactoring looks good',
      },
      undefined,
      { _callFn: mockCallFn(wrappedResponse) }
    );

    assert.equal(result.score, 0.7);
    assert.equal(result.rationale, 'Decent execution with fenced response.');
    assert.equal(result.scoreBand, 'Assisted Success');
  });

  it('includes promptArtifacts with eval-judge template metadata', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Excellent work.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Add authentication',
        prReviewOutput: 'Auth implementation complete',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    // Should have promptArtifacts array
    assert.ok(result.promptArtifacts, 'should have promptArtifacts field');
    assert.ok(Array.isArray(result.promptArtifacts), 'promptArtifacts should be an array');
    assert.equal(result.promptArtifacts.length, 1, 'should have one artifact (eval-judge)');

    const artifact = result.promptArtifacts[0];
    assert.equal(artifact.templateName, 'eval-judge', 'template name should be eval-judge');
    assert.ok(artifact.templateHash, 'should have templateHash');
    assert.equal(artifact.templateHash.length, 64, 'templateHash should be SHA-256 hex (64 chars)');
    assert.ok(artifact.filledPromptHash, 'should have filledPromptHash');
    assert.equal(artifact.filledPromptHash.length, 64, 'filledPromptHash should be SHA-256 hex (64 chars)');

    // Template hash and filled prompt hash should be different
    assert.notEqual(artifact.templateHash, artifact.filledPromptHash,
      'template hash should differ from filled prompt hash');
  });

  it('promptArtifacts hashes are deterministic', async () => {
    const validResponse = JSON.stringify({
      score: 0.95,
      rationale: 'Great work.',
      interventionFlags: [],
    });

    // Call evaluateTask twice with same inputs
    const result1 = await evaluateTask(
      {
        taskPrompt: 'Same task prompt',
        prReviewOutput: 'Same review output',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    const result2 = await evaluateTask(
      {
        taskPrompt: 'Same task prompt',
        prReviewOutput: 'Same review output',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    // Template hashes should be identical (same template file)
    assert.equal(
      result1.promptArtifacts[0].templateHash,
      result2.promptArtifacts[0].templateHash,
      'template hash should be deterministic'
    );

    // Filled prompt hashes should be identical (same inputs)
    assert.equal(
      result1.promptArtifacts[0].filledPromptHash,
      result2.promptArtifacts[0].filledPromptHash,
      'filled prompt hash should be deterministic for same inputs'
    );
  });

  it('refuses a change that cannot fit the judge, before any judge call (HOK-3493)', async () => {
    const callFn = mockCallFn(JSON.stringify({ score: 1, rationale: 'Should not be called.', interventionFlags: [] }));
    const adapter = stubAdapter({ contextWindowTokens: 2_000, preflightFromLimits: true });
    await assert.rejects(
      evaluateTask(
        {
          taskPrompt: 'Oversized change task',
          prReviewOutput: addedSource('src/huge.ts', 'export const y = 2;\n'.repeat(2_000)),
          issueId: 'HOK-3493',
        },
        undefined,
        { _callFn: callFn, _judgeAdapter: adapter }
      ),
      (error) => {
        assert.equal(error.name, 'ChangeInputRefusedError');
        assert.equal(error.adapterError.policyKind, 'context-window-exceeded');
        return true;
      }
    );
    assert.equal(callFn.mock.callCount(), 0);
  });

  it('sends a change over its per-part budget when the whole prompt still passes preflight (HOK-3493)', async () => {
    const validResponse = JSON.stringify({ score: 0.8, rationale: 'Sent.', interventionFlags: [] });
    const callFn = mockCallFn(validResponse);
    // The budget is tiny, but preflight (the transport's own check) accepts
    // the prompt: nothing was cut, so the judge runs.
    const adapter = stubAdapter({ contextWindowTokens: 2_000, preflightFromLimits: false });
    const result = await evaluateTask(
      { taskPrompt: 'Over per-part budget task', prReviewOutput: addedSource('src/huge.ts', 'export const y = 2;\n'.repeat(2_000)) },
      undefined,
      { _callFn: callFn, _judgeAdapter: adapter }
    );
    assert.equal(callFn.mock.callCount(), 1);
    assert.equal(result.failureReason, undefined);
    assert.ok(result.score > 0);
  });

  it('logs a change_input line for under-budget changes and leaves prompt_size behind', async () => {
    const validResponse = JSON.stringify({ score: 0.9, rationale: 'Under budget.', interventionFlags: [] });
    const callFn = mockCallFn(validResponse);
    const log = mock.method(console, 'log', () => {});
    try {
      await evaluateTask(
        { taskPrompt: 'Small eval prompt', prReviewOutput: 'Clean diff' },
        undefined,
        { _callFn: callFn, _judgeAdapter: null }
      );
      const lines = log.mock.calls.map((call) => call.arguments[0]).filter((line) => typeof line === 'string');
      const changeLine = lines.find((line) => line.startsWith('[eval] change_input '));
      assert.ok(changeLine, 'logs the change-input evidence line');
      const evidence = JSON.parse(changeLine.slice('[eval] change_input '.length));
      assert.equal(evidence.withinBudget, true);
      assert.equal(evidence.summarised, 0);
      assert.ok(evidence.promptTokens > 0);
      assert.ok(!lines.some((line) => line.startsWith('[eval] prompt_size ')), 'the byte-cap diagnostic is gone');
    } finally {
      log.mock.restore();
    }
  });
});
