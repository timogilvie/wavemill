import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isBlockingFinding, isDismissedFinding, reviewEngineTestUtils } from './review-engine.ts';
import type { ReviewContext } from './review-context-gatherer.ts';

describe('review-engine scoped mode', () => {
  afterEach(() => {
    reviewEngineTestUtils.resetDeps();
  });

  it('uses the scoped general prompt in degraded modes', () => {
    const normalPath = reviewEngineTestUtils.getPersonaPromptPath('general', 'normal');
    const survivalPath = reviewEngineTestUtils.getPersonaPromptPath('general', 'survival');

    assert.match(normalPath, /review-general\.md$/);
    assert.match(survivalPath, /review-general-scoped\.md$/);

    const normalPrompt = reviewEngineTestUtils.loadPersonaPromptTemplate('general', 'normal');
    const survivalPrompt = reviewEngineTestUtils.loadPersonaPromptTemplate('general', 'survival');

    assert.notEqual(normalPrompt, survivalPrompt);
    assert.match(survivalPrompt, /needs_stronger_reviewer/);
  });

  it('documents the scoped four-bucket checklist and stronger reviewer flag', () => {
    const promptPath = reviewEngineTestUtils.getPersonaPromptPath('general', 'constrained');
    const prompt = readFileSync(promptPath, 'utf-8');

    assert.match(prompt, /Syntax \/ compilation/);
    assert.match(prompt, /Contract violations/);
    assert.match(prompt, /Obvious regressions/);
    assert.match(prompt, /Test-coverage gaps/);
    assert.match(prompt, /needs_stronger_reviewer/);
    assert.match(prompt, /stronger_reviewer_reason/);
    assert.match(prompt, /Reverts #N/);
    assert.match(prompt, /auto\/integration/);
  });

  it('documents cross-PR revert protection in the normal general prompt', () => {
    const prompt = reviewEngineTestUtils.loadPersonaPromptTemplate('general', 'normal');

    assert.match(prompt, /Intentionally reverts #N/);
    assert.match(prompt, /auto\/integration/);
    assert.match(prompt, /merge base/);
  });

  it('enables native review only when enabled and review phase are both configured', () => {
    const cases = [
      { config: { nativeAgent: { enabled: true, allowedPhases: ['review'] } }, expected: true },
      { config: { nativeAgent: { enabled: true } }, expected: false },
      { config: { nativeAgent: { enabled: true, allowedPhases: ['planning'] } }, expected: false },
      { config: { nativeAgent: { allowedPhases: ['review'] } }, expected: false },
      { config: {}, expected: false },
    ];

    for (const [index, testCase] of cases.entries()) {
      const repoDir = mkdtempSync(join(tmpdir(), `review-engine-native-${index}-`));
      try {
        writeFileSync(
          join(repoDir, '.wavemill-config.json'),
          JSON.stringify(testCase.config),
          'utf-8',
        );
        assert.equal(reviewEngineTestUtils.isNativeReviewOptedIn(repoDir), testCase.expected);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });

  it('dispatches to the native review loader when review phase is opted in', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-native-dispatch-'));
    const context = makeReviewContext();

    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({ nativeAgent: { enabled: true, allowedPhases: ['review'] } }),
      'utf-8',
    );

    let loaderCalls = 0;
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
      loaderCalls += 1;
      return {
        async runNativeReview() {
          return {
            verdict: 'ready',
            codeReviewFindings: [],
            metadata: {
              branch: context.metadata.branch,
              files: context.metadata.files,
              hasUiChanges: false,
              designContextAvailable: false,
              uiVerificationRun: false,
            },
          };
        },
      };
    });

    try {
      const result = await import('./review-engine.ts').then((module) => module.runReview(context, repoDir, {
        skipClaudePreflight: true,
      }));
      assert.equal(loaderCalls, 1);
      assert.equal(result.verdict, 'ready');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not invoke the native review loader when review phase is disabled', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-native-disabled-'));
    const context = makeReviewContext();

    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({ nativeAgent: { enabled: false, allowedPhases: ['review'] } }),
      'utf-8',
    );

    let loaderCalls = 0;
    let personaCalls = 0;
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
      loaderCalls += 1;
      throw new Error('native loader should not be called');
    });
    reviewEngineTestUtils.setRunPersonaReview(async () => {
      personaCalls += 1;
      return {
        verdict: 'ready',
        codeReviewFindings: [],
        metadata: {
          branch: context.metadata.branch,
          files: context.metadata.files,
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
      };
    });

    try {
      const result = await import('./review-engine.ts').then((module) => module.runReview(context, repoDir, {
        skipClaudePreflight: true,
      }));
      assert.equal(loaderCalls, 0);
      assert.equal(personaCalls, 1);
      assert.equal(result.verdict, 'ready');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not invoke the native review loader when allowedPhases excludes review', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-native-phase-removed-'));
    const context = makeReviewContext();

    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({ nativeAgent: { enabled: true, allowedPhases: ['planning'] } }),
      'utf-8',
    );

    let loaderCalls = 0;
    let personaCalls = 0;
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
      loaderCalls += 1;
      throw new Error('native loader should not be called');
    });
    reviewEngineTestUtils.setRunPersonaReview(async () => {
      personaCalls += 1;
      return {
        verdict: 'ready',
        codeReviewFindings: [],
        metadata: {
          branch: context.metadata.branch,
          files: context.metadata.files,
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
      };
    });

    try {
      const result = await import('./review-engine.ts').then((module) => module.runReview(context, repoDir, {
        skipClaudePreflight: true,
      }));
      assert.equal(loaderCalls, 0);
      assert.equal(personaCalls, 1);
      assert.equal(result.verdict, 'ready');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

function makeReviewContext(): ReviewContext {
  return {
    diff: 'diff --git a/file.ts b/file.ts',
    plan: 'Plan',
    taskPacket: 'Task packet',
    designContext: null,
    metadata: {
      branch: 'feature/native-review',
      files: ['file.ts'],
      hasUiChanges: false,
    },
  };
}

describe('review-engine dismissal parsing (HOK-2932)', () => {
  it('keeps a justified dismissal and rejects an unjustified one', () => {
    const response = JSON.stringify({
      verdict: 'ready',
      codeReviewFindings: [
        {
          severity: 'blocker',
          location: 'scope-guard',
          category: 'plan_compliance',
          description: 'Diff includes out-of-scope files.',
          dismissed: true,
          dismissalJustification: 'False positive: stale diff base; PR diff is in scope.',
          dismissalEvidence: 'git log auto/integration..HEAD',
        },
        {
          severity: 'blocker',
          location: 'src/app.ts:10',
          category: 'logic',
          description: 'Off-by-one in loop bound.',
          dismissed: true,
          dismissalJustification: '   ',
        },
      ],
    });

    const result = reviewEngineTestUtils.parseNativeReviewResponse(response, makeReviewContext());

    const [justified, unjustified] = result.codeReviewFindings;
    assert.equal(isDismissedFinding(justified), true);
    assert.equal(isBlockingFinding(justified), false);
    // A blank justification rejects the dismissal: the finding stays blocking.
    assert.equal(unjustified.dismissed, undefined);
    assert.equal(isDismissedFinding(unjustified), false);
    assert.equal(isBlockingFinding(unjustified), true);
  });
});

describe('review-engine artifact citations (HOK-3058)', () => {
  it('keeps protected refs and drops invalid citations without failing the review parse', () => {
    const validRef = `artifact://${'a'.repeat(64)}`;
    const result = reviewEngineTestUtils.parseNativeReviewResponse(JSON.stringify({
      verdict: 'ready',
      codeReviewFindings: [{
        severity: 'warning', location: 'src/app.ts:1', category: 'logic', description: 'Visual difference',
        artifactRefs: [validRef, '/tmp/screenshot.png', `artifact://${'A'.repeat(64)}`, 42],
      }, {
        severity: 'warning', location: 'src/app.ts:2', category: 'logic', description: 'Malformed citations',
        artifactRefs: 'artifact://not-an-array',
      }],
      uiFindings: [{
        severity: 'warning', location: 'page', category: 'ui', description: 'Changed layout',
        artifactRefs: [validRef, 'artifact://short'],
      }],
    }), makeReviewContext());

    assert.deepEqual(result.codeReviewFindings[0].artifactRefs, [validRef]);
    assert.equal(result.codeReviewFindings[1].artifactRefs, undefined);
    assert.deepEqual(result.uiFindings?.[0].artifactRefs, [validRef]);
  });
});
