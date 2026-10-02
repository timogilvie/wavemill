#!/usr/bin/env bash
# Regression coverage for HOK-3147: a challenge arm whose Ready is terminally
# exhausted must not hold its green sibling at
# `challenge:pair-unresolved:no-comparison` forever.
#
# Background: maybe_run_challenge_eval / the pair resolver only run from the
# completed-Ready block of the monitor poll. An arm whose Ready re-checks or
# remediation ran out goes down the `ready_status == "failed"` branch, which
# used to set needs-user and return — nothing stamped challengeAborted, so the
# sibling's PR waited for an operator (HOK-3121 #1537, HOK-3145 #1560). The
# monitor now retires the exhausted arm when its sibling is green:
#   red checks         → terminal_stage_failure:ready-exhausted (forfeit)
#   route-stamp etc.   → invalid_challenge:ready-transition-failed (no forfeit)
#   no typed cause     → invalid_challenge:ready-unattributed
# and closes the arm's PR so tend releases the sibling.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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
source "$REPO_DIR/shared/lib/bounded-retry.sh"

for fn in \
  ready_exhausted_challenge_cause \
  ready_exhausted_challenge_sibling_green \
  ready_exhausted_challenge_terminalize \
  challenge_abort_pair \
  _challenge_side_for_issue \
  native_terminal_failure_next_action \
  challenge_result_stage_for_launch \
  challenge_stage_for_launch_env \
  ready_state_dir \
  read_stage_status \
  stage_result_field \
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
WORKTREE_ROOT="$TMP_ROOT/worktrees"
# No tools/record-arm-failure.ts here, so challenge_abort_pair skips it.
REPO_DIR="$TMP_ROOT/no-repo"
mkdir -p "$WORKTREE_ROOT" "$REPO_DIR"
PR_STATE="OPEN"
GH_CLOSE_RC=0

log() { shift; printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
log_error() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
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
# Mirrors the TS writer: the rewrite drops the previous artifacts.
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

# seed <exhausted_issue> <sibling_ready_status>: a challenge pair HOK-3145
# (primary, PR 1560) / HOK-3145_c (challenger, PR 1559), each with a worktree
# and a Ready state dir. The sibling's .ready-result.json carries the given
# status (empty → no result file).
seed() {
  local exhausted="$1" sibling_status="$2"
  local sibling key slug
  rm -rf "$WORKTREE_ROOT" "$ATTENTION_FILE" "$WARN_FILE" "$STATUS_LOG" "$GH_LOG"
  mkdir -p "$WORKTREE_ROOT"
  PR_STATE="OPEN"
  GH_CLOSE_RC=0

  jq -n '{tasks:{
      "HOK-3145":   {challengePairId:"HOK-3145", challengeRole:"primary",    challenge:true, slug:"guard", pr:1560, coderModel:"claude-opus-5-5"},
      "HOK-3145_c": {challengePairId:"HOK-3145", challengeRole:"challenger", challenge:true, slug:"guard-challenger", pr:1559, coderModel:"gpt-5.5"}
    }}' > "$STATE_FILE"

  for key in HOK-3145 HOK-3145_c; do
    slug="$(get_task_meta "$key" slug)"
    mkdir -p "$WORKTREE_ROOT/$slug/features/$slug"
  done

  if [[ "$exhausted" == "HOK-3145" ]]; then sibling="HOK-3145_c"; else sibling="HOK-3145"; fi
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

write_ready_result() {
  local dir="$1" artifacts="$2"
  jq -n --argjson a "$artifacts" \
    '{stage:"ready",status:"failed",model:"gpt-5.5",notes:"Ready checks failed",failureReason:"Ready checks failed",artifacts:$a}' \
    > "$dir/.ready-result.json"
}

run_terminalize() {
  local issue="$1" cause="${2:-}" pr dir
  pr="$(get_task_meta "$issue" pr)"
  dir="$(state_dir_for "$issue")"
  rc=0
  ready_exhausted_challenge_terminalize "$issue" "$pr" "$dir" "win-$issue" $cause || rc=$?
}

close_count() {
  if [[ -f "$GH_LOG" ]]; then grep -c '^pr close' "$GH_LOG" || true; else echo 0; fi
}

# ── 1. Red check (acceptance 1) ─────────────────────────────────────────────
seed "HOK-3145_c" "completed"
dir="$(state_dir_for HOK-3145_c)"
write_ready_result "$dir" '{"type":"ready","verdict":"fail","checksRun":3,"checksPassed":2,"mergeConflict":"MERGEABLE","prNumber":1559,"remediationAttempts":3,"remediationFailures":["unit"],"failedReadyRecheck":{"attempts":4,"exhausted":true}}'
bounded_retry_mark_exhausted "$dir" "failed-ready-recheck" "Failed-ready re-checks exhausted after 4 attempt(s) for PR #1559: REPO_DIR is not defined" || true
run_terminalize "HOK-3145_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3145_c challengeAborted)" == "terminal_stage_failure:ready-exhausted" ]] \
  && [[ "$(get_task_meta HOK-3145_c challengeAbortedStage)" == "ready" ]] \
  && [[ "$(get_task_meta HOK-3145_c challengeAbortedDetail)" == *"REPO_DIR is not defined"*"failed checks: unit"* ]] \
  && [[ -z "$(get_task_meta HOK-3145 challengeAborted)" ]] \
  && [[ "$(jq -r '.challengePairAbortions["HOK-3145"].challenger.scope' "$STATE_FILE")" == "single" ]] \
  && [[ "$(jq -r '.reason' "$dir/.challenge-aborted.json")" == "terminal_stage_failure:ready-exhausted" ]] \
  && [[ "$(close_count)" == "1" ]] \
  && grep -q '^pr close 1559 ' "$GH_LOG"; then
  pass "red-check exhaustion retires the challenger as a forfeit and closes its PR"
else
  fail "red-check retirement wrong (rc=$rc aborted=$(get_task_meta HOK-3145_c challengeAborted) closes=$(close_count))"
fi
if [[ "$(jq -r '.artifacts.remediationFailures[0]' "$dir/.ready-result.json")" == "unit" ]] \
  && [[ "$(jq -r '.artifacts.failedReadyRecheck.exhausted' "$dir/.ready-result.json")" == "true" ]] \
  && [[ "$(jq -r '.artifacts.challengeArmRetired.cause' "$dir/.ready-result.json")" == "terminal_stage_failure:ready-exhausted" ]] \
  && [[ "$(jq -r '.status' "$dir/.ready-result.json")" == "failed" ]]; then
  pass "the ready result keeps its artifacts and records the retirement"
else
  fail "ready-result artifacts lost: $(cat "$dir/.ready-result.json")"
fi
if grep -q 'retired (terminal_stage_failure:ready-exhausted)' "$WARN_FILE"; then
  pass "the retirement is logged once with its cause"
else
  fail "retirement warning missing"
fi

# ── 2. Route-stamp (acceptance 2) ───────────────────────────────────────────
seed "HOK-3145_c" "completed"
dir="$(state_dir_for HOK-3145_c)"
write_ready_result "$dir" '{"type":"ready","verdict":"pass","checksRun":3,"checksPassed":3,"prNumber":1559,"transitionFailure":{"stage":"route-stamp","detail":"review identity mismatch"}}'
run_terminalize "HOK-3145_c"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3145_c challengeAborted)" == "invalid_challenge:ready-transition-failed" ]] \
  && [[ "$(get_task_meta HOK-3145_c challengeAbortedDetail)" == *"transition route-stamp (review identity mismatch)"* ]] \
  && [[ "$(get_task_meta HOK-3145_c challengeAbortedNextAction)" == *"invalid challenge"* ]] \
  && [[ "$(close_count)" == "1" ]]; then
  pass "route-stamp exhaustion retires the challenger as an invalid challenge and closes its PR"
else
  fail "route-stamp retirement wrong (rc=$rc aborted=$(get_task_meta HOK-3145_c challengeAborted))"
fi

# ── 3. Symmetric: primary exhausted, challenger green ──────────────────────
seed "HOK-3145" "completed"
dir="$(state_dir_for HOK-3145)"
write_ready_result "$dir" '{"type":"ready","verdict":"fail","checksRun":2,"checksPassed":1,"prNumber":1560,"remediationFailures":["lint"]}'
run_terminalize "HOK-3145"
if [[ "$rc" == "0" ]] \
  && [[ "$(get_task_meta HOK-3145 challengeAborted)" == "terminal_stage_failure:ready-exhausted" ]] \
  && [[ -z "$(get_task_meta HOK-3145_c challengeAborted)" ]] \
  && grep -q '^pr close 1560 ' "$GH_LOG"; then
  pass "an exhausted primary is retired when the challenger is green"
else
  fail "symmetric retirement wrong (rc=$rc)"
fi

# ── 4. Sibling not green → legacy hold ─────────────────────────────────────
for sibling_status in failed running ""; do
  seed "HOK-3145_c" "$sibling_status"
  dir="$(state_dir_for HOK-3145_c)"
  write_ready_result "$dir" '{"type":"ready","verdict":"fail","checksRun":3,"checksPassed":2,"remediationFailures":["unit"]}'
  run_terminalize "HOK-3145_c"
  if [[ "$rc" == "1" ]] \
    && [[ -z "$(get_task_meta HOK-3145_c challengeAborted)" ]] \
    && [[ ! -f "$dir/.challenge-aborted.json" ]] \
    && [[ "$(close_count)" == "0" ]]; then
    pass "sibling Ready '${sibling_status:-missing}' keeps the needs-user hold"
  else
    fail "sibling '${sibling_status:-missing}' should hold (rc=$rc)"
  fi
done

# A sibling that is itself retired is not green either (never close both PRs).
seed "HOK-3145_c" "completed"
jq '.tasks["HOK-3145"].challengeAborted = "terminal_stage_failure:ready-exhausted"' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
run_terminalize "HOK-3145_c"
if [[ "$rc" == "1" ]] && [[ -z "$(get_task_meta HOK-3145_c challengeAborted)" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "a retired sibling never releases the other arm"
else
  fail "retired sibling should hold (rc=$rc)"
fi

# ── 5. Idempotent ───────────────────────────────────────────────────────────
seed "HOK-3145_c" "completed"
dir="$(state_dir_for HOK-3145_c)"
write_ready_result "$dir" '{"type":"ready","verdict":"fail","checksRun":3,"checksPassed":2,"remediationFailures":["unit"]}'
GH_CLOSE_RC=1
run_terminalize "HOK-3145_c"
first_rc="$rc"
first_aborted_at="$(jq -r '.abortedAt' "$dir/.challenge-aborted.json")"
GH_CLOSE_RC=0
: > "$WARN_FILE"
run_terminalize "HOK-3145_c"
second_rc="$rc"
run_terminalize "HOK-3145_c"
if [[ "$first_rc" == "0" && "$second_rc" == "0" && "$rc" == "0" ]] \
  && [[ "$(close_count)" == "2" ]] \
  && [[ "$PR_STATE" == "CLOSED" ]] \
  && [[ "$(jq -r '.abortedAt' "$dir/.challenge-aborted.json")" == "$first_aborted_at" ]] \
  && ! grep -q 'retired' "$WARN_FILE"; then
  pass "a failed close is retried next tick without re-stamping; a closed PR is left alone"
else
  fail "idempotency wrong (rcs=$first_rc/$second_rc/$rc closes=$(close_count) state=$PR_STATE)"
fi

# An unrelated abort stamp (e.g. a mirrored pair-scope quarantine) is never
# treated as this helper's retirement: the PR stays open.
seed "HOK-3145_c" "completed"
jq '.tasks["HOK-3145_c"].challengeAborted = "terminal_stage_failure:context-exhausted" | .tasks["HOK-3145_c"].challengeAbortedStage = "implementation"' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
run_terminalize "HOK-3145_c"
if [[ "$rc" == "1" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "an unrelated abort stamp keeps the hold and never closes the PR"
else
  fail "unrelated stamp handling wrong (rc=$rc closes=$(close_count))"
fi

# ── 6. Non-challenge task ──────────────────────────────────────────────────
seed "HOK-3145_c" "completed"
jq '.tasks["HOK-3145_c"].challenge = false' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
dir="$(state_dir_for HOK-3145_c)"
run_terminalize "HOK-3145_c"
if [[ "$rc" == "1" ]] && [[ ! -f "$dir/.challenge-aborted.json" ]] && [[ "$(close_count)" == "0" ]]; then
  pass "a non-challenge task is never retired"
else
  fail "non-challenge task touched (rc=$rc)"
fi

# ── 7. Unattributed ─────────────────────────────────────────────────────────
seed "HOK-3145_c" "completed"
run_terminalize "HOK-3145_c"
if [[ "$rc" == "0" ]] && [[ "$(get_task_meta HOK-3145_c challengeAborted)" == "invalid_challenge:ready-unattributed" ]]; then
  pass "no ready result classifies as invalid_challenge:ready-unattributed"
else
  fail "missing-result classification wrong ($(get_task_meta HOK-3145_c challengeAborted))"
fi

# The update-from-base conflict caller passes an explicit cause, overriding a
# stale red-check result.
seed "HOK-3145_c" "completed"
dir="$(state_dir_for HOK-3145_c)"
write_ready_result "$dir" '{"type":"ready","verdict":"fail","checksRun":3,"checksPassed":2,"remediationFailures":["unit"]}'
run_terminalize "HOK-3145_c" "invalid_challenge:ready-unattributed"
if [[ "$rc" == "0" ]] && [[ "$(get_task_meta HOK-3145_c challengeAborted)" == "invalid_challenge:ready-unattributed" ]]; then
  pass "an explicit cause (base conflict) overrides the result classification"
else
  fail "explicit cause ignored ($(get_task_meta HOK-3145_c challengeAborted))"
fi

# ── 8. Cause classifier table ──────────────────────────────────────────────
classify() {
  local artifacts="$1"
  local d="$TMP_ROOT/classify"
  rm -rf "$d"; mkdir -p "$d"
  [[ "$artifacts" == "none" ]] || write_ready_result "$d" "$artifacts"
  ready_exhausted_challenge_cause "$d"
}
classifier_ok=true
check_cause() {
  local expected="$1" artifacts="$2" got
  got="$(classify "$artifacts")"
  if [[ "$got" != "$expected" ]]; then
    classifier_ok=false
    echo "    classify($artifacts) = $got, expected $expected" >&2
  fi
}
check_cause "terminal_stage_failure:ready-exhausted"   '{"checksRun":3,"checksPassed":1}'
check_cause "terminal_stage_failure:ready-exhausted"   '{"remediationFailures":["unit"]}'
check_cause "invalid_challenge:ready-transition-failed" '{"checksRun":3,"checksPassed":3,"transitionFailure":{"stage":"ready-label"}}'
check_cause "invalid_challenge:ready-unattributed"     '{"checksRun":3,"checksPassed":2,"mergeConflict":"CONFLICTING","remediationFailures":["unit"]}'
check_cause "invalid_challenge:ready-unattributed"     '{"checksRun":0,"checksPassed":0,"remediationFailures":[]}'
check_cause "invalid_challenge:ready-unattributed"     '{"transitionFailure":"not-an-object"}'
check_cause "invalid_challenge:ready-unattributed"     'none'
printf 'not json' > "$TMP_ROOT/classify/.ready-result.json"
[[ "$(ready_exhausted_challenge_cause "$TMP_ROOT/classify")" == "invalid_challenge:ready-unattributed" ]] || classifier_ok=false
if [[ "$classifier_ok" == "true" ]]; then
  pass "cause classifier maps red checks, transitions, conflicts and missing evidence"
else
  fail "cause classifier table"
fi

# ── 9. Wiring: the failed-Ready branch calls the helper before holding ─────
if grep -q 'exhausted|exhausted-quiet)' "$MONITOR_SCRIPT_FILE" \
  && [[ "$(grep -c 'ready_exhausted_challenge_terminalize "\$ISSUE" "\$PR" "\$ready_state_dir_path" "\$WIN"' "$MONITOR_SCRIPT_FILE")" == "2" ]]; then
  pass "the exhausted and base-conflict holds both try the retirement first"
else
  fail "failed-Ready branch wiring missing"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
