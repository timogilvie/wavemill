#!/usr/bin/env bash
# protects: HOK-3369 — write_stage_result no longer runs a per-agent resolver
# or passes resolver flags. The CLI resolves in-process on completion; the
# shell fallback is a jq merge that preserves existing evidence.
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
cat >> "$FUNC_FILE" <<'SHIM'

wavemill_run_tool() {
  local tool="$1"; shift
  npx tsx "$tool" "$@"
}
SHIM
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

write_existing_with_direct_evidence() {
  local feature_dir="$1" agent="$2"
  mkdir -p "$feature_dir"
  jq -n --arg agent "$agent" '{
    stage:"coding",
    status:"awaiting_user",
    startedAt:"2026-09-15T10:00:00Z",
    finishedAt:null,
    agent:$agent,
    model:"requested-model",
    executedModel:"requested-model",
    executionEvidence:{status:"direct", source:"provider-response", identityVerdict:"match", recordedAt:"2026-09-15T10:05:00Z"},
    modelAttributionEligible:false,
    modelAttributionIneligibleReason:"stage_not_completed",
    notes:""
  }' > "$feature_dir/.coding-result.json"
}
EOS

BIN_DIR="$TEST_TMP/bin"
TOOLS_DIR="$TEST_TMP/tools"
mkdir -p "$BIN_DIR" "$TOOLS_DIR"
: > "$TOOLS_DIR/stage-result-cli.ts"

cat > "$BIN_DIR/npx" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
script="${2:-}"
case "$(basename "$script")" in
  resolve-executed-model.ts)
    # HOK-3369: the shell no longer runs this tool. If we see it, fail loudly.
    printf 'unexpected-resolver-invocation' >> "$CALL_LOG"
    printf ' %q' "$@" >> "$CALL_LOG"
    printf '\n' >> "$CALL_LOG"
    exit 11
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

echo "=== Wavemill Monitor Executed Model Evidence (HOK-3369) ==="

# protects: HOK-3369 — the shell no longer runs resolve-executed-model.ts.
# It calls the stage-result CLI with only basic flags; the CLI resolves.
run_case shell_does_not_run_resolver bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" claude
  write_stage_result "$feature_dir" coding completed claude claude-haiku-4-5 done
' "$FUNC_FILE"
assert_not_contains "shell does not spawn resolve-executed-model.ts" "$TEST_TMP/shell_does_not_run_resolver/calls.log" "unexpected-resolver-invocation"
assert_contains "shell calls stage-result-cli write" "$TEST_TMP/shell_does_not_run_resolver/calls.log" "stage-cli"
assert_not_contains "shell does not pass --executed-model" "$TEST_TMP/shell_does_not_run_resolver/calls.log" "--executed-model"
assert_not_contains "shell does not pass --execution-evidence-status" "$TEST_TMP/shell_does_not_run_resolver/calls.log" "--execution-evidence-status"

# protects: HOK-3369 — a native completion routes through the CLI the same way
# as claude/codex (no agent gate).
run_case native_also_calls_cli bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_result "$feature_dir" native
  write_stage_result "$feature_dir" coding completed native pi-model done
' "$FUNC_FILE"
assert_contains "native completed also invokes stage-result-cli" "$TEST_TMP/native_also_calls_cli/calls.log" "stage-cli"

# protects: HOK-3369 — the shell fallback (CLI unavailable) merges the
# write's basic fields onto any existing result, preserving its direct
# executionEvidence block.
run_case fallback_preserves_direct_evidence bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  write_existing_with_direct_evidence "$feature_dir" native
  STAGE_CLI_FAIL=1 write_stage_result "$feature_dir" coding completed native pi-model done
' "$FUNC_FILE"
fallback_file="$TEST_TMP/fallback_preserves_direct_evidence/feature/.coding-result.json"
if [[ "$(jq -r .executedModel "$fallback_file")" == "requested-model" \
  && "$(jq -r .executionEvidence.status "$fallback_file")" == "direct" \
  && "$(jq -r .executionEvidence.source "$fallback_file")" == "provider-response" ]]; then
  pass "jq fallback preserves direct provider-response evidence"
else
  jq . "$fallback_file"
  fail "jq fallback preserves direct provider-response evidence"
fi

# protects: HOK-3369 — a fresh file (no existing result) gets a `missing`
# evidence block; the fallback never fabricates a direct one.
run_case fallback_fresh_file_missing bash -c '
  set -euo pipefail
  source "$0"
  log_warn() { :; }
  _write_stage_result_trace_event() { :; }
  feature_dir="$1/feature"
  mkdir -p "$feature_dir"
  STAGE_CLI_FAIL=1 write_stage_result "$feature_dir" coding completed claude claude-haiku-4-5 done
' "$FUNC_FILE"
missing_file="$TEST_TMP/fallback_fresh_file_missing/feature/.coding-result.json"
if [[ "$(jq -r .executedModel "$missing_file")" == "null" \
  && "$(jq -r .executionEvidence.status "$missing_file")" == "missing" \
  && "$(jq -r .modelAttributionIneligibleReason "$missing_file")" == "missing_execution_evidence" ]]; then
  pass "jq fallback fresh file writes missing evidence"
else
  jq . "$missing_file"
  fail "jq fallback fresh file writes missing evidence"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
