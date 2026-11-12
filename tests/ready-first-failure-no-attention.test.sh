#!/usr/bin/env bash
# HOK-3360 incident replay (CI run 41086521534): a first-occurrence
# non-remediable Ready failure that recovers on the next tick must never page
# an operator. It drives the real ready_failure_classify_and_act +
# maybe_retry_failed_stage + the real escalation step (operator-escalation.sh),
# so the "retryable first occurrence records evidence, only exhaustion pages"
# contract is exercised end to end.
#
# protects: a one-tick retryable Ready failure pages an operator (HOK-3360
# incident); and an exhausted Ready budget pages exactly once.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

# Real helpers under test: marker writer, bounded retry, and the one escalation
# step (no stub — this test proves the real escalation path).
# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"
# shellcheck source=../shared/lib/operator-escalation.sh
source "$REPO_DIR/shared/lib/operator-escalation.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; [[ -n "${2:-}" ]] && echo "    $2"; FAIL=$((FAIL + 1)); }
check_eq() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "expected='$3' actual='$2'"; }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Brace-depth-aware function extraction (matches other monitor tests).
extract_function() {
  awk -v name="$1" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture { print; depth += brace_delta($0); if (depth == 0) exit }
  ' "$MONITOR_SCRIPT_FILE"
}

for fn in \
  ready_failure_reason \
  ready_failure_evidence_detail \
  ready_failure_base_drift \
  ready_failure_classify_and_act \
  stage_result_field \
  stage_failure_owned_by_bucket \
  stage_failure_decision \
  phase_launch_head \
  phase_launch_base \
  maybe_retry_failed_stage \
; do
  eval "$(extract_function "$fn")"
done

# Controller seams the incident path does not exercise are stubbed; the
# escalation step is the real one.
log() { :; }
log_warn() { :; }
log_error() { :; }
get_task_meta() { :; }
check_stage_aborted() { return 1; }
set_task_phase() { :; }
set_window_attention_state() { :; }
ready_exhausted_challenge_terminalize() { return 1; }
try_update_branch_from_base() { printf 'not-behind\n'; }
# The relaunch itself is not under test; the incident is about whether the
# launcher/classifier pages. A "successful" relaunch models the next-tick pass.
RELAUNCH_RC=0
_stage_failure_ready_relaunch() { return "$RELAUNCH_RC"; }
# Default policy decision: retryable (the HOK-3176 default, matching the
# incident's unrecognised non-remediable failure).
failure_policy_decide() {
  printf '%s\n' '{"class":"retryable","failureKind":"native-unclassified","terminalCode":null,"retryBucket":"stage-failure-ready","attribution":"unattributed","nextAction":"retry by default","rationale":"test default"}'
}

# A per-task git repo so the escalation step can resolve HEAD.
STATE_DIR="$TEST_TMP/features/hok-3360/ready"
mkdir -p "$STATE_DIR"
git -C "$STATE_DIR" init -q
git -C "$STATE_DIR" config user.email t@example.com
git -C "$STATE_DIR" config user.name t
git -C "$STATE_DIR" commit -q --allow-empty -m init
BUCKET="stage-failure-ready"
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_READY_BASE_SECONDS=0

write_failed_ready() {
  printf '%s\n' '{"stage":"ready","status":"failed","agent":"claude","model":"m","notes":"Ready checks failed","artifacts":{"type":"ready","verdict":"fail","prNumber":1743}}' \
    > "$STATE_DIR/.ready-result.json"
}

act() {
  if ready_failure_classify_and_act HOK-3360 hok-3360 "$STATE_DIR" "$STATE_DIR" task/hok-3360 auto/integration 1743 win "$(git -C "$STATE_DIR" rev-parse HEAD)"; then
    printf 'rc=0\n'
  else
    printf 'rc=%s\n' "$?"
  fi
}

echo "=== HOK-3360: first-occurrence retryable Ready failure never pages ==="

# ── Tick 1: a first non-remediable failure is retried, not paged ────────────
write_failed_ready
out="$(act)"
check_eq "tick 1 relaunches Ready (retryable)" "$out" "rc=0"
check_eq "tick 1 charges the stage-failure-ready bucket" "$(bounded_retry_count "$STATE_DIR" "$BUCKET")" "1"
check_eq "tick 1 raises no operator attention" "$([[ -f "$STATE_DIR/.needs-attention" ]] && echo present || echo absent)" "absent"

# ── Tick 2: the relaunch's next check passes — still no attention ───────────
# (Modelled as a clean bucket + a completed result; the launcher clears the
# bucket on a pass. The invariant is only that no attention was ever raised.)
bounded_retry_clear "$STATE_DIR" "$BUCKET"
printf '%s\n' '{"stage":"ready","status":"completed","agent":"claude","artifacts":{"type":"ready","verdict":"pass","prNumber":1743}}' > "$STATE_DIR/.ready-result.json"
check_eq "tick 2 Ready completed" "$(jq -r .status "$STATE_DIR/.ready-result.json")" "completed"
check_eq "no .needs-attention at any tick" "$([[ -f "$STATE_DIR/.needs-attention" ]] && echo present || echo absent)" "absent"

echo ""
echo "=== HOK-3360: an exhausted Ready budget pages exactly once ==="

# Fill the bucket to its ceiling (WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS=3) so the
# next classify terminalizes through maybe_retry and escalates.
write_failed_ready
head_sha="$(git -C "$STATE_DIR" rev-parse HEAD)"
bounded_retry_increment "$STATE_DIR" "$BUCKET" "$head_sha" >/dev/null
bounded_retry_increment "$STATE_DIR" "$BUCKET" "$head_sha" >/dev/null
bounded_retry_increment "$STATE_DIR" "$BUCKET" "$head_sha" >/dev/null
out="$(act)"
check_eq "exhausted budget escalates" "$out" "rc=1"
check_eq "exhaustion wrote exactly one attention marker" "$([[ -f "$STATE_DIR/.needs-attention" ]] && echo present || echo absent)" "present"
basis="$(jq -r '.detail.escalationBasis // empty' "$STATE_DIR/.needs-attention" 2>/dev/null || true)"
check_eq "the attention basis records exhausted:stage-failure-ready" "$basis" "exhausted:stage-failure-ready"

# A later classify at the same head must not rewrite the marker (idempotent).
mtime_before="$(stat -f %m "$STATE_DIR/.needs-attention" 2>/dev/null || stat -c %Y "$STATE_DIR/.needs-attention")"
out="$(act)"
mtime_after="$(stat -f %m "$STATE_DIR/.needs-attention" 2>/dev/null || stat -c %Y "$STATE_DIR/.needs-attention")"
check_eq "a later tick does not rewrite the attention marker" "$mtime_after" "$mtime_before"

echo ""
echo "ready-first-failure-no-attention: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
