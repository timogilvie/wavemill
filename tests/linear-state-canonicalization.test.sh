#!/usr/bin/env bash
# HOK-2901: canonical linear_set_state / linear_is_completed coverage.
#
# Characterization record of the pre-change divergence this refactor removed.
# The parent mill and the extracted monitor each carried private copies:
#
#   linear_set_state
#   - shared/lib/wavemill-mill.sh (parent): went through the generic `retry`
#     helper — up to MAX_RETRIES attempts, each capped at RETRY_TIMEOUT, plus
#     exponential backoff sleeps (roughly 90 s of blocking wall-clock) — with
#     stdout and stderr both discarded, so a failure logged only
#     "Failed to set X → Y in Linear" with no exit code or tool output.
#   - shared/lib/wavemill-monitor.sh: one attempt bounded by API_TIMEOUT,
#     stderr captured to a temp file, exit code and last stderr line logged,
#     always returned 0 (non-fatal under set -e). No DRY_RUN handling. Its
#     `rc=$?` ran after the `if ...; fi` and so captured the if-statement's
#     status, meaning every failure was logged as "(exit 0)".
#
#   linear_is_completed
#   - parent: asked get-issue-state.ts, which derives `completed` from Linear's
#     completedAt/canceledAt timestamps; timeout was RETRY_TIMEOUT.
#   - monitor: asked get-issue.ts --json and matched .state.name against the
#     literal list Done/Completed/Canceled, so a workspace whose terminal state
#     is renamed (or spelled "Cancelled") was never seen as complete; timeout
#     was API_TIMEOUT.
#
# The canonical copies live in shared/lib/wavemill-common.sh and adopt the
# monitor's writer semantics (single attempt, API_TIMEOUT wall-clock cap,
# stderr/exit-code diagnostics, always non-fatal, DRY_RUN honoured) and the
# parent's completion probe (get-issue-state.ts). Uncertainty policy: any
# lookup failure or timeout in linear_is_completed returns non-zero, i.e.
# "not completed", so callers never auto-clean a worktree on a false positive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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
    echo "    in:      $haystack"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    echo "    in:         $haystack"
    fail "$name"
  fi
}

echo "=== linear_set_state / linear_is_completed Canonicalization (HOK-2901) ==="

# --- Structural guards -------------------------------------------------------

# The startup runner keeps its intentional batch-scope linear_set_state stub
# (its live writes flow through linear_batch_set_state); HOK-2901 scope is the
# parent mill and the monitor, so only those two must have lost their copies.
for fn in linear_set_state linear_is_completed; do
  for f in wavemill-mill.sh wavemill-monitor.sh; do
    if grep -qE "^${fn}\(\) \{" "$REPO_DIR/shared/lib/$f"; then
      fail "$f still defines a private $fn"
    else
      pass "$f no longer defines a private $fn"
    fi
  done
  if grep -qE "^${fn}\(\) \{" "$REPO_DIR/shared/lib/wavemill-common.sh"; then
    pass "wavemill-common.sh defines canonical $fn"
  else
    fail "wavemill-common.sh is missing canonical $fn"
  fi
done

IS_COMPLETED_DEFINERS=()
for f in wavemill-mill.sh wavemill-startup-runner.sh wavemill-monitor.sh wavemill-common.sh; do
  if grep -qE '^linear_is_completed\(\) \{' "$REPO_DIR/shared/lib/$f"; then
    IS_COMPLETED_DEFINERS+=("shared/lib/$f")
  fi
done
check_eq "exactly one linear_is_completed definition exists, in wavemill-common.sh" \
  "shared/lib/wavemill-common.sh" "${IS_COMPLETED_DEFINERS[*]:-none}"

extract_fn() {
  awk -v fn="$1" '
    $0 == fn "() {" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$REPO_DIR/shared/lib/wavemill-common.sh"
}

SET_STATE_BODY="$(extract_fn linear_set_state)"
IS_COMPLETED_BODY="$(extract_fn linear_is_completed)"
if [[ -z "$SET_STATE_BODY" || -z "$IS_COMPLETED_BODY" ]]; then
  echo "Could not extract canonical helpers from wavemill-common.sh"
  exit 1
fi

check_contains "canonical writer is bounded by API_TIMEOUT" \
  "$SET_STATE_BODY" '_with_timeout "$API_TIMEOUT" wavemill_run_tool "set-issue-state.ts"'
check_not_contains "canonical writer does not go through the retry ladder" \
  "$SET_STATE_BODY" 'retry npx'
check_not_contains "canonical writer never returns 1 (would exit callers under set -e)" \
  "$SET_STATE_BODY" 'return 1'
check_contains "canonical writer surfaces the exit code" \
  "$SET_STATE_BODY" '(exit $rc)'
check_contains "canonical probe uses get-issue-state.ts" \
  "$IS_COMPLETED_BODY" '_with_timeout "$API_TIMEOUT" wavemill_run_tool "get-issue-state.ts"'
check_not_contains "canonical probe no longer matches display state names" \
  "$IS_COMPLETED_BODY" 'state.name'
check_contains "API_TIMEOUT default is provided by wavemill-common.sh" \
  "$(grep -E '^API_TIMEOUT=' "$REPO_DIR/shared/lib/wavemill-common.sh")" 'API_TIMEOUT="${API_TIMEOUT:-30}"'

# --- Behavioral coverage -----------------------------------------------------

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FIXTURE_BIN="$TEST_TMP/bin"
FIXTURE_TOOLS="$TEST_TMP/tools"
mkdir -p "$FIXTURE_BIN" "$FIXTURE_TOOLS"

# The helpers invoke `npx tsx "$TOOLS_DIR/<tool>.ts"`. A fake npx on PATH
# drops the `tsx` argument and runs the .ts fixture path as a bash script.
cat > "$FIXTURE_BIN/npx" <<'SH'
#!/usr/bin/env bash
shift
exec bash "$@"
SH
chmod +x "$FIXTURE_BIN/npx"

# Mock behaviour is driven by MOCK_* variables so each case can set the exit
# code, stdout, stderr, and an optional hang. Every invocation is appended to
# MOCK_CALL_LOG so DRY_RUN can prove the tool was never reached.
cat > "$FIXTURE_TOOLS/set-issue-state.ts" <<'SH'
printf 'set-issue-state %s\n' "$*" >> "$MOCK_CALL_LOG"
if [[ -n "${MOCK_SLEEP:-}" ]]; then exec sleep "$MOCK_SLEEP"; fi
[[ -n "${MOCK_STDERR:-}" ]] && printf '%s\n' "$MOCK_STDERR" >&2
exit "${MOCK_RC:-0}"
SH
cat > "$FIXTURE_TOOLS/get-issue-state.ts" <<'SH'
printf 'get-issue-state %s\n' "$*" >> "$MOCK_CALL_LOG"
if [[ -n "${MOCK_SLEEP:-}" ]]; then exec sleep "$MOCK_SLEEP"; fi
[[ -n "${MOCK_STDOUT+x}" ]] && printf '%s\n' "$MOCK_STDOUT"
exit "${MOCK_RC:-0}"
SH

# _with_timeout is inherited from shared/lib/wavemill-common.sh; exercise the
# helpers against the canonical implementation rather than a stub.
if ! grep -q '^_with_timeout() {' "$REPO_DIR/shared/lib/wavemill-common.sh"; then
  echo "Could not find _with_timeout in wavemill-common.sh"
  exit 1
fi

# run_case <name> <shell snippet>
# Runs the snippet in a fresh `set -euo pipefail` bash with the canonical
# helpers sourced, a fake npx on PATH, and log/log_warn sinks. The snippet's
# stdout is returned; `case_log <name> warn|info|calls` reads the side effects.
run_case() {
  local name="$1" snippet="$2"
  local case_dir="$TEST_TMP/$name"
  mkdir -p "$case_dir"
  : > "$case_dir/warn.log"
  : > "$case_dir/info.log"
  : > "$case_dir/calls.log"
  # HOK-3190: force the npx tsx path so the fixture's fake npx on PATH is hit.
  # The default fast-strip path shells out to `node --experimental-strip-types`
  # instead, which this test's mock does not intercept.
  PATH="$FIXTURE_BIN:$PATH" TOOLS_DIR="$FIXTURE_TOOLS" REPO_DIR="$REPO_DIR" \
  STATE_FILE="$case_dir/state.json" WAVEMILL_SKIP_FAST_STRIP=1 \
  WARN_LOG="$case_dir/warn.log" INFO_LOG="$case_dir/info.log" MOCK_CALL_LOG="$case_dir/calls.log" \
    bash -c '
      set -euo pipefail
      source "$REPO_DIR/shared/lib/wavemill-common.sh"
      log() { printf "%s\n" "$*" >> "$INFO_LOG"; }
      log_warn() { printf "%s\n" "$*" >> "$WARN_LOG"; }
      '"$snippet"'
    ' 2>"$case_dir/stderr.log"
}

case_log() { cat "$TEST_TMP/$1/$2.log"; }

# 1. DRY_RUN: the tool is never reached and the intent is logged.
OUT="$(DRY_RUN=true run_case dry_run 'linear_set_state HOK-2901 Done; echo "rc=$?"')"
check_eq "DRY_RUN linear_set_state returns 0" "rc=0" "$OUT"
check_eq "DRY_RUN linear_set_state never invokes set-issue-state.ts" "" "$(case_log dry_run calls)"
check_contains "DRY_RUN linear_set_state logs the intended transition" \
  "$(case_log dry_run info)" "[DRY-RUN] Would set HOK-2901 → Done"

# 2. Success: tool is called with issue and state, nothing is warned.
OUT="$(run_case success 'linear_set_state HOK-2901 "In Review"; echo "rc=$?"')"
check_eq "successful linear_set_state returns 0" "rc=0" "$OUT"
check_eq "successful linear_set_state passes issue and state to the tool" \
  "set-issue-state HOK-2901 In Review" "$(case_log success calls)"
check_eq "successful linear_set_state emits no warning" "" "$(case_log success warn)"

# 3. Non-fatal failure with stderr: exit code and last stderr line survive.
OUT="$(MOCK_RC=1 MOCK_STDERR=$'first line\nLinear API: 401 Unauthorized' \
  run_case failure_stderr 'linear_set_state HOK-2901 Done; echo "rc=$?"')"
check_eq "failed linear_set_state still returns 0" "rc=0" "$OUT"
WARN="$(case_log failure_stderr warn)"
check_contains "failure warning names the issue and target state" "$WARN" "HOK-2901 to Done"
check_contains "failure warning carries the exit code" "$WARN" "(exit 1)"
check_contains "failure warning carries the last stderr line" "$WARN" ": Linear API: 401 Unauthorized"
check_not_contains "failure warning keeps only the last stderr line" "$WARN" "first line"

# 4. Failure without stderr: exit code only, no dangling colon.
OUT="$(MOCK_RC=7 run_case failure_silent 'linear_set_state HOK-2901 Done; echo "rc=$?"')"
check_eq "silently failing linear_set_state returns 0" "rc=0" "$OUT"
WARN="$(case_log failure_silent warn)"
check_contains "silent failure warning still carries the exit code" "$WARN" "(exit 7)"
check_eq "silent failure warning has no stderr suffix" \
  "Failed to update Linear state for HOK-2901 to Done (exit 7)" "$WARN"

# 5. Non-fatal under set -e: a failing write must not abort the caller.
OUT="$(MOCK_RC=1 MOCK_STDERR="boom" run_case set_e_survival \
  'linear_set_state HOK-2901 Done; echo "continued"')"
check_eq "callers under set -e continue past a failed linear_set_state" "continued" "$OUT"

# 6. Wall-clock cap: a hanging tool is cut off at API_TIMEOUT and still non-fatal.
START=$(date +%s)
OUT="$(API_TIMEOUT=2 MOCK_SLEEP=60 run_case hang_write 'linear_set_state HOK-2901 Done; echo "rc=$?"')"
ELAPSED=$(( $(date +%s) - START ))
check_eq "hanging linear_set_state returns 0 after the cap" "rc=0" "$OUT"
if (( ELAPSED < 10 )); then
  pass "hanging linear_set_state is bounded by API_TIMEOUT (took ${ELAPSED}s)"
else
  fail "hanging linear_set_state exceeded API_TIMEOUT bound (took ${ELAPSED}s)"
fi
check_contains "timed-out linear_set_state logs an exit code" "$(case_log hang_write warn)" "(exit "

# 7. Retry policy: exactly one attempt per call, even on failure.
OUT="$(MOCK_RC=1 run_case single_attempt 'linear_set_state HOK-2901 Done; echo "rc=$?"')"
check_eq "failed linear_set_state is not retried in-loop" "1" "$(case_log single_attempt calls | wc -l | tr -d ' ')"

# 8. linear_is_completed: completed / active / failure / timeout / garbage.
OUT="$(MOCK_STDOUT=completed run_case completed 'if linear_is_completed HOK-2901; then echo yes; else echo no; fi')"
check_eq "linear_is_completed reports completed issues" "yes" "$OUT"
check_eq "linear_is_completed asks get-issue-state.ts for the issue" \
  "get-issue-state HOK-2901" "$(case_log completed calls)"

OUT="$(MOCK_STDOUT=active run_case active 'if linear_is_completed HOK-2901; then echo yes; else echo no; fi')"
check_eq "linear_is_completed reports active issues as not completed" "no" "$OUT"

OUT="$(MOCK_RC=1 run_case probe_failure 'if linear_is_completed HOK-2901; then echo yes; else echo no; fi; echo continued')"
check_eq "linear_is_completed treats a tool failure as not completed and stays non-fatal" \
  $'no\ncontinued' "$OUT"

START=$(date +%s)
OUT="$(API_TIMEOUT=2 MOCK_SLEEP=60 run_case probe_hang 'if linear_is_completed HOK-2901; then echo yes; else echo no; fi')"
ELAPSED=$(( $(date +%s) - START ))
check_eq "linear_is_completed treats a timeout as not completed" "no" "$OUT"
if (( ELAPSED < 10 )); then
  pass "hanging linear_is_completed is bounded by API_TIMEOUT (took ${ELAPSED}s)"
else
  fail "hanging linear_is_completed exceeded API_TIMEOUT bound (took ${ELAPSED}s)"
fi

OUT="$(MOCK_STDOUT="unknown" run_case probe_garbage 'if linear_is_completed HOK-2901; then echo yes; else echo no; fi')"
check_eq "linear_is_completed treats unexpected output as not completed" "no" "$OUT"

OUT="$(MOCK_STDOUT="" run_case probe_empty 'if linear_is_completed HOK-2901; then echo yes; else echo no; fi')"
check_eq "linear_is_completed treats empty output as not completed" "no" "$OUT"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
