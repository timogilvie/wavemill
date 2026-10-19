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

describe('review-engine per-model dispatch (HOK-3247)', () => {
  afterEach(() => {
    reviewEngineTestUtils.resetDeps();
  });

  type CallLLM = Parameters<typeof reviewEngineTestUtils.setCallLLM>[0];
  type CallOptions = Parameters<CallLLM>[1];

  const READY_JSON = JSON.stringify({ verdict: 'ready', codeReviewFindings: [] });

  function setup(input: {
    agents?: Record<string, string>;
    nativeOptedIn?: boolean;
    reportedModel?: (options: CallOptions) => string | undefined;
  }) {
    const calls: CallOptions[] = [];
    const nativeCalls: Array<string | undefined> = [];
    reviewEngineTestUtils.setResolveReviewAgent((model) => {
      const agent = input.agents?.[model];
      return agent
        ? { ok: true, agent: agent as never }
        : { ok: false, reason: 'uncertified', diagnostic: `[agent-resolution] model=${model} phase=review reason=uncertified` };
    });
    reviewEngineTestUtils.setIsNativeReviewOptedIn(() => input.nativeOptedIn === true);
    reviewEngineTestUtils.setBuildCliReviewAdapter((provider, model) => ({
      kind: provider === 'codex' ? 'codex-cli' : 'claude-cli',
      model,
      limits: {},
      countTokens: () => 0,
      preflight: () => undefined,
      invoke: async () => ({ text: '', reportedModel: 'unverified' }),
      parseResult: () => ({ text: '', reportedModel: 'unverified' }),
    }));
    reviewEngineTestUtils.setCallLLM(async (_prompt, options) => {
      calls.push(options);
      const reportedModel = input.reportedModel?.(options);
      return {
        text: READY_JSON,
        rawOutput: READY_JSON,
        provider: options?.provider ?? 'claude',
        model: options?.model ?? '(default)',
        ...(reportedModel ? { reportedModel } : {}),
      };
    });
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => ({
      async runNativeReview(context, _repoDir, options) {
        nativeCalls.push(options?.model);
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
    }));
    return { calls, nativeCalls };
  }

  async function review(model?: string) {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-dispatch-'));
    try {
      const { runReview } = await import('./review-engine.ts');
      return await runReview(makeReviewContext(), repoDir, {
        skipClaudePreflight: true,
        ...(model ? { model } : {}),
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }

  it('runs an Anthropic reviewer on the claude CLI, pinned, with no fallback ladder', async () => {
    const { calls, nativeCalls } = setup({
      agents: { 'claude-opus-5-5': 'claude' },
      nativeOptedIn: true,
      reportedModel: (options) => options?.model,
    });
    const result = await review('claude-opus-5-5');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.provider, 'claude');
    assert.equal(calls[0]?.model, 'claude-opus-5-5');
    assert.equal(calls[0]?.taskType, undefined);
    assert.deepEqual(calls[0]?.fallbackModels, []);
    // Native review is opted in, yet an Anthropic model never reaches it.
    assert.deepEqual(nativeCalls, []);
    assert.equal(result.verdict, 'ready');
    assert.equal(result.substantiveAnalysisIdentity?.resolvedModel, 'claude-opus-5-5');
    assert.equal(result.substantiveAnalysisIdentity?.agent, 'claude-cli');
    assert.equal(result.substantiveAnalysisIdentity?.source, 'artifact');
    assert.equal(result.substantiveAnalysisIdentity?.pinned, true);
  });

  it('runs an OpenAI reviewer on the codex CLI and records it unverified (codex reports no model)', async () => {
    const { calls, nativeCalls } = setup({ agents: { 'gpt-5.6-terra': 'codex' }, nativeOptedIn: true });
    const result = await review('gpt-5.6-terra');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.provider, 'codex');
    assert.equal(calls[0]?.model, 'gpt-5.6-terra');
    assert.equal(calls[0]?.taskType, undefined);
    assert.deepEqual(calls[0]?.fallbackModels, []);
    assert.deepEqual(nativeCalls, []);
    assert.equal(result.substantiveAnalysisIdentity?.agent, 'codex-cli');
    assert.equal(result.substantiveAnalysisIdentity?.requestedModel, 'gpt-5.6-terra');
    assert.equal(result.substantiveAnalysisIdentity?.source, 'derived');
    assert.equal(result.substantiveAnalysisIdentity?.pinned, false);
  });

  it('runs a certified native reviewer through runNativeReview with the exact pin', async () => {
    const { calls, nativeCalls } = setup({ agents: { 'kimi-k2': 'native-openrouter' }, nativeOptedIn: true });
    const result = await review('kimi-k2');
    assert.deepEqual(nativeCalls, ['kimi-k2']);
    assert.equal(calls.length, 0);
    assert.equal(result.verdict, 'ready');
  });

  it('fails closed with review-model-unlaunchable for an unresolvable requested model', async () => {
    const { calls, nativeCalls } = setup({ agents: {}, nativeOptedIn: true });
    const result = await review('glm-5.3');
    assert.equal(calls.length, 0);
    assert.deepEqual(nativeCalls, []);
    assert.equal(result.verdict, 'error');
    assert.equal(result.failureCategory, 'review-model-unlaunchable');
    assert.match(result.reviewToolError ?? '', /model=glm-5\.3 reason=uncertified/);
    assert.equal(result.substantiveAnalysisIdentity?.pinned, false);
  });

  it('fails closed when a native-resolving model is requested but native review is not opted in', async () => {
    const { calls, nativeCalls } = setup({ agents: { 'kimi-k2': 'native-openrouter' }, nativeOptedIn: false });
    const result = await review('kimi-k2');
    assert.equal(calls.length, 0);
    assert.deepEqual(nativeCalls, []);
    assert.equal(result.failureCategory, 'review-model-unlaunchable');
    assert.match(result.reviewToolError ?? '', /agent=native-openrouter reason=native-review-not-opted-in/);
  });

  it('keeps the legacy unpinned executors when no model is requested', async () => {
    const native = setup({ nativeOptedIn: true });
    await review();
    assert.deepEqual(native.nativeCalls, [undefined]);
    assert.equal(native.calls.length, 0);
    reviewEngineTestUtils.resetDeps();

    // Native off: eval.judge.model (default claude-sonnet-5) on its resolved
    // CLI, with the quota fallback ladder as before.
    const cli = setup({ agents: { 'claude-sonnet-5': 'claude' }, nativeOptedIn: false });
    await review();
    assert.equal(cli.calls.length, 1);
    assert.equal(cli.calls[0]?.provider, 'claude');
    assert.equal(cli.calls[0]?.model, 'claude-sonnet-5');
    assert.equal(cli.calls[0]?.taskType, 'review');
    assert.deepEqual(cli.nativeCalls, []);
  });

  it('routes a legacy judge model to codex when the resolver places it there', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-judge-codex-'));
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({ eval: { judge: { model: 'gpt-5.5' } } }), 'utf-8');
    const { calls } = setup({ agents: { 'gpt-5.5': 'codex' } });
    try {
      const { runReview } = await import('./review-engine.ts');
      await runReview(makeReviewContext(), repoDir, { skipClaudePreflight: true });
      assert.equal(calls[0]?.provider, 'codex');
      assert.equal(calls[0]?.model, 'gpt-5.5');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('never pins the requested id when the CLI reports a different executed model', async () => {
    setup({ agents: { 'claude-opus-5-5': 'claude' }, reportedModel: () => 'claude-sonnet-5' });
    const result = await review('claude-opus-5-5');
    assert.equal(result.substantiveAnalysisIdentity?.requestedModel, 'claude-opus-5-5');
    assert.equal(result.substantiveAnalysisIdentity?.resolvedModel, 'claude-sonnet-5');
    assert.equal(result.substantiveAnalysisIdentity?.pinned, false);
    assert.equal(result.substantiveAnalysisIdentity?.fallbackReason, 'requested_model_unavailable');
  });

  it('returns native-context-window-exceeded when the CLI prompt cannot fit', async () => {
    const { calls } = setup({ agents: { 'claude-opus-5-5': 'claude' } });
    reviewEngineTestUtils.setBuildCliReviewAdapter((provider, model) => ({
      kind: provider === 'codex' ? 'codex-cli' : 'claude-cli',
      model,
      limits: {},
      countTokens: () => 0,
      preflight: () => ({
        kind: 'context-exceeded',
        message: 'Native review pre-flight rejected the launch: prompt exceeds the context window',
        policyKind: 'context-window-exceeded',
      }),
      invoke: async () => ({ text: '', reportedModel: 'unverified' }),
      parseResult: () => ({ text: '', reportedModel: 'unverified' }),
    }));
    const result = await review('claude-opus-5-5');
    assert.equal(calls.length, 0);
    assert.equal(result.verdict, 'error');
    assert.equal(result.failureCategory, 'native-context-window-exceeded');
    assert.match(result.reviewToolError ?? '', /context window/);
  });
});

describe('review-engine CLI helpers (HOK-3247, HOK-3248)', () => {
  it('matches CLI-reported ids across variant and snapshot suffixes only', async () => {
    const { claudeCliReportedModelMatches } = await import('./model-adapters/claude-cli-adapter.ts');
    assert.equal(claudeCliReportedModelMatches('claude-opus-4-6', 'claude-opus-4-6[1m]'), true);
    assert.equal(claudeCliReportedModelMatches('claude-haiku-4-5-20251001', 'claude-haiku-4-5'), true);
    assert.equal(claudeCliReportedModelMatches('claude-sonnet-5', 'claude-opus-5-5'), false);
  });

  it('pre-checks the CLI prompt against the registry context window via the adapter', async () => {
    const { ClaudeCliAdapter } = await import('./model-adapters/claude-cli-adapter.ts');
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-cw-'));
    try {
      const smallAdapter = new ClaudeCliAdapter({ model: 'claude-haiku-4-5', repoDir });
      assert.equal(smallAdapter.preflight('small diff'), undefined);

      const refusal = smallAdapter.preflight('x'.repeat(4 * 1024 * 1024));
      assert.ok(refusal);
      assert.equal(refusal!.kind, 'context-exceeded');
      assert.match(refusal!.message, /context/i);

      // Models without a registry limit are not pre-checked.
      const unknown = new ClaudeCliAdapter({ model: 'not-a-registered-model', repoDir });
      assert.equal(unknown.preflight('x'.repeat(4 * 1024 * 1024)), undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
