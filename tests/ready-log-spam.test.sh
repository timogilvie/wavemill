#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

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

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

HELPER_FILE="$TEST_TMP/ready_helpers.sh"
extract_function "$MONITOR_SCRIPT_FILE" "log_ready_failure_result" > "$HELPER_FILE"
extract_function "$MONITOR_SCRIPT_FILE" "log_ready_unparseable_result" >> "$HELPER_FILE"

if [[ ! -s "$HELPER_FILE" ]]; then
  echo "Could not extract ready logging helpers"
  exit 1
fi

echo "=== Ready Log Spam ==="

output="$(
  COMMON_SCRIPT="$COMMON_SCRIPT" HELPER_FILE="$HELPER_FILE" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$HELPER_FILE"

    SESSION="ready-log-spam-regression-with-a-very-long-session-name"
    DEBUG_FILE="$(ready_debug_log_file)"
    rm -f "$DEBUG_FILE"
    trap '\''rm -f "$DEBUG_FILE"'\'' EXIT

    LOG_ERROR_OUTPUT=""

    log_error() {
      local formatted="11:07:50 ERROR: $*"
      LOG_ERROR_OUTPUT+="$formatted"$'\''\n'\''
    }

    ready_payload="$(jq -cn '\''{
        prNumber: 515,
        branch: "task/example",
        verdict: "fail",
        checks: [
          {
            name: "migration-chain-integrity",
            status: "fail",
            message: "Migration chain has gaps",
            details: ([range(0;21) | "db/migrations/\(.)_example.sql"])
          },
          { name: "schema-migrations", status: "pass", message: "ok" },
          { name: "docs", status: "skip", message: "skip" },
          { name: "ci-status", status: "pass", message: "ok" },
          { name: "release-notes", status: "skip", message: "skip" },
          { name: "lint", status: "pass", message: "ok" }
        ]
      }'\'')"

    log_ready_failure_result "HOK-1546" "$ready_payload"
    log_ready_unparseable_result "HOK-1546" "not-json"

    max_error_len=0
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      if (( ${#line} > max_error_len )); then
        max_error_len=${#line}
      fi
    done <<< "$LOG_ERROR_OUTPUT"
    if (( max_error_len <= 120 )); then
      length_ok="yes"
    else
      length_ok="no"
    fi

    debug_line_count=0
    [[ -f "$DEBUG_FILE" ]] && debug_line_count=$(wc -l < "$DEBUG_FILE" | tr -d " ")
    payload_check="missing"
    malformed_check="missing"
    if [[ -f "$DEBUG_FILE" ]]; then
      if jq -e '\''select(.category == "ready" and .payload.checks[0].name == "migration-chain-integrity")'\'' "$DEBUG_FILE" >/dev/null 2>&1; then
        payload_check="present"
      fi
      if jq -e '\''select(.category == "ready" and .error == "non_json" and .raw == "not-json")'\'' "$DEBUG_FILE" >/dev/null 2>&1; then
        malformed_check="present"
      fi
    fi

    printf "errors=%s\nmax_error_len=%s\nlength_ok=%s\ndebug_file=%s\ndebug_lines=%s\npayload_record=%s\nmalformed_record=%s\n" \
      "$LOG_ERROR_OUTPUT" "$max_error_len" "$length_ok" "$DEBUG_FILE" "$debug_line_count" "$payload_check" "$malformed_check"
  '
)"

check_contains "summary names failing check" "$output" "migration-chain-integrity: 21 files"
check_contains "summary includes pass skip count" "$output" "5 passed/skipped"
check_not_contains "status log omits raw ready json" "$output" "\"branch\":\"task/example\""
check_contains "status log includes debug file pointer" "$output" "Full ready result: /tmp/wavemill-ready-log-spam-regression-"
check_contains "max length reported" "$output" "max_error_len="
check_contains "error lines stay under 120 chars" "$output" "length_ok=yes"
check_contains "debug file gets ready payload" "$output" "payload_record=present"
check_contains "malformed payload still lands in debug file" "$output" "malformed_record=present"
check_contains "debug file gets two records" "$output" "debug_lines=2"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
