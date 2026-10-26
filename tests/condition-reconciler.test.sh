#!/usr/bin/env bash
# HOK-3172 acceptance: the condition reconciler clears each marker exactly when
# the condition that set it no longer holds, and never otherwise.
#
# One fixture per original incident:
#   HOK-3167  status=error survives a re-review
#   HOK-3168  same-head infra markers survive a substantive verdict
#   HOK-3171  GitHub head lag turns an observation into a permanent refusal
#   HOK-3165  review-infra exhaustion re-arms on a new head (not the same head)
# plus regressions found in review: UTC timestamp parsing on BSD date, the PR
# cache being an array, and exhausted sentinels without a SHA head.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/shared/lib/bounded-retry.sh"
source "$REPO_DIR/shared/lib/transient-marker.sh"
source "$REPO_DIR/shared/lib/condition-reconciler.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
exists() { [[ -e "$1" ]] && echo yes || echo no; }

# The real infra classifier, so the reconciler is held to its calling
# contract (it takes the feature dir, not the result file). Tests set
# INFRA_REVIEW=1 to make write_review produce an infra-failure artifact.
INFRA_REVIEW=0
for fn in review_result_has_final_evidence review_result_missing_final_evidence review_result_infra_failure; do
  eval "$(sed -n "/^${fn}() {/,/^}/p" "$REPO_DIR/shared/lib/wavemill-monitor.sh")"
  declare -F "$fn" >/dev/null || { echo "could not extract $fn" >&2; exit 1; }
done

ISSUE="HOK-9999"
SESSION="reconciler-test"
export MONITOR_PR_CACHE="$TMP_DIR/pr-cache.json"

# Fresh worktree (git repo with two commits) + state dir + state file.
new_fixture() {
  WT="$TMP_DIR/wt-$RANDOM$RANDOM"
  STATE_DIR="$WT/features/task"
  mkdir -p "$STATE_DIR"
  git -C "$WT" init -q
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
  OLD_HEAD="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
  HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
  STATE_FILE="$TMP_DIR/state-$RANDOM$RANDOM.json"
  jq -n --arg i "$ISSUE" '{tasks: {($i): {status: "active", phase: "ready", pr: "1591"}}}' > "$STATE_FILE"
  export STATE_FILE
  echo '[]' > "$MONITOR_PR_CACHE"
}
reconcile() { condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR"; }
write_review() { # status finishedAt — infra tool error when INFRA_REVIEW=1
  local artifacts='{type: "review", verdict: "not_ready", exitCode: 1, iterations: 1, blockerCount: 2}'
  [[ "$INFRA_REVIEW" == "1" ]] && artifacts='{type: "review", verdict: "error", exitCode: 1, reviewToolError: "claude exited 1"}'
  jq -n --arg s "$1" --arg f "$2" \
    "{stage: \"review\", status: \$s, startedAt: \"2026-10-06T21:00:00.123Z\", finishedAt: \$f,
      artifacts: $artifacts}" > "$STATE_DIR/.review-result.json"
}
pr_cache() { # number headRefOid
  jq -n --argjson n "$1" --arg h "$2" '[{number: 42, headRefOid: "deadbeef"}, {number: $n, headRefOid: $h}]' > "$MONITOR_PR_CACHE"
}
set_task() { jq --arg i "$ISSUE" ".tasks[\$i] |= ($1)" "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"; }

echo "=== HOK-3167: re-review clears status=error ==="
new_fixture
set_task '.status = "error"'
reconcile
assert_eq "no operator event: status stays error" "error" "$(jq -r --arg i "$ISSUE" '.tasks[$i].status' "$STATE_FILE")"
assert_eq "no operator event: nothing logged" "no" "$(exists "$STATE_DIR/.condition-reconcile.jsonl")"
operator_event_record "$STATE_DIR" "re-review" "$ISSUE"
reconcile
assert_eq "re-review: status becomes active" "active" "$(jq -r --arg i "$ISSUE" '.tasks[$i].status' "$STATE_FILE")"
assert_eq "re-review: clear attributed to the command" "re-review" "$(jq -r --arg i "$ISSUE" '.tasks[$i].statusClearedBy.command' "$STATE_FILE")"
assert_eq "re-review: audit entry written once" "1" "$(grep -c 'status=error' "$STATE_DIR/.condition-reconcile.jsonl")"
reconcile
assert_eq "second tick: no repeat audit entry" "1" "$(grep -c 'status=error' "$STATE_DIR/.condition-reconcile.jsonl")"

echo "=== HOK-3168: substantive verdict supersedes same-head infra marker ==="
new_fixture
write_review completed "2026-10-06T21:10:00Z"
marker_write "$STATE_DIR/.needs-attention" --kind ready-attention --head "$HEAD_SHA" \
  --reason "Review infrastructure recovery is exhausted" --state-dir "$STATE_DIR" \
  --expires-on "head,operator-event,review-artifact-substantive" --review-artifact
reconcile
assert_eq "same review artifact: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
write_review running "2026-10-06T21:30:00Z"
reconcile
assert_eq "review still running: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
INFRA_REVIEW=1
write_review completed "2026-10-06T21:31:00Z"
reconcile
assert_eq "new review is another infra failure: marker kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
INFRA_REVIEW=0
write_review completed "2026-10-06T21:32:00Z"
reconcile
assert_eq "new substantive verdict at same head: marker cleared" "no" "$(exists "$STATE_DIR/.needs-attention")"

echo "=== HOK-3171: waiting on GitHub head lag ==="
new_fixture
marker_write "$STATE_DIR/.ready-waiting-on.json" --kind ready-waiting-on --head "$HEAD_SHA" \
  --state-dir "$STATE_DIR" --waiting-on "pr-head=$HEAD_SHA@1591" --expires-on "head,waiting-on"
pr_cache 1591 "$OLD_HEAD"
reconcile
assert_eq "PR head still lagging: wait kept" "yes" "$(exists "$STATE_DIR/.ready-waiting-on.json")"
pr_cache 1591 "$HEAD_SHA"
reconcile
assert_eq "PR head caught up (array cache): wait cleared" "no" "$(exists "$STATE_DIR/.ready-waiting-on.json")"

new_fixture
marker_write "$STATE_DIR/.needs-attention" --kind ready-attention --head "$HEAD_SHA" \
  --observed "prHeadRefOid=$OLD_HEAD" --expires-on "head,operator-event,remote" --state-dir "$STATE_DIR"
pr_cache 1591 "$OLD_HEAD"
reconcile
assert_eq "remote unchanged: refusal kept" "yes" "$(exists "$STATE_DIR/.needs-attention")"
pr_cache 1591 "$HEAD_SHA"
reconcile
assert_eq "remote moved (task .pr field): refusal cleared" "no" "$(exists "$STATE_DIR/.needs-attention")"

echo "=== deadline trigger (UTC parsing) ==="
new_fixture
marker_write "$STATE_DIR/.needs-attention-transient" --kind ready-attention-transient --head "$HEAD_SHA" \
  --state-dir "$STATE_DIR" --expires-on "deadline" --recheck-after-seconds 3600
reconcile
assert_eq "deadline one hour away: kept (not shifted by local UTC offset)" "yes" "$(exists "$STATE_DIR/.needs-attention-transient")"
jq '.condition.recheckAfter = "2000-01-01T00:00:00Z"' "$STATE_DIR/.needs-attention-transient" > "$TMP_DIR/m" && mv "$TMP_DIR/m" "$STATE_DIR/.needs-attention-transient"
reconcile
assert_eq "deadline passed: cleared" "no" "$(exists "$STATE_DIR/.needs-attention-transient")"
marker_write "$STATE_DIR/.needs-attention-transient" --kind ready-attention-transient --head "$HEAD_SHA" \
  --state-dir "$STATE_DIR" --expires-on "deadline" --recheck-after-seconds 3600
jq '.condition.recheckAfter = "not-a-time"' "$STATE_DIR/.needs-attention-transient" > "$TMP_DIR/m" && mv "$TMP_DIR/m" "$STATE_DIR/.needs-attention-transient"
reconcile
assert_eq "unparseable deadline: kept (fail closed)" "yes" "$(exists "$STATE_DIR/.needs-attention-transient")"
assert_eq "UTC parse of fractional timestamp" "1791321437" "$(_condition_iso_to_epoch 2026-10-06T21:17:17.793Z)"

echo "=== HOK-3165: review-infra exhaustion re-arms only on a new head ==="
new_fixture
bounded_retry_increment "$STATE_DIR" "review-infra-recovery" "${HEAD_SHA}:review-tool-error" >/dev/null
bounded_retry_mark_exhausted "$STATE_DIR" "review-infra-recovery" "exhausted after 2 attempt(s)"
reconcile
assert_eq "same head: exhaustion kept" "yes" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m three
reconcile
assert_eq "new head: exhaustion cleared" "no" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"

new_fixture
bounded_retry_increment "$STATE_DIR" "review-infra-recovery" "${HEAD_SHA}:review-tool-error" >/dev/null
printf 'legacy sentinel\n' > "$STATE_DIR/.retry-review-infra-recovery-exhausted"
reconcile
assert_eq "legacy sentinel, same head (<sha>:<category> key): kept" "yes" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"

echo "=== HOK-3177: composite retry-identity head expires on a new head ==="
new_fixture
bounded_retry_mark_exhausted "$STATE_DIR" "review-infra-recovery" "exhausted after 2 attempt(s)" \
  --head "${HEAD_SHA}::native-review-timeout:/:::::::" --expires-on "head,operator-event,review-artifact-substantive"
reconcile
assert_eq "composite key, same head: exhaustion kept" "yes" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m three
reconcile
assert_eq "composite key, new head: exhaustion cleared" "no" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"

echo "=== review-infra exhaustion expires on a substantive verdict at the same head ==="
# HOK-2804: the exhausted sentinel latched for an hour after a real review
# landed, because the reconciler passed the result file where the classifier
# expects the feature dir and every artifact read as an infra failure.
new_fixture
INFRA_REVIEW=1
write_review completed "2026-10-15T14:14:14Z"
bounded_retry_mark_exhausted "$STATE_DIR" "review-infra-recovery" "exhausted after 2 attempt(s)" \
  --head "${HEAD_SHA}:review-tool-error" --expires-on "head,operator-event,review-artifact-substantive" \
  --review-artifact
reconcile
assert_eq "same infra artifact: exhaustion kept" "yes" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"
INFRA_REVIEW=0
write_review completed "2026-10-15T14:16:28Z"
reconcile
assert_eq "substantive verdict at same head: exhaustion cleared" "no" "$(exists "$STATE_DIR/.retry-review-infra-recovery-exhausted")"

echo "=== terminal short-circuit without a SHA head ==="
new_fixture
bounded_retry_mark_exhausted "$STATE_DIR" "coding-launch-refused" "terminal: no launchable coder"
reconcile
assert_eq "no head key: terminal sentinel kept" "yes" "$(exists "$STATE_DIR/.retry-coding-launch-refused-exhausted")"
assert_eq "no placeholder head recorded" "" "$(jq -r '.condition.head // empty' "$STATE_DIR/.retry-coding-launch-refused-exhausted-condition.json")"
operator_event_record "$STATE_DIR" "advance" "$ISSUE"
reconcile
assert_eq "operator event: terminal sentinel cleared" "no" "$(exists "$STATE_DIR/.retry-coding-launch-refused-exhausted")"
assert_eq "two-argument mark_exhausted does not abort" "ok" "$(bounded_retry_mark_exhausted "$STATE_DIR" "two-arg" >/dev/null && echo ok)"

echo "=== HOK-3273: in-flight conflict resolver marker expires on its condition ==="
write_conflict_marker() { # launch-head observed-pr-head
  marker_write "$STATE_DIR/.conflict-remediation.json" --kind conflict-remediation --head "$1" \
    --observed "prHeadRefOid=$2" --expires-on "head,remote,operator-event" \
    --detail-json "$(jq -cn --arg h "$1" '{head: $h, base: "auto/integration", launchHead: $h, prNumber: 1591}')"
}
new_fixture
write_conflict_marker "$HEAD_SHA" "$HEAD_SHA"
pr_cache 1591 "$HEAD_SHA"
reconcile
assert_eq "resolver still at its launch head: marker kept" "yes" "$(exists "$STATE_DIR/.conflict-remediation.json")"
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "Resolve merge conflicts"
reconcile
assert_eq "resolver pushed (head moved): marker cleared" "no" "$(exists "$STATE_DIR/.conflict-remediation.json")"

new_fixture
write_conflict_marker "$HEAD_SHA" "$HEAD_SHA"
pr_cache 1591 "$OLD_HEAD"
reconcile
assert_eq "PR head moved on GitHub (remote): marker cleared" "no" "$(exists "$STATE_DIR/.conflict-remediation.json")"

new_fixture
write_conflict_marker "$HEAD_SHA" "$HEAD_SHA"
pr_cache 1591 "$HEAD_SHA"
operator_event_record "$STATE_DIR" "re-review" "$ISSUE"
reconcile
assert_eq "operator event: marker cleared" "no" "$(exists "$STATE_DIR/.conflict-remediation.json")"

echo "=== HOK-3316: tend merge-attempt fact expires on the PR head or an operator event ==="
write_tend_fact() { # head base [writtenAt]
  jq -n --arg h "$1" --arg b "$2" --arg at "${3:-2026-10-22T17:12:29.000Z}" '{
    schemaVersion: 1, kind: "tend-attempt", headSha: $h, writtenAt: $at, reason: "tend-rebase-failed",
    detail: {phase: "rebase", prNumber: 1591, baseSha: $b, excerpt: "CONFLICT (content)", failureClass: "code-failure"},
    condition: {expiresOn: ["remote", "operator-event"], operatorEventSeq: 0,
                observed: {prHeadRefOid: $h, integrationBaseSha: $b}}}' > "$STATE_DIR/.tend-attempt-result.json"
}
new_fixture
write_tend_fact "$HEAD_SHA" "base-1"
pr_cache 1591 "$HEAD_SHA"
reconcile
assert_eq "fact at the live PR head: kept" "yes" "$(exists "$STATE_DIR/.tend-attempt-result.json")"
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "local only"
reconcile
assert_eq "task worktree HEAD alone moving (tend pushed from scratch): kept" "yes" "$(exists "$STATE_DIR/.tend-attempt-result.json")"

new_fixture
write_tend_fact "$HEAD_SHA" "base-1"
pr_cache 1591 "$OLD_HEAD"
reconcile
assert_eq "PR head moved on GitHub (remote): fact cleared" "no" "$(exists "$STATE_DIR/.tend-attempt-result.json")"

new_fixture
write_tend_fact "$HEAD_SHA" "base-1"
pr_cache 1591 "$HEAD_SHA"
operator_event_record "$STATE_DIR" "advance" "$ISSUE"
reconcile
assert_eq "operator event: fact cleared" "no" "$(exists "$STATE_DIR/.tend-attempt-result.json")"

echo "=== HOK-3316: a tend rebase fact re-runs Ready exactly once ==="
for fn in tend_attempt_fact_path tend_attempt_conflict_needs_ready; do
  eval "$(sed -n "/^${fn}() {/,/^}/p" "$REPO_DIR/shared/lib/wavemill-monitor.sh")"
  declare -F "$fn" >/dev/null || { echo "could not extract $fn" >&2; exit 1; }
done
wavemill_pr_cache_row_by_pr() { jq -c --argjson pr "$1" '.[] | select(.number == $pr)' "$MONITOR_PR_CACHE"; }
needs_ready() { tend_attempt_conflict_needs_ready "$STATE_DIR" 1591 "$1" && echo yes || echo no; }
new_fixture
pr_cache 1591 "$HEAD_SHA"
assert_eq "no fact: no Ready re-run" "no" "$(needs_ready base-1)"
write_tend_fact "$HEAD_SHA" "base-1" "2026-10-22T17:12:29.000Z"
jq -n '{stage: "ready", status: "completed", startedAt: "2026-10-22T12:00:00Z", finishedAt: "2026-10-22T12:05:00Z"}' > "$STATE_DIR/.ready-result.json"
assert_eq "fact newer than the Ready pass: re-run Ready" "yes" "$(needs_ready base-1)"
assert_eq "base moved since the attempt: no re-run (tend retries instead)" "no" "$(needs_ready base-2)"
pr_cache 1591 "$OLD_HEAD"
assert_eq "PR head moved: no re-run" "no" "$(needs_ready base-1)"
pr_cache 1591 "$HEAD_SHA"
jq -n '{stage: "ready", status: "running", startedAt: "2026-10-22T17:13:00Z", finishedAt: null}' > "$STATE_DIR/.ready-result.json"
assert_eq "Ready already ran after the fact: no second re-run" "no" "$(needs_ready base-1)"

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
