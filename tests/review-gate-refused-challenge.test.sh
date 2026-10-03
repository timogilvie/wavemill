#!/usr/bin/env bash
# Regression coverage for HOK-3154: a challenge arm whose Ready is refused by
# the review gate (pending-ready-recheck terminal cause) must not hold its green
# sibling at `challenge:pair-unresolved:no-comparison` forever (HOK-3147 gap).
#
# The monitor's pending-ready-recheck branch marks the bucket exhausted when a
# review verdict can never pass the readiness gate and (before HOK-3154) just
# set needs-user — nothing stamped challengeAborted, so the pair resolver never
# released the green sibling. The monitor now retires the refused arm when its
# sibling is green:
#   typed review failure with any non-contradictory identity → invalid_challenge:review-unattributed
#   identity drift                        → invalid_challenge:review-identity-mismatch
#   no evidence                           → invalid_challenge:review-unattributed
# and closes the arm's PR so tend releases the sibling.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extraction so functions with nested braces survive intact.
extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT_FILE"
}

# Real bounded-retry helpers (the exhausted-reason sentinel readers).
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR_ROOT/shared/lib/bounded-retry.sh"

for fn in \
  review_gate_refusal_is_terminal \
  review_refused_challenge_cause \
  review_refused_challenge_terminalize \
  _retired_challenge_arm_close_pr \
  ready_exhausted_challenge_sibling_green \
  challenge_abort_pair \
  _challenge_side_for_issue \
  native_terminal_failure_next_action \
  challenge_result_stage_for_launch \
  challenge_stage_for_launch_env \
  challenge_varied_stage_model \
  ready_state_dir \
  read_stage_status \
  stage_result_field \
  review_result_passes_ready_gate \
  review_result_has_final_evidence \
  review_result_missing_final_evidence \
  review_result_infra_failure \
  review_result_failure_category \
  review_result_summary \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
STATUS_LOG="$TMP_ROOT/status.txt"
GH_LOG="$TMP_ROOT/gh.txt"
ARG_LOG="$TMP_ROOT/record-arm-failure.argv.txt"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
REPO_DIR="$TMP_ROOT/repo"
mkdir -p "$WORKTREE_ROOT" "$REPO_DIR/tools"

# Stub record-arm-failure.ts so the HOK-3064 bridge argv is captured.
cat > "$REPO_DIR/tools/record-arm-failure.ts" <<'EOT'
#!/usr/bin/env node
// Test stub: write argv to a file so the test can assert the bridge arguments.
import { writeFileSync } from 'node:fs';
const target = process.env.WAVEMILL_RECORD_ARM_FAILURE_LOG!;
writeFileSync(target, process.argv.slice(2).join(' ') + '\n', { flag: 'a' });
EOT
PR_STATE="OPEN"
GH_CLOSE_RC=0
export WAVEMILL_RECORD_ARM_FAILURE_LOG="$ARG_LOG"

log() { shift; printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
log_error() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
record_openrouter_credits_challenge_abort() { :; }
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
}
read_state_value() {
  local default="$1"
  shift
  jq -r "$@" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$default"
}
# Mirrors the TS writer: the rewrite drops the previous artifacts and keeps a
# minimal {stage,status,agent,model,notes} shell.
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}"
  mkdir -p "$feature_dir"
  jq -n --arg stage "$stage" --arg status "$status" --arg agent "$agent" --arg model "$model" --arg notes "$notes" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes}' > "$feature_dir/.${stage}-result.json"
}
pr_state() { printf '%s\n' "$PR_STATE"; }
_with_timeout() { shift; "$@"; }
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  if [[ "$1 $2" == "pr close" && "$GH_CLOSE_RC" == "0" ]]; then
    PR_STATE="CLOSED"
  fi
  return "$GH_CLOSE_RC"
}

# seed <refused_issue> <sibling_ready_status>: a challenge pair
#   HOK-3097   (primary,    PR 1563, reviewer gpt-5.6-terra)
#   HOK-3097_c (challenger, PR 1562, reviewer kimi-k2)
# The sibling has a worktree directory plus a .ready-result.json with the
# given status (empty → no result file).
seed() {
  local refused="$1" sibling_status="$2"
  local sibling key slug
  rm -f "$ATTENTION_FILE" "$WARN_FILE" "$STATUS_LOG" "$GH_LOG" "$ARG_LOG"
  rm -rf "$WORKTREE_ROOT"
  mkdir -p "$WORKTREE_ROOT"
  PR_STATE="OPEN"
  GH_CLOSE_RC=0

  jq -n '{tasks:{
      "HOK-3097":   {challengePairId:"HOK-3097", challengeRole:"primary",    challenge:true, slug:"obs", pr:1563, coderModel:"claude-opus-4-7", reviewerModel:"gpt-5.6-terra", challengeStage:"review", challengeVariedModel:"gpt-5.6-terra"},
      "HOK-3097_c": {challengePairId:"HOK-3097", challengeRole:"challenger", challenge:true, slug:"obs-challenger", pr:1562, coderModel:"claude-opus-4-7", reviewerModel:"kimi-k2", challengeStage:"review", challengeVariedModel:"kimi-k2"}
    }}' > "$STATE_FILE"

  for key in HOK-3097 HOK-3097_c; do
    slug="$(get_task_meta "$key" slug)"
    mkdir -p "$WORKTREE_ROOT/$slug/features/$slug"
  done

  if [[ "$refused" == "HOK-3097" ]]; then sibling="HOK-3097_c"; else sibling="HOK-3097"; fi
  slug="$(get_task_meta "$sibling" slug)"
  if [[ -n "$sibling_status" ]]; then
    jq -n --arg s "$sibling_status" '{stage:"ready",status:$s}' \
      > "$WORKTREE_ROOT/$slug/features/$slug/.ready-result.json"
  fi
}

state_dir_for() {
  local slug
  slug="$(get_task_meta "$1" slug)"
  printf '%s\n' "$WORKTREE_ROOT/$slug/features/$slug"
}

# write_review_result <dir> <artifacts-json> [top-level-json]
# No default top-level identity fields; each test controls them explicitly.
write_review_result() {
  local dir="$1" artifacts="$2" extras="${3:-{\}}"
  jq -n --argjson a "$artifacts" --argjson extras "$extras" \
    '({stage:"review",status:"completed",notes:"",failureReason:"review refused by gate",artifacts:$a}) * $extras' \
    > "$dir/.review-result.json"
}

run_terminalize() {
  local issue="$1" pr dir
  pr="$(get_task_meta "$issue" pr)"
  dir="$(state_dir_for "$issue")"
  rc=0
  review_refused_challenge_terminalize "$issue" "$pr" "$dir" "win-$issue" || rc=$?
}

close_count() {
  if [[ -f "$GH_LOG" ]]; then grep -c '^pr close' "$GH_LOG" || true; else echo 0; fi
}

# Review artifacts commonly reused across tests.
MALFORMED_ARTIFACTS='{"type":"review","exitCode":1,"verdict":"not_ready","iterations":1,"blockerCount":1,"failureCategory":"native-review-malformed-response"}'
NOT_READY_ARTIFACTS='{"type":"review","exitCode":1,"verdict":"not_ready","iterations":2,"blockerCount":2,"dismissedBlockers":[]}'
PASSING_ARTIFACTS='{"type":"review","exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0,"dismissedBlockers":[]}'
INFRA_TIMEOUT_ARTIFACTS='{"type":"review","exitCode":1,"verdict":"error","iterations":1,"blockerCount":1,"failureCategory":"native-review-timeout","reviewToolError":"timeout"}'

# ── 1. Acceptance 1: malformed review, recorded=gpt-5.6-terra, assigned=kimi-k2
#       → invalid_challenge:review-identity-mismatch, no primary stamp ───────
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"model":"gpt-5.6-terra","intendedModel":"gpt-5.6-terra"}'
bounded_retry_mark_exhausted "$dir" "pending-ready-recheck" \
  "Ready launch refused for PR #1562: review verdict does not pass the readiness gate (terminal until the review artifact changes)" || true
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAborted)" == "invalid_challenge:review-identity-mismatch" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAbortedStage)" == "review" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAbortedDetail)" == *"Ready launch refused"*"failureCategory=native-review-malformed-response"* ]] \
  && [[ -z "$(get_task_meta HOK-3097 challengeAborted)" ]] \
  && [[ "$(jq -r '.challengePairAbortions["HOK-3097"].challenger.scope' "$STATE_FILE")" == "single" ]] \
  && [[ "$(jq -r '.reason' "$dir/.challenge-aborted.json")" == "invalid_challenge:review-identity-mismatch" ]] \
  && [[ "$(jq -r '.stage' "$dir/.challenge-aborted.json")" == "review" ]] \
  && [[ "$(close_count)" == "1" ]] \
  && grep -q '^pr close 1562 ' "$GH_LOG"; then
  pass "acceptance 1: malformed review with identity drift retires the challenger as identity-mismatch and closes its PR"
else
  fail "acceptance 1 wrong (rc=$rc aborted=$(get_task_meta HOK-3097_c challengeAborted) closes=$(close_count))"
fi
# Artifacts and identity fields are restored on the result file.
if [[ "$(jq -r '.artifacts.failureCategory' "$dir/.review-result.json")" == "native-review-malformed-response" ]] \
  && [[ "$(jq -r '.artifacts.challengeArmRetired.cause' "$dir/.review-result.json")" == "invalid_challenge:review-identity-mismatch" ]] \
  && [[ "$(jq -r '.failureReason' "$dir/.review-result.json")" == "review refused by gate" ]] \
  && [[ "$(jq -r '.intendedModel' "$dir/.review-result.json")" == "gpt-5.6-terra" ]] \
  && [[ "$(jq -r '.status' "$dir/.review-result.json")" == "failed" ]]; then
  pass "the review result keeps its artifacts and identity fields and records the retirement"
else
  fail "review-result restoration lost: $(cat "$dir/.review-result.json")"
fi
if grep -q 'retired (invalid_challenge:review-identity-mismatch)' "$WARN_FILE"; then
  pass "the retirement is logged once with its cause"
else
  fail "retirement warning missing"
fi
# HOK-3064 bridge: record-arm-failure.ts gets --stage review and the typed abort-reason.
if [[ -f "$ARG_LOG" ]] \
  && grep -q -- '--stage review' "$ARG_LOG" \
  && grep -q -- '--abort-reason invalid_challenge:review-identity-mismatch' "$ARG_LOG"; then
  pass "HOK-3064 bridge (acceptance 3): record-arm-failure gets --stage review and the typed abort-reason"
else
  fail "record-arm-failure argv missing or wrong: $(cat "$ARG_LOG" 2>/dev/null || echo '<none>')"
fi

# ── 2. Proven reviewer identity remains unattributed until HOK-2891 ────────
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"intendedModel":"kimi-k2","model":"kimi-k2","executedModel":"kimi-k2","executionEvidence":{"status":"consistent","source":"native-reviewer"},"modelAttributionEligible":true}'
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAborted)" == "invalid_challenge:review-unattributed" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAbortedStage)" == "review" ]] \
  && [[ "$(jq -r '.model' "$dir/.challenge-aborted.json")" == "kimi-k2" ]] \
  && [[ "$(jq -r '.stage' "$dir/.challenge-aborted.json")" == "review" ]]; then
  pass "proven reviewer identity on a malformed-response remains unattributed until HOK-2891 (model=kimi-k2)"
else
  fail "attributed forfeit wrong (aborted=$(get_task_meta HOK-3097_c challengeAborted) model=$(jq -r '.model' "$dir/.challenge-aborted.json"))"
fi
if grep -q -- '--model kimi-k2' "$ARG_LOG" \
  && grep -q -- '--abort-reason invalid_challenge:review-unattributed' "$ARG_LOG"; then
  pass "selection-health records the reviewer (kimi-k2), not the coder"
else
  fail "record-arm-failure did not attribute the reviewer: $(cat "$ARG_LOG")"
fi

# ── 3. Acceptance 2 (symmetric): primary refused, challenger green ─────────
seed "HOK-3097" "completed"
dir="$(state_dir_for HOK-3097)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"intendedModel":"gpt-5.6-terra","model":"gpt-5.6-terra","executedModel":"gpt-5.6-terra","executionEvidence":{"status":"consistent"},"modelAttributionEligible":true}'
run_terminalize "HOK-3097"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097 challengeAborted)" == "invalid_challenge:review-unattributed" ]] \
  && [[ "$(get_task_meta HOK-3097 challengeAbortedStage)" == "review" ]] \
  && [[ -z "$(get_task_meta HOK-3097_c challengeAborted)" ]] \
  && grep -q '^pr close 1563 ' "$GH_LOG"; then
  pass "acceptance 2: a refused primary is retired symmetrically when the challenger is green"
else
  fail "symmetric retirement wrong (rc=$rc aborted=$(get_task_meta HOK-3097 challengeAborted))"
fi

# ── 4. Missing evidence, no mismatch (no executedModel; recorded=assigned) ─
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"intendedModel":"kimi-k2","model":"kimi-k2"}'
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAborted)" == "invalid_challenge:review-unattributed" ]] \
  && [[ "$(jq -r '.model' "$dir/.challenge-aborted.json")" == "kimi-k2" ]]; then
  pass "missing execution evidence (no executedModel) with matching recorded/assigned retires as unattributed"
else
  fail "missing-evidence wrong (aborted=$(get_task_meta HOK-3097_c challengeAborted))"
fi

# ── 5. Genuine not_ready with 2 undismissed blockers + proven identity ────
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$NOT_READY_ARTIFACTS" \
  '{"intendedModel":"kimi-k2","model":"kimi-k2","executedModel":"kimi-k2","executionEvidence":{"status":"consistent"},"modelAttributionEligible":true}'
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAborted)" == "invalid_challenge:review-unattributed" ]]; then
  pass "a genuine not_ready with 2 undismissed blockers remains unattributed until HOK-2891"
else
  fail "review-not-ready attribution wrong (aborted=$(get_task_meta HOK-3097_c challengeAborted))"
fi

# ── 6. Attribution ineligible even with executedModel → unattributed ──────
# modelAttributionEligible=false blocks the forfeit even when all identities agree.
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"intendedModel":"kimi-k2","model":"kimi-k2","executedModel":"kimi-k2","executionEvidence":{"status":"consistent"},"modelAttributionEligible":false,"modelAttributionIneligibleReason":"missing_evidence"}'
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAborted)" == "invalid_challenge:review-unattributed" ]] \
  && [[ "$(jq -r '.modelAttributionIneligibleReason' "$dir/.review-result.json")" == "missing_evidence" ]]; then
  pass "modelAttributionEligible=false blocks the forfeit (unattributed) and preserves the ineligible reason"
else
  fail "attribution-ineligible wrong (aborted=$(get_task_meta HOK-3097_c challengeAborted))"
fi

# ── 7. executionEvidence.status==contradicted → identity-mismatch ─────────
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"intendedModel":"kimi-k2","model":"kimi-k2","executedModel":"kimi-k2","executionEvidence":{"status":"contradicted","source":"native-reviewer"},"modelAttributionEligible":true}'
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3097_c challengeAborted)" == "invalid_challenge:review-identity-mismatch" ]]; then
  pass "executionEvidence.status==contradicted retires as identity-mismatch"
else
  fail "contradicted-evidence wrong (aborted=$(get_task_meta HOK-3097_c challengeAborted))"
fi

# ── 8. Sibling not green → legacy hold ─────────────────────────────────────
for sibling_status in failed running ""; do
  seed "HOK-3097_c" "$sibling_status"
  dir="$(state_dir_for HOK-3097_c)"
  write_review_result "$dir" "$MALFORMED_ARTIFACTS"
  run_terminalize "HOK-3097_c"
  if [[ "$rc" == "1" ]] \
    && [[ -z "$(get_task_meta HOK-3097_c challengeAborted)" ]] \
    && [[ ! -f "$dir/.challenge-aborted.json" ]] \
    && [[ "$(close_count)" == "0" ]]; then
    pass "sibling Ready '${sibling_status:-missing}' keeps the legacy hold"
  else
    fail "sibling '${sibling_status:-missing}' should hold (rc=$rc)"
  fi
done

# A sibling that is itself retired is not green either (never close both PRs).
seed "HOK-3097_c" "completed"
jq '.tasks["HOK-3097"].challengeAborted = "terminal_stage_failure:review-malformed-response"' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS"
run_terminalize "HOK-3097_c"
if [[ "$rc" == "1" ]] && [[ -z "$(get_task_meta HOK-3097_c challengeAborted)" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "a retired sibling never releases the other arm"
else
  fail "retired-sibling hold wrong (rc=$rc)"
fi

# ── 9. Non-challenge task ──────────────────────────────────────────────────
seed "HOK-3097_c" "completed"
jq '.tasks["HOK-3097_c"].challenge = false' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
dir="$(state_dir_for HOK-3097_c)"
run_terminalize "HOK-3097_c"
if [[ "$rc" == "1" ]] && [[ ! -f "$dir/.challenge-aborted.json" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "a non-challenge task is never retired through the review-gate path"
else
  fail "non-challenge task touched (rc=$rc)"
fi

# ── 10. Idempotent: a failed close is retried; a closed PR is left alone ──
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS" \
  '{"intendedModel":"kimi-k2","model":"kimi-k2","executedModel":"kimi-k2","executionEvidence":{"status":"consistent"},"modelAttributionEligible":true}'
GH_CLOSE_RC=1
run_terminalize "HOK-3097_c"
first_rc="$rc"
first_aborted_at="$(jq -r '.abortedAt' "$dir/.challenge-aborted.json")"
GH_CLOSE_RC=0
: > "$WARN_FILE"
run_terminalize "HOK-3097_c"
second_rc="$rc"
run_terminalize "HOK-3097_c"
third_rc="$rc"
if [[ "$first_rc" == "0" && "$second_rc" == "0" && "$third_rc" == "0" ]] \
  && [[ "$(close_count)" == "2" ]] \
  && [[ "$PR_STATE" == "CLOSED" ]] \
  && [[ "$(jq -r '.abortedAt' "$dir/.challenge-aborted.json")" == "$first_aborted_at" ]] \
  && ! grep -q 'retired' "$WARN_FILE"; then
  pass "a failed close is retried next tick without re-stamping; a closed PR is left alone"
else
  fail "idempotency wrong (rcs=$first_rc/$second_rc/$third_rc closes=$(close_count) state=$PR_STATE)"
fi

# ── 11. An unrelated stamp (e.g. ready-exhausted) is never resumed here ───
seed "HOK-3097_c" "completed"
jq '.tasks["HOK-3097_c"].challengeAborted = "terminal_stage_failure:ready-exhausted" | .tasks["HOK-3097_c"].challengeAbortedStage = "ready"' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$MALFORMED_ARTIFACTS"
run_terminalize "HOK-3097_c"
if [[ "$rc" == "1" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "an unrelated abort stamp keeps the hold and never closes the PR"
else
  fail "unrelated stamp handling wrong (rc=$rc closes=$(close_count))"
fi

# A review-gate stamp (stage=review) is resumed and only retries the PR close.
seed "HOK-3097_c" "completed"
jq '.tasks["HOK-3097_c"].challengeAborted = "invalid_challenge:review-identity-mismatch" | .tasks["HOK-3097_c"].challengeAbortedStage = "review"' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
dir="$(state_dir_for HOK-3097_c)"
rm -f "$dir/.challenge-aborted.json"
run_terminalize "HOK-3097_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(close_count)" == "1" ]] \
  && [[ ! -f "$dir/.challenge-aborted.json" ]]; then
  pass "a review-gate stamp (stage=review) is resumed and only retries the PR close"
else
  fail "resume-only wrong (rc=$rc closes=$(close_count))"
fi

# A review-gate stamp with the wrong stage is NOT resumed (defense in depth).
seed "HOK-3097_c" "completed"
jq '.tasks["HOK-3097_c"].challengeAborted = "invalid_challenge:review-unattributed" | .tasks["HOK-3097_c"].challengeAbortedStage = "ready"' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
run_terminalize "HOK-3097_c"
if [[ "$rc" == "1" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "a review-gate reason with a non-review stage is never resumed here"
else
  fail "wrong-stage resume wrong (rc=$rc closes=$(close_count))"
fi

# ── 12. review_gate_refusal_is_terminal predicate ──────────────────────────
pred_ok=true
seed "HOK-3097_c" "completed"
dir="$(state_dir_for HOK-3097_c)"
write_review_result "$dir" "$PASSING_ARTIFACTS"
if review_gate_refusal_is_terminal "$dir"; then pred_ok=false; echo "    expected false for passing review" >&2; fi
write_review_result "$dir" "$INFRA_TIMEOUT_ARTIFACTS"
if review_gate_refusal_is_terminal "$dir"; then pred_ok=false; echo "    expected false for infra timeout" >&2; fi
write_review_result "$dir" "$MALFORMED_ARTIFACTS"
if ! review_gate_refusal_is_terminal "$dir"; then pred_ok=false; echo "    expected true for malformed-response" >&2; fi
if [[ "$pred_ok" == "true" ]]; then
  pass "review_gate_refusal_is_terminal is false for passing / infra and true for malformed-response"
else
  fail "review_gate_refusal_is_terminal predicate wrong"
fi

# ── 13. Wiring: pending-ready-recheck branch calls the helper 3× ──────────
# first-refusal, exhausted, exhausted-quiet.
wiring_count=$(grep -c 'review_refused_challenge_terminalize "\$ISSUE" "\$PR" "\$ready_state_dir_path" "\$WIN"' "$MONITOR_SCRIPT_FILE")
if [[ "$wiring_count" == "3" ]]; then
  pass "the first-refusal, exhausted and exhausted-quiet branches each call review_refused_challenge_terminalize"
else
  fail "pending-ready-recheck wiring missing (got $wiring_count call sites)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
