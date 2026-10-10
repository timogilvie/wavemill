#!/usr/bin/env bash
# Regression tests for typed coding launch refusals (HOK-3142).
#
# HOK-3138 sat at .plan-approved for 2.5h: the routed coder was refused at
# launch (uncertified / missing_live_canary) and the monitor re-derived the
# identical refused launch every tick, logging it as `[info] warn ⚠ …`.
#
# Covers:
#   - a deterministic refusal re-routes the coder (tools/reroute-refused-coder.ts)
#     and logs a structured [launch-refusal] line at warn;
#   - no eligible coder → needs-user with an exhausted sentinel holding the
#     certify command, and the next tick neither resolves nor launches again;
#   - FORCE_MODEL / WAVEMILL_CODER_MODEL pins terminalize instead of rerouting;
#   - an implementation-stage challenger is quarantined, never re-routed;
#   - transient resolver failures back off and terminalize at the ceiling;
#   - the reroute budget is bounded;
#   - log "warn" writes `[warn] …` in both the monitor and mill loggers;
#   - agent_resolve_from_model's typed refusal fields.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
MILL_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-mill.sh"
ADAPTERS_SCRIPT_FILE="$REPO_DIR/shared/lib/agent-adapters.sh"

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
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

FUNC_FILE="$TEST_TMP/coding_launch_refusal.sh"
cat "$REPO_DIR/shared/lib/bounded-retry.sh" > "$FUNC_FILE"
for fn in phase_launch_head phase_launch_base coding_launch_refusal_limit coding_launch_refusal_is_transient \
  log_coding_launch_refusal coding_launch_refusal_hold coding_launch_refusal_clear \
  coding_launch_refusal_terminalize handle_coding_launch_refusal; do
  extract_function "$MONITOR_SCRIPT_FILE" "$fn" >> "$FUNC_FILE"
  if ! grep -q "^$fn() {" "$FUNC_FILE"; then
    echo "Could not extract $fn()"
    exit 1
  fi
done
extract_function "$ADAPTERS_SCRIPT_FILE" "_agent_resolve_capture_refusal" >> "$FUNC_FILE"

# shellcheck source=/dev/null
source "$FUNC_FILE"

SESSION="coding-launch-refusal-test"
TOOLS_DIR="$TEST_TMP/tools"
LIB_DIR="$TEST_TMP/no-lib" # no hooks dir: hook writes are skipped
export WAVEMILL_RETRY_BACKOFF_CODING_LAUNCH_RESOLVER_BASE_SECONDS=600

# --- stubs -------------------------------------------------------------------
GIT_HEAD="sha-aaa"
STUB_REROUTE_JSON=""
STUB_CHALLENGE_ROLE=""
STUB_VARIED_MODEL=""
STUB_CHALLENGE_ABORTED=""

reset_capture() {
  WRITE_STAGE_CALLS=""
  CLEAR_STAGE_CALLS=""
  SET_PHASE_TO=""
  ATTENTION_STATE=""
  LOG_OUTPUT=""
  : > "$REROUTE_LOG"
  TASK_META_WRITES=""
  CHALLENGE_ABORTS=""
  RESOLVE_CALLS=0
  LAUNCH_CALLS=0
}

git() {
  if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" ]]; then
    printf "%s\n" "$GIT_HEAD"
    return 0
  fi
  return 1
}
log() {
  local level="info"
  case "${1:-}" in error|warn|status|info|debug) level="$1"; shift ;; esac
  LOG_OUTPUT+="[$level] $*"$'\n'
}
log_warn() { LOG_OUTPUT+="[warn] $*"$'\n'; }
write_stage_result() { WRITE_STAGE_CALLS+="${2-}|${3-}|${5-}|${6-}"$'\n'; }
clear_stage_result() { CLEAR_STAGE_CALLS+="${2-}"$'\n'; }
set_task_phase() { SET_PHASE_TO="$2"; }
set_window_attention_state() { ATTENTION_STATE="$2"; }
task_state_mutate_existing() { TASK_META_WRITES+="$*"$'\n'; }
_challenge_side_for_issue() { printf '%s\n' "$STUB_CHALLENGE_ROLE"; }
challenge_varied_stage_model() { printf '%s' "$STUB_VARIED_MODEL"; }
get_task_meta() {
  case "$2" in
    challengeAborted) printf '%s' "$STUB_CHALLENGE_ABORTED" ;;
    *) printf '' ;;
  esac
}
challenge_abort_pair() { CHALLENGE_ABORTS+="$1|$6|${9-}"$'\n'; }
cleanup_quarantined_no_pr_challenge_arm() { return 0; }
# The handler runs the reroute tool inside $(...), so calls are recorded to a
# file rather than a shell variable.
REROUTE_LOG="$TEST_TMP/reroute-calls.log"
npx() {
  # npx tsx <tool> <args...>
  if [[ "${2:-}" == *"reroute-refused-coder.ts" ]]; then
    shift 2
    printf '%s\n' "$*" >> "$REROUTE_LOG"
    printf '%s\n' "$STUB_REROUTE_JSON"
    return 0
  fi
  return 1
}
# HOK-3190: the monitor now routes tool spawns through `wavemill_run_tool`
# (fast-strip wrapper). This test extracts handle_coding_launch_refusal
# standalone, so provide a minimal shim that forwards to the `npx` stub.
wavemill_run_tool() {
  local tool="$1"; shift
  npx tsx "$tool" "$@"
}
reroute_calls() { grep -c . "$REROUTE_LOG" || true; }
reroute_args() { tail -n 1 "$REROUTE_LOG"; }

UNCERTIFIED_DIAG='[agent-resolution] model=gemini-2.5-pro phase=coding provider=openrouter reason=uncertified certification=missing_live_canary certify="npx tsx tools/native-agent-certify.ts --provider openrouter --model gemini-2.5-pro --phase patch --live-coding-canary"'
CERTIFY_CMD='npx tsx tools/native-agent-certify.ts --provider openrouter --model gemini-2.5-pro --phase patch --live-coding-canary'

# Simulates agent_resolve_from_model refusing the coder, run in this shell so
# the typed fields reach the handler (as the monitor now does).
STUB_RESOLVE_DIAG="$UNCERTIFIED_DIAG"
agent_resolve_from_model() {
  RESOLVE_CALLS=$((RESOLVE_CALLS + 1))
  AGENT_RESOLVE_LAST_DIAGNOSTIC="$STUB_RESOLVE_DIAG"
  _agent_resolve_capture_refusal "" "$AGENT_RESOLVE_LAST_DIAGNOSTIC"
  return 1
}

# Mirrors the monitor's .plan-approved coding-launch sequence: the refusal
# hold, then resolution, then the typed-refusal handler (or a launch).
simulate_tick() {
  local issue="$1" feature_dir="$2" model="${3:-gemini-2.5-pro}"
  if coding_launch_refusal_hold "$issue" "$feature_dir" "@1"; then
    echo "hold"
    return 0
  fi
  if agent_resolve_from_model "$model" "coding" >/dev/null 2>&1; then
    LAUNCH_CALLS=$((LAUNCH_CALLS + 1))
    coding_launch_refusal_clear "$feature_dir"
    echo "launched"
    return 0
  fi
  handle_coding_launch_refusal "$issue" "$feature_dir" "@1" "$model" "$model"
  echo "refused"
}

fresh_feature_dir() {
  local dir="$TEST_TMP/$1/wt/features/slug"
  mkdir -p "$dir"
  echo "$dir"
}

echo "=== deterministic refusal re-routes the coder ==="
reset_capture
FEATURE_DIR="$(fresh_feature_dir reroute)"
STUB_REROUTE_JSON='{"status":"rerouted","from":"gemini-2.5-pro","to":"claude-sonnet-5","agent":"claude","source":"router","reason":"uncertified","certification":"missing_live_canary","excluded":["gemini-2.5-pro"]}'
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
check_eq "reroute tool runs once" "$(reroute_calls)" "1"
check_contains "reroute passes the refused model" "$(reroute_args)" "--model gemini-2.5-pro"
check_contains "reroute passes the typed reason" "$(reroute_args)" "--reason uncertified"
check_contains "reroute passes the certification" "$(reroute_args)" "--certification missing_live_canary"
check_contains "reroute passes the certify command" "$(reroute_args)" "--certify $CERTIFY_CMD"
check_eq "task reverts to planning for the next tick" "$SET_PHASE_TO" "planning"
check_eq "attention is cleared after a substitution" "$ATTENTION_STATE" "clear"
check_eq "reroute counts against the refused bucket" "$(bounded_retry_count "$FEATURE_DIR" coding-launch-refused)" "1"
check_contains "coderModel task meta follows the substitute" "$TASK_META_WRITES" "claude-sonnet-5"
check_contains "failed coding result is cleared after reroute" "$CLEAR_STAGE_CALLS" "coding"
check_contains "structured refusal line is logged at warn" "$LOG_OUTPUT" "[warn] [launch-refusal] issue=HOK-3138 phase=coding model=gemini-2.5-pro provider=openrouter reason=uncertified certification=missing_live_canary action=rerouted substitute=claude-sonnet-5"
check_contains "substitution status line" "$LOG_OUTPUT" "coder substitution: gemini-2.5-pro → claude-sonnet-5"
check_not_contains "never logged as [info] warn" "$LOG_OUTPUT" "[info] warn"
if bounded_retry_is_exhausted "$FEATURE_DIR" coding-launch-refused; then
  fail "a successful reroute does not terminalize"
else
  pass "a successful reroute does not terminalize"
fi

reset_capture
STUB_RESOLVE_DIAG=""
agent_resolve_from_model() { RESOLVE_CALLS=$((RESOLVE_CALLS + 1)); echo claude; return 0; }
check_eq "next tick launches the substitute" "$(simulate_tick "HOK-3138" "$FEATURE_DIR" claude-sonnet-5)" "launched"
simulate_tick "HOK-3138" "$FEATURE_DIR" claude-sonnet-5 >/dev/null
check_eq "successful launch clears the refused bucket" "$(bounded_retry_count "$FEATURE_DIR" coding-launch-refused)" "0"
agent_resolve_from_model() {
  RESOLVE_CALLS=$((RESOLVE_CALLS + 1))
  AGENT_RESOLVE_LAST_DIAGNOSTIC="$STUB_RESOLVE_DIAG"
  _agent_resolve_capture_refusal "" "$AGENT_RESOLVE_LAST_DIAGNOSTIC"
  return 1
}
STUB_RESOLVE_DIAG="$UNCERTIFIED_DIAG"

echo "=== no eligible coder → needs-user, exhausted sentinel, no timer relaunch ==="
reset_capture
FEATURE_DIR="$(fresh_feature_dir no_eligible)"
STUB_REROUTE_JSON='{"status":"no-eligible","from":"gemini-2.5-pro","reason":"uncertified","certification":"missing_live_canary","excluded":["gemini-2.5-pro"]}'
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
if bounded_retry_is_exhausted "$FEATURE_DIR" coding-launch-refused; then
  pass "no-eligible writes the exhausted sentinel"
else
  fail "no-eligible writes the exhausted sentinel"
fi
SENTINEL_REASON="$(bounded_retry_exhaustion_reason "$FEATURE_DIR" coding-launch-refused)"
check_contains "sentinel records the certify command" "$SENTINEL_REASON" "certify=\"$CERTIFY_CMD\""
check_contains "sentinel records the model and certification" "$SENTINEL_REASON" "model=gemini-2.5-pro reason=uncertified certification=missing_live_canary"
check_contains "sentinel names why" "$SENTINEL_REASON" "no launchable coder remains"
check_eq "task parks at needs-user" "$ATTENTION_STATE" "needs-user"
check_eq "task is not aborted (certifying is the fix)" "$SET_PHASE_TO" "planning"
check_contains "needs-user refusal line at warn with certify" "$LOG_OUTPUT" "action=needs-user certify=\"$CERTIFY_CMD\""

resolve_calls_before="$RESOLVE_CALLS"
reroute_calls_before="$(reroute_calls)"
LOG_OUTPUT=""
check_eq "second tick holds" "$(simulate_tick "HOK-3138" "$FEATURE_DIR")" "hold"
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
check_eq "held ticks never call the resolver" "$RESOLVE_CALLS" "$resolve_calls_before"
check_eq "held ticks never call the reroute tool" "$(reroute_calls)" "$reroute_calls_before"
check_eq "held ticks never launch" "$LAUNCH_CALLS" "0"
check_eq "held ticks are quiet" "$LOG_OUTPUT" ""

GIT_HEAD="sha-bbb"
check_eq "a new head releases the hold" "$(simulate_tick "HOK-3138" "$FEATURE_DIR")" "refused"
GIT_HEAD="sha-aaa"

echo "=== pinned coder terminalizes instead of rerouting ==="
for pin in FORCE_MODEL WAVEMILL_CODER_MODEL; do
  reset_capture
  FEATURE_DIR="$(fresh_feature_dir "pinned_$pin")"
  export "$pin"=gemini-2.5-pro
  simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
  unset "$pin"
  check_eq "$pin: reroute tool is not called" "$(reroute_calls)" "0"
  check_contains "$pin: sentinel names the pin" "$(bounded_retry_exhaustion_reason "$FEATURE_DIR" coding-launch-refused)" "coder pinned by operator"
  check_eq "$pin: refusal does not consume the budget" "$(bounded_retry_count "$FEATURE_DIR" coding-launch-refused)" "0"
done

echo "=== implementation-stage challenger is quarantined, not re-routed ==="
reset_capture
FEATURE_DIR="$(fresh_feature_dir challenger)"
STUB_CHALLENGE_ROLE="challenger"
STUB_VARIED_MODEL="gemini-2.5-pro"
simulate_tick "HOK-3138_c" "$FEATURE_DIR" >/dev/null
check_eq "challenger: reroute tool is not called" "$(reroute_calls)" "0"
check_contains "challenger: arm aborted with single scope" "$CHALLENGE_ABORTS" "HOK-3138_c|varied_model_unlaunchable|single"
if bounded_retry_is_exhausted "$FEATURE_DIR" coding-launch-refused; then
  pass "challenger: sentinel holds the arm"
else
  fail "challenger: sentinel holds the arm"
fi
reset_capture
FEATURE_DIR="$(fresh_feature_dir challenger_primary)"
STUB_CHALLENGE_ROLE="primary"
STUB_REROUTE_JSON='{"status":"rerouted","to":"claude-sonnet-5"}'
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
check_eq "primary of a challenge is re-routed normally" "$(reroute_calls)" "1"
check_eq "primary is never challenge-aborted" "$CHALLENGE_ABORTS" ""
STUB_CHALLENGE_ROLE=""
STUB_VARIED_MODEL=""

echo "=== reroute budget is bounded ==="
reset_capture
FEATURE_DIR="$(fresh_feature_dir budget)"
export WAVEMILL_CODING_LAUNCH_REFUSAL_MAX_ATTEMPTS=2
STUB_REROUTE_JSON='{"status":"rerouted","to":"another-uncertified-model"}'
for _ in 1 2 3 4 5; do simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null; done
check_eq "only the budgeted reroutes run" "$(reroute_calls)" "2"
check_contains "budget exhaustion is recorded" "$(bounded_retry_exhaustion_reason "$FEATURE_DIR" coding-launch-refused)" "coder reroute budget of 2 exhausted"
unset WAVEMILL_CODING_LAUNCH_REFUSAL_MAX_ATTEMPTS

echo "=== reroute tool failure terminalizes ==="
reset_capture
FEATURE_DIR="$(fresh_feature_dir tool_failure)"
STUB_REROUTE_JSON=''
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
check_contains "tool failure is recorded" "$(bounded_retry_exhaustion_reason "$FEATURE_DIR" coding-launch-refused)" "coder reroute failed"

echo "=== transient resolver failure backs off and is bounded ==="
reset_capture
FEATURE_DIR="$(fresh_feature_dir transient)"
STUB_RESOLVE_DIAG='[agent-resolution] model=gemini-2.5-pro phase=coding provider=unknown reason=unknown-model certification=resolver-failed certify="unavailable"'
export WAVEMILL_CODING_LAUNCH_REFUSAL_MAX_ATTEMPTS=1
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
check_eq "transient: no reroute" "$(reroute_calls)" "0"
check_eq "transient: counted against the resolver bucket" "$(bounded_retry_count "$FEATURE_DIR" coding-launch-resolver)" "1"
check_contains "transient: logged as a retry" "$LOG_OUTPUT" "action=retry"
check_eq "transient: next tick backs off" "$(simulate_tick "HOK-3138" "$FEATURE_DIR")" "hold"
# Expire the backoff window.
printf '%s\n' "$(( $(date +%s) - 100000 ))" > "$FEATURE_DIR/.retry-coding-launch-resolver-last-at"
simulate_tick "HOK-3138" "$FEATURE_DIR" >/dev/null
if bounded_retry_is_exhausted "$FEATURE_DIR" coding-launch-resolver; then
  pass "transient: terminalizes past the ceiling"
else
  fail "transient: terminalizes past the ceiling"
fi
check_eq "transient: then holds quietly" "$(simulate_tick "HOK-3138" "$FEATURE_DIR")" "hold"
unset WAVEMILL_CODING_LAUNCH_REFUSAL_MAX_ATTEMPTS
STUB_RESOLVE_DIAG="$UNCERTIFIED_DIAG"

echo "=== refusal classification ==="
for reason in uncertified no-native-capability lifecycle-blocked role-ineligible unknown-model; do
  if coding_launch_refusal_is_transient "$reason" "missing_live_canary"; then
    fail "$reason is deterministic"
  else
    pass "$reason is deterministic"
  fi
done
for cert in missing-tsx missing-jq mktemp-failed resolver-failed malformed-json; do
  if coding_launch_refusal_is_transient "unknown-model" "$cert"; then
    pass "$cert is transient"
  else
    fail "$cert is transient"
  fi
done
if coding_launch_refusal_is_transient "invalid-model-id" "invalid-model-id"; then
  pass "invalid-model-id is retried, not rerouted"
else
  fail "invalid-model-id is retried, not rerouted"
fi

echo "=== agent_resolve_from_model typed refusal fields ==="
_agent_resolve_capture_refusal '{"ok":false,"reason":"uncertified","certificationStatus":"stale_live_canary","certifyCommand":"cmd --live-coding-canary","diagnostic":"x"}' "$UNCERTIFIED_DIAG"
check_eq "JSON reason wins" "$AGENT_RESOLVE_LAST_REASON" "uncertified"
check_eq "JSON certification wins" "$AGENT_RESOLVE_LAST_CERTIFICATION" "stale_live_canary"
check_eq "JSON certify wins" "$AGENT_RESOLVE_LAST_CERTIFY" "cmd --live-coding-canary"
_agent_resolve_capture_refusal "" "$UNCERTIFIED_DIAG"
check_eq "diagnostic fallback certification" "$AGENT_RESOLVE_LAST_CERTIFICATION" "missing_live_canary"
check_eq "diagnostic fallback certify" "$AGENT_RESOLVE_LAST_CERTIFY" "$CERTIFY_CMD"
_agent_resolve_capture_refusal "" '[agent-resolution] model=x phase=coding provider=unknown reason=invalid-model-id certification=missing-tsx certify="unavailable"'
check_eq "unavailable certify is empty" "$AGENT_RESOLVE_LAST_CERTIFY" ""

echo "=== monitor poll branch wiring ==="
POLL_BRANCH="$(awk '/coding_launch_refusal_hold "\$ISSUE"/,/coding_launch_refusal_clear "\$FEATURE_DIR"/' "$MONITOR_SCRIPT_FILE")"
check_contains "hold runs before resolution" "$POLL_BRANCH" 'agent_resolve_from_model "$coder_launch_model" "coding" >"$coder_resolve_out"'
check_contains "refusals route through the typed handler" "$POLL_BRANCH" 'handle_coding_launch_refusal "$ISSUE" "$FEATURE_DIR" "$WIN" "$coder_model" "$coder_launch_model"'
check_not_contains "resolver is not captured in a subshell" "$POLL_BRANCH" 'coder_agent="$(agent_resolve_from_model'

echo "=== log \"warn\" writes [warn] (monitor and mill loggers) ==="
for script in "$MONITOR_SCRIPT_FILE" "$MILL_SCRIPT_FILE"; do
  LOGGER_FILE="$TEST_TMP/logger-$(basename "$script").sh"
  {
    extract_function "$script" "_log_level_num"
    extract_function "$script" "append_status_log"
    extract_function "$script" "log"
  } > "$LOGGER_FILE"
  out="$(
    unset -f log
    # shellcheck source=/dev/null
    source "$LOGGER_FILE"
    MILL_LOG_FILE="$TEST_TMP/mill-$(basename "$script").log"
    STATUS_LOG_FILE="$TEST_TMP/status-$(basename "$script").log"
    DASHBOARD_LOG_TO_FILE=true
    VERBOSITY_NUM="$(_log_level_num status)"
    : > "$MILL_LOG_FILE"; : > "$STATUS_LOG_FILE"
    log "warn" "⚠ refusal"
    printf '%s|%s|%s' "$(cat "$MILL_LOG_FILE")" "$(cat "$STATUS_LOG_FILE")" "$(_log_level_num warn)"
  )"
  name="$(basename "$script")"
  check_contains "$name: mill log level is warn" "$out" "[warn] ⚠ refusal"
  check_not_contains "$name: never [info] warn" "$out" "[info] warn"
  check_contains "$name: warn is visible at status verbosity" "$out" "  ⚠ refusal|"
  check_eq "$name: warn shares status' level" "${out##*|}" "1"
done

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
