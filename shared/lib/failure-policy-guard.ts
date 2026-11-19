// allow-failure-policy: this file *is* the failure-policy guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the single failure policy (HOK-3176, enforced by
 * HOK-3236): whether a failure parks (`terminal`) is decided only by
 * `classifyFailure()` against `TERMINAL_ALLOWLIST` in
 * shared/lib/failure-policy.ts (shell: `failure_policy_decide`). Everything
 * unrecognised is retryable. A classifier branch elsewhere that decides
 * "this one parks" is exactly what the invariant forbids.
 *
 * Shapes caught — producers of a parking decision, never readers of one
 * (`decision.class === 'terminal'` is fine):
 * - a `class: 'terminal'` decision literal;
 * - a `retryable: false` classification;
 * - a private terminal/fatal/non-retryable pattern table
 *   (`TERMINAL_ERROR_PATTERNS = [...]`, `FATAL_SIGNATURES=(…)`).
 *
 * Lower-level provider/CLI taxonomies that feed into the policy are
 * allowlisted with a reason in tools/failure-policy-allowlist.txt.
 *
 * One budget-exhaustion outcome (HOK-3362): "a native stage ran out of
 * budget" is defined once, in shared/lib/native-agent/budget-exhaustion.ts.
 * Also caught:
 * - a private budget stop-reason switch (`case 'model_time_limit':`,
 *   `=== 'turn_limit'`, `new Set<LoopStopReason>(`) — use
 *   `isBudgetStopReason` / `budgetKindForStopReason` / `budgetExhaustionFromLoop`;
 * - a private final-assistant `errorMessage` scan — use
 *   `finalProviderErrorMessage`, which returns '' on a budget stop;
 * - `classifyProviderError(` over a raw transcript (`.messages`) in a native
 *   stage function that never consults the budget definition — our own budget
 *   abort must never be classified as a provider error.
 *
 * One tracked-job exhaustion path (HOK-3505): every `bounded_retry_mark_exhausted`
 * on a tracked async-job bucket must be followed by
 * `escalate_operator_attention` within the same branch, or the bucket must be
 * in QUIET_EXHAUSTION_BUCKETS. The guard scans `monitor-async-jobs.sh`.
 *
 * Native stage time share (HOK-3380): "whose time was this" is derived once,
 * by `nativeStageTimeSplit` in shared/lib/native-agent/stage-time-split.ts.
 * Also caught:
 * - `private-stage-time-share` — a share/division of a time-split bucket over
 *   the wall clock, or a private `providerWaitMs` accumulation, computed
 *   outside that module;
 * - `private-tool-duration` — tool-event timestamp arithmetic
 *   (`tool_result.timestamp - tool_started.timestamp`) computed outside that
 *   module.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

/**
 * Tracked async-job buckets where exhaustion is expected to degrade quietly
 * rather than page an operator. Every other bucket that calls
 * `bounded_retry_mark_exhausted` must follow up with
 * `escalate_operator_attention` in the same branch (HOK-3505).
 */
/**
 * Tracked async-job bucket values and their shell variable names where
 * exhaustion is expected to degrade quietly rather than page an operator.
 */
export const QUIET_EXHAUSTION_BUCKETS: ReadonlySet<string> = new Set([
  'in-flight-touch-set-job',
]);

const QUIET_BUCKET_VARS: ReadonlySet<string> = new Set([
  'IN_FLIGHT_TOUCH_SET_JOB_BUCKET',
]);

function findUnescalatedExhaustion(source: string): StructuralMatch[] {
  const lines = source.split('\n');
  const matches: StructuralMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bbounded_retry_mark_exhausted\b/.test(lines[i])) continue;
    if (/^\s*(?:#|\/\/|\*)/.test(lines[i])) continue;
    const contextBefore = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
    const isQuietByLiteral = [...QUIET_EXHAUSTION_BUCKETS].some(b =>
      contextBefore.includes(`"${b}"`) || contextBefore.includes(`'${b}'`));
    const isQuietByVar = [...QUIET_BUCKET_VARS].some(v =>
      contextBefore.includes(`$${v}`) || contextBefore.includes(`"$${v}"`));
    if (isQuietByLiteral || isQuietByVar) continue;
    const window = lines.slice(i, Math.min(lines.length, i + 10)).join('\n');
    if (!/\bescalate_operator_attention\b/.test(window)) {
      matches.push({ line: i + 1, detail: 'bounded_retry_mark_exhausted without escalate_operator_attention' });
    }
  }
  return matches;
}

/** Native stage sources whose provider classification must follow the budget rule. */
const NATIVE_STAGE_SOURCES = [
  'shared/lib/native-agent/launch-coding.ts',
  'shared/lib/native-agent/launch-planning.ts',
  'shared/lib/native-agent/review.ts',
  'shared/lib/native-agent/loop.ts',
  'shared/lib/native-agent/certification/live-coding-canary.ts',
  'shared/lib/native-expansion.ts',
] as const;

/** Calls that consult the one budget definition before reading error text. */
const BUDGET_GATE = /\b(?:finalProviderErrorMessage|isBudgetStopReason|budgetKindForStopReason|budgetExhaustionFromLoop)\(/;

/** Start of a top-level declaration (function, or a const/let arrow in a function body). */
const DECLARATION_START = /^(?:export\s+)?(?:async\s+)?function\s|^\s{0,4}(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(/;

/**
 * `classifyProviderError(` in a declaration that reads the raw transcript
 * (`.messages`) without consulting the budget definition (HOK-3362).
 */
function findUngatedProviderClassification(source: string): StructuralMatch[] {
  const lines = source.split('\n');
  const matches: StructuralMatch[] = [];
  lines.forEach((line, index) => {
    if (!/\bclassifyProviderError\(/.test(line) || /^\s*(?:\/\/|\*|import\b)/.test(line)) return;
    let start = index;
    while (start > 0 && !DECLARATION_START.test(lines[start])) start -= 1;
    const body = lines.slice(start, index + 1).join('\n');
    if (/\.messages\b/.test(body) && !BUDGET_GATE.test(body)) {
      matches.push({ line: index + 1 });
    }
  });
  return matches;
}

export const FAILURE_POLICY_GUARD: GuardSpec = {
  name: 'failure-policy',
  invariantDocs: ['docs/invariants/failure-policy.md'],
  findingNoun: 'private parking classifier(s)',
  suppressionMarker: 'allow-failure-policy',
  allowlistFile: 'tools/failure-policy-allowlist.txt',
  invariantPaths: [
    'shared/lib/failure-policy.ts',
    'shared/lib/failure-policy-guard.ts',
    // HOK-3362: the one budget-exhaustion definition.
    'shared/lib/native-agent/budget-exhaustion.ts',
    // HOK-3380: the one native stage time-share derivation.
    'shared/lib/native-agent/stage-time-split.ts',
    // HOK-3360: the one operator-escalation step (the only place that may
    // write .needs-attention). Both the shell helper and its TS twin.
    'shared/lib/operator-escalation.sh',
    'shared/lib/operator-escalation.ts',
  ],
  structuralChecks: [{
    name: 'budget-stop-provider-classification',
    description: 'classifyProviderError over a raw transcript without the budget rule — read errors through finalProviderErrorMessage (HOK-3362)',
    paths: NATIVE_STAGE_SOURCES,
    find: findUngatedProviderClassification,
  }, {
    name: 'unescalated-tracked-job-exhaustion',
    description: 'bounded_retry_mark_exhausted on a tracked-job bucket without escalate_operator_attention — add escalation or declare the bucket quiet in QUIET_EXHAUSTION_BUCKETS (HOK-3505)',
    paths: ['shared/lib/monitor-async-jobs.sh'],
    find: findUnescalatedExhaustion,
  }, {
    name: 'eval-retry-forfeit',
    description: 'eval retry exhaustion cannot create a model forfeit; use failure-policy',
    paths: ['shared/lib/challenge-pair-resolver.ts', 'shared/lib/wavemill-common.sh', 'shared/lib/wavemill-monitor.sh'],
    find(source) {
      const lines = source.split('\n');
      return lines.flatMap((line, index) => /(?:evalFailed|evalHardFailureRetryCount|isHardFailureExhausted)/.test(line)
        && /(?:buildForfeitComparison|buildDoubleForfeitComparison|write_challenge_pair_record)/.test(lines.slice(index, index + 12).join('\n'))
        ? [{ line: index + 1 }] : []);
    },
  }],
  patterns: [
    {
      name: 'private-budget-stop-switch',
      description: 'private budget stop-reason switch — use isBudgetStopReason / budgetKindForStopReason / budgetExhaustionFromLoop (budget-exhaustion.ts, HOK-3362)',
      lang: 'ts',
      re: /\bcase\s+['"](?:turn|token|tool_call|model_time|wall_clock|cost)_limit['"]\s*:|[!=]==\s*['"](?:turn|token|tool_call|model_time|wall_clock|cost)_limit['"]|['"](?:turn|token|tool_call|model_time|wall_clock|cost)_limit['"]\s*[!=]==|\bnew\s+Set<LoopStopReason>\((?:\[[^\]]*_limit|\[\s*$)/,
    },
    {
      name: 'private-final-error-scan',
      description: 'private final-assistant errorMessage scan — use finalProviderErrorMessage, which never returns our own budget abort (HOK-3362)',
      lang: 'ts',
      re: /\.errorMessage\?\.trim\(\)|\(\s*message\s+as\s+[^)]*\)\.errorMessage\b/,
    },
    {
      name: 'private-stage-time-share',
      description: 'native stage time share computed outside nativeStageTimeSplit (stage-time-split.ts, HOK-3380)',
      lang: 'ts',
      re: /\b(?:providerWaitMs|harnessToolMs|modelMs|toolDurationMs)\b\s*\/|\/\s*[\w.]*\bwallClockMs\b|\bproviderWaitMs\s*\+=/,
    },
    {
      name: 'private-tool-duration',
      description: 'native stage time share computed outside nativeStageTimeSplit (stage-time-split.ts, HOK-3380)',
      lang: 'ts',
      re: /(?:tool_?[Rr]esult|tool_?[Ss]tarted|toolEnd|toolStart)\w*\.timestamp\s*-|\.timestamp\s*-\s*[\w.]*(?:tool_?[Ss]tarted|toolStart)/,
    },
    {
      name: 'private-eval-retry-decision',
      description: 'An eval failure plus a retry counter cannot decide a model outcome; consume failure-policy.',
      lang: 'both',
      re: /\bif\b(?=[^\n]*(?:evalFailed|eval_failed))(?=[^\n]*(?:[Rr]etryCount|retry_count|[Rr]etries))[^\n]*/,
    },
    {
      name: 'retired-eval-forfeit-resolver',
      description: 'eval exhaustion must not resolve a pair; use failure_policy_decide and bounded retry',
      lang: 'both',
      re: /\bresolve_challenge_pair_hard_failure\s*(?:\(|["' ])|\bfunction\s+isHardFailureExhausted\s*\(/,
    },
    {
      name: 'terminal-decision-literal',
      description: '`class: \'terminal\'` decision built outside failure-policy.ts — call classifyFailure() / failure_policy_decide',
      lang: 'both',
      re: /["']?\bclass["']?\s*:\s*["']terminal["']/,
    },
    {
      name: 'non-retryable-classification',
      description: '`retryable: false` — a private parking classification; add a fixture to failure-policy.fixtures.test.ts instead',
      lang: 'ts',
      re: /\bretryable\s*:\s*false\b/,
    },
    {
      name: 'terminal-pattern-table',
      description: 'private terminal/fatal/non-retryable signature table — extend TERMINAL_ALLOWLIST (with a reason and test) or let it retry',
      lang: 'both',
      re: /\b[A-Z_]*(?:TERMINAL|FATAL|PERMANENT|NON_?RETRYABLE|UNRECOVERABLE)[A-Z_]*_(?:PATTERNS|SIGNATURES|REGEX(?:ES)?|RES|MATCHERS)\s*[:=(]/,
    },
    {
      name: 'attention-write-outside-escalation',
      description: 'operator attention is raised only by escalate_operator_attention / escalateOperatorAttention (shared/lib/operator-escalation.{sh,ts}, HOK-3360)',
      lang: 'both',
      re: /\bwrite_ready_attention_file\b|\b_operator_attention_write\b|\bwriteReadyAttention\b|\bwrite_transient_ready_attention_file\b|marker_write\s+"[^"]*\.needs-attention|path:\s*[^,}]*["']\.needs-attention["']/,
    },
    {
      name: 'retired-task-inputs-failure-marker',
      description: 'the .task-inputs-failure.json private marker and inputs_preparation_failed hook were removed (HOK-3505) — task-input exhaustion escalates through escalate_operator_attention',
      lang: 'both',
      re: /\.task-inputs-failure\.json\b|task_inputs_failure_marker\b|inputs_preparation_failed\b/,
    },
    {
      name: 'retired-transient-attention',
      description: 'the .needs-attention-transient kind / ready-attention-transient marker was removed (HOK-3360) — a transient mergeability is a retry state, not an attention kind',
      lang: 'both',
      re: /\.needs-attention-transient\b|ready-attention-transient\b/,
    },
  ],
  remediation: [
    'Every stage gate classifies failures through classifyFailure() / failure_policy_decide',
    '(HOK-3176): terminal only for TERMINAL_ALLOWLIST entries, code-failure for recognised',
    'signatures, retryable by default. Never add a classifier branch that parks: add a',
    'fixture to failure-policy.fixtures.test.ts, and only extend the allowlist (with a',
    'reason and test) when retrying provably cannot change the outcome.',
  ],
};
