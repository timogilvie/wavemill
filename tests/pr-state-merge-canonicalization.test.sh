#!/usr/bin/env bash
# HOK-2904: canonical pr_state / validate_pr_merge coverage.
#
# Characterization record of the pre-change divergence this refactor removed.
#
#   pr_state
#   - shared/lib/wavemill-mill.sh (parent): unbounded
#     `gh pr view "$pr" --json state --jq .state`, returning an empty string
#     on command failure.
#   - shared/lib/wavemill-monitor.sh: API_TIMEOUT-bounded
#     `gh pr view "$pr" --json state --jq .state`, also returning an empty
#     string on command failure.
#
#   validate_pr_merge
#   - parent: fetched state, baseRefName, and unused statusCheckRollup through
#     pr_details; required state=MERGED and baseRefName=$BASE_BRANCH.
#   - monitor: fetched only state with API_TIMEOUT and accepted any MERGED PR,
#     regardless of base branch.
#
# The canonical copies live in shared/lib/wavemill-common.sh. pr_state returns
# exactly MERGED, CLOSED, OPEN, or UNKNOWN; UNKNOWN is the explicit GitHub
# unavailable/unreadable sentinel. validate_pr_merge is bounded, ignores CI
# after a confirmed merge, and fails closed unless the PR is MERGED into
# BASE_BRANCH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"
STARTUP_SCRIPT="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

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

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "    unexpected: $needle"
    fail "$name"
  else
    pass "$name"
  fi
}

extract_fn() {
  awk -v fn="$1" '
    $0 == fn "() {" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$COMMON_SCRIPT"
}

echo "=== PR State / Merge Validation Canonicalization (HOK-2904) ==="

# --- Structural guards -------------------------------------------------------

for fn in pr_state validate_pr_merge; do
  DEFINING_FILES=()
  for f in "$MILL_SCRIPT" "$MONITOR_SCRIPT" "$STARTUP_SCRIPT" "$COMMON_SCRIPT"; do
    if grep -qE "^${fn}\(\) \{" "$f"; then
      DEFINING_FILES+=("${f#$REPO_DIR/}")
    fi
  done
  check_eq "exactly one $fn definition exists, in wavemill-common.sh" \
    "shared/lib/wavemill-common.sh" "${DEFINING_FILES[*]:-none}"
done

for f in "$MILL_SCRIPT" "$MONITOR_SCRIPT" "$STARTUP_SCRIPT" "$COMMON_SCRIPT"; do
  if grep -qE '^pr_details\(\) \{' "$f"; then
    fail "pr_details definition remains in ${f#$REPO_DIR/}"
  fi
done
if (( FAIL == 0 )); then
  pass "dead parent-only pr_details helper is deleted"
fi

PR_STATE_BODY="$(extract_fn pr_state)"
VALIDATE_BODY="$(extract_fn validate_pr_merge)"
if [[ -z "$PR_STATE_BODY" || -z "$VALIDATE_BODY" ]]; then
  echo "Could not extract canonical helpers from wavemill-common.sh"
  exit 1
fi

check_contains "canonical pr_state uses API_TIMEOUT-bound gh lookup" \
  "$PR_STATE_BODY" '_with_timeout "$API_TIMEOUT" gh pr view "$pr" --json state --jq .state'
check_contains "canonical pr_state returns explicit UNKNOWN for uncertainty" \
  "$PR_STATE_BODY" "printf 'UNKNOWN"
check_contains "canonical validate_pr_merge fetches only state and base branch" \
  "$VALIDATE_BODY" '_with_timeout "$API_TIMEOUT" gh pr view "$pr" --json state,baseRefName'
check_contains "canonical validate_pr_merge checks the target base branch" \
  "$VALIDATE_BODY" '[[ "$base_branch" != "${BASE_BRANCH:-}" ]]'
check_not_contains "canonical validate_pr_merge does not read CI rollup" \
  "$VALIDATE_BODY" 'statusCheckRollup'

# --- Behavioral harness ------------------------------------------------------

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT
TEST_SESSION="pr-merge-validation-test-$$"

GH_STUB_DIR="$TEST_TMP/bin"
mkdir -p "$GH_STUB_DIR"
cat > "$GH_STUB_DIR/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${GH_CALL_LOG:-}" ]]; then
  printf '%s\n' "$*" >> "$GH_CALL_LOG"
fi

case "${GH_BEHAVIOR:-ok}" in
  fail)
    echo "simulated gh failure" >&2
    exit 42
    ;;
  empty)
    exit 0
    ;;
  sleep)
    sleep "${GH_SLEEP_SECONDS:-3}"
    exit 0
    ;;
esac

json_fields=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      json_fields="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$json_fields" == "state,baseRefName" ]]; then
  jq -cn --arg state "${GH_STATE:-OPEN}" --arg base "${GH_BASE:-auto/integration}" \
    '{state:$state, baseRefName:$base}'
else
  printf '%s\n' "${GH_STATE:-OPEN}"
fi
SH
chmod +x "$GH_STUB_DIR/gh"

run_common() {
  local body="$1"
  PATH="$GH_STUB_DIR:$PATH" REPO_DIR="$REPO_DIR" COMMON_SCRIPT="$COMMON_SCRIPT" bash -c '
    set -euo pipefail
    _with_timeout() {
      local seconds="$1"
      shift
      if command -v timeout >/dev/null 2>&1; then
        timeout "$seconds" "$@"
      elif command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$seconds" "$@"
      else
        perl -e "alarm shift; exec @ARGV" "$seconds" "$@"
      fi
    }
    source "$COMMON_SCRIPT"
    log() { local level="$1"; shift; printf "%s:%s\n" "$level" "$*" >> "${LOG_FILE:-/dev/null}"; }
    log_warn() { printf "WARN:%s\n" "$*" >> "${LOG_FILE:-/dev/null}"; }
    log_error() { printf "ERROR:%s\n" "$*" >> "${LOG_FILE:-/dev/null}"; }
    eval "$1"
  ' bash "$body"
}

run_pr_state() {
  (
    export "$@" API_TIMEOUT=1
    run_common 'pr_state 123'
  )
}

run_validate() {
  local pr="$1"
  shift
  local quoted_pr
  printf -v quoted_pr '%q' "$pr"
  (
    export SESSION="$TEST_SESSION" API_TIMEOUT=1 BASE_BRANCH=auto/integration
    export "$@"
    run_common '
    if validate_pr_merge '"$quoted_pr"'; then
      printf "rc=0\n"
    else
      printf "rc=%s\n" "$?"
    fi
  '
  )
}

check_eq "pr_state preserves MERGED" "MERGED" "$(run_pr_state GH_STATE=MERGED)"
check_eq "pr_state preserves CLOSED" "CLOSED" "$(run_pr_state GH_STATE=CLOSED)"
check_eq "pr_state preserves OPEN" "OPEN" "$(run_pr_state GH_STATE=OPEN)"
check_eq "pr_state maps gh failure to UNKNOWN" "UNKNOWN" "$(run_pr_state GH_BEHAVIOR=fail)"
check_eq "pr_state maps empty gh output to UNKNOWN" "UNKNOWN" "$(run_pr_state GH_BEHAVIOR=empty)"
check_eq "pr_state maps unexpected gh output to UNKNOWN" "UNKNOWN" "$(run_pr_state GH_STATE=DRAFT)"
check_eq "pr_state maps timeout to UNKNOWN" "UNKNOWN" "$(run_pr_state GH_BEHAVIOR=sleep GH_SLEEP_SECONDS=3)"

CALL_LOG="$TEST_TMP/calls.log"
: > "$CALL_LOG"
check_eq "validate_pr_merge rejects empty PR without calling gh" \
  "rc=1" "$(run_validate "" GH_CALL_LOG="$CALL_LOG")"
check_eq "empty PR did not call gh" "" "$(cat "$CALL_LOG")"

LOG_FILE="$TEST_TMP/validate.log"
: > "$LOG_FILE"
check_eq "validate_pr_merge accepts MERGED into BASE_BRANCH" \
  "rc=0" "$(run_validate 123 LOG_FILE="$LOG_FILE" GH_STATE=MERGED GH_BASE=auto/integration)"
check_eq "merged success emits no log" "" "$(cat "$LOG_FILE")"

: > "$LOG_FILE"
check_eq "validate_pr_merge rejects wrong-base merge" \
  "rc=1" "$(run_validate 123 LOG_FILE="$LOG_FILE" GH_STATE=MERGED GH_BASE=main)"
check_contains "wrong-base merge logs error" "$(cat "$LOG_FILE")" "wrong base"

: > "$LOG_FILE"
check_eq "validate_pr_merge rejects CLOSED" \
  "rc=1" "$(run_validate 123 LOG_FILE="$LOG_FILE" GH_STATE=CLOSED GH_BASE=auto/integration)"
check_contains "CLOSED merge validation logs not MERGED" "$(cat "$LOG_FILE")" "not MERGED"

: > "$LOG_FILE"
check_eq "validate_pr_merge rejects OPEN" \
  "rc=1" "$(run_validate 123 LOG_FILE="$LOG_FILE" GH_STATE=OPEN GH_BASE=auto/integration)"
check_contains "OPEN merge validation logs not MERGED" "$(cat "$LOG_FILE")" "not MERGED"

: > "$LOG_FILE"
WARNING_SESSION="pr-merge-warning-test-$$"
WARNING_SENTINEL="/tmp/wavemill-${WARNING_SESSION}-hook-warnings.txt"
rm -f "$WARNING_SENTINEL"
SESSION="$WARNING_SESSION" LOG_FILE="$LOG_FILE" GH_STATE=OPEN GH_BASE=auto/integration \
  API_TIMEOUT=1 BASE_BRANCH=auto/integration run_common '
    validate_pr_merge 123 || true
    validate_pr_merge 123 || true
  '
rm -f "$WARNING_SENTINEL"
check_eq "repeated OPEN merge validation logs once per session" \
  "1" "$(wc -l < "$LOG_FILE" | tr -d ' ')"

: > "$LOG_FILE"
check_eq "validate_pr_merge rejects gh failure" \
  "rc=1" "$(run_validate 123 LOG_FILE="$LOG_FILE" GH_BEHAVIOR=fail)"
check_contains "gh failure logs fetch error" "$(cat "$LOG_FILE")" "Failed to fetch PR #123 details"

: > "$LOG_FILE"
check_eq "validate_pr_merge rejects timeout" \
  "rc=1" "$(run_validate 123 LOG_FILE="$LOG_FILE" GH_BEHAVIOR=sleep GH_SLEEP_SECONDS=3)"
check_contains "timeout logs fetch error" "$(cat "$LOG_FILE")" "Failed to fetch PR #123 details"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi

echo "pr-state-merge-canonicalization: ok"
