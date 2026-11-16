/**
 * HOK-3493 replay: PR #1862's real diff stays inside the judge's budget.
 *
 * Incident 2026-11-15: the eval asked GitHub for PR #1862's diff, which
 * returned 3,728,528 bytes because GitHub ignores `.gitattributes -diff` and
 * sent both regenerated `shared/validators/*.validator.cjs` in full. The judge
 * prompt was 3,810,241 bytes; every judge candidate failed with an empty
 * `is_error`; the mill retried the identical prompt three times and parked an
 * otherwise green PR.
 *
 * The fixture is the same change as local git renders it (216,200 bytes, both
 * validators as `Binary files … differ`). With the change built through
 * `buildBudgetedChangeInput`, the judge prompt fits the judge adapter, keeps
 * every source and test file verbatim, and shows the validators as git's
 * binary line.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateTask } from './eval.ts';
import { classifyTier, splitDiffByFile } from './review-input-budget.ts';
import { adapterForProvider } from './model-adapters/resolve-adapter.ts';
import { headlessProviderForModel } from './headless-llm.ts';
import type { LLMCallResult } from './llm-cli.ts';

// Test lives in shared/lib/; the fixture lives under tests/fixtures/.
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'incident-replay',
  'hok-3493-pr-1862',
);

/** The live default judge model (eval.ts DEFAULT_MODEL). */
const JUDGE_MODEL = 'gpt-5.6-terra';

function readFixture(): { diff: string; incident: { evalPromptSize: { totalBytes: number; prReviewOutputBytes: number } } } {
  return {
    diff: readFileSync(join(FIXTURE_DIR, 'local-git.diff'), 'utf-8'),
    incident: JSON.parse(readFileSync(join(FIXTURE_DIR, 'incident.json'), 'utf-8')),
  };
}

function validJudgeResponse(): LLMCallResult {
  return {
    text: JSON.stringify({ score: 0.9, rationale: 'Replayed.', interventionFlags: [] }),
    provider: 'codex',
    model: JUDGE_MODEL,
  } as LLMCallResult;
}

describe('HOK-3493 replay: PR #1862 through the budgeted change input', () => {
  it('builds a judge prompt inside the judge budget, with validators as binary lines', async () => {
    const { diff, incident } = readFixture();
    assert.equal(Buffer.byteLength(diff, 'utf8'), 216_200);

    // The incident's evidence: the eval sent 3.7 MB from gh for this same change.
    assert.equal(incident.evalPromptSize.totalBytes, 3_810_241);
    assert.equal(incident.evalPromptSize.prReviewOutputBytes, 3_728_528);

    const adapter = adapterForProvider(headlessProviderForModel(JUDGE_MODEL), { model: JUDGE_MODEL });
    let capturedPrompt = '';
    const previousModel = process.env.EVAL_MODEL;
    process.env.EVAL_MODEL = JUDGE_MODEL;
    try {
      await evaluateTask(
        { taskPrompt: 'Recover hung native harnesses through the controller', prReviewOutput: diff },
        undefined,
        {
          _judgeAdapter: adapter,
          _callFn: async (prompt) => {
            capturedPrompt = prompt;
            return validJudgeResponse();
          },
        },
      );
    } finally {
      if (previousModel === undefined) delete process.env.EVAL_MODEL;
      else process.env.EVAL_MODEL = previousModel;
    }

    // 1. The prompt is inside the judge's own budget: no typed refusal.
    assert.equal(adapter.preflight(capturedPrompt), undefined);
    assert.ok(
      adapter.limits.contextWindowTokens !== undefined || adapter.limits.maxInputChars !== undefined,
      'the judge adapter exposes a limit to fit',
    );

    // 2. Well under the 3.7 MB that broke the incident, and under the 400 KB bar.
    const promptBytes = Buffer.byteLength(capturedPrompt, 'utf8');
    assert.ok(promptBytes < 400_000, `prompt is ${promptBytes} bytes`);

    // 3. Both regenerated validators arrive as git's binary-file line, never as text.
    const binaryLines = capturedPrompt.match(/Binary files .* differ/g) ?? [];
    assert.equal(binaryLines.length, 2, `binary lines: ${JSON.stringify(binaryLines)}`);
    assert.match(capturedPrompt, /Binary files .*shared\/validators\/eval-record\.validator\.cjs.* differ/);
    assert.match(capturedPrompt, /Binary files .*shared\/validators\/wavemill-config\.validator\.cjs.* differ/);

    // 4. Every source and test file (and every docs/config file here) is verbatim.
    for (const { path, chunk } of splitDiffByFile(diff)) {
      if (classifyTier(path) > 3) continue;
      assert.ok(capturedPrompt.includes(chunk), `${path} is verbatim`);
    }
  });

  // The issue's known gap, pinned: on the gh fallback a regenerated validator
  // counts as source and cannot be summarised. That path now refuses with the
  // adapter's typed error — a visible, terminal failure — instead of shipping a
  // 3.7 MB prompt the CLI fails on and retrying it.
  it('refuses the gh-shaped regenerated validator instead of retrying an oversize prompt', async () => {
    const regenerated = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'validators', 'eval-record.validator.cjs'),
      'utf-8',
    );
    const lines = regenerated.split('\n');
    const ghShapedDiff = [
      'diff --git a/shared/validators/eval-record.validator.cjs b/shared/validators/eval-record.validator.cjs',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/shared/validators/eval-record.validator.cjs',
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      '',
    ].join('\n');
    assert.ok(Buffer.byteLength(ghShapedDiff, 'utf8') > 800_000);

    const adapter = adapterForProvider(headlessProviderForModel(JUDGE_MODEL), { model: JUDGE_MODEL });
    let judgeCalled = false;
    const previousModel = process.env.EVAL_MODEL;
    process.env.EVAL_MODEL = JUDGE_MODEL;
    try {
      await assert.rejects(
        evaluateTask(
          { taskPrompt: 'Regenerate the eval validator', prReviewOutput: ghShapedDiff },
          undefined,
          {
            _judgeAdapter: adapter,
            _callFn: async () => {
              judgeCalled = true;
              return validJudgeResponse();
            },
          },
        ),
        (error: unknown) => {
          assert.equal((error as Error).name, 'ChangeInputRefusedError');
          assert.equal(
            (error as { adapterError: { policyKind: string } }).adapterError.policyKind,
            'context-window-exceeded',
          );
          return true;
        },
      );
    } finally {
      if (previousModel === undefined) delete process.env.EVAL_MODEL;
      else process.env.EVAL_MODEL = previousModel;
    }
    assert.equal(judgeCalled, false, 'no model call for a change that cannot fit');
  });
});
