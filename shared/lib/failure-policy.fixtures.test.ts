/**
 * Table-driven acceptance test for HOK-3176: every failure string the mill
 * actually hit in the month before the change, and the class the policy
 * must assign it.
 *
 * Sources: `.wavemill/incidents/*.evidence.jsonl` and the mill/tend logs
 * (2026-09-09 → 2026-10-09), stage-result notes / `challengeAborted`
 * reasons from that window, the incident-replay fixtures, and the strings
 * quoted in HOK-3129, HOK-3155, HOK-3163, HOK-3169, HOK-3170 and #1601. A
 * new string belongs here before (or instead of) a new classifier branch.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAbortFailureKind } from './arm-failure-taxonomy.ts';
import { classifyFailure, type FailureClass, type FailureEvidence } from './failure-policy.ts';

interface Fixture {
  name: string;
  evidence: FailureEvidence;
  expectedClass: FailureClass;
  expectedKind?: string;
}

const HISTORICAL_FIXTURES: Fixture[] = [
  // ── Native stage hook details (monitor `Native <stage> failed (...)`) ──
  {
    name: 'provider context overflow (400 maximum context length)',
    evidence: { stage: 'coding', detail: "Native coding failed: 400 This endpoint's maximum context length is 131072 tokens. However, you requested about 131182 tokens", challengeArm: true },
    expectedClass: 'terminal',
    expectedKind: 'context-window-exceeded',
  },
  {
    name: 'pre-flight context overflow',
    evidence: { stage: 'coding', detail: 'Native coding pre-flight rejected the launch: estimated prompt is ~98414 input tokens plus 32768 reserved output tokens = 131182, which exceeds the 131072-token context window of moonshotai/kimi-k2 (openrouter, limit from registry). The provider would reject this request (context_length_exceeded).' },
    expectedClass: 'terminal',
    expectedKind: 'context-window-exceeded',
  },
  {
    name: 'invalid model id',
    evidence: { stage: 'coding', detail: 'Native coding failed: 400 qwen-2.5-coder-32b is not a valid model ID' },
    expectedClass: 'terminal',
    expectedKind: 'provider-config-error',
  },
  {
    name: 'no tool-use endpoint',
    evidence: { stage: 'coding', detail: 'Native coding failed: 404 No endpoints found that support tool use' },
    expectedClass: 'terminal',
    expectedKind: 'tool-use-unsupported',
  },
  {
    name: 'HOK-3155: 402 can-only-afford',
    evidence: { stage: 'coding', detail: 'Native coding failed: HTTP 402 Payment Required: This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 1123.' },
    expectedClass: 'retryable',
    expectedKind: 'provider-credit-exhausted',
  },
  {
    name: 'HOK-3155: 402 exceed-your-available-credits',
    evidence: { stage: 'coding', detail: 'Native coding failed: HTTP 402 This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.' },
    expectedClass: 'retryable',
    expectedKind: 'provider-credit-exhausted',
  },
  {
    name: 'empty model turns',
    evidence: { stage: 'coding', detail: 'Native coding failed: empty-model-turn: model returned reasoning-only or otherwise empty assistant turns after a continuation prompt' },
    expectedClass: 'retryable',
    expectedKind: 'empty-model-turn',
  },
  {
    name: 'context compacted to the floor',
    evidence: { stage: 'coding', detail: 'Native coding failed: context-exhausted: compacted native coding context to the floor and still exceeded the model context window' },
    expectedClass: 'retryable',
    expectedKind: 'context-exhausted',
  },
  {
    name: 'provider finish_reason error',
    evidence: { stage: 'coding', detail: 'Native coding failed: Provider finish_reason: error', challengeArm: true },
    expectedClass: 'retryable',
    expectedKind: 'provider-transient-error',
  },
  {
    name: 'rate limit 429',
    evidence: { stage: 'review', detail: 'Native review failed: 429 Too Many Requests: rate limit exceeded' },
    expectedClass: 'retryable',
    expectedKind: 'provider-transient-error',
  },
  {
    name: 'native-provider-error with typed handoff (40× in the mill log)',
    evidence: { stage: 'coding', detail: 'Native coding failed: provider returned an error', handoffReason: 'provider_error', challengeArm: true },
    expectedClass: 'retryable',
    expectedKind: 'native-provider-error',
  },
  {
    name: 'native-unclassified planning arm (4× in the mill log)',
    evidence: { stage: 'planning', detail: 'Native planning failed: stage exited unexpectedly', challengeArm: true },
    expectedClass: 'retryable',
    expectedKind: 'native-unclassified',
  },
  {
    name: 'typed completion-protocol handoff',
    evidence: { stage: 'coding', detail: 'Native coding failed: Provider finish_reason: error', handoffReason: 'no_completion_artifact' },
    expectedClass: 'retryable',
    expectedKind: 'native-completion-protocol',
  },
  // ── HOK-3129 signatures ──
  {
    name: 'HOK-3129: coding agent exited without a result',
    evidence: { stage: 'coding', detail: 'Interrupted: coding agent exited without recording a result - durable commits preserved at 1a2b3c4' },
    expectedClass: 'retryable',
    expectedKind: 'coding-exited-without-result',
  },
  {
    name: 'coding interruption whose SHA contains 5xx-looking digits',
    evidence: { stage: 'coding', detail: 'Interrupted: coding agent exited without recording a result - durable commits preserved at 0c564d2' },
    expectedClass: 'retryable',
    expectedKind: 'coding-exited-without-result',
  },
  {
    name: 'HOK-3129: review produced no findings',
    evidence: { stage: 'review', detail: 'Native review flow failed after 0 findings' },
    expectedClass: 'retryable',
    expectedKind: 'review-no-output',
  },
  {
    name: 'HOK-3129: review no output with typed credit cause',
    evidence: { stage: 'review', detail: 'Native review flow failed after 0 findings [typed envelope cause: provider-credit-exhausted]' },
    expectedClass: 'retryable',
  },
  {
    name: 'HOK-3129: planning turn limit',
    evidence: { stage: 'planning', detail: 'Native planning rejected before approval: turn_limit' },
    expectedClass: 'retryable',
    expectedKind: 'planning-turn-limit',
  },
  {
    name: 'HOK-3129: planning artifact rejected',
    evidence: { stage: 'planning', detail: 'Native planning final artifact rejected: missing_plan_sections' },
    expectedClass: 'retryable',
    expectedKind: 'planning-artifact-invalid:missing_plan_sections',
  },
  // ── HOK-3163 / HOK-3169 ──
  {
    name: 'HOK-3163: content-filtered Responses turn',
    evidence: { stage: 'coding', detail: 'Response incomplete: content_filter' },
    expectedClass: 'retryable',
    expectedKind: 'provider-response-incomplete',
  },
  {
    name: 'HOK-3169: malformed native review (typed category)',
    evidence: { stage: 'review', failureKind: 'native-review-malformed-response', detail: 'Native review returned a malformed final response: Unexpected token < in JSON at position 0' },
    expectedClass: 'retryable',
  },
  {
    name: 'HOK-3169: Ready refused on malformed review (non-challenge)',
    evidence: { stage: 'ready', failureKind: 'review-malformed-response', detail: 'Ready launch refused for PR #1601: review verdict does not pass the readiness gate; failureCategory=native-review-malformed-response' },
    expectedClass: 'retryable',
  },
  {
    name: 'HOK-3154: Ready refused on a genuine not_ready verdict (challenge arm)',
    evidence: { stage: 'ready', failureKind: 'review-not-ready', detail: 'Ready launch refused for PR #1544: review verdict does not pass the readiness gate (terminal until the review artifact changes); verdict=not_ready, blockers=7', challengeArm: true },
    expectedClass: 'terminal',
  },
  // ── HOK-3170: deterministic CI failure ──
  {
    name: 'HOK-3170: preflight seam guard failure in CI',
    evidence: { stage: 'ready', ciCategory: 'deterministic-local', detail: 'not ok 3 - check-install-paths: tools must resolve through install-paths.ts' },
    expectedClass: 'code-failure',
  },
  {
    name: 'HOK-3170: TAP failure without CI category',
    evidence: { stage: 'ready', detail: 'shell (2/3)\nnot ok 3 - check-common-guards\n# 41 passed, 1 failed' },
    expectedClass: 'code-failure',
  },
  // ── #1601 and tend ──
  {
    name: '#1601: dropped connection during tend push',
    evidence: { stage: 'tend', detail: "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: unable to access 'https://github.com/timogilvie/wavemill.git/': Recv failure: Connection reset by peer" },
    expectedClass: 'retryable',
  },
  {
    name: 'tend rebase conflict',
    evidence: { stage: 'tend', detail: 'Auto-merging shared/lib/x.ts\nCONFLICT (content): Merge conflict in shared/lib/x.ts\nerror: could not apply 1a2b3c4... HOK-1: change\nhint: Resolve all conflicts manually' },
    expectedClass: 'code-failure',
  },
  {
    name: 'tend force-with-lease rejected (someone pushed)',
    evidence: { stage: 'tend', detail: ' ! [rejected]        HEAD -> task/x (stale info)\nerror: failed to push some refs' },
    expectedClass: 'retryable',
  },
  {
    name: 'ready watchdog auto-update push failed',
    evidence: { stage: 'ready', detail: "Auto-update exhausted after 3 attempts: Command failed: git push origin 'task/self-review-iteration-can-revert-unrelated-merged-work'" },
    expectedClass: 'retryable',
  },
  {
    name: 'PR create failed: no commits between base and head',
    evidence: { stage: 'review', detail: 'pull request create failed: GraphQL: No commits between auto/integration and task/self-review-diffs-against-the-stale-local-base' },
    expectedClass: 'retryable',
  },
  // ── Eval / router / tooling ──
  {
    name: 'eval result JSON parse failure',
    evidence: { stage: 'eval', detail: 'Post-completion eval: failed (workflow unaffected) — Unexpected non-whitespace character after JSON at position 12 (line 1 column 13)' },
    expectedClass: 'retryable',
  },
  {
    name: 'eval not persisted',
    evidence: { stage: 'eval', detail: 'kind=eval status=failed reason=eval_not_persisted resultMissing=false' },
    expectedClass: 'retryable',
  },
  {
    name: 'router LLM fallback deadline',
    evidence: { stage: 'planning', detail: 'reason=inference_unavailable diagnostic=LLM fallback deadline exhausted before claude-fable-5 failureCount=3' },
    expectedClass: 'retryable',
  },
  {
    name: 'module export missing at tool startup',
    evidence: { stage: 'coding', detail: "SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'" },
    expectedClass: 'retryable',
  },
  {
    name: 'Hokusai router HTTP 500',
    evidence: { stage: 'planning', detail: '[hokusai-router] Hokusai routing failed (server_error): HTTP 500' },
    expectedClass: 'retryable',
  },
  // ── Typed kinds that keep parking ──
  {
    name: 'policy denial',
    evidence: { stage: 'coding', failureKind: 'policy-denied', detail: 'network policy denied fetch to example.com' },
    expectedClass: 'terminal',
  },
  {
    name: 'operator cancel',
    evidence: { stage: 'coding', failureKind: 'cancelled' },
    expectedClass: 'terminal',
  },
];

/** Recorded `challengeAborted` reasons from the window, parsed the way the resolver does. */
const ABORT_REASON_FIXTURES: Array<{ abortReason: string; challengeArm: boolean; expectedClass: FailureClass }> = [
  { abortReason: 'terminal_stage_failure:coding-exited-without-result', challengeArm: true, expectedClass: 'retryable' },
  { abortReason: 'terminal_stage_failure:provider-credit-exhausted', challengeArm: true, expectedClass: 'retryable' },
  { abortReason: 'terminal_launch_failure:native-provider-error', challengeArm: true, expectedClass: 'retryable' },
  { abortReason: 'retry_exhausted:native-review-timeout', challengeArm: true, expectedClass: 'retryable' },
  { abortReason: 'invalid_challenge:review-identity-mismatch', challengeArm: true, expectedClass: 'terminal' },
  { abortReason: 'invalid_challenge:ready-unattributed', challengeArm: true, expectedClass: 'terminal' },
  { abortReason: 'terminal_stage_failure:ready-exhausted', challengeArm: true, expectedClass: 'terminal' },
  { abortReason: 'terminal_stage_failure:coding-dirty-handoff', challengeArm: true, expectedClass: 'terminal' },
  { abortReason: 'varied_model_unresolvable', challengeArm: true, expectedClass: 'terminal' },
];

/**
 * Representative error text per incident-replay fault. Every fault used by a
 * checked-in fixture must appear here, so adding a replay fixture forces its
 * failure string into this table.
 */
const REPLAY_FAULT_DETAILS: Record<string, { evidence: FailureEvidence; expectedClass: FailureClass }> = {
  control_no_fault: { evidence: { stage: 'tend', detail: '' }, expectedClass: 'retryable' },
  agent_sigkill_mid_stage: {
    evidence: { stage: 'coding', detail: 'Interrupted: coding agent exited without recording a result - durable commits preserved at 1a2b3c4' },
    expectedClass: 'retryable',
  },
  dropped_connection_push_rebase: {
    evidence: { stage: 'tend', detail: 'fatal: the remote end hung up unexpectedly\nerror: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly: ECONNRESET' },
    expectedClass: 'retryable',
  },
  github_head_lag: {
    evidence: { stage: 'tend', detail: 'handoff rebind refused: head does not match pushed commit (observed=1a2b3c4 pushed=5d6e7f8)' },
    expectedClass: 'retryable',
  },
  host_sleep: {
    evidence: { stage: 'coding', detail: 'monitor tick gap of 900s; agent hook stale' },
    expectedClass: 'retryable',
  },
  malformed_model_response: {
    evidence: { stage: 'review', detail: 'Native review returned a non-JSON final response' },
    expectedClass: 'retryable',
  },
  provider_402_or_429: {
    evidence: { stage: 'coding', detail: 'HTTP 402 Payment Required: insufficient credits' },
    expectedClass: 'retryable',
  },
};

for (const fixture of HISTORICAL_FIXTURES) {
  test(`historical: ${fixture.name}`, () => {
    const decision = classifyFailure(fixture.evidence);
    assert.equal(decision.class, fixture.expectedClass, `${fixture.name}: ${decision.rationale}`);
    if (fixture.expectedKind) {
      assert.equal(decision.failureKind, fixture.expectedKind);
    }
  });
}

for (const fixture of ABORT_REASON_FIXTURES) {
  test(`abort reason: ${fixture.abortReason}`, () => {
    const failureKind = parseAbortFailureKind(fixture.abortReason);
    assert.ok(failureKind, `unparseable abort reason ${fixture.abortReason}`);
    const decision = classifyFailure({ stage: 'coding', failureKind, challengeArm: fixture.challengeArm });
    assert.equal(decision.class, fixture.expectedClass);
  });
}

test('incident-replay fixtures: every fault has a classified failure string', () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'incident-replay');
  const faults = new Set<string>();
  for (const file of readdirSync(fixtureDir).filter((name) => name.endsWith('.json'))) {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as { fault?: string };
    if (fixture.fault) faults.add(fixture.fault);
  }
  assert.ok(faults.size > 0, 'no incident-replay fixtures found');
  for (const fault of faults) {
    const entry = REPLAY_FAULT_DETAILS[fault];
    assert.ok(entry, `incident-replay fault ${fault} has no entry in REPLAY_FAULT_DETAILS`);
    assert.equal(classifyFailure(entry.evidence).class, entry.expectedClass, fault);
  }
});
