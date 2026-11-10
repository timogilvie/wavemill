#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
# The cross-PR guard helpers live in the monitor (the mill cp's it at launch).
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
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
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "expected to find: $needle"
    echo "actual: $haystack"
    exit 1
  fi
}

FUNCS_FILE="$TMP_DIR/cross-pr-funcs.sh"
: > "$FUNCS_FILE"
# HOK-3360: write_ready_attention_file was removed; the generic cross-PR guard
# failure now records a failed ready result (retryable) and raises no attention.
for fn in _write_cross_pr_diagnostic write_cross_pr_guard_ready_result clear_cross_pr_guard_ready_evidence cross_pr_revert_gate_apply_result cross_pr_revert_gate_allows_merge; do
  extracted="$(extract_function "$MONITOR_SCRIPT_FILE" "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "FAIL: missing extracted function $fn"
    exit 1
  fi
  printf '%s\n\n' "$extracted" >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

TOOLS_DIR="$REPO_DIR/tools"
BASE_BRANCH="main"
STATE_FILE="$TMP_DIR/workflow-state.json"
cat > "$STATE_FILE" <<'EOF'
{"tasks":{"HOK-2042":{"baseBranch":"main"}}}
EOF

read_state_value() {
  printf '%s\n' "main"
}
# HOK-3360: the generic cross-PR guard failure records the task agent on the
# ready result so stage-failure-ready owns retries.
pass_task_field() { printf '%s\n' "claude"; }
escalate_operator_attention() { return 0; }
wavemill_run_tool() { npx tsx "$TOOLS_DIR/$1" "${@:2}"; }
wavemill_base_compare_ref() { printf '%s\n' "origin/$1"; }
clear_ready_attention() { :; }
validate_ready_attention_marker() { return 3; }
marker_reason() { printf '%s\n' ""; }
log() { :; }
log_warn() { :; }
log_error() { :; }

npx() {
  if [[ "${1:-}" != "tsx" ]]; then
    return 1
  fi

  if [[ "${2:-}" == "$TOOLS_DIR/check-cross-pr-reverts.ts" ]]; then
    printf '%s\n' "fatal: bad revision auto/integration" >&2
    return 2
  fi

  if [[ "${2:-}" == "$TOOLS_DIR/ready-preflight-diagnostic.ts" ]]; then
    local state_dir="" stage="" tool="" classification="" reason="" raw_error="" exit_code=""
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --state-dir) state_dir="$2"; shift 2 ;;
        --stage) stage="$2"; shift 2 ;;
        --tool) tool="$2"; shift 2 ;;
        --classification) classification="$2"; shift 2 ;;
        --reason) reason="$2"; shift 2 ;;
        --raw-error) raw_error="$2"; shift 2 ;;
        --exit-code) exit_code="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$state_dir"
    printf '%s\n' "{\"stage\":\"$stage\",\"tool\":\"$tool\",\"classification\":\"$classification\",\"reason\":\"$reason\",\"rawError\":\"$raw_error\",\"exitCode\":$exit_code}" >> "$state_dir/.ready-preflight.jsonl"
    return 0
  fi

  return 1
}

state_dir="$TMP_DIR/state"
wt_dir="$TMP_DIR/worktree"
mkdir -p "$wt_dir"

if cross_pr_revert_gate_allows_merge "HOK-2042" "$state_dir" "$wt_dir" "132"; then
  echo "FAIL: expected cross_pr_revert_gate_allows_merge to fail"
  exit 1
fi

diagnostic="$(cat "$state_dir/.ready-preflight.jsonl")"
assert_contains "classification is preserved" "$diagnostic" '"classification":"ref-missing"'
assert_contains "raw error is preserved" "$diagnostic" '"rawError":"fatal: bad revision auto/integration"'
assert_contains "reason is included" "$diagnostic" '"reason":"Cross-PR revert guard failed for PR #132."'

echo "PASS: cross-pr guard writes structured preflight diagnostics"
