#!/usr/bin/env -S npx tsx
/**
 * failure-policy-cli — shell bridge to the HOK-3176 failure policy.
 *
 * `failure_policy_decide` (shared/lib/wavemill-common.sh) calls this so the
 * monitor classifies stage failures with the same module the TS gates use.
 * Prints one JSON line:
 *   {"class":…,"failureKind":…,"terminalCode":…,"retryBucket":…,"nextAction":…,"rationale":…}
 * With --next-action-only, prints just the operator hint for --failure-kind.
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import type { CiFailureCategory } from '../shared/lib/ci-failure-classifier.ts';
import { classifyFailure, nextActionFor, type FailureStage } from '../shared/lib/failure-policy.ts';

const STAGES: ReadonlySet<string> = new Set(['planning', 'coding', 'review', 'ready', 'tend', 'eval']);
const CI_CATEGORIES: ReadonlySet<string> = new Set(['deterministic-local', 'transient-infra', 'github-only', 'unknown']);

runTool({
  name: 'failure-policy-cli',
  description: 'Classify a stage failure as terminal, code-failure, or retryable (HOK-3176)',
  options: {
    stage: { type: 'string', description: 'planning | coding | review | ready | tend | eval' },
    'failure-kind': { type: 'string', description: 'Typed failure kind, when the stage recorded one' },
    detail: { type: 'string', description: 'Raw failure detail (pass as --detail=<text>)' },
    'handoff-reason': { type: 'string', description: 'Typed coding handoff reason' },
    'ci-category': { type: 'string', description: 'ci-failure-classifier category' },
    'challenge-arm': { type: 'boolean', description: 'The task is a tracked challenge arm' },
    'next-action-only': { type: 'boolean', description: 'Print only the next-action hint for --failure-kind' },
  },
  examples: [
    'npx tsx tools/failure-policy-cli.ts --stage coding --detail="Native coding failed: 402 Payment Required"',
    'npx tsx tools/failure-policy-cli.ts --next-action-only --failure-kind coding-dirty-handoff',
  ],
  run({ args }) {
    if (args['next-action-only']) {
      console.log(nextActionFor(args['failure-kind']));
      return;
    }
    const stage = args.stage ?? '';
    if (!STAGES.has(stage)) {
      throw new Error(`--stage must be one of: ${[...STAGES].join(', ')} (got "${stage}")`);
    }
    const ciCategory = args['ci-category'];
    const decision = classifyFailure({
      stage: stage as FailureStage,
      failureKind: args['failure-kind'],
      detail: args.detail,
      handoffReason: args['handoff-reason'],
      ciCategory: ciCategory && CI_CATEGORIES.has(ciCategory) ? (ciCategory as CiFailureCategory) : undefined,
      challengeArm: args['challenge-arm'] === true,
    });
    console.log(JSON.stringify({
      class: decision.class,
      failureKind: decision.failureKind,
      terminalCode: decision.cause?.code ?? null,
      retryBucket: decision.retryBucket ?? null,
      nextAction: decision.nextAction,
      rationale: decision.rationale,
    }));
  },
});
