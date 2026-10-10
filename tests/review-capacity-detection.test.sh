#!/usr/bin/env bash
# HOK-3146: review-phase capacity detection parity with coding.
#
# Verifies:
#  1. codex_capacity_* helpers accept a `stage` argument so review paths get
#     their own `.review-capacity-dwell.json` / `.review-capacity-recovery.json`
#     without clobbering coding markers.
#  2. write_codex_capacity_blocked_completion records `stage: "review"` and
#     `recommendedAction: "relaunch_review"` when called with stage="review".
#  3. handle_review_capacity_stop records the blocked-completion marker and
#     rotates the reviewer contract via the reroute tool (stubbed).
#  4. review_recovery_native_timeout_repeat identifies the deterministic
#     short-circuit case for two consecutive native-review-timeouts at the
#     same reviewHeadSha.

set -euo pipefail

# HOK-3190: wavemill_run_tool now prefers `node --experimental-strip-types` and
# only routes through `npx tsx` when it detects a shell-function `npx` or when
# WAVEMILL_SKIP_FAST_STRIP=1. This test stubs `npx` via PATH (handle_review_capacity_stop
# calls reroute-refused-reviewer.ts through wavemill_run_tool), so pin the npx
# tsx shape so the PATH stub keeps intercepting the launch.
export WAVEMILL_SKIP_FAST_STRIP=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
BOUNDED_RETRY="$REPO_DIR/shared/lib/bounded-retry.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT"
}

FUNCS_FILE="$TMP_DIR/review-capacity-functions.sh"
: > "$FUNCS_FILE"
for fn in \
  wavemill_capacity_stall_seconds \
  codex_capacity_recovery_marker \
  codex_capacity_dwell_marker \
  codex_capacity_clear_dwell_marker \
  codex_capacity_pane_tail \
  codex_capacity_tail_has_terminal_prompt \
  codex_capacity_hook_status \
  codex_capacity_record_dwell \
  codex_capacity_idle_confirmed \
  write_codex_capacity_blocked_completion \
  review_result_failure_category \
  review_result_review_head_sha \
  review_recovery_timeout_state_path \
  review_recovery_native_timeout_repeat \
  review_capacity_relaunch_limit \
  review_capacity_terminalize \
  review_capacity_release_window \
  handle_review_capacity_stop
do
  extract_function "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done

source "$COMMON_SCRIPT"
source "$BOUNDED_RETRY"
source "$FUNCS_FILE"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
assert_file_exists() {
  local label="$1" path="$2"
  if [[ -f "$path" ]]; then pass "$label"; else fail "$label (missing $path)"; fi
}
assert_file_absent() {
  local label="$1" path="$2"
  if [[ ! -f "$path" ]]; then pass "$label"; else fail "$label (unexpected $path)"; fi
}

SESSION="review-capacity-test-$$"
log() { :; }
log_warn() { :; }
log_error() { :; }
set_window_attention_state() { :; }
task_state_mutate_existing() { :; }
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3"
  mkdir -p "$feature_dir"
  printf '{"stage":"%s","status":"%s"}\n' "$stage" "$status" > "$feature_dir/.${stage}-result.json"
}
write_ready_attention_file() { printf '%s\n' "${2:-}" > "$1/.needs-attention"; }
_tmux_task_window_target() { return 1; }
phase_launch_head() { echo "abc1234"; }

echo "=== HOK-3146 Phase 1: stage-aware capacity markers ==="

FEATURE_DIR_A="$TMP_DIR/case-a/features/slug-a"
mkdir -p "$FEATURE_DIR_A"

assert_eq "coding dwell marker path" \
  "$FEATURE_DIR_A/.coding-capacity-dwell.json" \
  "$(codex_capacity_dwell_marker "$FEATURE_DIR_A")"
assert_eq "coding recovery marker path (default stage)" \
  "$FEATURE_DIR_A/.coding-capacity-recovery.json" \
  "$(codex_capacity_recovery_marker "$FEATURE_DIR_A")"
assert_eq "review dwell marker path" \
  "$FEATURE_DIR_A/.review-capacity-dwell.json" \
  "$(codex_capacity_dwell_marker "$FEATURE_DIR_A" "review")"
assert_eq "review recovery marker path" \
  "$FEATURE_DIR_A/.review-capacity-recovery.json" \
  "$(codex_capacity_recovery_marker "$FEATURE_DIR_A" "review")"

# dwell records are per-stage
codex_capacity_record_dwell "$FEATURE_DIR_A" "hook" "coding" >/dev/null
codex_capacity_record_dwell "$FEATURE_DIR_A" "pane" "review" >/dev/null
assert_file_exists "coding dwell written" "$FEATURE_DIR_A/.coding-capacity-dwell.json"
assert_file_exists "review dwell written" "$FEATURE_DIR_A/.review-capacity-dwell.json"
assert_eq "coding dwell source" "hook" \
  "$(jq -r '.source' "$FEATURE_DIR_A/.coding-capacity-dwell.json")"
assert_eq "review dwell source" "pane" \
  "$(jq -r '.source' "$FEATURE_DIR_A/.review-capacity-dwell.json")"

# clearing coding does not touch review
codex_capacity_clear_dwell_marker "$FEATURE_DIR_A" "coding"
assert_file_absent "coding dwell cleared" "$FEATURE_DIR_A/.coding-capacity-dwell.json"
assert_file_exists "review dwell preserved" "$FEATURE_DIR_A/.review-capacity-dwell.json"

echo ""
echo "=== HOK-3146 Phase 1: review-stage blocked completion ==="

FEATURE_DIR_B="$TMP_DIR/case-b/features/slug-b"
mkdir -p "$FEATURE_DIR_B"

write_codex_capacity_blocked_completion "HOK-3146-REV" "$FEATURE_DIR_B" "gpt-6-sol" "pane" "review"
assert_file_exists "review blocked-completion written" "$FEATURE_DIR_B/.review-blocked-completion.json"
assert_file_absent "coding blocked-completion NOT written" "$FEATURE_DIR_B/.coding-blocked-completion.json"
assert_file_exists "review recovery marker written" "$FEATURE_DIR_B/.review-capacity-recovery.json"
assert_eq "review artifact stage field" "review" \
  "$(jq -r '.stage' "$FEATURE_DIR_B/.review-blocked-completion.json")"
assert_eq "review artifact recommended action" "relaunch_review" \
  "$(jq -r '.recommendedAction' "$FEATURE_DIR_B/.review-blocked-completion.json")"
assert_eq "review artifact blocking reason" "model_at_capacity" \
  "$(jq -r '.blockingReason' "$FEATURE_DIR_B/.review-blocked-completion.json")"
assert_eq "review artifact model recorded" "gpt-6-sol" \
  "$(jq -r '.model' "$FEATURE_DIR_B/.review-blocked-completion.json")"
assert_eq "review recovery marker stage field" "review" \
  "$(jq -r '.stage' "$FEATURE_DIR_B/.review-capacity-recovery.json")"

echo ""
echo "=== HOK-3146 Phase 1: handle_review_capacity_stop reroutes contract ==="

FEATURE_DIR_C="$TMP_DIR/case-c/features/slug-c"
mkdir -p "$FEATURE_DIR_C"
WT_DIR_C="$TMP_DIR/case-c"
mkdir -p "$WT_DIR_C/.wavemill"

# Pretend the capacity dwell was already recorded (hook source).
jq -n '{source:"hook",firstSeen:1,lastSeen:1}' > "$FEATURE_DIR_C/.review-capacity-dwell.json"

# Stub the reroute tool to return a successful substitution without needing
# npx tsx + a model registry.
STUB_DIR="$TMP_DIR/case-c/stubs"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/npx" <<'EOF'
#!/usr/bin/env bash
# Only recognizes the reroute tool invocation shape.
for arg in "$@"; do
  case "$arg" in
    *reroute-refused-reviewer*)
      printf '{"status":"rerouted","from":"gpt-6-sol","to":"claude-opus-5-5","agent":"claude","source":"deterministic","reason":"model_at_capacity","excluded":["gpt-6-sol"]}'
      exit 0
      ;;
  esac
done
# default
exit 0
EOF
chmod +x "$STUB_DIR/npx"
export PATH="$STUB_DIR:$PATH"
# Simulate the tsx+tool arg structure that handle_review_capacity_stop uses.
REPO_DIR="$WT_DIR_C"
TOOLS_DIR="$REPO_DIR/tools"
mkdir -p "$TOOLS_DIR"
touch "$TOOLS_DIR/reroute-refused-reviewer.ts"

LIB_DIR="$REPO_DIR/shared/lib"
mkdir -p "$LIB_DIR/../hooks"

handle_review_capacity_stop "HOK-3146-REV" "slug-c" "$FEATURE_DIR_C" "$WT_DIR_C" "win" "gpt-6-sol"

assert_file_exists "handler wrote review blocked-completion" "$FEATURE_DIR_C/.review-blocked-completion.json"
assert_file_exists "handler wrote review recovery marker" "$FEATURE_DIR_C/.review-capacity-recovery.json"
assert_eq "handler wrote running stage result for relaunch" "running" \
  "$(jq -r '.status' "$FEATURE_DIR_C/.review-result.json")"

# Second invocation: recovery marker now present, so the handler should still
# be bounded by the retry gate — but since the marker is per-head/per-feature,
# the hook-side gate still allows new attempts up to the limit. What we assert
# here is that the retry bucket counter has been incremented.
assert_eq "review-capacity bucket count = 1 after first run" "1" \
  "$(bounded_retry_count "$FEATURE_DIR_C" "review-capacity")"

echo ""
echo "=== HOK-3146 Phase 1: review-capacity bucket exhaustion ==="

FEATURE_DIR_D="$TMP_DIR/case-d/features/slug-d"
mkdir -p "$FEATURE_DIR_D"
# Prime the bucket at the limit.
LIMIT="$(review_capacity_relaunch_limit)"
for ((i=0; i < LIMIT; i++)); do
  bounded_retry_increment "$FEATURE_DIR_D" "review-capacity" "abc1234" >/dev/null
done
WT_DIR_D="$TMP_DIR/case-d"
mkdir -p "$WT_DIR_D"
REPO_DIR="$WT_DIR_D"
TOOLS_DIR="$REPO_DIR/tools"
mkdir -p "$TOOLS_DIR"
touch "$TOOLS_DIR/reroute-refused-reviewer.ts"

handle_review_capacity_stop "HOK-3146-REV-D" "slug-d" "$FEATURE_DIR_D" "$WT_DIR_D" "win" "gpt-6-sol"
assert_file_exists "exhaustion writes bucket sentinel" \
  "$FEATURE_DIR_D/.retry-review-capacity-exhausted"

echo ""
echo "=== HOK-3146 Phase 4: deterministic repeat native-review-timeout ==="

FEATURE_DIR_E="$TMP_DIR/case-e/features/slug-e"
mkdir -p "$FEATURE_DIR_E"
# Case 1: no prior timeout state → no repeat
printf '{"status":"failed","artifacts":{"type":"review","failureCategory":"native-review-timeout","reviewHeadSha":"deadbee"}}\n' \
  > "$FEATURE_DIR_E/.review-result.json"
if review_recovery_native_timeout_repeat "$FEATURE_DIR_E"; then
  fail "no prior timeout state means not-a-repeat"
else
  pass "no prior timeout state means not-a-repeat"
fi

# Case 2: prior timeout at same head → repeat
jq -n --arg h "deadbee" \
  '{schemaVersion:1,category:"native-review-timeout",nativeTimeoutAttempt:1,reviewHeadSha:$h,recordedAt:"2026-01-01T00:00:00Z"}' \
  > "$FEATURE_DIR_E/.review-infra-recovery.json"
if review_recovery_native_timeout_repeat "$FEATURE_DIR_E"; then
  pass "repeat timeout at same head is deterministic"
else
  fail "repeat timeout at same head is deterministic"
fi

# Case 3: prior timeout at different head → not a repeat
jq -n --arg h "cafef00" \
  '{schemaVersion:1,category:"native-review-timeout",nativeTimeoutAttempt:1,reviewHeadSha:$h,recordedAt:"2026-01-01T00:00:00Z"}' \
  > "$FEATURE_DIR_E/.review-infra-recovery.json"
if review_recovery_native_timeout_repeat "$FEATURE_DIR_E"; then
  fail "prior timeout at different head is not a repeat"
else
  pass "prior timeout at different head is not a repeat"
fi

# Case 4: current category is not native-review-timeout → not a repeat
printf '{"status":"failed","artifacts":{"type":"review","failureCategory":"provider-credit-exhausted","reviewHeadSha":"deadbee"}}\n' \
  > "$FEATURE_DIR_E/.review-result.json"
jq -n --arg h "deadbee" \
  '{schemaVersion:1,category:"native-review-timeout",nativeTimeoutAttempt:1,reviewHeadSha:$h,recordedAt:"2026-01-01T00:00:00Z"}' \
  > "$FEATURE_DIR_E/.review-infra-recovery.json"
if review_recovery_native_timeout_repeat "$FEATURE_DIR_E"; then
  fail "non-timeout current category is not a repeat"
else
  pass "non-timeout current category is not a repeat"
fi

echo ""
echo "=== Totals ==="
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
