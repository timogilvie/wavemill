#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_contains() {
  local name="$1" file="$2" needle="$3"
  if grep -Fq -- "$needle" "$file"; then
    pass "$name"
  else
    echo "    missing: $needle"
    [[ -f "$file" ]] && sed 's/^/    | /' "$file"
    fail "$name"
  fi
}

assert_not_contains() {
  local name="$1" file="$2" needle="$3"
  if [[ -f "$file" ]] && grep -Fq -- "$needle" "$file"; then
    echo "    unexpected: $needle"
    sed 's/^/    | /' "$file"
    fail "$name"
  else
    pass "$name"
  fi
}

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNC_FILE="$TEST_TMP/write_stage_result.sh"
extract_function "$MONITOR_SCRIPT_FILE" "write_stage_result" > "$FUNC_FILE"
cat >> "$FUNC_FILE" <<'EOS'

write_existing_result() {
  local feature_dir="$1" agent="$2"
  mkdir -p "$feature_dir"
  jq -n --arg agent "$agent" '{
    stage:"coding",
    status:"running",
    startedAt:"2026-09-15T10:00:00Z",
    finishedAt:null,
    agent:$agent,
    model:"requested-model",
    notes:""
  }' > "$feature_dir/.coding-result.json"
}
EOS

BIN_DIR="$TEST_TMP/bin"
TOOLS_DIR="$TEST_TMP/tools"
mkdir -p "$BIN_DIR" "$TOOLS_DIR"
: > "$TOOLS_DIR/stage-result-cli.ts"
: > "$TOOLS_DIR/resolve-executed-model.ts"

cat > "$BIN_DIR/npx" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
script="${2:-}"
case "$(basename "$script")" in
  resolve-executed-model.ts)
    printf 'resolver' >> "$CALL_LOG"
    printf ' %q' "$@" >> "$CALL_LOG"
    printf '\n' >> "$CALL_LOG"
    case "${RESOLVER_MODE:-direct}" in
      direct)
        printf '{"executedModel":"claude-haiku-4-5","evidenceStatus":"direct","evidenceSource":"claude-session","evidenceDetail":"models=claude-haiku-4-5:2; sessions=1"}\n'
        ;;
      codex)
        printf '{"executedModel":"gpt-5.6-terra","evidenceStatus":"direct","evidenceSource":"codex-session","evidenceDetail":"models=gpt-5.6-terra:1; sessions=1"}\n'
        ;;
      missing)
        printf '{"executedModel":null,"evidenceStatus":"missing","evidenceSource":"claude-session","evidenceDetail":"sessions=0; inWindowTurns=0"}\n'
        ;;
      fail)
        exit 9
        ;;
    esac
    ;;
  stage-result-cli.ts)
    printf 'stage-cli' >> "$CALL_LOG"
    printf ' %q' "$@" >> "$CALL_LOG"
    printf '\n' >> "$CALL_LOG"
    if [[ "${STAGE_CLI_FAIL:-0}" == "1" ]]; then
      exit 7
    fi
    ;;
  *)
    printf 'unexpected-npx' >> "$CALL_LOG"
    printf ' %q' "$@" >> "$CALL_LOG"
    printf '\n' >> "$CALL_LOG"
    exit 8
    ;;
esac
EOS
chmod +x "$BIN_DIR/npx"

run_case() {
  local name="$1"
  shift
  local case_dir="$TEST_TMP/$name"
  mkdir -p "$case_dir"
  PATH="$BIN_DIR:$PATH" TOOLS_DIR="$TOOLS_DIR" CALL_LOG="$case_dir/calls.log" "$@" "$case_dir"
}

echo "=== Wavemill Monitor Executed Model Evidence ==="

run_case forwards_completed_claude bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" claude
  write_stage_result "$feature_dir" coding completed claude claude-haiku-4-5 done
' "$FUNC_FILE"
assert_contains "completed Claude invokes resolver" "$TEST_TMP/forwards_completed_claude/calls.log" "resolver"
assert_contains "completed Claude forwards executed model" "$TEST_TMP/forwards_completed_claude/calls.log" "--executed-model claude-haiku-4-5"
assert_contains "completed Claude forwards evidence source" "$TEST_TMP/forwards_completed_claude/calls.log" "--execution-evidence-source claude-session"
assert_contains "completed Claude forwards evidence status" "$TEST_TMP/forwards_completed_claude/calls.log" "--execution-evidence-status direct"
assert_contains "completed Claude forwards evidence detail" "$TEST_TMP/forwards_completed_claude/calls.log" "--execution-evidence-detail models=claude-haiku-4-5:2\\;\\ sessions=1"

run_case skips_non_completed bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" claude
  write_stage_result "$feature_dir" coding failed claude claude-haiku-4-5 failed
' "$FUNC_FILE"
assert_not_contains "failed Claude does not invoke resolver" "$TEST_TMP/skips_non_completed/calls.log" "resolver"

run_case skips_native bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" native
  write_stage_result "$feature_dir" coding completed native pi-model done
' "$FUNC_FILE"
assert_not_contains "native completed does not invoke resolver" "$TEST_TMP/skips_native/calls.log" "resolver"

run_case resolver_failure_soft bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" claude
  RESOLVER_MODE=fail write_stage_result "$feature_dir" coding completed claude claude-haiku-4-5 done
' "$FUNC_FILE"
assert_contains "resolver failure still writes through CLI" "$TEST_TMP/resolver_failure_soft/calls.log" "stage-cli"
assert_not_contains "resolver failure does not invent executed model" "$TEST_TMP/resolver_failure_soft/calls.log" "--executed-model"

run_case fallback_uses_resolved_evidence bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" claude
  STAGE_CLI_FAIL=1 write_stage_result "$feature_dir" coding completed claude claude-haiku-4-5 done
' "$FUNC_FILE"
fallback_file="$TEST_TMP/fallback_uses_resolved_evidence/feature/.coding-result.json"
if [[ "$(jq -r .executedModel "$fallback_file")" == "claude-haiku-4-5" \
  && "$(jq -r .executionEvidence.status "$fallback_file")" == "direct" \
  && "$(jq -r .executionEvidence.source "$fallback_file")" == "claude-session" \
  && "$(jq -r .modelAttributionEligible "$fallback_file")" == "true" ]]; then
  pass "jq fallback writes resolved direct evidence"
else
  jq . "$fallback_file"
  fail "jq fallback writes resolved direct evidence"
fi

run_case fallback_missing_stays_missing bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" claude
  RESOLVER_MODE=fail STAGE_CLI_FAIL=1 write_stage_result "$feature_dir" coding completed claude claude-haiku-4-5 done
' "$FUNC_FILE"
missing_file="$TEST_TMP/fallback_missing_stays_missing/feature/.coding-result.json"
if [[ "$(jq -r .executedModel "$missing_file")" == "null" \
  && "$(jq -r .executionEvidence.status "$missing_file")" == "missing" \
  && "$(jq -r .executionEvidence.source "$missing_file")" == "shell-fallback" \
  && "$(jq -r .modelAttributionIneligibleReason "$missing_file")" == "missing_execution_evidence" ]]; then
  pass "jq fallback keeps missing when resolver has no evidence"
else
  jq . "$missing_file"
  fail "jq fallback keeps missing when resolver has no evidence"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
