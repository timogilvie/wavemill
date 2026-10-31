#!/usr/bin/env bash
# HOK-3371 acceptance: the one Ready-failure disposition.
#
# ready_failure_classify_and_act reads the full failure evidence from
# .ready-result.json, asks the single failure policy what to do, and
# dispatches: base drift runs update-from-base first; a transition tool's
# deterministic code-failure goes to the operator with the excerpt and never
# spends the retry budget; a terminal allowlist cause retires a challenge arm;
# everything else relaunches through the shared stage-failure-ready bucket via
# maybe_retry_failed_stage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

# Brace-depth-aware extraction so functions with nested braces survive intact.
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
  _stage_failure_ready_relaunch \
  ready_failure_classify_and_act \
  stage_result_field \
  native_hook_terminal_failure_detail \
  native_coding_failure_handoff_reason \
  native_stage_failure_envelope_json \
  stage_failure_owned_by_bucket \
  stage_failure_decision \
  phase_launch_head \
  phase_launch_base \
  maybe_retry_failed_stage \
; do
  eval "$(extract_function "$fn")"
done

STATE_LOG="$TMP_ROOT/state.log"
ATTENTION_LOG="$TMP_ROOT/attention.log"
STATUS_LOG="$TMP_ROOT/status.log"

log() { printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$STATUS_LOG"; }
log_error() { printf '%s\n' "$1" >> "$STATUS_LOG"; }
log_task() { printf '%s\n' "$*" >> "$STATUS_LOG"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$STATE_LOG"; }
set_task_phase() { printf '%s=%s\n' "$1" "$2" >> "$STATE_LOG"; }
write_ready_attention_file() { printf '%s\n' "$2" >> "$ATTENTION_LOG"; }

WORKTREE="$TMP_ROOT/worktrees/hok-3371"
STATE_DIR="$WORKTREE/features/hok-3371/ready"
mkdir -p "$STATE_DIR"
BASE_BRANCH="auto/integration"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
SESSION="rfca$$"

pass_task_field() {
  case "$2" in
    worktree) printf '%s\n' "$WORKTREE" ;;
    branch) printf 'task/hok-3371\n' ;;
    pr) printf '4041\n' ;;
    title) printf 'HOK-3371 fixture\n' ;;
    *) printf '\n' ;;
  esac
}
effective_task_base_branch() { printf '%s\n' "$BASE_BRANCH"; }
get_task_meta() { :; }
check_stage_aborted() { return 1; }

LAUNCH_CALLS_FILE="$TMP_ROOT/launch-calls"
: > "$LAUNCH_CALLS_FILE"
READY_LAUNCH_RC=0
launch_ready_phase() {
  printf 'launch: %s\n' "$*" >> "$LAUNCH_CALLS_FILE"
  return "$READY_LAUNCH_RC"
}

UPDATE_CALLS_FILE="$TMP_ROOT/update-calls"
: > "$UPDATE_CALLS_FILE"
try_update_branch_from_base() {
  printf 'update: %s\n' "$*" >> "$UPDATE_CALLS_FILE"
  printf '%s\n' "${TRY_UPDATE_RESULT:-not-behind}"
  return 0
}

TERMINALIZE_CALLS_FILE="$TMP_ROOT/terminalize-calls"
: > "$TERMINALIZE_CALLS_FILE"
TERMINALIZE_RC=1
ready_exhausted_challenge_terminalize() {
  printf 'terminalize: %s\n' "$*" >> "$TERMINALIZE_CALLS_FILE"
  return "$TERMINALIZE_RC"
}

# The policy bridge is stubbed at the seam failure_policy_decide consumes, so
# each case pins the class the real policy returns for that evidence.
_failure_policy_cli() {
  if [[ -n "${FAILURE_POLICY_DECISION:-}" ]]; then
    printf '%s\n' "$FAILURE_POLICY_DECISION"
  else
    printf '%s\n' '{"class":"retryable","failureKind":"native-unclassified","terminalCode":null,"retryBucket":"stage-failure-ready","attribution":"unattributed","nextAction":"retry by default","rationale":"test default"}'
  fi
  return 0
}

write_failed_result() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$1" > "$STATE_DIR/.ready-result.json"
}

act() {
  : > "$STATE_LOG"; : > "$ATTENTION_LOG"; : > "$STATUS_LOG"
  if ready_failure_classify_and_act HOK-3371 hok-3371 "$STATE_DIR" "$WORKTREE" task/hok-3371 "$BASE_BRANCH" 4041 win current-head; then
    printf 'rc=0\n'
  else
    printf 'rc=%s\n' "$?"
  fi
}

bucket="stage-failure-ready"
HOK_3361_DETAIL='Expected resolved_model for planner inherited'

echo "=== Ready failure disposition (HOK-3371) ==="

# ── The HOK-3361 replay: a deterministic transition-tool error ──────────
FAILURE_POLICY_DECISION='{"class":"code-failure","failureKind":"native-unclassified","terminalCode":null,"retryBucket":"stage-failure-ready","attribution":"unattributed","nextAction":"remediate the failing change from the recorded excerpt, then push a new head","rationale":"test"}'
write_failed_result "{\"stage\":\"ready\",\"status\":\"failed\",\"agent\":\"claude\",\"artifacts\":{\"verdict\":\"pass\",\"transitionFailure\":{\"stage\":\"route-stamp\",\"detail\":\"$HOK_3361_DETAIL\"}}}"
out="$(act)"
check_eq "a deterministic transition error escalates to the operator" "$out" "rc=1"
check_contains "the transition error text reaches the attention record" "$(cat "$ATTENTION_LOG")" "$HOK_3361_DETAIL"
check_contains "the transition error text reaches the mill log" "$(cat "$STATUS_LOG")" "$HOK_3361_DETAIL"
check_eq "the transition error spends no retry budget" "$(bounded_retry_count "$STATE_DIR" "$bucket")" "0"
check_eq "the transition error never runs update-from-base" "$(wc -l < "$UPDATE_CALLS_FILE" | tr -d ' ')" "0"
check_eq "the transition error launches nothing" "$(wc -l < "$LAUNCH_CALLS_FILE" | tr -d ' ')" "0"

# ── Base drift runs update-from-base before anything else (HOK-3092) ────
TRY_UPDATE_RESULT="updated"
write_failed_result '{"stage":"ready","status":"failed","agent":"claude","artifacts":{"verdict":"fail","mergeConflict":"CONFLICTED"}}'
FAILURE_POLICY_DECISION=""
out="$(act)"
check_eq "a conflict signature updates from base and holds for the new head" "$out" "rc=0"
check_contains "update-from-base ran for the conflict" "$(cat "$UPDATE_CALLS_FILE")" "HOK-3371"
check_eq "the conflict consumed no retry budget" "$(bounded_retry_count "$STATE_DIR" "$bucket")" "0"
TRY_UPDATE_RESULT="not-behind"

# ── Retryable: the shared stage-failure-ready bucket ────────────────────
write_failed_result '{"stage":"ready","status":"failed","agent":"claude","artifacts":{"verdict":"fail"}}'
out="$(act)"
check_eq "a retryable failure relaunches Ready" "$out" "rc=0"
check_eq "the relaunch charges the stage-failure-ready bucket" "$(bounded_retry_count "$STATE_DIR" "$bucket")" "1"
check_contains "the relaunch carries the evidence kind in its log" "$(cat "$STATUS_LOG")" "re-running Ready checks (attempt 1/3)"

# A repeat failure inside the backoff window holds without spending budget.
out="$(act)"
check_eq "a repeat failure inside the backoff window holds" "$out" "rc=2"
check_eq "backoff does not spend budget" "$(bounded_retry_count "$STATE_DIR" "$bucket")" "1"

# ── Exhaustion: budget spent → retire a challenge arm or needs-user ─────
# Fill the shared bucket to its ceiling (WAVEMILL_STAGE_FAILURE_MAX_ATTEMPTS=3).
bounded_retry_increment "$STATE_DIR" "$bucket" "current-head" >/dev/null
bounded_retry_increment "$STATE_DIR" "$bucket" "current-head" >/dev/null
bounded_retry_increment "$STATE_DIR" "$bucket" "current-head" >/dev/null
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_READY_BASE_SECONDS=0
out="$(act)"
check_eq "the spent budget escalates" "$out" "rc=1"
check_contains "the escalation records the exhaustion reason on the attention record" "$(cat "$ATTENTION_LOG")" "unknown-failure-after-retries:ready"
check_eq "the exhausted sentinel is written" "$(bounded_retry_is_exhausted "$STATE_DIR" "$bucket" && echo yes || echo no)" "yes"

# A challenge arm with a green sibling is retired instead of held.
rm -f "$STATE_DIR/.retry-$bucket-exhausted"*
TERMINALIZE_RC=0
out="$(act)"
check_eq "an exhausted challenge arm is retired" "$out" "rc=0"
check_contains "the retirement names the exhausted cause" "$(cat "$TERMINALIZE_CALLS_FILE")" "HOK-3371"
TERMINALIZE_RC=1
unset WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_READY_BASE_SECONDS

# ── Terminal: the allowlist cause retires a challenge arm ───────────────
FAILURE_POLICY_DECISION='{"class":"terminal","failureKind":"ready-exhausted","terminalCode":"ready-exhausted","retryBucket":"stage-failure-ready","attribution":"unattributed","nextAction":"the arm was retired","rationale":"allowlisted terminal cause"}'
write_failed_result '{"stage":"ready","status":"failed","agent":"claude","artifacts":{"verdict":"fail"}}'
TERMINALIZE_RC=0
out="$(act)"
check_eq "a terminal cause retires the challenge arm" "$out" "rc=0"
TERMINALIZE_RC=1
out="$(act)"
check_eq "a terminal cause on a non-retirable arm holds at needs-user" "$out" "rc=1"
FAILURE_POLICY_DECISION=""

# ── Typed relaunch holds (launcher rc 3..6) are handled, not failures ───
rm -f "$STATE_DIR/.retry-$bucket-exhausted"*
bounded_retry_clear "$STATE_DIR" "$bucket"
READY_LAUNCH_RC=5
out="$(act)"
check_eq "a typed launcher hold is handled" "$out" "rc=0"
READY_LAUNCH_RC=0

echo ""
# ── The HOK-3361 replay fixture produces the exact exit shape the typed
# envelope consumes: exit 1 + the incident stderr on the first call, exit 0
# (delegated) on the recovery call. Scratch state only, never tracked paths.
echo "=== HOK-3361 replay fixture ==="
FIXTURE="$REPO_DIR/tests/journeys/fixtures/ready-fail-remediate/fake-stamp-pr-route.sh"
FIXTURE_TMP="$(mktemp -d)"
FAKE_STAMP_CALLS_FILE="$FIXTURE_TMP/calls" \
FAKE_STAMP_REAL_TOOL="$FIXTURE_TMP/recovery-tool" \
  bash "$FIXTURE" pr-arg --issue HOK-3371 > "$FIXTURE_TMP/first.out" 2> "$FIXTURE_TMP/first.err" \
  && first_rc=0 || first_rc=$?
if [[ "$first_rc" -eq 1 ]] && grep -q "$HOK_3361_DETAIL" "$FIXTURE_TMP/first.err" && [[ ! -s "$FIXTURE_TMP/first.out" ]]; then
  pass "fixture first call fails with the incident message on stderr"
else
  fail "fixture first call shape (rc=$first_rc)"
fi
printf '#!/usr/bin/env bash\nprintf %s\n' "'recovered'" > "$FIXTURE_TMP/recovery-tool"
chmod +x "$FIXTURE_TMP/recovery-tool"
FAKE_STAMP_CALLS_FILE="$FIXTURE_TMP/calls" \
FAKE_STAMP_REAL_TOOL="$FIXTURE_TMP/recovery-tool" \
  bash "$FIXTURE" pr-arg --issue HOK-3371 > "$FIXTURE_TMP/second.out" 2> "$FIXTURE_TMP/second.err" \
  && second_rc=0 || second_rc=$?
if [[ "$second_rc" -eq 0 ]] && [[ "$(cat "$FIXTURE_TMP/second.out")" == "recovered" ]]; then
  pass "fixture recovery call delegates with exit 0"
else
  fail "fixture recovery call shape (rc=$second_rc)"
fi
rm -rf "$FIXTURE_TMP"

echo ""
echo "--- ready-failure-classify-and-act: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]