#!/usr/bin/env bash
# Integration test: the golden challenge-model-identity flow (HOK-3321).
#
# Plan §3.7 attempted a full monitor-loop journey for the planning challenge
# whose challenger planning fake writes the provider-reported OpenRouter alias
# (`qwen/qwen3-coder`) while the intent records the Wavemill alias
# (`qwen-3-coder`). The challenge-mode lottery plus the LLM judge make that
# journey hostile inside the fakes environment, so this is the plan's declared
# fallback: the same primary + `_c` comparison path driven end-to-end through
# the REAL compare-prs boundary against the shared fakes (tests/fakes/lib.sh),
# with the judge edge answered by the fake agent's seeded-verdict mode.
#
# Asserted, the way an operator would see it:
#   Case A (the HOK-3313 state, regression pin): eval records carrying the
#     pre-fix `stage_override_lost` stamps produce an `invalid_challenge`
#     comparison row — the failure mode this task removes.
#   Case B (post-fix): the same records re-attested by the real
#     attestEvalRecordChallengeExecution flow reach the judge and the pair
#     lands a `compared` row naming the alias-spelled challenger model.
#
# Requires: jq (the fakes require it too).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=fakes/lib.sh
source "$REPO_DIR_ROOT/tests/fakes/lib.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

command -v jq >/dev/null 2>&1 || { echo "SKIP challenge-planning-equivalence: jq not installed"; exit 0; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/challenge-planning-equivalence.XXXXXX")"
# KEEP_ARTIFACTS=1 preserves the scratch world for post-mortem debugging.
if [[ "${KEEP_ARTIFACTS:-0}" == "1" ]]; then
  trap 'echo "artifacts kept: $TMP"' EXIT
else
  trap 'fakes_teardown; rm -rf "$TMP"' EXIT
fi
fakes_setup "$TMP/world" "acme/wavemill" main

# The judge edge: the fake agent answers `claude -p` with a canned blind
# verdict (B = the second presentation-order side = the challenger).
FAKE_JUDGE_VERDICT_FILE="$TMP/judge-verdict.json"
export FAKE_JUDGE_VERDICT_FILE
cat > "$FAKE_JUDGE_VERDICT_FILE" <<'JSON'
{"winner":"B","rationale":"The challenger plan covers the same scope with a sharper stage breakdown.","dimensions":{"completeness":{"A":8,"B":8},"correctness":{"A":8,"B":8},"code_quality":{"A":8,"B":8},"intervention_impact":{"A":7,"B":7},"autonomy":{"A":8,"B":8}},"criterionRationales":{"completeness":{"rationale":"Both plans cover the requested scope."},"correctness":{"rationale":"No correctness gaps in either plan."},"code_quality":{"rationale":"Both plans keep the change minimal."},"intervention_impact":{"rationale":"No interventions recorded."},"autonomy":{"rationale":"Both arms ran unattended."}},"workflowInsight":"Alias-equivalent planning pair compared cleanly."}
JSON

# Feature dirs with the real stage-result shapes; the challenger's planning
# result carries the intended Wavemill alias and the provider-reported
# OpenRouter id as executedModel (HOK-3143 field semantics).
FEATURE_ROOT="$TMP/features"
mkdir -p "$FEATURE_ROOT/primary" "$FEATURE_ROOT/challenger"
write_stage_result() {
  local dir="$1" stage="$2" intended="$3" executed="$4"
  local file
  case "$stage" in
    planning) file=".planning-result.json" ;;
    coding) file=".coding-result.json" ;;
    review) file=".review-result.json" ;;
  esac
  printf '{"stage":"%s","status":"completed","agent":"codex","model":"%s","executedModel":"%s"}' \
    "$stage" "$intended" "$executed" > "$dir/$file"
}
write_stage_result "$FEATURE_ROOT/primary" planning "claude-opus-4-6" "claude-opus-4-6"
write_stage_result "$FEATURE_ROOT/primary" coding "claude-opus-4-6" "claude-opus-4-6"
write_stage_result "$FEATURE_ROOT/primary" review "claude-opus-4-6" "claude-opus-4-6"
write_stage_result "$FEATURE_ROOT/challenger" planning "qwen-3-coder" "qwen/qwen3-coder"
write_stage_result "$FEATURE_ROOT/challenger" coding "claude-opus-4-6" "claude-opus-4-6"
write_stage_result "$FEATURE_ROOT/challenger" review "claude-opus-4-6" "claude-opus-4-6"

# Two PRs against the fake origin, exactly like the fake agent would create.
cd "$FAKE_REPO_DIR"
git checkout -q -b task/hok-3313
printf 'primary arm\n' > journey-output.txt
git add journey-output.txt
git -c user.name=fake-agent -c user.email=fake-agent@example.invalid commit -q -m "HOK-3313 primary"
git push -q -u origin task/hok-3313
PRIMARY_PR_URL="$(gh pr create --base main --head task/hok-3313 --title 'HOK-3313 primary' --body 'primary arm')"
PRIMARY_PR_NUMBER="${PRIMARY_PR_URL##*/}"
PRIMARY_PR_HEAD="$(git rev-parse HEAD)"

git checkout -q -b task/hok-3313_c
printf 'challenger arm\n' > journey-output.txt
git add journey-output.txt
git -c user.name=fake-agent -c user.email=fake-agent@example.invalid commit -q -m "HOK-3313 challenger"
git push -q -u origin task/hok-3313_c
CHALLENGER_PR_URL="$(gh pr create --base main --head task/hok-3313_c --title 'HOK-3313 challenger' --body 'challenger arm')"
CHALLENGER_PR_NUMBER="${CHALLENGER_PR_URL##*/}"
CHALLENGER_PR_HEAD="$(git rev-parse HEAD)"

# Eval-record driver: builds the pair's eval records, then either stamps the
# pre-fix invalid markers (case A) or runs the real migrated attestation
# (case B) — the same call the post-completion hook makes.
cat > "$TMP/driver.mts" <<'DRIVER'
import { writeFileSync } from 'node:fs';

const install = process.env.INSTALL_DIR!;
const mode = process.argv[2] ?? 'attested';
const outPath = process.argv[3]!;
const repoDir = process.env.FAKE_REPO_DIR!;
const primary = {
  prUrl: process.env.PRIMARY_PR_URL!,
  head: process.env.PRIMARY_PR_HEAD!,
};
const challenger = {
  prUrl: process.env.CHALLENGER_PR_URL!,
  head: process.env.CHALLENGER_PR_HEAD!,
};

const { attestEvalRecordChallengeExecution } = await import(`${install}/shared/lib/challenge-execution-contract.ts`);
const { attachChallengeExecutionMetadata } = await import(`${install}/shared/lib/eval-record-builder.ts`);

const route = (planner: string) => ({
  planner,
  coder: 'claude-opus-4-6',
  reviewer: 'claude-opus-4-6',
  planDepth: '',
  codeDepth: '',
  reviewMode: '',
});

const intent = {
  pairId: 'PAIR-3313',
  issueId: 'HOK-3313',
  createdAt: '2026-10-26T14:10:00.000Z',
  selectedStage: 'plan',
  decisionSource: 'expanded',
  selectionPath: 'recommendation-driven',
  selectionReason: 'stage_coverage_gap',
  challengerSource: 'recommendation',
  primary: {
    pairId: 'PAIR-3313',
    side: 'primary',
    challengeStage: 'plan',
    expectedStageModel: 'claude-opus-4-6',
    expectedRoute: route('claude-opus-4-6'),
  },
  challenger: {
    pairId: 'PAIR-3313',
    side: 'challenger',
    challengeStage: 'plan',
    expectedStageModel: 'qwen-3-coder',
    expectedRoute: route('qwen-3-coder'),
  },
};

function baseRecord(id: string, side: 'primary' | 'challenger', prUrl: string, head: string, score: number) {
  const record: Record<string, unknown> = {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: 'One-stage agent exit identity comes from the launch record.',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6',
    score,
    scoreBand: 'Full Success',
    timeSeconds: 245,
    timestamp: '2026-10-26T15:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Planning challenge arm completed.',
    issueId: 'HOK-3313',
    prUrl,
    evaluatedPrHeadSha: head,
    agentType: 'codex',
    challengePairId: 'PAIR-3313',
    challengeSide: side,
    challengeStage: 'plan',
    challengeIntent: intent,
    executedPlanning: {
      agent: 'codex',
      model: side === 'challenger' ? 'qwen/qwen3-coder' : 'claude-opus-4-6',
      status: 'completed',
      source: '.planning-result.json',
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 2,
          repo_size_loc: 1000,
          description_tokens: 20,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: { complexity: 4, domain: 'eval', risk_flags: [] },
      },
      constraints: {
        models_available: ['qwen-3-coder', 'claude-opus-4-6'],
        objective: 'balanced',
      },
      stages: {
        planner: { model: side === 'challenger' ? 'qwen-3-coder' : 'claude-opus-4-6' },
        coder: { model: 'claude-opus-4-6' },
        reviewer: { model: 'claude-opus-4-6' },
      },
    },
  };
  return record as EvalRecord;
}

const primaryRecord = baseRecord('eval-primary', 'primary', primary.prUrl, primary.head, 0.9);
const challengerRecord = baseRecord('eval-challenger', 'challenger', challenger.prUrl, challenger.head, 0.93);
primaryRecord.challengeExecutionRoute = route('claude-opus-4-6');
challengerRecord.challengeExecutionRoute = route('qwen-3-coder');

if (mode === 'stale') {
  // The pre-HOK-3321 mill stamped these markers from raw string equality.
  for (const record of [primaryRecord, challengerRecord]) {
    record.invalidChallenge = true;
    record.challengeDivergenceReason = 'stage_override_lost';
    record.challengeExecutionEvidence = {
      pairId: 'PAIR-3313',
      side: record.challengeSide,
      validity: 'invalid_challenge',
      challengeStage: 'plan',
      expectedStageModel: record.challengeSide === 'challenger' ? 'qwen-3-coder' : 'claude-opus-4-6',
      evidence: [],
      invalidReason: 'stage_override_lost',
      invalidDetails: 'Expected plan model qwen-3-coder, launch evidence has qwen/qwen3-coder.',
    };
  }
} else {
  // Post-fix: the same call path post-completion-hook.ts uses.
  for (const record of [primaryRecord, challengerRecord]) {
    const attestation = attestEvalRecordChallengeExecution(record, repoDir);
    if (!attestation) throw new Error(`no attestation for ${record.id}`);
    attachChallengeExecutionMetadata(record, {
      side: record.challengeSide,
      intent: record.challengeIntent,
      evidence: attestation,
    });
    if (attestation.validity !== 'valid') {
      throw new Error(`expected valid attestation for ${record.id}, got ${attestation.validity}: ${attestation.invalidReason ?? ''}`);
    }
  }
}

writeFileSync(outPath, `${JSON.stringify(primaryRecord)}\n${JSON.stringify(challengerRecord)}\n`);
DRIVER

EVALS_DIR="$FAKE_REPO_DIR/.wavemill/evals"
mkdir -p "$EVALS_DIR"
CHALLENGE_RECORDS="$EVALS_DIR/challenge-records.jsonl"
EVALS="$EVALS_DIR/evals.jsonl"

run_compare() {
  local mode="$1" out_file="$2"
  (
    cd "$REPO_DIR_ROOT"
    INSTALL_DIR="$REPO_DIR_ROOT" \
    FAKE_REPO_DIR="$FAKE_REPO_DIR" \
    PRIMARY_PR_URL="$PRIMARY_PR_URL" PRIMARY_PR_HEAD="$PRIMARY_PR_HEAD" \
    CHALLENGER_PR_URL="$CHALLENGER_PR_URL" CHALLENGER_PR_HEAD="$CHALLENGER_PR_HEAD" \
    node --import tsx "$TMP/driver.mts" "$mode" "$EVALS"
    node --import tsx tools/compare-prs.ts \
      --issue HOK-3313 \
      --pair-id PAIR-3313 \
      --primary-pr "$PRIMARY_PR_NUMBER" \
      --challenger-pr "$CHALLENGER_PR_NUMBER" \
      --primary-model claude-opus-4-6 \
      --challenger-model qwen-3-coder \
      --primary-planner claude-opus-4-6 \
      --primary-coder claude-opus-4-6 \
      --primary-reviewer claude-opus-4-6 \
      --challenger-planner qwen-3-coder \
      --challenger-coder claude-opus-4-6 \
      --challenger-reviewer claude-opus-4-6 \
      --primary-feature-dir "$FEATURE_ROOT/primary" \
      --challenger-feature-dir "$FEATURE_ROOT/challenger" \
      --presentation-order primary-first \
      --repo-dir "$FAKE_REPO_DIR"
  ) > "$out_file" 2> "$out_file.stderr"
}

last_comparison_row() {
  jq -s 'last' "$CHALLENGE_RECORDS"
}

# ── Case A: the HOK-3313 state — no comparison, evidence refused ───────────
# The pre-fix mill stamped both eval records invalid on raw string equality,
# so the current-head eval selector refuses the pair and no comparison row is
# written at all. That "completed work, no comparison" outcome is the
# incident symptom this task removes.
: > "$CHALLENGE_RECORDS"
if run_compare stale "$TMP/case-a.out"; then
  fail "case A: compare-prs unexpectedly completed on invalid evidence"
else
  pass "case A: compare-prs refuses the stamped-invalid pair"
fi
if grep -q 'Current-head challenge eval evidence refused for PAIR-3313' "$TMP/case-a.out.stderr"; then
  pass "case A: refusal names the pair"
else
  fail "case A: refusal names the pair"
  sed -n '1,20p' "$TMP/case-a.out.stderr" || true
fi
if grep -q 'stage_override_lost' "$TMP/case-a.out.stderr"; then
  pass "case A: refusal carries the pre-fix false-positive cause"
else
  fail "case A: refusal carries the pre-fix false-positive cause"
fi
check_eq "case A: no comparison row is written" \
  "0" "$(jq -s 'length' "$CHALLENGE_RECORDS")"

# ── Case B: post-fix — the same pair reaches the judge and compares ────────
: > "$CHALLENGE_RECORDS"
if run_compare attested "$TMP/case-b.out"; then
  pass "case B: compare-prs completes the comparison"
else
  fail "case B: compare-prs exited non-zero"
  sed -n '1,40p' "$TMP/case-b.out.stderr" || true
fi
check_eq "case B: comparisonOutcome is compared" \
  "compared" "$(last_comparison_row | jq -r '.comparisonOutcome // empty')"
check_eq "case B: no invalid row exists for the pair" \
  "0" "$(jq -s '[.[] | select(.invalidChallenge == true)] | length' "$CHALLENGE_RECORDS")"
check_eq "case B: winner is the challenger" \
  "challenger" "$(last_comparison_row | jq -r '.winner // empty')"
check_eq "case B: challenger model label is the intended alias" \
  "qwen-3-coder" "$(last_comparison_row | jq -r '.challengerModel // empty')"
check_eq "case B: executed planning identity is the provider-reported alias" \
  "qwen/qwen3-coder" "$(last_comparison_row | jq -r '.challengerExecution.planning.rawModel // empty')"
check_eq "case B: primary model is the incumbent" \
  "claude-opus-4-6" "$(last_comparison_row | jq -r '.primaryModel // empty')"
check_eq "case B: judge edge was modelled by the fake" \
  "1" "$(grep -c 'judge verdict served' "$FAKE_AGENT_LOG" 2>/dev/null || echo 0)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
