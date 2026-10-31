// allow-executed-model-resolver: this file *is* the executed-model-resolver
// guard; its pattern table names every forbidden shape. It is auto-excluded
// from its own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one executed-model resolver (HOK-3369).
 *
 * The invariant is that every stage-result write path resolves the executed
 * model through `resolveStageExecutedModel` in `shared/lib/executed-model-resolver.ts`,
 * and attribution eligibility is decided only in `shared/lib/stage-result.ts`.
 * This guard fails when a site tries to reintroduce one of three bugs:
 *
 * 1. The shell runs `resolve-executed-model.ts` as a separate `tsx` process
 *    (the HOK-3328 pattern HOK-3369 deletes). The CLI resolves in-process now.
 * 2. A second file imports session-model internals (`resolveExecutedModelFromSessions`)
 *    — the one resolver owns them.
 * 3. A second file writes eligibility reason literals (`'runtime_fallback'`,
 *    `'missing_execution_evidence'`) outside stage-result.ts — the one
 *    attribution decision owns them.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const EXECUTED_MODEL_RESOLVER_GUARD: GuardSpec = {
  name: 'executed-model-resolver',
  findingNoun: 'executed-model resolver violation(s)',
  suppressionMarker: 'allow-executed-model-resolver',
  allowlistFile: 'tools/executed-model-resolver-allowlist.txt',
  patterns: [
    {
      name: 'shell-invokes-retired-resolver-tool',
      description: 'Shell no longer runs resolve-executed-model.ts; the CLI write path resolves in-process (HOK-3369).',
      lang: 'sh',
      re: /resolve-executed-model\.ts\b/,
    },
    {
      name: 'imports-session-resolver-internals',
      description: 'Only the one resolver (shared/lib/executed-model-resolver.ts) imports resolveExecutedModelFromSessions.',
      lang: 'ts',
      re: /\bresolveExecutedModelFromSessions\b/,
    },
    {
      name: 'runtime-fallback-literal-outside-stage-result',
      description: "Eligibility reason 'runtime_fallback' lives only in shared/lib/stage-result.ts (HOK-3369).",
      lang: 'ts',
      re: /['"]runtime_fallback['"]/,
    },
    {
      name: 'missing-execution-evidence-literal-outside-stage-result',
      description: "Eligibility reason 'missing_execution_evidence' lives only in shared/lib/stage-result.ts (HOK-3369).",
      lang: 'ts',
      re: /['"]missing_execution_evidence['"]/,
    },
  ],
  invariantPaths: [
    // The one resolver and its tests/wrappers.
    'shared/lib/executed-model-resolver.ts',
    'shared/lib/executed-model-resolver-guard.ts',
    'tools/resolve-executed-model.ts', // install-paths: allow guard's self-exclusion list, not a tool invocation
    'tools/check-executed-model-resolver.ts', // install-paths: allow guard's self-exclusion list, not a tool invocation
    // The one attribution decision and its CLI write path.
    'shared/lib/stage-result.ts',
    'tools/stage-result-cli.ts', // install-paths: allow guard's self-exclusion list, not a tool invocation
    'tools/backfill-stage-executed-model.ts', // install-paths: allow guard's self-exclusion list, not a tool invocation
    // Model-registry equivalence tables may contain the literal strings as
    // enum values — allowed because they are not an eligibility decision.
    'shared/lib/eval-schema.ts',
    'shared/validators/stage-result.schema.ts',
    'shared/schemas/stage-result.schema.json',
    // Native launcher records its own direct evidence; the resolver reads it.
    'shared/lib/native-agent/launch-planning.ts',
    'shared/lib/native-agent/launch-coding.ts',
    'shared/lib/native-agent/review.ts',
    // Challenge/eval attribution helpers inspect the reason post-decision.
    // Not writers — but they repeat the literals as predicates, so the guard
    // treats them as invariant text (same rule as the model-equivalence guard).
    'shared/lib/challenge-attestation-backfill.ts',
    'shared/lib/arm-failure-taxonomy.ts',
  ],
  remediation: [
    'HOK-3369: one executed-model resolver (shared/lib/executed-model-resolver.ts)',
    'owns every harness. The CLI write path (tools/stage-result-cli.ts) resolves',
    'in-process on `completed`. Attribution eligibility lives only in',
    'shared/lib/stage-result.ts; no second site may compute runtime_fallback or',
    'missing_execution_evidence.',
  ],
};
