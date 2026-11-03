#!/usr/bin/env bash
# protects: HOK-3358 — `wavemill abort` and the monitor share one arm-termination
# recorder with a typed cause. The three operator-facing scenarios the recorder
# promises are checked against the real CLI, the real recorder, and the real
# JSONL stores — not a mock:
#
#   A. --failure-kind completion-protocol --evidence <file> --model <id>
#      → challengeAborted = terminal_stage_failure:completion-protocol
#      → reliability-records.jsonl   : one row, faultClass=model-fault,
#                                      source=operator-abort, qualitySignalEligible=true
#      → evals.jsonl                 : one row, outcomes.success=false, score=0,
#                                      nonRewardReason.code=arm-terminated
#      → buildTechnicalTaskRouterContributionRow(evalRow) → completion_result="failure"
#
#   B. (no --failure-kind flag)
#      → challengeAborted = terminal_stage_failure:cancelled
#      → reliability-records.jsonl   : one row, faultClass=harness-fault,
#                                      qualitySignalEligible=false
#      → evals.jsonl                 : no new row (operator didn't name a model)
#
#   C. --failure-kind completion-protocol (NO --evidence)
#      → the recorder throws before any mutation
#      → task row untouched; no reliability row; no eval row
#
# This journey builds on the fakes harness for a committed repo + a seeded
# workflow-state file, but does not start the monitor: the recorder's contract
# does not depend on a running mill, and the existing
# `operator-abort-mid-coding.journey.sh` already covers live-monitor interaction.
set -euo pipefail

JOURNEY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$JOURNEY_DIR/../.." && pwd)"
BUDGET="${JOURNEY_BUDGET_SECONDS:-90}"

if (( BASH_VERSINFO[0] < 4 )); then
  echo "SKIP operator-abort journey: bash >= 4 required (have $BASH_VERSION)"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP operator-abort journey: jq not installed"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/journey-operator-abort.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf '$WORK'" EXIT

STARTED_AT="$(date +%s)"
log() { printf '[journey operator-abort +%ss] %s\n' "$(( $(date +%s) - STARTED_AT ))" "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

assert() {
  local message="$1"; shift
  if "$@"; then
    log "✓ $message"
  else
    fail "$message"
  fi
}

(( BUDGET > 0 )) || BUDGET=90
budget_check() {
  (( $(date +%s) - STARTED_AT < BUDGET )) || fail "journey ran past $BUDGET s budget"
}

REPO_DIR="$WORK/repo"
STATE_DIR="$REPO_DIR/.wavemill"
STATE_FILE="$STATE_DIR/workflow-state.json"
EVALS_FILE="$STATE_DIR/evals/evals.jsonl"
RELIABILITY_FILE="$STATE_DIR/evals/reliability-records.jsonl"
mkdir -p "$STATE_DIR/evals"
# A minimal git repo so tools that call `git` from the state dir don't blow up.
git init -q "$REPO_DIR"
(
  cd "$REPO_DIR"
  git config user.email journey@wavemill.local
  git config user.name journey
  git commit --allow-empty -q -m "init"
)

ISSUE_A="JRN-301"
ISSUE_B="JRN-302"
ISSUE_C="JRN-303"
MODEL="anthropic/claude-sonnet-4"

# Seed workflow-state with three tasks in a coding row. The row only needs
# fields the recorder reads/writes; the HOK-3220 schema is validated at the
# write seam by task-record-write-guard, but all written values here are
# valid.
jq -n --arg a "$ISSUE_A" --arg b "$ISSUE_B" --arg c "$ISSUE_C" '
  {
    freeSlots: 1,
    # allow-task-literal: standalone journey jq seed; this file does not source tests/lib/state-fixtures.sh (HOK-3358)
    tasks: {
      ($a): {slug: "scenario-a", status: "active", phase: "coding", challengeAborted: ""},
      ($b): {slug: "scenario-b", status: "active", phase: "coding", challengeAborted: ""},
      ($c): {slug: "scenario-c", status: "active", phase: "coding", challengeAborted: ""}
    }
  }
' > "$STATE_FILE"

# Evidence artifact for scenario A — any file suffices for the recorder's
# existsSync check; the plan calls for a minimal `.coding-complete`-shaped body.
EVIDENCE="$WORK/evidence.coding-complete"
printf '{"stage":"coding","confidence":"low","note":"HOK-3358 journey evidence"}\n' > "$EVIDENCE"

# ── Scenario A — model-fault abort with evidence ─────────────────────────────
log "scenario A: wavemill abort $ISSUE_A --failure-kind completion-protocol --evidence <file> --model $MODEL"
budget_check
A_OUT="$WORK/a.out"
if ! npx tsx "$ROOT/tools/abort-task.ts" "$ISSUE_A" \
    --repo-dir "$REPO_DIR" --reason "model repeated 'ok, I'm done' without finishing" \
    --failure-kind completion-protocol --evidence "$EVIDENCE" \
    --stage coding --model "$MODEL" > "$A_OUT" 2>&1; then
  cat "$A_OUT" >&2
  fail "scenario A: abort should have succeeded"
fi

A_TASK="$(jq -r --arg i "$ISSUE_A" '.tasks[$i]' "$STATE_FILE")"
assert "A: challengeAborted = terminal_stage_failure:completion-protocol" \
  test "$(jq -r '.challengeAborted' <<<"$A_TASK")" = "terminal_stage_failure:completion-protocol"
assert "A: task flipped to aborted/aborted" \
  test "$(jq -r '.phase + "/" + .status' <<<"$A_TASK")" = "aborted/aborted"
assert "A: lifecycle.workflowOutcome = aborted" \
  test "$(jq -r '.lifecycle.workflowOutcome' <<<"$A_TASK")" = "aborted"

A_REL="$(grep -F "\"issueId\":\"$ISSUE_A\"" "$RELIABILITY_FILE" | tail -1)"
[[ -n "$A_REL" ]] || fail "A: reliability record not written"
assert "A: reliability.source = operator-abort" test "$(jq -r '.source' <<<"$A_REL")" = "operator-abort"
assert "A: reliability.faultClass = model-fault" test "$(jq -r '.faultClass' <<<"$A_REL")" = "model-fault"
assert "A: reliability.qualitySignalEligible = true" test "$(jq -r '.qualitySignalEligible' <<<"$A_REL")" = "true"
assert "A: reliability.model = $MODEL" test "$(jq -r '.model' <<<"$A_REL")" = "$MODEL"
assert "A: reliability.abortReason parses to completion-protocol" \
  test "$(jq -r '.abortReason' <<<"$A_REL")" = "terminal_stage_failure:completion-protocol"

[[ -f "$EVALS_FILE" ]] || fail "A: evals.jsonl missing (recorder must append failure eval row)"
A_EVAL="$(grep -F "\"issueId\":\"$ISSUE_A\"" "$EVALS_FILE" | tail -1)"
[[ -n "$A_EVAL" ]] || fail "A: eval record not written"
assert "A: eval outcomes.success = false" test "$(jq -r '.outcomes.success' <<<"$A_EVAL")" = "false"
assert "A: eval score = 0"               test "$(jq -r '.score' <<<"$A_EVAL")" = "0"
assert "A: eval modelId = $MODEL"        test "$(jq -r '.modelId' <<<"$A_EVAL")" = "$MODEL"
assert "A: eval nonRewardReason.code = arm-terminated" \
  test "$(jq -r '.nonRewardReason.code' <<<"$A_EVAL")" = "arm-terminated"
assert "A: eval trainingEligible = false" test "$(jq -r '.trainingEligible' <<<"$A_EVAL")" = "false"

# The eval row's outcomes.success is what the Hokusai contribution builder
# reads to derive `completion_result` ("success"|"failure"). We assert the
# input directly — the builder's own tests pin the mapping. (Running the
# builder from a journey would need `@hokusai/core` on-disk, which is not
# guaranteed in every CI leg.)
assert "A: eval outcomes.success is explicitly false (contribution → 'failure')" \
  test "$(jq -r '.outcomes.success' <<<"$A_EVAL")" = "false"

# ── Scenario B — default (no flags) harness-fault abort ──────────────────────
log "scenario B: wavemill abort $ISSUE_B (no flags)"
budget_check
B_OUT="$WORK/b.out"
EVALS_COUNT_BEFORE="$([[ -f $EVALS_FILE ]] && wc -l < "$EVALS_FILE" || echo 0)"
if ! npx tsx "$ROOT/tools/abort-task.ts" "$ISSUE_B" \
    --repo-dir "$REPO_DIR" --reason "operator wanted to pause this one" \
    > "$B_OUT" 2>&1; then
  cat "$B_OUT" >&2
  fail "scenario B: default abort should have succeeded"
fi

B_TASK="$(jq -r --arg i "$ISSUE_B" '.tasks[$i]' "$STATE_FILE")"
assert "B: challengeAborted = terminal_stage_failure:cancelled" \
  test "$(jq -r '.challengeAborted' <<<"$B_TASK")" = "terminal_stage_failure:cancelled"
assert "B: task flipped to aborted/aborted" \
  test "$(jq -r '.phase + "/" + .status' <<<"$B_TASK")" = "aborted/aborted"

B_REL="$(grep -F "\"issueId\":\"$ISSUE_B\"" "$RELIABILITY_FILE" | tail -1)"
[[ -n "$B_REL" ]] || fail "B: reliability record not written"
assert "B: reliability.source = operator-abort" test "$(jq -r '.source' <<<"$B_REL")" = "operator-abort"
assert "B: reliability.faultClass = harness-fault" test "$(jq -r '.faultClass' <<<"$B_REL")" = "harness-fault"
assert "B: reliability.qualitySignalEligible = false" test "$(jq -r '.qualitySignalEligible' <<<"$B_REL")" = "false"

EVALS_COUNT_AFTER_B="$([[ -f $EVALS_FILE ]] && wc -l < "$EVALS_FILE" || echo 0)"
assert "B: evals.jsonl line count unchanged (no model named → no eval row)" \
  test "$EVALS_COUNT_BEFORE" = "$EVALS_COUNT_AFTER_B"
# Belt + braces: no row keyed by issue B.
assert "B: no eval row keyed by $ISSUE_B" \
  bash -c '! grep -qF "\"issueId\":\"'$ISSUE_B'\"" "'"$EVALS_FILE"'" 2>/dev/null'

# ── Scenario C — missing evidence rejection ──────────────────────────────────
log "scenario C: wavemill abort $ISSUE_C --failure-kind completion-protocol (no --evidence)"
budget_check
C_BEFORE_JSON="$(jq -c --arg i "$ISSUE_C" '.tasks[$i]' "$STATE_FILE")"
RELIABILITY_BEFORE_C="$([[ -f $RELIABILITY_FILE ]] && wc -l < "$RELIABILITY_FILE" || echo 0)"
EVALS_BEFORE_C="$([[ -f $EVALS_FILE ]] && wc -l < "$EVALS_FILE" || echo 0)"
C_OUT="$WORK/c.out"
if npx tsx "$ROOT/tools/abort-task.ts" "$ISSUE_C" \
    --repo-dir "$REPO_DIR" --reason "operator fat-fingered the kind" \
    --failure-kind completion-protocol --model "$MODEL" \
    > "$C_OUT" 2>&1; then
  cat "$C_OUT" >&2
  fail "scenario C: abort must have failed (evidence missing for model-fault kind)"
fi
assert "C: error message names the evidence requirement" \
  grep -qi "evidence" "$C_OUT"
C_AFTER_JSON="$(jq -c --arg i "$ISSUE_C" '.tasks[$i]' "$STATE_FILE")"
assert "C: task row untouched" test "$C_BEFORE_JSON" = "$C_AFTER_JSON"
RELIABILITY_AFTER_C="$([[ -f $RELIABILITY_FILE ]] && wc -l < "$RELIABILITY_FILE" || echo 0)"
EVALS_AFTER_C="$([[ -f $EVALS_FILE ]] && wc -l < "$EVALS_FILE" || echo 0)"
assert "C: reliability-records.jsonl line count unchanged" \
  test "$RELIABILITY_BEFORE_C" = "$RELIABILITY_AFTER_C"
assert "C: evals.jsonl line count unchanged" \
  test "$EVALS_BEFORE_C" = "$EVALS_AFTER_C"

log "operator-abort journey OK (scenarios A, B, C)"
